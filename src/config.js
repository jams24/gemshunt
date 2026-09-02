require('dotenv').config();

const logger = require('./utils/logger');

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isInteger(v) ? v : def;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}

// ENCRYPTION_KEY is parsed as hex into a 32-byte AES-256 key. A 32-CHARACTER
// hex string is only 16 bytes and blows up inside createCipheriv at trade time
// rather than at boot, so validate the decoded length here.
function validateEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      'ENCRYPTION_KEY is required. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      `ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes), got ${key.length} chars. ` +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return key;
}

const config = {
  databaseUrl: req('DATABASE_URL'),
  encryptionKey: validateEncryptionKey(),

  solana: {
    rpcUrl: req('SOLANA_RPC_URL'),
    wsUrl: process.env.SOLANA_WS_URL || req('SOLANA_RPC_URL').replace(/^http/, 'ws'),
  },

  telegram: {
    token: req('TELEGRAM_BOT_TOKEN'),
    adminId: process.env.TELEGRAM_ADMIN_ID ? parseInt(process.env.TELEGRAM_ADMIN_ID, 10) : null,
  },

  trading: {
    maxBuyNative: num('MAX_BUY_SOL', 0.1),
    maxOpenPositions: int('MAX_OPEN_POSITIONS', 5),
    autoSell: bool('AUTO_SELL_ENABLED', true),
    slippageBps: int('DEFAULT_SLIPPAGE_BPS', 500),
    platformFeePct: num('PLATFORM_FEE_PCT', 1.0),
    feeWallet: process.env.FEE_WALLET_ADDRESS || null,
  },

  alerts: {
    // Only tokens scoring at or above this are pushed to subscribers.
    minScore: int('ALERT_MIN_SCORE', 60),
    minLiquidityNative: num('ALERT_MIN_LIQUIDITY', 5),
    // Hard ceiling on alerts per minute across all users, protects the bot
    // from a spam-launch wave burning the Telegram rate limit.
    maxPerMinute: int('ALERT_MAX_PER_MINUTE', 10),
  },

  tracker: {
    enabled: bool('TRACKER_ENABLED', true),
    snapshotIntervalSec: int('TRACKER_SNAPSHOT_INTERVAL', 120),
    trackHours: int('TRACKER_TRACK_HOURS', 24),
  },

  positionCheckIntervalSec: int('POSITION_CHECK_INTERVAL', 30),
};

module.exports = config;
module.exports.logger = logger;
