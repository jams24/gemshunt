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

    const [safety, market, nativePriceUsd, tokenInfo, watcherBuys, depth, quotedPrice] = await Promise.all([
      this.safety.check(chain, mint, key),
      this.market.getPairData(chain, mint),
      this.swap.getNativePriceUsd(chain).catch(() => null),
      this.swap.getTokenInfo(chain, mint).catch(() => null),
      this.db.countWatchersBought(chain, mint, 60).catch(() => 0),
      // No indexer covers Robinhood Chain, so measure pool depth from price
      // impact instead. Without it these tokens have only one scored category
      // and never clear the confidence gate.
      this.swap.getLiquidityEstimate(chain, mint, key).catch(() => null),
      this.swap.getPrice(chain, mint, key).catch(() => null),
    ]);

    const liquidity = liquidityNative ?? depth;

    const analysis = await this.scorer.score({
      chain, mint, deployer, safety, market,
      liquidityNative: liquidity, nativePriceUsd, watcherBuys,
    });

    const token = {
      chain,
      mint,
      symbol: symbol || market?.symbol || tokenInfo?.symbol || 'UNKNOWN',
      name: name || market?.name || tokenInfo?.name || null,
      deployer,
      poolAddress,
      dex,
      liquiditySol: liquidity,
      initialMc: market?.marketCap ?? null,
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
      socials: market?.socials || null,
      poolKey: key || null,
      priceUsd: market?.priceUsd ?? quotedPrice ?? null,
      marketCap: market?.marketCap
        ?? ((market?.priceUsd ?? quotedPrice) && (safety.totalSupply ?? tokenInfo?.totalSupply)
            ? (market?.priceUsd ?? quotedPrice) * (safety.totalSupply ?? tokenInfo?.totalSupply)
            : null),
      market,
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
