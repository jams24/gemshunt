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

// Unlocked LP is the cheapest rug there is: whoever holds the LP tokens can
// withdraw the pool in one transaction. Live, a common pattern is a hand-made
// PumpSwap pool on a vanity "...pump" mint seeded with exactly 85 SOL to look
// like a pump.fun graduation, LP kept by the creator. Such a token can still
// look clean on every other axis, so it is capped rather than weighted — and
// capped below the alert floor, because no user setting should surface it.
const UNLOCKED_LP_CAP = 30;
// When LP custody could not be read at all, hold the token just under the
// default alert bar until a re-check can see it.
const UNVERIFIED_LP_CAP = 59;
// Without a single trade there is no evidence of demand — only of safety.
// Cap such tokens below the STRONG band so "STRONG" always means someone is
// actually buying, and let the re-check promote them once trading starts.
const NO_MOMENTUM_CAP = 74;

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

/** Linear score: `lo` or worse => 0, `hi` or better => 1. */
const scale = (v, lo, hi) => clamp((v - lo) / (hi - lo));

/** Inverted: `lo` or better => 1, `hi` or worse => 0. */
const inverseScale = (v, lo, hi) => clamp(1 - (v - lo) / (hi - lo));

const reject = (verdict, bear, category = 'safety') => ({
  score: 0,
  rawScore: 0,
  confidence: 1,
  categories: { [category]: 0 },
  bulls: [],
  bears: [bear],
  verdict,
  rejected: true,
});

class Scorer {
  constructor(db) {
    this.db = db;
  }

