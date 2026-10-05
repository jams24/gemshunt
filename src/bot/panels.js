const db = require('../db/database');
const CHAINS = require('../services/chains');
const { formatHoldTime } = require('../services/pnlCard');
const { money, esc, chartUrl, scoreEmoji } = require('../analysis/thesis');
const { settle } = require('../utils/async');

/**
 * Every screen of the bot's inline UI. Each panel is a pure-ish render that
 * returns { text, keyboard } so the same screen can be sent fresh (a slash
 * command) or edited in place (a button tap) — navigation never floods the
 * chat with new messages.
 *
 * Callback data is `p:<panel>[:args]`, routed by TelegramBot._onPanel.
 * Telegram caps callback data at 64 bytes; keep args short.
 */

const btn = (text, data) => ({ text, callback_data: data });
const urlBtn = (text, url) => ({ text, url });
const back = (to = 'home', label = '« Menu') => btn(label, `p:${to}`);
const sel = (on, text) => (on ? `• ${text}` : text);

const num = (n) => (n == null || n === '' ? NaN : Number(n));
const x = (n, d = 1) => (Number.isFinite(num(n)) ? `${num(n).toFixed(d)}x` : '—');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const signed = (n, d = 4) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(d)}`;

function ago(date) {
  if (!date) return '';
  const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function span(from, to) {
  if (!from || !to) return null;
  const s = (new Date(to) - new Date(from)) / 1000;
  if (!(s > 0)) return null;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h`;
}

const PERIODS = [[1, '24h'], [7, '7d'], [30, '30d'], [0, 'All']];
const periodLabel = (d) => (PERIODS.find(([v]) => v === d)?.[1] || `${d}d`).replace('All', 'All time');
const CHAIN_KEYS = ['all', ...Object.keys(CHAINS)];

/** "24h" / "1d" / "7" / "all" / "sol" → { days, chain }. Hours round up to days. */
function parseLeaderboardArgs(args = []) {
  let days = 7;
  let chain = 'all';
  for (const raw of args.map(a => String(a).toLowerCase())) {
    if (raw === 'all' || raw === 'alltime') { days = 0; continue; }
    const m = raw.match(/^(\d+)\s*(h|d|w|m)?$/);
    if (m) {
      const n = parseInt(m[1], 10);
      const unit = m[2] || 'd';
      days = unit === 'h' ? Math.max(1, Math.ceil(n / 24))
        : unit === 'w' ? n * 7
        : unit === 'm' ? n * 30
        : n;
      continue;
    }
    const c = Object.keys(CHAINS).find(k => k.startsWith(raw) || CHAINS[k].name.toLowerCase().startsWith(raw)
      || (raw === 'rh' && k === 'robinhood') || (raw === 'sol' && k === 'solana'));
    if (c) chain = c;
  }
  return { days: Math.min(Math.max(days, 0), 3650), chain };
}

// ------------------------------------------------------------------ home

async function home(tb, user) {
  const info = CHAINS[user.active_chain || 'solana'] || CHAINS.solana;
  const positions = await db.getUserPositions(user.telegram_id, 'open');
  const up = positions.filter(p => (p.pnl_pct || 0) >= 0).length;
  const alertChains = (user.alert_chains || 'solana,robinhood').split(',')
    .map(k => CHAINS[k]?.emoji).filter(Boolean).join('');
  const wallets = Object.entries(CHAINS)
    .map(([k, c]) => `${c.emoji} ${(k === 'solana' ? user.sol_wallet_address : user.evm_wallet_address) ? '✅' : '—'}`)
    .join('  ');

  const text = [
    '<b>⚡ SolSniper</b>',
    '',
    `Active chain: <b>${info.emoji} ${info.name}</b>`,
    `Wallets: ${wallets}`,
    `Open positions: <b>${positions.length}</b>${positions.length ? ` (🟢 ${up} · 🔴 ${positions.length - up})` : ''}`,
    `Alerts: <b>${user.alerts_enabled ? `🔔 ON · ${user.alert_min_score ?? 60}+` : '🔕 OFF'}</b>${user.alerts_enabled ? ` · ${alertChains || 'no chains'}` : ''}`,
    `Buy: <b>${user.max_buy_amount}</b> · Slippage: <b>${(user.slippage_bps / 100).toFixed(1)}%</b> · Auto-sell: <b>${user.auto_sell ? 'ON' : 'OFF'}</b>`,
    '',
    '<i>Paste any token address to analyse and buy.</i>',
  ].join('\n');

  const keyboard = [
    [btn('👛 Wallet', 'p:wallet'), btn('📊 Positions', 'p:pos')],
    [btn('💰 PnL', 'p:pnl'), btn('🏆 Leaderboard', 'p:lb:7:all')],
    [btn('🔔 Alerts', 'p:alerts'), btn('⚙️ Settings', 'p:set')],
    [btn('📈 Hit rate', 'p:hit:30'), btn('🧬 Patterns', 'p:pat')],
    [btn('🧠 Watchlist', 'p:watch'), btn('🎁 Referral', 'p:ref')],
    [btn('❓ Help', 'p:help')],
  ];
  if (tb.isAdmin(user.telegram_id)) keyboard.push([btn('🩺 Health', 'p:health'), btn('🔧 Admin', 'p:admin')]);
  return { text, keyboard };
}

