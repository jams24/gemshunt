const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');

const PROGRAMS = {
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  raydiumV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
};
const WSOL = 'So11111111111111111111111111111111111111112';
const DEFAULT_PUBKEY = '11111111111111111111111111111111';

// Anchor event discriminator: sha256("event:<Name>")[0..8].
const CREATE_POOL_EVENT = crypto.createHash('sha256')
  .update('event:CreatePoolEvent').digest().subarray(0, 8);

/**
 * Cheap, string-only test for "this PumpSwap log is a pool creation".
 *
 * PumpSwap emits ~500 log notifications a second, almost all swaps. The old
 * filter counted `CreateIdempotent` lines, which every buy that opens a token
 * account also prints — measured live it let 9,252 of 31,047 notifications
 * through in one minute, against 4 real pool creations. Anchor names the
 * instruction explicitly, so match that.
 */
function isPumpSwapCreate(logs) {
  return logs.some(l => l === 'Program log: Instruction: CreatePool');
}

function isRaydiumInit(logs) {
  return logs.some(l => l.includes('initialize2: InitializeInstruction2'));
}

const pk = (buf, o) => new PublicKey(buf.subarray(o, o + 32)).toBase58();

/**
 * Decode PumpSwap's CreatePoolEvent straight out of the transaction logs.
 * This is the whole pool — mints, amounts, creator — with ZERO RPC calls,
 * which matters on a 100K/day RPC budget and makes detection instant.
 *
 * Layout verified against live pools and their on-chain Pool accounts:
 *   8 disc | i64 ts | u16 index | creator | base_mint | quote_mint |
 *   u8 base_dec | u8 quote_dec | u64 x7 amounts | u8 bump | pool | lp_mint |
 *   user_base_ata | user_quote_ata | coin_creator | ...
 *
 * Returns null when the logs carry no decodable event (truncated logs, or a
 * future layout change) so the caller can fall back to parsing the tx.
 */
function decodePumpSwapCreate(logs) {
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let b;
    try { b = Buffer.from(line.slice(14), 'base64'); } catch { continue; }
    if (b.length < 301 || !b.subarray(0, 8).equals(CREATE_POOL_EVENT)) continue;

    const creator = pk(b, 18);
    const baseMint = pk(b, 50);
    const quoteMint = pk(b, 82);
    const baseDecimals = b[114];
    const quoteDecimals = b[115];
    const poolBase = b.readBigUInt64LE(132);
    const poolQuote = b.readBigUInt64LE(140);
    const reserve = (raw, dec) => Number(raw) / 10 ** dec;
    const pool = pk(b, 173);
    const lpMint = pk(b, 205);
    const coinCreator = b.length >= 333 ? pk(b, 301) : null;

    // Pools are created in both orientations. The token is whichever side is
    // not wrapped SOL; a pool with no SOL side is not one we can trade.
    let mint, decimals, solRaw, tokenReserve;
    if (quoteMint === WSOL) {
      mint = baseMint; decimals = baseDecimals; solRaw = poolQuote;
      tokenReserve = reserve(poolBase, baseDecimals);
    } else if (baseMint === WSOL) {
      mint = quoteMint; decimals = quoteDecimals; solRaw = poolBase;
      tokenReserve = reserve(poolQuote, quoteDecimals);
    } else return { skip: 'no SOL side', mint: baseMint, pool };

    // A pump.fun graduation is created by the migration program, with the
    // token's real author recorded as coin_creator. A pool someone opened by
    // hand has no coin_creator, so the pool creator IS the deployer. Using the
    // fee payer here — as the old code did — attributed every graduation to
    // whichever keeper bot cranked the migration, pooling the rug history of
    // thousands of unrelated tokens onto a handful of addresses.
    const hasCoinCreator = coinCreator && coinCreator !== DEFAULT_PUBKEY && coinCreator !== creator;
    return {
      mint,
      decimals,
      pool,
      lpMint,
      deployer: hasCoinCreator ? coinCreator : creator,
      graduated: hasCoinCreator,
      liquiditySol: Number(solRaw) / 1e9,
      // Constant-product spot price straight from the opening reserves, so
      // an alert has a price and market cap before Jupiter can route it.
      priceNative: tokenReserve > 0 ? (Number(solRaw) / 1e9) / tokenReserve : null,
    };
  }
  return null;
}

/**
 * Decode a PumpSwap Pool account (fallback when the event is missing).
 * Offsets: 8 disc | u8 bump | u16 index | creator@11 | base@43 | quote@75 |
 * lp_mint@107 | base_vault@139 | quote_vault@171 | u64 lp_supply | coin_creator@211
 */
function decodePumpSwapPoolAccount(data) {
  if (!data || data.length < 243) return null;
  const creator = pk(data, 11);
  const baseMint = pk(data, 43);
  const quoteMint = pk(data, 75);
  const coinCreator = pk(data, 211);
  let mint, solVault;
  if (quoteMint === WSOL) { mint = baseMint; solVault = pk(data, 171); }
  else if (baseMint === WSOL) { mint = quoteMint; solVault = pk(data, 139); }
  else return { skip: 'no SOL side', mint: baseMint };
  const hasCoinCreator = coinCreator !== DEFAULT_PUBKEY && coinCreator !== creator;
  return {
    mint, solVault, lpMint: pk(data, 107),
    deployer: hasCoinCreator ? coinCreator : creator, graduated: hasCoinCreator,
  };
}

/** The pool address in a PumpSwap create_pool instruction is its first account. */
function findPumpSwapPoolInTx(tx) {
  const allIx = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions || []).flatMap(i => i.instructions),
  ];
  const ix = allIx.find(i => i.programId?.toBase58() === PROGRAMS.pumpswap && (i.accounts || []).length >= 10);
  return ix ? ix.accounts[0].toBase58() : null;
}

/**
 * Raydium AMM v4 initialize2: mints live in the instruction accounts, so this
 * one needs the parsed transaction. It is rare these days (pump.fun graduates
 * to PumpSwap), so the RPC cost is acceptable.
 */
function extractRaydiumPool(tx) {
  const allIx = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions || []).flatMap(i => i.instructions),
  ];
  for (const ix of allIx) {
    if (ix.programId?.toBase58() !== PROGRAMS.raydiumV4) continue;
    const accts = ix.accounts || [];
    if (accts.length < 10) continue;
    const mintA = accts[8]?.toBase58();
    const mintB = accts[9]?.toBase58();
    if (mintA !== WSOL && mintB !== WSOL) return null;
    const mint = mintA === WSOL ? mintB : mintA;
    const pool = accts[4]?.toBase58();
    const lpMint = accts[7]?.toBase58() || null;

    // SOL side from the pool's WSOL vault balance after the tx.
    let liquiditySol = null;
    for (const b of tx.meta?.postTokenBalances || []) {
      if (b.mint === WSOL && b.owner === '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1') {
        liquiditySol = Number(b.uiTokenAmount.uiAmount);
      }
    }
    const deployer = tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey?.toBase58() || null;
    return { mint, pool, lpMint, deployer, liquiditySol, graduated: false };
  }
  return null;
}

module.exports = {
  PROGRAMS, WSOL, DEFAULT_PUBKEY,
  isPumpSwapCreate, isRaydiumInit, decodePumpSwapCreate, extractRaydiumPool,
  decodePumpSwapPoolAccount, findPumpSwapPoolInTx,
};
