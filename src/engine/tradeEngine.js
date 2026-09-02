const logger = require('../utils/logger');
const db = require('../db/database');
const CHAINS = require('../services/chains');

/**
 * Buy/sell logic and position management. Deliberately knows nothing about
 * which chain it is on — WalletManager and SwapRouter resolve that — so TP/SL
 * behaviour is identical everywhere and a new chain needs no changes here.
 */
class TradeEngine {
  constructor({ swapRouter, walletManager, config }) {
    this.swap = swapRouter;
    this.wallets = walletManager;
    this.config = config;

    this.maxPositionsPerUser = config.trading.maxOpenPositions;
    this.defaultBuyAmount = config.trading.maxBuyNative;

    this.tp1x = 2;
    this.tp2x = 5;
    this.tp3x = 10;
    this.slPct = -50;

    this.onTradeEvent = null;
  }

  // ------------------------------------------------------------ helpers

  /** The wallet columns for a chain, so callers stop hand-picking them. */
  _walletFor(user, chain) {
    const map = {
      solana: { address: user.sol_wallet_address, encrypted: user.sol_wallet_key_encrypted },
      robinhood: { address: user.evm_wallet_address, encrypted: user.evm_wallet_key_encrypted },
    };
    const w = map[chain];
    if (!w?.address) {
      throw new Error(`No ${CHAINS[chain]?.name || chain} wallet yet — use /wallet to create one.`);
    }
    return w;
  }

  _minGasReserve(chain) {
    return chain === 'solana' ? 0.005 : 0.001;
  }

  // --------------------------------------------------------------- buy

  async buyToken(userId, mint, amount, chainOverride) {
    const user = await db.getUser(userId);
    if (!user) throw new Error('Not registered. Send /start first.');

    const chain = chainOverride || user.active_chain || 'solana';
    const meta = CHAINS[chain];
    const wallet = this._walletFor(user, chain);

    const positions = await db.getUserPositions(userId, 'open');
    if (positions.length >= this.maxPositionsPerUser) {
      throw new Error(`Max ${this.maxPositionsPerUser} open positions reached`);
    }
    if (positions.some(p => p.mint === mint && p.chain === chain)) {
      throw new Error('Already holding this token');
    }

    const buyAmount = amount || user.max_buy_amount || this.defaultBuyAmount;
    const slippage = user.slippage_bps || this.config.trading.slippageBps;

    const balance = await this.wallets.getBalance(chain, wallet.address);
    const needed = buyAmount + this._minGasReserve(chain);
    if (balance < needed) {
      throw new Error(
        `Insufficient ${meta.currency}: have ${balance.toFixed(4)}, need ${needed.toFixed(4)}.\n` +
        `Deposit to:\n<code>${wallet.address}</code>`
      );
    }

    const signer = this.wallets.getSigner(userId, chain, wallet.encrypted);
    const result = await this.swap.buy(chain, signer, mint, buyAmount, slippage);

    const info = await this.swap.getTokenInfo(chain, mint).catch(() => null);
    const decimals = info?.decimals ?? 9;
    const rawOut = BigInt(result.rawOutput ?? Math.floor(result.outputAmount));
    const uiTokens = Number(rawOut) / 10 ** decimals;
    if (uiTokens <= 0) throw new Error('Swap returned no tokens — aborting position');

    const entryPriceNative = buyAmount / uiTokens;
    const nativeUsd = await this.swap.getNativePriceUsd(chain);
    const symbol = info?.symbol || (await db.getToken(chain, mint))?.symbol || 'TOKEN';

    const pos = await db.openPosition(userId, {
      chain, mint, symbol,
      entryPriceSol: entryPriceNative,
      entryPriceUsd: entryPriceNative * nativeUsd,
      tokenAmount: uiTokens,
      tokenAmountRaw: rawOut.toString(),
      decimals,
      solInvested: buyAmount,
    });

    await db.saveTrade(userId, {
      chain, mint, symbol, direction: 'buy',
      solAmount: buyAmount,
      tokenAmount: uiTokens,
      tokenAmountRaw: rawOut.toString(),
      priceSol: entryPriceNative,
      priceUsd: entryPriceNative * nativeUsd,
      txSignature: result.signature,
      status: 'confirmed',
    });

    logger.info(`[${chain}] ${userId} bought ${symbol} for ${buyAmount} ${meta.currency}`);

    if (this.onTradeEvent) {
      this.onTradeEvent({ type: 'buy', userId, chain, position: pos, signature: result.signature, amount: buyAmount });
    }
    return { ...pos, signature: result.signature, solAmount: buyAmount, chain };
  }

  // -------------------------------------------------------------- sell

  async sellToken(userId, mint, fraction = 1.0) {
    const user = await db.getUser(userId);
    if (!user) throw new Error('Not registered. Send /start first.');

    const positions = await db.getUserPositions(userId, 'open');
    const pos = positions.find(p => p.mint === mint);
    if (!pos) throw new Error('No open position in that token');

    return this._executeSell(pos, user, fraction, 'MANUAL', user.slippage_bps || this.config.trading.slippageBps);
  }

