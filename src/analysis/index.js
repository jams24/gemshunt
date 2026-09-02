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

  async analyze({ chain, mint, deployer, poolAddress, dex, liquidityNative, symbol, name }) {
    const started = Date.now();

    const [safety, market, nativePriceUsd, tokenInfo, watcherBuys] = await Promise.all([
      this.safety.check(chain, mint),
      this.market.getPairData(chain, mint),
      this.swap.getNativePriceUsd(chain).catch(() => null),
      this.swap.getTokenInfo(chain, mint).catch(() => null),
      this.db.countWatchersBought(chain, mint, 60).catch(() => 0),
    ]);

    const analysis = await this.scorer.score({
      chain, mint, deployer, safety, market,
      liquidityNative, nativePriceUsd, watcherBuys,
    });

    const token = {
      chain,
      mint,
      symbol: symbol || tokenInfo?.symbol || 'UNKNOWN',
      name: name || tokenInfo?.name || null,
      deployer,
      poolAddress,
      dex,
      liquiditySol: liquidityNative,
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
