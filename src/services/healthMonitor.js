const axios = require('axios');
const logger = require('../utils/logger');
const CHAINS = require('./chains');
const stats = require('./stats');
const { withTimeout } = require('../utils/async');

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

const HOUR = 60 * 60 * 1000;
// Pools seen but nothing alerted for this long, while plenty flowed through,
// is a filter problem worth a human look — not a quiet market.
const NO_ALERT_WINDOW_MS = 3 * HOUR;
const NO_ALERT_MIN_ANALYZED = 30;

const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
};

/**
 * Watches whether the bot is actually working, as opposed to merely running.
 *
 * Every silent outage in this project so far — a moved Jupiter endpoint, a
 * wrong pool key, an exhausted RPC quota, a filter that rejected everything —
 * presented identically: the process healthy, the logs calm, and not one
 * alert sent. This measures the things that matter: is each chain's feed
 * alive, are pools arriving, and are they making it out the other end.
 */
class HealthMonitor {
  constructor({ db, swapRouter, connection, config, bot, scanner, analyzer }) {
    this.db = db;
    this.swap = swapRouter;
    this.connection = connection;
    this.config = config;
    this.bot = bot;
    this.scanner = scanner;
    this.analyzer = analyzer;

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
    this.notified[`noalert:${chain}`] = false;
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
      await withTimeout(this.connection.getLatestBlockhash(), 10000, 'Solana getLatestBlockhash');
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
        await withTimeout(this.swap.adapter(chain).provider.getBlockNumber(), 10000, `${chain} getBlockNumber`);
      } catch (err) {
        problems.push(isQuotaError(err)
          ? `${CHAINS[chain].name} RPC quota exhausted (${this._short(err)}). Set ROBINHOOD_RPC_URL to a working endpoint.`
          : `${CHAINS[chain].name} RPC unreachable: ${this._short(err)}`);
      }
    }

    // Jupiter: quotes, prices and the sellability probe all depend on it.
    try {
      const p = await this.swap.adapter('solana').getPrice('So11111111111111111111111111111111111111112');
      if (!p) throw new Error('no SOL price returned');
    } catch (err) {
      problems.push(`Jupiter API not answering (${this._short(err)}) — Solana prices, sell probes and trades will fail.`);
    }

    // DexScreener: market data for scoring and outcome tracking.
    try {
      await axios.get('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', { timeout: 8000 });
    } catch (err) {
      problems.push(`DexScreener unreachable (${this._short(err)}) — scores will run on on-chain data only.`);
    }

    return problems;
  }

  async _checkSolanaWs() {
    const url = this.config.solana.wsUrl;
    if (!url) return 'No SOLANA_WS_URL configured — pool detection needs a WebSocket.';

    // A plain HTTP POST against the ws:// host returns the same rejection body
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

  async sweep() {
    const quietMs = (this.config.health?.silentMinutes ?? 45) * 60 * 1000;
    const sinceStart = Date.now() - this.startedAt;

    for (const chain of this.swap.chains()) {
      if (this.scanner && !this.scanner.enabled[chain]) continue;

      // 1. No pools at all — the feed may be dead.
      if (sinceStart >= quietMs) {
        const last = this.lastPoolAt[chain] ?? this.startedAt;
        const quietFor = Date.now() - last;
        if (quietFor >= quietMs && !this.notified[`silent:${chain}`]) {
          this.notified[`silent:${chain}`] = true;
          const mins = Math.round(quietFor / 60000);
          const problems = await this.preflight();
          const feed = this.scanner?.lastActivity?.[chain];
          const detail = problems.length
            ? problems.map(p => `• ${p}`).join('\n')
            : `• RPC endpoints answer; feed last active ${ago(feed)}. May be a quiet market.`;
          logger.warn(`[health] ${chain}: no pools for ${mins}m`);
          await this._notify(
            `⚠️ <b>No ${CHAINS[chain]?.name || chain} tokens for ${mins} minutes</b>\n\n` +
            `${detail}\n\n<i>The bot is running; it is just not seeing anything.</i>`
          );
        }
      }

      // 2. Pools flowing but nothing reaching anyone — a filter or delivery
      // problem. This is the one that went unnoticed for days.
      if (sinceStart >= NO_ALERT_WINDOW_MS) {
        const analyzed = stats.count(chain, 'analyzed', NO_ALERT_WINDOW_MS);
        const lastAlert = this.lastAlertAt[chain] ?? 0;
        if (analyzed >= NO_ALERT_MIN_ANALYZED && Date.now() - lastAlert > NO_ALERT_WINDOW_MS &&
            !this.notified[`noalert:${chain}`]) {
          this.notified[`noalert:${chain}`] = true;
          await this._notify(
            `ℹ️ <b>${CHAINS[chain]?.name || chain}: ${analyzed} tokens analysed, 0 alerted in 3h</b>\n\n` +
            this._funnel(chain, NO_ALERT_WINDOW_MS) +
            `\n\n<i>If this looks wrong, check thresholds with /alerts or /health.</i>`
          );
        }
      }
    }
  }

  /** Where tokens went, as a readable funnel. */
  _funnel(chain, ms) {
    const b = stats.breakdown(chain, ms);
    const rows = [
      ['detected', 'Pools detected'],
      ['skipped_known_token', '  already known token'],
      ['skipped_low_liquidity', '  below min liquidity'],
      ['analyzed', 'Analysed'],
      ['analyze_failed', '  analysis failed'],
      ['rechecked', 'Re-checked later'],
      ['alert_below_floor', '  below score floor'],
      ['alert_low_confidence', '  low confidence'],
      ['alert_copycat', '  copycat ticker'],
      ['alert_no_subscribers', '  no subscriber filter matched'],
      ['alert_rate_limited', '  rate limited'],
      ['alert_already_alerted', '  already sent'],
      ['alert_sent', 'Alerts sent'],
    ];
    return rows.filter(([k]) => b[k]).map(([k, label]) => `${label}: <b>${b[k]}</b>`).join('\n') || 'No activity recorded.';
  }

  /** Full status for the admin /health command. */
  async status() {
    const lines = ['<b>🩺 Health</b>', `Up ${ago(this.startedAt).replace(' ago', '')}`, ''];
    for (const chain of this.swap.chains()) {
      const meta = CHAINS[chain];
      const enabled = this.scanner ? this.scanner.enabled[chain] : true;
      lines.push(`${meta.emoji} <b>${meta.name}</b> ${enabled ? '' : '— <i>scanner OFF</i>'}`);
      lines.push(`  Feed: ${ago(this.scanner?.lastActivity?.[chain])} · last pool ${ago(this.lastPoolAt[chain])} · last alert ${ago(this.lastAlertAt[chain])}`);
      const err = stats.lastDetail(chain, 'poll_error');
      if (err && Date.now() - stats.lastAt(chain, 'poll_error') < 10 * 60 * 1000) lines.push(`  ⚠️ poll error: ${err.slice(0, 80)}`);
      if (chain === 'solana' && this.scanner?.reconnects?.solana) lines.push(`  WS reconnects: ${this.scanner.reconnects.solana}`);
      lines.push(this._funnel(chain, HOUR).split('\n').map(l => `  ${l}`).join('\n'));
      lines.push('');
    }
    const market = this.analyzer?.market;
    if (market?.lastError && Date.now() - market.lastError.at < 15 * 60 * 1000) {
      lines.push(`⚠️ DexScreener error ${ago(market.lastError.at)}: ${market.lastError.message}`);
    }
    const evm = this.swap.adapters?.robinhood?.provider;
    if (evm?.rateLimited) lines.push('⚠️ Robinhood RPC breaker is open (rate limited)');
    lines.push('<i>Funnel counts cover the last hour.</i>');
    return lines.join('\n');
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
