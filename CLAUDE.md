# Solana Sniper Bot

Multi-chain Telegram sniper bot for Solana and Robinhood Chain.

## Architecture
- **Node.js / CommonJS**
- **PostgreSQL** via `pg` — no ORM, migrations are idempotent `ALTER ... IF NOT EXISTS` in `db/database.js`
- **Telegraf** for Telegram
- **Jupiter v6** (Solana) and **Uniswap V4 / UniversalRouter** (Robinhood Chain) for swaps

The codebase is chain-agnostic by design: every chain-specific detail lives in
an adapter, and the layers above take a `chain` string. **Adding a chain should
mean adding one wallet adapter, one swap adapter, and one `CHAINS` entry —
nothing else.** If you find yourself writing `if (chain === 'solana')` outside
an adapter, that's the wrong layer.

## Key Files

| Path | Purpose |
|------|---------|
| `src/config.js` | Env parsing + fail-fast validation. Nothing reads `process.env` directly. |
| `src/index.js` | Wires services together, owns the pipeline and shutdown |
| `src/services/chains.js` | Per-chain constants (RPC, explorer, contracts) |
| `src/services/wallet/` | `index.js` router + `solanaAdapter` / `evmAdapter` |
| `src/services/swap/` | `index.js` router + `solanaSwap` (Jupiter) / `evmSwap` (Uniswap V4) |
| `src/analysis/` | Thesis engine: `safety`, `marketData`, `scorer`, `thesis` (rendering) |
| `src/services/scanner.js` | Watches both chains for new pools, emits one uniform event |
| `src/services/alerter.js` | Who gets alerted, dedupe, rate limiting |
| `src/services/tracker.js` | Snapshots alerted tokens, outcomes, smart-money watching |
| `src/engine/tradeEngine.js` | Buy/sell, position management, TP/SL |
| `src/bot/telegramBot.js` | Telegram commands |
| `test/run.js` | Integration tests (`npm test`, needs a scratch Postgres) |

## Pipeline

```
Scanner (new pool on any chain)
  → Analyzer   safety + market + deployer reputation + smart-money → 0-100 score
  → db.saveToken
  → Alerter    per-user filters, dedupe, rate limit → Telegram thesis + buy buttons
  → Tracker    snapshots for 24h → outcome (runner/rug) → deployer reputation
                                                              ↑ feeds the next score
```

The tracker loop is what makes scoring improve over time — it records what
happened to every alerted token whether or not anyone bought it. `/analytics`
shows hit rate by score band; if the high bands don't beat the low ones, the
weights in `analysis/scorer.js` need tuning.

## Scoring

Five weighted categories (`WEIGHTS` in `scorer.js`): safety 35, distribution 20,
liquidity 20, deployer 10, momentum 15.

Two rules matter more than the weights:
- **Categories with no data are dropped and the rest renormalised**, then the
  score is shrunk toward 50 in proportion to missing evidence. Without this, a
  token clearing two cheap on-chain checks with no market data scores 100.
  `analysis.rawScore` is the unshrunk value; `analysis.score` is what to use.
- **A honeypot scores 0** and a serial rugger takes a multiplicative penalty —
  neither can be outweighed by a clean contract, which any rugger can also ship.

The alerter additionally refuses to send anything below 50% confidence.

## Invariants

- **Token amounts are raw integers**, stored as `NUMERIC` (`token_amount_raw`)
  and handled as `BigInt`. `DOUBLE PRECISION` loses precision above 2^53 and
  meme token supplies exceed that routinely. `token_amount` is display only.
- **Position uniqueness is `(user_id, chain, mint) WHERE status = 'open'`** —
  a partial index. A plain unique constraint makes it impossible to close a
  second position in the same token.
- **`ENCRYPTION_KEY` is 64 hex chars.** It is validated at boot; changing it
  orphans every stored wallet.
- Private keys are AES-256-GCM encrypted at rest; decrypted signers are cached
  in memory with a 10-minute TTL and a bounded size.

## Modes
- **Paper mode** — no `WALLET_PRIVATE_KEY`; trades simulated in the DB
- **Live mode** — per-user wallets created/imported through the bot

## RPC
- Helius free tier (100K req/day) — WebSocket for pool detection
- Market data is DexScreener's free endpoint. Robinhood Chain is **not indexed
  there**, so EVM tokens score on on-chain signals only and lean on the
  confidence shrinkage above.

## Testing
```bash
createdb sniper_test
DATABASE_URL=postgresql://localhost/sniper_test npm test
```
Covers position accounting, the TP/SL ladder, raw-amount precision, alert
routing, and scoring calibration. Run it against a **scratch** database — it
writes freely.
