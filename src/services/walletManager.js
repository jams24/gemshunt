const { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } = require('@solana/web3.js');
const { ethers } = require('ethers');
const bs58 = require('bs58').default || require('bs58');
const crypto = require('crypto');
const logger = require('../utils/logger');

const ALGORITHM = 'aes-256-gcm';

class WalletManager {
  constructor(solanaConnection) {
    this.solanaConnection = solanaConnection;
    this.masterKey = process.env.ENCRYPTION_KEY;
    if (!this.masterKey || this.masterKey.length < 32) {
      logger.warn('ENCRYPTION_KEY not set — wallets will not work');
    }
    this.keypairCache = new Map();
  }

  // === SOLANA ===
  createSolanaWallet() {
    const keypair = Keypair.generate();
    return {
      publicKey: keypair.publicKey.toBase58(),
      privateKey: bs58.encode(keypair.secretKey),
    };
  }

  importSolanaWallet(privateKeyStr) {
    const decoded = bs58.decode(privateKeyStr);
    const keypair = Keypair.fromSecretKey(decoded);
    return {
      publicKey: keypair.publicKey.toBase58(),
      privateKey: privateKeyStr,
    };
  }

  getSolanaKeypair(encryptedKey) {
    const privateKey = this.decrypt(encryptedKey);
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  }

  getCachedSolanaKeypair(userId, encryptedKey) {
    const cacheKey = `sol_${userId}`;
    if (this.keypairCache.has(cacheKey)) return this.keypairCache.get(cacheKey);
    const kp = this.getSolanaKeypair(encryptedKey);
    this.keypairCache.set(cacheKey, kp);
    return kp;
  }

  async getSolanaBalance(publicKey) {
    const bal = await this.solanaConnection.getBalance(new PublicKey(publicKey));
    return bal / LAMPORTS_PER_SOL;
  }

  async withdrawSolana(encryptedKey, toAddress, solAmount) {
    const keypair = this.getSolanaKeypair(encryptedKey);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(toAddress),
        lamports: Math.floor(solAmount * LAMPORTS_PER_SOL),
      })
    );
    tx.feePayer = keypair.publicKey;
    tx.recentBlockhash = (await this.solanaConnection.getLatestBlockhash()).blockhash;
    tx.sign(keypair);
    const sig = await this.solanaConnection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await this.solanaConnection.confirmTransaction(sig, 'confirmed');
    return sig;
  }

  // === EVM (Robinhood Chain) ===
  createEvmWallet() {
    const wallet = ethers.Wallet.createRandom();
    return {
      publicKey: wallet.address,
      privateKey: wallet.privateKey,
    };
  }

  importEvmWallet(privateKeyStr) {
    if (!privateKeyStr.startsWith('0x')) privateKeyStr = '0x' + privateKeyStr;
    const wallet = new ethers.Wallet(privateKeyStr);
    return {
      publicKey: wallet.address,
      privateKey: privateKeyStr,
    };
  }

  getEvmPrivateKey(encryptedKey) {
    return this.decrypt(encryptedKey);
  }

  // === ENCRYPTION ===
  encrypt(text) {
    if (!this.masterKey) throw new Error('Encryption key not configured');
    const key = Buffer.from(this.masterKey, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + tag + ':' + encrypted;
  }

  decrypt(encryptedText) {
    if (!this.masterKey) throw new Error('Encryption key not configured');
    const key = Buffer.from(this.masterKey, 'hex');
    const [ivHex, tagHex, data] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  async exportPrivateKey(encryptedKey) {
    return this.decrypt(encryptedKey);
  }
}

module.exports = WalletManager;
