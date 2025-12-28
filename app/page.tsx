'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
// Imports do Wagmi (Para a carteira principal)
import { useAccount, useConnect, useWriteContract, useSwitchChain } from 'wagmi'
import { parseEther, formatEther, createWalletClient, http, publicActions, decodeEventLog, createPublicClient, type Hex, type PrivateKeyAccount, toHex } from 'viem'
import { keccak256 } from 'viem'
import { usePublicClient } from 'wagmi'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import da Chain e ABI
import { monadTestnet } from '@/utils/chains'
// Import das funções do contrato
import {
  getSessionDelegate,
  getGameInfo,
  getEntropyFee,
  registerSessionKey,
  revokeSessionKey,
  startGame as startGameContract,
  revealCell as revealCellContract,
  cashOut as cashOutContract,
  findEventInLogs,
  ZERO_BYTES32,
  CONTRACT_ADDRESS,
  CONTRACT_ABI
} from '@/utils/contract'

// Tipos
type GameState = {
  id: bigint | null;
  pot: string;
  isActive: boolean;
  status: "idle" | "waiting_pyth" | "waiting_nonce" | "playing" | "game_over" | "won";
  revealedMask: bigint;
  revealedCount: number;
  nonceRevealed: boolean;
};

// Tipo para window.ethereum
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

type BurnerClient = ReturnType<typeof createWalletClient> & ReturnType<typeof publicActions>;

