const { PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');

const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

class TokenScanner {
  constructor(connection, db) {
    this.connection = connection;
    this.db = db;
    this.onNewToken = null;
    this.seenPools = new Set();
  }

  async startListening() {
    logger.info('Starting Raydium pool listener...');

    this.connection.onLogs(RAYDIUM_AMM_V4, async (logs) => {
      if (!logs.logs.some(l => l.includes('initialize2'))) return;

      try {
        const sig = logs.signature;
        if (this.seenPools.has(sig)) return;
        this.seenPools.add(sig);

        const tx = await this.connection.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (!tx) return;

        const poolInfo = this.extractPoolInfo(tx);
        if (!poolInfo) return;

        logger.info(`New pool detected: ${poolInfo.tokenMint}`, {
          liquidity: poolInfo.liquiditySol,
        });

        const safety = await this.runSafetyChecks(poolInfo.tokenMint);
        const tokenData = {
          mint: poolInfo.tokenMint,
          symbol: poolInfo.symbol || 'UNKNOWN',
          name: poolInfo.name || 'Unknown Token',
          deployer: poolInfo.deployer,
          poolAddress: poolInfo.poolAddress,
          dex: 'raydium',
          liquiditySol: poolInfo.liquiditySol,
          initialMc: poolInfo.marketCap,
          ...safety,
        };

        await this.db.saveToken(tokenData);

        if (this.onNewToken) {
          this.onNewToken(tokenData);
        }
      } catch (err) {
        logger.error(`Pool parse error: ${err.message}`);
      }
    }, 'confirmed');

    // Prune seen pools every hour
    setInterval(() => {
      if (this.seenPools.size > 5000) {
        this.seenPools.clear();
      }
    }, 60 * 60 * 1000);
  }

  extractPoolInfo(tx) {
    try {
      const accounts = tx.transaction.message.accountKeys;
      const instructions = tx.transaction.message.instructions;

      let tokenMint = null;
      let poolAddress = null;
      let deployer = accounts[0]?.pubkey?.toBase58();
      let liquiditySol = 0;

      for (const ix of instructions) {
        if (ix.programId?.toBase58() === RAYDIUM_AMM_V4.toBase58()) {
          const ixAccounts = ix.accounts || [];
          if (ixAccounts.length >= 10) {
            poolAddress = ixAccounts[4]?.toBase58();
            const mintA = ixAccounts[8]?.toBase58();
            const mintB = ixAccounts[9]?.toBase58();
            const WSOL = 'So11111111111111111111111111111111111111112';
            tokenMint = mintA === WSOL ? mintB : mintA;
          }
        }
      }

      if (!tokenMint) return null;

      const preBalances = tx.meta?.preBalances || [];
      const postBalances = tx.meta?.postBalances || [];
      for (let i = 0; i < preBalances.length; i++) {
        const diff = (preBalances[i] - postBalances[i]) / 1e9;
        if (diff > 0.5 && diff < 10000) {
          liquiditySol = Math.max(liquiditySol, diff);
        }
      }

      return { tokenMint, poolAddress, deployer, liquiditySol, marketCap: 0 };
    } catch (err) {
      logger.error(`Extract pool info error: ${err.message}`);
      return null;
    }
  }

  async runSafetyChecks(mintAddress) {
    const result = {
      lpLocked: false,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      topHolderPct: 100,
      isSafe: false,
    };

    try {
      const mint = new PublicKey(mintAddress);
      const accountInfo = await this.connection.getParsedAccountInfo(mint);
      const parsed = accountInfo?.value?.data?.parsed?.info;
      if (parsed) {
        result.mintAuthorityRevoked = !parsed.mintAuthority;
        result.freezeAuthorityRevoked = !parsed.freezeAuthority;
      }

      const accounts = await this.connection.getTokenLargestAccounts(mint);
      const supply = await this.connection.getTokenSupply(mint);
      const totalSupply = Number(supply.value.amount);
      const topHolderPct = accounts.value.slice(0, 10).reduce((sum, a) => sum + (Number(a.amount) / totalSupply) * 100, 0);
      result.topHolderPct = topHolderPct;

      result.isSafe = result.mintAuthorityRevoked &&
                      result.freezeAuthorityRevoked &&
                      topHolderPct < 50;

      logger.info(`Safety check ${mintAddress}: mint_revoked=${result.mintAuthorityRevoked} freeze_revoked=${result.freezeAuthorityRevoked} top_holders=${topHolderPct.toFixed(1)}% safe=${result.isSafe}`);
    } catch (err) {
      logger.error(`Safety check failed: ${err.message}`);
    }

    return result;
  }
}

module.exports = TokenScanner;
