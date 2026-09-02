const logger = require('../utils/logger');
const db = require('../db/database');
const axios = require('axios');

class TradeEngine {
  constructor(jupiterService, walletManager, robinhoodSwap) {
    this.jupiter = jupiterService;
    this.walletManager = walletManager;
    this.robinhoodSwap = robinhoodSwap;
    this.maxPositionsPerUser = parseInt(process.env.MAX_OPEN_POSITIONS) || 5;
    this.defaultBuyAmount = parseFloat(process.env.MAX_BUY_SOL) || 0.1;

    this.tp1x = 2;
    this.tp2x = 5;
    this.tp3x = 10;
    this.slPct = -50;

    this.onTradeEvent = null;
  }

  async buyToken(userId, mint, amount) {
    const user = await db.getUser(userId);
    if (!user) throw new Error('Not registered. /start first.');

    const chain = user.active_chain || 'solana';
    const walletAddr = chain === 'solana' ? user.sol_wallet_address : user.evm_wallet_address;
    const walletEnc = chain === 'solana' ? user.sol_wallet_key_encrypted : user.evm_wallet_key_encrypted;
    if (!walletAddr) throw new Error(`No ${chain} wallet. Use /wallet to create one.`);

    const positions = await db.getUserPositions(userId, 'open');
    if (positions.length >= this.maxPositionsPerUser) throw new Error(`Max ${this.maxPositionsPerUser} positions reached`);
    if (positions.some(p => p.mint === mint)) throw new Error('Already holding this token');

    const buyAmount = amount || user.max_buy_amount || this.defaultBuyAmount;
    const slippage = user.slippage_bps || 500;

    let result;
    if (chain === 'solana') {
      const bal = await this.walletManager.getSolanaBalance(walletAddr);
      if (bal < buyAmount + 0.005) throw new Error(`Low SOL: ${bal.toFixed(4)}. Deposit to:\n\`${walletAddr}\``);

      const keypair = this.walletManager.getCachedSolanaKeypair(userId, walletEnc);
      result = await this.jupiter.buy(keypair, mint, buyAmount, slippage);
    } else {
      const bal = await this.robinhoodSwap.getBalance(walletAddr);
      if (bal < buyAmount + 0.001) throw new Error(`Low ETH: ${bal.toFixed(4)}. Deposit to:\n\`${walletAddr}\``);

      const pk = this.walletManager.getEvmPrivateKey(walletEnc);
      result = await this.robinhoodSwap.buy(pk, mint, buyAmount, slippage / 100);
    }

    const tokenAmount = result.outputAmount;
    const entryPrice = buyAmount / tokenAmount;
    const nativePrice = await this._getNativePrice(chain);

    // Try to get token symbol
    let symbol = 'TOKEN';
    if (chain === 'robinhood') {
      const info = await this.robinhoodSwap.getTokenInfo(mint);
      if (info) symbol = info.symbol;
    }

    const pos = await db.openPosition(userId, {
      mint, symbol, entryPriceSol: entryPrice, entryPriceUsd: entryPrice * nativePrice,
      tokenAmount, solInvested: buyAmount,
    });

    // Update position chain
    await db.updatePosition(pos.id, { chain });

    await db.saveTrade(userId, {
      mint, symbol, direction: 'buy', solAmount: buyAmount, tokenAmount,
      priceSol: entryPrice, priceUsd: entryPrice * nativePrice,
      txSignature: result.signature, status: 'confirmed',
    });

    logger.info(`[${chain}] User ${userId} bought ${symbol} (${mint.slice(0, 8)}...) for ${buyAmount}`);
    return { ...pos, signature: result.signature, solAmount: buyAmount, chain };
  }

  async sellToken(userId, mint, fraction = 1.0) {
    const user = await db.getUser(userId);
    const positions = await db.getUserPositions(userId, 'open');
    const pos = positions.find(p => p.mint === mint);
    if (!pos) throw new Error('No open position');

    const chain = pos.chain || 'solana';
    const walletEnc = chain === 'solana' ? user.sol_wallet_key_encrypted : user.evm_wallet_key_encrypted;
    if (!walletEnc) throw new Error('No wallet');

    const slippage = user.slippage_bps || 500;
    return this._executeSell(pos, user, fraction, 'MANUAL', slippage);
  }

