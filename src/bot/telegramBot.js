const { Telegraf, Markup } = require('telegraf');
const logger = require('../utils/logger');
const db = require('../db/database');
const CHAINS = require('../services/chains');
const { generateTradeCard, generateMonthlyCard, formatHoldTime } = require('../services/pnlCard');
const { renderAlert, money, scoreBar, scoreEmoji } = require('../analysis/thesis');

const REFERRAL_FEE_SHARE = parseFloat(process.env.REFERRAL_FEE_SHARE) || 0.25;

class TelegramBot {
  constructor({ tradeEngine, walletManager, swapRouter, analyzer, tracker, config }) {
    this.bot = new Telegraf(config.telegram.token);
    this.engine = tradeEngine;
    this.walletManager = walletManager;
    this.swap = swapRouter;
    this.analyzer = analyzer;
    this.tracker = tracker;
    this.config = config;
    this.feePct = config.trading.platformFeePct;
    this.adminId = config.telegram.adminId;
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
    const hasAny = user.sol_wallet_address || user.evm_wallet_address;
    const missing = [];
    if (!user.sol_wallet_address) missing.push('solana');
    if (!user.evm_wallet_address) missing.push('robinhood');

    if (hasAny) {
      const rows = [
        [Markup.button.callback('🔄 Refresh', 'wallet_refresh'), Markup.button.callback('📤 Withdraw', 'withdraw_prompt')],
        [Markup.button.callback('🔑 Export Key', 'export_key'), Markup.button.callback('🔗 Switch Chain', 'switch_chain')],
      ];
      if (missing.length) {
        rows.unshift([Markup.button.callback(
          `🆕 Create missing wallet${missing.length > 1 ? 's' : ''}`, 'wallet_create'
        )]);
      }
      return Markup.inlineKeyboard(rows);
    }
    return Markup.inlineKeyboard([
      [Markup.button.callback('🆕 Create Wallets (all chains)', 'wallet_create')],
      [Markup.button.callback('📥 Import Wallet', 'wallet_import')],
    ]);
  }

