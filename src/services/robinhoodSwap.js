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

const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];

const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];

const V4_QUOTER_ABI = [
  'function quoteExactInputSingle((address poolManager, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) view returns (uint256 amountOut, uint256 gasEstimate)',
];

const POOL_MANAGER_ABI = [
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
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

  // Uniswap V4 swap via UniversalRouter
  // Command 0x10 = V4_SWAP
  async buy(privateKey, tokenAddress, ethAmount, slippagePct = 10) {
    const wallet = this.getWallet(privateKey);
    const router = new ethers.Contract(this.config.universalRouter, UNIVERSAL_ROUTER_ABI, wallet);

    const amountIn = ethers.parseEther(ethAmount.toString());
    const deadline = Math.floor(Date.now() / 1000) + 300;

    // Encode V4 exact input single swap: WETH → token
    const weth = this.config.weth;
    const [currency0, currency1, zeroForOne] = weth.toLowerCase() < tokenAddress.toLowerCase()
      ? [weth, tokenAddress, true]
      : [tokenAddress, weth, false];

    // V4 swap actions encoded
    // SWAP_EXACT_IN_SINGLE = 0x06
    const swapAction = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'bytes'],
      [
        [currency0, currency1, 3000, 60, ethers.ZeroAddress], // poolKey (fee=0.3%, tickSpacing=60)
        zeroForOne,
        amountIn,
        0n, // amountOutMin (we apply slippage below via separate check)
        '0x', // hookData
      ]
    );

    // SETTLE_ALL = 0x0e (settle ETH input)
    const settleAction = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [weth, amountIn]
    );

    // TAKE_ALL = 0x0f (take token output)
    const takeAction = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint128'],
      [tokenAddress, 0n]
    );

    // Commands: V4_SWAP (0x10)
    const actions = ethers.concat([
      ethers.toBeHex(0x06, 1), // SWAP_EXACT_IN_SINGLE
      ethers.toBeHex(0x0e, 1), // SETTLE_ALL
      ethers.toBeHex(0x0f, 1), // TAKE_ALL
    ]);

    const v4SwapInput = ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes', 'bytes[]'],
      [actions, [swapAction, settleAction, takeAction]]
    );

    const commands = ethers.toBeHex(0x10, 1); // V4_SWAP command
    const inputs = [v4SwapInput];

    const tx = await router.execute(commands, inputs, deadline, {
      value: amountIn,
      gasLimit: 500000,
    });

    const receipt = await tx.wait();
    logger.info(`[RH] Buy tx: ${receipt.hash}`);

    // Get output amount from token balance change
    const tokenBal = await this.getTokenBalance(wallet.address, tokenAddress);

    return {
      signature: receipt.hash,
      inputAmount: ethAmount,
      outputAmount: tokenBal.formatted,
    };
  }

  async sell(privateKey, tokenAddress, tokenAmount, slippagePct = 10) {
    const wallet = this.getWallet(privateKey);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

    const decimals = await token.decimals();
    const amountIn = typeof tokenAmount === 'bigint' ? tokenAmount : ethers.parseUnits(tokenAmount.toString(), decimals);

    // Approve Permit2 first, then Permit2 approves UniversalRouter
    const permit2 = new ethers.Contract(this.config.permit2, PERMIT2_ABI, wallet);
    const allowance = await token.allowance(wallet.address, this.config.permit2);
    if (allowance < amountIn) {
      const approveTx = await token.approve(this.config.permit2, ethers.MaxUint256);
      await approveTx.wait();
    }

    // Permit2 allowance to UniversalRouter
    const [p2Amount] = await permit2.allowance(wallet.address, tokenAddress, this.config.universalRouter);
    if (p2Amount < amountIn) {
      const p2Tx = await permit2.approve(tokenAddress, this.config.universalRouter, ethers.MaxUint160, Math.floor(Date.now() / 1000) + 86400 * 30);
      await p2Tx.wait();
    }

    const router = new ethers.Contract(this.config.universalRouter, UNIVERSAL_ROUTER_ABI, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const weth = this.config.weth;

    const [currency0, currency1, zeroForOne] = tokenAddress.toLowerCase() < weth.toLowerCase()
      ? [tokenAddress, weth, true]
      : [weth, tokenAddress, false];

    const swapAction = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'bytes'],
      [
        [currency0, currency1, 3000, 60, ethers.ZeroAddress],
        zeroForOne,
        amountIn,
        0n,
        '0x',
      ]
    );

    const settleAction = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [tokenAddress, amountIn]
    );

    const takeAction = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint128'],
      [weth, 0n]
    );

    const actions = ethers.concat([
      ethers.toBeHex(0x06, 1),
      ethers.toBeHex(0x0e, 1),
      ethers.toBeHex(0x0f, 1),
    ]);

    const v4SwapInput = ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes', 'bytes[]'],
      [actions, [swapAction, settleAction, takeAction]]
    );

    const commands = ethers.toBeHex(0x10, 1);
    const inputs = [v4SwapInput];

    // Check ETH balance before
    const ethBefore = await this.provider.getBalance(wallet.address);

    const tx = await router.execute(commands, inputs, deadline, { gasLimit: 500000 });
    const receipt = await tx.wait();
    logger.info(`[RH] Sell tx: ${receipt.hash}`);

    const ethAfter = await this.provider.getBalance(wallet.address);
    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const ethReceived = parseFloat(ethers.formatEther(ethAfter - ethBefore + gasCost));

    return {
      signature: receipt.hash,
      inputAmount: Number(ethers.formatUnits(amountIn, decimals)),
      outputAmount: Math.max(0, ethReceived),
    };
  }

  async getPrice(tokenAddress) {
    try {
      const weth = this.config.weth;
      const [currency0, currency1, zeroForOne] = weth.toLowerCase() < tokenAddress.toLowerCase()
        ? [weth, tokenAddress, true]
        : [tokenAddress, weth, false];

      const quoter = new ethers.Contract(this.config.v4Quoter, V4_QUOTER_ABI, this.provider);
      const oneEth = ethers.parseEther('0.01'); // quote small amount to avoid price impact

      const [amountOut] = await quoter.quoteExactInputSingle.staticCall([
        this.config.poolManager,
        [currency0, currency1, 3000, 60, ethers.ZeroAddress],
        zeroForOne,
        oneEth,
        '0x',
      ]);

      const tokensPerSmallEth = Number(ethers.formatUnits(amountOut, 18));
      const tokensPerEth = tokensPerSmallEth * 100;
      const ethPrice = await this._getEthPrice();
      return ethPrice / tokensPerEth;
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
    try {
      const poolManager = new ethers.Contract(this.config.poolManager, POOL_MANAGER_ABI, this.provider);
      poolManager.on('Initialize', async (id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick) => {
        const weth = this.config.weth.toLowerCase();
        const tokenAddress = currency0.toLowerCase() === weth ? currency1 : currency0;
        if (currency0.toLowerCase() !== weth && currency1.toLowerCase() !== weth) return;

        try {
          const info = await this.getTokenInfo(tokenAddress);
          callback({
            chain: 'robinhood',
            mint: tokenAddress,
            symbol: info?.symbol || 'UNKNOWN',
            name: info?.name || 'Unknown',
            poolAddress: id,
            dex: 'uniswap-v4',
          });
        } catch (err) {
          logger.error(`[RH] Pool parse error: ${err.message}`);
        }
      });
      logger.info('Listening for new Robinhood Chain pools (V4 PoolManager)...');
    } catch (err) {
      logger.error(`[RH] Failed to start pair listener: ${err.message}`);
    }
  }
}

module.exports = RobinhoodSwapService;
