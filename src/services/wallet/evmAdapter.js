const { ethers } = require('ethers');
const axios = require('axios');
const logger = require('../../utils/logger');
const { getEvmProvider } = require('../evmProvider');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

/**
 * EVM half of the wallet interface (Robinhood Chain today, any EVM chain
 * tomorrow). Method signatures mirror SolanaAdapter exactly.
 */
class EvmAdapter {
  constructor(chainConfig) {
    this.config = chainConfig;
    this.chain = 'robinhood';
    this.currency = chainConfig.currency || 'ETH';
    this.decimals = 18;
    // Same provider instance the swap adapter uses — two providers meant
    // two independent polling loops against one rate-limited endpoint.
    this.provider = getEvmProvider(chainConfig);
  }

  create() {
    const w = ethers.Wallet.createRandom();
    return { publicKey: w.address, privateKey: w.privateKey };
  }

  import(privateKeyStr) {
    let pk = privateKeyStr.trim();
    if (!pk.startsWith('0x')) pk = '0x' + pk;
    const w = new ethers.Wallet(pk);
    return { publicKey: w.address, privateKey: pk };
  }

  isValidAddress(address) {
    return ethers.isAddress(address);
  }

  signer(privateKey) {
    return new ethers.Wallet(privateKey, this.provider);
  }

  async getBalance(address) {
    const bal = await this.provider.getBalance(address);
    return parseFloat(ethers.formatEther(bal));
  }

  /**
   * EVM has no native "list my tokens" RPC. Blockscout exposes it for free on
   * Robinhood Chain; if that call fails we return empty rather than throwing,
   * and the caller falls back to the tokens it knows about from positions.
   */
  async getTokenBalances(address) {
    try {
      const url = `${this.config.explorer}/api/v2/addresses/${address}/token-balances`;
      const { data } = await axios.get(url, { timeout: 8000 });
      if (!Array.isArray(data)) return [];
      return data
        .map(item => {
          const decimals = parseInt(item.token?.decimals ?? 18, 10);
          const raw = item.value || '0';
          return {
            mint: item.token?.address,
            symbol: item.token?.symbol || 'UNKNOWN',
            amount: Number(raw),
            uiAmount: parseFloat(ethers.formatUnits(raw, decimals)),
            decimals,
          };
        })
        .filter(t => t.mint && t.uiAmount > 0)
        .sort((a, b) => b.uiAmount - a.uiAmount);
    } catch (err) {
      logger.warn(`[evm] token balances unavailable: ${err.message}`);
      return [];
    }
  }

  async getTokenBalance(address, tokenAddress) {
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
      const [raw, decimals] = await Promise.all([token.balanceOf(address), token.decimals()]);
      return {
        amount: Number(raw),
        uiAmount: parseFloat(ethers.formatUnits(raw, decimals)),
        decimals: Number(decimals),
      };
    } catch {
      return { amount: 0, uiAmount: 0, decimals: 18 };
    }
  }

  async withdrawNative(privateKey, toAddress, amount) {
    const wallet = this.signer(privateKey);
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: ethers.parseEther(amount.toString()),
    });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async withdrawToken(privateKey, toAddress, tokenAddress, rawAmount) {
    const wallet = this.signer(privateKey);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const tx = await token.transfer(toAddress, BigInt(rawAmount));
    const receipt = await tx.wait();
    return receipt.hash;
  }
}

module.exports = EvmAdapter;