  /**
   * @returns {{score:number, rawScore:number, confidence:number, categories:object,
   *            bulls:string[], bears:string[], verdict:string, rejected?:boolean}}
   */
  async score({ chain, deployer, safety, market, liquidityNative, nativePriceUsd, watcherBuys = 0 }) {
    const cats = {};
    const bulls = [];
    const bears = [];

    // ------------------------------------------------------ hard rejects
    // Each of these is a token you can lose everything on regardless of how
    // good the rest looks — no weighting can be allowed to outvote them.
    if (safety.honeypot === true) {
      const r = reject('HONEYPOT — do not buy', 'token cannot be sold');
      r.bears = safety.flags?.length ? safety.flags : r.bears;
      return r;
    }
    if (safety.fatal) return reject('REJECT — hostile token extension', safety.fatal);
    if (safety.devHoldingPct != null && safety.devHoldingPct > 20) {
      return reject('REJECT — dev holding too high',
        `Largest wallet holds ${safety.devHoldingPct.toFixed(0)}% — rug risk`, 'distribution');
    }
    if (safety.topHolderPct != null && safety.topHolderPct > 90) {
      return reject('REJECT — concentrated supply',
        `Top 10 wallets hold ${safety.topHolderPct.toFixed(0)}% — no real distribution`, 'distribution');
    }
    // Mint not revoked: hard reject on Solana, score penalty on EVM where
    // "owner not renounced" is common even on legitimate tokens.
    if (safety.mintAuthorityRevoked === false && chain === 'solana') {
      return reject('REJECT — mint not revoked', 'Mint authority NOT revoked — supply can be inflated at will');
    }
    if (safety.sybilWallets >= 8) {
      return reject('REJECT — sybil distribution',
        `${safety.sybilWallets} wallets hold identical amounts — fake holders`, 'distribution');
    }

    // ---------------------------------------------------------- safety
    const safetyChecks = [safety.mintAuthorityRevoked, safety.freezeAuthorityRevoked];
    const known = safetyChecks.filter(v => v !== null && v !== undefined);
    if (known.length) {
      let s = known.filter(Boolean).length / known.length;
      // On EVM, unrenounced ownership is common on legitimate tokens — floor
      // the safety score at 0.4 so it's a penalty, not a death sentence.
      if (chain !== 'solana' && s < 0.4) s = 0.4;
      if (chain !== 'solana' && safety.mintAuthorityRevoked === false) {
        bears.push('Owner not renounced — contract is still mutable');
      }
      if (safety.sellTaxPct != null && safety.sellTaxPct > 15) {
        s *= inverseScale(safety.sellTaxPct, 15, 60);
        bears.push(`~${safety.sellTaxPct.toFixed(0)}% lost on a buy+sell round trip right now`);
      } else if (safety.honeypot === false) {
        bulls.push('Sell route verified');
      }
      if (safety.transferFeePct) s *= inverseScale(safety.transferFeePct, 0, 10);
      cats.safety = s;
      if (safety.mintAuthorityRevoked === true) bulls.push(chain === 'solana' ? 'Mint authority revoked' : 'Ownership renounced');
      if (safety.freezeAuthorityRevoked === true && chain === 'solana') bulls.push('Freeze authority revoked');
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
    } else if (safety.devHoldingPct != null) {
      // EVM: no holder index, but the deployer's own balance is known.
      cats.distribution = inverseScale(safety.devHoldingPct, 5, 30);
      if (safety.devHoldingPct < 5) bulls.push(`Deployer holds ${safety.devHoldingPct.toFixed(1)}%`);
    }

    // ------------------------------------------------------- liquidity
    // DexScreener reports both sides of the pool; the scanner measures only
    // the native side, so double it to compare like with like.
    const liqUsd = market?.liquidityUsd
      || (liquidityNative && nativePriceUsd ? liquidityNative * nativePriceUsd * 2 : null);
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
      } else if (safety.lpLocked === true) {
        bulls.push('LP held by a program, not a wallet');
      }
      cats.liquidity = clamp(s);
      if (liqUsd >= 25000) bulls.push(`$${Math.round(liqUsd / 1000)}k liquidity`);
      else if (liqUsd < 5000) bears.push(`Very thin liquidity ($${Math.round(liqUsd)})`);
    }

    // -------------------------------------------------------- deployer
    const dep = await this._deployerScore(chain, deployer, bulls, bears);
    if (dep) cats.deployer = dep.score;

    // -------------------------------------------------------- momentum
    if (market) {
      // Prefer the 5-minute window; fall back to the hour for a token that
      // has been trading a while but is momentarily quiet.
      let buys = market.buys5m || 0;
      let sells = market.sells5m || 0;
      if (buys + sells < 5) { buys = market.buys1h || 0; sells = market.sells1h || 0; }
      const totalTx = buys + sells;
      if (totalTx >= 5) {
        // Buy pressure: 50/50 is neutral, 75%+ buys is real demand.
        const buyRatio = buys / totalTx;
        let s = scale(buyRatio, 0.4, 0.75) * 0.5 + scale(totalTx, 10, 150) * 0.3;
        if (market.socials) s += 0.1;
        if (market.boosts > 0) s += 0.1;
        cats.momentum = clamp(s);

        if (buyRatio > 0.7) bulls.push(`Strong buy pressure (${buys}B / ${sells}S)`);
        if (buyRatio < 0.4) bears.push(`Sell pressure (${buys}B / ${sells}S)`);
        if (market.socials) {
          const kinds = Object.keys(market.socials).filter(k => k !== 'image');
          if (kinds.length) bulls.push(`Socials present (${kinds.join(', ')})`);
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
    if (dep && dep.rugRate > 0.5) {
      const severity = Math.min(dep.resolved, 3) / 3; // 1 rug = weak, 3+ = conclusive
      const penalty = 1 - 0.55 * dep.rugRate * severity;
      rawScore = Math.round(rawScore * penalty);
      bears.unshift(
        dep.resolved >= 3
          ? 'Serial rugger — treat any score here as unreliable'
          : 'Deployer history is negative on a small sample'
      );
    }

    const caps = [];
    if (safety.lpUnlockedPct != null && safety.lpUnlockedPct >= 50) {
      caps.push(UNLOCKED_LP_CAP);
      bears.unshift(`LP not locked — ${safety.lpUnlockedPct.toFixed(0)}% held by a wallet that can pull liquidity`);
    } else if (safety.lpUnverified) {
      caps.push(UNVERIFIED_LP_CAP);
    }
    const hasMomentum = cats.momentum != null;
    if (!hasMomentum) caps.push(NO_MOMENTUM_CAP);

    const confidence = weightUsed / 100;

    // Shrink toward neutral in proportion to missing evidence. Without this a
    // token that only clears two cheap on-chain checks and has no market data
    // scores a perfect 100 on 35% confidence — and gets alerted as a top call.
    const NEUTRAL = 50;
    let score = Math.round(rawScore * confidence + NEUTRAL * (1 - confidence));
    // Caps apply after the shrink, which pulls UP as well as down.
    if (caps.length) score = Math.min(score, ...caps);
    if (caps.includes(UNLOCKED_LP_CAP) || caps.includes(UNVERIFIED_LP_CAP)) rawScore = Math.min(rawScore, score);

    for (const f of safety.flags || []) if (!bears.includes(f)) bears.push(f);
    if (!bears.length && score >= 60) bulls.push('No red flags detected');

    return {
      score,
      rawScore,
      confidence,
      categories: Object.fromEntries(
        Object.entries(cats).map(([k, v]) => [k, Math.round(v * 100)])
      ),
      bulls,
      bears,
      hasMomentum,
      verdict: this._verdict(score, confidence, hasMomentum),
    };
  }

  /**
   * Deployer reputation from resolved outcomes. Returns everything the caller
   * needs rather than stashing it on `this` — the old instance field was
   * shared across concurrently scored tokens, so one token could be penalised
   * for another's deployer.
   */
  async _deployerScore(chain, deployer, bulls, bears) {
    if (!deployer) return null;
    try {
      const stats = await this.db.getDeployerStats(chain, deployer);
      if (!stats) return null;

      // Evidence is resolved OUTCOMES, not launch count. A deployer whose one
      // previous token already rugged is damning even though it's only their
      // second launch — gating on launch count threw that away.
      const resolved = stats.rugs + stats.runners;
      if (resolved === 0) {
        if (stats.launches >= 10) bears.push(`Deployer has launched ${stats.launches} tokens`);
        return null;
      }

      const rugRate = stats.rugs / resolved;
      if (stats.rugs > 0) {
        bears.push(
          `Deployer has rugged ${stats.rugs} of ${resolved} resolved launch${resolved > 1 ? 'es' : ''}`
        );
      }
      if (stats.runners > 0) {
        bulls.push(`Deployer has ${stats.runners} prior runner${stats.runners > 1 ? 's' : ''} (best ${Number(stats.best_multiple || 0).toFixed(1)}x)`);
      }
      return { score: clamp(1 - rugRate), rugRate, rugs: stats.rugs, resolved };
    } catch (err) {
      logger.error(`[scorer] deployer lookup: ${err.message}`);
      return null;
    }
  }

  _verdict(score, confidence, hasMomentum = true) {
    if (confidence < 0.4) return 'INSUFFICIENT DATA';
    if (!hasMomentum && score >= 55) return 'EARLY — safety passed, no trades yet';
    if (score >= 85) return 'HIGH CONVICTION';
    if (score >= 70) return 'STRONG';
    if (score >= 55) return 'SPECULATIVE';
    if (score >= 35) return 'WEAK';
    return 'AVOID';
  }
}

module.exports = Scorer;
module.exports.WEIGHTS = WEIGHTS;
module.exports.UNLOCKED_LP_CAP = UNLOCKED_LP_CAP;
module.exports.NO_MOMENTUM_CAP = NO_MOMENTUM_CAP;
