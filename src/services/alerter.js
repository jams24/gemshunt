const logger = require('../utils/logger');
const { renderAlert, alertKeyboard, renderSmartMoneyAlert } = require('../analysis/thesis');

// Below this share of scoring signals, a score is not evidence enough to send.
const MIN_CONFIDENCE = 0.5;

/**
 * Decides who hears about a token and makes sure they hear about it once.
 * Sits between the analyzer and Telegram so neither has to know about
 * per-user filters, dedupe, or rate limits.
 */
class Alerter {
  constructor({ db, bot, config }) {
    this.db = db;
    this.bot = bot;
    this.config = config;
    this.sentThisMinute = 0;
    this._resetTimer = setInterval(() => { this.sentThisMinute = 0; }, 60 * 1000);
    this._resetTimer.unref?.();
  }

  _underRateLimit() {
    return this.sentThisMinute < this.config.alerts.maxPerMinute;
  }

  /**
   * Push a newly analysed token to every subscriber whose filters it clears.
   * Returns the number of users actually notified.
   */
  async dispatchNewToken(token, analysis) {
    if (analysis.score < this.config.alerts.minScore) {
      logger.debug?.(`[alert] ${token.symbol} scored ${analysis.score}, below threshold`);
      return 0;
    }
    // Never push a call we cannot substantiate. A high score built on a
    // fraction of the signals is a guess wearing a number.
    if (analysis.confidence < MIN_CONFIDENCE) {
      logger.info(
        `[alert] ${token.symbol} scored ${analysis.score} but only ` +
        `${(analysis.confidence * 100).toFixed(0)}% confidence — withheld`
      );
      return 0;
    }
    // Smart-money confluence is worth breaking the rate limit for; routine
    // launches are not.
    if (!this._underRateLimit() && token.watcherBuys < 2) {
      logger.warn(`[alert] rate limit hit, dropping ${token.symbol}`);
      return 0;
    }

    // Pass null when liquidity is genuinely unknown so subscribers' minimums
    // don't silently drop every token we couldn't measure.
    const liquidity = token.liquiditySol ?? null;

    const subscribers = await this.db.getAlertSubscribers(token.chain, analysis.score, liquidity);
    if (!subscribers.length) return 0;

    const text = renderAlert(token, analysis);
    const keyboard = alertKeyboard(token);

    let sent = 0;
    for (const sub of subscribers) {
      try {
        if (await this.db.wasAlerted(sub.telegram_id, token.chain, token.mint)) continue;
        // Claim the slot before sending so a crash mid-loop can't double-send.
        const claimed = await this.db.recordAlert(sub.telegram_id, token.chain, token.mint, analysis.score);
        if (!claimed) continue;

        await this.bot.sendAlert(sub.telegram_id, text, { reply_markup: keyboard });
        sent++;
      } catch (err) {
        logger.error(`[alert] send to ${sub.telegram_id} failed: ${err.message}`);
      }
    }

    if (sent) {
      this.sentThisMinute++;
      await this.db.markTokenAlerted(token.chain, token.mint);
      logger.info(`[alert] ${token.symbol} (${analysis.score}) sent to ${sent} users`);
    }
    return sent;
  }

  /** Fired when 2+ tracked wallets buy the same token. */
  async dispatchSmartMoney(token, wallets) {
    const subscribers = await this.db.getAlertSubscribers(token.chain, 100, 0);
    const text = renderSmartMoneyAlert(token, wallets);
    const keyboard = alertKeyboard(token);

    let sent = 0;
    for (const sub of subscribers) {
      try {
        const claimed = await this.db.recordAlert(
          sub.telegram_id, token.chain, token.mint, null, 'smart_money'
        );
        if (!claimed) continue;
        await this.bot.sendAlert(sub.telegram_id, text, { reply_markup: keyboard });
        sent++;
      } catch (err) {
        logger.error(`[alert] smart-money send failed: ${err.message}`);
      }
    }
    if (sent) logger.info(`[alert] smart-money ${token.symbol} sent to ${sent} users`);
    return sent;
  }
}

module.exports = Alerter;
