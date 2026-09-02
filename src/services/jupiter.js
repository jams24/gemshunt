const axios = require('axios');
const { VersionedTransaction } = require('@solana/web3.js');
const logger = require('../utils/logger');

const WSOL = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://quote-api.jup.ag/v6';

class JupiterService {
  constructor(connection) {
    this.connection = connection;
  }

  async getQuote(inputMint, outputMint, amount, slippageBps = 500) {
    const { data } = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint,
        outputMint,
        amount: Math.floor(amount).toString(),
        slippageBps,
        onlyDirectRoutes: false,
      },
      timeout: 10000,
    });
    return data;
  }

  async swap(keypair, inputMint, outputMint, amount, slippageBps = 500) {
    const quote = await this.getQuote(inputMint, outputMint, amount, slippageBps);

    const { data } = await axios.post(`${JUPITER_API}/swap`, {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }, { timeout: 15000 });

    const txBuf = Buffer.from(data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const sig = await this.connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
    await this.connection.confirmTransaction(sig, 'confirmed');

    logger.info(`Swap executed: ${sig}`);
    return {
      signature: sig,
      inputAmount: Number(quote.inAmount),
      outputAmount: Number(quote.outAmount),
      priceImpactPct: Number(quote.priceImpactPct),
    };
  }

  async buy(keypair, tokenMint, solAmount, slippageBps) {
    const lamports = Math.floor(solAmount * 1e9);
    logger.info(`Buying ${tokenMint} with ${solAmount} SOL`);
    return this.swap(keypair, WSOL, tokenMint, lamports, slippageBps);
  }

  async sell(keypair, tokenMint, tokenAmount, slippageBps) {
    logger.info(`Selling ${tokenAmount} of ${tokenMint}`);
    return this.swap(keypair, tokenMint, WSOL, tokenAmount, slippageBps);
  }

  async getPrice(tokenMint) {
    try {
      const res = await axios.get(`https://price.jup.ag/v6/price`, {
        params: { ids: tokenMint },
        timeout: 5000,
      });
      return res.data.data?.[tokenMint]?.price || null;
    } catch {
      return null;
    }
  }
}

module.exports = JupiterService;