// ---------------------------------------------------------------- wallet

async function wallet(tb, user) {
  if (!user.sol_wallet_address && !user.evm_wallet_address) {
    return {
      text: '<b>👛 No wallets yet</b>\n\nCreate one for every chain in a single tap, or import an existing key.',
      keyboard: [...tb._walletButtons(user).reply_markup.inline_keyboard, [back()]],
    };
  }
  const text = await tb._renderPortfolio(user);
  return { text, keyboard: [...tb._walletButtons(user).reply_markup.inline_keyboard, [back()]] };
}

// ------------------------------------------------------------- positions

function positionLine(p) {
  const c = CHAINS[p.chain || 'solana'] || CHAINS.solana;
  const pnl = Number(p.pnl_pct || 0);
  return `${pnl >= 0 ? '🟢' : '🔴'} ${c.emoji} ${p.symbol || p.mint.slice(0, 6)}  ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`;
}

async function positions(tb, user) {
  const list = await db.getUserPositions(user.telegram_id, 'open');
  if (!list.length) {
    return {
      text: '<b>📊 Positions</b>\n\nNo open positions.\n\n<i>Paste a token address, or buy straight from an alert.</i>',
      keyboard: [[btn('🏆 Leaderboard', 'p:lb:7:all'), back()]],
    };
  }
  const lines = ['<b>📊 Open positions</b>', ''];
  for (const p of list) {
    const c = CHAINS[p.chain || 'solana'] || CHAINS.solana;
    const pnl = Number(p.pnl_pct || 0);
    lines.push(
      `${pnl >= 0 ? '🟢' : '🔴'} ${c.emoji} <b>${esc(p.symbol || p.mint.slice(0, 8))}</b>  ` +
      `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%  ·  ${x(p.current_mc, 2)}  ·  ${formatHoldTime(p.opened_at)}`
    );
    lines.push(`   In: ${Number(p.sol_invested || 0).toFixed(4)} ${c.currency}  ·  PnL: ${signed(p.pnl_sol || 0)} ${c.currency}`);
  }
  lines.push('', '<i>Tap a position to manage it. PnL refreshes every monitor cycle.</i>');
  const keyboard = list.map(p => [btn(positionLine(p), `p:posd:${p.id}`)]);
  keyboard.push([btn('🔄 Refresh', 'p:pos'), btn('🔴 Sell all', 'p:sellall')]);
  keyboard.push([back()]);
  return { text: lines.join('\n'), keyboard };
}

