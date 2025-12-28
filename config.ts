// config.ts
import { http, createConfig } from 'wagmi'
import { monadTestnet } from 'viem/chains'
import { injected} from 'wagmi/connectors'


// 2. Wagmi configuration
export const config = createConfig({
  chains: [monadTestnet],
  connectors: [injected()],
  transports: {
    [monadTestnet.id]: http(),
  },
  ssr: true, 
})