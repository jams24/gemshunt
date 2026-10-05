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
| `src/services/solanaPools.js` | PumpSwap/Raydium log filters + zero-RPC CreatePoolEvent decoder |
| `src/services/pipeline.js` | analyze → save → alert, plus scheduled re-checks |
| `src/services/alerter.js` | Who gets alerted, dedupe, copycat filter, rate limiting |
| `src/services/stats.js` | Rolling per-chain funnel counters behind `/health` |
| `src/utils/async.js` | `withTimeout`, `settle`, `WorkQueue`, `singleFlight` |
| `src/services/tracker.js` | Snapshots alerted tokens, outcomes, smart-money watching |
| `src/engine/tradeEngine.js` | Buy/sell, position management, TP/SL |
| `src/bot/telegramBot.js` | Telegram commands, callback routing, polling supervisor |
| `src/bot/panels.js` | Every inline screen (menu, positions, PnL, leaderboard, …) as `{ text, keyboard }` |
| `test/run.js` | Integration tests (`npm test`, needs a scratch Postgres) |

## Pipeline

```
Scanner (new pool on any chain)
  → Pipeline   bounded queue (ANALYZE_CONCURRENCY)
  → Analyzer   safety + market + deployer reputation + smart-money → 0-100 score
  → db.saveToken
  → Alerter    floor, confidence, copycat, rate limit, per-user filters → Telegram
  → re-check   same token again at +3m / +10m (RECHECK_DELAYS_MIN)
  → Tracker    snapshots for 24h → outcome (runner/rug) → deployer reputation
                                                              ↑ feeds the next score
```

**Why re-checks exist:** at pool creation nothing has traded. DexScreener
indexes a new pool ~3 minutes later, Jupiter often can't route it for a
minute, and momentum is zero — so a single look at t=0 can only judge safety.
Plausible tokens are analysed again; one that develops real buying is alerted
then ("⏱ NOW QUALIFYING"), and users who already got the launch alert get one
"📈 MOMENTUM CONFIRMED" follow-up. Hard rejects, honeypots and unlocked-LP
pools are not re-checked — nothing a re-check finds can rescue them.

Every stage records what it did in `stats`; `/health` (admin) prints the
funnel, and the health monitor tells the admin when pools are flowing but
nothing has been alerted for 3h, with the breakdown of which filter ate them.

## Track record (leaderboard, hit rate)

A **call** is a token alerted to at least one user. `markTokenAlerted` fixes
it on the first alert — `alerted_at`, `alert_score`, `alert_mc` — and later
re-checks never move it. The leaderboard ranks calls by `peak_multiple`;
runners that later rugged stay on it, marked 💀.

`peak_multiple` is recomputed every tracker cycle from the token's own
snapshots by `db.getPriceStats`, with three rules that each fixed a fake
runner:
- **Base = first price at/after the alert**, not before it.
- **One price source.** Snapshots carrying `liquidity_usd` are DexScreener;
  without it they are swap quotes. Once a token is indexed only DexScreener
  prices count — dividing one source by the other produced 5–50x "pumps".
- **Peaks on <$1k liquidity don't count.**
The old code divided a running max by the oldest of the newest 500 snapshots
— a base that slid forward after ~17h. `Tracker.rebaseHistory()` recomputes
old rows once at startup (snapshots only, no RPC).

## Bot UI

Every screen lives in `bot/panels.js` and is reached through callback data
`p:<panel>[:args]` (≤64 bytes). A button tap **edits the message in place**
(`TelegramBot._show`); a slash command sends the same panel fresh. Callback
regexes must be anchored (`^…$`): the unanchored `/chain_(solana|robinhood)/`
also matched `alertchain_solana`, so toggling an alert chain switched the
user's trading chain.

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

Caps, applied after the shrink:
- **No trading data → max 74, verdict "EARLY".** STRONG/HIGH CONVICTION must
  mean someone is actually buying. Users at 60 get safe launches; users at
  75+ only get momentum-confirmed tokens.
- **LP held by a wallet (≥50%) → max 30**, below the floor. Whoever holds the
  LP can withdraw the pool in one transaction.
- **LP custody unreadable → max 59** until a re-check can see it.

The alerter refuses anything below `ALERT_FLOOR` (absolute) or 50% confidence,
then applies each user's own `alert_min_score` and USD liquidity floor.

## Chain gotchas that caused real outages

- **PumpSwap emits ~500 log notifications/second, almost all swaps.** Match
  `Program log: Instruction: CreatePool` exactly. The old filter counted
  `CreateIdempotent` lines (every buy that opens a token account prints them):
  measured live, 9,252 of 31,047 notifications/minute passed it against 4 real
  pools, and the 30-slot drop-oldest queue threw the real ones away.
- **The PumpSwap pool is in the logs.** `CreatePoolEvent` (Anchor event,
  `Program data:` line) carries mints, reserves, pool, LP mint and creator —
  detection needs zero RPC calls. Pools come in BOTH orientations (WSOL as
  base or quote).
