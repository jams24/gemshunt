const axios = require('axios');
const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const logger = require('../../utils/logger');
const { sleep, settle } = require('../../utils/async');

const WSOL = 'So11111111111111111111111111111111111111112';
const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
// Jupiter retired quote-api.jup.ag/v6 and price.jup.ag — the former now fails
// to connect and the latter no longer resolves at all. The current free
// endpoints are lite-api.jup.ag; api.jup.ag is the same API behind a key.
const JUPITER_HOST = process.env.JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
const JUPITER_API = `${JUPITER_HOST}/swap/v1`;
const JUPITER_PRICE = `${JUPITER_HOST}/price/v3`;
const JUPITER_HEADERS = process.env.JUPITER_API_KEY
  ? { 'x-api-key': process.env.JUPITER_API_KEY }
  : {};

const JITO_RPC = 'https://mainnet.block-engine.jito.wtf/api/v1/transactions';
const CONFIRM_TIMEOUT_MS = 75_000;
const REBROADCAST_MS = 2_000;
const TOKEN_INFO_TTL_MS = 5 * 60 * 1000;

/**
 * Solana swap adapter (Jupiter). Amounts crossing this boundary are always
 * RAW integer units — the router owns decimal conversion, not the caller.
 */
class SolanaSwapAdapter {
  constructor(connection) {
    this.connection = connection;
    this.chain = 'solana';
    this.nativeMint = WSOL;
    this.nativeDecimals = 9;
    this._infoCache = new Map();
  }

