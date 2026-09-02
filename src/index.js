const config = require('./config');
const { Connection } = require('@solana/web3.js');
const logger = require('./utils/logger');
const db = require('./db/database');
const CHAINS = require('./services/chains');

const WalletManager = require('./services/wallet');
const SwapRouter = require('./services/swap');
const Analyzer = require('./analysis');
const Scanner = require('./services/scanner');
const Alerter = require('./services/alerter');
const Tracker = require('./services/tracker');
const TradeEngine = require('./engine/tradeEngine');
const TelegramBot = require('./bot/telegramBot');

async function main() {
  logger.info('Starting SolSniper...');
  await db.init();

  const connection = new Connection(config.solana.rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: config.solana.wsUrl,
  });

  // --- core services ---
  const walletManager = new WalletManager(connection, config.encryptionKey);
  const swapRouter = new SwapRouter(connection);
  const analyzer = new Analyzer({ db, solanaConnection: connection, swapRouter });
  const engine = new TradeEngine({ swapRouter, walletManager, config });
  const scanner = new Scanner({ connection, swapRouter, db });
  const tracker = new Tracker({
    db, swapRouter, marketData: analyzer.market, connection, config,
  });

  const bot = new TelegramBot({
    tradeEngine: engine, walletManager, swapRouter, analyzer, tracker, config,
  });
  const alerter = new Alerter({ db, bot, config });

  // --- new token → analyze → persist → alert → track ---
  scanner.onNewToken = async (raw) => {
    try {
      const { token, analysis } = await analyzer.analyze(raw);

      // Track anything worth alerting on, so we learn whether the thesis was
      // right even when nobody buys it.
      if (analysis.score >= config.alerts.minScore) {
        token.trackingUntil = tracker.trackingDeadline();
      }
      await db.saveToken(token);
      await alerter.dispatchNewToken(token, analysis);
    } catch (err) {
      logger.error(`[pipeline] ${raw.chain}/${raw.mint}: ${err.message}`);
    }
  };

  tracker.onSmartMoneyBuy = async (token, wallets) => {
    try {
      const info = await swapRouter.getTokenInfo(token.chain, token.mint).catch(() => null);
      await alerter.dispatchSmartMoney({ ...token, symbol: info?.symbol || token.mint.slice(0, 6) }, wallets);
    } catch (err) {
      logger.error(`[pipeline] smart-money alert: ${err.message}`);
    }
  };

  // --- position monitor ---
  const positionTimer = setInterval(() => {
    engine.checkAllPositions().catch(err => logger.error(`[monitor] ${err.message}`));
  }, config.positionCheckIntervalSec * 1000);

  // --- start everything ---
  await bot.launch();
  await scanner.start();
  tracker.start();
  await tracker.startWalletWatching();

  if (config.telegram.adminId) {
    const { rows: [s] } = await db.query('SELECT COUNT(*)::int AS c FROM users');
    const { rows: [w] } = await db.query('SELECT COUNT(*)::int AS c FROM wallet_watch WHERE is_active');
    await bot.sendAlert(config.telegram.adminId,
      `🚀 <b>SolSniper online</b>\n\n` +
      `Chains: ${Object.values(CHAINS).map(c => `${c.emoji} ${c.name}`).join(' + ')}\n` +
      `Users: ${s.c}  ·  Tracked wallets: ${w.c}\n` +
      `Alert threshold: ${config.alerts.minScore}/100  ·  Fee: ${config.trading.platformFeePct}%\n\n` +
      `Scanning for new pools.`
    );
  }

  logger.info('SolSniper running');

  const shutdown = (signal) => {
    logger.info(`${signal} — shutting down`);
    clearInterval(positionTimer);
    scanner.stop();
    tracker.stop();
    bot.stop();
    db.pool.end().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // A rejected promise anywhere must not take the bot down mid-position.
  process.on('unhandledRejection', (err) => {
    logger.error(`Unhandled rejection: ${err?.stack || err?.message || err}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err?.stack || err?.message || err}`);
  });
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
