// utils/contract.ts
// Module for interactions with MonadMines contract

import { type Address, type PublicClient, type Hex, decodeEventLog } from 'viem'
import { CONTRACT_ADDRESS, CONTRACT_ABI, ENTROPY_ADDRESS, ENTROPY_ABI } from './constants'

// Also exports for use in watchContractEvent
export { CONTRACT_ADDRESS, CONTRACT_ABI }


// Contract types
// games returns: [player, currentPot, seed, pythSeed, playerNonce, nonceCommit, revealedCells, isActive, isLost, nonceRevealed]
// Note: revealedCells is a bigint that represents a bitmask (each bit represents a revealed cell)
export type GameInfoArray = [string, bigint, Hex, Hex, Hex, Hex, bigint, boolean, boolean, boolean]
export type GameInfo = {
  player: string
  currentPot: bigint
  seed: Hex
  pythSeed: Hex
  playerNonce: Hex
  nonceCommit: Hex
  revealedCells: bigint // Bitmask of revealed cells
  isActive: boolean
  isLost: boolean
  nonceRevealed: boolean
}

// ============ READ FUNCTIONS ============

/**
 * Checks if a session key is registered for a user
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
 * Gets game information
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
 * Gets Entropy fee
 */
export async function getEntropyFee(publicClient: PublicClient): Promise<bigint> {
  const result = await publicClient.readContract({
    address: ENTROPY_ADDRESS,
    abi: ENTROPY_ABI,
    functionName: 'getFeeV2'
  })
  return result as bigint
}

// ============ WRITE FUNCTIONS (Main Wallet) ============

/**
 * Registers a session key
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
 * Revokes a session key
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
 * Starts a new game
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

// ============ WRITE FUNCTIONS (Burner Wallet) ============

/**
 * Reveals a cell in the game
 * @param walletClient - Wallet client (burner wallet)
 * @param gameId - Game ID
 * @param x - Cell X coordinate
 * @param y - Cell Y coordinate
 * @param nonce - Nonce to reveal (use zeroBytes32 if not the first move)
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
 * Zero bytes32 to use when nonce reveal is not needed
 */
export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex

/**
 * Cashes out a game
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

// ============ EVENT DECODING ============

/**
 * Decodes log event
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
 * Finds a specific event in logs and returns the raw log along with parsed
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
 * Event types
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
