const { PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');

// LP tokens sent here are provably gone.
const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111',
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

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

  async check(chain, mint) {
    const base = {
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      topHolderPct: null,
      devHoldingPct: null,
      holderCount: null,
      lpBurnedPct: null,
      lpLocked: null,
      honeypot: null,
      sellTaxPct: null,
      decimals: null,
      totalSupply: null,
      flags: [],
    };

    try {
      const specific = chain === 'solana'
        ? await this._checkSolana(mint)
        : await this._checkEvm(mint);
      Object.assign(base, specific);
    } catch (err) {
      logger.error(`[safety] ${chain}/${mint}: ${err.message}`);
      base.flags.push('safety check errored');
    }

    // Sellability probe is identical in intent on both chains.
    try {
      const sellable = await this.swap.checkSellable(chain, mint, base.decimals || 9);
      base.honeypot = sellable.sellable === false;
      base.sellTaxPct = sellable.roundTripLossPct ?? null;
      if (base.honeypot) base.flags.push(`cannot sell: ${sellable.reason}`);
    } catch (err) {
      base.flags.push('sellability probe failed');
    }

    return base;
  }

  async _checkSolana(mint) {
    const mintPk = new PublicKey(mint);
    const out = { flags: [] };

    const [accountInfo, supply, largest] = await Promise.all([
      this.connection.getParsedAccountInfo(mintPk),
      this.connection.getTokenSupply(mintPk),
      this.connection.getTokenLargestAccounts(mintPk).catch(() => ({ value: [] })),
    ]);

    const parsed = accountInfo?.value?.data?.parsed?.info;
    out.mintAuthorityRevoked = parsed ? !parsed.mintAuthority : null;
    out.freezeAuthorityRevoked = parsed ? !parsed.freezeAuthority : null;
    out.decimals = supply.value.decimals;
    out.totalSupply = Number(supply.value.uiAmount);

    if (out.mintAuthorityRevoked === false) out.flags.push('mint authority still active — supply can be inflated');
    if (out.freezeAuthorityRevoked === false) out.flags.push('freeze authority still active — your tokens can be frozen');

    const total = Number(supply.value.amount);
    if (total > 0 && largest.value.length) {
      const holders = largest.value.map(a => ({
        address: a.address.toBase58(),
        pct: (Number(a.amount) / total) * 100,
      }));

      // Burn/LP addresses are not real concentration — exclude them or every
      // healthy token with a burned LP looks like a rug.
      const real = holders.filter(h => !BURN_ADDRESSES.has(h.address));
      out.topHolderPct = real.slice(0, 10).reduce((s, h) => s + h.pct, 0);
      out.devHoldingPct = real[0]?.pct ?? null;

      const burned = holders.filter(h => BURN_ADDRESSES.has(h.address)).reduce((s, h) => s + h.pct, 0);
      out.lpBurnedPct = burned;
      out.lpLocked = burned > 50;

      if (out.topHolderPct > 50) out.flags.push(`top 10 wallets hold ${out.topHolderPct.toFixed(0)}%`);
      if (out.devHoldingPct > 15) out.flags.push(`single wallet holds ${out.devHoldingPct.toFixed(0)}%`);
    }

    // getTokenLargestAccounts caps at 20, so this is a floor, not a count.
    out.holderCount = largest.value.length >= 20 ? null : largest.value.length;
    return out;
  }

  async _checkEvm(tokenAddress) {
    const out = { flags: [] };
    const info = await this.swap.getTokenInfo('robinhood', tokenAddress);
    if (!info) {
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
    return out;
  }
}

module.exports = SafetyChecker;
module.exports.BURN_ADDRESSES = BURN_ADDRESSES;
