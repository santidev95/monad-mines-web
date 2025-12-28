// utils/contract.ts
// Módulo para interações com o contrato MonadMines

import { type Address, type PublicClient, type Hex, decodeEventLog } from 'viem'
import { CONTRACT_ADDRESS, CONTRACT_ABI, ENTROPY_ADDRESS, ENTROPY_ABI } from './constants'

// Exporta também para uso em watchContractEvent
export { CONTRACT_ADDRESS, CONTRACT_ABI }


// Tipos do contrato
// games retorna: [player, currentPot, seed, pythSeed, playerNonce, nonceCommit, revealedCells, isActive, isLost, nonceRevealed]
// Nota: revealedCells é um bigint que representa um bitmask (cada bit representa uma célula revelada)
export type GameInfoArray = [string, bigint, Hex, Hex, Hex, Hex, bigint, boolean, boolean, boolean]
export type GameInfo = {
  player: string
  currentPot: bigint
  seed: Hex
  pythSeed: Hex
  playerNonce: Hex
  nonceCommit: Hex
  revealedCells: bigint // Bitmask das células reveladas
  isActive: boolean
  isLost: boolean
  nonceRevealed: boolean
}

// ============ FUNÇÕES DE LEITURA ============

/**
 * Verifica se uma session key está registrada para um usuário
 */
export async function getSessionDelegate(
  publicClient: PublicClient,
  sessionKey: Address
): Promise<Address> {
  const result = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: 'sessionDelegates',
    args: [sessionKey]
  })
  return result as Address
}

/**
 * Obtém informações de um jogo
 */
export async function getGameInfo(
  publicClient: PublicClient,
  gameId: bigint
): Promise<GameInfo> {
  const result = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: 'games',
    args: [gameId]
  }) as GameInfoArray

  return {
    player: result[0],
    currentPot: result[1],
    seed: result[2],
    pythSeed: result[3],
    playerNonce: result[4],
    nonceCommit: result[5],
    revealedCells: result[6],
    isActive: result[7],
    isLost: result[8],
    nonceRevealed: result[9]
  }
}

/**
 * Obtém a taxa do Entropy
 */
export async function getEntropyFee(publicClient: PublicClient): Promise<bigint> {
  const result = await publicClient.readContract({
    address: ENTROPY_ADDRESS,
    abi: ENTROPY_ABI,
    functionName: 'getFeeV2'
  })
  return result as bigint
}

// ============ FUNÇÕES DE ESCRITA (Main Wallet) ============

/**
 * Registra uma session key
 */
export async function registerSessionKey(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeContractAsync: (params: any) => Promise<Hex>,
  sessionKey: Address
): Promise<Hex> {
  return await writeContractAsync({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: 'registerSessionKey',
    args: [sessionKey]
  })
}

/**
 * Revoga uma session key
 */
export async function revokeSessionKey(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeContractAsync: (params: any) => Promise<Hex>,
  sessionKey: Address
): Promise<Hex> {
  return await writeContractAsync({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: 'revokeSessionKey',
    args: [sessionKey]
  })
}

/**
 * Inicia um novo jogo
 */
export async function startGame(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeContractAsync: (params: any) => Promise<Hex>,
  nonceCommit: Hex,
  value: bigint
): Promise<Hex> {
  return await writeContractAsync({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: 'startGame',
    args: [nonceCommit],
    value
  })
}

// ============ FUNÇÕES DE ESCRITA (Burner Wallet) ============

/**
 * Revela uma célula no jogo
 * @param walletClient - Cliente wallet (burner wallet)
 * @param gameId - ID do jogo
 * @param x - Coordenada X da célula
 * @param y - Coordenada Y da célula
 * @param nonce - Nonce para revelar (use zeroBytes32 se não for o primeiro movimento)
 */
export async function revealCell(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient: any,
  gameId: bigint,
  x: number,
  y: number,
  nonce: Hex
): Promise<Hex> {
  return await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: 'revealCell',
    args: [gameId, x, y, nonce],
    gas: 200000n
  })
}

/**
 * Bytes32 zero para usar quando não é necessário revelar nonce
 */
export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex

/**
 * Faz cashout de um jogo
 */
export async function cashOut(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient: any,
  gameId: bigint
): Promise<Hex> {
  return await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: 'cashOut',
    args: [gameId]
  })
}

// ============ DECODIFICAÇÃO DE EVENTOS ============

/**
 * Decodifica evento de log
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeContractEvent(log: { data: Hex; topics: Hex[] }, eventName: string): any {
  try {
    const parsed = decodeEventLog({
      abi: CONTRACT_ABI,
      data: log.data,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      topics: log.topics as any
    })
    return parsed.eventName === eventName ? parsed : null
  } catch {
    return null
  }
}

/**
 * Encontra um evento específico nos logs e retorna o log raw junto com o parsed
 */
export function findEventInLogs(
  logs: Array<{ data: Hex; topics: Hex[] }>,
  eventName: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { data: Hex; topics: Hex[]; parsed: any } | null {
  for (const log of logs) {
    const parsed = decodeContractEvent(log, eventName)
    if (parsed) {
      return { ...log, parsed }
    }
  }
  return null
}

/**
 * Tipos de eventos
 */
export type GameRequestedEvent = {
  eventName: 'GameRequested'
  args: {
    gameId: bigint
    player: Address
    nonceCommit: Hex
  }
}

export type GameStartedEvent = {
  eventName: 'GameStarted'
  args: {
    gameId: bigint
  }
}

export type NonceRevealedEvent = {
  eventName: 'NonceRevealed'
  args: {
    gameId: bigint
    playerNonce: Hex
  }
}

export type CellRevealedEvent = {
  eventName: 'CellRevealed'
  args: {
    gameId: bigint
    x: number
    y: number
    isMine: boolean
    newPot: bigint
  }
}

export type SessionKeyRegisteredEvent = {
  eventName: 'SessionKeyRegistered'
  args: {
    user: Address
    sessionKey: Address
  }
}

export type SessionKeyRevokedEvent = {
  eventName: 'SessionKeyRevoked'
  args: {
    user: Address
    sessionKey: Address
  }
}
