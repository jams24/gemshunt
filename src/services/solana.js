const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
const logger = require('../utils/logger');

class SolanaService {
  constructor() {
    this.connection = new Connection(process.env.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      wsEndpoint: process.env.SOLANA_WS_URL,
    });

    if (process.env.WALLET_PRIVATE_KEY) {
      this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
      logger.info(`Wallet loaded: ${this.wallet.publicKey.toBase58()}`);
    } else {
      logger.warn('No wallet private key set — running in watch-only mode');
    }
  }

  async getBalance() {
    if (!this.wallet) return 0;
    const bal = await this.connection.getBalance(this.wallet.publicKey);
    return bal / LAMPORTS_PER_SOL;
  }

  async getTokenBalance(mintAddress) {
    if (!this.wallet) return 0;
    try {
      const mint = new PublicKey(mintAddress);
      const ata = await getAssociatedTokenAddress(mint, this.wallet.publicKey);
      const account = await getAccount(this.connection, ata);
      return Number(account.amount);
    } catch {
      return 0;
    }
  }

  async getSolPrice() {
    try {
      const { data } = require('axios').default;
      const res = await require('axios').get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      return res.data.solana.usd;
    } catch {
      return 150;
    }
  }

  async getTokenInfo(mintAddress) {
    try {
      const mint = new PublicKey(mintAddress);
      const supply = await this.connection.getTokenSupply(mint);
      const accountInfo = await this.connection.getParsedAccountInfo(mint);
      const parsed = accountInfo?.value?.data?.parsed?.info;

      return {
        mint: mintAddress,
        supply: Number(supply.value.amount),
        decimals: supply.value.decimals,
        mintAuthorityRevoked: !parsed?.mintAuthority,
        freezeAuthorityRevoked: !parsed?.freezeAuthority,
      };
    } catch (err) {
      logger.error(`Token info failed for ${mintAddress}: ${err.message}`);
      return null;
    }
  }

  async getTopHolders(mintAddress, topN = 10) {
    try {
      const mint = new PublicKey(mintAddress);
      const accounts = await this.connection.getTokenLargestAccounts(mint);
      const supply = await this.connection.getTokenSupply(mint);
      const totalSupply = Number(supply.value.amount);

      const holders = accounts.value.slice(0, topN).map(a => ({
        address: a.address.toBase58(),
        amount: Number(a.amount),
        pct: (Number(a.amount) / totalSupply) * 100,
      }));

      const topHolderPct = holders.reduce((sum, h) => sum + h.pct, 0);
      return { holders, topHolderPct };
    } catch (err) {
      logger.error(`Top holders failed: ${err.message}`);
      return { holders: [], topHolderPct: 100 };
    }
  }

  async sendTransaction(tx) {
    if (!this.wallet) throw new Error('No wallet configured');

    if (tx instanceof VersionedTransaction) {
      tx.sign([this.wallet]);
      const sig = await this.connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
      await this.connection.confirmTransaction(sig, 'confirmed');
      return sig;
    }

    tx.feePayer = this.wallet.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    tx.sign(this.wallet);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    await this.connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }
}

module.exports = SolanaService;
