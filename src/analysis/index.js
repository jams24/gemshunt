const logger = require('../utils/logger');
const MarketData = require('./marketData');
const SafetyChecker = require('./safety');
const Scorer = require('./scorer');

/**
 * The thesis engine. Given a bare token address it gathers safety, market and
 * reputation signals in parallel, scores them, and returns an enriched token
 * ready to persist and alert on.
 */
class Analyzer {
  constructor({ db, solanaConnection, swapRouter }) {
    this.db = db;
    this.market = new MarketData();
    this.safety = new SafetyChecker(solanaConnection, swapRouter);
    this.scorer = new Scorer(db);
    this.swap = swapRouter;
  }

  async analyze({ chain, mint, deployer, poolAddress, dex, liquidityNative, symbol, name, poolKey }) {
    const started = Date.now();

    // A V4 pool key cannot be derived, only observed. Fall back to one stored
    // from a previous sighting so /scan works on tokens we saw earlier.
    let key = poolKey;
    if (!key && chain !== 'solana') {
      const stored = await this.db.getToken(chain, mint).catch(() => null);
      key = stored?.pool_key || null;
      if (key) this.swap.rememberPool(chain, mint, key);
    }

    const race = (p, ms, fallback = null) =>
      Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

    const [safety, market, nativePriceUsd, tokenInfo, watcherBuys, depth, quotedPrice] = await Promise.all([
      race(this.safety.check(chain, mint, key), 8000, {}),
      race(this.market.getPairData(chain, mint), 8000),
      race(this.swap.getNativePriceUsd(chain).catch(() => null), 5000),
      race(this.swap.getTokenInfo(chain, mint).catch(() => null), 8000),
      race(this.db.countWatchersBought(chain, mint, 60).catch(() => 0), 3000, 0),
      race(this.swap.getLiquidityEstimate(chain, mint, key).catch(() => null), 8000),
      race(this.swap.getPrice(chain, mint, key).catch(() => null), 8000),
    ]);

    const liquidity = liquidityNative ?? depth;

    // For chains without DexScreener (e.g. Robinhood), build a synthetic
    // market object from on-chain data so the alert isn't all dashes.
    let effectiveMarket = market;
    if (!market) {
      logger.info(`[analyze] ${chain}/${mint} no DexScreener — quotedPrice=${quotedPrice}, tokenInfo=${!!tokenInfo}, poolKey=${!!key}, depth=${depth}, nativeUsd=${nativePriceUsd}`);
    }
    if (!market && (quotedPrice || tokenInfo)) {
      const supply = safety.totalSupply ?? tokenInfo?.totalSupply;
      const mc = quotedPrice && supply ? quotedPrice * supply : null;
      const liqUsd = liquidity && nativePriceUsd ? liquidity * nativePriceUsd : null;
      effectiveMarket = {
        symbol: tokenInfo?.symbol || null,
        name: tokenInfo?.name || null,
        priceUsd: quotedPrice,
        priceNative: quotedPrice && nativePriceUsd ? quotedPrice / nativePriceUsd : null,
        liquidityUsd: liqUsd || 0,
        marketCap: mc,
        volume5m: 0, volume1h: 0,
        buys5m: 0, sells5m: 0,
        priceChange5m: 0, priceChange1h: 0,
        pairCreatedAt: null,
        socials: null,
        boosts: 0,
      };
    }

    const analysis = await this.scorer.score({
      chain, mint, deployer, safety, market: effectiveMarket,
      liquidityNative: liquidity, nativePriceUsd, watcherBuys,
    });

    const token = {
      chain,
      mint,
      symbol: symbol || effectiveMarket?.symbol || tokenInfo?.symbol || 'UNKNOWN',
      name: name || effectiveMarket?.name || tokenInfo?.name || null,
      deployer,
      poolAddress,
      dex,
      liquiditySol: liquidity,
      initialMc: effectiveMarket?.marketCap ?? null,
      decimals: safety.decimals ?? tokenInfo?.decimals ?? null,
      totalSupply: safety.totalSupply ?? tokenInfo?.totalSupply ?? null,
      holderCount: safety.holderCount,
      devHoldingPct: safety.devHoldingPct,
      topHolderPct: safety.topHolderPct,
      lpBurnedPct: safety.lpBurnedPct,
      lpLocked: safety.lpLocked,
      mintAuthorityRevoked: safety.mintAuthorityRevoked,
      freezeAuthorityRevoked: safety.freezeAuthorityRevoked,
      honeypot: safety.honeypot,
      isSafe: analysis.score >= 55 && safety.honeypot !== true,
      score: analysis.score,
      scoreBreakdown: {
        categories: analysis.categories,
        confidence: analysis.confidence,
        bulls: analysis.bulls,
        bears: analysis.bears,
      },
      thesis: analysis.verdict,
      socials: effectiveMarket?.socials || null,
      poolKey: key || null,
      priceUsd: effectiveMarket?.priceUsd ?? quotedPrice ?? null,
      marketCap: effectiveMarket?.marketCap ?? null,
      market: effectiveMarket,
      watcherBuys,
    };

    logger.info(
      `[analyze] ${chain}/${token.symbol} score=${analysis.score} ` +
      `verdict=${analysis.verdict} conf=${(analysis.confidence * 100).toFixed(0)}% ` +
      `(${Date.now() - started}ms)`
    );

    return { token, analysis };
  }
}

module.exports = Analyzer;
module.exports.MarketData = MarketData;
module.exports.SafetyChecker = SafetyChecker;
module.exports.Scorer = Scorer;
