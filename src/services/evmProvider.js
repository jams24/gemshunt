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

module.exports = { getEvmProvider, ThrottledProvider, isRateLimit };
