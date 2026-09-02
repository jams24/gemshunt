# Solana Sniper Bot

## Architecture
- **Node.js / CommonJS** — same stack as cryptosignal bot
- **PostgreSQL** via `pg` — no ORM
- **Telegraf** for Telegram bot
- **Jupiter v6** for token swaps
- **Solana web3.js** for chain interaction

## Key Files
- `src/index.js` — entry point, wires everything together
- `src/services/solana.js` — RPC connection, wallet, token info
- `src/services/jupiter.js` — buy/sell via Jupiter aggregator
- `src/services/tokenScanner.js` — listens for new Raydium pools + safety checks
- `src/engine/tradeEngine.js` — buy/sell logic, position management, TP/SL
- `src/bot/telegramBot.js` — Telegram commands
- `src/db/database.js` — PostgreSQL schema + queries

## Trading Flow
1. TokenScanner listens for Raydium `initialize2` logs (new pool creation)
2. Runs safety checks: mint authority revoked, freeze authority revoked, top holder concentration
3. If safe + passes filters → TradeEngine executes buy via Jupiter
4. Position monitor runs every 30s — checks prices, triggers TP/SL
5. TP1 (2x) sell 30%, TP2 (5x) sell 30%, TP3 (10x) sell 100%, SL at -50%

## Modes
- **Paper mode** (default) — no wallet key set, simulates trades in DB
- **Live mode** — set WALLET_PRIVATE_KEY in .env

## RPC
- Using Helius free tier (100K req/day)
- WebSocket for real-time pool detection
