const logger = require('../utils/logger');
const { settle } = require('../utils/async');
const MarketData = require('./marketData');
const SafetyChecker = require('./safety');
const Scorer = require('./scorer');

// Per-signal budgets. Every one of these can hang on a bad day; a missing
// signal lowers confidence, a hung one used to stall the whole pipeline.
const BUDGET = {
  safety: 12000,
  market: 7000,
  nativePrice: 5000,
  tokenInfo: 8000,
  watchers: 3000,
  depth: 9000,
  price: 8000,
};

/**
 * The thesis engine. Given a pool sighting it gathers safety, market and
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

  async analyze({ chain, mint, deployer, poolAddress, lpMint, dex, liquidityNative, priceNative, symbol, name, poolKey }) {
    const started = Date.now();
    const isSolana = chain === 'solana';

    // A V4 pool key cannot be derived, only observed. Fall back to one stored
    // from a previous sighting so /scan works on tokens we saw earlier.
    let key = poolKey || null;
    if (!key && !isSolana) key = await settle(this.swap.resolvePoolKey(chain, mint), 3000, null);

    const [safety, market, nativePriceUsd, tokenInfo, watcherBuys, depth, quotedPrice] = await Promise.all([
      settle(this.safety.check(chain, mint, { poolKey: key, poolAddress, lpMint, deployer }), BUDGET.safety,
        { flags: ['safety checks timed out'], honeypot: null }),
      settle(this.market.getPairData(chain, mint), BUDGET.market, null),
      settle(this.swap.getNativePriceUsd(chain), BUDGET.nativePrice, null),
      settle(this.swap.getTokenInfo(chain, mint), BUDGET.tokenInfo, null),
      settle(this.db.countWatchersBought(chain, mint, 60), BUDGET.watchers, 0),
      // The scanner measured Solana depth from the pool itself; EVM needs
      // the price-impact estimate.
      liquidityNative != null || isSolana
        ? Promise.resolve(null)
        : settle(this.swap.getLiquidityEstimate(chain, mint, key), BUDGET.depth, null),
      settle(this.swap.getPrice(chain, mint, key), BUDGET.price, null),
    ]);

    const liquidity = liquidityNative ?? depth;
    const supply = safety.totalSupply ?? tokenInfo?.totalSupply ?? null;
    // Opening-reserve price is only a fallback: it is right at t=0 and stale
    // a minute later, by which time Jupiter or DexScreener will have one.
    const priceUsd = market?.priceUsd ?? quotedPrice
      ?? (priceNative && nativePriceUsd ? priceNative * nativePriceUsd : null);
    const marketCap = market?.marketCap ?? (priceUsd && supply ? priceUsd * supply : null);

    // What the scorer sees: real market data when the pair is indexed;
    // otherwise only the market cap we can derive ourselves. Feeding it a
    // synthetic object with liquidityUsd: 0 told it every unindexed token had
    // no liquidity at all.
    const scoringMarket = market || (marketCap ? { marketCap } : null);

    const analysis = await this.scorer.score({
      chain, mint, deployer, safety, market: scoringMarket,
      liquidityNative: liquidity, nativePriceUsd, watcherBuys,
    });

    const token = {
      chain,
      mint,
      symbol: symbol || market?.symbol || tokenInfo?.symbol || 'UNKNOWN',
      name: name || market?.name || tokenInfo?.name || null,
      deployer,
      poolAddress,
      lpMint: lpMint || null,
      dex,
      liquiditySol: liquidity ?? null,
      liquidityUsd: market?.liquidityUsd
        || (liquidity != null && nativePriceUsd ? liquidity * nativePriceUsd * 2 : null),
      initialMc: marketCap,
      decimals: safety.decimals ?? tokenInfo?.decimals ?? null,
      totalSupply: supply,
      holderCount: safety.holderCount ?? null,
      devHoldingPct: safety.devHoldingPct ?? null,
      topHolderPct: safety.topHolderPct ?? null,
      lpBurnedPct: safety.lpBurnedPct ?? null,
      lpLocked: safety.lpLocked ?? null,
      lpUnlockedPct: safety.lpUnlockedPct ?? null,
      mintAuthorityRevoked: safety.mintAuthorityRevoked ?? null,
      freezeAuthorityRevoked: safety.freezeAuthorityRevoked ?? null,
      honeypot: safety.honeypot ?? null,
      sellTaxPct: safety.sellTaxPct ?? null,
      isSafe: analysis.score >= 55 && safety.honeypot !== true,
      score: analysis.score,
      scoreBreakdown: {
        categories: analysis.categories,
        confidence: analysis.confidence,
        bulls: analysis.bulls,
        bears: analysis.bears,
      },
      thesis: analysis.verdict,
      socials: market?.socials || null,
      poolKey: key || null,
      priceUsd,
      marketCap,
      market: market || { priceUsd, marketCap },
      indexed: !!market,
      watcherBuys,
    };

    logger.info(
      `[analyze] ${chain}/${token.symbol} ${mint.slice(0, 8)} score=${analysis.score} ` +
      `verdict=${analysis.verdict} conf=${(analysis.confidence * 100).toFixed(0)}% ` +
      `market=${market ? 'yes' : 'no'} (${Date.now() - started}ms)`
    );

    return { token, analysis };
  }
}

module.exports = Analyzer;
module.exports.MarketData = MarketData;
module.exports.SafetyChecker = SafetyChecker;
module.exports.Scorer = Scorer;
