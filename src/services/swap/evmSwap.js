const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const CHAINS = require('../chains');
const { getEvmProvider, getEvmWsUrl, ReconnectingLogWatcher } = require('../evmProvider');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
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

const V4_SWAP = 0x10;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0e;
const TAKE_ALL = 0x0f;
const POOL_FEE = 3000;
const TICK_SPACING = 60;

/**
 * Robinhood Chain swap adapter (Uniswap V4 via UniversalRouter).
 * Mirrors SolanaSwapAdapter's interface: raw amounts in, raw amounts out.
 */
class EvmSwapAdapter {
  constructor(chainConfig = CHAINS.robinhood) {
    this.config = chainConfig;
    this.chain = 'robinhood';
    this.nativeDecimals = 18;
    // Shared, throttled provider — see services/evmProvider.js.
    this.provider = getEvmProvider(chainConfig);
    this._decimalsCache = new Map();
  }

  _poolKey(tokenAddress) {
    const weth = this.config.weth;
    const tokenFirst = tokenAddress.toLowerCase() < weth.toLowerCase();
    return {
      currency0: tokenFirst ? tokenAddress : weth,
      currency1: tokenFirst ? weth : tokenAddress,
      tokenIsCurrency0: tokenFirst,
    };
  }

  _encodeSwap({ currency0, currency1 }, zeroForOne, amountIn, minOut, settleCurrency, takeCurrency) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const swapAction = coder.encode(
      ['tuple(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'bytes'],
      [[currency0, currency1, POOL_FEE, TICK_SPACING, ethers.ZeroAddress], zeroForOne, amountIn, minOut, '0x']
    );
    const settleAction = coder.encode(['address', 'uint256'], [settleCurrency, amountIn]);
    const takeAction = coder.encode(['address', 'uint128'], [takeCurrency, minOut]);

    const actions = ethers.concat([
      ethers.toBeHex(SWAP_EXACT_IN_SINGLE, 1),
      ethers.toBeHex(SETTLE_ALL, 1),
      ethers.toBeHex(TAKE_ALL, 1),
    ]);
    return coder.encode(['bytes', 'bytes[]'], [actions, [swapAction, settleAction, takeAction]]);
  }

  async getDecimals(tokenAddress) {
    const key = tokenAddress.toLowerCase();
    if (this._decimalsCache.has(key)) return this._decimalsCache.get(key);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    const d = Number(await token.decimals().catch(() => 18));
    this._decimalsCache.set(key, d);
    return d;
  }

  /** Quote via the V4 quoter. amountIn/out are RAW units. */
  async quote(tokenAddress, rawAmountIn, isBuy) {
    const { currency0, currency1, tokenIsCurrency0 } = this._poolKey(tokenAddress);
    // Buying the token means selling WETH, so zeroForOne is true when WETH is currency0.
    const zeroForOne = isBuy ? !tokenIsCurrency0 : tokenIsCurrency0;
    const quoter = new ethers.Contract(this.config.v4Quoter, V4_QUOTER_ABI, this.provider);
    const [amountOut] = await quoter.quoteExactInputSingle.staticCall([
      this.config.poolManager,
      [currency0, currency1, POOL_FEE, TICK_SPACING, ethers.ZeroAddress],
      zeroForOne,
      rawAmountIn,
      '0x',
    ]);
    return { inAmount: Number(rawAmountIn), outAmount: Number(amountOut), rawOut: amountOut };
  }