async function positionDetail(tb, user, id) {
  const p = await db.getPosition(user.telegram_id, parseInt(id, 10));
  if (!p || p.status !== 'open') {
    return { text: '<b>📊 Position</b>\n\nThat position is closed or no longer exists.', keyboard: [[back('pos', '« Positions')]] };
  }
  const c = CHAINS[p.chain || 'solana'] || CHAINS.solana;
  const pnl = Number(p.pnl_pct || 0);
  const tps = ['tp1_hit', 'tp2_hit', 'tp3_hit'].map((k, i) => `TP${i + 1} ${p[k] ? '✅' : '⬜'}`).join('  ');
  const value = Number(p.sol_invested || 0) + Number(p.pnl_sol || 0) - Number(p.sol_received || 0);
  const text = [
    `${pnl >= 0 ? '🟢' : '🔴'} <b>${esc(p.symbol || 'Position')}</b> · ${c.emoji} ${c.name}`,
    `<code>${p.mint}</code>`,
    '',
    `PnL: <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%</b> (${signed(p.pnl_sol || 0)} ${c.currency})`,
    `Multiple: <b>${x(p.current_mc, 2)}</b> · peak ${x(p.peak_mc, 2)}`,
    `Invested: ${Number(p.sol_invested || 0).toFixed(4)} ${c.currency}` +
      (Number(p.sol_received) ? ` · taken out ${Number(p.sol_received).toFixed(4)}` : ''),
    `Holding value: ~${Math.max(0, value).toFixed(4)} ${c.currency}`,
    `Held: ${formatHoldTime(p.opened_at)}`,
    `${tps}${user.auto_sell ? '' : '  <i>(auto-sell off)</i>'}`,
  ].join('\n');
  const keyboard = [
    [25, 50, 75, 100].map(v => btn(`Sell ${v}%`, `qsell_${p.mint}_${v}`)),
    [urlBtn('📈 Chart', chartUrl({ chain: p.chain || 'solana', mint: p.mint })), btn('🔬 Scan', `analyze_${p.chain || 'solana'}_${p.mint}`)],
    [btn('🔄 Refresh', `p:posd:${p.id}`), back('pos', '« Positions')],
  ];
  return { text, keyboard };
}

function sellAllConfirm() {
  return {
    text: '<b>🔴 Sell everything?</b>\n\nThis market-sells 100% of every open position on every chain.',
    keyboard: [[btn('Yes, sell all', 'sellall_yes'), back('pos', 'Cancel')]],
  };
}

// ------------------------------------------------------------------- pnl

async function pnl(tb, user) {
  const [byChain, closed] = await Promise.all([
    db.getUserPnlByChain(user.telegram_id),
    db.getUserClosedPositions(user.telegram_id, 8),
  ]);
  if (!byChain.length) {
    return { text: '<b>💰 PnL</b>\n\nNo closed trades yet.', keyboard: [[back()]] };
  }
  const lines = ['<b>💰 PnL — realised</b>', ''];
  for (const r of byChain) {
    const c = CHAINS[r.chain] || CHAINS.solana;
    const usd = await settle(tb.swap.getNativePriceUsd(r.chain), 3000, null);
    lines.push(
      `${c.emoji} <b>${c.name}</b>: <b>${signed(r.pnl)} ${c.currency}</b>` +
      (usd ? ` (${r.pnl < 0 ? '-' : ''}${money(Math.abs(r.pnl * usd))})` : ''),
      `   ${r.trades} trades · win rate ${pct(r.wins, r.trades)} · ROI ${r.invested ? `${signed((r.pnl / r.invested) * 100, 0)}%` : '—'}`,
      `   best ${signed(r.best_pct ?? 0, 0)}% · worst ${signed(r.worst_pct ?? 0, 0)}%`,
      ''
    );
  }
  lines.push('<b>Recent</b>');
  for (const p of closed) {
    const c = CHAINS[p.chain || 'solana'] || CHAINS.solana;
    lines.push(
      `${p.pnl_sol >= 0 ? '🟢' : '🔴'} ${c.emoji} ${esc(p.symbol || p.mint.slice(0, 6))} ` +
      `${signed(p.pnl_pct, 0)}% · ${signed(p.pnl_sol)} ${c.currency} · ${formatHoldTime(p.opened_at, p.closed_at)}`
    );
  }
  return { text: lines.join('\n'), keyboard: [[btn('🎴 Monthly card', 'p:card'), btn('📊 Positions', 'p:pos')], [back()]] };
}

// ----------------------------------------------------------- leaderboard

function lbStatus(t) {
  if (t.outcome === 'rug') return '💀 rugged after';
  const last = num(t.last_multiple);
  if (!Number.isFinite(last)) return null;
  if (last >= num(t.peak_multiple) * 0.8) return `🔥 now ${x(last)}`;
  return `now ${x(last, 2)}`;
}

const MEDALS = ['🥇', '🥈', '🥉'];

