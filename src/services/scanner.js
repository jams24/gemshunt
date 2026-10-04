const { PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');
const stats = require('./stats');
const { WorkQueue, settle } = require('../utils/async');
const {
  PROGRAMS, isPumpSwapCreate, isRaydiumInit, decodePumpSwapCreate, extractRaydiumPool,
  decodePumpSwapPoolAccount, findPumpSwapPoolInTx,
} = require('./solanaPools');

const SEEN_MAX = 20000;
// PumpSwap alone emits hundreds of log notifications a second. A socket that
// has delivered NOTHING for this long is dead, not quiet — the old watchdog
// waited 15 minutes for a *pool* before it would reconnect.
const SOLANA_STALE_MS = 90 * 1000;
const WATCHDOG_EVERY_MS = 30 * 1000;

/**
 * Watches every chain for new pools and emits one uniform event per token:
 *   { chain, mint, deployer, poolAddress, dex, liquidityNative, poolKey?, decimals? }
 *
 * Detection is deliberately cheap. On Solana the PumpSwap pool is decoded out
 * of the log notification itself — no RPC call at all — and only rare Raydium
 * launches cost a getParsedTransaction. Everything expensive happens later, in
 * the analyzer, once per real token.
 */
class Scanner {
  constructor({ connection, connectionFactory, swapRouter, db, config = {} }) {
    this.connection = connection;
    // A dead websocket is replaced with a fresh Connection rather than
    // re-subscribed on the old one, which can hold a half-open socket.
    this.connectionFactory = connectionFactory || (() => connection);
    this.swap = swapRouter;
    this.db = db;
    this.config = config;
    this.onNewToken = null;

    this.enabled = {
      solana: config.scanner?.solana ?? true,
      robinhood: config.scanner?.robinhood ?? true,
    };
    this.minLiquiditySol = config.scanner?.minLiquiditySol ?? 0;

    this.seen = new Set();
    this.subscriptions = [];
    this.lastActivity = { solana: 0, robinhood: 0 };
    this.reconnects = { solana: 0 };

    this.txQueue = new WorkQueue({
      concurrency: 2,
      maxSize: 200,
      label: 'scan-tx',
      onError: err => logger.error(`[scan] tx job: ${err.message}`),
    });
  }

  setEnabled(chain, on) {
    if (!(chain in this.enabled)) throw new Error(`Unknown chain ${chain}`);
    this.enabled[chain] = on;
    logger.info(`[scan] ${chain} scanner ${on ? 'enabled' : 'disabled'}`);
  }

  _markSeen(key) {
    if (this.seen.has(key)) return false;
    if (this.seen.size > SEEN_MAX) this.seen.clear();
    this.seen.add(key);
    return true;
  }

  /**
   * Hand a detected pool to the pipeline. A token we already know is not a
   * new launch — a second pool for an existing coin is common and is not
   * worth an alert.
   */
  async _emit(token) {
    if (!this.enabled[token.chain]) return;
    if (!this._markSeen(`${token.chain}:mint:${token.mint.toLowerCase()}`)) return;

    stats.inc(token.chain, 'detected');
    try {
      const known = await settle(this.db.getToken(token.chain, token.mint), 3000, null);
      if (known && Date.now() - new Date(known.detected_at).getTime() > 10 * 60 * 1000) {
        stats.inc(token.chain, 'skipped_known_token');
        return;
      }
      await settle(this.db.recordDeployerLaunch(token.chain, token.deployer), 3000);
      if (this.onNewToken) await this.onNewToken(token);
    } catch (err) {
      logger.error(`[scan] emit failed for ${token.chain}/${token.mint}: ${err.message}`);
    }
  }

  async start() {
    this._startSolana();
    this._startRobinhood();
    this._watchdog = setInterval(() => this._checkLiveness(), WATCHDOG_EVERY_MS);
    this._watchdog.unref?.();
  }

  // ------------------------------------------------------------- Solana

  _startSolana() {
    const conn = this.connection;
    this.lastActivity.solana = Date.now();

    const sub = (program, handler) => {
      const id = conn.onLogs(new PublicKey(program), (logs) => {
        this.lastActivity.solana = Date.now();
        if (logs.err) return;
        try { handler(logs); } catch (err) {
          logger.error(`[scan] ${program.slice(0, 6)} handler: ${err.message}`);
        }
      }, 'confirmed');
      this.subscriptions.push(() => conn.removeOnLogsListener(id));
    };

    sub(PROGRAMS.pumpswap, (logs) => this._onPumpSwapLogs(logs));
    sub(PROGRAMS.raydiumV4, (logs) => this._onRaydiumLogs(logs));
    logger.info('[scan] solana: listening for PumpSwap + Raydium V4 pool creations');
  }

  _onPumpSwapLogs({ signature, logs }) {
    if (!isPumpSwapCreate(logs)) return;
    if (!this._markSeen(`sol:sig:${signature}`)) return;

    const pool = decodePumpSwapCreate(logs);
    if (!pool) {
      // Event missing (log truncation) — the pool is still real, so take the
      // slow path rather than drop it.
      stats.inc('solana', 'event_undecodable');
      this._pumpSwapFallback(signature);
      return;
    }
    if (pool.skip) {
      stats.inc('solana', 'skipped_no_sol_pair');
      return;
    }
    if (this.minLiquiditySol && pool.liquiditySol < this.minLiquiditySol) {
      stats.inc('solana', 'skipped_low_liquidity');
      return;
    }

    logger.info(
      `[scan] pumpswap ${pool.graduated ? 'graduation' : 'pool'} ${pool.mint} ` +
      `liq=${pool.liquiditySol.toFixed(2)} SOL`
    );
    this._emit({
      chain: 'solana',
      mint: pool.mint,
      deployer: pool.deployer,
      poolAddress: pool.pool,
      lpMint: pool.lpMint,
      dex: pool.graduated ? 'pumpswap' : 'pumpswap-direct',
      liquidityNative: pool.liquiditySol,
      priceNative: pool.priceNative,
      decimals: pool.decimals,
    });
  }

  _pumpSwapFallback(signature) {
    const queued = this.txQueue.push(async () => {
      const tx = await settle(this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }), 15000, null);
      const poolAddress = tx && findPumpSwapPoolInTx(tx);
      if (!poolAddress) {
        stats.inc('solana', 'tx_fetch_failed');
        return;
      }
      const acct = await settle(this.connection.getAccountInfo(new PublicKey(poolAddress)), 8000, null);
      const pool = decodePumpSwapPoolAccount(acct?.data);
      if (!pool || pool.skip) return;
      const bal = await settle(this.connection.getTokenAccountBalance(new PublicKey(pool.solVault)), 8000, null);
      await this._emit({
        chain: 'solana',
        mint: pool.mint,
        deployer: pool.deployer,
        poolAddress,
        lpMint: pool.lpMint,
        dex: pool.graduated ? 'pumpswap' : 'pumpswap-direct',
        liquidityNative: bal?.value?.uiAmount ?? null,
      });
    });
    if (!queued) stats.inc('solana', 'queue_overflow');
  }

  _onRaydiumLogs({ signature, logs }) {
    if (!isRaydiumInit(logs)) return;
    if (!this._markSeen(`sol:sig:${signature}`)) return;

    const queued = this.txQueue.push(async () => {
      const tx = await settle(this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }), 15000, null);
      if (!tx) {
        stats.inc('solana', 'tx_fetch_failed');
        return;
      }
      const pool = extractRaydiumPool(tx);
      if (!pool) return;
      if (this.minLiquiditySol && pool.liquiditySol != null && pool.liquiditySol < this.minLiquiditySol) {
        stats.inc('solana', 'skipped_low_liquidity');
        return;
      }
      logger.info(`[scan] raydium pool ${pool.mint} liq=${pool.liquiditySol?.toFixed(2) ?? '?'} SOL`);
      await this._emit({
        chain: 'solana',
        mint: pool.mint,
        deployer: pool.deployer,
        poolAddress: pool.pool,
        lpMint: pool.lpMint,
        dex: 'raydium',
        liquidityNative: pool.liquiditySol,
      });
    });
    if (!queued) stats.inc('solana', 'queue_overflow');
  }

  _checkLiveness() {
    if (!this.enabled.solana) return;
    const quiet = Date.now() - this.lastActivity.solana;
    if (quiet < SOLANA_STALE_MS) return;

    this.reconnects.solana++;
    stats.inc('solana', 'ws_reconnect');
    logger.warn(
      `[scan] solana websocket delivered nothing for ${Math.round(quiet / 1000)}s — ` +
      `rebuilding connection (reconnect #${this.reconnects.solana})`
    );
    this._teardownSolana();
    try {
      this.connection = this.connectionFactory();
      this._startSolana();
    } catch (err) {
      logger.error(`[scan] solana resubscribe failed: ${err.message}`);
    }
  }

  _teardownSolana() {
    for (const unsub of this.subscriptions) {
      // Unsubscribing over a dead socket can reject; it must not throw here.
      try { Promise.resolve(unsub()).catch(() => {}); } catch { /* already gone */ }
    }
    this.subscriptions = [];
  }

  // ---------------------------------------------------------- Robinhood

  _startRobinhood() {
    let adapter;
    try { adapter = this.swap.adapter('robinhood'); } catch { return; }

    try {
      adapter.onNewPool(async ({ tokenAddress, poolId, poolKey, txHash }) => {
        this.lastActivity.robinhood = Date.now();
        if (!this.enabled.robinhood) return;
        if (!this._markSeen(`rh:pool:${poolId}`)) return;

        // The tx sender is the deployer: one cheap call, and without it
        // Robinhood tokens had no deployer reputation at all.
        const deployer = txHash
          ? await settle(adapter.getTxSender(txHash), 5000, null)
          : null;

        logger.info(`[scan] robinhood pool ${tokenAddress} fee=${poolKey.fee} spacing=${poolKey.tickSpacing}`);
        await this._emit({
          chain: 'robinhood',
          mint: tokenAddress,
          deployer,
          poolAddress: poolId,
          dex: 'uniswap-v4',
          liquidityNative: null,
          poolKey,
        });
      }, {
        // Polling proves liveness even when no pool lands.
        onPoll: () => { this.lastActivity.robinhood = Date.now(); },
      });
    } catch (err) {
      // A dead Robinhood RPC must never take the Solana side down with it.
      logger.error(`[scan] robinhood listener failed (non-fatal): ${err.message}`);
    }
  }

  stop() {
    if (this._watchdog) clearInterval(this._watchdog);
    this._teardownSolana();
    this.txQueue.clear();
    try { this.swap.adapter('robinhood').stopWatching(); } catch { /* never started */ }
  }
}

module.exports = Scanner;
