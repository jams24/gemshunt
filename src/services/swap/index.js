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
  constructor(solanaConnection) {
    this.adapters = {
      solana: new SolanaSwapAdapter(solanaConnection),
      robinhood: new EvmSwapAdapter(CHAINS.robinhood),
    };
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
    return this.adapter(chain).buy(signer, mint, nativeAmount, slippageBps);
  }

  async sell(chain, signer, mint, rawTokenAmount, slippageBps) {
    return this.adapter(chain).sell(signer, mint, rawTokenAmount, slippageBps);
  }

  /** USD price per whole token, or null when there's no route. */
  async getPrice(chain, mint) {
    if (chain === 'solana') return this.adapter(chain).getPrice(mint);
    const nativeUsd = await this.getNativePriceUsd(chain);
    return this.adapter(chain).getPrice(mint, nativeUsd);
  }

  async getTokenInfo(chain, mint) {
    return this.adapter(chain).getTokenInfo(mint);
  }

  async checkSellable(chain, mint, decimals) {
    return this.adapter(chain).checkSellable(mint, decimals);
  }

  async getNativePriceUsd(chain) {
    const cached = this._priceCache.get(chain);
    if (cached && cached.expires > Date.now()) return cached.price;

    const id = COINGECKO_IDS[chain];
    try {
      const { data } = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
        { timeout: 5000 }
      );
      const price = data[id].usd;
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
