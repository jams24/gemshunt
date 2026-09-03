const axios = require('axios');
const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
const logger = require('../../utils/logger');

const WSOL = 'So11111111111111111111111111111111111111112';
// Jupiter retired quote-api.jup.ag/v6 and price.jup.ag — the former now fails
// to connect and the latter no longer resolves at all. The current free
// endpoints are lite-api.jup.ag; api.jup.ag is the same API behind a key.
const JUPITER_HOST = process.env.JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
const JUPITER_API = `${JUPITER_HOST}/swap/v1`;
const JUPITER_PRICE = `${JUPITER_HOST}/price/v3`;
const JUPITER_HEADERS = process.env.JUPITER_API_KEY
  ? { 'x-api-key': process.env.JUPITER_API_KEY }
  : {};

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
      headers: JUPITER_HEADERS,
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
    }, { timeout: 15000, headers: JUPITER_HEADERS });

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
      const { data } = await axios.get(JUPITER_PRICE, {
        params: { ids: mint }, timeout: 5000, headers: JUPITER_HEADERS,
      });
      // price/v3 returns { <mint>: { usdPrice, decimals, ... } } — flatter
      // than v2's { data: { <mint>: { price } } }.
      const entry = data?.[mint] ?? data?.data?.[mint];
      const p = entry?.usdPrice ?? entry?.price;
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
  /**
   * Sellability probe. Returns sellable:null for UNKNOWN — an API failure is
   * not evidence of a honeypot, and treating it as one condemned every token
   * the moment Jupiter's endpoint moved.
   */
  async checkSellable(mint, decimals = 9) {
    let buyQuote;
    try {
      buyQuote = await this.quote(WSOL, mint, 1e8, 1500); // 0.1 SOL in
    } catch (err) {
      // No route yet is normal for a pool seconds old; a network error tells
      // us nothing about the token. Either way: unknown, not guilty.
      return { sellable: null, reason: `buy probe failed: ${err.message}` };
    }
    if (!buyQuote.outAmount) return { sellable: null, reason: 'no buy route yet' };

    try {
      const sellQuote = await this.quote(mint, WSOL, buyQuote.outAmount, 1500);
      if (!sellQuote.outAmount) {
        return { sellable: false, reason: 'no sell route while a buy route exists' };
      }
      const roundTripLoss = 1 - (sellQuote.outAmount / 1e8);
      return {
        sellable: true,
        roundTripLossPct: roundTripLoss * 100,
        reason: null,
      };
    } catch (err) {
      // A buy route exists but the sell quote errors — that asymmetry is the
      // actual honeypot signature.
      return { sellable: false, reason: `sell quote failed: ${err.message}` };
    }
  }
}

module.exports = SolanaSwapAdapter;
