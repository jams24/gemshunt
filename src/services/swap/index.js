const axios = require('axios');
const logger = require('../../utils/logger');
const CHAINS = require('../chains');
const SolanaSwapAdapter = require('./solanaSwap');
const EvmSwapAdapter = require('./evmSwap');

const COINGECKO_IDS = { solana: 'solana', robinhood: 'ethereum' };
const PRICE_TTL_MS = 60 * 1000;
const FALLBACK_PRICE = { solana: 150, robinhood: 2500 };

/**
 * Chain-agnostic swap facade. TradeEngine talks only to this, so it never
 * branches on chain and a new chain is one adapter away.
 */
class SwapRouter {
  constructor(solanaConnection, { db } = {}) {
    this.adapters = {
      solana: new SolanaSwapAdapter(solanaConnection),
      robinhood: new EvmSwapAdapter(CHAINS.robinhood),
    };
    // Used to recover V4 pool keys after a restart. Without it, a Robinhood
    // position opened before a redeploy could never be priced again, so its
    // TP/SL ladder silently stopped firing.
    this.db = db || null;
    // CoinGecko's free tier rate-limits hard and the old code hit it on every
    // position check. One cached price per chain per minute is plenty.
    this._priceCache = new Map();
  }

  adapter(chain) {
    const a = this.adapters[chain];
    if (!a) throw new Error(`Unsupported chain: ${chain}`);
    return a;
  }

  chains() {
    return Object.keys(this.adapters);
  }

  async buy(chain, signer, mint, nativeAmount, slippageBps) {
    if (chain !== 'solana') await this.resolvePoolKey(chain, mint);
    return this.adapter(chain).buy(signer, mint, nativeAmount, slippageBps);
  }

  async sell(chain, signer, mint, rawTokenAmount, slippageBps) {
    if (chain !== 'solana') await this.resolvePoolKey(chain, mint);
    return this.adapter(chain).sell(signer, mint, rawTokenAmount, slippageBps);
  }

  /** USD price per whole token, or null when there's no route. */
  async getPrice(chain, mint, poolKey) {
    if (chain === 'solana') return this.adapter(chain).getPrice(mint);
    const key = poolKey || await this.resolvePoolKey(chain, mint);
    const nativeUsd = await this.getNativePriceUsd(chain);
    return this.adapter(chain).getPrice(mint, nativeUsd, key);
  }

  /**
   * The V4 pool key for a token: from the adapter's memory, else from the
   * database row the scanner wrote when it first saw the pool.
   */
  async resolvePoolKey(chain, mint) {
    const adapter = this.adapter(chain);
    const known = adapter.knownPool?.(mint);
    if (known || !this.db) return known || null;
    try {
      const row = await this.db.getToken(chain, mint);
      if (row?.pool_key) {
        adapter.rememberPool?.(mint, row.pool_key);
        return row.pool_key;
      }
    } catch { /* fall through: unknown */ }
    return null;
  }

  async getTokenInfo(chain, mint) {
    return this.adapter(chain).getTokenInfo(mint);
  }

  async checkSellable(chain, mint, decimals, poolKey) {
    const key = chain === 'solana' ? null : (poolKey || await this.resolvePoolKey(chain, mint));
    return this.adapter(chain).checkSellable(mint, decimals, key);
  }

  /** Native-side pool depth, where the adapter can measure it. */
  async getLiquidityEstimate(chain, mint, poolKey) {
    const adapter = this.adapter(chain);
    if (!adapter.getLiquidityEstimate) return null;
    const key = poolKey || await this.resolvePoolKey(chain, mint);
    return adapter.getLiquidityEstimate(mint, key);
  }

  /** Record a pool key discovered by the scanner so later quotes can use it. */
  rememberPool(chain, mint, poolKey) {
    const adapter = this.adapter(chain);
    adapter.rememberPool?.(mint, poolKey);
  }

  async getNativePriceUsd(chain) {
    const cached = this._priceCache.get(chain);
    if (cached && cached.expires > Date.now()) return cached.price;

    const id = COINGECKO_IDS[chain];
    try {
      // Jupiter prices SOL without CoinGecko's aggressive free-tier limits.
      let price = chain === 'solana'
        ? await this.adapters.solana.getPrice('So11111111111111111111111111111111111111112')
        : null;
      if (!price) {
        const { data } = await axios.get(
          `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
          { timeout: 5000 }
        );
        price = data[id].usd;
      }
      this._priceCache.set(chain, { price, expires: Date.now() + PRICE_TTL_MS });
      return price;
    } catch (err) {
      // Serve a stale price over no price — a missed TP is worse than a
      // slightly-off USD figure.
      if (cached) return cached.price;
      logger.warn(`[${chain}] native price unavailable, using fallback: ${err.message}`);
      return FALLBACK_PRICE[chain];
    }
  }

  /** Native decimals for a chain (9 on Solana, 18 on EVM). */
  nativeDecimals(chain) {
    return this.adapter(chain).nativeDecimals;
  }

  /** Convert a raw native amount to a human float. */
  fromRawNative(chain, raw) {
    return Number(raw) / 10 ** this.nativeDecimals(chain);
  }
}

module.exports = SwapRouter;
