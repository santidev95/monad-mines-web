import { defineChain } from 'viem';

export const monad = /*#__PURE__*/ defineChain({
  id: 143,
  name: 'Monad',
  blockTime: 400,
  nativeCurrency: {
    name: 'Monad',
    symbol: 'MON',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.ankr.com/monad_mainnet/256da13e87c5eea9e7ff0ebcc823870ae3bcc971b2b0816793858d1469535957', 'https://rpc1.monad.xyz'],
      webSocket: ['wss://rpc.monad.xyz', 'wss://rpc1.monad.xyz'],
    },
  },
  blockExplorers: {
    default: {
      name: 'MonadVision',
      url: 'https://monadvision.com',
    },
    monadscan: {
      name: 'Monadscan',
      url: 'https://monadscan.com',
      apiUrl: 'https://api.monadscan.com/api',
    },
  },
  testnet: false,
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      blockCreated: 9248132,
    },
  },
})

export const monadTestnet = /*#__PURE__*/ defineChain({
  id: 10_143,
  name: 'Monad Testnet',
  blockTime: 400,
  nativeCurrency: {
    name: 'Testnet MON Token',
    symbol: 'MON',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.ankr.com/monad_testnet/256da13e87c5eea9e7ff0ebcc823870ae3bcc971b2b0816793858d1469535957','https://testnet-rpc.monad.xyz'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Monad Testnet explorer',
      url: 'https://testnet.monadexplorer.com',
    },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      blockCreated: 251449,
    },
  },
  testnet: true,
})