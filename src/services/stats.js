/**
 * Pipeline counters. Every stage records what it did with each token, so
 * "zero alerts" can always be explained: 300 pools seen, 280 below score, 15
 * withheld on confidence, 5 had no subscribers. Without this the only way to
 * tell a quiet market from a broken filter was to read logs — which is how
 * every previous outage went unnoticed for days.
 *
 * Counters are kept in rolling one-hour buckets, in memory. A restart resets
 * them, which is fine: they answer "what is happening now", and the database
 * already holds the long-term record.
 */

const BUCKET_MS = 5 * 60 * 1000;
const KEEP_BUCKETS = 12 * 24; // 24h of 5-minute buckets

class Stats {
  constructor() {
    this.buckets = new Map(); // bucketStart -> Map(key -> count)
    this.last = new Map();    // key -> { at, detail }
    this.startedAt = Date.now();
  }

  _bucket(now = Date.now()) {
    const start = now - (now % BUCKET_MS);
    let b = this.buckets.get(start);
    if (!b) {
      b = new Map();
      this.buckets.set(start, b);
      if (this.buckets.size > KEEP_BUCKETS) {
        const oldest = Math.min(...this.buckets.keys());
        this.buckets.delete(oldest);
      }
    }
    return b;
  }

  /** inc('solana', 'detected') — keys are `${chain}.${event}`. */
  inc(chain, event, n = 1, detail) {
    const key = `${chain}.${event}`;
    const b = this._bucket();
    b.set(key, (b.get(key) || 0) + n);
    this.last.set(key, { at: Date.now(), detail });
  }

  /** Sum of a counter over the last `ms`. */
  count(chain, event, ms = 60 * 60 * 1000) {
    const key = `${chain}.${event}`;
    const since = Date.now() - ms;
    let total = 0;
    for (const [start, b] of this.buckets) {
      if (start + BUCKET_MS < since) continue;
      total += b.get(key) || 0;
    }
    return total;
  }

  lastAt(chain, event) {
    return this.last.get(`${chain}.${event}`)?.at || null;
  }

  lastDetail(chain, event) {
    return this.last.get(`${chain}.${event}`)?.detail;
  }

  /** Every event name seen for a chain in the window, with counts. */
  breakdown(chain, ms = 60 * 60 * 1000) {
    const since = Date.now() - ms;
    const out = {};
    for (const [start, b] of this.buckets) {
      if (start + BUCKET_MS < since) continue;
      for (const [key, n] of b) {
        if (!key.startsWith(`${chain}.`)) continue;
        const ev = key.slice(chain.length + 1);
        out[ev] = (out[ev] || 0) + n;
      }
    }
    return out;
  }
}

// One shared instance: stats are process-wide by nature.
module.exports = new Stats();
module.exports.Stats = Stats;
