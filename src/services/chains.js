const CHAINS = {
  solana: {
    name: 'Solana',
    emoji: '◎',
    currency: 'SOL',
    explorer: 'https://solscan.io',
    txUrl: (sig) => `https://solscan.io/tx/${sig}`,
    tokenUrl: (mint) => `https://solscan.io/token/${mint}`,
  },
  robinhood: {
    name: 'Robinhood',
    emoji: '🪶',
    currency: 'ETH',
    chainId: 4663,
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    wsUrl: 'wss://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
    txUrl: (hash) => `https://robinhoodchain.blockscout.com/tx/${hash}`,
    tokenUrl: (addr) => `https://robinhoodchain.blockscout.com/token/${addr}`,
    uniswapRouter: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', // Uniswap Universal Router
    uniswapQuoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // Uniswap Quoter V2
    weth: '0x4200000000000000000000000000000000000006',
    uniswapFactory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
  },
};

module.exports = CHAINS;