export default function Home() {
  const chain = monadTestnet;
  // --- WAGMI (Main Wallet) ---
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors } = useConnect()
  const { switchChain } = useSwitchChain()
  const { writeContractAsync } = useWriteContract() // Substituto moderno do signer.sendTransaction
  const wagmiPublicClient = usePublicClient()

  // --- VIEM (Session Key / Burner Wallet) ---
  // A Burner Wallet não usa hooks do Wagmi, pois não queremos conectá-la na UI global
  const [burnerAccount, setBurnerAccount] = useState<PrivateKeyAccount | null>(null)
  const [burnerBalance, setBurnerBalance] = useState<string>("0")
  const [isSessionActive, setIsSessionActive] = useState(false)
  
  // Estados para popup de abastecimento
  const [showTopUpModal, setShowTopUpModal] = useState(false)
  const [topUpAmount, setTopUpAmount] = useState<string>("0.05")
  const [mainBalance, setMainBalance] = useState<string>("0")
  
  // Estados para popup de withdraw
  const [showWithdrawModal, setShowWithdrawModal] = useState(false)
  const [withdrawAmount, setWithdrawAmount] = useState<string>("0")
  const [estimatedGas, setEstimatedGas] = useState<string>("0.001")
  const [isWithdrawing, setIsWithdrawing] = useState(false)

  // Cliente Viem para a Burner Wallet (Para ler e escrever)
  // publicActions permite usar esse cliente para ler dados também (getBalance, readContract)
  const burnerClient = useRef<BurnerClient | null>(null)
  const eventUnwatchRef = useRef<(() => void) | null>(null)
  const balanceIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Estado do Jogo
  const [game, setGame] = useState<GameState>({
    id: null, pot: "0", isActive: false, status: "idle", revealedMask: 0n, revealedCount: 0, nonceRevealed: false
  })
  const [betAmount, setBetAmount] = useState<string>("0.001")
  const [minePosition, setMinePosition] = useState<{ x: number; y: number } | null>(null)
  const [showMineModal, setShowMineModal] = useState(false)
  const [gridShake, setGridShake] = useState(false)
  const [lostPot, setLostPot] = useState<string>("0")
  const [showHowToPlayModal, setShowHowToPlayModal] = useState(false)
  
  // Estado para o nonce do commit-reveal
  const [currentNonce, setCurrentNonce] = useState<Hex | null>(null)
  
  // Multiplicador fixo de 1.2x por acerto
  const currentMultiplier = "1.20"
  const [logs, setLogs] = useState<string[]>([])
  const logsEndRef = useRef<HTMLDivElement>(null)
  const seedPollingRef = useRef<NodeJS.Timeout | null>(null)

  const updateBurnerBalance = useCallback(async () => {
    if (!burnerClient.current || !burnerAccount) return
    try {
      const bal = await burnerClient.current.getBalance({ address: burnerAccount.address })
      setBurnerBalance(formatEther(bal))
    } catch (e) {
      console.error('Erro ao atualizar saldo:', e)
    }
  }, [burnerAccount])

  const updateMainBalance = useCallback(async () => {
    if (!address || !wagmiPublicClient) return
    try {
      const publicClient = wagmiPublicClient || createPublicClient({
        chain: chain,
        transport: http()
      })
      const bal = await publicClient.getBalance({ address })
      setMainBalance(formatEther(bal))
    } catch (e) {
      console.error('Erro ao atualizar saldo principal:', e)
    }
  }, [address, wagmiPublicClient, chain])

  // 1. SETUP INICIAL (Cria Burner Wallet)
  useEffect(() => {
    let pKey = localStorage.getItem("monad_session_key") as Hex | null
    if (!pKey) {
      pKey = generatePrivateKey() // Viem utility
      localStorage.setItem("monad_session_key", pKey)
    }
    
    // Configura a conta Viem
    const account = privateKeyToAccount(pKey)
    setBurnerAccount(account)

    // Cria o cliente que vai assinar as transações rápidas
    const client = createWalletClient({
      account,
      chain: chain,
      transport: http()
    }).extend(publicActions)
    burnerClient.current = client as unknown as BurnerClient // Adiciona métodos de leitura

    // Limpa intervalo anterior se existir
    if (balanceIntervalRef.current) {
      clearInterval(balanceIntervalRef.current)
    }

    // Função para atualizar saldo (definida localmente para evitar dependência)
    const updateBalance = async () => {
      if (!burnerClient.current || !account) return
      try {
        const bal = await burnerClient.current.getBalance({ address: account.address })
        setBurnerBalance(formatEther(bal))
      } catch (e) {
        console.error('Erro ao atualizar saldo:', e)
      }
    }

    // Inicia polling de saldo da Burner (a cada 10 segundos para reduzir carga)
    updateBalance()
    balanceIntervalRef.current = setInterval(updateBalance, 10000)
    
    return () => {
      if (balanceIntervalRef.current) {
        clearInterval(balanceIntervalRef.current)
        balanceIntervalRef.current = null
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [chain]) // Executa apenas uma vez na montagem do componente

  // Efeito separado para atualizar saldo quando a conta mudar
  useEffect(() => {
    if (burnerAccount && burnerClient.current) {
      updateBurnerBalance()
    }
  }, [burnerAccount, updateBurnerBalance])

  // Verifica se está na chain certa
  useEffect(() => {
    if (isConnected && chainId !== chain.id) {
        switchChain({ chainId: chain.id })
    }
  }, [isConnected, chainId, switchChain, chain])

  const checkAuthorization = useCallback(async () => {
    if (!burnerClient.current || !burnerAccount || !address) return
    try {
        // burnerClient.current tem publicActions, então pode ser usado como PublicClient
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const delegate = await getSessionDelegate(burnerClient.current as any, burnerAccount.address)
        setIsSessionActive(delegate.toLowerCase() === address.toLowerCase())
    } catch (e) { console.error(e) }
  }, [burnerAccount, address])

  // Verifica se a Session Key está autorizada no contrato
  useEffect(() => {
    if (address && burnerAccount && burnerClient.current) {
        checkAuthorization()
    }
  }, [address, burnerAccount, checkAuthorization])

  // Atualiza saldo da wallet principal quando conectar ou mudar endereço
  useEffect(() => {
    if (address && wagmiPublicClient) {
      updateMainBalance()
      const interval = setInterval(updateMainBalance, 10000) // Atualiza a cada 10 segundos
      return () => clearInterval(interval)
    }
  }, [address, wagmiPublicClient, updateMainBalance])

  // Atualiza saldo quando abrir o modal
  useEffect(() => {
    if (showTopUpModal && address) {
      updateMainBalance()
    }
  }, [showTopUpModal, address, updateMainBalance])

  const addLog = (msg: string) => {
    setLogs(prev => {
      const newLogs = [`> ${msg}`, ...prev]
      // Limita a 100 logs para evitar consumo excessivo de memória
      return newLogs.slice(0, 100)
    })
  }

  // ---------------- ACTIONS ----------------

  // A. Abrir modal de abastecimento
  const openTopUpModal = () => {
    setShowTopUpModal(true)
    setTopUpAmount("0.05")
  }

  // A2. Abrir modal de withdraw e calcular gas
  const openWithdrawModal = async () => {
    setShowWithdrawModal(true)
    
    // Calcula o gas estimado para a transação
    if (address && burnerAccount && burnerClient.current) {
      try {
        const publicClient = wagmiPublicClient || createPublicClient({
          chain: chain,
          transport: http()
        })
        
        // Estima o gas para uma transação simples de transferência
        const gasEstimate = await publicClient.estimateGas({
          account: burnerAccount,
          to: address,
          value: parseEther("0.001") // Valor mínimo para estimar
        })
        
        // Obtém o gas price atual
        const gasPrice = await publicClient.getGasPrice()
        
        // Calcula o custo total do gas
        const gasCost = gasEstimate * gasPrice
        const gasCostInEther = formatEther(gasCost)
        
        // Adiciona uma margem de segurança de 20%
        const gasWithMargin = parseFloat(gasCostInEther) * 1.2
        setEstimatedGas(gasWithMargin.toFixed(6))
        
        // Define o valor inicial como saldo menos gas
        const maxWithdraw = Math.max(0, parseFloat(burnerBalance) - gasWithMargin)
        setWithdrawAmount(maxWithdraw > 0 ? maxWithdraw.toFixed(6) : "0")
      } catch (e) {
        console.error('Erro ao calcular gas:', e)
        // Fallback para valor fixo se houver erro
        setEstimatedGas("0.001")
        const maxWithdraw = Math.max(0, parseFloat(burnerBalance) - 0.001)
        setWithdrawAmount(maxWithdraw > 0 ? maxWithdraw.toFixed(6) : "0")
      }
    } else {
      setEstimatedGas("0.001")
      setWithdrawAmount(burnerBalance)
    }
  }

  // A3. Retirar (Withdraw) - Usa Burner Wallet para enviar de volta para Main Wallet
  const handleWithdraw = async () => {
    if (!address || !burnerAccount || !burnerClient.current || isWithdrawing) return
    
    const amount = parseFloat(withdrawAmount)
    if (isNaN(amount) || amount <= 0) {
      addLog("❌ Invalid value!")
      return
    }

    const burnerBal = parseFloat(burnerBalance)
    const gasCost = parseFloat(estimatedGas)
    
    if (amount > burnerBal) {
      addLog("❌ Insufficient balance in burner account!")
      return
    }

    // Verifica se há saldo suficiente incluindo o gas
    if (amount + gasCost > burnerBal) {
      const maxAmount = Math.max(0, burnerBal - gasCost)
      addLog(`⚠️ Insufficient balance including gas. Maximum available: ${maxAmount.toFixed(6)} MON`)
      setWithdrawAmount(maxAmount.toFixed(6))
      return
    }

    setIsWithdrawing(true)
    try {
        addLog(`Withdrawing ${withdrawAmount} MON to main wallet...`)
        
        // Usa a burner account para enviar MON de volta para a wallet principal
        // O burnerClient já tem a account configurada no createWalletClient
        // @ts-expect-error - O account já está configurado no client, não precisa passar novamente
        const hash = await burnerClient.current.sendTransaction({
            to: address as `0x${string}`,
            value: parseEther(withdrawAmount)
        })
        
        addLog(`Withdraw sent! Hash: ${hash.slice(0, 10)}...`)
        addLog("⏳ Waiting for confirmation...")
        
        // Aguarda confirmação da transação
        const receipt = await burnerClient.current.waitForTransactionReceipt({ hash })
        
        // Verifica se a transação foi bem-sucedida
        if (receipt.status !== 'success') {
          addLog("❌ Withdraw transaction failed!")
          setIsWithdrawing(false)
          return
        }
        
        addLog(`✅ Withdraw confirmed at block: ${receipt.blockNumber}`)
        addLog("💰 Funds transferred to main wallet!")
        
        // Fecha o modal
        setShowWithdrawModal(false)
        setIsWithdrawing(false)
        
        // Atualiza os saldos imediatamente
        await updateBurnerBalance()
        await updateMainBalance()
        
        // Limpa timeout anterior se existir
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }
        // Atualiza novamente após um delay para garantir sincronização
        timeoutRef.current = setTimeout(() => {
          updateBurnerBalance()
          updateMainBalance()
        }, 2000)
    } catch (e: unknown) { 
        const error = e as { message?: string }
        addLog("❌ Withdraw Error: " + (error.message || String(e)))
        setIsWithdrawing(false)
    }
  }

  // A. Abastecer (Usa Main Wallet via Wagmi)
  const handleTopUp = async () => {
    if (!address || !burnerAccount || !window.ethereum) return
    
    const amount = parseFloat(topUpAmount)
    if (isNaN(amount) || amount <= 0) {
      addLog("❌ Invalid value!")
      return
    }

    const mainBal = parseFloat(mainBalance)
    if (amount > mainBal) {
      addLog("❌ Insufficient balance in main wallet!")
      return
    }

    try {
        addLog(`Sending ${topUpAmount} MON...`)
        const hash = await window.ethereum.request({
            method: 'eth_sendTransaction',
            params: [{ 
              from: address, 
              to: burnerAccount.address, 
              value: `0x${parseEther(topUpAmount).toString(16)}` 
            }]
        }) as string
        addLog(`TopUp sent! Hash: ${hash.slice(0, 10)}...`)
        
        // Fecha o modal
        setShowTopUpModal(false)
        
        // Limpa timeout anterior se existir
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }
        timeoutRef.current = setTimeout(() => {
          updateBurnerBalance()
          updateMainBalance()
        }, 2000)
    } catch (e: unknown) { 
        const error = e as { message?: string }
        addLog("❌ TopUp Error: " + (error.message || String(e))) 
    }
  }

  // B. Autorizar Sessão (Usa Main Wallet via Wagmi)
  const activateSession = async () => {
    if (!burnerAccount || !address) return
    try {
        addLog("Authorizing session key...")
        const publicClient = wagmiPublicClient || createPublicClient({
          chain: chain,
          transport: http()
        })

        const hash = await registerSessionKey(writeContractAsync, burnerAccount.address)
        addLog(`Tx sent. Hash: ${hash.slice(0, 10)}...`)
        addLog("⏳ Waiting for confirmation...")
        
        // Polling manual para verificar o status da transação
        let receipt = null
        let attempts = 0
        const maxAttempts = 30 // 30 tentativas = ~30 segundos
        const pollingInterval = 2000 // 2 segundos
        
        while (attempts < maxAttempts && !receipt) {
          try {
            receipt = await publicClient.getTransactionReceipt({ hash })
            if (receipt) break
          } catch {
            // Transação ainda não confirmada, continua esperando
          }
          attempts++
          if (attempts % 5 === 0) {
            addLog(`   Still waiting... (${attempts * 2}s)`)
          }
          await new Promise(resolve => setTimeout(resolve, pollingInterval))
        }
        
        // Se não conseguiu o receipt, verifica diretamente o estado do contrato
        if (!receipt) {
          addLog("⚠️ Could not get transaction receipt, checking contract state directly...")
          try {
            // Aguarda um pouco mais antes de verificar
            await new Promise(resolve => setTimeout(resolve, 3000))
            
            const delegate = await getSessionDelegate(publicClient, burnerAccount.address)
            
            if (delegate.toLowerCase() === address.toLowerCase()) {
              addLog("✅ Session key is active! (verified directly)")
              setIsSessionActive(true)
              return
            } else {
              addLog("⚠️ Session key not yet active. Transaction may still be pending.")
              addLog("💡 The transaction was sent. Please refresh the page in a few seconds.")
              return
            }
          } catch {
            addLog("⚠️ Could not verify session key status. Transaction was sent.")
            addLog("💡 Please refresh the page in a few seconds to check status.")
            return
          }
        }
        
        if (receipt.status !== 'success') {
          addLog("❌ Transaction failed!")
          return
        }
        
        addLog(`✅ Transaction confirmed at block: ${receipt.blockNumber}`)
        
        // Verifica o evento SessionKeyRegistered
        let eventFound = false
        if (receipt.logs) {
          const event = findEventInLogs(receipt.logs, "SessionKeyRegistered")
          
          if (event) {
            eventFound = true
            addLog("✅ Session key registered successfully!")
            setIsSessionActive(true)
            await checkAuthorization() // Atualiza o estado
          }
        }
        
        // Se o evento não foi encontrado, verifica diretamente no contrato
        if (!eventFound) {
          addLog("⚠️ Event not found in logs, checking contract state...")
          try {
            const delegate = await getSessionDelegate(publicClient, burnerAccount.address)
            
            if (delegate.toLowerCase() === address.toLowerCase()) {
              addLog("✅ Session key is active!")
              setIsSessionActive(true)
            } else {
              addLog("⚠️ Session key may not be registered. Please check the transaction.")
            }
          } catch (checkError) {
            addLog("⚠️ Could not verify session key status. Please check manually.")
            console.error('Error checking session key:', checkError)
            // checkError é usado no console.error
          }
        }
    } catch (e: unknown) { 
        const error = e as { message?: string; name?: string }
        const errorMessage = error.message || String(e)
        
        if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
          addLog("⏱️ Transaction confirmation timeout. The transaction may still be pending.")
          addLog("💡 Please check the transaction status in the block explorer.")
        } else {
          addLog("❌ Authorization error: " + errorMessage)
        }
    }
  }

  // B2. Revogar Sessão (Usa Main Wallet via Wagmi)
  const revokeSession = async () => {
    if (!burnerAccount || !address) return
    try {
        addLog("Revoking session key...")
        const publicClient = wagmiPublicClient || createPublicClient({
          chain: chain,
          transport: http()
        })

        const hash = await revokeSessionKey(writeContractAsync, burnerAccount.address)
        addLog(`Tx sent. Hash: ${hash.slice(0, 10)}...`)
        addLog("⏳ Waiting for confirmation...")
        
        // Polling manual para verificar o status da transação
        let receipt = null
        let attempts = 0
        const maxAttempts = 30 // 30 tentativas = ~30 segundos
        const pollingInterval = 2000 // 2 segundos
        
        while (attempts < maxAttempts && !receipt) {
          try {
            receipt = await publicClient.getTransactionReceipt({ hash })
            if (receipt) break
          } catch {
            // Transação ainda não confirmada, continua esperando
          }
          attempts++
          if (attempts % 5 === 0) {
            addLog(`   Still waiting... (${attempts * 2}s)`)
          }
          await new Promise(resolve => setTimeout(resolve, pollingInterval))
        }
        
        // Se não conseguiu o receipt, verifica diretamente o estado do contrato
        if (!receipt) {
          addLog("⚠️ Could not get transaction receipt, checking contract state directly...")
          try {
            // Aguarda um pouco mais antes de verificar
            await new Promise(resolve => setTimeout(resolve, 3000))
            
            const delegate = await getSessionDelegate(publicClient, burnerAccount.address)
            
            if (delegate.toLowerCase() === address.toLowerCase()) {
              addLog("⚠️ Session key is still active. Transaction may still be pending.")
              addLog("💡 The transaction was sent. Please refresh the page in a few seconds.")
              return
            } else {
              addLog("✅ Session key is revoked! (verified directly)")
              setIsSessionActive(false)
              return
            }
          } catch {
            addLog("⚠️ Could not verify session key status. Transaction was sent.")
            addLog("💡 Please refresh the page in a few seconds to check status.")
            return
          }
        }
        
        if (receipt.status !== 'success') {
          addLog("❌ Transaction failed!")
          return
        }
        
        addLog(`✅ Transaction confirmed at block: ${receipt.blockNumber}`)
        
        // Verifica o evento SessionKeyRevoked
        let eventFound = false
        if (receipt.logs) {
          const event = findEventInLogs(receipt.logs, "SessionKeyRevoked")
          
          if (event) {
            eventFound = true
            addLog("✅ Session key revoked successfully!")
            setIsSessionActive(false)
            await checkAuthorization() // Atualiza o estado
          }
        }
        
        // Se o evento não foi encontrado, verifica diretamente no contrato
        if (!eventFound) {
          addLog("⚠️ Event not found in logs, checking contract state...")
          try {
            const delegate = await getSessionDelegate(publicClient, burnerAccount.address)
            
            if (delegate.toLowerCase() === address.toLowerCase()) {
              addLog("⚠️ Session key may still be active. Please check the transaction.")
            } else {
              addLog("✅ Session key is revoked!")
              setIsSessionActive(false)
            }
          } catch (checkError) {
            addLog("⚠️ Could not verify session key status. Please check manually.")
            console.error('Error checking session key:', checkError)
            // checkError é usado no console.error
          }
        }
    } catch (e: unknown) { 
        const error = e as { message?: string; name?: string }
        const errorMessage = error.message || String(e)
        
        if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
          addLog("⏱️ Transaction confirmation timeout. The transaction may still be pending.")
          addLog("💡 Please check the transaction status in the block explorer.")
        } else {
          addLog("❌ Revocation error: " + errorMessage)
        }
    }
  }

        // C. Iniciar Jogo (Usa Main Wallet - Paga a aposta)
  const startGame = async () => {
    // Valida o valor da aposta
    const betValue = parseFloat(betAmount)
    if (isNaN(betValue) || betValue <= 0) {
      addLog("❌ Invalid bet amount!")
      return
    }
    
    // Reseta o estado do jogo antes de iniciar
    setGame({
      id: null,
      pot: "0",
      isActive: false,
      status: "idle",
      revealedMask: 0n,
      revealedCount: 0,
      nonceRevealed: false
    })
    setMinePosition(null)
    setShowMineModal(false)
    setGridShake(false)
    setLostPot("0")
    
    // 1. Gera nonce aleatório de 32 bytes usando crypto.getRandomValues
    addLog("🔐 Generating nonce...")
    const randomBytesArray = new Uint8Array(32)
    crypto.getRandomValues(randomBytesArray)
    const nonce = toHex(randomBytesArray) as Hex
    setCurrentNonce(nonce)
    
    // 2. Cria hash do nonce usando keccak256
    const nonceCommit = keccak256(nonce)
    addLog(`   Nonce hash: ${nonceCommit.slice(0, 10)}...`)
    
    // 3. Armazena nonce no localStorage junto com timestamp
    const gameData = {
      nonce: nonce,
      timestamp: Date.now()
    }
    localStorage.setItem(`monad_game_nonce_${Date.now()}`, JSON.stringify(gameData))

    try {
        addLog("Starting game...")
        
        // Reutiliza o cliente público do wagmi para evitar criar múltiplas instâncias
        const publicClient = wagmiPublicClient || createPublicClient({
          chain: chain,
          transport: http()
        })

        // 1. Obtém a taxa do Entropy (getFeeV2)
        // Usa o endereço do Entropy diretamente da constante
        addLog("💰 Getting Entropy fee...")
        const pythFee = await getEntropyFee(publicClient)
        addLog(`   Entropy fee: ${formatEther(pythFee)} MON`)

        // 3. Calcula o valor total (taxa + aposta definida pelo usuário)
        const betValue = parseEther(betAmount)
        const totalValue = pythFee + betValue
        addLog(`   Bet amount: ${betAmount} MON`)
        addLog(`   Total value: ${formatEther(totalValue)} MON`)

        // 4. Chama startGame com nonceCommit
        addLog("🚀 Calling startGame with nonce commit...")
        const hash = await startGameContract(writeContractAsync, nonceCommit, totalValue)
        
        addLog(`Tx enviada! Hash: ${hash.slice(0, 10)}...`)
        setGame(prev => ({ ...prev, status: "waiting_pyth" }))
        

        // 5. Aguarda confirmação da transação
        addLog("Waiting for confirmation...")
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        
        // Verifica se a transação foi bem-sucedida
        if (receipt.status !== 'success') {
          addLog("❌ Transaction failed!")
          setGame(prev => ({ ...prev, status: "idle" }))
          setCurrentNonce(null)
          return
        }

        addLog(`✅ Transaction confirmed at block: ${receipt.blockNumber}`)

        // 6. Obtém o gameId do evento GameRequested
        let gameId: bigint | null = null
        if (receipt.logs) {
          const gameRequestedEvent = findEventInLogs(receipt.logs, "GameRequested")
          
          if (gameRequestedEvent && gameRequestedEvent.parsed) {
            const args = gameRequestedEvent.parsed.args as { gameId?: bigint; player?: string; nonceCommit?: Hex }
            gameId = args.gameId || null
            if (gameId) {
              addLog(`🎯 Game ID: ${gameId}`)
              setGame(prev => ({ ...prev, id: gameId }))
              
              // Armazena gameId e nonce no localStorage para recuperação
              const gameData = {
                gameId: gameId.toString(),
                nonce: nonce,
                timestamp: Date.now()
              }
              localStorage.setItem(`monad_game_${gameId.toString()}`, JSON.stringify(gameData))
            }
          }
        }

        if (!gameId) {
          addLog("❌ Could not get gameId")
          setGame(prev => ({ ...prev, status: "idle" }))
          setCurrentNonce(null)
          return
        }

        // 7. Aguarda o evento GameStarted (seed do Pyth)
        addLog("⏳ Waiting for GameStarted event (Pyth seed)...")
        
        // Escuta o evento GameStarted
        let gameStartedReceived = false
        const unwatchGameStarted = publicClient.watchContractEvent({
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          eventName: 'GameStarted',
          args: {
            gameId: gameId
          },
          onLogs: (logs) => {
            if (logs.length > 0) {
              gameStartedReceived = true
              const log = logs[0]
              const parsed = decodeEventLog({
                abi: CONTRACT_ABI,
                data: log.data,
                topics: log.topics
              })
              const args = parsed.args as { gameId?: bigint; seed?: Hex }
              addLog(`✅ GameStarted event received! Seed: ${args.seed?.slice(0, 10)}...`)
              unwatchGameStarted()
            }
          }
        })
        
        // Fallback: também faz polling caso o evento não seja capturado
        let attempts = 0
        const maxAttempts = 30
        let cancelled = false
        
        if (seedPollingRef.current) {
          clearInterval(seedPollingRef.current)
          seedPollingRef.current = null
        }
        
        await new Promise<void>((resolve) => {
          seedPollingRef.current = setInterval(async () => {
            if (cancelled || gameStartedReceived) {
              if (seedPollingRef.current) {
                clearInterval(seedPollingRef.current)
                seedPollingRef.current = null
              }
              if (gameStartedReceived) {
                unwatchGameStarted()
              }
              resolve()
              return
            }

            try {
              attempts++
              
              // Verifica se o evento foi recebido
              if (gameStartedReceived) {
                cancelled = true
                if (seedPollingRef.current) {
                  clearInterval(seedPollingRef.current)
                  seedPollingRef.current = null
                }
                unwatchGameStarted()
                resolve()
                return
              }
              
              // Fallback: verifica diretamente no contrato
              const gameData = await getGameInfo(publicClient, gameId)
              
              const seed = gameData.seed
              const zeroHash = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex
              
              if (seed !== zeroHash) {
                gameStartedReceived = true
                cancelled = true
                if (seedPollingRef.current) {
                  clearInterval(seedPollingRef.current)
                  seedPollingRef.current = null
                }
                unwatchGameStarted()
                addLog(`✅ Seed gerado: ${seed.slice(0, 10)}...`)
                resolve()
              } else if (attempts >= maxAttempts) {
                cancelled = true
                if (seedPollingRef.current) {
                  clearInterval(seedPollingRef.current)
                  seedPollingRef.current = null
                }
                unwatchGameStarted()
                addLog("⏱️ Timeout waiting for GameStarted")
                setGame(prev => ({ ...prev, status: "idle" }))
                setCurrentNonce(null)
                resolve()
              } else if (attempts % 5 === 0) {
                addLog(`   Waiting for GameStarted... (${attempts}/${maxAttempts})`)
              }
            } catch (error) {
              console.error('Erro ao verificar GameStarted:', error)
              if (attempts >= maxAttempts) {
                cancelled = true
                if (seedPollingRef.current) {
                  clearInterval(seedPollingRef.current)
                  seedPollingRef.current = null
                }
                unwatchGameStarted()
                resolve()
              }
            }
          }, 1000)
        })

        if (!gameStartedReceived) {
          setGame(prev => ({ ...prev, status: "idle" }))
          setCurrentNonce(null)
          return
        }

        // 8. Atualiza o estado para aguardar primeiro movimento (revelação do nonce)
        setGame(prev => ({ 
          ...prev, 
          status: "waiting_nonce",
          nonceRevealed: false
        }))
        
        addLog(`🟡 Game #${gameId} ready! Waiting for first move (nonce reveal)...`)

    } catch (e: unknown) { 
        const error = e as { message?: string; cause?: unknown }
        const errorMessage: string = error.message || String(e)
        
        // Limpa polling do seed se estiver ativo
        if (seedPollingRef.current) {
          clearInterval(seedPollingRef.current)
          seedPollingRef.current = null
        }
        
        // Limpa nonce em caso de erro
        setCurrentNonce(null)
        
        // Reseta o estado do jogo apenas se necessário
        if (game.status !== "idle") {
          setGame(prev => ({ ...prev, status: "idle", nonceRevealed: false }))
        }
        
        if (errorMessage.includes("User rejected") || errorMessage.includes("user rejected")) {
          addLog("❌ Transaction cancelled by user")
        } else if (errorMessage.includes("execution reverted") || errorMessage.includes("revert")) {
          addLog("❌ Transaction reverted by contract. Check the parameters.")
        } else {
          addLog("❌ Error: " + errorMessage)
        }
    }
  }

  // Limpa watchers e intervals quando componente desmonta
  useEffect(() => {
    return () => {
      if (eventUnwatchRef.current) {
        eventUnwatchRef.current()
        eventUnwatchRef.current = null
      }
      if (balanceIntervalRef.current) {
        clearInterval(balanceIntervalRef.current)
        balanceIntervalRef.current = null
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      if (seedPollingRef.current) {
        clearInterval(seedPollingRef.current)
        seedPollingRef.current = null
      }
    }
  }, [])

  // D. Jogar (Usa VIEM + BURNER WALLET)
  const handleCellClick = async (x: number, y: number) => {
    if (!game.id || !burnerClient.current) return

    try {
        // Verifica se o nonce precisa ser revelado (primeiro movimento)
        let nonceToUse: Hex | undefined = undefined
        
        if (!game.nonceRevealed) {
          // Primeiro movimento: precisa revelar o nonce
          if (!currentNonce) {
            // Tenta recuperar do localStorage
            const storedData = localStorage.getItem(`monad_game_${game.id.toString()}`)
            if (storedData) {
              try {
                const parsed = JSON.parse(storedData)
                if (parsed.nonce) {
                  setCurrentNonce(parsed.nonce as Hex)
                  nonceToUse = parsed.nonce as Hex
                  addLog("🔐 Nonce recuperado do localStorage")
                } else {
                  addLog("❌ Nonce não encontrado! Não é possível fazer o primeiro movimento.")
                  return
                }
            } catch {
              addLog("❌ Erro ao recuperar nonce do localStorage")
              return
            }
            } else {
              addLog("❌ Nonce não encontrado! Não é possível fazer o primeiro movimento.")
              return
            }
          } else {
            nonceToUse = currentNonce
          }
          addLog(`🔓 Revealing nonce on first move...`)
        }
        
        addLog(`Opening (${x}, ${y})...`)
        
        // Lê o estado do jogo ANTES de enviar a transação para ter o pote correto caso encontre mina
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gameInfoBefore = await getGameInfo(burnerClient.current as any, game.id)
        const potBefore = gameInfoBefore.currentPot
        
        // Escrita direta via Viem (Sem popup)
        // Se for o primeiro movimento, inclui o nonce; caso contrário, envia bytes32 zero
        const hash = await revealCellContract(
          burnerClient.current,
          game.id,
          x,
          y,
          nonceToUse || ZERO_BYTES32
        )
        
        // Espera recibo
        const receipt = await burnerClient.current.waitForTransactionReceipt({ hash })
        
        // Processa eventos: NonceRevealed e CellRevealed
        if (receipt.logs) {
          // Verifica se o nonce foi revelado (evento NonceRevealed)
          const nonceRevealedEventFound = findEventInLogs(receipt.logs, "NonceRevealed")
          
          if (nonceRevealedEventFound && !game.nonceRevealed) {
            addLog("✅ Nonce revelado com sucesso! Jogo agora está totalmente ativo.")
            setGame(prev => ({ ...prev, nonceRevealed: true, status: "playing" }))
            // Limpa o nonce da memória após revelação bem-sucedida (mas mantém no localStorage para recuperação)
            // Não limpa o currentNonce ainda, pode ser útil para debug
          }
          
          // Processa o evento CellRevealed
          const cellRevealedEventFound = findEventInLogs(receipt.logs, "CellRevealed")
          
          if (cellRevealedEventFound && cellRevealedEventFound.parsed) {
            const args = cellRevealedEventFound.parsed.args as { gameId?: bigint; x?: number; y?: number; isMine?: boolean; newPot?: bigint }
            
            const isMine = args.isMine
            const newPot = args.newPot
            
            if (isMine) {
              // Usa o pote ANTES de encontrar a mina (o pote que foi perdido) apenas para mostrar no modal
              const lostPotValue = formatEther(potBefore)
              setLostPot(lostPotValue) // Salva o pote perdido para mostrar no modal
              addLog(`💥 MINE FOUND at (${x}, ${y})!`)
              setMinePosition({ x, y })
              setGridShake(true)
              // Mostra o modal após um pequeno delay para o efeito visual
              setTimeout(() => {
                setShowMineModal(true)
              }, 300)
              setGame(prev => ({ 
                ...prev, 
                status: "game_over", 
                isActive: false, 
                pot: "0", // Reseta o pote para 0 quando perde
                nonceRevealed: true
              }))
              // Remove o shake após a animação
              setTimeout(() => setGridShake(false), 1000)
              // Limpa dados do localStorage após game over
              if (game.id) {
                localStorage.removeItem(`monad_game_${game.id}`)
              }
              setCurrentNonce(null)
            } else {
              addLog(`💎 Safe! Pot: ${newPot ? formatEther(newPot) : "0"} MON`)
            }
          }
        }
        
        // Lê o estado atualizado do jogo para sincronizar
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gameInfo = await getGameInfo(burnerClient.current as any, game.id)
        const { currentPot: pot, revealedCells: revealedMask, isActive, isLost, nonceRevealed: nonceRevealedFromContract } = gameInfo

        // Conta o número de células reveladas para calcular o multiplicador
        let revealedCount = 0
        for (let i = 0; i < 100; i++) {
          if ((revealedMask & (1n << BigInt(i))) !== 0n) {
            revealedCount++
          }
        }
        
        // Atualiza o estado completo do jogo
        setGame(prev => ({
          ...prev,
          pot: prev.status === "game_over" ? "0" : formatEther(pot), // Mantém o pote em 0 se já foi game_over
          revealedMask: revealedMask,
          revealedCount: revealedCount,
          isActive: isActive && !isLost,
          nonceRevealed: nonceRevealedFromContract,
          status: isLost ? "game_over" : (nonceRevealedFromContract && isActive) ? "playing" : prev.status === "waiting_nonce" ? "waiting_nonce" : prev.status
        }))

    } catch (e: unknown) { 
        const error = e as { message?: string }
        const errorMessage = error.message || String(e)
        
        if (errorMessage.includes("insufficient funds")) {
          addLog("⚠️ Insufficient Gas in Session Key!")
        } else if (errorMessage.includes("Celula ja revelada") || errorMessage.includes("célula já revelada") || errorMessage.includes("already revealed")) {
          addLog(`⚠️ Cell (${x}, ${y}) already revealed`)
        } else if (errorMessage.includes("Invalid nonce") || errorMessage.includes("nonce inválido") || errorMessage.includes("Nonce mismatch")) {
          addLog("❌ Erro: Nonce inválido! Verifique se o nonce está correto.")
          // Tenta recuperar do localStorage
          const storedData = localStorage.getItem(`monad_game_${game.id.toString()}`)
          if (storedData) {
            try {
              const parsed = JSON.parse(storedData)
              if (parsed.nonce) {
                setCurrentNonce(parsed.nonce as Hex)
                addLog("🔐 Nonce recuperado do localStorage. Tente novamente.")
              }
            } catch {
              addLog("❌ Não foi possível recuperar o nonce do localStorage.")
            }
          }
        } else if (errorMessage.includes("Seed not available") || errorMessage.includes("seed não disponível")) {
          addLog("⏳ Aguarde o seed do Pyth ser gerado antes de fazer movimentos.")
        } else {
          addLog("Error: " + errorMessage)
        }
    }
  }

  // E. Cashout (Usa VIEM + BURNER)
  const handleCashOut = async () => {
    if (!game.id || !burnerClient.current) return
    try {
        const hash = await cashOutContract(burnerClient.current, game.id)
        addLog("Saque solicitado!")
        await burnerClient.current.waitForTransactionReceipt({ hash })
        setGame(prev => ({ ...prev, status: "won", isActive: false }))
        addLog("💰 Dinheiro na conta!")
        
        // Limpa dados do localStorage após cashout
        localStorage.removeItem(`monad_game_${game.id.toString()}`)
        setCurrentNonce(null)
    } catch (e: unknown) { 
        const error = e as { message?: string }
        addLog("Cashout Error: " + (error.message || String(e))) 
    }
  }

  // --- RENDER (Simplificado para brevidade) ---
  const renderGrid = () => {
    const cells = []
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const index = BigInt(y * 10 + x)
        const isMineCell = minePosition && minePosition.x === x && minePosition.y === y
        // Se for uma célula de mina, não verifica revealedMask - sempre mostra como mina
        const isRevealed = !isMineCell && (game.revealedMask & (1n << index)) !== 0n
        
        let cellClass = 'bg-gradient-to-br from-gray-700 to-gray-800 border-gray-600 hover:from-gray-600 hover:to-gray-700'
        let cellContent = ""
        
        if (isMineCell) {
          cellClass = 'bg-gradient-to-br from-red-600 to-red-700 border-2 border-red-400 animate-pulse shadow-lg shadow-red-500/50'
          cellContent = "💣"
        } else if (isRevealed) {
          cellClass = 'bg-gradient-to-br from-emerald-400 to-green-500 border-green-400 shadow-md shadow-green-500/30'
          cellContent = "💎"
        }
        
        cells.push(
            <button 
              key={`${x}-${y}`} 
              disabled={(game.status !== 'playing' && game.status !== 'waiting_nonce') || isRevealed || !!isMineCell}
              onClick={() => handleCellClick(x, y)}
              className={`
                w-12 h-12 border-2 rounded-lg
                ${cellClass}
                transition-all duration-200 
                ${isMineCell ? 'scale-110' : ''}
                ${!isRevealed && !isMineCell && game.status === 'playing' ? 'hover:scale-105 hover:shadow-lg cursor-pointer active:scale-95' : ''}
                ${isRevealed || isMineCell ? 'cursor-default' : ''}
                disabled:opacity-50 disabled:cursor-not-allowed
                flex items-center justify-center text-xl
              `}
            >
              {cellContent}
            </button>
        )
      }
    }
    return (
      <div className={`grid grid-cols-10 gap-2 p-4 bg-gradient-to-br from-gray-900/50 to-gray-800/50 rounded-xl border border-gray-700/50 ${gridShake ? 'animate-shake' : ''}`}>
        {cells}
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900/20 to-gray-900 text-white p-4 sm:p-8 flex flex-col items-center relative overflow-hidden">
        {/* Background decorative elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-20 left-10 w-72 h-72 bg-purple-500/10 rounded-full blur-3xl"></div>
          <div className="absolute bottom-20 right-10 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl"></div>
        </div>
        
        <div className="relative z-10 w-full max-w-4xl">
          {/* Header */}
          <div className="text-center mb-4 relative z-20">
            <button
              onClick={() => setShowHowToPlayModal(true)}
              className="absolute top-0 right-0 z-30 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 px-4 py-2 rounded-lg font-semibold text-sm transition-all transform hover:scale-105 shadow-md cursor-pointer pointer-events-auto"
            >
              ❓ How to Play
            </button>
            <h1 className="text-4xl sm:text-5xl font-black mb-1 bg-gradient-to-r from-purple-400 via-pink-400 to-blue-400 bg-clip-text text-transparent drop-shadow-2xl">
              💎 MONAD MINES 💎
            </h1>
            <p className="text-gray-400 text-xs mt-1">Discover the mines and win the pot!</p>
          </div>
        
          {!isConnected ? (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
              <div className="bg-gradient-to-br from-gray-800/90 to-gray-900/90 backdrop-blur-sm p-8 rounded-2xl border border-purple-500/30 shadow-2xl">
                <h2 className="text-2xl font-bold text-center mb-6 text-purple-300">Connect Your Wallet</h2>
                <button 
                  onClick={() => connect({ connector: connectors[0] })} 
                  className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 px-8 py-4 rounded-xl font-bold text-lg transition-all transform hover:scale-105 shadow-lg shadow-purple-500/50"
                >
                  🔗 Conectar Wallet
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
                {/* Status Bar */}
                <div className="bg-gradient-to-br from-gray-800/90 to-gray-900/90 backdrop-blur-sm p-3 rounded-xl border border-gray-700/50 shadow-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                    <div className="space-y-2">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-400 text-xs">Main Wallet:</span>
                            <span className="text-purple-300 font-mono text-sm font-semibold">{address?.slice(0,8)}...{address?.slice(-6)}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-gray-500 text-xs">Balance:</span>
                            <span className="text-purple-400 font-mono text-sm font-semibold">{parseFloat(mainBalance).toFixed(6)} MON</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-400 text-xs">Session:</span>
                          {isSessionActive ? (
                            <span className="flex items-center gap-1 text-green-400 font-semibold">
                              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
                              Active
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-red-400 font-semibold">
                              <span className="w-2 h-2 bg-red-400 rounded-full"></span>
                              Inactive
                            </span>
                          )}
                        </div>
                    </div>
                    <div className="text-right space-y-2">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-400 text-sm">Game Wallet:</span>
                            <span className="text-yellow-400 font-mono font-bold text-lg">{parseFloat(burnerBalance).toFixed(4)} MON</span>
                          </div>
                          {burnerAccount && (
                            <div className="flex items-center gap-2">
                              <span className="text-gray-400 text-xs">Address:</span>
                              <span className="text-purple-300 font-mono text-xs">{burnerAccount.address.slice(0,8)}...{burnerAccount.address.slice(-6)}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <button 
                            onClick={openTopUpModal} 
                            className="text-xs bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 px-3 py-1.5 rounded-lg font-semibold transition-all transform hover:scale-105 shadow-md"
                          >
                            ⛽ Top Up
                          </button>
                          {parseFloat(burnerBalance) > 0.001 && (
                            <button 
                              onClick={openWithdrawModal} 
                              className="text-xs bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 px-3 py-1.5 rounded-lg font-semibold transition-all transform hover:scale-105 shadow-md"
                            >
                              💸 Withdraw
                            </button>
                          )}
                        </div>
                    </div>
                </div>

                {/* Session Control */}
                {!isSessionActive ? (
                    <button 
                      onClick={activateSession} 
                      className="w-full bg-gradient-to-r from-yellow-600 to-orange-600 hover:from-yellow-500 hover:to-orange-500 py-2 rounded-xl font-bold text-sm transition-all transform hover:scale-105 shadow-lg shadow-yellow-500/30"
                    >
                      🔑 Authorize Session
                    </button>
                ) : (
                    <button 
                      onClick={revokeSession} 
                      className="w-full bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 py-2 rounded-xl font-bold text-sm transition-all transform hover:scale-105 shadow-lg shadow-red-500/30"
                    >
                      🚫 Revoke Session
                    </button>
                )}

                {/* Game Area with Logs Side by Side */}
                <div className="flex flex-col lg:flex-row gap-3">
                    {/* Logs - Left Side */}
                    <div className="lg:w-72 bg-gradient-to-br from-black/80 to-gray-900/80 backdrop-blur-sm h-64 lg:h-auto overflow-y-auto text-xs text-green-400 p-3 font-mono border border-gray-800 rounded-xl shadow-xl order-2 lg:order-1">
                        <div className="sticky top-0 bg-gray-900/80 backdrop-blur-sm pb-1 mb-1 border-b border-gray-700 z-10">
                          <p className="text-gray-400 text-xs font-semibold">📋 LOGS</p>
                        </div>
                        <div className="space-y-1">
                          {logs.map((l, i) => (
                            <div key={i} className="text-green-400/90 hover:text-green-300 transition-colors">
                              {l}
                            </div>
                          ))}
                        </div>
                        <div ref={logsEndRef}/>
                    </div>

                    {/* Game Area - Right Side */}
                    <div className="flex-1 bg-gradient-to-br from-gray-800/90 to-gray-900/90 backdrop-blur-sm p-4 sm:p-5 rounded-2xl border border-gray-700/50 shadow-2xl order-1 lg:order-2">
                        {/* Game Header - Compact */}
                        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                            {/* Bet Amount - Only show when game is idle */}
                            {(game.status === 'idle' || game.status === 'game_over' || game.status === 'won') && (
                              <div className="flex items-center gap-2 bg-gradient-to-r from-purple-500/10 to-blue-500/10 border border-purple-500/30 rounded-lg px-3 py-2 backdrop-blur-sm">
                                <label className="text-gray-300 text-xs font-semibold whitespace-nowrap">
                                  💰 Bet:
                                </label>
                                <input
                                  type="number"
                                  step="0.001"
                                  min="0.001"
                                  value={betAmount}
                                  onChange={(e) => setBetAmount(e.target.value)}
                                  className="w-20 bg-gray-800/50 border border-gray-700 rounded px-2 py-1 text-white text-sm font-mono focus:outline-none focus:border-purple-500 transition-all"
                                  placeholder="0.001"
                                />
                                <div className="flex gap-1">
                                  <button
                                    onClick={() => setBetAmount("0.001")}
                                    className="bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-xs transition-all"
                                  >
                                    0.001
                                  </button>
                                  <button
                                    onClick={() => setBetAmount("0.01")}
                                    className="bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-xs transition-all"
                                  >
                                    0.01
                                  </button>
                                </div>
                              </div>
                            )}
                            
                            {/* Pot and Multiplier - Compact */}
                            <div className="flex gap-2 items-center">
                              <div className="bg-gradient-to-r from-yellow-500/20 to-yellow-600/20 border border-yellow-500/50 rounded-lg px-3 py-2 backdrop-blur-sm">
                                <p className="text-gray-400 text-xs">Pot</p>
                                <span className="text-xl text-yellow-400 font-bold font-mono">
                                  {game.pot} MON
                                </span>
                              </div>
                              {game.status === 'playing' && (
                                <div className="bg-gradient-to-r from-green-500/20 to-emerald-500/20 border border-green-500/50 rounded-lg px-3 py-2 backdrop-blur-sm">
                                  <p className="text-gray-400 text-xs">Mult</p>
                                  <span className="text-xl text-green-400 font-bold font-mono">
                                    {currentMultiplier}x
                                  </span>
                                </div>
                              )}
                            </div>
                            
                            {/* Action Button */}
                            <div className="flex gap-2">
                              {game.status === 'playing' && (
                                <button 
                                  onClick={handleCashOut} 
                                  className="bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 px-4 py-2 rounded-lg font-bold text-sm text-white shadow-lg shadow-green-500/30 transition-all transform hover:scale-105"
                                >
                                  💰 CASH OUT
                                </button>
                              )}
                              {(game.status === 'idle' || game.status === 'game_over' || game.status === 'won') && (
                                <button 
                                  onClick={startGame} 
                                  className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 px-4 py-2 rounded-lg font-bold text-sm text-white shadow-lg shadow-purple-500/30 transition-all transform hover:scale-105"
                                >
                                  🎮 NEW GAME
                                </button>
                              )}
                            </div>
                        </div>
                        
                        {/* Game Grid */}
                        <div className="flex flex-col items-center">
                          {game.status === 'waiting_pyth' ? (
                            <div className="py-12 flex flex-col items-center gap-3">
                              <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-b-4 border-purple-500"></div>
                              <p className="text-lg text-purple-300 font-semibold animate-pulse">Aguardando seed do Pyth...</p>
                            </div>
                          ) : (
                            <>
                              {game.status === 'waiting_nonce' && (
                                <div className="mb-4 text-center w-full">
                                  <div className="animate-pulse text-2xl mb-2">🔐</div>
                                  <p className="text-sm text-yellow-300 font-semibold">Jogo pronto! Clique em qualquer célula para revelar o nonce.</p>
                                </div>
                              )}
                              <div className="flex justify-center w-full">
                                {renderGrid()}
                              </div>
                            </>
                          )}
                        </div>
                    </div>
                </div>
            </div>
          )}
        </div>

        {/* Modal de Abastecimento */}
        {showTopUpModal && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fadeIn">
            <div className="bg-gradient-to-br from-gray-800/95 to-gray-900/95 backdrop-blur-md border-2 border-purple-500/50 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl animate-bounceIn">
              <h2 className="text-3xl font-black bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent mb-6 text-center">
                ⛽ Top Up Burner Account
              </h2>
              
              <div className="mb-6 bg-gradient-to-r from-yellow-500/10 to-yellow-600/10 border border-yellow-500/30 rounded-xl p-4">
                <p className="text-gray-400 text-sm mb-2">💰 Current balance in your wallet:</p>
                <p className="text-2xl font-mono text-yellow-400 font-bold">{parseFloat(mainBalance).toFixed(4)} MON</p>
              </div>

              <div className="mb-6">
                <label className="block text-gray-300 text-sm mb-3 font-semibold">
                  💵 Amount to top up (MON):
                </label>
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  max={mainBalance}
                  value={topUpAmount}
                  onChange={(e) => setTopUpAmount(e.target.value)}
                  className="w-full bg-gray-800/50 border-2 border-gray-700 rounded-xl px-4 py-3 text-white text-lg font-mono focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/50 transition-all"
                  placeholder="0.05"
                />
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => setTopUpAmount("0.01")}
                    className="flex-1 bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-600 hover:to-gray-700 px-3 py-2 rounded-lg text-sm font-semibold transition-all transform hover:scale-105"
                  >
                    0.01
                  </button>
                  <button
                    onClick={() => setTopUpAmount("0.05")}
                    className="flex-1 bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-600 hover:to-gray-700 px-3 py-2 rounded-lg text-sm font-semibold transition-all transform hover:scale-105"
                  >
                    0.05
                  </button>
                  <button
                    onClick={() => setTopUpAmount("0.1")}
                    className="flex-1 bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-600 hover:to-gray-700 px-3 py-2 rounded-lg text-sm font-semibold transition-all transform hover:scale-105"
                  >
                    0.1
                  </button>
                  <button
                    onClick={() => setTopUpAmount(mainBalance)}
                    className="flex-1 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 px-3 py-2 rounded-lg text-sm font-semibold transition-all transform hover:scale-105"
                  >
                    Máx
                  </button>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleTopUp}
                  className="flex-1 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 px-6 py-3 rounded-xl font-bold text-lg transition-all transform hover:scale-105 shadow-lg shadow-purple-500/30"
                >
                  ✅ Confirm
                </button>
                <button
                  onClick={() => setShowTopUpModal(false)}
                  className="flex-1 bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-600 hover:to-gray-700 px-6 py-3 rounded-xl font-bold text-lg transition-all transform hover:scale-105"
                >
                  ❌ Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal de Withdraw */}
        {showWithdrawModal && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fadeIn">
            <div className="bg-gradient-to-br from-gray-800/95 to-gray-900/95 backdrop-blur-md border-2 border-green-500/50 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl animate-bounceIn">
              <h2 className="text-3xl font-black bg-gradient-to-r from-green-400 to-emerald-400 bg-clip-text text-transparent mb-6 text-center">
                💸 Withdraw
              </h2>
              
              <div className="mb-4 space-y-3">
                <div className="bg-gradient-to-r from-yellow-500/10 to-yellow-600/10 border border-yellow-500/30 rounded-xl p-4">
                  <p className="text-gray-400 text-sm mb-2">💰 Current balance in burner account:</p>
                  <p className="text-2xl font-mono text-yellow-400 font-bold">{parseFloat(burnerBalance).toFixed(6)} MON</p>
                </div>
                <div className="bg-gradient-to-r from-blue-500/10 to-cyan-500/10 border border-blue-500/30 rounded-xl p-3">
                  <p className="text-gray-400 text-xs mb-1">⛽ Estimated gas:</p>
                  <p className="text-lg font-mono text-blue-400 font-semibold">{parseFloat(estimatedGas).toFixed(6)} MON</p>
                </div>
                <div className="bg-gradient-to-r from-green-500/10 to-emerald-500/10 border border-green-500/30 rounded-xl p-3">
                  <p className="text-gray-400 text-xs mb-1">✅ Available to withdraw:</p>
                  <p className="text-lg font-mono text-green-400 font-semibold">
                    {Math.max(0, parseFloat(burnerBalance) - parseFloat(estimatedGas)).toFixed(6)} MON
                  </p>
                </div>
              </div>

              <div className="mb-6">
                <label className="block text-gray-300 text-sm mb-3 font-semibold">
                  💵 Amount to withdraw (MON):
                </label>
                <input
                  type="number"
                  step="0.000001"
                  min="0"
                  max={Math.max(0, parseFloat(burnerBalance) - parseFloat(estimatedGas))}
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  className="w-full bg-gray-800/50 border-2 border-gray-700 rounded-xl px-4 py-3 text-white text-lg font-mono focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/50 transition-all"
                  placeholder="0"
                />
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => {
                      const max = Math.max(0, parseFloat(burnerBalance) - parseFloat(estimatedGas))
                      setWithdrawAmount(max.toFixed(6))
                    }}
                    disabled={isWithdrawing}
                    className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 px-3 py-2 rounded-lg text-sm font-semibold transition-all transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
                  >
                    Max (All - Gas)
                  </button>
                  <button
                    onClick={() => {
                      const available = Math.max(0, parseFloat(burnerBalance) - parseFloat(estimatedGas))
                      setWithdrawAmount((available * 0.5).toFixed(6))
                    }}
                    disabled={isWithdrawing}
                    className="flex-1 bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-600 hover:to-gray-700 px-3 py-2 rounded-lg text-sm font-semibold transition-all transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
                  >
                    50%
                  </button>
                  <button
                    onClick={() => {
                      const available = Math.max(0, parseFloat(burnerBalance) - parseFloat(estimatedGas))
                      setWithdrawAmount(available.toFixed(6))
                    }}
                    disabled={isWithdrawing}
                    className="flex-1 bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-600 hover:to-gray-700 px-3 py-2 rounded-lg text-sm font-semibold transition-all transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
                  >
                    All
                  </button>
                </div>
                <p className="text-gray-500 text-xs mt-2">
                  ℹ️ Estimated gas ({parseFloat(estimatedGas).toFixed(6)} MON) will be deducted automatically
                </p>
              </div>

              {isWithdrawing && (
                <div className="mb-4 bg-gradient-to-r from-blue-500/10 to-cyan-500/10 border border-blue-500/30 rounded-xl p-4">
                  <div className="flex items-center gap-3">
                    <div className="animate-spin text-2xl">⏳</div>
                    <div>
                      <p className="text-blue-400 font-semibold">Processing withdrawal...</p>
                      <p className="text-gray-400 text-sm">Waiting for transaction confirmation</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={handleWithdraw}
                  disabled={isWithdrawing}
                  className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 px-6 py-3 rounded-xl font-bold text-lg transition-all transform hover:scale-105 shadow-lg shadow-green-500/30 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none flex items-center justify-center gap-2"
                >
                  {isWithdrawing ? (
                    <>
                      <div className="animate-spin">⏳</div>
                      Processing...
                    </>
                  ) : (
                    '✅ Confirm'
                  )}
                </button>
                <button
                  onClick={() => {
                    if (!isWithdrawing) {
                      setShowWithdrawModal(false)
                      setIsWithdrawing(false)
                    }
                  }}
                  disabled={isWithdrawing}
                  className="flex-1 bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-600 hover:to-gray-700 px-6 py-3 rounded-xl font-bold text-lg transition-all transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
                >
                  ❌ Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal How to Play */}
        {showHowToPlayModal && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fadeIn">
            <div className="bg-gradient-to-br from-gray-800/95 to-gray-900/95 backdrop-blur-md border-2 border-purple-500/50 rounded-2xl p-6 max-w-2xl w-full mx-4 shadow-2xl animate-bounceIn max-h-[90vh] overflow-y-auto">
              <h2 className="text-3xl font-black bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent mb-6 text-center">
                📖 How to Play
              </h2>
              
              <div className="space-y-4 text-gray-300">
                <div className="bg-gradient-to-r from-purple-500/10 to-blue-500/10 border border-purple-500/30 rounded-xl p-4">
                  <h3 className="text-xl font-bold text-purple-300 mb-2">🎯 Objective</h3>
                  <p className="text-sm">
                    Click on cells to reveal them. Find safe cells (💎) to increase the pot, but avoid mines (💣) or you&apos;ll lose everything!
                  </p>
                </div>

                <div className="bg-gradient-to-r from-yellow-500/10 to-orange-500/10 border border-yellow-500/30 rounded-xl p-4">
                  <h3 className="text-xl font-bold text-yellow-300 mb-2">💰 Betting</h3>
                  <ul className="text-sm space-y-2 list-disc list-inside">
                    <li>Set your bet amount before starting a new game</li>
                    <li>Each safe cell you reveal multiplies your potential winnings by 1.2x</li>
                    <li>The pot grows with each safe cell you find</li>
                  </ul>
                </div>

                <div className="bg-gradient-to-r from-green-500/10 to-emerald-500/10 border border-green-500/30 rounded-xl p-4">
                  <h3 className="text-xl font-bold text-green-300 mb-2">✅ Winning</h3>
                  <ul className="text-sm space-y-2 list-disc list-inside">
                    <li>Click &quot;CASH OUT&quot; at any time to secure your current pot</li>
                    <li>The longer you play, the higher the pot, but the riskier it gets</li>
                    <li>Balance risk vs reward - know when to cash out!</li>
                  </ul>
                </div>

                <div className="bg-gradient-to-r from-red-500/10 to-orange-500/10 border border-red-500/30 rounded-xl p-4">
                  <h3 className="text-xl font-bold text-red-300 mb-2">💣 Losing</h3>
                  <ul className="text-sm space-y-2 list-disc list-inside">
                    <li>If you click on a mine, you lose the entire pot</li>
                    <li>The game ends immediately when a mine is found</li>
                    <li>Start a new game to try again!</li>
                  </ul>
                </div>

                <div className="bg-gradient-to-r from-blue-500/10 to-cyan-500/10 border border-blue-500/30 rounded-xl p-4">
                  <h3 className="text-xl font-bold text-blue-300 mb-2">🔑 Game Wallet</h3>
                  <ul className="text-sm space-y-2 list-disc list-inside">
                    <li>You need to authorize a session key to play</li>
                    <li>Top up your Game Wallet with MON for gas fees</li>
                    <li>You can withdraw funds from Game Wallet back to your main wallet anytime</li>
                  </ul>
                </div>

                <div className="bg-gradient-to-r from-gray-500/10 to-gray-600/10 border border-gray-500/30 rounded-xl p-4">
                  <h3 className="text-xl font-bold text-gray-300 mb-2">💡 Tips</h3>
                  <ul className="text-sm space-y-2 list-disc list-inside">
                    <li>Start with smaller bets to learn the game</li>
                    <li>Don&apos;t get greedy - cash out when you&apos;re ahead!</li>
                    <li>Keep your Game Wallet topped up for smooth gameplay</li>
                  </ul>
                </div>
              </div>

              <div className="mt-6 flex justify-center">
                <button
                  onClick={() => setShowHowToPlayModal(false)}
                  className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 px-8 py-3 rounded-xl font-bold text-lg transition-all transform hover:scale-105 shadow-lg shadow-purple-500/30"
                >
                  Got it!
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal de Explosão - Mina Encontrada */}
        {showMineModal && (
          <div className="fixed inset-0 bg-black bg-opacity-95 flex items-center justify-center z-50 animate-fadeIn">
            <div className="relative bg-gradient-to-br from-red-900 via-red-800 to-orange-900 border-4 border-red-500 rounded-lg p-8 max-w-md w-full mx-4 text-center animate-bounceIn shadow-2xl shadow-red-900">
              {/* Efeito de brilho pulsante ao redor */}
              <div className="absolute inset-0 rounded-lg bg-red-500 opacity-20 animate-pulse blur-xl"></div>
              
              <div className="relative mb-6">
                <div className="text-9xl mb-4 animate-pulse drop-shadow-2xl">💣</div>
                <div className="flex items-center justify-center gap-2 mb-2">
                  <h2 className="text-5xl font-black text-white animate-pulse drop-shadow-lg">
                    BOOM!
                  </h2>
                </div>
                <h3 className="text-3xl font-bold text-yellow-300 mb-4 drop-shadow-lg">
                  💥 MINE FOUND! 💥
                </h3>
                {minePosition && (
                  <div className="bg-black/40 rounded-lg p-3 mb-3 border border-red-500/50">
                    <p className="text-lg text-white/90 font-semibold">
                      Mine Position: ({minePosition.x}, {minePosition.y})
                    </p>
                  </div>
                )}
                <div className="bg-black/50 rounded-lg p-4 mb-4 border-2 border-yellow-500/50">
                  <p className="text-sm text-yellow-200 mb-2">Lost Pot:</p>
                  <p className="text-3xl text-yellow-400 font-mono font-bold">
                    {lostPot} MON
                  </p>
                </div>
                <div className="bg-red-950/50 rounded-lg p-3 mb-4 border border-red-600">
                  <p className="text-white/80 text-sm">
                    ⚠️ Game over! You found a mine and lost all the accumulated pot.
                  </p>
                </div>
              </div>
              
              <button
                onClick={() => {
                  setShowMineModal(false)
                  setMinePosition(null)
                  setLostPot("0")
                }}
                className="relative w-full bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 px-6 py-4 rounded-lg font-bold text-white text-lg transition-all transform hover:scale-105 shadow-lg shadow-red-900/50 border-2 border-red-400"
              >
                Got it - Close
              </button>
            </div>
          </div>
        )}
    </main>
  )
}