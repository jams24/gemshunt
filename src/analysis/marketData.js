const axios = require('axios');
const logger = require('../utils/logger');

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens';
const CACHE_TTL_MS = 30 * 1000;
// "Not indexed yet" is the normal answer for a pool seconds old, and it
// changes within minutes — cache it briefly so re-checks see the pair appear.
const MISS_TTL_MS = 10 * 1000;

// DexScreener's chain slugs. Robinhood Chain IS indexed (chainId "robinhood"),
// typically within ~3 minutes of a pool's creation; this used to be null, so
// Robinhood tokens never had market data at all.
const DEX_CHAIN_SLUG = { solana: 'solana', robinhood: 'robinhood' };

/**
 * Free-tier market data. Everything here is best-effort: any provider failure
 * yields null, never an exception, because a missing data point must not stop
 * a token from being scored.
 */
class MarketData {
  constructor() {
    this.cache = new Map();
  }

  _cached(key) {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    return undefined;
  }

  _store(key, value) {
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, { value, expires: Date.now() + (value ? CACHE_TTL_MS : MISS_TTL_MS) });
    return value;
  }

  /**
   * Pair-level stats: price, liquidity, volume, buy/sell counts, socials.
   * Returns null when the token has no indexed pair yet (very common in the
   * first seconds of a launch, which is exactly when we're looking).
   */
  async getPairData(chain, mint) {
    const slug = DEX_CHAIN_SLUG[chain];
    if (!slug) return null;

    const key = `pair:${chain}:${mint}`;
    const hit = this._cached(key);
    if (hit !== undefined) return hit;

    try {
      const { data } = await axios.get(`${DEXSCREENER}/${mint}`, { timeout: 6000 });
      const pairs = (data?.pairs || []).filter(p => p.chainId === slug);
      this.lastOkAt = Date.now();
      if (!pairs.length) return this._store(key, null);

      // Deepest pool is the honest one — thin side-pools give garbage prices.
      const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

      // The pair carries the token's name and symbol, which neither the RPC
      // nor the SPL mint account provides on Solana.
      const base = pair.baseToken?.address?.toLowerCase() === mint.toLowerCase()
        ? pair.baseToken
        : pair.quoteToken;

      return this._store(key, {
        symbol: base?.symbol || null,
        name: base?.name || null,
        priceUsd: parseFloat(pair.priceUsd) || null,
        priceNative: parseFloat(pair.priceNative) || null,
        liquidityUsd: pair.liquidity?.usd || 0,
        marketCap: pair.marketCap || pair.fdv || null,
        volume5m: pair.volume?.m5 || 0,
        volume1h: pair.volume?.h1 || 0,
        buys5m: pair.txns?.m5?.buys || 0,
        sells5m: pair.txns?.m5?.sells || 0,
        buys1h: pair.txns?.h1?.buys || 0,
        sells1h: pair.txns?.h1?.sells || 0,
        priceChange5m: pair.priceChange?.m5 || 0,
        priceChange1h: pair.priceChange?.h1 || 0,
        pairCreatedAt: pair.pairCreatedAt || null,
        socials: this._extractSocials(pair),
        boosts: pair.boosts?.active || 0,
      });
    } catch (err) {
      // A provider failure is not "no pair" — don't cache it, and record it so
      // a dead DexScreener is visible rather than looking like a quiet market.
      this.lastError = { at: Date.now(), message: err.response?.status ? `HTTP ${err.response.status}` : err.message };
      logger.debug?.(`[market] ${chain}/${mint}: ${err.message}`);
      return null;
    }
  }

  _extractSocials(pair) {
    const info = pair.info || {};
    const socials = {};
    for (const s of info.socials || []) {
      if (s.type && s.url) socials[s.type] = s.url;
    }
    if (info.websites?.length) socials.website = info.websites[0].url;
    if (info.imageUrl) socials.image = info.imageUrl;
    return Object.keys(socials).length ? socials : null;
  }

  /** Age of the pair in minutes, or null if unknown. */
  ageMinutes(pairData) {
    if (!pairData?.pairCreatedAt) return null;
    return (Date.now() - pairData.pairCreatedAt) / 60000;
  }
}

module.exports = MarketData;
