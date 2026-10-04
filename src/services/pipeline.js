const logger = require('../utils/logger');
const stats = require('./stats');
const { withTimeout, WorkQueue } = require('../utils/async');

const ANALYZE_TIMEOUT_MS = 30_000;
const MAX_PENDING_RECHECKS = 1500;

/**
 * new pool → analyze → persist → alert → (re-check later) → track.
 *
 * Why re-checks exist: at the moment a pool is created there is, by
 * definition, no trading history — DexScreener has not indexed it (measured:
 * ~3 minutes on Robinhood), Jupiter often cannot route it yet, and momentum is
 * zero. A single look at t=0 can only ever judge safety. So every plausible
 * token is analysed again a few minutes later, and one that has started to
 * show real demand is alerted then, even if it did not qualify at launch.
 */
class Pipeline {
  constructor({ analyzer, db, alerter, tracker, health, config }) {
    this.analyzer = analyzer;
    this.db = db;
    this.alerter = alerter;
    this.tracker = tracker;
    this.health = health;
    this.config = config;
    this.recheckDelaysMin = config.recheck?.delaysMin ?? [3, 10];
    this.pendingRechecks = new Map(); // `${chain}:${mint}` -> timer
    this.stopped = false;

    // Bounded analysis concurrency: a launch wave must queue, not fan out
    // into hundreds of simultaneous RPC calls and trip every rate limit.
    this.queue = new WorkQueue({
      concurrency: config.pipeline?.concurrency ?? 4,
      maxSize: 300,
      label: 'analyze',
      onError: err => logger.error(`[pipeline] ${err.message}`),
    });
  }

  /** Scanner entry point. Never throws. */
  onDetected(raw) {
    this.health?.recordPool(raw.chain);
    raw.detectedAt = raw.detectedAt || Date.now();
    const queued = this.queue.push(() => this._process(raw, 0));
    if (!queued) stats.inc(raw.chain, 'analyze_queue_overflow');
  }

  async _process(raw, round) {
    const stage = round === 0 ? 'launch' : 'recheck';
    let result;
    try {
      result = await withTimeout(this.analyzer.analyze(raw), ANALYZE_TIMEOUT_MS, 'analysis');
    } catch (err) {
      stats.inc(raw.chain, 'analyze_failed', 1, err.message);
      logger.error(`[pipeline] analyze ${raw.chain}/${raw.mint}: ${err.message}`);
      if (round === 0) this._scheduleRecheck(raw, 0);
      return;
    }
    const { token, analysis } = result;
    stats.inc(raw.chain, round === 0 ? 'analyzed' : 'rechecked');

    // Track anything that could have been alerted, so we learn whether the
    // thesis was right even when nobody buys it.
    if (analysis.score >= this.alerter.floor && this.tracker) {
      token.trackingUntil = this.tracker.trackingDeadline();
    }
    try {
      await this.db.saveToken(token);
    } catch (err) {
      logger.error(`[pipeline] save ${raw.chain}/${raw.mint}: ${err.message}`);
    }

    const ageMin = (Date.now() - raw.detectedAt) / 60000;
    const sent = await this.alerter.dispatchNewToken(token, analysis, { stage, ageMin })
      .catch((err) => {
        logger.error(`[pipeline] alert ${raw.chain}/${raw.mint}: ${err.message}`);
        return 0;
      });
    if (sent) this.health?.recordAlert(raw.chain);

    if (this._worthRechecking(token, analysis)) this._scheduleRecheck(raw, round);
  }

  /**
   * Re-checking costs RPC calls, so skip tokens a re-check cannot rescue:
   * hard rejects and honeypots stay that way, and an unlocked-LP pool is a
   * rug vector no amount of momentum fixes.
   */
  _worthRechecking(token, analysis) {
    if (analysis.rejected) return false;
    if (token.honeypot === true) return false;
    if (token.lpUnlockedPct != null && token.lpUnlockedPct >= 50) return false;
    return true;
  }

  _scheduleRecheck(raw, round) {
    if (this.stopped || round >= this.recheckDelaysMin.length) return;
    const key = `${raw.chain}:${raw.mint}`;
    if (this.pendingRechecks.has(key)) return;
    if (this.pendingRechecks.size >= MAX_PENDING_RECHECKS) {
      stats.inc(raw.chain, 'recheck_dropped');
      return;
    }
    const dueMs = raw.detectedAt + this.recheckDelaysMin[round] * 60000 - Date.now();
    const timer = setTimeout(() => {
      this.pendingRechecks.delete(key);
      if (this.stopped) return;
      this.queue.push(() => this._process(raw, round + 1));
    }, Math.max(1000, dueMs));
    timer.unref?.();
    this.pendingRechecks.set(key, timer);
  }

  stop() {
    this.stopped = true;
    for (const t of this.pendingRechecks.values()) clearTimeout(t);
    this.pendingRechecks.clear();
    this.queue.clear();
  }
}

module.exports = Pipeline;
