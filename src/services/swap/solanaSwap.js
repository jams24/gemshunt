const axios = require('axios');
const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
const logger = require('../../utils/logger');

const WSOL = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://quote-api.jup.ag/v6';
const JUPITER_PRICE = 'https://api.jup.ag/price/v2';

/**
 * Solana swap adapter (Jupiter v6). Amounts crossing this boundary are always
 * RAW integer units — the router owns decimal conversion, not the caller.
 */
class SolanaSwapAdapter {
  constructor(connection) {
    this.connection = connection;
    this.chain = 'solana';
    this.nativeMint = WSOL;
    this.nativeDecimals = 9;
  }

  async quote(inputMint, outputMint, rawAmount, slippageBps = 500) {
    const { data } = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint, outputMint,
        amount: Math.floor(rawAmount).toString(),
        slippageBps,
        onlyDirectRoutes: false,
      },
      timeout: 10000,
    });
    return {
      inAmount: Number(data.inAmount),
      outAmount: Number(data.outAmount),
      priceImpactPct: Number(data.priceImpactPct),
      raw: data,
    };
  }

  async _swap(signer, inputMint, outputMint, rawAmount, slippageBps) {
    const quote = await this.quote(inputMint, outputMint, rawAmount, slippageBps);

    const { data } = await axios.post(`${JUPITER_API}/swap`, {
      quoteResponse: quote.raw,
      userPublicKey: signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }, { timeout: 15000 });

    const tx = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
    tx.sign([signer]);

    const sig = await this.connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
    const conf = await this.connection.confirmTransaction(sig, 'confirmed');
    if (conf.value?.err) throw new Error(`Swap reverted on-chain: ${JSON.stringify(conf.value.err)}`);

    logger.info(`[sol] swap ${sig}`);
    return {
      signature: sig,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
    };
  }

  /** nativeAmount in SOL; returns outputAmount in RAW token units. */
  async buy(signer, mint, nativeAmount, slippageBps) {
    return this._swap(signer, WSOL, mint, Math.floor(nativeAmount * 1e9), slippageBps);
  }

  /** rawTokenAmount in RAW units; returns outputAmount in RAW lamports. */
  async sell(signer, mint, rawTokenAmount, slippageBps) {
    return this._swap(signer, mint, WSOL, Math.floor(Number(rawTokenAmount)), slippageBps);
  }

  /** Price in USD, or null if Jupiter has no route yet. */
  async getPrice(mint) {
    try {
      const { data } = await axios.get(JUPITER_PRICE, { params: { ids: mint }, timeout: 5000 });
      const p = data?.data?.[mint]?.price;
      return p ? Number(p) : null;
    } catch {
      return null;
    }
  }

  async getTokenInfo(mint) {
    try {
      const mintPk = new PublicKey(mint);
      const [supply, info] = await Promise.all([
        this.connection.getTokenSupply(mintPk),
        this.connection.getParsedAccountInfo(mintPk),
      ]);
      const parsed = info?.value?.data?.parsed?.info;
      return {
        symbol: null,
        name: null,
        decimals: supply.value.decimals,
        totalSupply: Number(supply.value.uiAmount),
        rawSupply: supply.value.amount,
        mintAuthorityRevoked: !parsed?.mintAuthority,
        freezeAuthorityRevoked: !parsed?.freezeAuthority,
      };
    } catch (err) {
      logger.error(`[sol] token info ${mint}: ${err.message}`);
      return null;
    }
  }

  /**
   * Sellability probe. Ask Jupiter to route a small sell of the token back to
   * SOL; if no route exists or the quote round-trips at a catastrophic loss,
   * the token is effectively a honeypot. Costs nothing — quote only, no tx.
   */
  async checkSellable(mint, decimals = 9) {
    try {
      const probe = Math.floor(10 ** decimals); // 1 whole token
      const buyQuote = await this.quote(WSOL, mint, 1e8, 1500); // 0.1 SOL in
      if (!buyQuote.outAmount) return { sellable: false, reason: 'no buy route' };

      const sellQuote = await this.quote(mint, WSOL, Math.min(buyQuote.outAmount, probe * 1e6), 1500);
      if (!sellQuote.outAmount) return { sellable: false, reason: 'no sell route' };

      const roundTripLoss = 1 - (sellQuote.outAmount / 1e8);
      return {
        sellable: roundTripLoss < 0.9,
        roundTripLossPct: roundTripLoss * 100,
        reason: roundTripLoss >= 0.9 ? 'round-trip loses >90%' : null,
      };
    } catch (err) {
      return { sellable: false, reason: `probe failed: ${err.message}` };
    }
  }
}

module.exports = SolanaSwapAdapter;
