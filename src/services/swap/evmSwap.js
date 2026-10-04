const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const CHAINS = require('../chains');
const { getEvmProvider, getEvmWsUrl, ReconnectingLogWatcher } = require('../evmProvider');
const stats = require('../stats');

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

// V4 marks a pool whose fee is set by its hook with this bit in the fee field.
// The raw value 8388608 is NOT a fee — reading it as one reported an "838%
// swap fee" and zeroed the safety score of every dynamic-fee pool.
const DYNAMIC_FEE_FLAG = 0x800000;

const QUOTE_TTL_MS = 8000;
const TOKEN_INFO_TTL_MS = 5 * 60 * 1000;
// After an outage, replaying more than this many blocks of pools would alert
// on tokens that are already old news (Robinhood Chain runs ~10 blocks/s).
const MAX_CATCHUP_BLOCKS = 18000;
const LOG_CHUNK_BLOCKS = 5000;

/** Fee in percent, or null for a dynamic-fee pool whose fee lives in its hook. */
function poolFeePct(fee) {
  const f = Number(fee);
  if (!Number.isFinite(f) || (f & DYNAMIC_FEE_FLAG)) return null;
  return f / 10000;
}

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
    this._quoteCache = new Map();
    this._infoCache = new Map();
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

  /**
   * Quote via the V4 quoter. amountIn/out are RAW units.
   *
   * Memoised for a few seconds: one analysis asks for the same 0.01 ETH buy
   * quote from the price, sellability and depth checks. On a rate-limited
   * public RPC, sharing it is the difference between 3 calls and 5.
   */
  quote(tokenAddress, rawAmountIn, isBuy, poolKeyOverride) {
    const pk = this._poolKey(tokenAddress, poolKeyOverride);
    if (!pk) return Promise.reject(new PoolUnknownError(tokenAddress));

    const key = [tokenAddress.toLowerCase(), String(rawAmountIn), isBuy, pk.fee, pk.tickSpacing, pk.hooks].join(':');
    const hit = this._quoteCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.promise;

    const promise = this._quote(tokenAddress, rawAmountIn, isBuy, pk);
    if (this._quoteCache.size > 500) this._quoteCache.clear();
    this._quoteCache.set(key, { promise, expires: Date.now() + QUOTE_TTL_MS });
    // A failed quote must not be served from cache to the next caller.
    promise.catch(() => this._quoteCache.delete(key));
    return promise;
  }

  async _quote(tokenAddress, rawAmountIn, isBuy, pk) {
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
      // Fresh quote, not the memoised one: minOut must reflect the pool now.
      const q = await this._quote(tokenAddress, amountIn, true, pk);
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
      const q = await this._quote(tokenAddress, amountIn, false, pk);
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
    const key = tokenAddress.toLowerCase();
    const hit = this._infoCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await this._fetchTokenInfo(tokenAddress);
    if (value) {
      if (this._infoCache.size > 2000) this._infoCache.clear();
      this._infoCache.set(key, { value, expires: Date.now() + TOKEN_INFO_TTL_MS });
      this._decimalsCache.set(key, value.decimals);
    }
    return value;
  }

  async _fetchTokenInfo(tokenAddress) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    // A REVERT means the function does not exist; any other failure means the
    // RPC did not answer. Only the first is evidence about the token. Folding
    // both into a default made a rate-limited RPC report every token as
    // "owner renounced" — the failure made tokens look safer.
    const reverted = (err) => err?.code === 'CALL_EXCEPTION' || err?.code === 'BAD_DATA';
    const optional = (p, fallback) => p.catch(err => {
      if (reverted(err)) return fallback;
      throw err;
    });
    try {
      // totalSupply is mandatory: a contract without it is not an ERC20.
      const [symbol, name, decimals, totalSupply, owner] = await Promise.all([
        optional(token.symbol(), 'UNKNOWN'),
        optional(token.name(), null),
        optional(token.decimals(), 18n),
        token.totalSupply(),
        optional(token.owner(), null),
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
      logger.warn(`[rh] token info ${tokenAddress}: ${err.shortMessage || err.message}`);
      return null;
    }
  }

  /** Raw ERC20 balance, or null when it cannot be read. */
  async balanceOf(tokenAddress, holder) {
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
      return await token.balanceOf(holder);
    } catch {
      return null;
    }
  }

  /** The externally-owned account that sent a transaction — the deployer. */
  async getTxSender(txHash) {
    const tx = await this.provider.getTransaction(txHash);
    return tx?.from || null;
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
        feePct: poolFeePct(pk.fee),
        dynamicFee: poolFeePct(pk.fee) === null,
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
   * events the moment they land. Without one it polls eth_getLogs directly.
   *
   * The poller is ours rather than ethers' contract.on(): ethers' HTTP event
   * polling swallows failures into an 'error' event and gives no way to tell
   * "no pools" from "not polling", which is the exact silence this bot has
   * been bitten by. Here every successful poll is reported (`onPoll`) so the
   * health monitor can tell the two apart, and a gap is caught up on recovery.
   */
  onNewPool(callback, { onPoll } = {}) {
    const weth = this.config.weth.toLowerCase();
    const isNative = (a) => a === ZERO || a === weth;

    const handle = async (currency0, currency1, fee, tickSpacing, hooks, id, txHash) => {
      const c0 = currency0.toLowerCase();
      const c1 = currency1.toLowerCase();
      // Pools pair against native ETH (address(0)) far more often than WETH.
      if (!isNative(c0) && !isNative(c1)) return;
      const tokenAddress = isNative(c0) ? currency1 : currency0;
      if (isNative(tokenAddress.toLowerCase())) return; // both sides native

      const poolKey = {
        currency0, currency1,
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
        hooks,
      };
      this.rememberPool(tokenAddress, poolKey);
      await callback({ tokenAddress, poolId: id, poolKey, txHash });
    };

    const wsUrl = getEvmWsUrl(this.config);
    if (wsUrl) {
      this.poolWatcher = new ReconnectingLogWatcher({
        wsUrl,
        chainId: this.config.chainId,
        address: this.config.poolManager,
        abi: POOL_MANAGER_ABI,
        event: 'Initialize',
        // ethers passes the decoded args, then a payload carrying the raw log.
        onEvent: (id, c0, c1, fee, spacing, hooks, _sqrt, _tick, payload) =>
          handle(c0, c1, fee, spacing, hooks, id, payload?.log?.transactionHash),
        onBlock: onPoll,
        label: 'rh',
      });
      this.poolWatcher.start();
      return;
    }

    logger.warn('[rh] no websocket endpoint — polling eth_getLogs for new pools');
    this._startLogPoller(handle, onPoll);
  }

  _startLogPoller(handle, onPoll) {
    const iface = new ethers.Interface(POOL_MANAGER_ABI);
    const topic = iface.getEvent('Initialize').topicHash;
    const intervalMs = parseInt(process.env.EVM_POLLING_INTERVAL_MS, 10) || 5000;
    let from = null;
    this._polling = true;

    const tick = async () => {
      if (!this._polling) return;
      try {
        const head = await this.provider.getBlockNumber();
        if (from === null) from = head - 20;
        if (head - from > MAX_CATCHUP_BLOCKS) {
          logger.warn(`[rh] ${head - from} blocks behind — skipping ahead, older pools are stale`);
          stats.inc('robinhood', 'poll_skipped_ahead');
          from = head - 600;
        }
        while (from <= head && this._polling) {
          const to = Math.min(head, from + LOG_CHUNK_BLOCKS);
          const logs = await this.provider.getLogs({
            address: this.config.poolManager, topics: [topic], fromBlock: from, toBlock: to,
          });
          from = to + 1;
          for (const log of logs) {
            const ev = iface.parseLog(log);
            const [id, c0, c1, fee, spacing, hooks] = ev.args;
            handle(c0, c1, fee, spacing, hooks, id, log.transactionHash)
              .catch(err => logger.error(`[rh] pool handler: ${err.message}`));
          }
        }
        onPoll?.();
      } catch (err) {
        stats.inc('robinhood', 'poll_error', 1, err.shortMessage || err.message);
      } finally {
        if (this._polling) {
          this._pollTimer = setTimeout(tick, intervalMs);
          this._pollTimer.unref?.();
        }
      }
    };
    tick();
  }

  stopWatching() {
    this.poolWatcher?.stop();
    this._polling = false;
    clearTimeout(this._pollTimer);
  }
}

module.exports = EvmSwapAdapter;
module.exports.PoolUnknownError = PoolUnknownError;
module.exports.poolFeePct = poolFeePct;
