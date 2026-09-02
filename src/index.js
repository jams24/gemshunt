require('dotenv').config();
const { Connection } = require('@solana/web3.js');
const logger = require('./utils/logger');
const db = require('./db/database');
const JupiterService = require('./services/jupiter');
const WalletManager = require('./services/walletManager');
const RobinhoodSwapService = require('./services/robinhoodSwap');
const TokenScanner = require('./services/tokenScanner');
const TradeEngine = require('./engine/tradeEngine');
const TelegramBot = require('./bot/telegramBot');

async function main() {
  logger.info('Starting SolSniper Bot...');

  await db.init();

  const solConnection = new Connection(process.env.SOLANA_RPC_URL, {
    commitment: 'confirmed',
    wsEndpoint: process.env.SOLANA_WS_URL,
  });

  const walletManager = new WalletManager(solConnection);
  const jupiter = new JupiterService(solConnection);
  const robinhoodSwap = new RobinhoodSwapService();
  const engine = new TradeEngine(jupiter, walletManager, robinhoodSwap);
  const scanner = new TokenScanner(solConnection, db);
  const bot = new TelegramBot(engine, walletManager);

  // New token alerts to admin
  const adminId = parseInt(process.env.TELEGRAM_ADMIN_ID);

  scanner.onNewToken = async (tokenData) => {
    if (!adminId) return;
    await bot.sendAlert(adminId,
      `🔔 <b>New Token [Solana]</b>\n` +
      `<b>${tokenData.symbol}</b> | ${tokenData.isSafe ? '✅ Safe' : '⚠️ Risky'}\n` +
      `Liquidity: ${tokenData.liquiditySol.toFixed(2)} SOL\n` +
      `<code>${tokenData.mint}</code>\n\n` +
      `/buy ${tokenData.mint}`
    );
  };

  // Listen for Robinhood Chain new pairs
  robinhoodSwap.listenForNewPairs(async (tokenData) => {
    if (!adminId) return;
    await bot.sendAlert(adminId,
      `🔔 <b>New Token [Robinhood]</b>\n` +
      `<b>${tokenData.symbol}</b>\n` +
      `<code>${tokenData.mint}</code>\n\n` +
      `Switch to Robinhood chain, then:\n/buy ${tokenData.mint}`
    );
  });

  // Position monitor
  setInterval(async () => {
    try { await engine.checkAllPositions(); } catch (err) { logger.error(`Position check: ${err.message}`); }
  }, 30 * 1000);

  await bot.launch();
  await scanner.startListening();

  if (adminId) {
    const { rows: [s] } = await db.query(`SELECT COUNT(*) as c FROM users`);
    await bot.sendAlert(adminId,
      `🚀 <b>SolSniper Online</b>\n\n` +
      `Chains: ◎ Solana + 🪶 Robinhood\n` +
      `Users: ${s.c} | Fee: ${process.env.PLATFORM_FEE_PCT || 1}%\n` +
      `Listening for new pools...`
    );
  }

  logger.info('SolSniper running — Solana + Robinhood Chain');

  process.on('SIGINT', () => { bot.stop(); process.exit(0); });
}

main().catch(err => { logger.error(`Fatal: ${err.message}`); process.exit(1); });
