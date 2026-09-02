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
        closed_at TIMESTAMPTZ
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

    await migrate(client);
    logger.info('Database initialized');
  } finally {
    client.release();
  }
}

// Idempotent migrations. The bot is already deployed, so every change here has
// to survive being run against a database that may or may not already have it.
async function migrate(client) {
  // --- users: total_pnl_sol was written by closePosition but never existed ---
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS total_pnl_sol DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_min_score INTEGER DEFAULT 60;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_min_liquidity DOUBLE PRECISION DEFAULT 5;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_chains TEXT DEFAULT 'solana,robinhood';
  `);

  // --- positions: the old UNIQUE(user_id, mint, status) made it impossible to
  // close a second position in the same token (two 'closed' rows collide).
  // Replace with a partial unique index that only constrains OPEN positions,
  // and key it on chain too so the same address on two chains is distinct. ---
  await client.query(`ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_user_id_mint_status_key`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique_open
      ON positions(user_id, chain, mint) WHERE status = 'open'
  `);

  // token_amount is DOUBLE PRECISION, which silently loses precision above
  // 2^53 (~9e15). A 9-decimal token with a 1B supply is 1e18 raw units, so
  // hold the authoritative amount in NUMERIC and keep the float for display.
  await client.query(`
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS token_amount_raw NUMERIC;
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS decimals INTEGER DEFAULT 9;
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS token_amount_raw NUMERIC;
  `);

  // --- tokens: chain + scoring/analysis columns ---
  await client.query(`
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS chain TEXT DEFAULT 'solana';
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS decimals INTEGER DEFAULT 9;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS total_supply DOUBLE PRECISION;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS holder_count INTEGER;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS dev_holding_pct DOUBLE PRECISION;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lp_burned_pct DOUBLE PRECISION;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS honeypot BOOLEAN;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS score INTEGER;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS score_breakdown JSONB;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS thesis TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS alerted BOOLEAN DEFAULT FALSE;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS socials JSONB;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS peak_price_usd DOUBLE PRECISION;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS peak_multiple DOUBLE PRECISION;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS outcome TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS tracking_until TIMESTAMPTZ;
  `);

  // The old tokens table had UNIQUE(mint) only. Two chains can theoretically
  // collide, so widen it to (chain, mint).
  await client.query(`ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_mint_key`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_chain_mint ON tokens(chain, mint)`);

  // --- Phase 5: on-chain tracking + analytics ---
  await client.query(`
    CREATE TABLE IF NOT EXISTS token_snapshots (
      id SERIAL PRIMARY KEY,
      chain TEXT NOT NULL,
      mint TEXT NOT NULL,
      price_usd DOUBLE PRECISION,
      price_native DOUBLE PRECISION,
      liquidity_usd DOUBLE PRECISION,
      market_cap DOUBLE PRECISION,
      volume_5m DOUBLE PRECISION,
      buys_5m INTEGER,
      sells_5m INTEGER,
      holder_count INTEGER,
      taken_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_token ON token_snapshots(chain, mint, taken_at DESC);

    CREATE TABLE IF NOT EXISTS deployer_stats (
      id SERIAL PRIMARY KEY,
      chain TEXT NOT NULL,
      address TEXT NOT NULL,
      launches INTEGER DEFAULT 0,
      rugs INTEGER DEFAULT 0,
      runners INTEGER DEFAULT 0,
      best_multiple DOUBLE PRECISION DEFAULT 0,
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(chain, address)
    );

    CREATE TABLE IF NOT EXISTS wallet_watch (
      id SERIAL PRIMARY KEY,
      chain TEXT NOT NULL,
      address TEXT NOT NULL,
      label TEXT,
      added_by BIGINT,
      win_rate DOUBLE PRECISION,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(chain, address)
    );

    CREATE TABLE IF NOT EXISTS wallet_activity (
      id SERIAL PRIMARY KEY,
      chain TEXT NOT NULL,
      wallet TEXT NOT NULL,
      mint TEXT NOT NULL,
      direction TEXT NOT NULL,
      amount_native DOUBLE PRECISION,
      tx_signature TEXT,
      seen_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(chain, tx_signature, wallet, mint)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_activity_mint ON wallet_activity(chain, mint, seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_activity_wallet ON wallet_activity(chain, wallet, seen_at DESC);

    CREATE TABLE IF NOT EXISTS alerts_sent (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      chain TEXT NOT NULL,
      mint TEXT NOT NULL,
      score INTEGER,
      kind TEXT DEFAULT 'new_token',
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, chain, mint, kind)
    );
  `);

  logger.info('Migrations applied');
}

async function query(text, params) {
  return pool.query(text, params);
}

// ---------------------------------------------------------------- users

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
  if (!setClauses.length) return;
  values.push(telegramId);
  await pool.query(`UPDATE users SET ${setClauses.join(', ')} WHERE telegram_id = $${i}`, values);
}

// Users who should receive an alert for this token, per their own filters.
async function getAlertSubscribers(chain, score, liquidityNative) {
  const { rows } = await pool.query(
    `SELECT telegram_id, alert_min_score FROM users
     WHERE is_active = TRUE
       AND alerts_enabled = TRUE
       AND COALESCE(alert_min_score, 60) <= $2::int
       AND ($3::double precision IS NULL OR COALESCE(alert_min_liquidity, 0) <= $3::double precision)
       AND COALESCE(alert_chains, 'solana,robinhood') LIKE '%' || $1 || '%'`,
    // null liquidity means "unmeasured", not "zero" — do not filter on it.
    [chain, score, liquidityNative ?? null]
  );
  return rows;
}

// ---------------------------------------------------------------- tokens

async function saveToken(token) {
  const chain = token.chain || 'solana';
  const { rows } = await pool.query(
    `INSERT INTO tokens (
       chain, mint, symbol, name, deployer, pool_address, dex, liquidity_sol, initial_mc,
       lp_locked, mint_authority_revoked, freeze_authority_revoked, top_holder_pct, is_safe,
       decimals, total_supply, holder_count, dev_holding_pct, lp_burned_pct, honeypot,
       score, score_breakdown, thesis, socials, tracking_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (chain, mint) DO UPDATE SET
       symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
       name = COALESCE(EXCLUDED.name, tokens.name),
       liquidity_sol = EXCLUDED.liquidity_sol,
       initial_mc = EXCLUDED.initial_mc,
       lp_locked = EXCLUDED.lp_locked,
       mint_authority_revoked = EXCLUDED.mint_authority_revoked,
       freeze_authority_revoked = EXCLUDED.freeze_authority_revoked,
       top_holder_pct = EXCLUDED.top_holder_pct,
       is_safe = EXCLUDED.is_safe,
       decimals = EXCLUDED.decimals,
       total_supply = EXCLUDED.total_supply,
       holder_count = EXCLUDED.holder_count,
       dev_holding_pct = EXCLUDED.dev_holding_pct,
       lp_burned_pct = EXCLUDED.lp_burned_pct,
       honeypot = EXCLUDED.honeypot,
       score = EXCLUDED.score,
       score_breakdown = EXCLUDED.score_breakdown,
       thesis = EXCLUDED.thesis,
       socials = EXCLUDED.socials,
       tracking_until = EXCLUDED.tracking_until
     RETURNING *`,
    [chain, token.mint, token.symbol, token.name, token.deployer, token.poolAddress,
     token.dex || 'raydium', token.liquiditySol, token.initialMc,
     token.lpLocked, token.mintAuthorityRevoked, token.freezeAuthorityRevoked,
     token.topHolderPct, token.isSafe, token.decimals, token.totalSupply,
     token.holderCount, token.devHoldingPct, token.lpBurnedPct, token.honeypot,
     token.score, token.scoreBreakdown ? JSON.stringify(token.scoreBreakdown) : null,
     token.thesis, token.socials ? JSON.stringify(token.socials) : null,
     token.trackingUntil || null]
  );
  return rows[0];
}

async function getToken(chain, mint) {
  const { rows } = await pool.query(`SELECT * FROM tokens WHERE chain=$1 AND mint=$2`, [chain, mint]);
  return rows[0];
}

async function markTokenAlerted(chain, mint) {
  await pool.query(`UPDATE tokens SET alerted = TRUE WHERE chain=$1 AND mint=$2`, [chain, mint]);
}

async function getTokensToTrack() {
  const { rows } = await pool.query(
    `SELECT chain, mint, symbol, initial_mc, score FROM tokens
     WHERE tracking_until IS NOT NULL AND tracking_until > NOW()`
  );
  return rows;
}

async function updateTokenOutcome(chain, mint, updates) {
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(updates)) {
    setClauses.push(`${key} = $${i}`);
    values.push(val);
    i++;
  }
  if (!setClauses.length) return;
  values.push(chain, mint);
  await pool.query(
    `UPDATE tokens SET ${setClauses.join(', ')} WHERE chain = $${i} AND mint = $${i + 1}`,
    values
  );
}

// ---------------------------------------------------------------- positions

async function openPosition(userId, pos) {
  const { rows } = await pool.query(
    `INSERT INTO positions (user_id, chain, mint, symbol, entry_price_sol, entry_price_usd,
                            token_amount, token_amount_raw, decimals, sol_invested)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [userId, pos.chain || 'solana', pos.mint, pos.symbol, pos.entryPriceSol,
     pos.entryPriceUsd, pos.tokenAmount, String(pos.tokenAmountRaw ?? 0),
     pos.decimals ?? 9, pos.solInvested]
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
  if (!setClauses.length) return;
  values.push(posId);
  await pool.query(`UPDATE positions SET ${setClauses.join(', ')} WHERE id = $${i}`, values);
}

async function closePosition(posId, userId, solReceived, pnlSol, pnlPct) {
  await pool.query(
    `UPDATE positions SET status='closed', sol_received=$2, pnl_sol=$3, pnl_pct=$4, closed_at=NOW() WHERE id=$1`,
    [posId, solReceived, pnlSol, pnlPct]
  );
  // $2 must be cast: Postgres otherwise infers it as integer from `$2 > 0`
  // and rejects a fractional PnL outright.
  await pool.query(
    `UPDATE users SET
       total_trades = total_trades + 1,
       winning_trades = winning_trades + CASE WHEN $2::double precision > 0 THEN 1 ELSE 0 END,
       total_pnl_sol = COALESCE(total_pnl_sol, 0) + $2::double precision
     WHERE telegram_id = $1`,
    [userId, pnlSol]
  );
}

async function saveTrade(userId, trade) {
  const { rows } = await pool.query(
    `INSERT INTO trades (user_id, chain, mint, symbol, direction, sol_amount, token_amount,
                         token_amount_raw, price_sol, price_usd, tx_signature, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [userId, trade.chain || 'solana', trade.mint, trade.symbol, trade.direction,
     trade.solAmount, trade.tokenAmount, String(trade.tokenAmountRaw ?? 0),
     trade.priceSol, trade.priceUsd, trade.txSignature, trade.status || 'confirmed']
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
    `SELECT total_trades, winning_trades, total_pnl_usd, COALESCE(total_pnl_sol, 0) AS total_pnl_sol,
     (SELECT COUNT(*) FROM positions WHERE user_id=$1 AND status='open') as open_positions,
     (SELECT COALESCE(SUM(sol_invested), 0) FROM positions WHERE user_id=$1 AND status='open') as sol_in_positions
     FROM users WHERE telegram_id=$1`,
    [userId]
  );
  return rows[0];
}

// ---------------------------------------------------------------- analytics

async function saveSnapshot(snap) {
  await pool.query(
    `INSERT INTO token_snapshots (chain, mint, price_usd, price_native, liquidity_usd, market_cap, volume_5m, buys_5m, sells_5m, holder_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [snap.chain, snap.mint, snap.priceUsd, snap.priceNative, snap.liquidityUsd,
     snap.marketCap, snap.volume5m, snap.buys5m, snap.sells5m, snap.holderCount]
  );
}

async function getSnapshots(chain, mint, limit = 50) {
  const { rows } = await pool.query(
    `SELECT * FROM token_snapshots WHERE chain=$1 AND mint=$2 ORDER BY taken_at DESC LIMIT $3`,
    [chain, mint, limit]
  );
  return rows;
}

async function getDeployerStats(chain, address) {
  if (!address) return null;
  const { rows } = await pool.query(
    `SELECT * FROM deployer_stats WHERE chain=$1 AND address=$2`, [chain, address]
  );
  return rows[0];
}

async function recordDeployerLaunch(chain, address) {
  if (!address) return;
  await pool.query(
    `INSERT INTO deployer_stats (chain, address, launches) VALUES ($1,$2,1)
     ON CONFLICT (chain, address) DO UPDATE SET
       launches = deployer_stats.launches + 1, last_seen = NOW()`,
    [chain, address]
  );
}

async function recordDeployerOutcome(chain, address, outcome, multiple) {
  if (!address) return;
  const col = outcome === 'rug' ? 'rugs' : 'runners';
  await pool.query(
    `UPDATE deployer_stats SET ${col} = ${col} + 1,
       best_multiple = GREATEST(COALESCE(best_multiple, 0), $3), last_seen = NOW()
     WHERE chain=$1 AND address=$2`,
    [chain, address, multiple || 0]
  );
}

async function addWatchedWallet(chain, address, label, addedBy) {
  const { rows } = await pool.query(
    `INSERT INTO wallet_watch (chain, address, label, added_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (chain, address) DO UPDATE SET label = COALESCE($3, wallet_watch.label), is_active = TRUE
     RETURNING *`,
    [chain, address, label, addedBy]
  );
  return rows[0];
}

async function removeWatchedWallet(chain, address) {
  await pool.query(`UPDATE wallet_watch SET is_active=FALSE WHERE chain=$1 AND address=$2`, [chain, address]);
}

async function getWatchedWallets(chain) {
  const { rows } = chain
    ? await pool.query(`SELECT * FROM wallet_watch WHERE is_active=TRUE AND chain=$1`, [chain])
    : await pool.query(`SELECT * FROM wallet_watch WHERE is_active=TRUE`);
  return rows;
}

async function recordWalletActivity(act) {
  const { rows } = await pool.query(
    `INSERT INTO wallet_activity (chain, wallet, mint, direction, amount_native, tx_signature)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (chain, tx_signature, wallet, mint) DO NOTHING
     RETURNING *`,
    [act.chain, act.wallet, act.mint, act.direction, act.amountNative, act.txSignature]
  );
  return rows[0];
}

// How many distinct watched wallets bought this token recently. This is the
// smart-money confluence signal — 2+ is the highest-conviction alert we send.
async function countWatchersBought(chain, mint, withinMinutes = 60) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT wallet)::int AS n FROM wallet_activity
     WHERE chain=$1 AND mint=$2 AND direction='buy'
       AND seen_at > NOW() - ($3 || ' minutes')::interval`,
    [chain, mint, withinMinutes]
  );
  return rows[0]?.n || 0;
}

// The actual watched wallets that bought this token, for the alert body.
async function getWalletsBought(chain, mint, withinMinutes = 60) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (a.wallet) a.wallet AS address, w.label, a.amount_native, a.seen_at
     FROM wallet_activity a
     LEFT JOIN wallet_watch w ON w.chain = a.chain AND w.address = a.wallet
     WHERE a.chain=$1 AND a.mint=$2 AND a.direction='buy'
       AND a.seen_at > NOW() - ($3 || ' minutes')::interval
     ORDER BY a.wallet, a.seen_at DESC`,
    [chain, mint, withinMinutes]
  );
  return rows;
}

async function wasAlerted(userId, chain, mint, kind = 'new_token') {
  const { rows } = await pool.query(
    `SELECT 1 FROM alerts_sent WHERE user_id=$1 AND chain=$2 AND mint=$3 AND kind=$4`,
    [userId, chain, mint, kind]
  );
  return rows.length > 0;
}

async function recordAlert(userId, chain, mint, score, kind = 'new_token') {
  const { rows } = await pool.query(
    `INSERT INTO alerts_sent (user_id, chain, mint, score, kind) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, chain, mint, kind) DO NOTHING RETURNING *`,
    [userId, chain, mint, score, kind]
  );
  return rows[0];
}

// Hit rate by score band — tells us whether the thesis engine is actually right.
async function getScoreBandPerformance() {
  const { rows } = await pool.query(`
    SELECT
      CASE
        WHEN score >= 85 THEN '85-100'
        WHEN score >= 70 THEN '70-84'
        WHEN score >= 55 THEN '55-69'
        ELSE '0-54'
      END AS band,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE peak_multiple >= 2)::int AS hit_2x,
      COUNT(*) FILTER (WHERE peak_multiple >= 5)::int AS hit_5x,
      COUNT(*) FILTER (WHERE outcome = 'rug')::int AS rugs,
      ROUND(AVG(peak_multiple)::numeric, 2) AS avg_peak
    FROM tokens
    WHERE score IS NOT NULL AND peak_multiple IS NOT NULL
    GROUP BY band ORDER BY band DESC
  `);
  return rows;
}

module.exports = {
  init, query, pool,
  getOrCreateUser, getUser, updateUser, getAlertSubscribers,
  saveToken, getToken, markTokenAlerted, getTokensToTrack, updateTokenOutcome,
  openPosition, getUserPositions, getAllOpenPositions, updatePosition, closePosition,
  saveTrade, getUserClosedPositions, getUserStats,
  saveSnapshot, getSnapshots,
  getDeployerStats, recordDeployerLaunch, recordDeployerOutcome,
  addWatchedWallet, removeWatchedWallet, getWatchedWallets,
  recordWalletActivity, countWatchersBought, getWalletsBought,
  wasAlerted, recordAlert, getScoreBandPerformance,
};
