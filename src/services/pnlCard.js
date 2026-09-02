const { createCanvas, registerFont } = require('canvas');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const BOT_NAME = 'SolSniper';

function generateTradeCard(trade) {
  const width = 800;
  const height = 480;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const isProfit = trade.pnlPct >= 0;
  const accentColor = isProfit ? '#00E676' : '#FF1744';
  const bgGradientTop = isProfit ? '#0a1f0a' : '#1f0a0a';
  const bgGradientBottom = '#0d1117';

  // Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, bgGradientTop);
  bgGrad.addColorStop(1, bgGradientBottom);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle grid pattern
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y < height; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }

  // Glow effect behind PnL
  const glowGrad = ctx.createRadialGradient(400, 200, 0, 400, 200, 300);
  glowGrad.addColorStop(0, isProfit ? 'rgba(0,230,118,0.15)' : 'rgba(255,23,68,0.15)');
  glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, width, height);

  // Top bar
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, 0, width, 60);

  // Bot name
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${BOT_NAME}`, 30, 40);

  // Chain badge
  ctx.fillStyle = accentColor;
  ctx.font = 'bold 14px Arial, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('SOLANA', width - 30, 38);

  // Token symbol
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 42px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`$${trade.symbol}`, width / 2, 115);

  // Token name subtitle
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '16px Arial, sans-serif';
  ctx.fillText(trade.name || trade.mint?.slice(0, 16) + '...', width / 2, 142);

  // PnL percentage — the big number
  const pnlText = `${isProfit ? '+' : ''}${trade.pnlPct.toFixed(2)}%`;
  ctx.fillStyle = accentColor;
  ctx.font = 'bold 72px Arial, sans-serif';
  ctx.fillText(pnlText, width / 2, 230);

  // PnL in SOL
  const solText = `${isProfit ? '+' : ''}${trade.pnlSol.toFixed(4)} SOL`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '24px Arial, sans-serif';
  ctx.fillText(solText, width / 2, 268);

  // USD value
  if (trade.pnlUsd !== undefined) {
    const usdText = `~$${Math.abs(trade.pnlUsd).toFixed(2)} USD`;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '18px Arial, sans-serif';
    ctx.fillText(usdText, width / 2, 296);
  }

  // Stats section — divider
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(60, 320); ctx.lineTo(width - 60, 320); ctx.stroke();

  // Stats grid
  const stats = [
    ['Invested', `${trade.solInvested.toFixed(4)} SOL`],
    ['Returned', `${trade.solReceived.toFixed(4)} SOL`],
    ['Entry MC', trade.entryMc ? `$${formatNumber(trade.entryMc)}` : 'N/A'],
    ['Peak', `${trade.peakMc?.toFixed(1) || '?'}x`],
  ];

  const colWidth = (width - 120) / stats.length;
  ctx.textAlign = 'center';
  stats.forEach(([label, value], i) => {
    const x = 60 + colWidth * i + colWidth / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '13px Arial, sans-serif';
    ctx.fillText(label, x, 352);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px Arial, sans-serif';
    ctx.fillText(value, x, 378);
  });

  // Hold time
  if (trade.holdTime) {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '14px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Hold: ${trade.holdTime}`, width / 2, 415);
  }

  // Footer
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.font = '12px Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), 30, height - 20);
  ctx.textAlign = 'right';
  ctx.fillText(`@${trade.username || 'trader'}`, width - 30, height - 20);

  return canvas.toBuffer('image/png');
}

function generateMonthlyCard(stats) {
  const width = 800;
  const height = 520;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const isProfit = stats.totalPnlSol >= 0;
  const accentColor = isProfit ? '#00E676' : '#FF1744';

  // Background
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, '#0d1117');
  bgGrad.addColorStop(0.5, isProfit ? '#0a1a0a' : '#1a0a0a');
  bgGrad.addColorStop(1, '#0d1117');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  for (let x = 0; x < width; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y < height; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }

  // Glow
  const glowGrad = ctx.createRadialGradient(400, 220, 0, 400, 220, 300);
  glowGrad.addColorStop(0, isProfit ? 'rgba(0,230,118,0.12)' : 'rgba(255,23,68,0.12)');
  glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, width, height);

  // Bot name + logo area
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(BOT_NAME, width / 2, 50);

  // Month/Year
  const monthStr = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '20px Arial, sans-serif';
  ctx.fillText(monthStr, width / 2, 82);

  // PnL pill
  const pnlSolText = `${isProfit ? '+' : ''}${stats.totalPnlSol.toFixed(4)} SOL`;
  ctx.fillStyle = accentColor;
  roundRect(ctx, width / 2 - 160, 105, 320, 55, 12);
  ctx.fill();
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 30px Arial, sans-serif';
  ctx.fillText(pnlSolText, width / 2, 142);

  // USD equivalent
  if (stats.totalPnlUsd !== undefined) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '18px Arial, sans-serif';
    ctx.fillText(`~$${Math.abs(stats.totalPnlUsd).toFixed(2)} USD`, width / 2, 185);
  }

  // PnL percentage
  const pctText = stats.totalPnlPct !== undefined ? `${isProfit ? '+' : ''}${stats.totalPnlPct.toFixed(0)}%` : '';
  if (pctText) {
    ctx.fillStyle = accentColor;
    ctx.font = 'bold 22px Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`PNL  ${pctText}`, width - 60, 140);
    ctx.textAlign = 'center';
  }

  // Stats section
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath(); ctx.moveTo(60, 210); ctx.lineTo(width - 60, 210); ctx.stroke();

  const rows = [
    ['Total Trades', stats.totalTrades.toString()],
    ['Win Rate', `${stats.winRate.toFixed(0)}%`],
    ['Total Invested', `${stats.totalInvested.toFixed(2)} SOL`],
    ['Total Returned', `${stats.totalReturned.toFixed(2)} SOL`],
    ['Best Trade', stats.bestTrade ? `${stats.bestTrade.symbol} +${stats.bestTrade.pnlPct.toFixed(0)}%` : 'N/A'],
    ['Worst Trade', stats.worstTrade ? `${stats.worstTrade.symbol} ${stats.worstTrade.pnlPct.toFixed(0)}%` : 'N/A'],
  ];

  rows.forEach(([label, value], i) => {
    const y = 245 + i * 38;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '16px Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, 80, y);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(value, width - 80, y);
  });

  // Footer
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.font = '14px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`@${stats.username || 'trader'} | ${BOT_NAME}`, width / 2, height - 25);

  return canvas.toBuffer('image/png');
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function formatNumber(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function formatHoldTime(openedAt, closedAt) {
  const ms = (closedAt || new Date()) - new Date(openedAt);
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

module.exports = { generateTradeCard, generateMonthlyCard, formatHoldTime };
