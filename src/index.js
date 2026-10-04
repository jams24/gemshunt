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
const Pipeline = require('./services/pipeline');
const HealthMonitor = require('./services/healthMonitor');
const TradeEngine = require('./engine/tradeEngine');
const TelegramBot = require('./bot/telegramBot');

// A rejected promise anywhere must not take the bot down mid-position.
// Registered first so nothing during startup can escape it.
process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled rejection: ${err?.stack || err?.message || err}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err?.stack || err?.message || err}`);
});

const solanaConnection = () => new Connection(config.solana.rpcUrl, {
  commitment: 'confirmed',
  wsEndpoint: config.solana.wsUrl,
  // web3.js retries 429s internally with exponential backoff and no cap on
  // total time — a call could block for minutes. Callers here bound their
  // own waits, so fail fast and let them decide.
  disableRetryOnRateLimit: true,
});

async function main() {
  logger.info('Starting SolSniper...');
  await db.init();

  // Trading, wallets and analysis share one connection. The scanner gets its
  // own so it can be rebuilt when its websocket dies without disturbing the
  // tracker's wallet subscriptions or an in-flight trade.
  const connection = solanaConnection();

  // --- core services ---
  const walletManager = new WalletManager(connection, config.encryptionKey);
  const swapRouter = new SwapRouter(connection, { db });
  const analyzer = new Analyzer({ db, solanaConnection: connection, swapRouter });
  const engine = new TradeEngine({ swapRouter, walletManager, config });
  const scanner = new Scanner({
    connection: solanaConnection(),
    connectionFactory: solanaConnection,
    swapRouter, db, config,
  });
  const tracker = new Tracker({
    db, swapRouter, marketData: analyzer.market, connection, config,
  });

  const bot = new TelegramBot({
    tradeEngine: engine, walletManager, swapRouter, analyzer, tracker, config,
  });
  const alerter = new Alerter({ db, bot, config });
  const health = new HealthMonitor({ db, swapRouter, connection, config, bot, scanner, analyzer });
  const pipeline = new Pipeline({ analyzer, db, alerter, tracker, health, config });
  bot.attach({ scanner, health });

  // --- new token → analyze → persist → alert → re-check → track ---
  scanner.onNewToken = (raw) => pipeline.onDetected(raw);

  tracker.onSmartMoneyBuy = async (token, wallets) => {
    try {
      const info = await swapRouter.getTokenInfo(token.chain, token.mint).catch(() => null);
      await alerter.dispatchSmartMoney({ ...token, symbol: info?.symbol || token.mint.slice(0, 6) }, wallets);
    } catch (err) {
      logger.error(`[pipeline] smart-money alert: ${err.message}`);
    }
  };

  // --- position monitor (single-flight inside the engine) ---
  const positionTimer = setInterval(() => {
    engine.checkAllPositions().catch(err => logger.error(`[monitor] ${err.message}`));
  }, config.positionCheckIntervalSec * 1000);

  // --- verify the dependencies actually work before claiming to run ---
  // Quota exhaustion is the failure mode that hurts most: the endpoint stays
  // up, answers cheap calls, and refuses the ones detection depends on. The
  // process looks healthy while seeing nothing.
  const problems = await health.preflight();
  if (problems.length) {
    for (const p of problems) logger.error(`[preflight] ${p}`);
    if (config.health.failFast) {
      throw new Error(`Preflight failed:\n${problems.map(p => `  - ${p}`).join('\n')}`);
    }
    logger.warn('[preflight] starting anyway — set HEALTH_FAIL_FAST=true to refuse instead');
  } else {
    logger.info('[preflight] all dependencies healthy');
  }

  // --- start everything ---
  await bot.launch();
  await scanner.start();
  tracker.start();
  await tracker.startWalletWatching();
  health.start();

  if (config.telegram.adminId) {
    const { rows: [s] } = await db.query('SELECT COUNT(*)::int AS c FROM users');
    const { rows: [w] } = await db.query('SELECT COUNT(*)::int AS c FROM wallet_watch WHERE is_active');
    const enabled = Object.entries(CHAINS).filter(([k]) => scanner.enabled[k]);
    await bot.sendAlert(config.telegram.adminId,
      `🚀 <b>SolSniper online</b>\n\n` +
      `Scanning: ${enabled.map(([, c]) => `${c.emoji} ${c.name}`).join(' + ') || 'nothing (all scanners off)'}\n` +
      `Users: ${s.c}  ·  Tracked wallets: ${w.c}\n` +
      `Default alert score: ${config.alerts.minScore}  ·  Floor: ${config.alerts.floor}  ·  ` +
      `Re-checks at +${config.recheck.delaysMin.join('/+')}m\n` +
      `Fee: ${config.trading.platformFeePct}%\n\n` +
      `/health shows the live pipeline.` +
      (problems.length ? `\n\n⚠️ <b>Problems detected</b>\n${problems.map(p => `• ${p}`).join('\n')}` : '')
    );
  }

  logger.info('SolSniper running');

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} — shutting down`);
    clearInterval(positionTimer);
    pipeline.stop();
    scanner.stop();
    tracker.stop();
    health.stop();
    bot.stop();
    // Give in-flight DB writes a moment, but never hang the deploy.
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref?.();
    db.pool.end().catch(() => {}).finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