  async quote(inputMint, outputMint, rawAmount, slippageBps = 500) {
    const { data } = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint, outputMint,
        amount: BigInt(rawAmount).toString(),
        slippageBps,
        onlyDirectRoutes: false,
      },
      timeout: 10000,
      headers: JUPITER_HEADERS,
    });
    return {
      inAmount: Number(data.inAmount),
      outAmount: Number(data.outAmount),
      rawOut: BigInt(data.outAmount),
      priceImpactPct: Number(data.priceImpactPct),
      raw: data,
    };
  }

  async _swap(signer, inputMint, outputMint, rawAmount, slippageBps) {
    const quote = await this.quote(inputMint, outputMint, rawAmount, slippageBps);

    const { data } = await axios.post(`${JUPITER_API}/swap`, {
      quoteResponse: quote.raw,
      userPublicKey: signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: 'veryHigh',
          maxLamports: parseInt(process.env.SOLANA_MAX_PRIORITY_LAMPORTS, 10) || 2_000_000,
        },
      },
    }, { timeout: 15000, headers: JUPITER_HEADERS });

    const tx = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
    tx.sign([signer]);

    const sig = await this._sendAndConfirm(tx, data.lastValidBlockHeight);
    logger.info(`[sol] swap confirmed ${sig}`);
    return {
      signature: sig,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
      rawOutput: quote.rawOut,
      priceImpactPct: quote.priceImpactPct,
    };
  }

  /**
   * Broadcast and confirm, bounded by the blockhash's validity window.
   *
   * The old path sent to Jito alone — which drops transactions that carry no
   * tip, as Jupiter's do — logged "jito bundle landed" regardless, and then
   * waited on the deprecated signature-only confirmTransaction, which has no
   * expiry. Trades that never reached a leader showed up as a minute-long
   * hang and then a timeout. Here the same signed transaction goes to the RPC
   * and to Jito together (one signature, so it cannot execute twice), is
   * rebroadcast until it lands, and gives up the moment its blockhash expires.
   */
  async _sendAndConfirm(tx, lastValidBlockHeight) {
    const raw = Buffer.from(tx.serialize());
    const sig = bs58.encode(tx.signatures[0]);
    const useJito = process.env.SOLANA_USE_JITO !== 'false';

    const broadcast = () => Promise.allSettled([
      this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
      useJito ? this._sendViaJito(raw) : Promise.resolve(),
    ]);

    const first = await broadcast();
    if (first[0].status === 'rejected' && (!useJito || first[1].status === 'rejected')) {
      throw new Error(`Could not broadcast: ${first[0].reason?.message || first[0].reason}`);
    }

    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    let loops = 0;
    while (Date.now() < deadline) {
      await sleep(REBROADCAST_MS);
      loops++;
      const st = await settle(this.connection.getSignatureStatuses([sig]), 5000, null);
      const s = st?.value?.[0];
      if (s?.err) throw new Error(`Swap failed on-chain: ${JSON.stringify(s.err)} (${sig})`);
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig;

      if (lastValidBlockHeight && loops % 3 === 0) {
        const height = await settle(this.connection.getBlockHeight('confirmed'), 5000, null);
        if (height && height > lastValidBlockHeight) {
          throw new Error(`Transaction expired before landing — network congested, try again (${sig})`);
        }
      }
      broadcast(); // not awaited: rebroadcast is fire-and-forget
    }
    throw new Error(`Not confirmed within ${CONFIRM_TIMEOUT_MS / 1000}s — check ${sig} before retrying`);
  }

  async _sendViaJito(rawBuf) {
    const { data } = await axios.post(JITO_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [rawBuf.toString('base64'), { encoding: 'base64' }],
    }, { timeout: 5000 });
    if (data.error) throw new Error(data.error.message || 'Jito rejected');
    return data.result;
  }

  /** nativeAmount in SOL; returns outputAmount in RAW token units. */
  async buy(signer, mint, nativeAmount, slippageBps) {
    return this._swap(signer, WSOL, mint, Math.floor(nativeAmount * 1e9), slippageBps);
  }

  /** rawTokenAmount in RAW units; returns outputAmount in RAW lamports. */
  async sell(signer, mint, rawTokenAmount, slippageBps) {
    return this._swap(signer, mint, WSOL, BigInt(rawTokenAmount), slippageBps);
  }

  /** Price in USD, or null if Jupiter has no route yet. */
  async getPrice(mint) {
    try {
      const { data } = await axios.get(JUPITER_PRICE, {
        params: { ids: mint }, timeout: 5000, headers: JUPITER_HEADERS,
      });
      // price/v3 returns { <mint>: { usdPrice, decimals, ... } } — flatter
      // than v2's { data: { <mint>: { price } } }.
      const entry = data?.[mint] ?? data?.data?.[mint];
      const p = entry?.usdPrice ?? entry?.price;
      return p ? Number(p) : null;
    } catch {
      return null;
    }
  }

  /**
   * Mint facts in ONE RPC call: the parsed mint (authorities, supply,
   * decimals, Token-2022 extensions) plus the Metaplex metadata account.
   *
   * Most pump tokens are now Token-2022 with the name in the mint's own
   * tokenMetadata extension — the Metaplex-only lookup found nothing for
   * them, which is why so many alerts said UNKNOWN.
   */
  async getTokenInfo(mint) {
    const hit = this._infoCache.get(mint);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await this._fetchTokenInfo(mint);
    if (value) {
      if (this._infoCache.size > 2000) this._infoCache.clear();
      this._infoCache.set(mint, { value, expires: Date.now() + TOKEN_INFO_TTL_MS });
    }
    return value;
  }

  async _fetchTokenInfo(mint) {
    try {
      const mintPk = new PublicKey(mint);
      const [metaPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mintPk.toBuffer()],
        METADATA_PROGRAM,
      );
      const { value: [mintAcct, metaAcct] } = await this.connection.getMultipleParsedAccounts([mintPk, metaPda]);
      const info = mintAcct?.data?.parsed?.info;
      if (!info || mintAcct.data.parsed.type !== 'mint') return null;

      const ext = {};
      for (const e of info.extensions || []) ext[e.extension] = e.state || {};

      let symbol = ext.tokenMetadata?.symbol || null;
      let name = ext.tokenMetadata?.name || null;
      if ((!symbol || !name) && Buffer.isBuffer(metaAcct?.data)) {
        const meta = parseMetaplex(metaAcct.data);
        symbol = symbol || meta.symbol;
        name = name || meta.name;
      }

      const decimals = info.decimals;
      const rawSupply = String(info.supply);
      return {
        symbol: clean(symbol),
        name: clean(name),
        decimals,
        rawSupply,
        totalSupply: Number(rawSupply) / 10 ** decimals,
        mintAuthorityRevoked: !info.mintAuthority,
        freezeAuthorityRevoked: !info.freezeAuthority,
        token2022: mintAcct.data.program === 'spl-token-2022',
        extensions: ext,
      };
    } catch (err) {
      logger.warn(`[sol] token info ${mint}: ${err.message}`);
      return null;
    }
  }

  /**
   * Sellability probe. Returns sellable:null for UNKNOWN — an API failure is
   * not evidence of a honeypot, and treating it as one condemned every token
   * the moment Jupiter's endpoint moved.
   */
  async checkSellable(mint) {
    let buyQuote;
    try {
      buyQuote = await this.quote(WSOL, mint, 1e8, 1500); // 0.1 SOL in
    } catch (err) {
      // No route yet is normal for a pool seconds old; a network error tells
      // us nothing about the token. Either way: unknown, not guilty.
      return { sellable: null, reason: `buy probe failed: ${shortErr(err)}` };
    }
    if (!buyQuote.outAmount) return { sellable: null, reason: 'no buy route yet' };

    try {
      const sellQuote = await this.quote(mint, WSOL, buyQuote.rawOut, 1500);
      if (!sellQuote.outAmount) {
        return { sellable: false, reason: 'no sell route while a buy route exists' };
      }
      const roundTripLoss = 1 - (sellQuote.outAmount / 1e8);
      return {
        sellable: true,
        roundTripLossPct: roundTripLoss * 100,
        priceImpactPct: buyQuote.priceImpactPct * 100,
        reason: null,
      };
    } catch (err) {
      // An HTTP/network failure on the second call says nothing about the
      // token. Only Jupiter positively saying "no route" for the sell side
      // while the buy side routes is the honeypot signature.
      const status = err.response?.status;
      const body = JSON.stringify(err.response?.data || '');
      if (status === 400 && /route|liquidity|TOKEN_NOT_TRADABLE/i.test(body)) {
        return { sellable: false, reason: `sell quote refused: ${body.slice(0, 80)}` };
      }
      return { sellable: null, reason: `sell probe failed: ${shortErr(err)}` };
    }
  }
}

function parseMetaplex(d) {
  try {
    const nameLen = d.readUInt32LE(65);
    const name = d.subarray(69, 69 + nameLen).toString('utf8');
    const symOffset = 69 + nameLen;
    const symLen = d.readUInt32LE(symOffset);
    const symbol = d.subarray(symOffset + 4, symOffset + 4 + symLen).toString('utf8');
    return { name, symbol };
  } catch {
    return {};
  }
}

const clean = (s) => (s ? s.replace(/\0/g, '').trim() || null : null);
const shortErr = (err) => {
  const status = err.response?.status;
  return status ? `HTTP ${status}` : (err.code || err.message || String(err)).slice(0, 60);
};

module.exports = SolanaSwapAdapter;
