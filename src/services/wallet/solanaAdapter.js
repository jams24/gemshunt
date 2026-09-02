const {
  Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction,
} = require('@solana/web3.js');
const {
  createTransferInstruction, getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58').default || require('bs58');
const logger = require('../../utils/logger');

const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * Solana half of the wallet interface. Every method here has a matching
 * signature on EvmAdapter so WalletManager can stay chain-agnostic.
 */
class SolanaAdapter {
  constructor(connection) {
    this.connection = connection;
    this.chain = 'solana';
    this.currency = 'SOL';
    this.decimals = 9;
  }

  create() {
    const kp = Keypair.generate();
    return { publicKey: kp.publicKey.toBase58(), privateKey: bs58.encode(kp.secretKey) };
  }

  import(privateKeyStr) {
    const kp = Keypair.fromSecretKey(bs58.decode(privateKeyStr.trim()));
    return { publicKey: kp.publicKey.toBase58(), privateKey: privateKeyStr.trim() };
  }

  isValidAddress(address) {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  signer(privateKey) {
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  }

  async getBalance(address) {
    const bal = await this.connection.getBalance(new PublicKey(address));
    return bal / LAMPORTS_PER_SOL;
  }

  /** All non-zero SPL token balances held by this wallet. */
  async getTokenBalances(address) {
    try {
      const res = await this.connection.getParsedTokenAccountsByOwner(
        new PublicKey(address), { programId: TOKEN_PROGRAM_ID }
      );
      return res.value
        .map(({ account }) => {
          const info = account.data.parsed.info;
          return {
            mint: info.mint,
            amount: Number(info.tokenAmount.amount),
            uiAmount: info.tokenAmount.uiAmount || 0,
            decimals: info.tokenAmount.decimals,
          };
        })
        .filter(t => t.uiAmount > 0 && t.mint !== WSOL)
        .sort((a, b) => b.uiAmount - a.uiAmount);
    } catch (err) {
      logger.error(`[sol] token balances failed: ${err.message}`);
      return [];
    }
  }

  async getTokenBalance(address, mint) {
    try {
      const ata = await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(address));
      const res = await this.connection.getTokenAccountBalance(ata);
      return {
        amount: Number(res.value.amount),
        uiAmount: res.value.uiAmount || 0,
        decimals: res.value.decimals,
      };
    } catch {
      return { amount: 0, uiAmount: 0, decimals: 9 };
    }
  }

  async withdrawNative(privateKey, toAddress, amount) {
    const kp = this.signer(privateKey);
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: new PublicKey(toAddress),
      lamports,
    }));
    return this._send(tx, kp);
  }

  async withdrawToken(privateKey, toAddress, mint, rawAmount) {
    const kp = this.signer(privateKey);
    const mintPk = new PublicKey(mint);
    const dest = new PublicKey(toAddress);
    const fromAta = await getAssociatedTokenAddress(mintPk, kp.publicKey);
    const toAta = await getAssociatedTokenAddress(mintPk, dest);

    const tx = new Transaction();
    // Create the recipient's token account if they've never held this mint.
    const toInfo = await this.connection.getAccountInfo(toAta);
    if (!toInfo) {
      tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, toAta, dest, mintPk));
    }
    tx.add(createTransferInstruction(fromAta, toAta, kp.publicKey, BigInt(rawAmount)));
    return this._send(tx, kp);
  }

  async _send(tx, kp) {
    tx.feePayer = kp.publicKey;
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(kp);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  }
}

module.exports = SolanaAdapter;
