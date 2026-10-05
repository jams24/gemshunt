const logger = require('../utils/logger');
const stats = require('./stats');
const { renderAlert, alertKeyboard, renderSmartMoneyAlert } = require('../analysis/thesis');

// Below this share of scoring signals, a score is not evidence enough to send.
const MIN_CONFIDENCE = 0.5;
// The same ticker launched again within this window is a copycat. Live, the
// same names ("JEWEL", "Human") were relaunched several times within minutes
// across both chains — alerting each one is spam, and the copies are where
// the rugs concentrate.
const COPYCAT_WINDOW_MS = 30 * 60 * 1000;
// A re-check only earns a follow-up when demand is clearly there.
const MOMENTUM_MIN_SCORE = 75;
const MOMENTUM_MIN_CATEGORY = 60;

const normSymbol = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Decides who hears about a token and makes sure they hear about it once.
 * Sits between the analyzer and Telegram so neither has to know about
 * per-user filters, dedupe, or rate limits.
 *
 * Every dispatch returns WHY it did or did not send, and records it in stats.
 * "Zero alerts" used to be indistinguishable from "nothing passed the filter";
 * now /health can say which filter.
 */
class Alerter {
  constructor({ db, bot, config }) {
    this.db = db;
    this.bot = bot;
    this.config = config;
    this.sentThisMinute = 0;
    this._recentSymbols = new Map(); // normSymbol -> { mint, at }
    this._resetTimer = setInterval(() => { this.sentThisMinute = 0; }, 60 * 1000);
    this._resetTimer.unref?.();
  }

  get floor() {
    return this.config.alerts.floor ?? this.config.alerts.minScore ?? 60;
  }

  _underRateLimit() {
    return this.sentThisMinute < this.config.alerts.maxPerMinute;
  }

  _isCopycat(token) {
    const key = normSymbol(token.symbol);
    if (!key || key === 'unknown') return false;
    const prev = this._recentSymbols.get(key);
    if (!prev) return false;
    if (Date.now() - prev.at > COPYCAT_WINDOW_MS) {
      this._recentSymbols.delete(key);
      return false;
    }
    return prev.mint !== token.mint;
  }

  _rememberSymbol(token) {
    const key = normSymbol(token.symbol);
    if (!key || key === 'unknown') return;
    if (this._recentSymbols.size > 5000) this._recentSymbols.clear();
    if (!this._recentSymbols.has(key)) this._recentSymbols.set(key, { mint: token.mint, at: Date.now() });
  }

  /**
   * Push an analysed token to every subscriber whose filters it clears.
   *
   * @param {object} opts.stage  'launch' (first sighting) or 'recheck'
   * @param {number} opts.ageMin minutes since the pool was detected
   * @returns {Promise<number>} users notified (the reason is in stats)
   */
  async dispatchNewToken(token, analysis, { stage = 'launch', ageMin = 0 } = {}) {
    const result = await this._dispatch(token, analysis, stage, ageMin);
    stats.inc(token.chain, `alert_${result.reason}`, 1, `${token.symbol} ${analysis.score}`);
    return result.sent;
  }

  async _dispatch(token, analysis, stage, ageMin) {
    if (analysis.score < this.floor) return { sent: 0, reason: 'below_floor' };
    // Never push a call we cannot substantiate. A high score built on a
    // fraction of the signals is a guess wearing a number.
    if (analysis.confidence < MIN_CONFIDENCE) {
      logger.info(
        `[alert] ${token.symbol} scored ${analysis.score} but only ` +
        `${(analysis.confidence * 100).toFixed(0)}% confidence — withheld`
      );
      return { sent: 0, reason: 'low_confidence' };
    }
    const smartMoney = (token.watcherBuys || 0) >= 2;
    if (!smartMoney && this._isCopycat(token)) return { sent: 0, reason: 'copycat' };
    // Smart-money confluence is worth breaking the rate limit for; routine
    // launches are not.
    if (!this._underRateLimit() && !smartMoney) {
      logger.warn(`[alert] rate limit hit, dropping ${token.symbol}`);
      return { sent: 0, reason: 'rate_limited' };
    }

    const subscribers = await this.db.getAlertSubscribers(token.chain, analysis.score, token.liquidityUsd ?? null);
    if (!subscribers.length) return { sent: 0, reason: 'no_subscribers' };

    const deployerStats = token.deployer
      ? await this.db.getDeployerStats(token.chain, token.deployer).catch(() => null)
      : null;
    const strongMomentum = stage === 'recheck' && analysis.hasMomentum &&
      analysis.score >= MOMENTUM_MIN_SCORE &&
      (analysis.categories?.momentum ?? 0) >= MOMENTUM_MIN_CATEGORY;

    const keyboard = alertKeyboard(token);
    const texts = {
      new_token: renderAlert(token, analysis, deployerStats, { stage, ageMin }),
      momentum: strongMomentum ? renderAlert(token, analysis, deployerStats, { stage: 'momentum', ageMin }) : null,
    };

    let sent = 0;
    for (const sub of subscribers) {
      try {
        // First time this user hears of it: the launch (or late-qualifying)
        // alert. Already told: only a clear momentum follow-up is worth it.
        let kind = 'new_token';
        if (await this.db.wasAlerted(sub.telegram_id, token.chain, token.mint, 'new_token')) {
          if (!strongMomentum) continue;
          kind = 'momentum';
        }
        // Claim the slot before sending so a crash mid-loop can't double-send.
        const claimed = await this.db.recordAlert(sub.telegram_id, token.chain, token.mint, analysis.score, kind);
        if (!claimed) continue;

        const ok = await this.bot.sendAlert(sub.telegram_id, texts[kind], { reply_markup: keyboard });
        if (ok !== false) sent++;
        // A first alert that already shows strong momentum IS the momentum
        // news; claim that slot too so the next re-check doesn't repeat it.
        if (kind === 'new_token' && strongMomentum) {
          await this.db.recordAlert(sub.telegram_id, token.chain, token.mint, analysis.score, 'momentum');
        }
      } catch (err) {
        logger.error(`[alert] send to ${sub.telegram_id} failed: ${err.message}`);
      }
    }

    if (!sent) return { sent: 0, reason: 'already_alerted' };
    this.sentThisMinute++;
    this._rememberSymbol(token);
    await this.db.markTokenAlerted(token.chain, token.mint, {
      score: analysis.score, marketCap: token.marketCap ?? token.initialMc ?? null,
    });
    logger.info(`[alert] ${token.chain}/${token.symbol} (${analysis.score}, ${stage}) sent to ${sent} users`);
    return { sent, reason: 'sent' };
  }

  /** Fired when 2+ tracked wallets buy the same token. */
  async dispatchSmartMoney(token, wallets) {
    const subscribers = await this.db.getAlertSubscribers(token.chain, 100, null);
    const text = renderSmartMoneyAlert(token, wallets);
    const keyboard = alertKeyboard(token);

    let sent = 0;
    for (const sub of subscribers) {
      try {
        const claimed = await this.db.recordAlert(
          sub.telegram_id, token.chain, token.mint, null, 'smart_money'
        );
        if (!claimed) continue;
        const ok = await this.bot.sendAlert(sub.telegram_id, text, { reply_markup: keyboard });
        if (ok !== false) sent++;
      } catch (err) {
        logger.error(`[alert] smart-money send failed: ${err.message}`);
      }
    }
    if (sent) logger.info(`[alert] smart-money ${token.symbol} sent to ${sent} users`);
    return sent;
  }
}

module.exports = Alerter;
module.exports.MIN_CONFIDENCE = MIN_CONFIDENCE;
