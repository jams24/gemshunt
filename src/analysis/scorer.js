const logger = require('../utils/logger');

/**
 * Category weights. They sum to 100, but categories with no data are dropped
 * and the rest are renormalised — a token isn't punished for a provider being
 * down, it's just scored on less evidence (surfaced as `confidence`).
 */
const WEIGHTS = {
  safety: 35,
  distribution: 20,
  liquidity: 20,
  deployer: 10,
  momentum: 15,
};

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

/** Linear score: `lo` or worse => 0, `hi` or better => 1. */
const scale = (v, lo, hi) => clamp((v - lo) / (hi - lo));

/** Inverted: `lo` or better => 1, `hi` or worse => 0. */
const inverseScale = (v, lo, hi) => clamp(1 - (v - lo) / (hi - lo));

class Scorer {
  constructor(db) {
    this.db = db;
    this._lastDeployer = null;
  }

  /**
   * @returns {{score:number, confidence:number, categories:object, bulls:string[], bears:string[], verdict:string}}
   */
  async score({ chain, mint, deployer, safety, market, liquidityNative, nativePriceUsd, watcherBuys = 0 }) {
    const cats = {};
    const bulls = [];
    const bears = [];

    // ---------------------------------------------------------- safety
    if (safety.honeypot === true) {
      // A token you cannot sell is worth zero regardless of everything else.
      return {
        score: 0,
        confidence: 1,
        categories: { safety: 0 },
        bulls: [],
        bears: safety.flags.length ? safety.flags : ['token cannot be sold'],
        verdict: 'HONEYPOT — do not buy',
      };
    }

    const safetyChecks = [safety.mintAuthorityRevoked, safety.freezeAuthorityRevoked];
    const known = safetyChecks.filter(v => v !== null);
    if (known.length) {
      let s = known.filter(Boolean).length / known.length;
      // A heavy round-trip loss is a sell tax even when the swap succeeds.
      if (safety.sellTaxPct != null && safety.sellTaxPct > 15) {
        s *= inverseScale(safety.sellTaxPct, 15, 60);
        bears.push(`~${safety.sellTaxPct.toFixed(0)}% round-trip loss (likely sell tax)`);
      }
      cats.safety = s;
      if (safety.mintAuthorityRevoked) bulls.push('Mint authority revoked');
      if (safety.freezeAuthorityRevoked) bulls.push('Freeze authority revoked');
    }

    // ---------------------------------------------------- distribution
    if (safety.topHolderPct != null) {
      // Under 25% across the top 10 is healthy; over 70% is a coordinated bag.
      const top = inverseScale(safety.topHolderPct, 25, 70);
      const dev = safety.devHoldingPct != null
        ? inverseScale(safety.devHoldingPct, 5, 30)
        : top;
      cats.distribution = top * 0.6 + dev * 0.4;

      if (safety.topHolderPct < 30) bulls.push(`Well distributed — top 10 hold ${safety.topHolderPct.toFixed(0)}%`);
      else bears.push(`Top 10 wallets hold ${safety.topHolderPct.toFixed(0)}%`);
      if (safety.devHoldingPct != null && safety.devHoldingPct > 15) {
        bears.push(`Largest wallet holds ${safety.devHoldingPct.toFixed(0)}%`);
      }
    }

    // ------------------------------------------------------- liquidity
    const liqUsd = market?.liquidityUsd
      ?? (liquidityNative && nativePriceUsd ? liquidityNative * nativePriceUsd : null);
    if (liqUsd != null) {
      // $5k is thin, $100k+ is deep for a fresh launch.
      let s = scale(liqUsd, 5000, 100000);

      // Liquidity relative to market cap matters more than the raw number: a
      // $50k pool under a $5m cap is an exit-liquidity trap.
      if (market?.marketCap) {
        const ratio = liqUsd / market.marketCap;
        s = s * 0.6 + scale(ratio, 0.02, 0.25) * 0.4;
        if (ratio < 0.03) bears.push(`Liquidity only ${(ratio * 100).toFixed(1)}% of market cap`);
      }
      if (safety.lpBurnedPct != null && safety.lpBurnedPct > 50) {
        s = Math.min(1, s + 0.15);
        bulls.push(`LP burned (${safety.lpBurnedPct.toFixed(0)}%)`);
      }
      cats.liquidity = clamp(s);
      if (liqUsd >= 25000) bulls.push(`$${Math.round(liqUsd / 1000)}k liquidity`);
      else if (liqUsd < 5000) bears.push(`Very thin liquidity ($${Math.round(liqUsd)})`);
    }

    // -------------------------------------------------------- deployer
    const dep = await this._deployerScore(chain, deployer, bulls, bears);
    if (dep != null) cats.deployer = dep;

    // -------------------------------------------------------- momentum
    if (market) {
      const totalTx = market.buys5m + market.sells5m;
      if (totalTx >= 5) {
        // Buy pressure: 50/50 is neutral, 75%+ buys is real demand.
        const buyRatio = market.buys5m / totalTx;
        let s = scale(buyRatio, 0.4, 0.75) * 0.5 + scale(totalTx, 10, 150) * 0.3;
        if (market.socials) s += 0.1;
        if (market.boosts > 0) s += 0.1;
        cats.momentum = clamp(s);

        if (buyRatio > 0.7) bulls.push(`Strong buy pressure (${market.buys5m}B / ${market.sells5m}S in 5m)`);
        if (buyRatio < 0.4) bears.push(`Sell pressure (${market.buys5m}B / ${market.sells5m}S in 5m)`);
        if (market.socials) {
          bulls.push(`Socials present (${Object.keys(market.socials).filter(k => k !== 'image').join(', ')})`);
        }
      }
    }

    // Smart-money confluence overrides thin data — if wallets with a track
    // record are buying, that's the strongest signal the bot can observe.
    if (watcherBuys >= 2) {
      cats.momentum = Math.max(cats.momentum ?? 0, 0.85);
      bulls.unshift(`${watcherBuys} tracked smart-money wallets bought this`);
    } else if (watcherBuys === 1) {
      bulls.push('1 tracked wallet bought this');
    }

    // ------------------------------------------------ weighted rollup
    let weighted = 0;
    let weightUsed = 0;
    for (const [name, value] of Object.entries(cats)) {
      weighted += value * WEIGHTS[name];
      weightUsed += WEIGHTS[name];
    }
    let rawScore = weightUsed ? Math.round((weighted / weightUsed) * 100) : 0;

    // A clean contract and deep liquidity are exactly what a competent serial
    // rugger also ships. Deployer history is only 10% of the weighted score,
    // which is nowhere near enough to stop one clearing the alert threshold —
    // so apply it as a penalty on the total, scaled by how well evidenced it is.
    const dh = this._lastDeployer;
    this._lastDeployer = null;
    if (dh && dh.rugRate > 0.5) {
      const severity = Math.min(dh.resolved, 3) / 3; // 1 rug = weak, 3+ = conclusive
      const penalty = 1 - 0.55 * dh.rugRate * severity;
      rawScore = Math.round(rawScore * penalty);
      bears.unshift(
        dh.resolved >= 3
          ? 'Serial rugger — treat any score here as unreliable'
          : 'Deployer history is negative on a small sample'
      );
    }
    const confidence = weightUsed / 100;

    // Shrink toward neutral in proportion to missing evidence. Without this a
    // token that only clears two cheap on-chain checks and has no market data
    // scores a perfect 100 on 35% confidence — and gets alerted as a top call.
    // Two passing checks is not the same claim as a fully evidenced 100.
    const NEUTRAL = 50;
    const score = Math.round(rawScore * confidence + NEUTRAL * (1 - confidence));

    if (!bears.length && score >= 60) bulls.push('No red flags detected');
    for (const f of safety.flags || []) if (!bears.includes(f)) bears.push(f);

    return {
      score,
      rawScore,
      confidence,
      categories: Object.fromEntries(
        Object.entries(cats).map(([k, v]) => [k, Math.round(v * 100)])
      ),
      bulls,
      bears,
      verdict: this._verdict(score, confidence),
    };
  }

