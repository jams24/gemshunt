const { ethers } = require('ethers');
const axios = require('axios');
const logger = require('../utils/logger');
const CHAINS = require('./chains');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

const ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
];

const FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
];

class RobinhoodSwapService {
  constructor() {
    const config = CHAINS.robinhood;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
    this.config = config;
    this.walletCache = new Map();
  }

  getWallet(privateKey) {
    if (this.walletCache.has(privateKey)) return this.walletCache.get(privateKey);
    const wallet = new ethers.Wallet(privateKey, this.provider);
    this.walletCache.set(privateKey, wallet);
    return wallet;
  }

  async getBalance(address) {
    const bal = await this.provider.getBalance(address);
    return parseFloat(ethers.formatEther(bal));
  }

  async getTokenBalance(walletAddress, tokenAddress) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    const [balance, decimals] = await Promise.all([
      token.balanceOf(walletAddress),
      token.decimals(),
    ]);
    return { raw: balance, formatted: parseFloat(ethers.formatUnits(balance, decimals)), decimals };
  }

  async getTokenInfo(tokenAddress) {
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
      const [symbol, name, decimals, totalSupply] = await Promise.all([
        token.symbol().catch(() => 'UNKNOWN'),
        token.name().catch(() => 'Unknown'),
        token.decimals().catch(() => 18),
        token.totalSupply().catch(() => 0n),
      ]);
      return { symbol, name, decimals: Number(decimals), totalSupply };
    } catch (err) {
      logger.error(`Token info failed: ${err.message}`);
      return null;
    }
  }

  async buy(privateKey, tokenAddress, ethAmount, slippagePct = 10) {
    const wallet = this.getWallet(privateKey);
    const router = new ethers.Contract(this.config.uniswapRouter, ROUTER_ABI, wallet);

    const path = [this.config.weth, tokenAddress];
    const amountIn = ethers.parseEther(ethAmount.toString());

    const amounts = await router.getAmountsOut(amountIn, path);
    const amountOutMin = amounts[1] * BigInt(100 - slippagePct) / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const tx = await router.swapExactETHForTokens(
      amountOutMin, path, wallet.address, deadline,
      { value: amountIn, gasLimit: 300000 }
    );

    const receipt = await tx.wait();
    logger.info(`[RH] Buy tx: ${receipt.hash}`);

    return {
      signature: receipt.hash,
      inputAmount: ethAmount,
      outputAmount: Number(ethers.formatUnits(amounts[1], 18)),
    };
  }

  async sell(privateKey, tokenAddress, tokenAmount, slippagePct = 10) {
    const wallet = this.getWallet(privateKey);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const router = new ethers.Contract(this.config.uniswapRouter, ROUTER_ABI, wallet);

    const decimals = await token.decimals();
    const amountIn = typeof tokenAmount === 'bigint' ? tokenAmount : ethers.parseUnits(tokenAmount.toString(), decimals);

    // Approve router if needed
    const allowance = await token.allowance(wallet.address, this.config.uniswapRouter);
    if (allowance < amountIn) {
      const approveTx = await token.approve(this.config.uniswapRouter, ethers.MaxUint256);
      await approveTx.wait();
    }

    const path = [tokenAddress, this.config.weth];
    const amounts = await router.getAmountsOut(amountIn, path);
    const amountOutMin = amounts[1] * BigInt(100 - slippagePct) / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const tx = await router.swapExactTokensForETH(
      amountIn, amountOutMin, path, wallet.address, deadline,
      { gasLimit: 350000 }
    );

    const receipt = await tx.wait();
    logger.info(`[RH] Sell tx: ${receipt.hash}`);

    return {
      signature: receipt.hash,
      inputAmount: Number(ethers.formatUnits(amountIn, decimals)),
      outputAmount: Number(ethers.formatEther(amounts[1])),
    };
  }

  async getPrice(tokenAddress) {
    try {
      const router = new ethers.Contract(this.config.uniswapRouter, ROUTER_ABI, this.provider);
      const path = [this.config.weth, tokenAddress];
      const oneEth = ethers.parseEther('1');
      const amounts = await router.getAmountsOut(oneEth, path);
      const ethPrice = await this._getEthPrice();
      return ethPrice / Number(ethers.formatUnits(amounts[1], 18));
    } catch {
      return null;
    }
  }

  async _getEthPrice() {
    try {
      const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { timeout: 5000 });
      return res.data.ethereum.usd;
    } catch {
      return 2500;
    }
  }

  async withdraw(privateKey, toAddress, ethAmount) {
    const wallet = this.getWallet(privateKey);
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: ethers.parseEther(ethAmount.toString()),
    });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  listenForNewPairs(callback) {
    const factory = new ethers.Contract(this.config.uniswapFactory, FACTORY_ABI, this.provider);
    factory.on('PairCreated', async (token0, token1, pair) => {
      const weth = this.config.weth.toLowerCase();
      const tokenAddress = token0.toLowerCase() === weth ? token1 : token0;
      if (token0.toLowerCase() !== weth && token1.toLowerCase() !== weth) return;

      try {
        const info = await this.getTokenInfo(tokenAddress);
        callback({
          chain: 'robinhood',
          mint: tokenAddress,
          symbol: info?.symbol || 'UNKNOWN',
          name: info?.name || 'Unknown',
          poolAddress: pair,
          dex: 'uniswap',
        });
      } catch (err) {
        logger.error(`[RH] Pair parse error: ${err.message}`);
      }
    });
    logger.info('Listening for new Robinhood Chain pairs...');
  }
}

module.exports = RobinhoodSwapService;
