const { ethers } = require('ethers');
const logger = require('../utils/logger');

/**
 * A JsonRpcProvider that survives a rate-limited public RPC.
 *
 * The Robinhood Chain public endpoint returns 429 under very little load, and
 * ethers' default behaviour makes that worse in three ways:
 *   1. Without `staticNetwork`, ethers verifies chainId alongside requests,
 *      roughly doubling call volume.
 *   2. Event subscriptions over HTTP poll `eth_blockNumber` every 4s and issue
 *      `eth_getLogs` on every new block, forever.
 *   3. Its internal retry gives up with an unhandled rejection that escapes
 *      whatever called it — which is why these surfaced as bare stack traces.
 *
 * This wrapper serialises requests behind a minimum interval, backs off on 429,
 * and trips a breaker that pauses polling entirely when the endpoint is angry,
 * so a rate-limited chain degrades instead of spamming.
 */
class ThrottledProvider extends ethers.JsonRpcProvider {
  constructor(url, chainId, options = {}) {
    // Ethers' own FetchRequest retries a 429 up to 12 times with exponential
    // backoff before it ever returns — that is the "exceeded maximum retry
    // limit" in the logs, and it blocks the caller for minutes. Cap it low so
    // failures come back fast and the backoff below is the one that governs.
    const request = new ethers.FetchRequest(url);
    request.timeout = options.timeoutMs ?? 20_000;
    request.setThrottleParams({ slotInterval: 100, maxAttempts: 1 });

    super(request, chainId, {
      // Stops ethers re-verifying the network on requests.
      staticNetwork: true,
      // Batch aggressively: fewer HTTP round-trips for the same work.
      batchMaxCount: 20,
      batchStallTime: 50,
      ...options,
    });

    this.minIntervalMs = options.minIntervalMs ?? 120;
    this.maxRetries = options.maxRetries ?? 3;
    this.breakerThreshold = options.breakerThreshold ?? 5;
    this.breakerCooldownMs = options.breakerCooldownMs ?? 60_000;

    this._chain = 'evm';
    this._lastRequest = 0;
    this._queue = Promise.resolve();
    this._consecutive429 = 0;
    this._breakerUntil = 0;
    this._pollingPaused = false;
  }

  get rateLimited() {
    return Date.now() < this._breakerUntil;
  }

  /** Serialise every RPC call behind a minimum spacing. */
  send(method, params) {
    const run = async () => {
      const wait = this.minIntervalMs - (Date.now() - this._lastRequest);
      if (wait > 0) await sleep(wait);
      this._lastRequest = Date.now();
      return this._sendWithBackoff(method, params);
    };
    // Chain onto the queue but don't let one rejection poison the next call.
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }

