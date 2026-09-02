const { PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');

const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
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
    const subId = this.connection.onLogs(RAYDIUM_AMM_V4, async (logs) => {
      if (logs.err) return;
      if (!logs.logs.some(l => l.includes('initialize2'))) return;
      if (!this._markSeen(`sol:${logs.signature}`)) return;

      try {
        const tx = await this.connection.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (!tx) return;

        const pool = this._extractSolanaPool(tx);
        if (!pool) return;

        logger.info(`[scan] solana pool ${pool.tokenMint} liq=${pool.liquiditySol.toFixed(2)} SOL`);
        await this._emit({
          chain: 'solana',
          mint: pool.tokenMint,
          deployer: pool.deployer,
          poolAddress: pool.poolAddress,
          dex: 'raydium',
          liquidityNative: pool.liquiditySol,
        });
      } catch (err) {
        logger.error(`[scan] solana parse: ${err.message}`);
      }
    }, 'confirmed');

    this.subscriptions.push(() => this.connection.removeOnLogsListener(subId));
    logger.info('[scan] listening for Raydium pools');
  }

  _extractSolanaPool(tx) {
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

      // Pool SOL is whatever the deployer's own balance dropped by, net of the
      // rent and fees the earlier heuristic kept mistaking for liquidity.
      const pre = tx.meta?.preBalances || [];
      const post = tx.meta?.postBalances || [];
      let liquiditySol = 0;
      for (let i = 0; i < pre.length; i++) {
        const diff = (pre[i] - post[i]) / 1e9;
        if (diff > 0.05 && diff < 100000) liquiditySol = Math.max(liquiditySol, diff);
      }

      return { tokenMint, poolAddress, deployer, liquiditySol };
    } catch (err) {
      logger.error(`[scan] extract: ${err.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------- Robinhood

  _startRobinhood() {
    try {
      this.swap.adapter('robinhood').onNewPool(async ({ tokenAddress, poolId }) => {
        if (!this._markSeen(`rh:${poolId}`)) return;
        logger.info(`[scan] robinhood pool ${tokenAddress}`);
        await this._emit({
          chain: 'robinhood',
          mint: tokenAddress,
          deployer: null,
          poolAddress: poolId,
          dex: 'uniswap-v4',
          liquidityNative: null,
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
  }
}

module.exports = Scanner;
