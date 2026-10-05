const { Telegraf, Markup } = require('telegraf');
const logger = require('../utils/logger');
const db = require('../db/database');
const CHAINS = require('../services/chains');
const { generateTradeCard, generateMonthlyCard, formatHoldTime } = require('../services/pnlCard');
const { renderAlert, money, esc } = require('../analysis/thesis');
const { withTimeout, sleep } = require('../utils/async');
const panels = require('./panels');

const REFERRAL_FEE_SHARE = parseFloat(process.env.REFERRAL_FEE_SHARE) || 0.25;

class TelegramBot {
  constructor({ tradeEngine, walletManager, swapRouter, analyzer, tracker, config }) {
    // Handlers are detached (see setupMiddleware), so this timeout no longer
    // gates the polling loop; it only bounds a single runaway handler.
    this.bot = new Telegraf(config.telegram.token, { handlerTimeout: 10 * 60 * 1000 });
    this.engine = tradeEngine;
    this.walletManager = walletManager;
    this.swap = swapRouter;
    this.analyzer = analyzer;
    this.tracker = tracker;
    this.config = config;
    this.feePct = config.trading.platformFeePct;
    this.adminId = config.telegram.adminId;
    this.pendingImport = new Map();
    this.scanner = null;
    this.health = null;
    this._stopping = false;
    this._sellFailNotified = new Map();
    this.setupMiddleware();
    this.setupCommands();
    this.setupCallbacks();
    this.hookTradeEvents();
  }

  /** Late-bound services the bot reports on but does not own. */
  attach({ scanner, health }) {
    this.scanner = scanner;
    this.health = health;
  }

