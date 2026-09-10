const axios = require('axios');
const logger = require('../utils/logger');
const CHAINS = require('./chains');

// Provider quota exhaustion does not look like an outage: the endpoint stays
// up and answers cheap calls, then refuses the ones that matter. These are the
// signatures worth calling out by name.
const QUOTA_PATTERNS = [
  /max usage reached/i,
  /monthly capacity/i,
  /credits? (exhausted|exceeded)/i,
  /quota (exceeded|exhausted)/i,
  /usage limit/i,
  /plan limit/i,
];

function isQuotaError(err) {
  const text = [
    err?.message,
    err?.info?.responseBody,
    err?.response?.data && JSON.stringify(err.response.data),
  ].filter(Boolean).join(' ');
  return QUOTA_PATTERNS.some(p => p.test(text));
}

/**
 * Watches whether the bot is actually working, as opposed to merely running.
 *
 * Every silent outage in this project so far — a moved Jupiter endpoint, a
 * wrong pool key, an exhausted RPC quota — presented identically: the process
 * healthy, the logs calm, and not one alert sent. Nothing measured the thing
 * that matters, which is whether tokens are still flowing.
 */
class HealthMonitor {
  constructor({ db, swapRouter, connection, config, bot }) {
    this.db = db;
    this.swap = swapRouter;
    this.connection = connection;
    this.config = config;
    this.bot = bot;

    this.lastPoolAt = {};
    this.lastAlertAt = {};
    this.notified = {};
    this.startedAt = Date.now();
    this._timer = null;
  }

  recordPool(chain) {
    this.lastPoolAt[chain] = Date.now();
    // A chain that recovers should be able to warn again if it dies later.
    this.notified[`silent:${chain}`] = false;
  }

  recordAlert(chain) {
    this.lastAlertAt[chain] = Date.now();
  }

  /**
   * Verify the dependencies actually answer before claiming to be running.
   * Returns a list of human-readable problems (empty when healthy).
   */
  async preflight() {
    const problems = [];

    // Solana RPC. getHealth is served even when credits are gone, so ask for
    // something that actually costs the provider money.
    try {
      await this.connection.getSlot();
    } catch (err) {
      problems.push(isQuotaError(err)
        ? `Solana RPC quota exhausted (${this._short(err)}). Pool detection will not work — top up Helius or switch SOLANA_RPC_URL.`
        : `Solana RPC unreachable: ${this._short(err)}`);
    }

    // Solana WebSocket. This is the one that matters for detection, and it can
    // be rejected while plain HTTP still answers.
    const wsProblem = await this._checkSolanaWs();
    if (wsProblem) problems.push(wsProblem);

    // EVM chains.
    for (const chain of this.swap.chains()) {
      if (chain === 'solana') continue;
      try {
        await this.swap.adapter(chain).provider.getBlockNumber();
      } catch (err) {
        problems.push(isQuotaError(err)
          ? `${CHAINS[chain].name} RPC quota exhausted (${this._short(err)}). Set ROBINHOOD_RPC_URL to a working endpoint.`
          : `${CHAINS[chain].name} RPC unreachable: ${this._short(err)}`);
      }
    }

    return problems;
  }

  async _checkSolanaWs() {
    const url = this.config.solana.wsUrl;
    if (!url) return 'No SOLANA_WS_URL configured — pool detection needs a WebSocket.';

    // A plain HTTP GET against the ws:// host returns the same rejection body
    // the socket handshake would, without pulling in a websocket client.
    try {
      const probe = url.replace(/^ws/, 'http');
      const { data } = await axios.post(probe, {
        jsonrpc: '2.0', id: 1, method: 'getSlot',
      }, { timeout: 8000, validateStatus: () => true });

      const body = typeof data === 'string' ? data : JSON.stringify(data || '');
      if (QUOTA_PATTERNS.some(p => p.test(body))) {
        return `Solana WebSocket rejected: ${body.slice(0, 120)}. ` +
               'The scanner cannot subscribe, so NO Solana tokens will ever be detected.';
      }
      return null;
    } catch (err) {
      return `Solana WebSocket check failed: ${this._short(err)}`;
    }
  }

  start() {
    const everyMs = 5 * 60 * 1000;
    this._timer = setInterval(() => {
      this.sweep().catch(err => logger.error(`[health] sweep: ${err.message}`));
    }, everyMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  /**
   * Warn when a chain has detected nothing for long enough that silence is
   * more likely to be breakage than a quiet market.
   */
  async sweep() {
    const quietMs = (this.config.health?.silentMinutes ?? 45) * 60 * 1000;
    const sinceStart = Date.now() - this.startedAt;
    if (sinceStart < quietMs) return;

    for (const chain of this.swap.chains()) {
      const last = this.lastPoolAt[chain] ?? this.startedAt;
      const quietFor = Date.now() - last;
      if (quietFor < quietMs) continue;
      if (this.notified[`silent:${chain}`]) continue;

      this.notified[`silent:${chain}`] = true;
      const mins = Math.round(quietFor / 60000);
      const problems = await this.preflight();

      const detail = problems.length
        ? problems.map(p => `• ${p}`).join('\n')
        : '• RPC endpoints answer, so this may just be a quiet market.';

      logger.warn(`[health] ${chain}: no pools for ${mins}m`);
      await this._notify(
        `⚠️ <b>No ${CHAINS[chain]?.name || chain} tokens for ${mins} minutes</b>\n\n` +
        `${detail}\n\n` +
        `<i>The bot is running; it is just not seeing anything.</i>`
      );
    }
  }

  async _notify(html) {
    const adminId = this.config.telegram.adminId;
    if (!adminId || !this.bot) return;
    try {
      await this.bot.sendAlert(adminId, html);
    } catch (err) {
      logger.error(`[health] could not notify admin: ${err.message}`);
    }
  }

  _short(err) {
    const msg = err?.shortMessage || err?.message || String(err);
    return msg.slice(0, 140);
  }
}

module.exports = HealthMonitor;
module.exports.isQuotaError = isQuotaError;
