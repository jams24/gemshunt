const crypto = require('crypto');
const logger = require('../../utils/logger');
const CHAINS = require('../chains');
const SolanaAdapter = require('./solanaAdapter');
const EvmAdapter = require('./evmAdapter');

const ALGORITHM = 'aes-256-gcm';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

/**
 * Chain-agnostic wallet facade. Callers pass a chain name and never branch on
 * it themselves. Adding a chain means adding one adapter and one CHAINS entry.
 */
class WalletManager {
  constructor(solanaConnection, encryptionKey) {
    this.masterKey = encryptionKey || process.env.ENCRYPTION_KEY;
    this.adapters = {
      solana: new SolanaAdapter(solanaConnection),
      robinhood: new EvmAdapter(CHAINS.robinhood),
    };
    // Decrypted signers are held briefly to avoid a KDF round-trip per trade,
    // but they are secrets: bound the cache and expire entries.
    this.signerCache = new Map();
    this._sweeper = setInterval(() => this._sweep(), 60 * 1000);
    this._sweeper.unref?.();
  }

  adapter(chain) {
    const a = this.adapters[chain];
    if (!a) throw new Error(`Unsupported chain: ${chain}`);
    return a;
  }

  chains() {
    return Object.keys(this.adapters);
  }

  meta(chain) {
    return CHAINS[chain];
  }

  // ------------------------------------------------------------ lifecycle

  createWallet(chain) {
    const { publicKey, privateKey } = this.adapter(chain).create();
    return { publicKey, privateKey, encrypted: this.encrypt(privateKey) };
  }

  importWallet(chain, privateKeyStr) {
    const { publicKey, privateKey } = this.adapter(chain).import(privateKeyStr);
    return { publicKey, privateKey, encrypted: this.encrypt(privateKey) };
  }

  isValidAddress(chain, address) {
    return this.adapter(chain).isValidAddress(address);
  }

  /**
   * Both chains at once, so a new user is never one wallet short when they
   * switch chains mid-session.
   */
  createAllWallets() {
    const out = {};
    for (const chain of this.chains()) out[chain] = this.createWallet(chain);
    return out;
  }

  // ------------------------------------------------------------ signing

  getSigner(userId, chain, encryptedKey) {
    const cacheKey = `${chain}:${userId}`;
    const hit = this.signerCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.signer;

    const signer = this.adapter(chain).signer(this.decrypt(encryptedKey));
    if (this.signerCache.size >= CACHE_MAX) this._evictOldest();
    this.signerCache.set(cacheKey, { signer, expires: Date.now() + CACHE_TTL_MS });
    return signer;
  }

  getPrivateKey(encryptedKey) {
    return this.decrypt(encryptedKey);
  }

  /** Drop a user's cached signer, e.g. after they re-import a wallet. */
  forget(userId) {
    for (const chain of this.chains()) this.signerCache.delete(`${chain}:${userId}`);
  }

  _sweep() {
    const now = Date.now();
    for (const [k, v] of this.signerCache) {
      if (v.expires <= now) this.signerCache.delete(k);
    }
  }

  _evictOldest() {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of this.signerCache) {
      if (v.expires < oldest) { oldest = v.expires; oldestKey = k; }
    }
    if (oldestKey) this.signerCache.delete(oldestKey);
  }

  // ------------------------------------------------------------ balances

  async getBalance(chain, address) {
    return this.adapter(chain).getBalance(address);
  }

  async getTokenBalances(chain, address) {
    return this.adapter(chain).getTokenBalances(address);
  }

  async getTokenBalance(chain, address, mint) {
    return this.adapter(chain).getTokenBalance(address, mint);
  }

  /**
   * One call that returns the user's whole portfolio across every chain, so
   * /wallet is a single screen instead of a per-chain drill-down. Chains that
   * fail are reported with an error instead of sinking the whole view.
   */
  async getPortfolio(user, priceFn) {
    const walletsByChain = {
      solana: user.sol_wallet_address,
      robinhood: user.evm_wallet_address,
    };

    const results = await Promise.all(this.chains().map(async (chain) => {
      const address = walletsByChain[chain];
      if (!address) return { chain, address: null, meta: CHAINS[chain] };
      try {
        const [native, tokens, nativeUsd] = await Promise.all([
          this.getBalance(chain, address),
          this.getTokenBalances(chain, address),
          priceFn ? priceFn(chain).catch(() => null) : Promise.resolve(null),
        ]);
        return {
          chain,
          address,
          meta: CHAINS[chain],
          native,
          nativeUsd: nativeUsd ? native * nativeUsd : null,
          nativePriceUsd: nativeUsd,
          tokens: tokens.slice(0, 15),
          tokenCount: tokens.length,
        };
      } catch (err) {
        logger.error(`[${chain}] portfolio failed: ${err.message}`);
        return { chain, address, meta: CHAINS[chain], error: err.message };
      }
    }));

    const totalUsd = results.reduce((sum, r) => sum + (r.nativeUsd || 0), 0);
    return { chains: results, totalUsd };
  }

  // ------------------------------------------------------------ withdrawals

  async withdrawNative(chain, encryptedKey, toAddress, amount) {
    if (!this.isValidAddress(chain, toAddress)) {
      throw new Error(`Not a valid ${CHAINS[chain].name} address`);
    }
    return this.adapter(chain).withdrawNative(this.decrypt(encryptedKey), toAddress, amount);
  }

  async withdrawToken(chain, encryptedKey, toAddress, mint, rawAmount) {
    if (!this.isValidAddress(chain, toAddress)) {
      throw new Error(`Not a valid ${CHAINS[chain].name} address`);
    }
    return this.adapter(chain).withdrawToken(this.decrypt(encryptedKey), toAddress, mint, rawAmount);
  }

  // ------------------------------------------------------------ encryption

  encrypt(text) {
    const key = Buffer.from(this.masterKey, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
  }

  decrypt(encryptedText) {
    if (!encryptedText) throw new Error('No wallet key stored');
    const key = Buffer.from(this.masterKey, 'hex');
    const [ivHex, tagHex, data] = encryptedText.split(':');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
  }

  async exportPrivateKey(encryptedKey) {
    return this.decrypt(encryptedKey);
  }

  // --------------------------------------------- back-compat shims
  // The old call sites used chain-specific names. Keep them working so this
  // refactor doesn't have to land atomically with every caller.
  createSolanaWallet() { return this.adapter('solana').create(); }
  createEvmWallet() { return this.adapter('robinhood').create(); }
  importSolanaWallet(pk) { return this.adapter('solana').import(pk); }
  importEvmWallet(pk) { return this.adapter('robinhood').import(pk); }
  getSolanaBalance(addr) { return this.getBalance('solana', addr); }
  getEvmBalance(addr) { return this.getBalance('robinhood', addr); }
  getEvmPrivateKey(enc) { return this.decrypt(enc); }
  getSolanaKeypair(enc) { return this.adapter('solana').signer(this.decrypt(enc)); }
  getCachedSolanaKeypair(userId, enc) { return this.getSigner(userId, 'solana', enc); }
  withdrawSolana(enc, to, amt) { return this.withdrawNative('solana', enc, to, amt); }
}

module.exports = WalletManager;