  async _executeSell(pos, user, fraction, reason, slippage = 500) {
    const chain = pos.chain || 'solana';
    const sellAmount = Math.floor(pos.token_amount * fraction);
    if (sellAmount <= 0) return null;

    let result;
    if (chain === 'solana') {
      const keypair = this.walletManager.getCachedSolanaKeypair(pos.user_id, user.sol_wallet_key_encrypted);
      result = await this.jupiter.sell(keypair, pos.mint, sellAmount, slippage);
    } else {
      const pk = this.walletManager.getEvmPrivateKey(user.evm_wallet_key_encrypted);
      result = await this.robinhoodSwap.sell(pk, pos.mint, BigInt(sellAmount), slippage / 100);
    }

    const nativeReceived = chain === 'solana' ? result.outputAmount / 1e9 : result.outputAmount;
    const nativePrice = await this._getNativePrice(chain);

    await db.saveTrade(pos.user_id, {
      mint: pos.mint, symbol: pos.symbol, direction: 'sell',
      solAmount: nativeReceived, tokenAmount: sellAmount,
      priceSol: nativeReceived / sellAmount, priceUsd: (nativeReceived / sellAmount) * nativePrice,
      txSignature: result.signature, status: 'confirmed',
    });

    if (fraction >= 0.99) {
      const totalReceived = pos.sol_received + nativeReceived;
      const pnlNative = totalReceived - pos.sol_invested;
      const pnlPct = (pnlNative / pos.sol_invested) * 100;
      await db.closePosition(pos.id, pos.user_id, totalReceived, pnlNative, pnlPct);
      logger.info(`[${reason}] Closed ${pos.symbol}: ${pnlNative > 0 ? '+' : ''}${pnlNative.toFixed(4)} (${pnlPct.toFixed(1)}%)`);

      if (this.onTradeEvent) {
        this.onTradeEvent({ type: 'close', reason, userId: pos.user_id, position: pos, pnlSol: pnlNative, pnlPct, solReceived: totalReceived });
      }
      return { closed: true, pnlSol: pnlNative, pnlPct, signature: result.signature };
    }

    await db.updatePosition(pos.id, {
      token_amount: pos.token_amount - sellAmount,
      sol_received: pos.sol_received + nativeReceived,
    });
    return { closed: false, fraction, solReceived: nativeReceived, signature: result.signature };
  }

  async checkAllPositions() {
    const positions = await db.getAllOpenPositions();
    if (!positions.length) return;

    for (const pos of positions) {
      try {
        const chain = pos.chain || 'solana';
        const currentPrice = chain === 'solana'
          ? await this.jupiter.getPrice(pos.mint)
          : await this.robinhoodSwap.getPrice(pos.mint);
        if (!currentPrice) continue;

        const nativePrice = await this._getNativePrice(chain);
        const currentPriceNative = currentPrice / nativePrice;
        const pnlPct = ((currentPriceNative - pos.entry_price_sol) / pos.entry_price_sol) * 100;
        const currentValue = pos.token_amount * currentPriceNative;
        const pnlNative = currentValue - pos.sol_invested + pos.sol_received;
        const mcMultiple = currentPriceNative / pos.entry_price_sol;
        const peakMc = Math.max(pos.peak_mc || 0, mcMultiple);

        await db.updatePosition(pos.id, {
          current_price_sol: currentPriceNative, current_mc: mcMultiple,
          peak_mc: peakMc, pnl_sol: pnlNative, pnl_pct: pnlPct,
        });

        const user = await db.getUser(pos.user_id);
        if (!user?.auto_sell) continue;

        const slippage = user.slippage_bps || 500;

        if (mcMultiple >= this.tp3x && !pos.tp3_hit) {
          await db.updatePosition(pos.id, { tp3_hit: true });
          await this._executeSell(pos, user, 1.0, 'TP3', slippage);
        } else if (mcMultiple >= this.tp2x && !pos.tp2_hit) {
          await db.updatePosition(pos.id, { tp2_hit: true });
          await this._executeSell(pos, user, 0.3, 'TP2', slippage);
        } else if (mcMultiple >= this.tp1x && !pos.tp1_hit) {
          await db.updatePosition(pos.id, { tp1_hit: true });
          await this._executeSell(pos, user, 0.3, 'TP1', slippage);
        } else if (pnlPct <= this.slPct) {
          await this._executeSell(pos, user, 1.0, 'SL', slippage);
        }
      } catch (err) {
        logger.error(`Check failed ${pos.symbol}: ${err.message}`);
      }
    }
  }

  async _getNativePrice(chain) {
    try {
      const id = chain === 'solana' ? 'solana' : 'ethereum';
      const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, { timeout: 5000 });
      return res.data[id].usd;
    } catch {
      return chain === 'solana' ? 150 : 2500;
    }
  }
}

module.exports = TradeEngine;
