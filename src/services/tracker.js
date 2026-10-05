const { PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');
const { singleFlight, withTimeout, settle } = require('../utils/async');

const WSOL = 'So11111111111111111111111111111111111111112';
const RUG_DRAWDOWN = 0.85; // -85% from peak with no liquidity left = rug

/**
 * Follows every alerted token for a fixed window whether or not we bought it.
 * Two jobs:
 *   1. Build the outcome record that tells us if the thesis engine is right.
 *   2. Feed deployer reputation, which then feeds the next score.
 */
class Tracker {
  constructor({ db, swapRouter, marketData, connection, config }) {
    this.db = db;
    this.swap = swapRouter;
    this.market = marketData;
    this.connection = connection;
    this.config = config;
    this.onSmartMoneyBuy = null;
    this.walletSubs = new Map();
    this._timer = null;
    // A cycle over hundreds of tracked tokens can outlast the interval;
    // overlapping cycles would double every snapshot.
    this.snapshotAll = singleFlight(this._snapshotAll.bind(this));
  }

  start() {
    if (!this.config.tracker.enabled) {
      logger.info('[track] disabled');
      return;
    }
    const ms = this.config.tracker.snapshotIntervalSec * 1000;
    this._timer = setInterval(() => {
      this.snapshotAll().catch(err => logger.error(`[track] cycle: ${err.message}`));
    }, ms);
    this._timer.unref?.();
    this.rebaseHistory().catch(err => logger.error(`[track] rebase: ${err.message}`));
    logger.info(`[track] snapshotting every ${this.config.tracker.snapshotIntervalSec}s`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    for (const unsub of this.walletSubs.values()) {
      try { unsub(); } catch { /* already gone */ }
    }
  }

  /** How long a newly alerted token should stay under observation. */
  trackingDeadline() {
    return new Date(Date.now() + this.config.tracker.trackHours * 3600 * 1000);
  }

  // ---------------------------------------------------------- snapshots

  async _snapshotAll() {
    const tokens = await this.db.getTokensToTrack();
    if (!tokens.length) return;

    for (const t of tokens) {
      try {
        await withTimeout(this.snapshotOne(t), 20000, 'snapshot');
      } catch (err) {
        logger.error(`[track] ${t.chain}/${t.mint}: ${err.message}`);
      }
    }
  }

  async snapshotOne(token) {
    const [market, nativeUsd] = await Promise.all([
      this.market.getPairData(token.chain, token.mint),
      settle(this.swap.getNativePriceUsd(token.chain), 8000, null),
    ]);

    const priceUsd = market?.priceUsd ?? await settle(this.swap.getPrice(token.chain, token.mint), 10000, null);
    if (priceUsd == null && !market) return; // nothing observable yet

    await this.db.saveSnapshot({
      chain: token.chain,
      mint: token.mint,
      priceUsd,
      priceNative: nativeUsd && priceUsd ? priceUsd / nativeUsd : null,
      liquidityUsd: market?.liquidityUsd ?? null,
      marketCap: market?.marketCap ?? null,
      volume5m: market?.volume5m ?? null,
      buys5m: market?.buys5m ?? null,
      sells5m: market?.sells5m ?? null,
      holderCount: null,
    });

    await this._updateOutcome(token, { priceUsd, market });
  }

  /**
   * Maintain peak multiple and a rug/runner verdict, recomputed from the
   * token's own snapshots every cycle (see db.getPriceStats for the rules).
   *
   * This used to divide the running max price by the oldest of the newest
   * 500 snapshots — a base that slid forward once a token had been tracked
   * for ~17h — and mixed DexScreener prices with swap-quote prices. Both
   * inflated multiples and put fake runners on the leaderboard.
   */
  async _updateOutcome(token, { priceUsd, market }) {
    if (priceUsd == null) return;
    const stored = await this.db.getToken(token.chain, token.mint);
    if (!stored) return;
    const s = await this.db.getPriceStats(token.chain, token.mint, { since: stored.alerted_at || null });
    const base = s?.base?.price_usd;
    if (!base) return;

    const peakPrice = Math.max(s.peak?.price_usd || 0, base);
    const peakMultiple = peakPrice / base;
    const lastPrice = s.last?.price_usd ?? priceUsd;
    const baseMc = s.base.market_cap ?? null;

    const drawdownFromPeak = peakPrice > 0 ? 1 - lastPrice / peakPrice : 0;
    const liquidityGone = market?.liquidityUsd != null && market.liquidityUsd < 500;

    let outcome = stored.outcome || null;
    if (!outcome) {
      if (liquidityGone || drawdownFromPeak >= RUG_DRAWDOWN) outcome = 'rug';
      else if (peakMultiple >= 2) outcome = 'runner';
    } else if (outcome === 'runner' && (liquidityGone || drawdownFromPeak >= RUG_DRAWDOWN)) {
      // Runner that subsequently rugged — reclassify
      outcome = 'rug';
    }

    await this.db.updateTokenOutcome(token.chain, token.mint, {
      base_price_usd: base,
      base_mc: baseMc,
      peak_price_usd: peakPrice,
      peak_multiple: peakMultiple,
      peak_mc: s.peak?.market_cap ?? (baseMc ? baseMc * peakMultiple : null),
      peak_at: s.peak?.taken_at ?? s.base.taken_at,
      last_multiple: lastPrice / base,
      ...(outcome ? { outcome } : {}),
    });

    const outcomeChanged = outcome && outcome !== stored.outcome;
    if (outcomeChanged && stored.deployer) {
      await this.db.recordDeployerOutcome(token.chain, stored.deployer, outcome, peakMultiple);
      logger.info(`[track] ${token.chain}/${stored.symbol} → ${outcome} (peak ${peakMultiple.toFixed(2)}x)`);
    }
  }

  /**
   * One-off: recompute multiples stored by the old sliding-base logic. Reads
   * snapshots only (no RPC), never changes an outcome — just the numbers the
   * leaderboard ranks by.
   */
  async rebaseHistory() {
    const tokens = await this.db.getTokensNeedingRebase();
    let fixed = 0;
    for (const t of tokens) {
      try {
        const s = await this.db.getPriceStats(t.chain, t.mint, { since: t.alerted_at || null });
        const base = s?.base?.price_usd;
        if (!base) {
          // Nothing measurable after the alert — mark it so it isn't retried.
          await this.db.updateTokenOutcome(t.chain, t.mint, { base_price_usd: 0, peak_multiple: null });
          continue;
        }
        const peakPrice = Math.max(s.peak?.price_usd || 0, base);
        const baseMc = s.base.market_cap ?? null;
        await this.db.updateTokenOutcome(t.chain, t.mint, {
          base_price_usd: base,
          base_mc: baseMc,
          peak_price_usd: peakPrice,
          peak_multiple: peakPrice / base,
          peak_mc: s.peak?.market_cap ?? (baseMc ? baseMc * (peakPrice / base) : null),
          peak_at: s.peak?.taken_at ?? s.base.taken_at,
          last_multiple: (s.last?.price_usd ?? base) / base,
        });
        fixed++;
      } catch (err) {
        logger.error(`[track] rebase ${t.chain}/${t.mint}: ${err.message}`);
      }
    }
    if (fixed) logger.info(`[track] recomputed multiples for ${fixed} historical tokens`);
    return fixed;
  }

  // ------------------------------------------------------- smart money

  /**
   * Subscribe to every watched Solana wallet's transactions. When one buys a
   * token, record it; the analyzer reads these back as a confluence signal and
   * 2+ buyers on one token fires a smart-money alert.
   */
  async startWalletWatching() {
    const wallets = await this.db.getWatchedWallets('solana');
    for (const w of wallets) await this.watchWallet(w);
    if (wallets.length) logger.info(`[track] watching ${wallets.length} smart-money wallets`);
  }

  async watchWallet(wallet) {
    if (wallet.chain !== 'solana') return; // EVM watching needs an indexer
    if (this.walletSubs.has(wallet.address)) return;

    try {
      const pubkey = new PublicKey(wallet.address);
      const subId = this.connection.onLogs(pubkey, async (logs) => {
        if (logs.err) return;
        try {
          await this._handleWalletTx(wallet, logs.signature);
        } catch (err) {
          logger.error(`[track] wallet tx ${logs.signature}: ${err.message}`);
        }
      }, 'confirmed');

      this.walletSubs.set(wallet.address, () => this.connection.removeOnLogsListener(subId));
    } catch (err) {
      logger.error(`[track] cannot watch ${wallet.address}: ${err.message}`);
    }
  }

  unwatchWallet(address) {
    const unsub = this.walletSubs.get(address);
    if (unsub) {
      try { unsub(); } catch { /* already gone */ }
      this.walletSubs.delete(address);
    }
  }

  async _handleWalletTx(wallet, signature) {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) return;

    // A buy shows up as a token balance the wallet did not previously hold
    // (or held less of) paired with a drop in its SOL.
    const owner = wallet.address;
    const pre = new Map(
      (tx.meta.preTokenBalances || [])
        .filter(b => b.owner === owner)
        .map(b => [b.mint, Number(b.uiTokenAmount.amount)])
    );

    for (const post of tx.meta.postTokenBalances || []) {
      if (post.owner !== owner) continue;
      if (post.mint === WSOL) continue;

      const before = pre.get(post.mint) || 0;
      const after = Number(post.uiTokenAmount.amount);
      if (after <= before) continue;

      const accountKeys = tx.transaction.message.accountKeys;
      const idx = accountKeys.findIndex(k => k.pubkey.toBase58() === owner);
      const solSpent = idx >= 0
        ? (tx.meta.preBalances[idx] - tx.meta.postBalances[idx]) / 1e9
        : null;

      const recorded = await this.db.recordWalletActivity({
        chain: 'solana',
        wallet: owner,
        mint: post.mint,
        direction: 'buy',
        amountNative: solSpent,
        txSignature: signature,
      });
      if (!recorded) continue;

      logger.info(`[track] ${wallet.label || owner.slice(0, 8)} bought ${post.mint.slice(0, 8)}…`);

      const buyers = await this.db.getWalletsBought('solana', post.mint, 60);
      if (buyers.length >= 2 && this.onSmartMoneyBuy) {
        await this.onSmartMoneyBuy({ chain: 'solana', mint: post.mint, symbol: null }, buyers);
      }
    }
  }
}

module.exports = Tracker;