  async _deployerScore(chain, deployer, bulls, bears) {
    if (!deployer) return null;
    try {
      const stats = await this.db.getDeployerStats(chain, deployer);
      if (!stats) return null;

      // Evidence is resolved OUTCOMES, not launch count. A deployer whose one
      // previous token already rugged is damning even though it's only their
      // second launch — gating on launch count threw that away.
      const resolved = stats.rugs + stats.runners;
      if (resolved === 0) return null;

      const rugRate = stats.rugs / resolved;
      if (stats.rugs > 0) {
        bears.push(
          `Deployer has rugged ${stats.rugs} of ${resolved} resolved launch${resolved > 1 ? 'es' : ''}`
        );
      }
      if (stats.runners > 0) {
        bulls.push(`Deployer has ${stats.runners} prior runner${stats.runners > 1 ? 's' : ''} (best ${Number(stats.best_multiple || 0).toFixed(1)}x)`);
      }
      this._lastDeployer = { rugRate, rugs: stats.rugs, resolved };
      return clamp(1 - rugRate);
    } catch (err) {
      logger.error(`[scorer] deployer lookup: ${err.message}`);
      return null;
    }
  }

  _verdict(score, confidence) {
    if (confidence < 0.4) return 'INSUFFICIENT DATA';
    if (score >= 85) return 'HIGH CONVICTION';
    if (score >= 70) return 'STRONG';
    if (score >= 55) return 'SPECULATIVE';
    if (score >= 35) return 'WEAK';
    return 'AVOID';
  }
}

module.exports = Scorer;
module.exports.WEIGHTS = WEIGHTS;
