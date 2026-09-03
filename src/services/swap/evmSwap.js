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

// V4Quoter.quoteExactInputSingle takes QuoteExactSingleParams, which is
// { PoolKey poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData }.
// There is NO poolManager field — including one produces a different selector
// (0xc10cb6f6 instead of 0xaa9d21cb) that the deployed contract does not
// implement, so every call reverted with no data. Verified against the
// deployed bytecode.
const V4_QUOTER_ABI = [
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) returns (uint256 amountOut, uint256 gasEstimate)',
];

const POOL_MANAGER_ABI = [
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
];

const V4_SWAP = 0x10;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0e;
const TAKE_ALL = 0x0f;
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Robinhood Chain swap adapter (Uniswap V4 via UniversalRouter).
 * Mirrors SolanaSwapAdapter's interface: raw amounts in, raw amounts out.
 */
/** Thrown when a token's V4 pool key has not been observed, so it cannot be quoted. */
class PoolUnknownError extends Error {
  constructor(token) {
    super(`No known V4 pool for ${token}`);
    this.name = 'PoolUnknownError';
    this.poolUnknown = true;
  }
}

class EvmSwapAdapter {
  constructor(chainConfig = CHAINS.robinhood) {
    this.config = chainConfig;
    this.chain = 'robinhood';
    this.nativeDecimals = 18;
    // Shared, throttled provider — see services/evmProvider.js.
    this.provider = getEvmProvider(chainConfig);
    this._decimalsCache = new Map();
    this._pools = new Map();
  }

  /**
   * Remember the exact PoolKey seen in a pool's Initialize event.
   *
   * V4 pool keys are NOT guessable. Observed fees on this chain include 9000,
   * 810000 and 813690, and tick spacings 90, 200 and 19988 — nothing like the
   * 3000/60 this code used to assume. A key that is even slightly wrong
   * addresses a pool that does not exist, so every quote reverts. That made
   * the sellability probe report *every* token as a honeypot.
   */
  rememberPool(tokenAddress, poolKey) {
    if (!tokenAddress || !poolKey) return;
    this._pools.set(tokenAddress.toLowerCase(), poolKey);
  }

  knownPool(tokenAddress) {
    return this._pools.get(tokenAddress?.toLowerCase()) || null;
  }

  /**
   * Build the V4 pool key for a token, or null when it is not known. Callers
   * must treat null as "cannot quote", never as "cannot sell".
   */
  _poolKey(tokenAddress, override) {
    const key = override || this.knownPool(tokenAddress);
    if (!key) return null;

    const token = tokenAddress.toLowerCase();
    const tokenIsCurrency0 = key.currency0.toLowerCase() === token;
    return {
      currency0: key.currency0,
      currency1: key.currency1,
      fee: Number(key.fee),
      tickSpacing: Number(key.tickSpacing),
      hooks: key.hooks || ZERO,
      tokenIsCurrency0,
      // The other side of the pair — native ETH (address(0)) for most pools
      // on this chain, occasionally WETH.
      nativeCurrency: tokenIsCurrency0 ? key.currency1 : key.currency0,
    };
  }