- **The deployer is not the fee payer.** For a pump.fun graduation the fee
  payer is a migration keeper shared by thousands of tokens; the real author is
  `coin_creator`. For a hand-made pool `coin_creator` is unset and the pool
  `creator` is the deployer. Using the fee payer pooled unrelated rug histories
  onto a few keeper addresses and penalised every graduation.
- **Fake graduations are common.** Hand-made PumpSwap pools on vanity
  `…pump` mints seeded with exactly 84.99 SOL, LP kept by the creator. pump.fun
  is never invoked. The LP-custody check and the copycat filter exist for them.
- **Pool vaults are owned by PDAs, not by the AMM program ID.** Exclude
  program-held supply with `PublicKey.isOnCurve(owner) === false`; a list of
  program IDs never matches, and the vault was counted as "the dev" (20%+),
  tripping the dev-holding hard reject on clean tokens.
- **Most pump tokens are Token-2022** with the name in the mint's
  `tokenMetadata` extension, not Metaplex. Extensions are also honeypot vectors:
  `permanentDelegate`, `nonTransferable` and a frozen `defaultAccountState` are
  hard rejects; `transferHook`, `pausable` and transfer fees are flagged.
- **The holder index lags the newest slot**: `getTokenLargestAccounts` on a
  mint created in the same tx routinely fails once, then succeeds — retry.
- **V4 `fee` with bit `0x800000` set is the dynamic-fee flag**, not a fee
  (8388608 was read as an "838% fee").
- **An RPC error is not a revert.** `owner()` failing because of a 429 must
  not read as "no owner = renounced". Only `CALL_EXCEPTION` is evidence.
- **Telegraf ends polling permanently** on a 409 Conflict (two instances —
  routine during a redeploy) or on any handler error when there is no
  `bot.catch`, and it awaits a whole batch of handlers before fetching more.
  Handlers are detached in middleware, errors go to `_handleError`, and
  `launch()` supervises polling with backoff. Symptom when this breaks: alerts
  still go out, but no command is ever answered.
- **Never run the bot locally with the production `TELEGRAM_BOT_TOKEN`** —
  it will fight the deployed instance for updates (409).
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
  A fresh pool returns HTTP 400 for a few minutes — that is "unknown", never
  "honeypot". Only an explicit no-route answer for the sell side while the buy
  side routes is the honeypot signature.
- **Jito drops untipped transactions.** Swaps are broadcast to the RPC and Jito
  together (same signature, cannot double-execute), rebroadcast until they land,
  and abandoned when `lastValidBlockHeight` passes. The deprecated
  signature-only `confirmTransaction` has no expiry and hung buys for minutes.
- **Alchemy's free tier caps `eth_getLogs` to a 10-block range**, so historical
  log scans need paging; live subscriptions are unaffected. The public
  Robinhood RPC served 100k-block ranges in ~400ms (Oct 2026). Blocks are
  ~0.1s; ~260 V4 pools/hour, liquidity added in the same tx as `Initialize`.

## Silence is a failure mode

Every outage in this project has presented the same way: process healthy, logs
calm, zero alerts. A moved Jupiter endpoint, a guessed V4 pool key, an
exhausted RPC quota — all of them looked exactly like a quiet market.

`services/healthMonitor.js` exists for that. It runs a preflight before the bot
claims to be running (asking for something that actually costs the provider
money — `getHealth` is served even when credits are gone) and warns the admin
when a chain has produced no pools for `HEALTH_SILENT_MINUTES`. Quota
exhaustion is detected by message signature and named explicitly, because it is
the failure that looks least like a failure.

When adding a dependency, add it to `preflight()`. An unchecked dependency is
one that will one day fail silently.

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
  and free of polling requests. Without one, `EvmSwapAdapter._startLogPoller`
  polls `eth_getLogs` itself (not ethers' `contract.on`, which hides whether it
  is polling at all), reports every successful poll for liveness, and catches
  up after an outage up to ~30 minutes back.
  Two non-obvious constraints in that watcher, both of which crashed the
  process before they were handled: ethers assigns its own socket handlers, so
  ours must chain onto them rather than replace them (replacing them silently
  kills the message pump); and `provider.destroy()` rejects pending
  `eth_subscribe` payloads that no reachable handler owns, so teardown closes
  the socket directly instead.
- Market data is DexScreener's free endpoint. Robinhood Chain **is** indexed
  (chainId `robinhood`), typically ~3 minutes after pool creation — which the
  re-checks rely on. Misses are cached for 10s only, failures not at all.

## Testing
```bash
createdb sniper_test
DATABASE_URL=postgresql://localhost/sniper_test npm test
```
Covers position accounting, the TP/SL ladder, raw-amount precision, alert
routing, scoring calibration, PumpSwap detection against live-captured logs
(`test/fixtures/pumpswap_logs.json`), re-checks, and the Telegram error path.
Run it against a **scratch** database — it writes freely.
