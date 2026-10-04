/**
 * Small async primitives shared across the pipeline. Every external call in
 * this bot can hang (RPCs, Jupiter, DexScreener, Telegram), and a hung call is
 * how a healthy-looking process stops doing anything — so bounded waits and
 * bounded concurrency live here rather than being re-improvised per file.
 */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.timeout = true;
  }
}

/** Reject with TimeoutError if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Resolve to `fallback` instead of rejecting — on error OR on timeout. */
function settle(promise, ms, fallback = null, label) {
  return withTimeout(Promise.resolve(promise), ms, label).catch(() => fallback);
}

/**
 * A FIFO work queue with a concurrency cap and a hard size bound.
 *
 * The previous scanner queue evicted the OLDEST job when full. Under a flood
 * of false-positive candidates that meant the genuine pool creations — rare,
 * and therefore usually the oldest entries — were exactly what got thrown
 * away. Here overflow rejects the NEWEST job and counts it, so a flood is
 * visible in /health instead of silently eating real work.
 */
class WorkQueue {
  constructor({ concurrency = 2, maxSize = 500, label = 'queue', onError } = {}) {
    this.concurrency = concurrency;
    this.maxSize = maxSize;
    this.label = label;
    this.onError = onError || (() => {});
    this.running = 0;
    this.jobs = [];
    this.dropped = 0;
    this.completed = 0;
  }

  get size() { return this.jobs.length; }

  push(fn) {
    if (this.jobs.length >= this.maxSize) {
      this.dropped++;
      return false;
    }
    this.jobs.push(fn);
    this._pump();
    return true;
  }

  _pump() {
    while (this.running < this.concurrency && this.jobs.length) {
      const job = this.jobs.shift();
      this.running++;
      Promise.resolve()
        .then(job)
        .catch(err => this.onError(err))
        .finally(() => {
          this.running--;
          this.completed++;
          this._pump();
        });
    }
  }

  /** Resolves once everything queued so far has finished. Test helper. */
  async idle() {
    while (this.running || this.jobs.length) await sleep(10);
  }

  clear() { this.jobs = []; }
}

/** Run at most one instance of `fn` at a time; overlapping calls are skipped. */
function singleFlight(fn) {
  let running = null;
  const wrapped = (...args) => {
    if (running) return running;
    running = Promise.resolve()
      .then(() => fn(...args))
      .finally(() => { running = null; });
    return running;
  };
  wrapped.isRunning = () => running !== null;
  return wrapped;
}

module.exports = { sleep, withTimeout, settle, TimeoutError, WorkQueue, singleFlight };
