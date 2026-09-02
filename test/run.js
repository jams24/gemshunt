/**
 * Integration tests. Requires a scratch Postgres database:
 *   createdb sniper_test && DATABASE_URL=postgresql://localhost/sniper_test node test/run.js
 *
 * These cover the parts where a bug costs real money: position accounting,
 * the TP/SL ladder, raw-amount precision, and who gets alerted.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/sniper_test';

const db = require('../src/db/database');
const TradeEngine = require('../src/engine/tradeEngine');
const Alerter = require('../src/services/alerter');
const Tracker = require('../src/services/tracker');
const Scorer = require('../src/analysis/scorer');

let pass = 0, fail = 0, group = '';
const section = (n) => { group = n; console.log(`\n${n}`); };
async function t(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
const eq = (a, b, msg) => { if (String(a) !== String(b)) throw new Error(`${msg}: got ${a}, want ${b}`); };

// --- mocks -----------------------------------------------------------------
function mockSwap(state) {
  return {
    chains: () => ['solana', 'robinhood'],
    buy: async () => ({ signature: 'buysig', rawOutput: 10n ** 18n }),
    sell: async (chain, signer, mint, raw) => {
      state.sells.push({ mint, raw: raw.toString() });
      return { signature: 'sellsig', rawOutput: BigInt(Math.floor(Number(raw) / 1e18 * 5e8)) };
    },
    getPrice: async () => state.priceUsd,
    getTokenInfo: async () => ({ symbol: 'TST', decimals: 18 }),
    getNativePriceUsd: async () => 150,
    fromRawNative: (chain, raw) => Number(raw) / 1e9,
  };
}
const mockWallets = { getBalance: async () => 10, getSigner: () => ({}) };
const tradingConfig = { trading: { maxOpenPositions: 5, maxBuyNative: 0.1, slippageBps: 500, platformFeePct: 1 } };

// --- suites ----------------------------------------------------------------

async function positionAccounting() {
  section('Position accounting');
  await db.getOrCreateUser(101, 'acct');

  await t('close records fractional PnL (regression: total_pnl_sol was an int cast)', async () => {
    const p = await db.openPosition(101, { chain: 'solana', mint: 'A1', entryPriceSol: 0.001, tokenAmount: 1000, tokenAmountRaw: '1000000000000', decimals: 9, solInvested: 0.1 });
    await db.closePosition(p.id, 101, 0.25, 0.15, 150);
    const u = await db.getUser(101);
    if (Math.abs(u.total_pnl_sol - 0.15) > 1e-9) throw new Error(`pnl ${u.total_pnl_sol}`);
    eq(u.winning_trades, 1, 'wins');
  });

  await t('same token can be traded twice (regression: UNIQUE(user,mint,status))', async () => {
    const p = await db.openPosition(101, { chain: 'solana', mint: 'A1', entryPriceSol: 0.002, tokenAmount: 500, tokenAmountRaw: '500', decimals: 9, solInvested: 0.1 });
    await db.closePosition(p.id, 101, 0.05, -0.05, -50);
  });

  await t('two OPEN positions in one token are still rejected', async () => {
    await db.openPosition(101, { chain: 'solana', mint: 'A2', entryPriceSol: 1, tokenAmount: 1, tokenAmountRaw: '1', decimals: 9, solInvested: 0.1 });
    try {
      await db.openPosition(101, { chain: 'solana', mint: 'A2', entryPriceSol: 1, tokenAmount: 1, tokenAmountRaw: '1', decimals: 9, solInvested: 0.1 });
    } catch (e) {
      if (/duplicate key/.test(e.message)) return;
      throw e;
    }
    throw new Error('duplicate open position was allowed');
  });

  await t('the same address on two chains is a separate position', async () => {
    await db.openPosition(101, { chain: 'robinhood', mint: 'A2', entryPriceSol: 1, tokenAmount: 1, tokenAmountRaw: '1', decimals: 18, solInvested: 0.1 });
  });

  await t('raw amounts above 2^53 survive exactly (regression: DOUBLE PRECISION)', async () => {
    const raw = '999999999999999999';
    await db.openPosition(101, { chain: 'solana', mint: 'BIG', entryPriceSol: 1e-15, tokenAmount: 1e9, tokenAmountRaw: raw, decimals: 9, solInvested: 0.1 });
    const back = (await db.getUserPositions(101, 'open')).find(p => p.mint === 'BIG');
    eq(back.token_amount_raw, raw, 'raw amount');
    if (BigInt(back.token_amount_raw) !== BigInt(raw)) throw new Error('BigInt mismatch');
  });
}

async function tradeLadder() {
  section('Buy / sell / TP / SL');
  const state = { sells: [], priceUsd: 150 };
  const engine = new TradeEngine({ swapRouter: mockSwap(state), walletManager: mockWallets, config: tradingConfig });

  await db.getOrCreateUser(102, 'ladder');
  await db.updateUser(102, { sol_wallet_address: 'A', sol_wallet_key_encrypted: 'e', auto_sell: true });

  await t('buy stores the exact raw output', async () => {
    await engine.buyToken(102, 'LADDER', 1, 'solana');
    const p = (await db.getUserPositions(102, 'open'))[0];
    eq(p.token_amount_raw, '1000000000000000000', 'raw');
    eq(p.decimals, 18, 'decimals');
  });

  await t('sell passes the mint through (regression: arg was omitted)', async () => {
    const u = await db.getUser(102);
    await engine._executeSell((await db.getUserPositions(102, 'open'))[0], u, 0.3, 'TP1', 500);
    eq(state.sells.at(-1).mint, 'LADDER', 'mint');
  });

  await t('30% sell leaves exactly 70%', async () => {
    eq(state.sells.at(-1).raw, '300000000000000000', 'sold');
    eq((await db.getUserPositions(102, 'open'))[0].token_amount_raw, '700000000000000000', 'remaining');
  });

  await t('a second 30% compounds off the remainder, not the original', async () => {
    const u = await db.getUser(102);
    await engine._executeSell((await db.getUserPositions(102, 'open'))[0], u, 0.3, 'TP2', 500);
    eq(state.sells.at(-1).raw, '210000000000000000', 'sold');
    eq((await db.getUserPositions(102, 'open'))[0].token_amount_raw, '490000000000000000', 'remaining');
  });

  await t('a full exit dumps the whole remainder with no dust', async () => {
    const u = await db.getUser(102);
    const r = await engine._executeSell((await db.getUserPositions(102, 'open'))[0], u, 1.0, 'TP3', 500);
    eq(state.sells.at(-1).raw, '490000000000000000', 'sold');
    if (!r.closed) throw new Error('position not closed');
    eq((await db.getUserPositions(102, 'open')).length, 0, 'open count');
  });

  await t('proceeds from every partial are summed into the close', async () => {
    const p = (await db.getUserClosedPositions(102, 1))[0];
    if (Math.abs(p.sol_received - 0.5) > 1e-9) throw new Error(`received ${p.sol_received}`);
  });

  // Ladder via the monitor. Entry is 1 SOL/token, native price is $150.
  await t('monitor: below 2x nothing fires', async () => {
    await engine.buyToken(102, 'MON', 1, 'solana');
    state.priceUsd = 150 * 1.8;
    await engine.checkAllPositions();
    const p = (await db.getUserPositions(102, 'open'))[0];
    if (p.tp1_hit) throw new Error('TP1 fired at 1.8x');
    if (Math.abs(p.pnl_pct - 80) > 1) throw new Error(`pnl% ${p.pnl_pct}`);
  });

  await t('monitor: 2x fires TP1 only', async () => {
    state.priceUsd = 150 * 2.5;
    await engine.checkAllPositions();
    const p = (await db.getUserPositions(102, 'open'))[0];
    if (!p.tp1_hit) throw new Error('TP1 missed');
    if (p.tp2_hit) throw new Error('TP2 fired early');
    eq(p.token_amount_raw, '700000000000000000', 'remaining');
  });

  await t('monitor: 5x fires TP2', async () => {
    state.priceUsd = 150 * 5.5;
    await engine.checkAllPositions();
    const p = (await db.getUserPositions(102, 'open'))[0];
    if (!p.tp2_hit) throw new Error('TP2 missed');
    eq(p.token_amount_raw, '490000000000000000', 'remaining');
  });

  await t('monitor: 10x closes the position', async () => {
    state.priceUsd = 150 * 11;
    await engine.checkAllPositions();
    eq((await db.getUserPositions(102, 'open')).length, 0, 'open count');
  });

  await t('monitor: stop-loss closes a loser', async () => {
    await engine.buyToken(102, 'LOSER', 1, 'solana');
    state.priceUsd = 150 * 0.45;
    await engine.checkAllPositions();
    eq((await db.getUserPositions(102, 'open')).length, 0, 'open count');
    const p = (await db.getUserClosedPositions(102, 1))[0];
    if (p.pnl_sol >= 0) throw new Error('expected a loss');
  });

  await t('auto_sell off disables the ladder but still tracks PnL', async () => {
    await db.updateUser(102, { auto_sell: false });
    await engine.buyToken(102, 'MANUAL', 1, 'solana');
    state.priceUsd = 150 * 20;
    await engine.checkAllPositions();
    const p = (await db.getUserPositions(102, 'open'))[0];
    if (!p) throw new Error('position closed despite auto_sell off');
    if (p.tp1_hit) throw new Error('TP fired with auto_sell off');
    if (p.pnl_pct < 1000) throw new Error(`pnl not tracked: ${p.pnl_pct}`);
  });

  await t('buying on a chain with no wallet gives an actionable error', async () => {
    try { await engine.buyToken(102, 'X', 0.1, 'robinhood'); }
    catch (e) {
      if (/Robinhood.*wallet/i.test(e.message)) return;
      throw new Error(`unclear error: ${e.message}`);
    }
    throw new Error('should have thrown');
  });
}

async function alerts() {
  section('Alert routing');
  const sent = [];
  const bot = { sendAlert: async (id, txt, extra) => sent.push({ id: Number(id), txt, extra }) };
  const config = {
    alerts: { minScore: 60, minLiquidityNative: 5, maxPerMinute: 3 },
    tracker: { enabled: true, snapshotIntervalSec: 120, trackHours: 24 },
  };
  const alerter = new Alerter({ db, bot, config });

  // Users created by earlier suites are valid subscribers too — silence them
  // so this suite asserts on a known audience.
  await db.query('UPDATE users SET alerts_enabled = FALSE');
  for (const id of [201, 202, 203]) await db.getOrCreateUser(id, `u${id}`);
  await db.query('UPDATE users SET alerts_enabled = TRUE WHERE telegram_id IN (201, 202)');
  await db.updateUser(201, { alert_min_score: 60, alert_min_liquidity: 0 });
  await db.updateUser(202, { alert_min_score: 85, alert_min_liquidity: 0 });
  await db.updateUser(203, { alerts_enabled: false });

  const token = (mint, extra = {}) => ({
    chain: 'solana', mint, symbol: `S${mint}`, liquiditySol: 50,
    market: { liquidityUsd: 50000, marketCap: 1e6 }, watcherBuys: 0, ...extra,
  });
  const analysis = (score, confidence = 0.9) => ({
    score, confidence, verdict: 'STRONG', bulls: ['x'], bears: [], categories: { safety: 100 },
  });

  await t('below threshold reaches nobody', async () => {
    eq(await alerter.dispatchNewToken(token('LOW'), analysis(40)), 0, 'sent');
  });
  await t('score 70 reaches only the user whose minimum it clears', async () => {
    sent.length = 0;
    eq(await alerter.dispatchNewToken(token('MID'), analysis(70)), 1, 'sent');
    eq(sent[0].id, 201, 'recipient');
  });
  await t('score 90 reaches both subscribed users', async () => {
    sent.length = 0;
    eq(await alerter.dispatchNewToken(token('HIGH'), analysis(90)), 2, 'sent');
  });
  await t('a muted user never receives anything', async () => {
    if (sent.some(s => s.id === 203)) throw new Error('muted user was alerted');
  });
  await t('the same token is never sent twice', async () => {
    eq(await alerter.dispatchNewToken(token('HIGH'), analysis(90)), 0, 'resent');
  });
  await t('a high score on thin evidence is withheld', async () => {
    eq(await alerter.dispatchNewToken(token('THIN'), analysis(95, 0.35)), 0, 'sent');
  });
  await t('alerts carry chain-tagged inline buy buttons', async () => {
    sent.length = 0;
    await alerter.dispatchNewToken(token('BTN'), analysis(90));
    const btn = sent[0].extra.reply_markup.inline_keyboard[0][0];
    if (!btn.callback_data.startsWith('abuy_solana_BTN_')) throw new Error(btn.callback_data);
  });
  await t('routine alerts respect the rate limit', async () => {
    alerter.sentThisMinute = 0;
    for (const m of ['R1', 'R2', 'R3', 'R4', 'R5']) await alerter.dispatchNewToken(token(m), analysis(90));
    if (alerter.sentThisMinute > config.alerts.maxPerMinute) throw new Error(`over limit: ${alerter.sentThisMinute}`);
  });
  await t('smart-money confluence bypasses the rate limit', async () => {
    alerter.sentThisMinute = 99;
    if (await alerter.dispatchNewToken(token('SMART', { watcherBuys: 3 }), analysis(90)) === 0) {
      throw new Error('smart money was rate limited');
    }
  });
  // User 201 requires 5 native liquidity; 202 requires none. Assert on 201.
  await t('unmeasured liquidity does not filter a user out', async () => {
    await db.updateUser(201, { alert_min_liquidity: 5, alert_chains: 'solana,robinhood' });
    const subs = await db.getAlertSubscribers('robinhood', 90, null);
    if (!subs.some(s => Number(s.telegram_id) === 201)) {
      throw new Error('a token with unknown liquidity was withheld from a subscriber');
    }
  });
  await t('measured-but-thin liquidity does filter out', async () => {
    const subs = await db.getAlertSubscribers('solana', 90, 1);
    if (subs.some(s => Number(s.telegram_id) === 201)) {
      throw new Error('1 native liquidity should be below the subscriber minimum of 5');
    }
  });
}

async function trackingAndScoring() {
  section('Tracking, deployer reputation, scoring');
  const market = { getPairData: async () => market._data };
  market._data = { priceUsd: 0.001, liquidityUsd: 50000, marketCap: 1e6, volume5m: 1, buys5m: 1, sells5m: 1 };
  const swap = { getNativePriceUsd: async () => 150, getPrice: async () => market._data.priceUsd };
  const config = { tracker: { enabled: true, snapshotIntervalSec: 120, trackHours: 24 } };
  const tracker = new Tracker({ db, swapRouter: swap, marketData: market, connection: null, config });

  await t('a 5x run is recorded as a runner and credited to the deployer', async () => {
    await db.saveToken({ chain: 'solana', mint: 'RUN', symbol: 'RUN', deployer: 'DEVX', score: 90, trackingUntil: tracker.trackingDeadline() });
    await db.recordDeployerLaunch('solana', 'DEVX');
    await tracker.snapshotOne({ chain: 'solana', mint: 'RUN' });
    market._data = { priceUsd: 0.005, liquidityUsd: 50000, marketCap: 5e6, volume5m: 1, buys5m: 1, sells5m: 1 };
    await tracker.snapshotOne({ chain: 'solana', mint: 'RUN' });
    const tk = await db.getToken('solana', 'RUN');
    eq(tk.outcome, 'runner', 'outcome');
    if (Math.abs(tk.peak_multiple - 5) > 0.01) throw new Error(`peak ${tk.peak_multiple}`);
    eq((await db.getDeployerStats('solana', 'DEVX')).runners, 1, 'runners');
  });

  await t('vanished liquidity is recorded as a rug', async () => {
    market._data = { priceUsd: 0.001, liquidityUsd: 50000, marketCap: 1e6, volume5m: 1, buys5m: 1, sells5m: 1 };
    await db.saveToken({ chain: 'solana', mint: 'RUG', symbol: 'RUG', deployer: 'DEVY', score: 70, trackingUntil: tracker.trackingDeadline() });
    await db.recordDeployerLaunch('solana', 'DEVY');
    await tracker.snapshotOne({ chain: 'solana', mint: 'RUG' });
    market._data = { priceUsd: 0.00001, liquidityUsd: 50, marketCap: 100, volume5m: 0, buys5m: 0, sells5m: 9 };
    await tracker.snapshotOne({ chain: 'solana', mint: 'RUG' });
    eq((await db.getToken('solana', 'RUG')).outcome, 'rug', 'outcome');
    eq((await db.getDeployerStats('solana', 'DEVY')).rugs, 1, 'rugs');
  });

  const scorer = new Scorer(db);
  const cleanToken = {
    chain: 'solana', mint: 'X',
    safety: { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, topHolderPct: 25, devHoldingPct: 5, honeypot: false, sellTaxPct: 2, flags: [] },
    market: { liquidityUsd: 50000, marketCap: 500000, buys5m: 30, sells5m: 10, volume5m: 20000, socials: null, boosts: 0 },
    liquidityNative: 100, nativePriceUsd: 150,
  };

  await t('a honeypot scores zero regardless of everything else', async () => {
    const r = await scorer.score({ ...cleanToken, safety: { ...cleanToken.safety, honeypot: true, flags: ['cannot sell'] } });
    eq(r.score, 0, 'score');
    if (!/HONEYPOT/.test(r.verdict)) throw new Error(r.verdict);
  });

  await t('missing signals shrink the score toward neutral', async () => {
    const thin = await scorer.score({
      chain: 'robinhood', mint: 'T',
      safety: { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, topHolderPct: null, honeypot: false, sellTaxPct: 1, flags: [] },
      market: null, liquidityNative: null, nativePriceUsd: 2500,
    });
    if (thin.rawScore !== 100) throw new Error(`raw ${thin.rawScore}`);
    if (thin.score >= 80) throw new Error(`unshrunk score ${thin.score} on ${thin.confidence} confidence`);
  });

  await t('a serial rugger is pushed below the alert threshold', async () => {
    await db.recordDeployerLaunch('solana', 'SERIAL');
    for (let i = 0; i < 4; i++) await db.recordDeployerOutcome('solana', 'SERIAL', 'rug', 0.2);
    const clean = await scorer.score({ ...cleanToken, deployer: 'NOBODY' });
    const rugger = await scorer.score({ ...cleanToken, deployer: 'SERIAL' });
    if (clean.score < 70) throw new Error(`baseline too low: ${clean.score}`);
    if (rugger.score >= 60) throw new Error(`serial rugger still alertable at ${rugger.score}`);
  });

  await t('a proven deployer scores above an unknown one', async () => {
    const unknown = await scorer.score({ ...cleanToken, deployer: 'NOBODY' });
    const proven = await scorer.score({ ...cleanToken, deployer: 'DEVX' });
    if (proven.score <= unknown.score) throw new Error(`${proven.score} <= ${unknown.score}`);
  });

  await t('smart-money confluence is surfaced as the lead bull point', async () => {
    const r = await scorer.score({ ...cleanToken, watcherBuys: 3 });
    if (!/tracked smart-money/.test(r.bulls[0])) throw new Error(r.bulls[0]);
  });
}

async function smartMoney() {
  section('Smart-money confluence');
  await t('distinct watched wallets buying one token are counted once each', async () => {
    await db.recordWalletActivity({ chain: 'solana', wallet: 'W1', mint: 'HOT', direction: 'buy', amountNative: 1, txSignature: 's1' });
    await db.recordWalletActivity({ chain: 'solana', wallet: 'W2', mint: 'HOT', direction: 'buy', amountNative: 2, txSignature: 's2' });
    await db.recordWalletActivity({ chain: 'solana', wallet: 'W1', mint: 'HOT', direction: 'buy', amountNative: 1, txSignature: 's1' });
    eq(await db.countWatchersBought('solana', 'HOT', 60), 2, 'distinct buyers');
    eq((await db.getWalletsBought('solana', 'HOT', 60)).length, 2, 'wallet rows');
  });
  await t('score-band analytics group tracked outcomes', async () => {
    const bands = await db.getScoreBandPerformance();
    if (!bands.length) throw new Error('no bands returned');
  });
}

(async () => {
  await db.init();
  await positionAccounting();
  await tradeLadder();
  await alerts();
  await trackingAndScoring();
  await smartMoney();
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