  /**
   * Portfolio across every chain in one message: native balance, USD value,
   * held tokens, and open positions — so a user never has to switch chain
   * just to find out what they own.
   */
  async _renderPortfolio(user) {
    const portfolio = await this.walletManager.getPortfolio(
      user, (chain) => this.swap.getNativePriceUsd(chain)
    );
    const positions = await db.getUserPositions(user.telegram_id, 'open');
    const active = user.active_chain || 'solana';

    const lines = ['<b>👛 Portfolio</b>'];
    if (portfolio.totalUsd > 0) lines.push(`Total: <b>${money(portfolio.totalUsd)}</b>`);
    lines.push('');

    for (const c of portfolio.chains) {
      const meta = c.meta;
      lines.push(`${meta.emoji} <b>${meta.name}</b>${c.chain === active ? ' · <i>active</i>' : ''}`);

      if (!c.address) {
        lines.push('  <i>no wallet — tap Create below</i>', '');
        continue;
      }
      lines.push(`  <code>${c.address}</code>`);

      if (c.error) {
        lines.push(`  ⚠️ <i>unavailable: ${c.error.slice(0, 60)}</i>`, '');
        continue;
      }

      const usd = c.nativeUsd != null ? ` (${money(c.nativeUsd)})` : '';
      lines.push(`  <b>${c.native.toFixed(4)} ${meta.currency}</b>${usd}`);

      const chainPositions = positions.filter(p => (p.chain || 'solana') === c.chain);
      for (const p of chainPositions) {
        const pnl = p.pnl_pct || 0;
        lines.push(`  ${pnl >= 0 ? '🟢' : '🔴'} ${p.symbol || p.mint.slice(0, 6)} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`);
      }

      // Tokens held but not tracked as a position (airdrops, manual buys).
      const tracked = new Set(chainPositions.map(p => p.mint.toLowerCase()));
      const untracked = (c.tokens || []).filter(t => !tracked.has(t.mint.toLowerCase()));
      if (untracked.length) {
        const preview = untracked.slice(0, 3)
          .map(t => `${t.symbol || t.mint.slice(0, 5)} ${t.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
          .join(', ');
        const more = untracked.length > 3 ? ` +${untracked.length - 3} more` : '';
        lines.push(`  <i>Untracked: ${preview}${more}</i>`);
      }
      lines.push('');
    }

    lines.push('<i>Deposit to any address above to trade on that chain.</i>');
    return lines.join('\n');
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
        const bal = await this.walletManager.getBalance(info.chain, walletAddr);

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
        `${this.feePct}% fee per trade. That's it.\n\n` +
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
        `<b>Alerts & Research:</b>\n` +
        `/alerts — Alert settings\n` +
        `/scan <code>address</code> — Analyze a token\n` +
        `/watch <code>wallet</code> — Track smart money\n` +
        `/watchlist — Tracked wallets\n` +
        `/analytics — Thesis engine hit rate\n\n` +
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
    // One screen for every chain — no drilling down, no /chain switch first.
    this.bot.command('wallet', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      if (!user.sol_wallet_address && !user.evm_wallet_address) {
        return ctx.replyWithHTML(
          `<b>👛 No wallets yet</b>\n\nCreate one for every chain in a single tap:`,
          this._walletButtons(user)
        );
      }
      const loading = await ctx.reply('👛 Loading portfolio...');
      const text = await this._renderPortfolio(user);
      await ctx.telegram.editMessageText(
        ctx.chat.id, loading.message_id, undefined, text,
        { parse_mode: 'HTML', disable_web_page_preview: true, ...this._walletButtons(user) }
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

      const enc = info.chain === 'solana' ? user.sol_wallet_key_encrypted : user.evm_wallet_key_encrypted;
      try {
        const sig = await this.walletManager.withdrawNative(info.chain, enc, toAddr, amount);
        ctx.replyWithHTML(
          `✅ <b>Sent ${amount} ${info.currency}</b>\n\n<a href="${CHAINS[info.chain].txUrl(sig)}">View TX</a>`
        );
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
        `${this.feePct}% per trade (buy + sell)\n` +
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

    // === ALERTS ===
    this.bot.command('alerts', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      ctx.replyWithHTML(this._renderAlertSettings(user), this._alertButtons(user));
    });

    this.bot.command('setscore', async (ctx) => {
      const v = parseInt(ctx.message.text.split(' ')[1], 10);
      if (!Number.isInteger(v) || v < 0 || v > 100) {
        return ctx.reply('Usage: /setscore <0-100>  — minimum conviction score to alert you');
      }
      await db.updateUser(ctx.from.id, { alert_min_score: v });
      ctx.reply(`✅ You'll only be alerted on tokens scoring ${v}+`);
    });

    // === ON-DEMAND ANALYSIS ===
    this.bot.command('scan', async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      if (!args[0]) return ctx.reply('Usage: /scan <token_address>');
      await this._sendAnalysis(ctx, args[0]);
    });

    // === SMART MONEY WATCHLIST ===
    this.bot.command('watch', async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      if (!args[0]) return ctx.reply('Usage: /watch <wallet_address> [label]');
      const address = args[0];
      const label = args.slice(1).join(' ') || null;

      const chain = this.walletManager.isValidAddress('solana', address) ? 'solana'
        : this.walletManager.isValidAddress('robinhood', address) ? 'robinhood'
        : null;
      if (!chain) return ctx.reply('❌ Not a valid Solana or EVM address.');
      if (chain === 'robinhood') {
        return ctx.reply('⚠️ Wallet tracking is Solana-only for now — Robinhood Chain has no indexer to read historic wallet activity from.');
      }

      const wallet = await db.addWatchedWallet(chain, address, label, ctx.from.id);
      await this.tracker?.watchWallet(wallet);
      ctx.replyWithHTML(
        `🧠 <b>Now tracking</b>\n<code>${address}</code>\n` +
        `${label ? `Label: ${label}\n` : ''}\n` +
        `You'll get a priority alert when 2+ tracked wallets buy the same token.`
      );
    });

    this.bot.command('unwatch', async (ctx) => {
      const address = ctx.message.text.split(' ')[1];
      if (!address) return ctx.reply('Usage: /unwatch <wallet_address>');
      await db.removeWatchedWallet('solana', address);
      this.tracker?.unwatchWallet(address);
      ctx.reply('✅ Stopped tracking that wallet.');
    });

    this.bot.command('watchlist', async (ctx) => {
      const wallets = await db.getWatchedWallets();
      if (!wallets.length) {
        return ctx.replyWithHTML('No wallets tracked yet.\n\nAdd one: <code>/watch &lt;address&gt; [label]</code>');
      }
      const lines = wallets.map(w =>
        `${CHAINS[w.chain]?.emoji || ''} <b>${w.label || w.address.slice(0, 8) + '…'}</b>\n  <code>${w.address}</code>`
      );
      ctx.replyWithHTML(`<b>🧠 Tracked wallets (${wallets.length})</b>\n\n${lines.join('\n')}`);
    });

    // === ANALYTICS ===
    this.bot.command('analytics', async (ctx) => {
      const bands = await db.getScoreBandPerformance();
      if (!bands.length) {
        return ctx.reply('Not enough tracked tokens yet — analytics appear once alerted tokens have run their 24h tracking window.');
      }
      const lines = ['<b>📈 Thesis engine performance</b>', '<i>Peak multiple reached after alert</i>', ''];
      for (const b of bands) {
        const rate2x = b.total ? ((b.hit_2x / b.total) * 100).toFixed(0) : '0';
        const rugRate = b.total ? ((b.rugs / b.total) * 100).toFixed(0) : '0';
        lines.push(
          `<b>Score ${b.band}</b> — ${b.total} tokens\n` +
          `  2x+: ${rate2x}%  ·  5x+: ${b.total ? ((b.hit_5x / b.total) * 100).toFixed(0) : 0}%  ·  rugs: ${rugRate}%\n` +
          `  avg peak: ${b.avg_peak || '—'}x`
        );
      }
      lines.push('', '<i>If the high bands don\'t beat the low ones, the scoring weights need tuning.</i>');
      ctx.replyWithHTML(lines.join('\n'));
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
    // Create every missing chain at once. A user who only has a Solana wallet
    // and then taps a Robinhood alert should not hit "no wallet" mid-trade.
    this.bot.action('wallet_create', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await db.getUser(ctx.from.id);

      const created = [];
      const updates = {};
      if (!user.sol_wallet_address) {
        const w = this.walletManager.createWallet('solana');
        updates.sol_wallet_address = w.publicKey;
        updates.sol_wallet_key_encrypted = w.encrypted;
        created.push({ chain: 'solana', ...w });
      }
      if (!user.evm_wallet_address) {
        const w = this.walletManager.createWallet('robinhood');
        updates.evm_wallet_address = w.publicKey;
        updates.evm_wallet_key_encrypted = w.encrypted;
        created.push({ chain: 'robinhood', ...w });
      }

      if (!created.length) return ctx.reply('You already have a wallet on every chain.');
      await db.updateUser(ctx.from.id, updates);
      this.walletManager.forget(ctx.from.id);

      const blocks = created.map(w => {
        const meta = CHAINS[w.chain];
        return `${meta.emoji} <b>${meta.name}</b>\n` +
               `<code>${w.publicKey}</code>\n` +
               `Key: <tg-spoiler>${w.privateKey}</tg-spoiler>`;
      });

      ctx.replyWithHTML(
        `✅ <b>Wallet${created.length > 1 ? 's' : ''} created</b>\n\n` +
        blocks.join('\n\n') +
        `\n\n<b>⚠️ Save those keys now.</b> Tap to reveal — they are shown once ` +
        `and we cannot recover them for you.\n\n` +
        `Deposit, then paste any token address to buy.`,
        this._mainKeyboard(user.active_chain || 'solana')
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
    this.bot.action('wallet_refresh', async (ctx) => {
      await ctx.answerCbQuery('Refreshing...');
      const user = await db.getUser(ctx.from.id);
      try {
        const text = await this._renderPortfolio(user);
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...this._walletButtons(user),
        });
      } catch (err) {
        // Telegram rejects an edit when the text is byte-identical.
        if (!/message is not modified/i.test(err.message)) {
          ctx.reply(`❌ ${err.message}`);
        }
      }
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
    // === ALERT CALLBACKS ===
    this.bot.action('alerts_toggle', async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      const next = !user.alerts_enabled;
      await db.updateUser(ctx.from.id, { alerts_enabled: next });
      await ctx.answerCbQuery(next ? 'Alerts ON' : 'Alerts OFF');
      const fresh = await db.getUser(ctx.from.id);
      await ctx.editMessageText(this._renderAlertSettings(fresh), {
        parse_mode: 'HTML', ...this._alertButtons(fresh),
      }).catch(() => {});
    });

    this.bot.action('alerts_off', async (ctx) => {
      await db.updateUser(ctx.from.id, { alerts_enabled: false });
      await ctx.answerCbQuery('Alerts muted. Re-enable with /alerts');
    });

    this.bot.action(/alertscore_(\d+)/, async (ctx) => {
      const v = parseInt(ctx.match[1], 10);
      await db.updateUser(ctx.from.id, { alert_min_score: v });
      await ctx.answerCbQuery(`Min score: ${v}`);
      const fresh = await db.getUser(ctx.from.id);
      await ctx.editMessageText(this._renderAlertSettings(fresh), {
        parse_mode: 'HTML', ...this._alertButtons(fresh),
      }).catch(() => {});
    });

    this.bot.action(/alertchain_(\w+)/, async (ctx) => {
      const chain = ctx.match[1];
      const user = await db.getUser(ctx.from.id);
      const current = new Set((user.alert_chains || 'solana,robinhood').split(',').filter(Boolean));
      if (current.has(chain)) current.delete(chain); else current.add(chain);
      await db.updateUser(ctx.from.id, { alert_chains: [...current].join(',') });
      await ctx.answerCbQuery(`${CHAINS[chain].name}: ${current.has(chain) ? 'on' : 'off'}`);
      const fresh = await db.getUser(ctx.from.id);
      await ctx.editMessageText(this._renderAlertSettings(fresh), {
        parse_mode: 'HTML', ...this._alertButtons(fresh),
      }).catch(() => {});
    });

    // Buy straight from an alert. The chain rides in the callback data, so
    // there is no "switch chain first" step between seeing a call and taking it.
    this.bot.action(/abuy_(\w+)_([^_]+)_([\d.]+)/, async (ctx) => {
      const [, chain, mint, amountStr] = ctx.match;
      await ctx.answerCbQuery(`Buying ${amountStr} on ${CHAINS[chain]?.name || chain}...`);
      await this._executeBuy(ctx, mint, parseFloat(amountStr), chain);
    });

    this.bot.action(/analyze_(\w+)_(.+)/, async (ctx) => {
      await ctx.answerCbQuery();
      await this._sendAnalysis(ctx, ctx.match[2], ctx.match[1]);
    });

    this.bot.action('export_key', (ctx) => {
      ctx.answerCbQuery();
      ctx.replyWithHTML('⚠️ <b>Show private key?</b>', Markup.inlineKeyboard([
        [Markup.button.callback('Yes', 'confirm_export'), Markup.button.callback('Cancel', 'cancel_action')],
      ]));
    });
  }

  // === ALERT SETTINGS ===
  _renderAlertSettings(user) {
    const chains = (user.alert_chains || 'solana,robinhood').split(',');
    const chainLabels = Object.entries(CHAINS)
      .map(([k, c]) => `${chains.includes(k) ? '✅' : '⬜'} ${c.emoji} ${c.name}`)
      .join('\n  ');

    return [
      `<b>🔔 Alert settings</b>`,
      '',
      `Status: <b>${user.alerts_enabled ? 'ON' : 'OFF'}</b>`,
      `Min score: <b>${user.alert_min_score ?? 60}</b>/100`,
      `Min liquidity: <b>${user.alert_min_liquidity ?? 5}</b> (native)`,
      `Chains:\n  ${chainLabels}`,
      '',
      `<i>Only tokens the thesis engine scores at or above your minimum are sent. Raise it for fewer, higher-conviction calls.</i>`,
    ].join('\n');
  }

  _alertButtons(user) {
    const score = user.alert_min_score ?? 60;
    return Markup.inlineKeyboard([
      [Markup.button.callback(user.alerts_enabled ? '🔕 Turn OFF' : '🔔 Turn ON', 'alerts_toggle')],
      [40, 60, 75, 85].map(v =>
        Markup.button.callback(`${score === v ? '•' : ''}${v}`, `alertscore_${v}`)
      ),
      Object.entries(CHAINS).map(([k, c]) =>
        Markup.button.callback(`${c.emoji} ${c.name}`, `alertchain_${k}`)
      ),
    ]);
  }

  /** Run the thesis engine on demand and reply with the full breakdown. */
  async _sendAnalysis(ctx, mint, chainHint) {
    const user = await db.getUser(ctx.from.id);
    const chain = chainHint
      || (this.walletManager.isValidAddress('solana', mint) ? 'solana' : 'robinhood');

    const msg = await ctx.reply('🔬 Analyzing...');
    try {
      const stored = await db.getToken(chain, mint);
      const { token, analysis } = await this.analyzer.analyze({
        chain, mint,
        deployer: stored?.deployer,
        liquidityNative: stored?.liquidity_sol,
        symbol: stored?.symbol,
      });

      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        renderAlert(token, analysis),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [0.05, 0.1, 0.5, 1].map(a => ({
                text: `Buy ${a}`,
                callback_data: `abuy_${chain}_${mint}_${a}`,
              })),
            ],
          },
        }
      );
    } catch (err) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined, `❌ Analysis failed: ${err.message}`
      );
    }
  }