  /**
   * nativeAmount in ETH. Returns outputAmount in RAW token units, measured as
   * a balance DELTA — the previous implementation reported the wallet's whole
   * balance, which corrupted entry price on any token already held.
   */
  async buy(signer, tokenAddress, nativeAmount, slippageBps = 1000) {
    const wallet = signer.connect ? signer.connect(this.provider) : signer;
    const amountIn = ethers.parseEther(nativeAmount.toString());

    let minOut = 0n;
    try {
      const q = await this.quote(tokenAddress, amountIn, true);
      minOut = (q.rawOut * BigInt(10000 - slippageBps)) / 10000n;
    } catch (err) {
      logger.warn(`[rh] quote failed, sending with no minOut: ${err.message}`);
    }

    const poolKey = this._poolKey(tokenAddress);
    const zeroForOne = !poolKey.tokenIsCurrency0;
    const input = this._encodeSwap(poolKey, zeroForOne, amountIn, minOut, this.config.weth, tokenAddress);

    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    const before = await token.balanceOf(wallet.address);

    const router = new ethers.Contract(this.config.universalRouter, UNIVERSAL_ROUTER_ABI, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const tx = await router.execute(ethers.toBeHex(V4_SWAP, 1), [input], deadline, {
      value: amountIn,
      gasLimit: 500000,
    });
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`Buy tx reverted: ${receipt.hash}`);

    const after = await token.balanceOf(wallet.address);
    const received = after - before;
    logger.info(`[rh] buy ${receipt.hash} received ${received}`);

    return {
      signature: receipt.hash,
      inputAmount: Number(amountIn),
      outputAmount: Number(received),
      rawOutput: received,
    };
  }

  /** rawTokenAmount in RAW units. Returns outputAmount in RAW wei. */
  async sell(signer, tokenAddress, rawTokenAmount, slippageBps = 1000) {
    const wallet = signer.connect ? signer.connect(this.provider) : signer;
    const amountIn = BigInt(rawTokenAmount);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

    // Token -> Permit2 -> UniversalRouter is the V4 approval path.
    const allowance = await token.allowance(wallet.address, this.config.permit2);
    if (allowance < amountIn) {
      await (await token.approve(this.config.permit2, ethers.MaxUint256)).wait();
    }
    const permit2 = new ethers.Contract(this.config.permit2, PERMIT2_ABI, wallet);
    const [p2Amount] = await permit2.allowance(wallet.address, tokenAddress, this.config.universalRouter);
    if (p2Amount < amountIn) {
      await (await permit2.approve(
        tokenAddress, this.config.universalRouter,
        ethers.MaxUint160, Math.floor(Date.now() / 1000) + 86400 * 30
      )).wait();
    }

    let minOut = 0n;
    try {
      const q = await this.quote(tokenAddress, amountIn, false);
      minOut = (q.rawOut * BigInt(10000 - slippageBps)) / 10000n;
    } catch (err) {
      logger.warn(`[rh] sell quote failed: ${err.message}`);
    }

    const poolKey = this._poolKey(tokenAddress);
    const zeroForOne = poolKey.tokenIsCurrency0;
    const input = this._encodeSwap(poolKey, zeroForOne, amountIn, minOut, tokenAddress, this.config.weth);

    const ethBefore = await this.provider.getBalance(wallet.address);
    const router = new ethers.Contract(this.config.universalRouter, UNIVERSAL_ROUTER_ABI, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const tx = await router.execute(ethers.toBeHex(V4_SWAP, 1), [input], deadline, { gasLimit: 500000 });
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`Sell tx reverted: ${receipt.hash}`);

    const ethAfter = await this.provider.getBalance(wallet.address);
    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const received = ethAfter - ethBefore + gasCost;
    logger.info(`[rh] sell ${receipt.hash}`);

    return {
      signature: receipt.hash,
      inputAmount: Number(amountIn),
      outputAmount: Number(received > 0n ? received : 0n),
      rawOutput: received > 0n ? received : 0n,
    };
  }

  /** Price in USD per whole token. */
  async getPrice(tokenAddress, nativePriceUsd) {
    try {
      const probe = ethers.parseEther('0.01');
      const q = await this.quote(tokenAddress, probe, true);
      if (!q.outAmount) return null;
      const decimals = await this.getDecimals(tokenAddress);
      const tokensOut = Number(ethers.formatUnits(q.rawOut, decimals));
      if (!tokensOut) return null;
      const ethPerToken = 0.01 / tokensOut;
      return nativePriceUsd ? ethPerToken * nativePriceUsd : null;
    } catch {
      return null;
    }
  }

