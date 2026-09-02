const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username TEXT,
        active_chain TEXT DEFAULT 'solana',
        sol_wallet_address TEXT,
        sol_wallet_key_encrypted TEXT,
        evm_wallet_address TEXT,
        evm_wallet_key_encrypted TEXT,
        max_buy_amount DOUBLE PRECISION DEFAULT 0.1,
        slippage_bps INTEGER DEFAULT 500,
        auto_sell BOOLEAN DEFAULT TRUE,
        is_active BOOLEAN DEFAULT TRUE,
        referrer_id BIGINT,
        total_trades INTEGER DEFAULT 0,
        winning_trades INTEGER DEFAULT 0,
        total_pnl_usd DOUBLE PRECISION DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tokens (
        id SERIAL PRIMARY KEY,
        mint TEXT UNIQUE NOT NULL,
        symbol TEXT,
        name TEXT,
        deployer TEXT,
        pool_address TEXT,
        dex TEXT DEFAULT 'raydium',
        liquidity_sol DOUBLE PRECISION,
        initial_mc DOUBLE PRECISION,
        lp_locked BOOLEAN DEFAULT FALSE,
        mint_authority_revoked BOOLEAN DEFAULT FALSE,
        freeze_authority_revoked BOOLEAN DEFAULT FALSE,
        top_holder_pct DOUBLE PRECISION,
        is_safe BOOLEAN DEFAULT FALSE,
        detected_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS positions (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(telegram_id),
        chain TEXT DEFAULT 'solana',
        mint TEXT NOT NULL,
        symbol TEXT,
        entry_price_sol DOUBLE PRECISION,
        entry_price_usd DOUBLE PRECISION,
        token_amount DOUBLE PRECISION,
        sol_invested DOUBLE PRECISION,
        sol_received DOUBLE PRECISION DEFAULT 0,
        current_price_sol DOUBLE PRECISION,
        current_mc DOUBLE PRECISION,
        peak_mc DOUBLE PRECISION DEFAULT 0,
        pnl_sol DOUBLE PRECISION DEFAULT 0,
        pnl_pct DOUBLE PRECISION DEFAULT 0,
        status TEXT DEFAULT 'open',
        tp1_hit BOOLEAN DEFAULT FALSE,
        tp2_hit BOOLEAN DEFAULT FALSE,
        tp3_hit BOOLEAN DEFAULT FALSE,
        opened_at TIMESTAMPTZ DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        UNIQUE(user_id, mint, status)
      );

      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(telegram_id),
        chain TEXT DEFAULT 'solana',
        mint TEXT NOT NULL,
        symbol TEXT,
        direction TEXT NOT NULL DEFAULT 'buy',
        sol_amount DOUBLE PRECISION,
        token_amount DOUBLE PRECISION,
        price_sol DOUBLE PRECISION,
        price_usd DOUBLE PRECISION,
        tx_signature TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS fee_ledger (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(telegram_id),
        fee_amount DOUBLE PRECISION NOT NULL,
        referrer_id BIGINT,
        referrer_share DOUBLE PRECISION DEFAULT 0,
        paid_out BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_positions_user_status ON positions(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
      CREATE INDEX IF NOT EXISTS idx_tokens_detected ON tokens(detected_at);
      CREATE INDEX IF NOT EXISTS idx_fee_ledger_user ON fee_ledger(user_id);
      CREATE INDEX IF NOT EXISTS idx_fee_ledger_referrer ON fee_ledger(referrer_id);
    `);
    logger.info('Database initialized');
  } finally {
    client.release();
  }
}

async function query(text, params) {
  return pool.query(text, params);
}

// User functions
async function getOrCreateUser(telegramId, username) {
  const { rows } = await pool.query(
    `INSERT INTO users (telegram_id, username) VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET username = COALESCE($2, users.username)
     RETURNING *`,
    [telegramId, username]
  );
  return rows[0];
}

async function getUser(telegramId) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
  return rows[0];
}

async function updateUser(telegramId, updates) {
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(updates)) {
    setClauses.push(`${key} = $${i}`);
    values.push(val);
    i++;
  }
  values.push(telegramId);
  await pool.query(`UPDATE users SET ${setClauses.join(', ')} WHERE telegram_id = $${i}`, values);
}

// Token functions
async function saveToken(token) {
  const { rows } = await pool.query(
    `INSERT INTO tokens (mint, symbol, name, deployer, pool_address, dex, liquidity_sol, initial_mc, lp_locked, mint_authority_revoked, freeze_authority_revoked, top_holder_pct, is_safe)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (mint) DO UPDATE SET liquidity_sol=$7, initial_mc=$8, lp_locked=$9, mint_authority_revoked=$10, freeze_authority_revoked=$11, top_holder_pct=$12, is_safe=$13
     RETURNING *`,
    [token.mint, token.symbol, token.name, token.deployer, token.poolAddress, token.dex || 'raydium',
     token.liquiditySol, token.initialMc, token.lpLocked, token.mintAuthorityRevoked,
     token.freezeAuthorityRevoked, token.topHolderPct, token.isSafe]
  );
  return rows[0];
}

// Position functions
async function openPosition(userId, pos) {
  const { rows } = await pool.query(
    `INSERT INTO positions (user_id, mint, symbol, entry_price_sol, entry_price_usd, token_amount, sol_invested)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, pos.mint, pos.symbol, pos.entryPriceSol, pos.entryPriceUsd, pos.tokenAmount, pos.solInvested]
  );
  return rows[0];
}

