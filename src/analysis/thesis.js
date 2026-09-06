const CHAINS = require('../services/chains');

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function money(n) {
  if (n == null) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

/** Token prices span many orders of magnitude; keep them readable. */
function price(n) {
  if (n == null) return '—';
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 1e-6) return `$${n.toFixed(9).replace(/0+$/, '')}`;
  return `$${n.toExponential(3)}`;
}

function compact(n) {
  if (n == null) return '—';
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function scoreBar(score) {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function scoreEmoji(score) {
  if (score >= 85) return '🟢';
  if (score >= 70) return '🟡';
  if (score >= 55) return '🟠';
  return '🔴';
}

/**
 * Renders a scored token as a readable investment thesis rather than a data
 * dump: verdict first, then the case for and against, then the numbers.
 */
function renderAlert(token, analysis, deployerStats) {
  const meta = CHAINS[token.chain] || CHAINS.solana;
  const { score, verdict, bulls, bears, categories, confidence } = analysis;
  const m = token.market || {};

  const lines = [];
  lines.push(`${scoreEmoji(score)} <b>${esc(token.symbol || 'UNKNOWN')}</b> — ${esc(verdict)}`);
  lines.push(`${meta.emoji} ${meta.name}  ·  <code>${scoreBar(score)}</code> <b>${score}</b>/100`);
  if (confidence < 0.7) {
    lines.push(`<i>⚠️ Partial data — scored on ${Math.round(confidence * 100)}% of signals</i>`);
  }
  if (token.name && token.name !== token.symbol) lines.push(`<i>${esc(token.name)}</i>`);
  lines.push('');

  const mc = m.marketCap || token.marketCap;
  const liq = m.liquidityUsd
    ? money(m.liquidityUsd)
    : token.liquiditySol != null ? `${token.liquiditySol.toFixed(2)} ${meta.currency}` : '—';
  lines.push(`💰 Price: ${price(token.priceUsd)}  ·  MC: ${money(mc)}  ·  Liq: ${liq}`);

  const holderParts = [];
  if (token.holderCount) holderParts.push(`Holders: ${compact(token.holderCount)}`);
  if (token.devHoldingPct != null) holderParts.push(`Dev: ${token.devHoldingPct.toFixed(1)}%`);
  if (token.topHolderPct != null) holderParts.push(`Top: ${token.topHolderPct.toFixed(1)}%`);
  if (holderParts.length) lines.push(`👥 ${holderParts.join('  ·  ')}`);

  const safety = [];
  if (token.mintAuthorityRevoked) safety.push('Mint revoked');
  if (token.freezeAuthorityRevoked) safety.push('Freeze revoked');
  if (token.lpBurnedPct > 0) safety.push(`LP burned ${token.lpBurnedPct.toFixed(0)}%`);
  else if (token.lpLocked) safety.push('LP locked');
  if (token.honeypot === true) safety.push('⚠️ HONEYPOT');
  if (safety.length) lines.push(`🔒 ${safety.join('  ·  ')}`);

  const vol = [];
  if (m.volume5m) vol.push(`Vol5m: ${money(m.volume5m)}`);
  if (m.buys5m != null && m.sells5m != null) vol.push(`Buys: ${m.buys5m}  ·  Sells: ${m.sells5m}`);
  else if (m.priceChange1h != null && m.priceChange1h !== 0) {
    vol.push(`1h: ${m.priceChange1h > 0 ? '+' : ''}${m.priceChange1h.toFixed(1)}%`);
  }
  if (vol.length) lines.push(`📊 ${vol.join('  ·  ')}`);

  lines.push('');

  if (bulls.length) {
    lines.push('<b>Bull case</b>');
    for (const b of bulls.slice(0, 4)) lines.push(`  ✓ ${esc(b)}`);
  }
  if (bears.length) {
    lines.push('<b>Risks</b>');
    for (const b of bears.slice(0, 4)) lines.push(`  ✗ ${esc(b)}`);
  }

  if (token.deployer) {
    const addr = token.deployer;
    const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    let depLine = `🏷 Deployer: <code>${short}</code>`;
    if (deployerStats) {
      depLine += ` (${deployerStats.launches} launches, ${deployerStats.rugs || 0} rugs`;
      if (deployerStats.best_multiple > 1) depLine += `, best ${deployerStats.best_multiple.toFixed(0)}x`;
      depLine += ')';
    }
    lines.push('');
    lines.push(depLine);
  }

  lines.push('');
  lines.push(`<code>${esc(token.mint)}</code>`);
  lines.push(`<a href="${meta.tokenUrl(token.mint)}">Explorer</a>`);

  return lines.join('\n');
}

/** Inline buy buttons that carry the chain, so no manual /chain switch. */
function alertKeyboard(token) {
  const amounts = [0.1, 0.5, 1];
  return {
    inline_keyboard: [
      amounts.map(a => ({
        text: `Buy ${a}`,
        callback_data: `abuy_${token.chain}_${token.mint}_${a}`,
      })),
      [
        { text: '📊 Analysis', callback_data: `analyze_${token.chain}_${token.mint}` },
        { text: '🔕 Mute', callback_data: 'alerts_off' },
      ],
    ],
  };
}

function renderSmartMoneyAlert(token, wallets) {
  const meta = CHAINS[token.chain] || CHAINS.solana;
  const names = wallets.map(w => esc(w.label || `${w.address.slice(0, 6)}…`)).join(', ');
  return [
    `🧠 <b>SMART MONEY</b> — ${wallets.length} tracked wallets bought`,
    `${meta.emoji} <b>${esc(token.symbol || 'UNKNOWN')}</b>`,
    '',
    `Wallets: ${names}`,
    '',
    `<code>${esc(token.mint)}</code>`,
  ].join('\n');
}

module.exports = { renderAlert, alertKeyboard, renderSmartMoneyAlert, money, price, compact, scoreBar, scoreEmoji, esc };
