const { PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');
const { sleep } = require('../utils/async');

// LP tokens or supply sent here are provably gone.
const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111',
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

// Token-2022 extensions that let the issuer take or trap holders' tokens.
// Any one of these makes a clean-looking mint a honeypot in practice.
const FATAL_EXTENSIONS = {
  permanentDelegate: 'permanent delegate — the issuer can move or burn anyone\'s tokens',
  nonTransferable: 'non-transferable token — it cannot be sold',
};
const RISKY_EXTENSIONS = {
  transferHook: 'transfer hook — custom code runs on every transfer and can block sells',
  pausable: 'pausable mint — transfers can be halted',
  defaultAccountState: null, // only risky when the default is frozen; checked below
};

/**
 * A wallet is a point on the ed25519 curve; a PDA is deliberately off it.
 * Pool vaults, bonding curves and lockers are all owned by PDAs, so this one
 * check excludes program-held supply on every DEX without a hardcoded list.
 *
 * The old list held program IDs, but a token account's owner is the pool's
 * PDA, never the program — so a PumpSwap pool vault (often 20%+ of supply)
 * was counted as "the dev", tripping the >20% hard reject on clean tokens.
 */
function isProgramOwned(owner) {
  try { return !PublicKey.isOnCurve(new PublicKey(owner).toBytes()); } catch { return false; }
}

/**
 * Chain-agnostic contract safety checks. Returns the same shape for every
 * chain so the scorer never has to know which one it's looking at. Fields it
 * genuinely cannot determine are left null, not guessed.
 */
class SafetyChecker {
  constructor(solanaConnection, swapRouter) {
    this.connection = solanaConnection;
    this.swap = swapRouter;
  }

  /**
   * @param {object} ctx  { poolKey, poolAddress, lpMint, deployer }
   */
  async check(chain, mint, ctx = {}) {
    // Back-compat: callers used to pass the pool key positionally.
    if (ctx && ctx.currency0) ctx = { poolKey: ctx };

    const base = {
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      topHolderPct: null,
      devHoldingPct: null,
      holderCount: null,
      lpBurnedPct: null,
      lpLocked: null,
      lpUnlockedPct: null,
      honeypot: null,
      sellTaxPct: null,
      poolFeePct: null,
      decimals: null,
      totalSupply: null,
      fatal: null,
      flags: [],
    };

    // Contract checks and the sell probe are independent — run them together.
    const [specific, sellable] = await Promise.all([
      (chain === 'solana' ? this._checkSolana(mint, ctx) : this._checkEvm(chain, mint, ctx))
        .catch((err) => {
          logger.warn(`[safety] ${chain}/${mint}: ${err.message}`);
          return { flags: ['contract checks unavailable'] };
        }),
      this.swap.checkSellable(chain, mint, null, ctx.poolKey)
        .catch(err => ({ sellable: null, reason: `probe errored: ${err.message}` })),
    ]);

    const flags = [...(specific.flags || [])];
    Object.assign(base, specific);
    base.flags = flags;

    // Sellability is three-valued, and the third matters: true (sellable),
    // false (honeypot), null (could not determine). Treating null as a
    // honeypot condemned every token whose pool we could not quote.
    base.honeypot = sellable.sellable === null ? null : sellable.sellable === false;
    base.sellTaxPct = sellable.roundTripLossPct ?? null;
    base.poolFeePct = sellable.feePct ?? null;
    // V4 launch pools routinely open at a 50-80% fee that decays. Worth
    // naming explicitly — a buyer needs a big move just to break even.
    if (base.poolFeePct != null && base.poolFeePct > 10) {
      base.flags.push(`pool fee is ${base.poolFeePct.toFixed(1)}% per swap (often decays after launch)`);
    }
    if (sellable.dynamicFee) base.flags.push('dynamic-fee pool — the fee is set by a hook and can change');
    if (base.honeypot === true) base.flags.push(`cannot sell: ${sellable.reason}`);
    if (base.honeypot === null) base.flags.push(`sellability unverified (${sellable.reason})`);

    return base;
  }

  async _checkSolana(mint, { poolAddress, lpMint } = {}) {
    const out = { flags: [] };
    const mintPk = new PublicKey(mint);

    // The holder index lags the newest slot: for a mint created in the same
    // transaction as its pool, the first call routinely fails and a retry a
    // moment later succeeds.
    const largestOf = async (pk) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await this.connection.getTokenLargestAccounts(pk); } catch {
          if (attempt === 0) await sleep(1500);
        }
      }
      return null;
    };
    const [info, largest, lpLargest] = await Promise.all([
      this.swap.getTokenInfo('solana', mint),
      largestOf(mintPk),
      lpMint ? largestOf(new PublicKey(lpMint)) : null,
    ]);
    if (!info) throw new Error('mint account unreadable');

    out.decimals = info.decimals;
    out.totalSupply = info.totalSupply;
    out.mintAuthorityRevoked = info.mintAuthorityRevoked;
    out.freezeAuthorityRevoked = info.freezeAuthorityRevoked;
    if (!info.mintAuthorityRevoked) out.flags.push('mint authority still active — supply can be inflated');
    if (!info.freezeAuthorityRevoked) out.flags.push('freeze authority still active — your tokens can be frozen');

    // Token-2022 extensions.
    for (const [name, why] of Object.entries(FATAL_EXTENSIONS)) {
      if (info.extensions?.[name]) {
        const delegate = info.extensions[name]?.delegate;
        // A permanent delegate set to null is inert.
        if (name === 'permanentDelegate' && !delegate) continue;
        out.fatal = why;
        out.flags.push(why);
      }
    }
    for (const [name, why] of Object.entries(RISKY_EXTENSIONS)) {
      const state = info.extensions?.[name];
      if (!state) continue;
      if (name === 'defaultAccountState') {
        if (/frozen/i.test(state.accountState || '')) {
          out.fatal = 'new token accounts start frozen — buyers cannot sell';
          out.flags.push(out.fatal);
        }
        continue;
      }
      if (name === 'transferHook' && !state.programId) continue;
      out.flags.push(why);
    }
    const tfee = info.extensions?.transferFeeConfig?.newerTransferFee || info.extensions?.transferFeeConfig?.olderTransferFee;
    if (tfee?.transferFeeBasisPoints > 0) {
      out.transferFeePct = tfee.transferFeeBasisPoints / 100;
      out.flags.push(`${out.transferFeePct}% transfer tax on every move`);
    }

    // Resolve owners of the top holder accounts and LP holders in one call.
    const holderAccts = (largest?.value || []).slice(0, 12);
    const lpAccts = (lpLargest?.value || []).slice(0, 4);
    const lookups = [...holderAccts, ...lpAccts].map(a => a.address);
    const parsed = lookups.length
      ? (await this.connection.getMultipleParsedAccounts(lookups).catch(() => ({ value: [] }))).value
      : [];
    const ownerOf = (i) => parsed[i]?.data?.parsed?.info?.owner || null;

    const rawTotal = Number(info.rawSupply);
    if (rawTotal > 0 && holderAccts.length) {
      const holders = holderAccts.map((a, i) => ({
        address: a.address.toBase58(),
        owner: ownerOf(i),
        pct: (Number(a.amount) / rawTotal) * 100,
      }));
      const excluded = (h) =>
        BURN_ADDRESSES.has(h.address) || BURN_ADDRESSES.has(h.owner) ||
        h.owner === poolAddress || (h.owner && isProgramOwned(h.owner));

      const real = holders.filter(h => !excluded(h));
      const programHeld = holders.filter(excluded).reduce((s, h) => s + h.pct, 0);
      out.programHeldPct = programHeld;
      const realPct = real.slice(0, 10).reduce((s, h) => s + h.pct, 0);
      if (realPct < 0.5 && programHeld > 90) {
        // Seconds after creation the pool holds the whole supply. "Top 10
        // hold 0%" is not a distribution, it is the absence of one — leave it
        // unmeasured and let the re-check judge it once people have bought.
        out.flags.push('entire supply still in the pool — distribution not measurable yet');
      } else {
        out.topHolderPct = realPct;
        out.devHoldingPct = real[0]?.pct ?? 0;
      }

      if (out.topHolderPct > 50) out.flags.push(`top 10 wallets hold ${out.topHolderPct.toFixed(0)}%`);
      if (out.devHoldingPct > 15) out.flags.push(`single wallet holds ${out.devHoldingPct.toFixed(0)}%`);

      // Sybil: many wallets holding EXACTLY the same balance were airdropped.
      const amounts = holderAccts.map(a => a.amount).filter(a => a !== '0');
      const clusters = new Map();
      for (const amt of amounts) clusters.set(amt, (clusters.get(amt) || 0) + 1);
      const maxCluster = amounts.length ? Math.max(...clusters.values()) : 0;
      if (maxCluster >= 8 && maxCluster / amounts.length > 0.5) {
        out.flags.push(`${maxCluster} wallets hold exactly identical amounts — likely sybil`);
        out.sybilWallets = maxCluster;
      }
    }
    // getTokenLargestAccounts caps at 20, so this is a floor, not a count.
    if (largest?.value) out.holderCount = largest.value.length >= 20 ? null : largest.value.length;
    else out.flags.push('holder distribution unavailable');

    // LP custody: whoever holds the LP tokens can withdraw the liquidity.
    if (lpMint && lpLargest) {
      const offset = holderAccts.length;
      let total = 0, burned = 0, wallet = 0;
      lpAccts.forEach((a, i) => {
        const amt = Number(a.amount);
        const owner = ownerOf(offset + i);
        total += amt;
        if (BURN_ADDRESSES.has(a.address.toBase58()) || BURN_ADDRESSES.has(owner)) burned += amt;
        else if (owner && !isProgramOwned(owner)) wallet += amt;
      });
      if (total === 0) {
        // Every LP token account is empty: the LP was burned (supply destroyed).
        out.lpBurnedPct = 100;
        out.lpUnlockedPct = 0;
      } else {
        out.lpBurnedPct = (burned / total) * 100;
        out.lpUnlockedPct = (wallet / total) * 100;
      }
      out.lpLocked = out.lpUnlockedPct < 10;
    } else if (lpMint) {
      // We know there IS an LP and could not see who holds it. That is the
      // single most important rug check, so say so rather than stay silent.
      out.lpUnverified = true;
      out.flags.push('LP custody could not be verified yet');
    }

    return out;
  }

  async _checkEvm(chain, tokenAddress, { deployer } = {}) {
    const out = { flags: [] };
    const info = await this.swap.getTokenInfo(chain, tokenAddress);
    if (!info) {
      // Unknown, not unsafe: an unanswered RPC says nothing about the token.
      out.flags.push('contract did not respond to ERC20 calls');
      return out;
    }

    out.decimals = info.decimals;
    out.totalSupply = info.totalSupply;
    // An unrenounced owner is the EVM equivalent of a live mint authority:
    // whoever holds it may be able to mint, pause, or tax at will.
    out.mintAuthorityRevoked = info.ownerRenounced;
    out.freezeAuthorityRevoked = info.ownerRenounced;
    if (!info.ownerRenounced) {
      out.flags.push(`owner not renounced (${info.owner?.slice(0, 10)}…) — contract is still mutable`);
    }

    // No indexer covers this chain, but the deployer's own balance is one
    // call away — and a deployer still holding the bag is the main rug tell.
    if (deployer && info.rawSupply && info.rawSupply !== '0') {
      const adapter = this.swap.adapter(chain);
      const bal = adapter.balanceOf ? await adapter.balanceOf(tokenAddress, deployer) : null;
      if (bal != null) {
        out.devHoldingPct = Number((bal * 10000n) / BigInt(info.rawSupply)) / 100;
        if (out.devHoldingPct > 15) out.flags.push(`deployer still holds ${out.devHoldingPct.toFixed(0)}%`);
      }
    }
    return out;
  }
}

module.exports = SafetyChecker;
module.exports.BURN_ADDRESSES = BURN_ADDRESSES;
module.exports.isProgramOwned = isProgramOwned;