async function getUserPositions(userId, status = 'open') {
  const { rows } = await pool.query(
    `SELECT * FROM positions WHERE user_id = $1 AND status = $2 ORDER BY opened_at`, [userId, status]
  );
  return rows;
}

async function getAllOpenPositions() {
  const { rows } = await pool.query(`SELECT * FROM positions WHERE status = 'open'`);
  return rows;
}

async function updatePosition(posId, updates) {
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(updates)) {
    setClauses.push(`${key} = $${i}`);
    values.push(val);
    i++;
  }
  values.push(posId);
  await pool.query(`UPDATE positions SET ${setClauses.join(', ')} WHERE id = $${i}`, values);
}

async function closePosition(posId, userId, solReceived, pnlSol, pnlPct) {
  await pool.query(
    `UPDATE positions SET status='closed', sol_received=$2, pnl_sol=$3, pnl_pct=$4, closed_at=NOW() WHERE id=$1`,
    [posId, solReceived, pnlSol, pnlPct]
  );
  const isWin = pnlSol > 0;
  await pool.query(
    `UPDATE users SET total_trades=total_trades+1, winning_trades=winning_trades+${isWin ? 1 : 0},
     total_pnl_sol=total_pnl_sol+$2 WHERE telegram_id=$1`,
    [userId, pnlSol]
  );
}

async function saveTrade(userId, trade) {
  const { rows } = await pool.query(
    `INSERT INTO trades (user_id, mint, symbol, direction, sol_amount, token_amount, price_sol, price_usd, tx_signature, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [userId, trade.mint, trade.symbol, trade.direction, trade.solAmount, trade.tokenAmount, trade.priceSol, trade.priceUsd, trade.txSignature, trade.status || 'confirmed']
  );
  return rows[0];
}

async function getUserClosedPositions(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM positions WHERE user_id=$1 AND status='closed' ORDER BY closed_at DESC LIMIT $2`, [userId, limit]
  );
  return rows;
}

async function getUserStats(userId) {
  const { rows } = await pool.query(
    `SELECT total_trades, winning_trades, total_pnl_usd,
     (SELECT COUNT(*) FROM positions WHERE user_id=$1 AND status='open') as open_positions,
     (SELECT COALESCE(SUM(sol_invested), 0) FROM positions WHERE user_id=$1 AND status='open') as sol_in_positions
     FROM users WHERE telegram_id=$1`,
    [userId]
  );
  return rows[0];
}

module.exports = {
  init, query, pool,
  getOrCreateUser, getUser, updateUser,
  saveToken,
  openPosition, getUserPositions, getAllOpenPositions, updatePosition, closePosition,
  saveTrade, getUserClosedPositions, getUserStats,
};
