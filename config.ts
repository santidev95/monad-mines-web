// src/config.ts
import { http, createConfig } from 'wagmi'
import { monadTestnet } from '@/utils/chains'
import { injected } from 'wagmi/connectors'


// 2. Configuração do Wagmi
export const config = createConfig({
  chains: [monadTestnet],
  connectors: [injected()],
  transports: {
    [monadTestnet.id]: http(),
  },
  ssr: true, 
})