  setupMiddleware() {
    // Detach every update from Telegraf's polling loop.
    //
    // Telegraf fetches updates in batches and awaits ALL handlers in a batch
    // before fetching the next. One user's 30-second buy therefore froze the
    // bot for everyone, and a handler that passed the 90s handlerTimeout threw
    // a TimeoutError that — with no bot.catch — ended polling for good. The
    // process kept running and alerting, but never answered a command again.
    this.bot.use((ctx, next) => {
      Promise.resolve()
        .then(() => next())
        .catch(err => this._handleError(err, ctx));
    });

    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return;
      await withTimeout(db.getOrCreateUser(ctx.from.id, ctx.from.username), 10000, 'user lookup');
      return next();
    });

    // Belt and braces: anything that still reaches Telegraf's error path is
    // logged, never rethrown into the polling loop.
    this.bot.catch((err, ctx) => this._handleError(err, ctx));
  }

  _handleError(err, ctx) {
    const msg = err?.description || err?.message || String(err);
    // Harmless Telegram complaints: a double-tapped button re-rendering the
    // same text, or answering a callback after its 15s window.
    if (/message is not modified|query is too old|query ID is invalid|message to edit not found/i.test(msg)) return;
    logger.error(`[bot] update ${ctx?.updateType || '?'} from ${ctx?.from?.id || '?'} failed: ${msg}`);
    if (ctx?.chat?.id) {
      ctx.reply('⚠️ Something went wrong handling that — please try again.').catch(() => {});
    }
  }

  // === HELPERS ===
  isAdmin(id) {
    return this.adminId != null && String(id) === String(this.adminId);
  }

  /**
   * Show a panel: edit the message in place when a button was tapped, send a
   * new one for a command. Falls back to sending when the original can't be
   * edited (a photo, or older than Telegram allows).
   */
  async _show(ctx, panel) {
    const { text, keyboard } = await panel;
    const extra = {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard || [] },
    };
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, extra);
        return;
      } catch (err) {
        if (/message is not modified/i.test(err.description || err.message)) return;
      }
    }
    await ctx.reply(text, extra);
  }

  /** Render a panel by name. Args come from callback data (`p:name:a:b`). */
  async _panel(name, user, args = []) {
    switch (name) {
      case 'home': return panels.home(this, user);
      case 'wallet': return panels.wallet(this, user);
      case 'pos': return panels.positions(this, user);
      case 'posd': return panels.positionDetail(this, user, args[0]);
      case 'sellall': return panels.sellAllConfirm();
      case 'pnl': return panels.pnl(this, user);
      case 'lb': {
        const days = Number.isFinite(parseInt(args[0], 10)) ? parseInt(args[0], 10) : 7;
        const chain = CHAINS[args[1]] ? args[1] : 'all';
        return panels.leaderboard(this, user, { days, chain });
      }
      case 'hit': return panels.hitRate(this, user, { days: Number.isFinite(parseInt(args[0], 10)) ? parseInt(args[0], 10) : 30 });
      case 'pat': return panels.patterns();
      case 'alerts': return panels.alerts(this, user);
      case 'set': return panels.settings(this, user);
      case 'watch': return panels.watchlist();
      case 'ref': return panels.referral(this, user, { share: REFERRAL_FEE_SHARE });
      case 'help': return panels.help(this);
      case 'health': return this.isAdmin(user.telegram_id) ? panels.health(this) : panels.home(this, user);
      case 'admin': return this.isAdmin(user.telegram_id) ? panels.admin() : panels.home(this, user);
      default: return panels.home(this, user);
    }
  }

  async _showPanel(ctx, name, args = []) {
    const user = await db.getUser(ctx.from.id);
    return this._show(ctx, this._panel(name, user, args));
  }

  _chainInfo(user) {
    const chain = user.active_chain || 'solana';
    return { chain, ...CHAINS[chain] };
  }

  _mainKeyboard(chain) {
    const c = CHAINS[chain] || CHAINS.solana;
    return Markup.keyboard([
      [`👛 Wallet`, `📊 Positions`],
      [`💰 PnL`, `🏆 Leaderboard`],
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
        const bal = await Promise.race([
          this.walletManager.getBalance(info.chain, walletAddr),
          new Promise(r => setTimeout(() => r(0), 5000)),
        ]);

        await ctx.replyWithHTML(
          `<b>⚡ Welcome back</b>\n\n` +
          `${info.emoji} <code>${walletAddr}</code>\n` +
          `Balance: <b>${Number(bal || 0).toFixed(4)} ${info.currency}</b>`,
          this._mainKeyboard(info.chain)
        );
        return this._show(ctx, panels.home(this, user));
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

    this.bot.command('menu', (ctx) => this._showPanel(ctx, 'home'));
    this.bot.command('help', (ctx) => this._showPanel(ctx, 'help'));

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
      const loading = await ctx.reply('👛 Loading portfolio...');
      const user = await db.getUser(ctx.from.id);
      const { text, keyboard } = await panels.wallet(this, user);
      await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined, text, {
        parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard },
      });
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
            `sellmenu_${p.mint}`
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
      return this._show(ctx, panels.sellAllConfirm());
    });

    // === PORTFOLIO ===
    this.bot.command('positions', (ctx) => this._showPanel(ctx, 'pos'));
    this.bot.command('pnl', (ctx) => this._showPanel(ctx, 'pnl'));
    this.bot.command('stats', (ctx) => this._showPanel(ctx, 'pnl'));

    this.bot.command('card', (ctx) => this.sendMonthlyCard(ctx.from.id, ctx));

    // === SETTINGS ===
    this.bot.command('settings', (ctx) => this._showPanel(ctx, 'set'));

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

    this.bot.command('referral', (ctx) => this._showPanel(ctx, 'ref'));

    this.bot.command('fees', (ctx) => {
      ctx.replyWithHTML(
        `<b>💸 Fees</b>\n\n` +
        `${this.feePct}% per trade (buy + sell)\n` +
        `Referrals earn ${(REFERRAL_FEE_SHARE * 100)}% of fees.\n` +
        `/referral for your link.`
      );
    });

    this.bot.command('admin', (ctx) => {
      if (!this.isAdmin(ctx.from.id)) return;
      return this._showPanel(ctx, 'admin');
    });

    // === PASTE TOKEN ADDRESS TO BUY ===
    // === ALERTS ===
    this.bot.command('alerts', (ctx) => this._showPanel(ctx, 'alerts'));

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

    this.bot.command('watchlist', (ctx) => this._showPanel(ctx, 'watch'));

    // === TRACK RECORD ===
    this.bot.command('leaderboard', async (ctx) => {
      const { days, chain } = panels.parseLeaderboardArgs(ctx.message.text.split(/\s+/).slice(1));
      const user = await db.getUser(ctx.from.id);
      return this._show(ctx, panels.leaderboard(this, user, { days, chain }));
    });
    this.bot.command('analytics', (ctx) => this._showPanel(ctx, 'hit', ['30']));
    this.bot.command('patterns', (ctx) => this._showPanel(ctx, 'pat'));

    this.bot.command('scanchain', async (ctx) => {
      if (!this.isAdmin(ctx.from.id)) return;
      const args = ctx.message.text.split(/\s+/).slice(1);
      if (!args.length) {
        const solOn = this.scanner ? this.scanner.enabled.solana : true;
        const rhOn = this.scanner ? this.scanner.enabled.robinhood : true;
        return ctx.replyWithHTML(
          `<b>🔗 Scanner Status</b>\n\n` +
          `◎ Solana: ${solOn ? '✅ Active' : '❌ Disabled'}\n` +
          `🪶 Robinhood: ${rhOn ? '✅ Active' : '❌ Disabled'}`
        );
      }
      const [chain, state] = args;
      if (!['solana', 'robinhood'].includes(chain) || !['on', 'off'].includes(state)) {
        return ctx.reply('Usage: /scanchain <solana|robinhood> <on|off>');
      }
      // This used to set an env var that nothing read after startup, so the
      // toggle reported success and changed nothing.
      if (!this.scanner) return ctx.reply('Scanner not attached.');
      this.scanner.setEnabled(chain, state === 'on');
      ctx.reply(`${chain} scanner ${state === 'on' ? 'enabled' : 'disabled'} (resets on restart — set ${chain.toUpperCase()}_SCANNER_ENABLED to persist)`);
    });

    this.bot.command('health', async (ctx) => {
      if (!this.isAdmin(ctx.from.id)) return;
      return this._showPanel(ctx, 'health');
    });

    this.bot.command('setliq', async (ctx) => {
      const v = parseFloat((ctx.message.text.split(' ')[1] || '').replace(/[$,k]/gi, m => (m.toLowerCase() === 'k' ? 'e3' : '')));
      if (!Number.isFinite(v) || v < 0 || v > 10_000_000) {
        return ctx.reply('Usage: /setliq <usd>  — e.g. /setliq 10000 or /setliq 10k (0 = no minimum)');
      }
      await db.updateUser(ctx.from.id, { alert_min_liq_usd: v });
      ctx.reply(v ? `✅ Only alerting tokens with at least ${money(v)} liquidity` : '✅ Liquidity filter off');
    });

    // Catch-all for free text. Must stay registered AFTER every command:
    // Telegraf middleware runs in order and a command is just a text message,
    // so anything registered below this that does not get next() called is
    // unreachable. It falls through at the end for exactly that reason.
    this.bot.on('text', async (ctx, next) => {
      const text = ctx.message.text.trim();

      // Handle wallet import
      if (this.pendingImport.has(ctx.from.id)) {
        return this._handleImport(ctx, text);
      }

      // A pasted token address gets the full thesis — name, price, market cap,
      // liquidity, safety and score — before any buy button is offered. The
      // chain is inferred from the address format, so pasting a Robinhood
      // token while on Solana just works instead of being ignored.
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
        return this._sendAnalysis(ctx, text, 'solana');
      }
      if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
        return this._sendAnalysis(ctx, text, 'robinhood');
      }

      // Keyboard buttons
      const BUTTONS = {
        '👛 Wallet': 'wallet',
        '📊 Positions': 'positions',
        '💰 PnL': 'pnl',
        '🏆 Leaderboard': 'leaderboard',
        '🎴 Card': 'card', // keyboards sent before the leaderboard button
        '📋 Menu': 'menu',
        '⚙️ Settings': 'settings',
      };
      const command = BUTTONS[text] || (text.startsWith('🔗') ? 'chain' : null);
      if (command) return this._runCommand(ctx, command);

      // Nothing matched — hand off rather than swallowing the update.
      return next();
    });

  }

  setupCallbacks() {
    // === PANELS ===
    // Every inline screen. Answer the callback first: Telegram shows a spinner
    // on the button until it is answered, and the window is only ~15s.
    this.bot.action(/^p:([a-z]+)((?::[\w.-]+)*)$/, async (ctx) => {
      const [, name, rest] = ctx.match;
      await ctx.answerCbQuery(name === 'wallet' ? 'Loading portfolio…' : undefined).catch(() => {});
      if (name === 'card') return this.sendMonthlyCard(ctx.from.id, ctx);
      return this._showPanel(ctx, name, rest ? rest.slice(1).split(':') : []);
    });

    // Buttons on messages sent by older versions of the bot.
    const legacy = {
      nav_leaderboard: ['lb', ['7', 'all']], nav_analytics: ['hit', ['30']], nav_patterns: ['pat', []],
      menu_alerts: ['alerts', []], menu_watchlist: ['watch', []],
    };
    for (const [data, [name, args]] of Object.entries(legacy)) {
      this.bot.action(data, async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        return this._showPanel(ctx, name, args);
      });
    }
    this.bot.action(/^lb_(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery().catch(() => {});
      const d = parseInt(ctx.match[1], 10);
      return this._showPanel(ctx, 'lb', [String(d >= 9999 ? 0 : d), 'all']);
    });

    this.bot.action('sellall_yes', async (ctx) => {
      await ctx.answerCbQuery('Selling everything…').catch(() => {});
      const positions = await db.getUserPositions(ctx.from.id, 'open');
      if (!positions.length) return this._show(ctx, panels.positions(this, await db.getUser(ctx.from.id)));
      await this._show(ctx, { text: `⏳ Closing ${positions.length} position(s)…`, keyboard: [] });
      const results = [];
      for (const pos of positions) {
        const c = CHAINS[pos.chain] || CHAINS.solana;
        try {
          const r = await this.engine.sellToken(ctx.from.id, pos.mint, 1.0, pos.chain);
          results.push(`✅ ${c.emoji} ${esc(pos.symbol || pos.mint.slice(0, 6))}` +
            (r?.pnlSol != null ? ` ${r.pnlSol >= 0 ? '+' : ''}${Number(r.pnlSol).toFixed(4)} ${c.currency}` : ''));
        } catch (e) {
          results.push(`❌ ${c.emoji} ${esc(pos.symbol || pos.mint.slice(0, 6))}: ${esc(e.message).slice(0, 80)}`);
        }
      }
      await ctx.replyWithHTML(`<b>Sell all</b>\n\n${results.join('\n')}`, {
        reply_markup: { inline_keyboard: [[{ text: '📊 Positions', callback_data: 'p:pos' }, { text: '« Menu', callback_data: 'p:home' }]] },
      });
    });

    // === ONBOARDING ===
    this.bot.action(/^onboard_(solana|robinhood)$/, async (ctx) => {
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
    // Anchored: unanchored, this also matched `alertchain_solana`, so toggling
    // an alert chain switched the user's active trading chain instead.
    this.bot.action(/^chain_(solana|robinhood)$/, async (ctx) => {
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
    this.bot.action(/^qbuy_([^_]+)_([^_]+)$/, async (ctx) => {
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
    this.bot.action(/^qsell_([^_]+)_(\d+)$/, async (ctx) => {
      const mint = ctx.match[1];
      const pct = parseInt(ctx.match[2]);
      await ctx.answerCbQuery(`Selling ${pct}%...`);
      await this._executeSell(ctx, mint, pct);
    });

    this.bot.action(/^sellmenu_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      ctx.replyWithHTML(`<b>Sell:</b>`, this._sellButtons(ctx.match[1]));
    });

    // === SETTINGS ===
    // Each change re-renders the settings panel so the selection marker moves;
    // previously the buttons only flashed a toast and the screen kept showing
    // the old values.
    const settingsChange = (pattern, apply) => this.bot.action(pattern, async (ctx) => {
      const user = await db.getUser(ctx.from.id);
      const { updates, toast } = apply(ctx.match, user);
      await db.updateUser(ctx.from.id, updates);
      await ctx.answerCbQuery(toast).catch(() => {});
      return this._showPanel(ctx, 'set');
    });
    settingsChange(/^setbuy_([\d.]+)$/, (m) => {
      const v = parseFloat(m[1]);
      return { updates: { max_buy_amount: v }, toast: `Buy: ${v}` };
    });
    settingsChange(/^setslip_(\d+)$/, (m) => {
      const v = parseInt(m[1], 10);
      return { updates: { slippage_bps: v }, toast: `Slippage: ${v / 100}%` };
    });
    settingsChange(/^toggle_autosell$/, (m, user) => ({
      updates: { auto_sell: !user.auto_sell }, toast: `Auto-sell: ${!user.auto_sell ? 'ON' : 'OFF'}`,
    }));
    settingsChange(/^setchain_(solana|robinhood)$/, (m) => ({
      updates: { active_chain: m[1] }, toast: `Active chain: ${CHAINS[m[1]].name}`,
    }));

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
      await this._showPanel(ctx, 'alerts');
    });

    this.bot.action('alerts_off', async (ctx) => {
      await db.updateUser(ctx.from.id, { alerts_enabled: false });
      await ctx.answerCbQuery('Alerts muted. Re-enable with /alerts');
    });

    this.bot.action(/^alertscore_(\d+)$/, async (ctx) => {
      const v = parseInt(ctx.match[1], 10);
      await db.updateUser(ctx.from.id, { alert_min_score: v });
      await ctx.answerCbQuery(`Min score: ${v}`);
      await this._showPanel(ctx, 'alerts');
    });

    this.bot.action(/^alertliq_(\d+)$/, async (ctx) => {
      const v = parseInt(ctx.match[1], 10);
      await db.updateUser(ctx.from.id, { alert_min_liq_usd: v });
      await ctx.answerCbQuery(v ? `Min liquidity: ${money(v)}` : 'Liquidity filter off');
      await this._showPanel(ctx, 'alerts');
    });

    this.bot.action(/^alertchain_(solana|robinhood)$/, async (ctx) => {
      const chain = ctx.match[1];
      const user = await db.getUser(ctx.from.id);
      const current = new Set((user.alert_chains || 'solana,robinhood').split(',').filter(Boolean));
      if (current.has(chain)) current.delete(chain); else current.add(chain);
      await db.updateUser(ctx.from.id, { alert_chains: [...current].join(',') });
      await ctx.answerCbQuery(`${CHAINS[chain].name}: ${current.has(chain) ? 'on' : 'off'}`);
      await this._showPanel(ctx, 'alerts');
    });

    // Buy straight from an alert. The chain rides in the callback data, so
    // there is no "switch chain first" step between seeing a call and taking it.
    this.bot.action(/^abuy_(solana|robinhood)_([^_]+)_([\d.]+)$/, async (ctx) => {
      const [, chain, mint, amountStr] = ctx.match;
      await ctx.answerCbQuery(`Buying ${amountStr} on ${CHAINS[chain]?.name || chain}...`);
      await this._executeBuy(ctx, mint, parseFloat(amountStr), chain);
    });

    this.bot.action(/^analyze_(solana|robinhood)_(.+)$/, async (ctx) => {
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

  /**
   * Run a slash command on behalf of a reply-keyboard button.
   *
   * Telegraf matches bot.command() on a `bot_command` message entity, not on
   * the text. A keyboard button sends plain text with no entities, so
   * re-dispatching with only the text swapped matched nothing and the button
   * silently did nothing. The entity has to be synthesized too.
   */
  _runCommand(ctx, command) {
    const text = `/${command}`;
    return this.bot.handleUpdate({
      ...ctx.update,
      message: {
        ...ctx.message,
        text,
        entities: [{ type: 'bot_command', offset: 0, length: text.length }],
      },
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
      `Min liquidity: <b>${user.alert_min_liq_usd ? money(user.alert_min_liq_usd) : 'none'}</b>`,
      `Chains:\n  ${chainLabels}`,
      '',
      `<i>60–74 = safe new launches with no trading yet. 75+ = only tokens that already show buying momentum. Raise it for fewer, higher-conviction calls.</i>`,
    ].join('\n');
  }

  _alertButtons(user) {
    const score = user.alert_min_score ?? 60;
    return Markup.inlineKeyboard([
      [Markup.button.callback(user.alerts_enabled ? '🔕 Turn OFF' : '🔔 Turn ON', 'alerts_toggle')],
      [40, 60, 75, 85].map(v =>
        Markup.button.callback(`${score === v ? '• ' : ''}Score ${v}+`, `alertscore_${v}`)
      ),
      [0, 5000, 10000, 25000].map(v =>
        Markup.button.callback(
          `${(user.alert_min_liq_usd || 0) === v ? '• ' : ''}${v ? `Liq ${money(v)}+` : 'Any liq'}`,
          `alertliq_${v}`
        )
      ),
      Object.entries(CHAINS).map(([k, c]) => {
        const on = (user.alert_chains || 'solana,robinhood').split(',').includes(k);
        return Markup.button.callback(`${on ? '✅' : '⬜'} ${c.emoji} ${c.name}`, `alertchain_${k}`);
      }),
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
      const { token, analysis } = await withTimeout(this.analyzer.analyze({
        chain, mint: stored?.mint || mint,
        deployer: stored?.deployer,
        poolAddress: stored?.pool_address,
        lpMint: stored?.lp_mint,
        dex: stored?.dex,
        symbol: stored?.symbol !== 'UNKNOWN' ? stored?.symbol : undefined,
      }), 45000, 'analysis');

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
      await ctx.reply(`⏳ Selling ${pct}%...`);
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
      if (event.type === 'sell_failed') return this._notifySellFailed(event);
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

  /**
   * An automatic TP/SL sell that fails is retried every monitor cycle, so
   * tell the user once an hour per position rather than every 30 seconds —
   * but do tell them: a stop-loss that silently never fills costs money.
   */
  async _notifySellFailed(event) {
    const key = `${event.position.id}:${event.reason}`;
    const last = this._sellFailNotified.get(key) || 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    this._sellFailNotified.set(key, Date.now());
    if (this._sellFailNotified.size > 5000) this._sellFailNotified.clear();
    const sym = esc(event.position.symbol || event.position.mint.slice(0, 8));
    await this.sendAlert(event.userId,
      `⚠️ <b>${event.reason} sell failed</b> — ${sym}\n\n${esc(event.error).slice(0, 200)}\n\n` +
      `<i>Retrying automatically. You can also sell manually:</i>`,
      { reply_markup: this._sellButtons(event.position.mint).reply_markup });
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

  /** Send an HTML message. Resolves true when delivered, false otherwise. */
  async sendAlert(chatId, msg, extra = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.bot.telegram.sendMessage(chatId, msg, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...extra,
        });
        return true;
      } catch (e) {
        const code = e.response?.error_code;
        // Flood control: Telegram says exactly how long to wait.
        if (code === 429 && attempt === 0) {
          await sleep(Math.min((e.response?.parameters?.retry_after || 3) * 1000, 30000));
          continue;
        }
        // 403: the user blocked the bot. 400 "chat not found": the account is
        // gone. Either way stop alerting them rather than failing forever.
        if (code === 403 || (code === 400 && /chat not found/i.test(e.description || e.message))) {
          await db.updateUser(chatId, { alerts_enabled: false }).catch(() => {});
          logger.warn(`[alert] ${chatId} unreachable (${code}) — alerts disabled`);
        } else {
          logger.error(`Alert failed for ${chatId}: ${e.description || e.message}`);
        }
        return false;
      }
    }
    return false;
  }

  /**
   * Start long polling under a supervisor.
   *
   * Telegraf ends polling permanently on a 409 Conflict (another process is
   * polling with this token — routine for a few seconds during a redeploy)
   * and on any unexpected getUpdates error. Previously that rejection went
   * unobserved: alerts kept flowing out, but no command was ever answered
   * again. Here polling is restarted with backoff until stop() is called.
   */
  async launch() {
    this.bot.botInfo = await this._getMe();
    logger.info(`Telegram bot authenticated as @${this.bot.botInfo.username}`);
    this._poll(0);
  }

  async _getMe() {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withTimeout(this.bot.telegram.getMe(), 15000, 'getMe');
      } catch (err) {
        if (err.response?.error_code === 401) throw new Error('TELEGRAM_BOT_TOKEN is invalid (401 Unauthorized)');
        if (attempt >= 5) throw err;
        logger.warn(`[bot] getMe failed (${err.message}), retrying`);
        await sleep(2000 * (attempt + 1));
      }
    }
  }

  _poll(restarts) {
    if (this._stopping) return;
    const startedAt = Date.now();
    this.bot.launch({ dropPendingUpdates: restarts === 0 })
      .then(() => {
        if (!this._stopping) {
          logger.warn('[bot] polling ended unexpectedly — restarting');
          setTimeout(() => this._poll(restarts + 1), 2000).unref?.();
        }
      })
      .catch((err) => {
        if (this._stopping) return;
        const code = err.response?.error_code;
        // A long healthy run resets the backoff.
        const n = Date.now() - startedAt > 10 * 60 * 1000 ? 0 : restarts;
        const delay = Math.min(5000 * 2 ** n, 120000);
        if (code === 409) {
          logger.warn(`[bot] 409 Conflict: another instance is polling this bot token. Retrying in ${delay / 1000}s ` +
            '(normal for a few seconds during a redeploy; if it persists, a second copy of the bot is running).');
        } else {
          logger.error(`[bot] polling stopped: ${err.description || err.message}. Restarting in ${delay / 1000}s`);
        }
        setTimeout(() => this._poll(n + 1), delay).unref?.();
      });
  }

  stop() {
    this._stopping = true;
    try { this.bot.stop('shutdown'); } catch { /* not running */ }
  }
}

module.exports = TelegramBot;