  // === TRADE EXECUTION ===
  async _executeBuy(ctx, mint, amount, chainOverride) {
    const user = await db.getUser(ctx.from.id);
    const chain = chainOverride || user.active_chain || 'solana';
    const meta = CHAINS[chain];
    const buyAmount = amount || user.max_buy_amount || this.config.trading.maxBuyNative;
    const fee = buyAmount * (this.feePct / 100);

    try {
      await ctx.replyWithHTML(
        `⏳ <b>Buying on ${meta.emoji} ${meta.name}...</b>\n` +
        `Amount: ${buyAmount} ${meta.currency} | Fee: ${fee.toFixed(4)}`
      );
      const result = await this.engine.buyToken(ctx.from.id, mint, buyAmount, chain);

      ctx.replyWithHTML(
        `✅ <b>Bought ${result.symbol || ''}</b>\n\n` +
        `<code>${mint}</code>\n` +
        `Spent: ${buyAmount} ${meta.currency}\n` +
        `<a href="${meta.txUrl(result.signature)}">View TX</a>`,
        this._sellButtons(mint)
      );

      await this._collectFee(user, fee, chain);
    } catch (err) {
      ctx.replyWithHTML(`❌ ${err.message}`);
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
      const wallet = this.walletManager.importWallet(chain, key);
      const updates = chain === 'solana'
        ? { sol_wallet_address: wallet.publicKey, sol_wallet_key_encrypted: wallet.encrypted }
        : { evm_wallet_address: wallet.publicKey, evm_wallet_key_encrypted: wallet.encrypted };
      await db.updateUser(ctx.from.id, updates);
      // Drop any signer cached under the old key for this user.
      this.walletManager.forget(ctx.from.id);
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

      const enc = chain === 'solana' ? user.sol_wallet_key_encrypted : user.evm_wallet_key_encrypted;
      if (!enc) return;
      // Fee wallets are per-chain: an EVM address cannot receive SOL.
      const chainFeeWallet = chain === 'solana'
        ? (process.env.FEE_WALLET_ADDRESS_SOL || feeWallet)
        : (process.env.FEE_WALLET_ADDRESS_EVM || null);
      if (!chainFeeWallet || !this.walletManager.isValidAddress(chain, chainFeeWallet)) {
        logger.warn(`[fee] no valid ${chain} fee wallet configured — logging fee only`);
      } else {
        await this.walletManager.withdrawNative(chain, enc, chainFeeWallet, feeAmount);
      }

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
        const nativeUsd = await this.swap.getNativePriceUsd(event.chain || 'solana').catch(() => 0);
        const cardBuf = generateTradeCard({
          symbol: event.position.symbol || event.position.mint.slice(0, 8),
          name: event.position.mint,
          pnlPct: event.pnlPct,
          pnlSol: event.pnlSol,
          pnlUsd: event.pnlSol * nativeUsd,
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
    const nativeUsd = await this.swap.getNativePriceUsd('solana').catch(() => 0);

    const cardBuf = generateMonthlyCard({
      totalPnlSol: totalPnl, totalPnlUsd: totalPnl * nativeUsd,
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

  async sendAlert(chatId, msg, extra = {}) {
    try {
      await this.bot.telegram.sendMessage(chatId, msg, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
      });
    } catch (e) {
      // 403 means the user blocked the bot — stop alerting them rather than
      // retrying forever on every launch.
      if (e.response?.error_code === 403) {
        await db.updateUser(chatId, { alerts_enabled: false }).catch(() => {});
        logger.warn(`[alert] ${chatId} blocked the bot — alerts disabled`);
      } else {
        logger.error(`Alert failed for ${chatId}: ${e.message}`);
      }
    }
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
