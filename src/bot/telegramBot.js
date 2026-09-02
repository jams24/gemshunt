const { Telegraf, Markup } = require('telegraf');
const logger = require('../utils/logger');
const db = require('../db/database');
const CHAINS = require('../services/chains');
const { generateTradeCard, generateMonthlyCard, formatHoldTime } = require('../services/pnlCard');

const FEE_PCT = parseFloat(process.env.PLATFORM_FEE_PCT) || 1.0;
const REFERRAL_FEE_SHARE = parseFloat(process.env.REFERRAL_FEE_SHARE) || 0.25;

class TelegramBot {
  constructor(tradeEngine, walletManager) {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.engine = tradeEngine;
    this.walletManager = walletManager;
    this.adminId = parseInt(process.env.TELEGRAM_ADMIN_ID);
    this.pendingImport = new Map();
    this.setupMiddleware();
    this.setupCommands();
    this.setupCallbacks();
    this.hookTradeEvents();
  }

  setupMiddleware() {
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return;
      await db.getOrCreateUser(ctx.from.id, ctx.from.username);
      return next();
    });
  }

  // === HELPERS ===
  _chainInfo(user) {
    const chain = user.active_chain || 'solana';
    return { chain, ...CHAINS[chain] };
  }

  _mainKeyboard(chain) {
    const c = CHAINS[chain] || CHAINS.solana;
    return Markup.keyboard([
      [`👛 Wallet`, `📊 Positions`],
      [`💰 PnL`, `🎴 Card`],
      [`🔗 ${c.name}`, `📋 Menu`],
    ]).resize();
  }

  _chainSwitchButtons(currentChain) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          `${currentChain === 'solana' ? '✅' : '⬜'} ◎ Solana`,
          'chain_solana'
        ),
        Markup.button.callback(
          `${currentChain === 'robinhood' ? '✅' : '⬜'} 🪶 Robinhood`,
          'chain_robinhood'
        ),
      ],
    ]);
  }

  _walletButtons(user) {
    const chain = user.active_chain || 'solana';
    const hasWallet = chain === 'solana' ? user.sol_wallet_address : user.evm_wallet_address;
    if (hasWallet) {
      return Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'refresh_balance'), Markup.button.callback('📤 Withdraw', 'withdraw_prompt')],
        [Markup.button.callback('🔑 Export Key', 'export_key'), Markup.button.callback('🔗 Switch Chain', 'switch_chain')],
      ]);
    }
    return Markup.inlineKeyboard([
      [Markup.button.callback('🆕 Create Wallet', 'wallet_create')],
      [Markup.button.callback('📥 Import Wallet', 'wallet_import')],
      [Markup.button.callback('🔗 Switch Chain', 'switch_chain')],
    ]);
  }

  _sellButtons(mint) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('25%', `qsell_${mint}_25`),
        Markup.button.callback('50%', `qsell_${mint}_50`),
        Markup.button.callback('75%', `qsell_${mint}_75`),
        Markup.button.callback('100%', `qsell_${mint}_100`),
      ],
    ]);
  }

  _buyAmountButtons(mint) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('0.05', `qbuy_${mint}_0.05`),
        Markup.button.callback('0.1', `qbuy_${mint}_0.1`),
        Markup.button.callback('0.5', `qbuy_${mint}_0.5`),
        Markup.button.callback('1.0', `qbuy_${mint}_1`),
      ],
      [Markup.button.callback('Custom Amount', `qbuy_${mint}_custom`)],
    ]);
  }

  setupCommands() {
    // === START ===
    this.bot.command('start', async (ctx) => {
      const args = ctx.message.text.split(' ');
      if (args[1]?.startsWith('ref_')) {
        const refId = parseInt(args[1].replace('ref_', ''));
        if (refId && refId !== ctx.from.id) {
          await db.updateUser(ctx.from.id, { referrer_id: refId });
        }
      }

      const user = await db.getUser(ctx.from.id);
      const info = this._chainInfo(user);
      const hasWallet = info.chain === 'solana' ? user.sol_wallet_address : user.evm_wallet_address;

      if (hasWallet) {
        const walletAddr = info.chain === 'solana' ? user.sol_wallet_address : user.evm_wallet_address;
        const bal = info.chain === 'solana'
          ? await this.walletManager.getSolanaBalance(walletAddr)
          : await this.engine.robinhoodSwap.getBalance(walletAddr);

        return ctx.replyWithHTML(
          `<b>⚡ SolSniper</b>\n\n` +
          `Chain: <b>${info.emoji} ${info.name}</b>\n` +
          `Wallet: <code>${walletAddr}</code>\n` +
          `Balance: <b>${bal.toFixed(4)} ${info.currency}</b>\n\n` +
          `Paste a token address to buy instantly.\nOr use /menu for all commands.`,
          this._mainKeyboard(info.chain)
        );
      }

      ctx.replyWithHTML(
        `<b>⚡ SolSniper</b>\n\n` +
        `The fastest multi-chain token sniper.\n` +
        `◎ <b>Solana</b> + 🪶 <b>Robinhood Chain</b>\n\n` +
        `${FEE_PCT}% fee per trade. That's it.\n\n` +
        `Select your chain:`,
        Markup.inlineKeyboard([
          [Markup.button.callback('◎ Solana', 'onboard_solana')],
          [Markup.button.callback('🪶 Robinhood Chain', 'onboard_robinhood')],
        ])
      );
    });

    this.bot.command('menu', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      const info = this._chainInfo(user);
      ctx.replyWithHTML(
        `<b>📋 SolSniper — ${info.emoji} ${info.name}</b>\n\n` +
        `<b>Trade:</b>\n` +
        `• Paste token address to buy\n` +
        `/buy <code>address</code> [amount] — Buy\n` +
        `/sell <code>address</code> [%] — Sell\n` +
        `/sellall — Close all\n\n` +
        `<b>Portfolio:</b>\n` +
        `/positions — Open positions\n` +
        `/pnl — History | /stats — Stats\n` +
        `/card — Monthly PnL card\n\n` +
        `<b>Wallet:</b>\n` +
        `/wallet — Balance & deposit\n` +
        `/withdraw <code>addr</code> <code>amount</code>\n` +
        `/export — Private key\n\n` +
        `<b>Settings:</b>\n` +
        `/chain — Switch chain\n` +
        `/setbuy — Buy amount | /setslippage\n` +
        `/autosell — Toggle TP/SL\n` +
        `/referral — Earn fees\n` +
        `/fees — Fee info`,
        this._mainKeyboard(info.chain)
      );
    });

    // === CHAIN ===
    this.bot.command('chain', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      ctx.replyWithHTML(
        `<b>🔗 Active Chain: ${this._chainInfo(user).emoji} ${this._chainInfo(user).name}</b>\n\nSwitch:`,
        this._chainSwitchButtons(user.active_chain || 'solana')
      );
    });

    // === WALLET ===
    this.bot.command('wallet', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      const info = this._chainInfo(user);
      const walletAddr = info.chain === 'solana' ? user.sol_wallet_address : user.evm_wallet_address;

      if (!walletAddr) {
        return ctx.replyWithHTML(
          `<b>👛 No ${info.name} wallet yet</b>\n\nCreate or import:`,
          this._walletButtons(user)
        );
      }

      const bal = info.chain === 'solana'
        ? await this.walletManager.getSolanaBalance(walletAddr)
        : await this.engine.robinhoodSwap.getBalance(walletAddr);

      ctx.replyWithHTML(
        `<b>👛 ${info.emoji} ${info.name} Wallet</b>\n\n` +
        `Address:\n<code>${walletAddr}</code>\n\n` +
        `Balance: <b>${bal.toFixed(4)} ${info.currency}</b>\n\n` +
        `Send ${info.currency} to this address to start trading.`,
        this._walletButtons(user)
      );
    });

    this.bot.command('withdraw', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      const info = this._chainInfo(user);
      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 2) return ctx.reply(`Usage: /withdraw <address> <${info.currency.toLowerCase()}_amount>`);

      const toAddr = args[0];
      const amount = parseFloat(args[1]);
      if (!amount || amount <= 0) return ctx.reply('Invalid amount.');

      try {
        let sig;
        if (info.chain === 'solana') {
          sig = await this.walletManager.withdrawSolana(user.sol_wallet_key_encrypted, toAddr, amount);
        } else {
          const pk = this.walletManager.getEvmPrivateKey(user.evm_wallet_key_encrypted);
          sig = await this.engine.robinhoodSwap.withdraw(pk, toAddr, amount);
        }
        ctx.replyWithHTML(`✅ <b>Sent ${amount} ${info.currency}</b>\n\nTX: <code>${sig}</code>`);
      } catch (err) {
        ctx.reply(`❌ ${err.message}`);
      }
    });

    this.bot.command('export', async (ctx) => {
      ctx.replyWithHTML(
        `⚠️ <b>WARNING</b>\nThis gives FULL access to your wallet.\nNever share it.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Yes, show key', 'confirm_export')],
          [Markup.button.callback('Cancel', 'cancel_action')],
        ])
      );
    });

    // === TRADING ===
    this.bot.command('buy', async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      if (!args[0]) return ctx.reply('Usage: /buy <token_address> [amount]');
      const mint = args[0];
      const amount = parseFloat(args[1]) || undefined;
      await this._executeBuy(ctx, mint, amount);
    });

    this.bot.command('sell', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      const args = ctx.message.text.split(' ').slice(1);

      if (!args[0]) {
        const positions = await db.getUserPositions(ctx.from.id, 'open');
        if (!positions.length) return ctx.reply('No open positions.');
        const buttons = positions.map(p => [
          Markup.button.callback(
            `${(p.pnl_pct || 0) >= 0 ? '🟢' : '🔴'} ${p.symbol || p.mint.slice(0, 8)} | ${(p.pnl_pct || 0) >= 0 ? '+' : ''}${(p.pnl_pct || 0).toFixed(0)}%`,
            `sellmenu_${p.mint.slice(0, 40)}`
          ),
        ]);
        return ctx.replyWithHTML('<b>Select position to sell:</b>', Markup.inlineKeyboard(buttons));
      }

      const mint = args[0];
      const pct = parseFloat(args[1]) || 100;
      await this._executeSell(ctx, mint, pct);
    });

    this.bot.command('sellall', async (ctx) => {
      const positions = await db.getUserPositions(ctx.from.id, 'open');
      if (!positions.length) return ctx.reply('No open positions.');
      ctx.reply(`Closing ${positions.length} positions...`);
      for (const pos of positions) {
        try { await this.engine.sellToken(ctx.from.id, pos.mint, 1.0); } catch (e) { ctx.reply(`❌ ${pos.symbol}: ${e.message}`); }
      }
      ctx.reply('✅ Done.');
    });

    // === PORTFOLIO ===
    this.bot.command('positions', async (ctx) => {
      const positions = await db.getUserPositions(ctx.from.id, 'open');
      if (!positions.length) return ctx.reply('No open positions.\n\nPaste a token address to buy!');

      let msg = '<b>📊 Positions</b>\n\n';
      for (const p of positions) {
        const c = CHAINS[p.chain || 'solana'];
        const emoji = (p.pnl_pct || 0) >= 0 ? (p.pnl_pct > 50 ? '🟢' : '🔵') : '🔴';
        msg += `${emoji} ${c?.emoji || ''} <b>${p.symbol || p.mint.slice(0, 8)}</b>\n`;
        msg += `  ${(p.pnl_pct || 0) >= 0 ? '+' : ''}${(p.pnl_pct || 0).toFixed(1)}% | ${(p.current_mc || 0).toFixed(1)}x | ${formatHoldTime(p.opened_at)}\n`;
        msg += `  <code>${p.mint}</code>\n\n`;
      }
      ctx.replyWithHTML(msg);
    });

    this.bot.command('pnl', async (ctx) => {
      const closed = await db.getUserClosedPositions(ctx.from.id, 15);
      if (!closed.length) return ctx.reply('No closed trades yet.');
      let msg = '<b>💰 History</b>\n\n';
      let totalPnl = 0;
      for (const p of closed) {
        const c = CHAINS[p.chain || 'solana'];
        const emoji = p.pnl_sol >= 0 ? '🟢' : '🔴';
        msg += `${emoji} ${c?.emoji || ''} <b>${p.symbol || p.mint.slice(0, 6)}</b> ${p.pnl_pct >= 0 ? '+' : ''}${p.pnl_pct.toFixed(0)}% | ${formatHoldTime(p.opened_at, p.closed_at)}\n`;
        totalPnl += p.pnl_sol;
      }
      msg += `\n<b>Total: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)}</b>`;
      ctx.replyWithHTML(msg);
    });

    this.bot.command('stats', async (ctx) => {
      const stats = await db.getUserStats(ctx.from.id);
      if (!stats?.total_trades) return ctx.reply('No trades yet.');
      const wr = stats.total_trades > 0 ? (stats.winning_trades / stats.total_trades * 100) : 0;
      ctx.replyWithHTML(
        `<b>📈 Stats</b>\n\n` +
        `Trades: <b>${stats.total_trades}</b> | WR: <b>${wr.toFixed(0)}%</b>\n` +
        `PnL: <b>${stats.total_pnl_usd >= 0 ? '+' : ''}$${stats.total_pnl_usd.toFixed(2)}</b>\n` +
        `Open: <b>${stats.open_positions}</b>`
      );
    });

    this.bot.command('card', (ctx) => this.sendMonthlyCard(ctx.from.id, ctx));

    // === SETTINGS ===
    this.bot.command('settings', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      const info = this._chainInfo(user);
      ctx.replyWithHTML(
        `<b>⚙️ Settings</b>\n\n` +
        `Chain: <b>${info.emoji} ${info.name}</b>\n` +
        `Buy: <b>${user.max_buy_amount} ${info.currency}</b>\n` +
        `Slippage: <b>${user.slippage_bps} bps</b>\n` +
        `Auto-sell: <b>${user.auto_sell ? 'ON' : 'OFF'}</b>`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('0.05', 'setbuy_0.05'),
            Markup.button.callback('0.1', 'setbuy_0.1'),
            Markup.button.callback('0.5', 'setbuy_0.5'),
            Markup.button.callback('1.0', 'setbuy_1'),
          ],
          [
            Markup.button.callback('Slip 1%', 'setslip_100'),
            Markup.button.callback('5%', 'setslip_500'),
            Markup.button.callback('10%', 'setslip_1000'),
          ],
          [
            Markup.button.callback(`Auto-sell: ${user.auto_sell ? '✅' : '❌'}`, 'toggle_autosell'),
            Markup.button.callback('🔗 Chain', 'switch_chain'),
          ],
        ])
      );
    });

    this.bot.command('setbuy', async (ctx) => {
      const v = parseFloat(ctx.message.text.split(' ')[1]);
      if (!v || v < 0.001 || v > 50) return ctx.reply('Usage: /setbuy <0.001-50>');
      await db.updateUser(ctx.from.id, { max_buy_amount: v });
      ctx.reply(`✅ Buy amount: ${v}`);
    });

    this.bot.command('setslippage', async (ctx) => {
      const v = parseInt(ctx.message.text.split(' ')[1]);
      if (!v || v < 50 || v > 5000) return ctx.reply('Usage: /setslippage <50-5000>');
      await db.updateUser(ctx.from.id, { slippage_bps: v });
      ctx.reply(`✅ Slippage: ${v} bps`);
    });

    this.bot.command('autosell', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      await db.updateUser(ctx.from.id, { auto_sell: !user.auto_sell });
      ctx.reply(`✅ Auto-sell ${!user.auto_sell ? 'ON' : 'OFF'}`);
    });

    this.bot.command('referral', (ctx) => {
      const link = `https://t.me/${this.bot.botInfo?.username || 'SolSniperBot'}?start=ref_${ctx.from.id}`;
      ctx.replyWithHTML(
        `<b>🔗 Referral</b>\n\n<code>${link}</code>\n\n` +
        `Share → earn <b>${(REFERRAL_FEE_SHARE * 100).toFixed(0)}%</b> of their trading fees forever.`
      );
    });

    this.bot.command('fees', (ctx) => {
      ctx.replyWithHTML(
        `<b>💸 Fees</b>\n\n` +
        `${FEE_PCT}% per trade (buy + sell)\n` +
        `Referrals earn ${(REFERRAL_FEE_SHARE * 100)}% of fees.\n` +
        `/referral for your link.`
      );
    });

    this.bot.command('admin', async (ctx) => {
      if (ctx.from.id !== this.adminId) return;
      const { rows: [s] } = await db.query(`
        SELECT (SELECT COUNT(*) FROM users) as users,
        (SELECT COUNT(*) FROM users WHERE sol_wallet_address IS NOT NULL OR evm_wallet_address IS NOT NULL) as wallets,
        (SELECT COUNT(*) FROM positions WHERE status='open') as open_pos,
        (SELECT COUNT(*) FROM trades) as trades,
        (SELECT COALESCE(SUM(fee_amount), 0) FROM fee_ledger) as fees
      `);
      ctx.replyWithHTML(
        `<b>🔧 Admin</b>\n\n` +
        `Users: <b>${s.users}</b> (${s.wallets} wallets)\n` +
        `Open: <b>${s.open_pos}</b> | Trades: <b>${s.trades}</b>\n` +
        `Fees: <b>${parseFloat(s.fees || 0).toFixed(4)}</b>`
      );
    });

    // === PASTE TOKEN ADDRESS TO BUY ===
    this.bot.on('text', async (ctx) => {
      const text = ctx.message.text.trim();

      // Handle wallet import
      if (this.pendingImport.has(ctx.from.id)) {
        return this._handleImport(ctx, text);
      }

      // Detect Solana address (base58, 32-44 chars)
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
        const user = await db.getUser(ctx.from.id);
        if ((user.active_chain || 'solana') === 'solana' && user.sol_wallet_address) {
          return ctx.replyWithHTML(
            `<b>◎ Buy on Solana?</b>\n\n<code>${text}</code>`,
            this._buyAmountButtons(text)
          );
        }
      }

      // Detect EVM address (0x...)
      if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
        const user = await db.getUser(ctx.from.id);
        if ((user.active_chain) === 'robinhood' && user.evm_wallet_address) {
          return ctx.replyWithHTML(
            `<b>🪶 Buy on Robinhood Chain?</b>\n\n<code>${text}</code>`,
            this._buyAmountButtons(text)
          );
        }
      }

      // Keyboard buttons
      if (text === '👛 Wallet') return this.bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/wallet' } });
      if (text === '📊 Positions') return this.bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/positions' } });
      if (text === '💰 PnL') return this.bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/pnl' } });
      if (text === '🎴 Card') return this.bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/card' } });
      if (text === '📋 Menu') return this.bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/menu' } });
      if (text.startsWith('🔗')) return this.bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/chain' } });
      if (text === '⚙️ Settings') return this.bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/settings' } });
    });
  }

  setupCallbacks() {
    // === ONBOARDING ===
    this.bot.action(/onboard_(solana|robinhood)/, async (ctx) => {
      const chain = ctx.match[1];
      await ctx.answerCbQuery();
      await db.updateUser(ctx.from.id, { active_chain: chain });
      const info = CHAINS[chain];
      ctx.editMessageText(
        `<b>${info.emoji} ${info.name} selected!</b>\n\nSet up your wallet:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🆕 Create New Wallet', 'wallet_create')],
            [Markup.button.callback('📥 Import Existing Wallet', 'wallet_import')],
          ]),
        }
      );
    });

    // === CHAIN SWITCH ===
    this.bot.action(/chain_(solana|robinhood)/, async (ctx) => {
      const chain = ctx.match[1];
      await db.updateUser(ctx.from.id, { active_chain: chain });
      const info = CHAINS[chain];
      await ctx.answerCbQuery(`Switched to ${info.name}`);
      ctx.editMessageText(
        `<b>✅ Switched to ${info.emoji} ${info.name}</b>`,
        { parse_mode: 'HTML' }
      );
    });

    this.bot.action('switch_chain', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      await ctx.answerCbQuery();
      ctx.replyWithHTML('<b>🔗 Select chain:</b>', this._chainSwitchButtons(user.active_chain || 'solana'));
    });

    // === WALLET CREATE ===
    this.bot.action('wallet_create', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await db.getUser(ctx.from.id);
      const chain = user.active_chain || 'solana';
      const info = CHAINS[chain];

      let wallet, updates;
      if (chain === 'solana') {
        wallet = this.walletManager.createSolanaWallet();
        updates = {
          sol_wallet_address: wallet.publicKey,
          sol_wallet_key_encrypted: this.walletManager.encrypt(wallet.privateKey),
        };
      } else {
        wallet = this.walletManager.createEvmWallet();
        updates = {
          evm_wallet_address: wallet.publicKey,
          evm_wallet_key_encrypted: this.walletManager.encrypt(wallet.privateKey),
        };
      }
      await db.updateUser(ctx.from.id, updates);

      ctx.replyWithHTML(
        `✅ <b>${info.emoji} ${info.name} Wallet Created!</b>\n\n` +
        `Address:\n<code>${wallet.publicKey}</code>\n\n` +
        `<b>⚠️ SAVE YOUR KEY:</b>\n<tg-spoiler>${wallet.privateKey}</tg-spoiler>\n\n` +
        `Tap to reveal. Store it safely.\n\n` +
        `<b>Next:</b> Send ${info.currency} to this address, then paste a token address to buy.`,
        this._mainKeyboard(chain)
      );
    });

    // === WALLET IMPORT ===
    this.bot.action('wallet_import', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await db.getUser(ctx.from.id);
      this.pendingImport.set(ctx.from.id, user.active_chain || 'solana');
      ctx.replyWithHTML(`📥 <b>Send your private key</b>\n\nIt will be auto-deleted for safety.`);
      setTimeout(() => this.pendingImport.delete(ctx.from.id), 120000);
    });

    // === QUICK BUY ===
    this.bot.action(/qbuy_(.+)_(.+)/, async (ctx) => {
      const mint = ctx.match[1];
      const amountStr = ctx.match[2];
      if (amountStr === 'custom') {
        await ctx.answerCbQuery();
        return ctx.reply(`Send: /buy ${mint} <amount>`);
      }
      await ctx.answerCbQuery('Buying...');
      await this._executeBuy(ctx, mint, parseFloat(amountStr));
    });

    // === QUICK SELL ===
    this.bot.action(/qsell_(.+)_(\d+)/, async (ctx) => {
      const mint = ctx.match[1];
      const pct = parseInt(ctx.match[2]);
      await ctx.answerCbQuery(`Selling ${pct}%...`);
      await this._executeSell(ctx, mint, pct);
    });

    this.bot.action(/sellmenu_(.+)/, async (ctx) => {
      await ctx.answerCbQuery();
      ctx.replyWithHTML(`<b>Sell:</b>`, this._sellButtons(ctx.match[1]));
    });

    // === SETTINGS ===
    this.bot.action(/setbuy_(.+)/, async (ctx) => {
      const v = parseFloat(ctx.match[1]);
      await db.updateUser(ctx.from.id, { max_buy_amount: v });
      await ctx.answerCbQuery(`Buy: ${v}`);
    });
    this.bot.action(/setslip_(\d+)/, async (ctx) => {
      const v = parseInt(ctx.match[1]);
      await db.updateUser(ctx.from.id, { slippage_bps: v });
      await ctx.answerCbQuery(`Slippage: ${v} bps`);
    });
    this.bot.action('toggle_autosell', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      await db.updateUser(ctx.from.id, { auto_sell: !user.auto_sell });
      await ctx.answerCbQuery(`Auto-sell: ${!user.auto_sell ? 'ON' : 'OFF'}`);
    });

    // === WALLET ACTIONS ===
    this.bot.action('refresh_balance', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      const info = this._chainInfo(user);
      const addr = info.chain === 'solana' ? user.sol_wallet_address : user.evm_wallet_address;
      if (!addr) return ctx.answerCbQuery('No wallet');
      const bal = info.chain === 'solana'
        ? await this.walletManager.getSolanaBalance(addr)
        : await this.engine.robinhoodSwap.getBalance(addr);
      await ctx.answerCbQuery(`${bal.toFixed(4)} ${info.currency}`);
    });

    this.bot.action('confirm_export', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      const chain = user.active_chain || 'solana';
      const enc = chain === 'solana' ? user.sol_wallet_key_encrypted : user.evm_wallet_key_encrypted;
      if (!enc) return ctx.answerCbQuery('No wallet');
      await ctx.answerCbQuery();
      const pk = await this.walletManager.exportPrivateKey(enc);
      const msg = await ctx.replyWithHTML(`🔑 <tg-spoiler>${pk}</tg-spoiler>\n\n⚠️ Deletes in 30s.`);
      setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => {}), 30000);
    });

    this.bot.action('cancel_action', (ctx) => { ctx.answerCbQuery('Cancelled'); ctx.deleteMessage().catch(() => {}); });
    this.bot.action('withdraw_prompt', (ctx) => { ctx.answerCbQuery(); ctx.reply('/withdraw <address> <amount>'); });
    this.bot.action('export_key', (ctx) => {
      ctx.answerCbQuery();
      ctx.replyWithHTML('⚠️ <b>Show private key?</b>', Markup.inlineKeyboard([
        [Markup.button.callback('Yes', 'confirm_export'), Markup.button.callback('Cancel', 'cancel_action')],
      ]));
    });
  }

  // === TRADE EXECUTION ===
  async _executeBuy(ctx, mint, amount) {
    const user = await db.getUser(ctx.from.id);
    const info = this._chainInfo(user);
    const buyAmount = amount || user.max_buy_amount || 0.1;
    const fee = buyAmount * (FEE_PCT / 100);

    try {
      await ctx.replyWithHTML(`⏳ <b>Buying on ${info.emoji} ${info.name}...</b>\nAmount: ${buyAmount} ${info.currency} | Fee: ${fee.toFixed(4)}`);
      const result = await this.engine.buyToken(ctx.from.id, mint, buyAmount);

      const txUrl = CHAINS[info.chain].txUrl(result.signature);
      ctx.replyWithHTML(
        `✅ <b>Bought!</b>\n\n` +
        `<code>${mint}</code>\n` +
        `Spent: ${buyAmount} ${info.currency}\n` +
        `<a href="${txUrl}">View TX</a>`,
        this._sellButtons(mint)
      );

      await this._collectFee(user, fee, info.chain);
    } catch (err) {
      ctx.reply(`❌ ${err.message}`);
    }
  }

  async _executeSell(ctx, mint, pct) {
    try {
      const result = await this.engine.sellToken(ctx.from.id, mint, pct / 100);
      if (result.closed) {
        const emoji = result.pnlSol >= 0 ? '🟢' : '🔴';
        ctx.replyWithHTML(`${emoji} <b>Closed!</b> PnL: ${result.pnlSol >= 0 ? '+' : ''}${result.pnlSol.toFixed(4)} (${result.pnlPct.toFixed(1)}%)`);
      } else {
        ctx.replyWithHTML(`✅ Sold ${pct}%`);
      }
    } catch (err) {
      ctx.reply(`❌ ${err.message}`);
    }
  }

  async _handleImport(ctx, key) {
    const chain = this.pendingImport.get(ctx.from.id);
    this.pendingImport.delete(ctx.from.id);
    try { await ctx.deleteMessage(ctx.message.message_id).catch(() => {}); } catch {}

    try {
      let wallet, updates;
      if (chain === 'solana') {
        wallet = this.walletManager.importSolanaWallet(key);
        updates = {
          sol_wallet_address: wallet.publicKey,
          sol_wallet_key_encrypted: this.walletManager.encrypt(key),
        };
      } else {
        wallet = this.walletManager.importEvmWallet(key);
        updates = {
          evm_wallet_address: wallet.publicKey,
          evm_wallet_key_encrypted: this.walletManager.encrypt(key),
        };
      }
      await db.updateUser(ctx.from.id, updates);
      const info = CHAINS[chain];

      ctx.replyWithHTML(
        `✅ <b>${info.emoji} Wallet Imported!</b>\n\n` +
        `<code>${wallet.publicKey}</code>\n\n` +
        `⚠️ Key message deleted.\nPaste a token address to buy!`,
        this._mainKeyboard(chain)
      );
    } catch (err) {
      ctx.reply(`❌ Invalid key: ${err.message}`);
    }
  }

  async _collectFee(user, feeAmount, chain) {
    if (feeAmount <= 0) return;
    try {
      const feeWallet = process.env.FEE_WALLET_ADDRESS;
      if (!feeWallet) return;

      if (chain === 'solana' && user.sol_wallet_key_encrypted) {
        await this.walletManager.withdrawSolana(user.sol_wallet_key_encrypted, feeWallet, feeAmount);
      }
      // For Robinhood chain, fees would go to an EVM fee wallet (TODO: add EVM fee wallet)

      await db.query(
        `INSERT INTO fee_ledger (user_id, fee_amount, referrer_id, referrer_share) VALUES ($1, $2, $3, $4)`,
        [user.telegram_id, feeAmount, user.referrer_id, user.referrer_id ? feeAmount * REFERRAL_FEE_SHARE : 0]
      );
    } catch (err) {
      logger.error(`Fee collection failed: ${err.message}`);
    }
  }

  hookTradeEvents() {
    this.engine.onTradeEvent = async (event) => {
      if (event.type !== 'close') return;
      try {
        const user = await db.getUser(event.userId);
        const cardBuf = generateTradeCard({
          symbol: event.position.symbol || event.position.mint.slice(0, 8),
          name: event.position.mint,
          pnlPct: event.pnlPct,
          pnlSol: event.pnlSol,
          pnlUsd: event.pnlSol * 150,
          solInvested: event.position.sol_invested,
          solReceived: event.solReceived,
          peakMc: event.position.peak_mc,
          holdTime: formatHoldTime(event.position.opened_at, new Date()),
          username: user?.username || 'trader',
        });
        await this.bot.telegram.sendPhoto(event.userId, { source: cardBuf }, {
          caption: `${event.pnlSol >= 0 ? '🟢' : '🔴'} <b>${event.reason}</b> — ${event.position.symbol || event.position.mint.slice(0, 8)}`,
          parse_mode: 'HTML',
        });
      } catch (err) {
        logger.error(`Card send failed: ${err.message}`);
      }
    };
  }

  async sendMonthlyCard(userId, ctx) {
    const user = await db.getUser(userId);
    const closed = await db.getUserClosedPositions(userId, 100);
    const now = new Date();
    const monthTrades = closed.filter(t => new Date(t.closed_at) >= new Date(now.getFullYear(), now.getMonth(), 1));
    if (!monthTrades.length) return ctx.reply('No trades this month.');

    const totalPnl = monthTrades.reduce((s, t) => s + t.pnl_sol, 0);
    const invested = monthTrades.reduce((s, t) => s + t.sol_invested, 0);
    const returned = monthTrades.reduce((s, t) => s + (t.sol_received || 0), 0);
    const winners = monthTrades.filter(t => t.pnl_sol > 0);
    const sorted = [...monthTrades].sort((a, b) => b.pnl_pct - a.pnl_pct);

    const cardBuf = generateMonthlyCard({
      totalPnlSol: totalPnl, totalPnlUsd: totalPnl * 150,
      totalPnlPct: invested > 0 ? (totalPnl / invested) * 100 : 0,
      totalTrades: monthTrades.length, winRate: (winners.length / monthTrades.length) * 100,
      totalInvested: invested, totalReturned: returned,
      bestTrade: sorted[0] ? { symbol: sorted[0].symbol || '?', pnlPct: sorted[0].pnl_pct } : null,
      worstTrade: sorted.at(-1) ? { symbol: sorted.at(-1).symbol || '?', pnlPct: sorted.at(-1).pnl_pct } : null,
      username: user?.username || 'trader',
    });
    await ctx.replyWithPhoto({ source: cardBuf }, {
      caption: `📊 <b>${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</b>`,
      parse_mode: 'HTML',
    });
  }

  async sendAlert(chatId, msg) {
    try { await this.bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' }); } catch (e) { logger.error(`Alert failed: ${e.message}`); }
  }

  async launch() {
    this.bot.launch({ dropPendingUpdates: true });
    // Wait briefly for botInfo to populate
    await new Promise(r => setTimeout(r, 2000));
    logger.info(`Telegram bot started as @${this.bot.botInfo?.username}`);
  }
  stop() { this.bot.stop(); }
}

module.exports = TelegramBot;
