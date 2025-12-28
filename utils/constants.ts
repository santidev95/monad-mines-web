// src/utils/constants.ts
import { parseAbi } from 'viem'
import contractAbi from './abi.json'

export const CONTRACT_ADDRESS = "0xb622C9Ad048C61bFe11810baa94d51FcFCa65415";
export const ENTROPY_ADDRESS = "0x825c0390f379c631f3cf11a82a37d20bddf93c07" as const;

// ABI do contrato MonadMines importado do arquivo JSON
export const CONTRACT_ABI = contractAbi;

// ABI do contrato Entropy para obter a taxa
export const ENTROPY_ABI = parseAbi([
  "function getFeeV2() view returns (uint128)"
]);