  async _executeSell(pos, user, fraction, reason, slippage) {
    const chain = pos.chain || 'solana';
    const wallet = this._walletFor(user, chain);

    // Raw amounts are exact integers; never round-trip them through a float.
    const heldRaw = BigInt(pos.token_amount_raw || '0');
    if (heldRaw <= 0n) throw new Error('Position has no token balance recorded');

    const sellRaw = fraction >= 0.999
      ? heldRaw
      : (heldRaw * BigInt(Math.round(fraction * 10000))) / 10000n;
    if (sellRaw <= 0n) return null;

    const signer = this.wallets.getSigner(pos.user_id, chain, wallet.encrypted);
    const result = await this.swap.sell(chain, signer, pos.mint, sellRaw, slippage);

    const nativeReceived = this.swap.fromRawNative(chain, result.rawOutput ?? result.outputAmount);
    const nativeUsd = await this.swap.getNativePriceUsd(chain);
    const decimals = pos.decimals ?? 9;
    const uiSold = Number(sellRaw) / 10 ** decimals;

    await db.saveTrade(pos.user_id, {
      chain, mint: pos.mint, symbol: pos.symbol, direction: 'sell',
      solAmount: nativeReceived,
      tokenAmount: uiSold,
      tokenAmountRaw: sellRaw.toString(),
      priceSol: uiSold ? nativeReceived / uiSold : 0,
      priceUsd: uiSold ? (nativeReceived / uiSold) * nativeUsd : 0,
      txSignature: result.signature,
      status: 'confirmed',
    });

    const isFullExit = sellRaw >= heldRaw;
    if (isFullExit) {
      const totalReceived = (pos.sol_received || 0) + nativeReceived;
      const pnlNative = totalReceived - pos.sol_invested;
      const pnlPct = (pnlNative / pos.sol_invested) * 100;

      await db.closePosition(pos.id, pos.user_id, totalReceived, pnlNative, pnlPct);
      logger.info(`[${reason}] closed ${pos.symbol}: ${pnlNative >= 0 ? '+' : ''}${pnlNative.toFixed(4)} (${pnlPct.toFixed(1)}%)`);

      if (this.onTradeEvent) {
        this.onTradeEvent({
          type: 'close', reason, userId: pos.user_id, chain, position: pos,
          pnlSol: pnlNative, pnlPct, solReceived: totalReceived, signature: result.signature,
        });
      }
      return { closed: true, pnlSol: pnlNative, pnlPct, signature: result.signature };
    }

    const remainingRaw = heldRaw - sellRaw;
    await db.updatePosition(pos.id, {
      token_amount_raw: remainingRaw.toString(),
      token_amount: Number(remainingRaw) / 10 ** decimals,
      sol_received: (pos.sol_received || 0) + nativeReceived,
    });

    if (this.onTradeEvent) {
      this.onTradeEvent({
        type: 'partial', reason, userId: pos.user_id, chain, position: pos,
        fraction, solReceived: nativeReceived, signature: result.signature,
      });
    }
    return { closed: false, fraction, solReceived: nativeReceived, signature: result.signature };
  }

  // --------------------------------------------------- position monitor

  async checkAllPositions() {
    const positions = await db.getAllOpenPositions();
    if (!positions.length) return;

    // Cache native prices once per sweep instead of per position.
    const nativePrices = {};
    for (const chain of this.swap.chains()) {
      nativePrices[chain] = await this.swap.getNativePriceUsd(chain).catch(() => null);
    }

    for (const pos of positions) {
      try {
        await this._checkPosition(pos, nativePrices);
      } catch (err) {
        logger.error(`[monitor] ${pos.symbol} (${pos.chain}): ${err.message}`);
      }
    }
  }

  async _checkPosition(pos, nativePrices) {
    const chain = pos.chain || 'solana';
    const priceUsd = await this.swap.getPrice(chain, pos.mint);
    if (priceUsd == null) return;

    const nativeUsd = nativePrices[chain];
    if (!nativeUsd) return;

    const priceNative = priceUsd / nativeUsd;
    if (!pos.entry_price_sol) return;

    const multiple = priceNative / pos.entry_price_sol;
    const decimals = pos.decimals ?? 9;
    const uiHeld = Number(BigInt(pos.token_amount_raw || '0')) / 10 ** decimals;
    const currentValue = uiHeld * priceNative;
    const pnlNative = currentValue + (pos.sol_received || 0) - pos.sol_invested;
    const pnlPct = (pnlNative / pos.sol_invested) * 100;

    await db.updatePosition(pos.id, {
      current_price_sol: priceNative,
      current_mc: multiple,
      peak_mc: Math.max(pos.peak_mc || 0, multiple),
      pnl_sol: pnlNative,
      pnl_pct: pnlPct,
    });

    const user = await db.getUser(pos.user_id);
    if (!user?.auto_sell) return;

    const slippage = user.slippage_bps || this.config.trading.slippageBps;
    const fresh = { ...pos, token_amount_raw: pos.token_amount_raw, sol_received: pos.sol_received };

    if (multiple >= this.tp3x && !pos.tp3_hit) {
      await db.updatePosition(pos.id, { tp3_hit: true });
      await this._executeSell(fresh, user, 1.0, 'TP3', slippage);
    } else if (multiple >= this.tp2x && !pos.tp2_hit) {
      await db.updatePosition(pos.id, { tp2_hit: true });
      await this._executeSell(fresh, user, 0.3, 'TP2', slippage);
    } else if (multiple >= this.tp1x && !pos.tp1_hit) {
      await db.updatePosition(pos.id, { tp1_hit: true });
      await this._executeSell(fresh, user, 0.3, 'TP1', slippage);
    } else if (pnlPct <= this.slPct) {
      await this._executeSell(fresh, user, 1.0, 'SL', slippage);
    }
  }
}

module.exports = TradeEngine;
