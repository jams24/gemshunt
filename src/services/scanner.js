const { PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');

const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const PUMPSWAP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP_FUN = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const WSOL = 'So11111111111111111111111111111111111111112';
const SEEN_MAX = 5000;

/**
 * Watches every configured chain for new pools and emits one uniform token
 * event, so downstream code never learns which chain it came from.
 */
class Scanner {
  constructor({ connection, swapRouter, db }) {
    this.connection = connection;
    this.swap = swapRouter;
    this.db = db;
    this.onNewToken = null;
    this.seen = new Set();
    this.subscriptions = [];
  }

  _markSeen(key) {
    if (this.seen.has(key)) return false;
    if (this.seen.size > SEEN_MAX) this.seen.clear();
    this.seen.add(key);
    return true;
  }

  async _emit(token) {
    try {
      await this.db.recordDeployerLaunch(token.chain, token.deployer);
      if (this.onNewToken) await this.onNewToken(token);
    } catch (err) {
      logger.error(`[scan] emit failed for ${token.mint}: ${err.message}`);
    }
  }

  async start() {
    await this._startSolana();
    this._startRobinhood();
  }

  // ------------------------------------------------------------- Solana

  async _startSolana() {
    // PumpSwap — where 95%+ of new tokens launch (Pump.fun graduates here since March 2025)
    // Pool creations have Initialize + CreateIdempotent logs and 10+ inner instructions
    const pumpSwapId = this.connection.onLogs(PUMPSWAP_AMM, async (logs) => {
      if (logs.err) return;
      // Pool creations have multiple CreateIdempotent + Initialize logs; swaps don't
      const createCount = logs.logs.filter(l => l.includes('CreateIdempotent') || l.includes('Initialize the associated')).length;
      if (createCount < 2) return;
      if (!this._markSeen(`sol:ps:${logs.signature}`)) return;

      try {
        const tx = await this.connection.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (!tx) return;

        const pool = this._extractPumpSwapPool(tx);
        if (!pool) return;

        logger.info(`[scan] pumpswap pool ${pool.tokenMint} liq=${pool.liquiditySol.toFixed(2)} SOL`);
        await this._emit({
          chain: 'solana',
          mint: pool.tokenMint,
          deployer: pool.deployer,
          poolAddress: pool.poolAddress,
          dex: 'pumpswap',
          liquidityNative: pool.liquiditySol,
        });
      } catch (err) {
        logger.error(`[scan] pumpswap parse: ${err.message}`);
      }
    }, 'confirmed');
    this.subscriptions.push(() => this.connection.removeOnLogsListener(pumpSwapId));
    logger.info('[scan] listening for PumpSwap pools (pump.fun graduates)');

    // Raydium AMM V4 — legacy, still catches some tokens
    const raydiumId = this.connection.onLogs(RAYDIUM_AMM_V4, async (logs) => {
      if (logs.err) return;
      if (!logs.logs.some(l => l.includes('initialize2'))) return;
      if (!this._markSeen(`sol:ray:${logs.signature}`)) return;

      try {
        const tx = await this.connection.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (!tx) return;

        const pool = this._extractRaydiumPool(tx);
        if (!pool) return;

        logger.info(`[scan] raydium pool ${pool.tokenMint} liq=${pool.liquiditySol.toFixed(2)} SOL`);
        await this._emit({
          chain: 'solana',
          mint: pool.tokenMint,
          deployer: pool.deployer,
          poolAddress: pool.poolAddress,
          dex: 'raydium',
          liquidityNative: pool.liquiditySol,
        });
      } catch (err) {
        logger.error(`[scan] raydium parse: ${err.message}`);
      }
    }, 'confirmed');
    this.subscriptions.push(() => this.connection.removeOnLogsListener(raydiumId));
    logger.info('[scan] listening for Raydium V4 pools');
  }

  _extractPumpSwapPool(tx) {
    try {
      const accounts = tx.transaction.message.accountKeys;
      const deployer = accounts[0]?.pubkey?.toBase58();
      let tokenMint = null;
      let poolAddress = null;

      // Find the PumpSwap instruction and its accounts
      for (const ix of tx.transaction.message.instructions) {
        if (ix.programId?.toBase58() !== PUMPSWAP_AMM.toBase58()) continue;
        const ixAccounts = ix.accounts || [];
        if (ixAccounts.length >= 5) {
          poolAddress = ixAccounts[0]?.toBase58();
        }
        break;
      }

      // Find token mint from inner instructions (initializeAccount3 with non-WSOL mint)
      for (const group of tx.meta?.innerInstructions || []) {
        for (const ix of group.instructions || []) {
          const parsed = ix.parsed;
          if (!parsed) continue;
          if (parsed.type === 'initializeAccount3' || parsed.type === 'initializeAccount') {
            const mint = parsed.info?.mint;
            if (mint && mint !== WSOL) { tokenMint = mint; break; }
          }
        }
        if (tokenMint) break;
      }

      if (!tokenMint || tokenMint === WSOL) return null;

      // Liquidity: sum SOL transferred in (look at token balance changes for WSOL account)
      // Fall back to the deployer's balance drop
      const pre = tx.meta?.preBalances || [];
      const post = tx.meta?.postBalances || [];
      let liquiditySol = 0;
      for (let i = 0; i < Math.min(pre.length, 10); i++) {
        const diff = (pre[i] - post[i]) / 1e9;
        if (diff > 0.01 && diff < 100000) liquiditySol += diff;
      }

      return { tokenMint, poolAddress: poolAddress || 'unknown', deployer, liquiditySol: Math.max(liquiditySol, 0) };
    } catch (err) {
      logger.error(`[scan] pumpswap extract: ${err.message}`);
      return null;
    }
  }

  _extractRaydiumPool(tx) {
    try {
      const accounts = tx.transaction.message.accountKeys;
      const deployer = accounts[0]?.pubkey?.toBase58();
      let tokenMint = null;
      let poolAddress = null;

      const allIx = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions || []).flatMap(i => i.instructions),
      ];

      for (const ix of allIx) {
        if (ix.programId?.toBase58() !== RAYDIUM_AMM_V4.toBase58()) continue;
        const ixAccounts = ix.accounts || [];
        if (ixAccounts.length < 10) continue;
        poolAddress = ixAccounts[4]?.toBase58();
        const mintA = ixAccounts[8]?.toBase58();
        const mintB = ixAccounts[9]?.toBase58();
        tokenMint = mintA === WSOL ? mintB : mintA;
        break;
      }
      if (!tokenMint || tokenMint === WSOL) return null;

      const pre = tx.meta?.preBalances || [];
      const post = tx.meta?.postBalances || [];
      let liquiditySol = 0;
      for (let i = 0; i < pre.length; i++) {
        const diff = (pre[i] - post[i]) / 1e9;
        if (diff > 0.05 && diff < 100000) liquiditySol = Math.max(liquiditySol, diff);
      }

      return { tokenMint, poolAddress, deployer, liquiditySol };
    } catch (err) {
      logger.error(`[scan] raydium extract: ${err.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------- Robinhood

  _startRobinhood() {
    if (process.env.ROBINHOOD_SCANNER_ENABLED === 'false') {
      logger.info('[scan] robinhood scanner disabled by config');
      return;
    }
    try {
      this.swap.adapter('robinhood').onNewPool(async ({ tokenAddress, poolId, poolKey }) => {
        if (!this._markSeen(`rh:${poolId}`)) return;
        logger.info(`[scan] robinhood pool ${tokenAddress} fee=${poolKey.fee} spacing=${poolKey.tickSpacing}`);
        await this._emit({
          chain: 'robinhood',
          mint: tokenAddress,
          deployer: null,
          poolAddress: poolId,
          dex: 'uniswap-v4',
          liquidityNative: null,
          poolKey,
        });
      });
    } catch (err) {
      // A dead Robinhood RPC must never take the Solana side down with it.
      logger.error(`[scan] robinhood listener failed (non-fatal): ${err.message}`);
    }
  }

  stop() {
    for (const unsub of this.subscriptions) {
      try { unsub(); } catch { /* already gone */ }
    }
    try { this.swap.adapter('robinhood').stopWatching(); } catch { /* never started */ }
  }
}

module.exports = Scanner;