async function leaderboard(tb, user, { days = 7, chain = 'all' } = {}) {
  const chainFilter = chain === 'all' ? null : chain;
  const [rows, stats] = await Promise.all([
    db.getLeaderboard({ days, chain: chainFilter, limit: 10 }),
    db.getCallStats({ days, chain: chainFilter }),
  ]);
  const chainName = chainFilter ? `${CHAINS[chainFilter].emoji} ${CHAINS[chainFilter].name}` : 'All chains';
  const lines = [`🏆 <b>Leaderboard</b> — ${periodLabel(days)} · ${chainName}`];

  if (stats?.calls) {
    const m = stats.measured || 0;
    lines.push(
      `Calls: <b>${stats.calls}</b>${m < stats.calls ? ` (${m} measured)` : ''}` +
      (m ? ` · 2x+ <b>${pct(stats.hit_2x, m)}</b> · 5x+ <b>${pct(stats.hit_5x, m)}</b> · rugs ${pct(stats.rugs, m)}` : ''),
    );
    if (m) lines.push(`Best <b>${x(stats.best)}</b> · median peak ${x(stats.median_peak, 2)}`);
  }
  lines.push('');

  if (!rows.length) {
    lines.push(stats?.calls
      ? '<i>No call in this window has gone above its alert price yet.</i>'
      : '<i>No calls in this window yet. Calls appear here once an alerted token has been tracked for a few minutes.</i>');
  }
  rows.forEach((t, i) => {
    const c = CHAINS[t.chain] || CHAINS.solana;
    const status = lbStatus(t);
    const peakIn = span(t.called_at, t.peak_at);
    lines.push(
      `${MEDALS[i] || `<b>${i + 1}.</b>`} <b>${x(t.peak_multiple)}</b>  ${c.emoji} ` +
      `<a href="${chartUrl(t)}">${esc(t.symbol || t.mint.slice(0, 6))}</a>` +
      (t.score != null ? `  ${scoreEmoji(t.score)} ${t.score}` : ''),
      `    ${money(t.call_mc)} → ${money(t.peak_mc)} MC${peakIn ? ` in ${peakIn}` : ''} · ${ago(t.called_at)}` +
      (status ? ` · ${status}` : ''),
      `    <code>${t.mint}</code>`
    );
  });
  lines.push('', '<i>Peak since the alert, from post-alert prices only.</i>');

  const keyboard = [
    PERIODS.map(([d, l]) => btn(sel(d === days, l), `p:lb:${d}:${chain}`)),
    CHAIN_KEYS.map(k => btn(sel(k === chain, k === 'all' ? 'All' : `${CHAINS[k].emoji} ${CHAINS[k].name}`), `p:lb:${days}:${k}`)),
    [btn('📈 Hit rate', 'p:hit:30'), btn('🔄', `p:lb:${days}:${chain}`), back()],
  ];
  return { text: lines.join('\n'), keyboard };
}

// -------------------------------------------------------------- hit rate

async function hitRate(tb, user, { days = 30 } = {}) {
  const bands = await db.getScoreBandPerformance({ days });
  const lines = [`📈 <b>Hit rate by score</b> — ${periodLabel(days)}`, '<i>Peak multiple reached after the token was scored</i>', ''];
  if (!bands.length) {
    lines.push('<i>Not enough tracked tokens yet.</i>');
  }
  for (const b of bands) {
    const lo = parseInt(b.band, 10);
    lines.push(
      `${scoreEmoji(lo)} <b>Score ${b.band}</b> — ${b.total} token${b.total === 1 ? '' : 's'}`,
      `   2x+ <b>${pct(b.hit_2x, b.total)}</b> · 5x+ ${pct(b.hit_5x, b.total)} · rugs ${pct(b.rugs, b.total)} · median ${x(b.median_peak, 2)}`
    );
  }
  // Calibration check: does the best band with a real sample beat the worst?
  const sampled = bands.filter(b => b.total >= 5);
  if (sampled.length >= 2) {
    const rate = b => b.hit_2x / b.total;
    const top = sampled[0];
    const bottom = sampled[sampled.length - 1];
    lines.push('', rate(top) > rate(bottom)
      ? `✅ Higher scores are outperforming (${pct(top.hit_2x, top.total)} vs ${pct(bottom.hit_2x, bottom.total)} hit 2x).`
      : `⚠️ Higher scores are NOT outperforming (${pct(top.hit_2x, top.total)} vs ${pct(bottom.hit_2x, bottom.total)}) — weights need tuning.`);
  }
  const keyboard = [
    [[7, '7d'], [30, '30d'], [0, 'All']].map(([d, l]) => btn(sel(d === days, l), `p:hit:${d}`)),
    [btn('🏆 Leaderboard', 'p:lb:7:all'), btn('🧬 Patterns', 'p:pat'), back()],
  ];
  return { text: lines.join('\n'), keyboard };
}

// -------------------------------------------------------------- patterns