  async getTokenInfo(tokenAddress) {
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
      const [symbol, name, decimals, totalSupply, owner] = await Promise.all([
        token.symbol().catch(() => 'UNKNOWN'),
        token.name().catch(() => 'Unknown'),
        token.decimals().catch(() => 18),
        token.totalSupply().catch(() => 0n),
        token.owner().catch(() => null),
      ]);
      return {
        symbol, name,
        decimals: Number(decimals),
        totalSupply: parseFloat(ethers.formatUnits(totalSupply, decimals)),
        rawSupply: totalSupply.toString(),
        // No owner() means no privileged admin function — the EVM analogue of
        // a revoked mint authority.
        ownerRenounced: !owner || owner === ethers.ZeroAddress,
        owner,
      };
    } catch (err) {
      logger.error(`[rh] token info ${tokenAddress}: ${err.message}`);
      return null;
    }
  }

  /**
   * Sellability probe using quoter round-trip. Quote-only, costs no gas.
   * A token that quotes a buy but cannot quote a sell is a honeypot.
   */
  async checkSellable(tokenAddress) {
    try {
      const probe = ethers.parseEther('0.01');
      const buyQ = await this.quote(tokenAddress, probe, true);
      if (!buyQ.outAmount) return { sellable: false, reason: 'no buy route' };

      const sellQ = await this.quote(tokenAddress, buyQ.rawOut, false);
      if (!sellQ.outAmount) return { sellable: false, reason: 'sell quote reverts (honeypot)' };

      const roundTripLoss = 1 - (sellQ.outAmount / Number(probe));
      return {
        sellable: roundTripLoss < 0.9,
        roundTripLossPct: roundTripLoss * 100,
        reason: roundTripLoss >= 0.9 ? 'round-trip loses >90% (high sell tax)' : null,
      };
    } catch (err) {
      return { sellable: false, reason: `probe reverted: ${err.message}` };
    }
  }

  /**
   * Watch for new V4 pools. Prefers a WebSocket subscription — the chain pushes
   * events the moment they land, so detection is near-instant and costs no
   * polling requests. Falls back to HTTP polling when no WebSocket endpoint is
   * configured (the public RPC has none), which is correct but up to one
   * polling interval late on every pool.
   */
  onNewPool(callback) {
    const handler = async (id, currency0, currency1, fee, tickSpacing, hooks) => {
      const weth = this.config.weth.toLowerCase();
      const c0 = currency0.toLowerCase();
      const c1 = currency1.toLowerCase();
      if (c0 !== weth && c1 !== weth) return;
      const tokenAddress = c0 === weth ? currency1 : currency0;
      await callback({ tokenAddress, poolId: id, fee: Number(fee), hooks });
    };

    const wsUrl = getEvmWsUrl(this.config);
    if (wsUrl) {
      this.poolWatcher = new ReconnectingLogWatcher({
        wsUrl,
        chainId: this.config.chainId,
        address: this.config.poolManager,
        abi: POOL_MANAGER_ABI,
        event: 'Initialize',
        onEvent: handler,
        label: 'rh',
      });
      this.poolWatcher.start();
      return;
    }

    const poolManager = new ethers.Contract(this.config.poolManager, POOL_MANAGER_ABI, this.provider);
    poolManager.on('Initialize', (...args) => {
      handler(...args).catch(err => logger.error(`[rh] pool handler: ${err.message}`));
    });
    this.poolContract = poolManager;
    logger.warn('[rh] no websocket endpoint — falling back to HTTP polling for pool detection');
  }

  stopWatching() {
    this.poolWatcher?.stop();
    try { this.poolContract?.removeAllListeners(); } catch { /* already gone */ }
  }
}

module.exports = EvmSwapAdapter;