  async _sendWithBackoff(method, params) {
    if (this.rateLimited) {
      throw new Error(`RPC rate limited, retrying after cooldown (${method})`);
    }

    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const out = await super.send(method, params);
        this._onSuccess();
        return out;
      } catch (err) {
        lastErr = err;
        if (!isRateLimit(err)) throw err;

        this._on429();
        if (this.rateLimited || attempt === this.maxRetries) break;

        // 250ms, 750ms, 2.25s — plus jitter so retries don't resynchronise.
        const backoff = 250 * 3 ** attempt + Math.random() * 200;
        logger.warn(`[evm] 429 on ${method}, backing off ${Math.round(backoff)}ms`);
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  _onSuccess() {
    if (this._consecutive429 > 0) {
      logger.info('[evm] RPC recovered');
      this._consecutive429 = 0;
    }
    if (this._pollingPaused) this._resumePolling();
  }

  _on429() {
    this._consecutive429++;
    if (this._consecutive429 < this.breakerThreshold || this.rateLimited) return;

    this._breakerUntil = Date.now() + this.breakerCooldownMs;
    logger.error(
      `[evm] RPC rate limited ${this._consecutive429}x — pausing chain activity for ` +
      `${this.breakerCooldownMs / 1000}s. Set ROBINHOOD_RPC_URL to a private endpoint to avoid this.`
    );
    this._pausePolling();
    setTimeout(() => {
      this._breakerUntil = 0;
      this._consecutive429 = 0;
      this._resumePolling();
      logger.info('[evm] cooldown over, resuming');
    }, this.breakerCooldownMs).unref?.();
  }

  _pausePolling() {
    if (this._pollingPaused) return;
    this._pollingPaused = true;
    try { this.pause(); } catch { /* nothing subscribed */ }
  }

  _resumePolling() {
    if (!this._pollingPaused) return;
    this._pollingPaused = false;
    try { this.resume(); } catch { /* nothing subscribed */ }
  }
}

function isRateLimit(err) {
  if (!err) return false;
  const body = err.info?.responseBody || '';
  const status = err.info?.responseStatus || '';
  return err.code === 'SERVER_ERROR' &&
    (String(status).includes('429') || body.includes('"code":429') || /Too Many Requests/i.test(body));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One provider per chain, shared by the wallet and swap adapters. Two separate
// providers meant two independent polling loops against the same endpoint.
const providers = new Map();

function getEvmProvider(chainConfig) {
  const url = process.env.ROBINHOOD_RPC_URL || chainConfig.rpcUrl;
  const key = `${chainConfig.chainId}:${url}`;
  if (providers.has(key)) return providers.get(key);

  const provider = new ThrottledProvider(url, chainConfig.chainId, {
    minIntervalMs: parseInt(process.env.EVM_MIN_REQUEST_INTERVAL_MS, 10) || 120,
  });
  // Slow the event poll right down. Pool detection a few seconds later is a
  // fine trade for staying under the limit.
  provider.pollingInterval = parseInt(process.env.EVM_POLLING_INTERVAL_MS, 10) || 15_000;

  // Ethers emits polling failures on the provider itself. Without a listener
  // they surface as bare unhandled rejections with no context — which is how
  // the 429s were reaching the logs.
  provider.on('error', (err) => {
    if (isRateLimit(err)) return; // already reported with backoff context
    logger.error(`[evm] provider error: ${err?.shortMessage || err?.message || err}`);
  });

  providers.set(key, provider);
  logger.info(`[evm] provider ready (${url}, poll ${provider.pollingInterval}ms)`);
  return provider;
}

/**
 * Resolves the WebSocket URL for a chain: explicit env var, else derived from
 * the HTTP endpoint. Returns null when only the public RPC is configured —
 * it does not offer WebSockets, so callers fall back to polling.
 */
function getEvmWsUrl(chainConfig) {
  if (process.env.ROBINHOOD_WS_URL) return process.env.ROBINHOOD_WS_URL;

  const http = process.env.ROBINHOOD_RPC_URL;
  if (http) return http.replace(/^http/, 'ws');

  // The public endpoint's advertised wsUrl is not usable for subscriptions.
  return null;
}

/**
 * A log subscription that survives disconnects.
 *
 * Ethers' WebSocketProvider does not reconnect on its own: when the socket
 * drops, the subscription is simply gone and the bot goes silently deaf —
 * which is worse than polling, because nothing errors. This owns the socket,
 * detects death, and rebuilds provider + listener with backoff.
 */
class ReconnectingLogWatcher {
  constructor({ wsUrl, chainId, address, abi, event, onEvent, label = 'evm' }) {
    Object.assign(this, { wsUrl, chainId, address, abi, event, onEvent, label });
    this.provider = null;
    this.contract = null;
    this.stopped = false;
    this.attempt = 0;
    this.heartbeat = null;
    this.lastBlockAt = 0;
  }

  async start() {
    this.stopped = false;
    await this._connect();
  }

  async _connect() {
    if (this.stopped) return;
    try {
      this.provider = new ethers.WebSocketProvider(this.wsUrl, this.chainId, { staticNetwork: true });
      this.contract = new ethers.Contract(this.address, this.abi, this.provider);

      // ethers' .on() returns a promise for the eth_subscribe round-trip.
      // Destroying the provider rejects any still-pending one, so every
      // subscribe here must carry its own catch — an unhandled rejection from
      // a socket that died mid-handshake would otherwise crash the process.
      const subscribed = this.contract.on(this.event, (...args) => {
        this.lastBlockAt = Date.now();
        Promise.resolve(this.onEvent(...args)).catch(err =>
          logger.error(`[${this.label}] event handler: ${err.message}`)
        );
      });
      subscribed.catch(() => {}); // handled below; this only marks it as observed
      await subscribed;

      // Liveness: a silent socket is indistinguishable from a quiet chain
      // unless we watch block arrivals. Robinhood blocks are ~250ms, so a
      // 90s gap means the socket is dead even if it never emitted an error.
      this.lastBlockAt = Date.now();
      this.provider.on('block', () => {
        this.lastBlockAt = Date.now();
        // Only a delivered block proves the socket actually works. Resetting
        // backoff at subscribe time instead would let a flapping endpoint be
        // retried at full speed forever.
        this.attempt = 0;
      }).catch(() => {}); // rejected when the provider is destroyed mid-subscribe

      // Ethers assigns its own onopen/onmessage/onerror/onclose during start.
      // Overwriting them silently breaks its message pump — the socket stays
      // open but no events are ever delivered. Chain onto them instead.
      const socket = this.provider.websocket;
      if (socket) {
        const prevClose = socket.onclose;
        const prevError = socket.onerror;
        socket.onclose = (e) => {
          try { prevClose?.call(socket, e); } finally { this._reconnect('socket closed'); }
        };
        socket.onerror = (e) => {
          try { prevError?.call(socket, e); } finally {
            this._reconnect(`socket error: ${e?.message || 'unknown'}`);
          }
        };
      }

      this._startHeartbeat();
      logger.info(`[${this.label}] websocket subscribed to ${this.event}`);
    } catch (err) {
      // May already be reconnecting if the socket errored during handshake;
      // _reconnect guards against double-scheduling.
      this._reconnect(`connect failed: ${err.shortMessage || err.message}`);
    }
  }

  _startHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.stopped) return;
      if (Date.now() - this.lastBlockAt > 90_000) {
        this._reconnect('no blocks for 90s — socket presumed dead');
      }
    }, 30_000);
    this.heartbeat.unref?.();
  }

  _reconnect(reason) {
    if (this.stopped || this._reconnecting) return;
    this._reconnecting = true;
    clearInterval(this.heartbeat);

    const backoff = Math.min(1000 * 2 ** this.attempt, 60_000);
    this.attempt++;
    logger.warn(`[${this.label}] ${reason} — reconnecting in ${backoff}ms (attempt ${this.attempt})`);

    this._teardown();
    setTimeout(() => {
      this._reconnecting = false;
      this._connect();
    }, backoff).unref?.();
  }

  _teardown() {
    const provider = this.provider;
    const socket = provider?.websocket;
    this.provider = null;
    this.contract = null;

    if (!provider) return;

    // Neutralise our handlers so closing doesn't re-enter _reconnect — but
    // with no-ops, never null. Closing a socket that is still CONNECTING makes
    // ws emit an 'error' event, and an EventEmitter with no 'error' listener
    // throws and kills the process.
    if (socket) {
      socket.onclose = () => {};
      socket.onerror = () => {};
    }
    try { provider.removeAllListeners(); } catch { /* already gone */ }

    // provider.destroy() rejects every still-pending request, including the
    // eth_subscribe that never completed when a socket dies mid-handshake.
    // Those rejections have no reachable handler (they live in ethers'
    // private payload queue) and take the process down. Closing the socket
    // directly lets ethers run its own close path without that fallout.
    try { socket?.close(); } catch { /* already closed */ }

    // Only a socket that actually opened has server-side state worth the
    // destroy() call; deferring it lets the pending payloads settle first.
    if (socket?.readyState === 1) {
      setTimeout(() => {
        try { provider.destroy(); } catch { /* already gone */ }
      }, 0).unref?.();
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    this._teardown();
  }
}

module.exports = {
  getEvmProvider, getEvmWsUrl, ThrottledProvider, ReconnectingLogWatcher, isRateLimit,
};
