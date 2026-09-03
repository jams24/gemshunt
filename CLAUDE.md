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

## Chain gotchas that caused real outages

- **Uniswap V4 pool keys cannot be guessed.** Fee and tickSpacing vary per pool
  (observed: fee 2500/9000/38000/810000/813690, spacing 25/60/90/200/19988), and
  most pools pair against **native ETH `address(0)`, not WETH**. The key is only
  learned from the `Initialize` event, so the scanner records it and it is
  persisted in `tokens.pool_key`. A wrong key addresses a pool that does not
  exist and every quote reverts.
- **`V4Quoter.quoteExactInputSingle` takes no `poolManager` field.** Its struct
  is `{PoolKey, bool, uint128, bytes}`. Adding one changes the selector to
  0xc10cb6f6, which the deployed contract does not implement, so every call
  reverts with no data.
- **V4 fees are hundredths of a bip**, so `fee: 813690` is an 81% swap fee —
  normal for a launch pool whose fee decays. That is a tax, not a honeypot.
- **Jupiter retired `quote-api.jup.ag/v6` and `price.jup.ag`.** Current free
  endpoints are `lite-api.jup.ag/swap/v1` and `lite-api.jup.ag/price/v3`
  (note: v3 returns `usdPrice` at the top level, not `data[mint].price`).
- **Alchemy's free tier caps `eth_getLogs` to a 10-block range**, so historical
  log scans need paging; live subscriptions are unaffected.

## Sellability is three-valued

`checkSellable` returns `true`, `false`, or **`null` for unknown**, and
`safety.honeypot` carries the same three states. Never collapse null into
false. Both chains once did, and the result was that *every* token scored 0 as
a honeypot the moment an endpoint moved or a pool key was wrong — the bot went
completely silent while looking like it was working. A failed probe degrades
confidence; only a sell quote that reverts while a buy quote succeeds is a
honeypot.

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
- **Robinhood Chain's public RPC rate-limits hard.** All EVM traffic goes
  through the single shared, throttled provider in `services/evmProvider.js`:
  requests are serialised with a minimum spacing, 429s back off, and a breaker
  pauses chain polling after repeated limits. Never construct a
  `JsonRpcProvider` directly — use `getEvmProvider()`, or you reintroduce a
  second independent polling loop. Ethers' own FetchRequest retry is capped at
  1 attempt there; leaving it at the default made a single 429 block the caller
  for minutes and surface as "exceeded maximum retry limit".
  Set `ROBINHOOD_RPC_URL` to a private endpoint to avoid the limits entirely.
- **Pool detection prefers WebSockets.** With `ROBINHOOD_WS_URL` set (or
  derivable from `ROBINHOOD_RPC_URL`), `ReconnectingLogWatcher` subscribes to
  V4 `Initialize` events and the chain pushes them as they land — near-instant
  and free of polling requests. Without one it falls back to HTTP polling and
  is up to one interval late on every pool.
  Two non-obvious constraints in that watcher, both of which crashed the
  process before they were handled: ethers assigns its own socket handlers, so
  ours must chain onto them rather than replace them (replacing them silently
  kills the message pump); and `provider.destroy()` rejects pending
  `eth_subscribe` payloads that no reachable handler owns, so teardown closes
  the socket directly instead.
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