  _encodeSwap(pk, zeroForOne, amountIn, minOut, settleCurrency, takeCurrency) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const swapAction = coder.encode(
      ['tuple(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'bytes'],
      [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks], zeroForOne, amountIn, minOut, '0x']
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
  async quote(tokenAddress, rawAmountIn, isBuy, poolKeyOverride) {
    const pk = this._poolKey(tokenAddress, poolKeyOverride);
    if (!pk) throw new PoolUnknownError(tokenAddress);

    // Buying the token means spending the native side, so zeroForOne is true
    // when the native currency is currency0.
    const zeroForOne = isBuy ? !pk.tokenIsCurrency0 : pk.tokenIsCurrency0;
    const quoter = new ethers.Contract(this.config.v4Quoter, V4_QUOTER_ABI, this.provider);
    const [amountOut] = await quoter.quoteExactInputSingle.staticCall([
      [pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks],
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

    const pk = this._poolKey(tokenAddress);
    if (!pk) throw new PoolUnknownError(tokenAddress);

    let minOut = 0n;
    try {
      const q = await this.quote(tokenAddress, amountIn, true, pk);
      minOut = (q.rawOut * BigInt(10000 - slippageBps)) / 10000n;
    } catch (err) {
      logger.warn(`[rh] quote failed, sending with no minOut: ${err.message}`);
    }

    const zeroForOne = !pk.tokenIsCurrency0;
    // Settle the native side of THIS pool — address(0) for native ETH pools.
    const input = this._encodeSwap(pk, zeroForOne, amountIn, minOut, pk.nativeCurrency, tokenAddress);

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

    const pk = this._poolKey(tokenAddress);
    if (!pk) throw new PoolUnknownError(tokenAddress);

    let minOut = 0n;
    try {
      const q = await this.quote(tokenAddress, amountIn, false, pk);
      minOut = (q.rawOut * BigInt(10000 - slippageBps)) / 10000n;
    } catch (err) {
      logger.warn(`[rh] sell quote failed: ${err.message}`);
    }

    const zeroForOne = pk.tokenIsCurrency0;
    const input = this._encodeSwap(pk, zeroForOne, amountIn, minOut, tokenAddress, pk.nativeCurrency);

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
  async getPrice(tokenAddress, nativePriceUsd, poolKey) {
    try {
      const probe = ethers.parseEther('0.01');
      const q = await this.quote(tokenAddress, probe, true, poolKey);
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
  /**
   * Sellability probe. `sellable: null` means UNKNOWN — the pool could not be
   * reached — and must never be scored as a honeypot. Conflating those two
   * marked every token on this chain unsellable.
   */
  async checkSellable(tokenAddress, _decimals, poolKey) {
    const pk = this._poolKey(tokenAddress, poolKey);
    if (!pk) return { sellable: null, reason: 'pool key unknown — cannot probe' };

    try {
      const probe = ethers.parseEther('0.01');
      const buyQ = await this.quote(tokenAddress, probe, true, pk);
      if (!buyQ.outAmount) return { sellable: null, reason: 'buy quote returned nothing' };

      const sellQ = await this.quote(tokenAddress, buyQ.rawOut, false, pk);
      if (!sellQ.outAmount) return { sellable: false, reason: 'sell quote reverts (honeypot)' };

      // A large round-trip loss is a TAX, not a honeypot. V4 fees are in
      // hundredths of a bip, so fee=813690 is an 81% swap fee — common on
      // launches where the fee decays over the first minutes. The token is
      // genuinely sellable; it is just expensive right now. Report it as tax
      // and let scoring penalise it, rather than condemning it outright.
      const roundTripLoss = 1 - (sellQ.outAmount / Number(probe));
      return {
        sellable: true,
        roundTripLossPct: roundTripLoss * 100,
        feePct: pk.fee / 10000,
        reason: null,
      };
    } catch (err) {
      // A revert is ambiguous: honeypot, or a pool not initialised yet.
      // Report unknown and let confidence carry the doubt.
      return { sellable: null, reason: `probe failed: ${err.shortMessage || err.message}` };
    }
  }

  /**
   * Estimate the pool's native-side depth from price impact. For a constant
   * product pool, buying x of the native side moves price by roughly x/reserve,
   * so reserve ~= x / impact. Rough, but it is the only liquidity signal
   * available on a chain no indexer covers.
   */
  async getLiquidityEstimate(tokenAddress, poolKey) {
    const pk = this._poolKey(tokenAddress, poolKey);
    if (!pk) return null;
    try {
      const small = ethers.parseEther('0.01');
      const large = ethers.parseEther('1');
      const [qs, ql] = await Promise.all([
        this.quote(tokenAddress, small, true, pk),
        this.quote(tokenAddress, large, true, pk),
      ]);
      if (!qs.outAmount || !ql.outAmount) return null;

      const rateSmall = qs.outAmount / Number(small);
      const rateLarge = ql.outAmount / Number(large);
      const impact = 1 - rateLarge / rateSmall;
      if (!(impact > 0)) return null;      // deeper than the probe can measure
      if (impact >= 0.999) return 0;       // essentially no liquidity
      return 1 / impact;                   // native-side reserve, in ETH
    } catch {
      return null;
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

      // Pools pair against native ETH (address(0)) far more often than WETH.
      const isNative = (a) => a === ZERO || a === weth;
      if (!isNative(c0) && !isNative(c1)) return;

      const tokenAddress = isNative(c0) ? currency1 : currency0;
      if (tokenAddress.toLowerCase() === ZERO) return; // both sides native

      const poolKey = {
        currency0, currency1,
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
        hooks,
      };
      this.rememberPool(tokenAddress, poolKey);
      await callback({ tokenAddress, poolId: id, poolKey });
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
module.exports.PoolUnknownError = PoolUnknownError;