async function patterns() {
  const p = await db.getPatternAnalysis(3, 30);
  const lines = ['🧬 <b>What winners looked like</b> — 3x+ runners, last 30d', ''];
  if (!p?.total) {
    lines.push('<i>Not enough tracked tokens yet.</i>');
  } else {
    const row = (label, w, a, fmt = v => v) =>
      `${label}: <b>${w != null ? fmt(w) : '—'}</b> vs ${a != null ? fmt(a) : '—'}`;
    lines.push(
      `Winners: <b>${p.winners}</b> of ${p.total} tracked (${pct(p.winners, p.total)})`,
      '<i>winners vs all tracked</i>',
      '',
      row('Score', p.avg_score_winners, p.avg_score),
      row('MC at detection', p.avg_mc_winners, p.avg_mc, money),
      row('Liquidity', p.avg_liq_winners, p.avg_liq, money),
      row('Dev holding', p.avg_dev_pct_winners, p.avg_dev_pct, v => `${v}%`),
      row('Holders', p.avg_holders_winners, p.avg_holders),
      row('Mint revoked', p.pct_mint_revoked_winners, p.pct_mint_revoked_all, v => `${v}%`),
      row('LP burned >80%', p.pct_lp_burned_winners, p.pct_lp_burned_all, v => `${v}%`),
      '',
      `Rug rate across all tracked: <b>${p.pct_rug_all ?? '—'}%</b>`,
      '',
      '<i>Where winners differ clearly from the average is where the edge is.</i>'
    );
  }
  return { text: lines.join('\n'), keyboard: [[btn('📈 Hit rate', 'p:hit:30'), btn('🏆 Leaderboard', 'p:lb:7:all'), back()]] };
}

// ---------------------------------------------------------------- alerts

function alerts(tb, user) {
  return {
    text: tb._renderAlertSettings(user),
    keyboard: [...tb._alertButtons(user).reply_markup.inline_keyboard, [back()]],
  };
}

// -------------------------------------------------------------- settings

const BUY_PRESETS = { solana: [0.05, 0.1, 0.25, 0.5, 1], robinhood: [0.005, 0.01, 0.025, 0.05, 0.1] };

function settings(tb, user) {
  const chain = user.active_chain || 'solana';
  const info = CHAINS[chain] || CHAINS.solana;
  const text = [
    '<b>⚙️ Settings</b>',
    '',
    `Active chain: <b>${info.emoji} ${info.name}</b>`,
    `Default buy: <b>${user.max_buy_amount} ${info.currency}</b>`,
    `Slippage: <b>${(user.slippage_bps / 100).toFixed(1)}%</b>`,
    `Auto-sell (TP/SL): <b>${user.auto_sell ? 'ON' : 'OFF'}</b>`,
    '',
    '<i>The buy amount is in the active chain\'s currency. Custom: /setbuy 0.2 · /setslippage 300</i>',
  ].join('\n');
  const presets = BUY_PRESETS[chain] || BUY_PRESETS.solana;
  const keyboard = [
    presets.map(v => btn(sel(Number(user.max_buy_amount) === v, String(v)), `setbuy_${v}`)),
    [100, 300, 500, 1000, 2000].map(v => btn(sel(user.slippage_bps === v, `${v / 100}%`), `setslip_${v}`)),
    [btn(`Auto-sell: ${user.auto_sell ? '✅ ON' : '❌ OFF'}`, 'toggle_autosell')],
    Object.entries(CHAINS).map(([k, c]) => btn(sel(k === chain, `${c.emoji} ${c.name}`), `setchain_${k}`)),
    [back()],
  ];
  return { text, keyboard };
}

// ---------------------------------------------------------- watch / ref

async function watchlist() {
  const wallets = await db.getWatchedWallets();
  const lines = [`<b>🧠 Smart-money watchlist</b> (${wallets.length})`, ''];
  if (!wallets.length) lines.push('No wallets tracked yet.');
  for (const w of wallets.slice(0, 30)) {
    lines.push(`${CHAINS[w.chain]?.emoji || ''} <b>${esc(w.label || `${w.address.slice(0, 8)}…`)}</b>\n  <code>${w.address}</code>`);
  }
  if (wallets.length > 30) lines.push(`…and ${wallets.length - 30} more`);
  lines.push('', '<i>Add: /watch &lt;address&gt; [label] · Remove: /unwatch &lt;address&gt;\n2+ tracked wallets buying the same token fires a priority alert.</i>');
  return { text: lines.join('\n'), keyboard: [[back()]] };
}

