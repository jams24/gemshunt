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
    universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904',
    v4Quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
    poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    bagsFactory: '0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37',
  },
};

module.exports = CHAINS;