async function referral(tb, user, { share }) {
  const link = `https://t.me/${tb.bot.botInfo?.username || 'SolSniperBot'}?start=ref_${user.telegram_id}`;
  const s = await db.getReferralStats(user.telegram_id);
  const text = [
    '<b>🎁 Referral</b>',
    '',
    `<code>${link}</code>`,
    '',
    `Earn <b>${Math.round(share * 100)}%</b> of the trading fees of everyone you refer, forever.`,
    '',
    `Referred: <b>${s?.referred ?? 0}</b>`,
    `Earned: <b>${Number(s?.earned || 0).toFixed(4)}</b> · unpaid ${Number(s?.unpaid || 0).toFixed(4)}`,
  ].join('\n');
  return {
    text,
    keyboard: [[urlBtn('📤 Share', `https://t.me/share/url?url=${encodeURIComponent(link)}`)], [back()]],
  };
}

function help(tb) {
  const text = [
    '<b>❓ Help</b>',
    '',
    '<b>Trade</b>',
    '• Paste a token address → full analysis + buy buttons',
    '/buy <code>addr</code> [amount] · /sell <code>addr</code> [%] · /sellall',
    '',
    '<b>Portfolio</b>',
    '/positions · /pnl · /card',
    '',
    '<b>Wallet</b>',
    '/wallet · /withdraw <code>addr</code> <code>amount</code> · /export',
    '',
    '<b>Alerts &amp; research</b>',
    '/alerts · /setscore <code>0-100</code> · /setliq <code>usd</code>',
    '/scan <code>addr</code> · /watch <code>wallet</code> · /watchlist',
    '/leaderboard [24h|7d|30d|all] [sol|rh] · /analytics · /patterns',
    '',
    '<b>Settings</b>',
    '/settings · /chain · /setbuy · /setslippage · /autosell',
    '/referral · /fees',
    '',
    `<i>Fee: ${tb.feePct}% per trade.</i>`,
  ].join('\n');
  return { text, keyboard: [[back()]] };
}

async function health(tb) {
  const text = tb.health ? await tb.health.status() : 'Health monitor not attached.';
  return { text, keyboard: [[btn('🔄 Refresh', 'p:health'), back()]] };
}

async function admin() {
  const { rows: [s] } = await db.query(`
    SELECT (SELECT COUNT(*) FROM users)::int AS users,
      (SELECT COUNT(*) FROM users WHERE sol_wallet_address IS NOT NULL OR evm_wallet_address IS NOT NULL)::int AS wallets,
      (SELECT COUNT(*) FROM users WHERE alerts_enabled AND is_active)::int AS subscribers,
      (SELECT COUNT(*) FROM users WHERE created_at > NOW() - interval '1 day')::int AS new_users,
      (SELECT COUNT(*) FROM positions WHERE status='open')::int AS open_pos,
      (SELECT COUNT(*) FROM trades)::int AS trades,
      (SELECT COUNT(*) FROM trades WHERE created_at > NOW() - interval '1 day')::int AS trades_24h,
      (SELECT COUNT(*) FROM tokens WHERE alerted_at > NOW() - interval '1 day')::int AS calls_24h,
      (SELECT COUNT(*) FROM alerts_sent WHERE sent_at > NOW() - interval '1 day')::int AS msgs_24h,
      (SELECT COALESCE(SUM(fee_amount), 0)::float FROM fee_ledger) AS fees
  `);
  const text = [
    '<b>🔧 Admin</b>',
    '',
    `Users: <b>${s.users}</b> (+${s.new_users} today) · wallets ${s.wallets} · subscribed ${s.subscribers}`,
    `Open positions: <b>${s.open_pos}</b> · trades ${s.trades} (${s.trades_24h} today)`,
    `Calls 24h: <b>${s.calls_24h}</b> · alert messages ${s.msgs_24h}`,
    `Fees logged: <b>${s.fees.toFixed(4)}</b>`,
  ].join('\n');
  return { text, keyboard: [[btn('🩺 Health', 'p:health'), btn('🔄 Refresh', 'p:admin'), back()]] };
}

module.exports = {
  home, wallet, positions, positionDetail, sellAllConfirm, pnl, leaderboard, hitRate,
  patterns, alerts, settings, watchlist, referral, help, health, admin,
  parseLeaderboardArgs, PERIODS,
};
