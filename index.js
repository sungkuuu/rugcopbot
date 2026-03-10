require('dotenv').config();
const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { TwitterApi } = require('twitter-api-v2');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ============================================================
// INIT
// ============================================================
const bot = new TelegramBot(process.env.API_KEY, { polling: false });

// 기존 webhook/polling 강제 초기화 후 시작
setTimeout(async () => {
  try {
    await bot.deleteWebHook();
    bot.startPolling({ restart: false });
    console.log('✅ Telegram polling started');
  } catch(e) {
    console.error('Telegram start error:', e.message);
  }
}, 3000);

bot.on('polling_error', (err) => {
  if (err.message && err.message.includes('409')) {
    console.log('⚠️ 409 conflict - ignoring, will resolve on next deploy');
  } else {
    console.error('Polling error:', err.message);
  }
});

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

const ETHERSCAN_API_KEY = (process.env.ETHERSCAN_API_KEY || '').trim();
const HELIUS_API_KEY    = (process.env.HELIUS_API_KEY    || '').trim();

let twitter = null;
if (process.env.TWITTER_APP_KEY && process.env.TWITTER_APP_SECRET &&
    process.env.TWITTER_ACCESS_TOKEN && process.env.TWITTER_ACCESS_TOKEN_SECRET) {
  twitter = new TwitterApi({
    appKey: process.env.TWITTER_APP_KEY,
    appSecret: process.env.TWITTER_APP_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  });
  console.log('🐦 Twitter client ready');
} else {
  console.log('⚠️ Twitter keys missing');
}

// ============================================================
// RECENT RUGS STORAGE (PostgreSQL)
// ============================================================
const RUGS_FILE = path.join(__dirname, 'recent_rugs.json');

function loadRugs() {
  try {
    if (fs.existsSync(RUGS_FILE)) {
      return JSON.parse(fs.readFileSync(RUGS_FILE, 'utf8'));
    }
  } catch(e) {}
  return [];
}

async function saveRug(rug) {
  if (!process.env.DATABASE_URL) {
    const rugs = loadRugs();
    if (rugs.find(r => r.ca === rug.ca)) return;
    rugs.unshift(rug);
    if (rugs.length > 50) rugs.splice(50);
    fs.writeFileSync(RUGS_FILE, JSON.stringify(rugs, null, 2));
    console.log(`💾 Rug saved (file): ${rug.name} (${rug.ca.slice(0,8)}...)`);
    return;
  }
  try {
    await pool.query(
      `INSERT INTO tokens (ca, name, symbol, chain, risk, flags, volume24h, market_cap, logo, type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (ca) DO NOTHING`,
      [rug.ca, rug.name, rug.symbol, rug.chain || 'SOL', rug.risk, JSON.stringify(rug.flags || []), rug.volume24h ?? null, rug.marketCap ?? null, rug.logo ?? null, rug.type || 'clean']
    );
    console.log(`💾 Rug saved: ${rug.name} (${rug.ca.slice(0,8)}...)`);
  } catch(e) {
    console.error('saveRug error:', e.message);
  }
}

// 이미 트윗한 CA (재시작 후에도 유지)
const TWEETED_FILE = path.join(__dirname, 'tweeted_cas.json');

function loadTweetedCAs() {
  try {
    if (fs.existsSync(TWEETED_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(TWEETED_FILE, 'utf8')));
    }
  } catch(e) {}
  return new Set();
}

function saveTweetedCA(ca) {
  const set = loadTweetedCAs();
  set.add(ca);
  fs.writeFileSync(TWEETED_FILE, JSON.stringify([...set]));
}

const tweetedCAs = loadTweetedCAs();

// ============================================================
// GOPLUS SOLANA SCAN
// ============================================================
async function scanSolanaToken(ca) {
  try {
    const res  = await fetch(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${ca}`);
    const data = await res.json();
    const key  = Object.keys(data.result || {})[0];
    return data.result?.[key] || null;
  } catch(e) {
    return null;
  }
}

// ============================================================
// RISK SCORER
// ============================================================
function calcRisk(sd, chain) {
  if (chain === 'SOL') {
    const freeze   = sd.freezable?.status               === '1';
    const mutable  = sd.balance_mutable_authority?.status === '1';
    const closable = sd.closable?.status                === '1';
    const flagCount = [freeze, mutable, closable].filter(Boolean).length;
    let r = flagCount >= 2 ? 90 : flagCount === 1 ? 75 : 15;
    if (r < 10) r = 10;
    return r;
  } else {
    const honeypot = sd.is_honeypot === '1';
    const mintable = sd.is_mintable === '1';
    const sellTax  = Math.round((sd.sell_tax || 0) * 100);
    if (honeypot) return 99;
    if (mintable)  return 85;
    if (sellTax > 20) return 75;
    let r = 15;
    if (r < 10) r = 10;
    return r;
  }
}

function getFlags(sd, chain) {
  const flags = [];
  if (chain === 'SOL') {
    if (sd.freezable?.status               === '1') flags.push('FREEZABLE');
    if (sd.balance_mutable_authority?.status === '1') flags.push('MUTABLE');
    if (sd.closable?.status                === '1') flags.push('CLOSABLE');
  } else {
    if (sd.is_honeypot === '1') flags.push('HONEYPOT');
    if (sd.is_mintable === '1') flags.push('MINTABLE');
    const sell = Math.round((sd.sell_tax || 0) * 100);
    if (sell > 10) flags.push(`SELL TAX ${sell}%`);
  }
  return flags;
}

// ============================================================
// TWITTER AUTO-ALERT
// ============================================================
let lastTweetTime = Date.now(); // 시작 시 바로 트윗 못하게
const TWEET_COOLDOWN = 900000; // 15분에 1개만 트윗
let lastAdminAlert = 0;
const ADMIN_COOLDOWN = 15 * 60 * 1000; // 15분

async function tweetAlert(rug) {
  if (tweetedCAs.has(rug.ca)) return;

  if (!process.env.ADMIN_CHAT_ID) {
    console.log('⚠️ ADMIN_CHAT_ID not set, skipping admin alert');
    return;
  }

  const volume24h = rug.volume24h ?? 0;
  const marketCap = rug.marketCap ?? 0;
  const top10pct = rug.top10pct != null ? rug.top10pct : 0;
  const top10str = top10pct > 0 ? Math.round(top10pct) + '%' : 'N/A';
  const { name, symbol, ca, chain, risk, flags } = rug;
  const chainStr = chain || 'SOL';

  if (!symbol || symbol === '???') return;
  if (name === 'Unknown') return;

  const isMutable =
    (flags || []).includes('MUTABLE_METADATA') ||
    (flags || []).includes('MUTABLE');
  const isFreezable =
    (flags || []).includes('FREEZE_AUTHORITY') ||
    (flags || []).includes('FREEZABLE');

  // DANGER 알림 (risk >= 70, volume >= 5000)
  if (risk >= 70 && volume24h >= 5000) {
    const dangerMsg = `🚨 SCAM ALERT — $${symbol}

${name} | ${chainStr} | Risk: ${risk}%
CA: ${ca}

⚖️ Mutable: ${isMutable ? '🚨 YES' : '✅ NO'} | 🧊 Freezable: ${isFreezable ? '🚨 YES' : '✅ NO'}

👥 Top 10 Holders: ${top10str}

💰 Vol 24h: $${Number(volume24h).toLocaleString('en-US', { maximumFractionDigits: 0 })}
📊 MCap: $${Number(marketCap).toLocaleString('en-US')}

——— TWEET DRAFT ———
🚨 $${symbol} flagged by RugCop

High risk token — do NOT ape
CA: ${ca.slice(0,6)}...${ca.slice(-6)}
Risk Score: ${risk}% 🚨

Scan before you lose it all 👇
rugcop.xyz

#Solana #RugPull #CryptoScam
———————————`;

    try {
      await bot.sendMessage(process.env.ADMIN_CHAT_ID, dangerMsg);
      console.log('📩 Admin notified (danger):', symbol);
      tweetedCAs.add(rug.ca);
      saveTweetedCA(rug.ca);
    } catch (e) {
      console.error('Admin alert failed:', e.message);
    }
    return;
  }

  // CLEAN 알림 (15분 쿨다운 유지)
  if (risk <= 30 && volume24h >= 10000) {
    if (Date.now() - lastAdminAlert < ADMIN_COOLDOWN) return;
    if (marketCap < 50000) return;

    const alertMsg = `✅ $${symbol} looks clean

${name} | ${chainStr} | Risk: ${risk}%
CA: ${ca}

⚖️ Mutable: ${isMutable ? '🚨 YES' : '✅ NO'} | 🧊 Freezable: ${isFreezable ? '🚨 YES' : '✅ NO'}

👥 Top 10 Holders: ${top10str}

💰 Vol 24h: $${Number(volume24h).toLocaleString('en-US', {maximumFractionDigits:0})}
📊 MCap: $${Number(marketCap).toLocaleString('en-US')}

Scan before you ape 👇\
rugcop.xyz

#Solana #Memecoin #GemAlert`;

    try {
      lastAdminAlert = Date.now();
      await bot.sendMessage(process.env.ADMIN_CHAT_ID, alertMsg);
      console.log('📩 Admin notified (clean):', symbol);
      tweetedCAs.add(rug.ca);
      saveTweetedCA(rug.ca);
    } catch(e) {
      console.error('Admin alert failed:', e.message);
    }
  }
}

// ============================================================
// PROCESS NEW TOKEN (Helius webhook에서 호출)
// ============================================================
async function getTokenMeta(ca) {
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: ca } })
    });
    const data = await res.json();
    const meta = data.result?.content?.metadata;
    return { name: meta?.name || 'Unknown', symbol: meta?.symbol || '???' };
  } catch(e) { return { name: 'Unknown', symbol: '???' }; }
}

async function heliusRpc(method, params) {
  if (!HELIUS_API_KEY) return null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const data = await res.json();
    return data.result;
  } catch(e) { return null; }
}

/**
 * Fetch top 10 token holders via Helius getTokenLargestAccounts (fallback when GoPlus returns none).
 * Returns array of { address, token_account } for use with analyzeBundleRisk (ATAs).
 */
async function fetchTopHoldersFromHelius(mintAddress) {
  if (!mintAddress) return [];
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenLargestAccounts',
        params: [mintAddress]
      })
    });
    const data = await res.json();
    if (data.error) {
      console.error("🚨 Helius RPC Error:", JSON.stringify(data.error));
      return [];
    }
    const raw = data.result;
    const list = Array.isArray(raw) ? raw : (raw?.value || []);
    console.log(`✅ Helius fetched ${list.length} top accounts`);
    return list.slice(0, 10).map(item => ({
      address: item.address || item.token_account,
      owner_address: item.owner,
      token_account: item.address || item.token_account
    })).filter(h => h.address || h.token_account);
  } catch(e) {
    console.error("🚨 Helius Catch Error:", e.message);
    return [];
  }
}

/**
 * Ultra-fast Bundle Risk from top 10 holders: Ghost Wallet + Funding Source overlap.
 * Returns { label, riskAdd }: label for display, riskAdd = 50 (HIGH), 30 (MEDIUM), or 0.
 */
async function analyzeBundleRisk(holders) {
  const list = (holders || []).slice(0, 10);
  const addresses = list
    .map(h => h.address || h.owner_address || h.token_account)
    .filter(Boolean);
  if (addresses.length === 0) return { label: '⏳ Pool/Curve (Holders N/A)', riskAdd: 0 };

  const SIG_LIMIT = 50;
  const fundingBySource = {};

  const fetchSigs = async (addr) => {
    try {
      const sigs = await heliusRpc('getSignaturesForAddress', [addr, { limit: SIG_LIMIT }]);
      return { addr, sigs: Array.isArray(sigs) ? sigs : [] };
    } catch(e) { return { addr, sigs: [] }; }
  };

  const results = await Promise.all(addresses.map(fetchSigs));

  for (const { addr, sigs } of results) {
    if (sigs.length >= SIG_LIMIT) continue;
    if (sigs.length === 0) continue;
    const lastSig = sigs[sigs.length - 1];
    const sigStr = typeof lastSig === 'string' ? lastSig : lastSig?.signature;
    if (!sigStr) continue;
    try {
      const tx = await heliusRpc('getTransaction', [sigStr, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      if (!tx?.transaction?.message?.accountKeys?.length) continue;
      const keys = tx.transaction.message.accountKeys;
      const feePayer = (keys[0] && typeof keys[0] === 'object' && keys[0].pubkey) ? keys[0].pubkey : (typeof keys[0] === 'string' ? keys[0] : null);
      if (!feePayer) continue;
      fundingBySource[feePayer] = (fundingBySource[feePayer] || 0) + 1;
    } catch(e) { /* skip */ }
  }

  const counts = Object.values(fundingBySource).filter(c => c > 0);
  const maxSame = counts.length ? Math.max(...counts) : 0;

  if (maxSame >= 7) return { label: '🔴 BUNDLE RISK: HIGH (Dev Sniped)', riskAdd: 50 };
  if (maxSame >= 4) return { label: '🟡 BUNDLE RISK: MEDIUM', riskAdd: 30 };
  if (maxSame >= 1) return { label: '🟢 BUNDLE RISK: LOW', riskAdd: 0 };
  return { label: '✅ NO BUNDLE DETECTED', riskAdd: 0 };
}

/**
 * Genesis Bundle Tracker: when holders are hidden (e.g. in pool), check if token creator
 * funded multiple wallets before/during launch. Uses genesis tx to find creator, then traces
 * creator's SOL transfers to count unique funded addresses.
 * Returns { label, riskAdd, flags }.
 */
async function checkGenesisBundle(ca) {
  if (!ca || !HELIUS_API_KEY) return { label: '✅ NO GENESIS BUNDLE DETECTED', riskAdd: 0, flags: [] };
  try {
    const sigs = await heliusRpc('getSignaturesForAddress', [ca, { limit: 100 }]);
    const list = Array.isArray(sigs) ? sigs : [];
    if (list.length === 0) return { label: '✅ NO GENESIS BUNDLE DETECTED', riskAdd: 0, flags: [] };

    const genesisSig = list[list.length - 1];
    const genesisSigStr = typeof genesisSig === 'string' ? genesisSig : genesisSig?.signature;
    if (!genesisSigStr) return { label: '✅ NO GENESIS BUNDLE DETECTED', riskAdd: 0, flags: [] };

    const genesisTx = await heliusRpc('getTransaction', [genesisSigStr, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!genesisTx?.transaction?.message?.accountKeys?.length) return { label: '✅ NO GENESIS BUNDLE DETECTED', riskAdd: 0, flags: [] };

    const keys = genesisTx.transaction.message.accountKeys;
    const creatorAddress = (keys[0] && typeof keys[0] === 'object' && keys[0].pubkey) ? keys[0].pubkey : (typeof keys[0] === 'string' ? keys[0] : null);
    if (!creatorAddress) return { label: '✅ NO GENESIS BUNDLE DETECTED', riskAdd: 0, flags: [] };

    const creatorSigs = await heliusRpc('getSignaturesForAddress', [creatorAddress, { limit: 50 }]);
    const creatorList = Array.isArray(creatorSigs) ? creatorSigs : [];
    const toFetch = creatorList.slice(0, 10);
    const funded = new Set();

    for (const item of toFetch) {
      const sigStr = typeof item === 'string' ? item : item?.signature;
      if (!sigStr) continue;
      try {
        const tx = await heliusRpc('getTransaction', [sigStr, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
        if (!tx?.transaction?.message) continue;
        const msg = tx.transaction.message;
        const accountKeys = msg.accountKeys || [];
        const instructions = msg.instructions || [];

        for (const ix of instructions) {
          const program = (ix.programId && typeof ix.programId === 'string') ? ix.programId : null;
          const programName = (ix.program === 'system' || program === '11111111111111111111111111111111') ? 'system' : (ix.program || null);
          if (programName !== 'system' && ix.program !== 'system') continue;
          let dest = null;
          if (ix.parsed?.type === 'transfer' && ix.parsed?.info?.destination) dest = ix.parsed.info.destination;
          if (!dest && Array.isArray(ix.accounts) && accountKeys[ix.accounts[1]]) {
            const acc = accountKeys[ix.accounts[1]];
            dest = typeof acc === 'object' && acc.pubkey ? acc.pubkey : (typeof acc === 'string' ? acc : null);
          }
          if (dest && dest !== creatorAddress) funded.add(dest);
        }
      } catch (e) { /* skip tx */ }
    }

    const uniqueFunded = funded.size;
    if (uniqueFunded >= 4) return { label: `🔴 GENESIS BUNDLE: Dev funded ${uniqueFunded} wallets`, riskAdd: 50, flags: ['GENESIS_BUNDLE'] };
    if (uniqueFunded >= 2) return { label: `🟡 SUSPICIOUS: Dev funded ${uniqueFunded} wallets`, riskAdd: 30, flags: ['DEV_FUNDING'] };
    return { label: '✅ NO GENESIS BUNDLE DETECTED', riskAdd: 0, flags: [] };
  } catch (e) {
    console.error('checkGenesisBundle error:', e.message);
    return { label: '✅ NO GENESIS BUNDLE DETECTED', riskAdd: 0, flags: [] };
  }
}

async function processNewToken(ca, name, symbol) {
  console.log(`🔍 New token detected: ${symbol} (${ca})`);

  const sd = await scanSolanaToken(ca);
  let risk, flags, meta;

  if (!sd) {
    // GoPlus 데이터 없을 때 Helius DAS로 실제 데이터 확인
    try {
      const assetRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: ca } })
      });
      const assetData = await assetRes.json();
      const asset = assetData.result;

      let risk = 30;
      let flags = [];

      // 민팅 권한 있으면 위험
      if (asset?.mint_extensions || asset?.token_info?.mint_authority) {
        risk += 30; flags.push('MINT_AUTHORITY');
      }
      // 프리즈 권한 있으면 위험
      if (asset?.token_info?.freeze_authority) {
        risk += 25; flags.push('FREEZE_AUTHORITY');
      }
      // 메타데이터 뮤터블이면 위험
      if (asset?.mutable === true) {
        risk += 20; flags.push('MUTABLE_METADATA');
      }

      const name = asset?.content?.metadata?.name || 'Unknown';
      const symbol = asset?.content?.metadata?.symbol || '???';

      if (risk > 30 && risk < 50) return; // 중간 위험은 스킵

      if (risk <= 30 || risk >= 50) {
        await saveRug({ ca, name, symbol, chain: 'SOL', risk: Math.min(risk, 99), flags });
        if (risk <= 30 || risk >= 80) await tweetAlert({ ca, name, symbol, chain: 'SOL', risk: Math.min(risk, 99), flags });
      }
      return;
    } catch(e) {
      return; // 데이터 없으면 스킵 (75% 고정 제거)
    }
  }

  risk  = calcRisk(sd, 'SOL');
  flags = getFlags(sd, 'SOL');
  meta  = sd.metadata || {};
  if (risk < 10) risk = 10;

  let holders = sd.top_holders || [];
  if (!holders.length) holders = await fetchTopHoldersFromHelius(ca);
  const bundleRisk = await analyzeBundleRisk(holders);
  risk += (bundleRisk.riskAdd || 0);
  if (bundleRisk.label.includes('UNAVAILABLE')) {
    flags.push('HOLDERS_HIDDEN');
  } else if (bundleRisk.riskAdd > 0) {
    flags.push('BUNDLE_RISK');
  }
  risk = Math.min(risk, 99);

  if (risk > 30 && risk < 50) {
    console.log(`⏭️ ${symbol} - Mid risk (${risk}%), skipping`);
    return;
  }

  const rug = {
    ca,
    name:   meta.name   || name   || 'Unknown',
    symbol: meta.symbol || symbol || '???',
    chain:  'SOL',
    risk,
    flags,
    time:   Date.now(),
  };

  if (rug.name === 'Unknown' && (rug.symbol === '???' || rug.symbol == null)) {
    const metaFromHelius = await getTokenMeta(ca);
    rug.name = metaFromHelius.name;
    rug.symbol = metaFromHelius.symbol;
  }

  await saveRug(rug);
  if (rug.risk >= 80 || rug.risk <= 30) await tweetAlert(rug);
}

// ============================================================
// DEXSCREENER 트렌딩 토큰 자동 스캔 (15분마다)
// ============================================================

/** 한 개 솔라나 토큰 스캔 (GoPlus + DexScreener, 저장/알림). tokenMeta: { description?, symbol?, name? } */
async function scanOneSolanaToken(ca, tokenMeta = {}) {
  try {
    const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
    const dexData = await dexRes.json();
    const pair = dexData.pairs?.[0];
    const dexName = pair?.baseToken?.name;
    const dexSymbol = pair?.baseToken?.symbol;

    const gpRes = await fetch(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${ca}`);
    const gpData = await gpRes.json();
    const key = Object.keys(gpData.result || {})[0];
    const sd = gpData.result?.[key];
    if (!sd) return;

    console.log('GoPlus raw:', JSON.stringify(sd).slice(0, 300));

    const mintAuth = sd.metadata?.['mint_authority'] || sd.mintAuthority || sd.mint_authority;
    const freezeAuth = sd.metadata?.['freeze_authority'] || sd.freezeAuthority || sd.freeze_authority;
    const mutable = sd.mutable === '1' || sd.is_mutable === '1';

    const flags = [];
    if (mintAuth) flags.push('MINT_AUTHORITY');
    if (freezeAuth) flags.push('FREEZE_AUTHORITY');
    if (mutable) flags.push('MUTABLE_METADATA');

    let risk = mintAuth ? 80 : freezeAuth ? 70 : mutable ? 60 : 15;

    let holders = sd.top_holders || [];
    if (!holders.length) holders = await fetchTopHoldersFromHelius(ca);

    const bundleRisk = await analyzeBundleRisk(holders);
    risk += (bundleRisk.riskAdd || 0);
    if (bundleRisk.label.includes('UNAVAILABLE')) {
      flags.push('HOLDERS_HIDDEN');
      try {
        const genesisRisk = await checkGenesisBundle(ca);
        risk += (genesisRisk.riskAdd || 0);
        if (genesisRisk.flags && genesisRisk.flags.length) flags.push(...genesisRisk.flags);
      } catch (e) {
        console.error('checkGenesisBundle (scanOneSolanaToken):', e.message);
      }
    } else if (bundleRisk.riskAdd > 0) {
      flags.push('BUNDLE_RISK');
    }

    const topHolders = sd.top_holders || [];
    const top10pct = topHolders.slice(0, 10)
      .reduce((s, h) => s + parseFloat(h.percent || 0), 0);

    if (top10pct > 50) { risk += 40; flags.push(`TOP10_${Math.round(top10pct)}%`); }
    if (top10pct > 30) { risk += 20; flags.push(`TOP10_${Math.round(top10pct)}%`); }

    const devHolder = topHolders[0];
    if (devHolder && parseFloat(devHolder.percent) > 20) {
      risk += 30;
      flags.push('DEV_WHALE');
    }

    if (risk < 10) risk = 10;
    risk = Math.min(risk, 99);

    const meta = sd.metadata || {};
    let name = meta.name || tokenMeta.name || tokenMeta.description;
    if (!name || name === 'Unknown') name = dexName || 'Unknown';
    let symbol = meta.symbol || tokenMeta.symbol;
    if (!symbol || symbol === '???') symbol = dexSymbol || '???';

    console.log(`📊 ${symbol}: risk ${risk}% flags: ${flags.join(', ')}`);

    const volume24h = pair?.volume?.h24 || 0;
    const marketCap = pair?.marketCap || 0;
    const priceUsd = pair?.priceUsd || 0;
    const logo = pair?.info?.imageUrl || null;

    const rugPayload = {
      ca,
      name,
      symbol,
      chain: 'SOL',
      risk: Math.min(risk, 99),
      flags,
      volume24h,
      marketCap,
      priceUsd,
      logo,
      top10pct,
    };

    if (risk >= 70 && volume24h >= 5000) {
      await saveRug({ ...rugPayload, type: 'danger' });
      await tweetAlert({ ...rugPayload, volume24h, marketCap });
    }
    if (risk <= 30 && volume24h >= 10000) {
      await saveRug({ ...rugPayload, type: 'clean' });
      await tweetAlert({ ...rugPayload, volume24h, marketCap });
    }
  } catch(e) { /* skip */ }
}

async function scanTrendingTokens() {
  try {
    console.log('🔥 Scanning trending tokens...');
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const tokens = await res.json();
    const solTokens = (Array.isArray(tokens) ? tokens : [])
      .filter(t => t.chainId === 'solana' && t.tokenAddress)
      .slice(0, 20);

    for (const token of solTokens) {
      await scanOneSolanaToken(token.tokenAddress, {
        description: token.description,
        symbol: token.symbol,
        name: token.name,
      });
      await new Promise(r => setTimeout(r, 2000));
    }

    // Solana 신규 상장 토큰 추가 스캔 (상위 10개)
    const newRes = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const newData = await newRes.json();
    const newCAs = Array.isArray(newData)
      ? newData.filter(t => t.chainId === 'solana').slice(0, 10).map(t => t.tokenAddress).filter(Boolean)
      : [];

    for (const ca of newCAs) {
      await scanOneSolanaToken(ca, {});
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch(e) { console.error('Trending scan error:', e.message); }
}

// ============================================================
// HELIUS WEBHOOK — 새 솔라나 토큰 감지
// ============================================================
app.post('/webhook/helius', async (req, res) => {
  res.sendStatus(200); // 즉시 응답

  try {
    const events = req.body;
    if (!Array.isArray(events)) return;

    for (const event of events) {
      // 새 토큰 민팅 이벤트
      if (event.type === 'CREATE' || event.type === 'TOKEN_MINT') {
        const ca     = event.tokenTransfers?.[0]?.mint || event.mint;
        const name   = event.tokenMetadata?.name   || '';
        const symbol = event.tokenMetadata?.symbol || '';
        if (ca) {
          await processNewToken(ca, name, symbol);
        }
      }

      // AccountTransaction에서 새 토큰 추출
      if (event.accountData) {
        for (const acc of event.accountData) {
          if (acc.tokenBalanceChanges) {
            for (const change of acc.tokenBalanceChanges) {
              if (change.mint && change.rawTokenAmount?.tokenAmount === '1000000000') {
                await processNewToken(change.mint, '', '');
              }
            }
          }
        }
      }
    }
  } catch(e) {
    console.error('Webhook error:', e.message);
  }
});

// ============================================================
// API — 웹사이트에서 Recent Rugs 가져가기
// ============================================================
app.get('/api/recent-rugs', async (req, res) => {
  if (process.env.DATABASE_URL) {
    try {
      const result = await pool.query('SELECT * FROM tokens ORDER BY created_at DESC LIMIT 50');
      const rows = result.rows.map(r => ({
        ...r,
        marketCap: r.market_cap,
        time: r.created_at ? new Date(r.created_at).getTime() : null,
        timeAgo: getTimeAgo(r.created_at ? new Date(r.created_at).getTime() : Date.now()),
        riskLabel: getRiskLabel(r.risk ?? 0),
      }));
      res.json(rows);
      return;
    } catch(e) {
      console.error('recent-rugs error:', e.message);
    }
  }
  const rugs = loadRugs();
  const sorted = rugs.slice().sort((a, b) => (b.time || 0) - (a.time || 0));
  const limited = sorted.slice(0, 50);
  const formatted = limited.map(r => ({
    ...r,
    timeAgo: getTimeAgo(r.time),
    riskLabel: getRiskLabel(r.risk ?? 0),
  }));
  res.json(formatted);
});

app.get('/api/stats', async (req, res) => {
  if (process.env.DATABASE_URL) {
    try {
      const stats = await pool.query(`SELECT COUNT(*)::int as total, COUNT(CASE WHEN type='danger' THEN 1 END)::int as danger, COUNT(CASE WHEN type='clean' THEN 1 END)::int as clean, COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END)::int as "last24h" FROM tokens`);
      res.json(stats.rows[0]);
      return;
    } catch(e) {
      console.error('stats error:', e.message);
    }
  }
  const rugs = loadRugs();
  res.json({
    total: rugs.length,
    totalRugs: rugs.length,
    danger: rugs.filter(r => r.type === 'danger').length,
    clean: rugs.filter(r => r.type === 'clean').length,
    last24h: rugs.filter(r => Date.now() - r.time < 86400000).length,
  });
});

function getTimeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  return `${Math.floor(diff/3600)}h ago`;
}

function getRiskLabel(risk) {
  if (risk <= 20) return '⭐⭐⭐⭐⭐  LOW RISK';
  if (risk <= 40) return '⭐⭐⭐⭐    LOOKS CLEAN';
  if (risk <= 60) return '⭐⭐⭐      NEUTRAL';
  if (risk <= 80) return '⭐⭐        HIGH RISK';
  return '⭐          DANGER';
}

// ============================================================
// EXPRESS SERVER START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  if (process.env.DATABASE_URL) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tokens (
          id SERIAL PRIMARY KEY,
          ca TEXT UNIQUE,
          name TEXT,
          symbol TEXT,
          chain TEXT,
          risk INTEGER,
          flags TEXT,
          volume24h NUMERIC,
          market_cap NUMERIC,
          logo TEXT,
          type TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('✅ Tokens table ready');
    } catch(e) {
      console.error('DB table create error:', e.message);
    }
  }
  console.log(`🌐 API server running on port ${PORT}`);
  console.log(`📡 Helius webhook ready at /webhook/helius`);
  console.log(`🔗 Recent rugs API at /api/recent-rugs`);
  setInterval(scanTrendingTokens, 900000); // 15분마다
  scanTrendingTokens(); // 시작하자마자 1번 실행
});

// ============================================================
// 기존 텔레그램 봇 코드 (그대로 유지)
// ============================================================
async function getContractSourceCode(contractAddress) {
  if (!ETHERSCAN_API_KEY) return '';
  const apiUrl = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getsourcecode&address=${contractAddress}&apikey=${ETHERSCAN_API_KEY}`;
  try {
    const res  = await fetch(apiUrl);
    const data = await res.json();
    if (!data.result?.[0]?.SourceCode) return '';
    let raw = data.result[0].SourceCode || '';
    if (raw.startsWith('{{')) raw = raw.slice(1, -1);
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.sources) {
          return Object.values(parsed.sources).map(s => s.content || '').join('\n');
        }
      } catch(e) {}
    }
    return raw;
  } catch(e) { return ''; }
}

async function getAIAudit(sourceCode, sd = {}, bundleStatus = null, calculatedRisk = 0) {
  if (!process.env.OPENAI_API_KEY) return 'N/A (no OpenAI API key)';
  const isSolana    = sourceCode === 'SOLANA_TOKEN';
  const snippet     = isSolana ? "No smart contract code available. Rely ONLY on the provided API flags." : (sourceCode || '').slice(0, 3000);
  const chainContext = isSolana ? "Solana" : "Ethereum/EVM";
  const isHoneypot  = sd.is_honeypot === "1" ? "YES" : "NO";
  const isMintable  = sd.is_mintable  === "1" ? "YES" : "NO";
  const buyTax      = Math.round((sd.buy_tax  || 0) * 100);
  const sellTax     = Math.round((sd.sell_tax || 0) * 100);
  const solFreezable = (sd.freezable?.status === "1") ? "YES" : "NO";
  const solMutable   = (sd.balance_mutable_authority?.status === "1") ? "YES" : "NO";
  const solClosable  = (sd.closable?.status === "1") ? "YES" : "NO";
  const securityDataText = isSolana
    ? `Freezable: ${solFreezable}, Balance Mutable: ${solMutable}, Closable: ${solClosable}, Bundle Risk: ${bundleStatus != null ? bundleStatus : 'N/A'}`
    : `Honeypot: ${isHoneypot}, Mintable: ${isMintable}, Buy Tax: ${buyTax}%, Sell Tax: ${sellTax}%`;

  const systemPrompt = `You are an elite crypto security auditor.
CHAIN: ${chainContext}
ON-CHAIN DATA: ${securityDataText}
SYSTEM RISK SCORE: ${calculatedRisk}%
YOUR JOB:
The system has already calculated the strict Risk Score as ${calculatedRisk}%.
DO NOT invent a new score. Your task is to provide a 1-2 sentence cynical, expert explanation of WHY this score makes sense based on the ON-CHAIN DATA.

If the score is low but holders are hidden, warn them about the lack of transparency.

If authorities are revoked (safe) but bundle risk is high, explain the danger of developer supply control.

Format STRICTLY as: Risk: ${calculatedRisk}% | [Your expert explanation]`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: snippet }],
      max_tokens: 200,
      temperature: 0
    });
    return completion.choices?.[0]?.message?.content?.trim() || 'N/A';
  } catch(e) { return `N/A (${e.message})`; }
}

console.log("🚨 RUGCOP RADAR is online. (Ethereum + Solana)");

const SOLANA_CA_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function runScanInChat(chatId, contractAddress) {
  const waitMsg = await bot.sendMessage(chatId,
    `🚨 RUGCOP RADAR ACTIVATED 🚨\n🎯 Target Locked: <code>${contractAddress}</code>\n\n🐶 Sniffing the contract...\nHold tight, pulling on-chain data... ⏳`,
    { parse_mode: 'HTML' }
  );

  try {
    const isEVM = /^0x[a-fA-F0-9]{40}$/.test(contractAddress);
    const chain = isEVM ? 'ETH' : 'SOL';
    let resultMsg  = null;

    if (isEVM) {
      const res  = await fetch(`https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${contractAddress}`);
      const data = await res.json();
      if (data.code === 1 && data.result?.[contractAddress.toLowerCase()]) {
        const sd         = data.result[contractAddress.toLowerCase()];
        const sourceCode = await getContractSourceCode(contractAddress);
        const aiAudit    = sourceCode ? await getAIAudit(sourceCode, sd) : 'N/A (no verified source)';
        resultMsg =
          `🚓 <b>RUGCOP INSPECTION REPORT</b> 🚓\n\n` +
          `⛓️ <b>Chain:</b> Ethereum\n` +
          `🪙 <b>Token:</b> ${sd.token_name || "?"} (${sd.token_symbol || "?"})\n` +
          `📍 <b>Address:</b> <code>${contractAddress}</code>\n\n` +
          `🍯 <b>Honeypot:</b> ${sd.is_honeypot === "1" ? "🚨 YES" : "✅ NO"}\n` +
          `💸 <b>Tax:</b> Buy ${Math.round((sd.buy_tax||0)*100)}% | Sell ${Math.round((sd.sell_tax||0)*100)}%\n` +
          `🖨️ <b>Mintable:</b> ${sd.is_mintable === "1" ? "🚨 YES" : "✅ NO"}\n\n` +
          `🧠 <b>AI Risk & Audit:</b> ${aiAudit}\n\n` +
          `💡 On-chain analysis complete. Tap below to snipe.`;
      }
    } else {
      const res  = await fetch(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${contractAddress}`);
      const data = await res.json();
      const key  = Object.keys(data.result || {})[0];
      if (data.code === 1 && data.result && key) {
        const sd      = data.result[key];
        const meta    = sd.metadata || {};
        let holders   = sd?.top_holders || [];
        if (!holders.length) holders = await fetchTopHoldersFromHelius(contractAddress);
        let top10str = 'N/A';
        if (sd?.top_holders && sd.top_holders.length > 0) {
          const top10pct = sd.top_holders.slice(0, 10).reduce((s, h) => s + parseFloat(h.percent || 0), 0);
          if (top10pct > 0) top10str = Math.round(top10pct) + '%';
        } else if (holders && holders.length > 0) {
          top10str = '⚠️ Hidden (Fetched via RPC)';
        }
        const bundleRisk = await analyzeBundleRisk(holders);
        let bundleLabel = bundleRisk.label;
        let bundleRiskAdd = bundleRisk.riskAdd || 0;
        if (bundleRisk.label.includes('UNAVAILABLE')) {
          try {
            const genesisRisk = await checkGenesisBundle(contractAddress);
            bundleLabel = genesisRisk.label;
            bundleRiskAdd += (genesisRisk.riskAdd || 0);
          } catch (e) {
            console.error('checkGenesisBundle (runScanInChat):', e.message);
          }
        }
        const baseRisk = calcRisk(sd, 'SOL');
        const finalRisk = Math.min(99, baseRisk + bundleRiskAdd);
        const aiAudit = await getAIAudit('SOLANA_TOKEN', sd, bundleLabel, finalRisk);
        resultMsg =
          `🚓 <b>RUGCOP INSPECTION REPORT</b> 🚓\n\n` +
          `⛓️ <b>Chain:</b> Solana\n` +
          `🪙 <b>Token:</b> ${meta.name || "?"} (${meta.symbol || "?"})\n` +
          `📍 <b>Address:</b> <code>${contractAddress}</code>\n\n` +
          `📊 <b>Risk:</b> ${finalRisk}%\n\n` +
          `⚖️ <b>Balance Mutable:</b> ${sd.balance_mutable_authority?.status === "1" ? "🚨 YES" : "✅ NO"}\n` +
          `🧊 <b>Freezable:</b> ${sd.freezable?.status === "1" ? "🚨 YES" : "✅ NO"}\n` +
          `🗑️ <b>Closable:</b> ${sd.closable?.status === "1" ? "🚨 YES" : "✅ NO"}\n` +
          `👥 <b>Top 10 Holders:</b> ${top10str}\n\n` +
          `🔗 <b>Bundle Scan:</b> ${bundleLabel}\n\n` +
          `🧠 <b>AI Risk & Audit:</b> ${aiAudit}\n\n` +
          `💡 On-chain analysis complete. Tap below to snipe.`;
      } else {
        resultMsg = `❌ Token not found on Solana.`;
      }
    }

    if (resultMsg) {
      await bot.editMessageText(resultMsg, {
        chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🍌 Snipe with Banana Gun', url: 'https://t.me/BananaGun_bot?start=ref_rugcopbot' }]
          ]
        }
      });
    } else {
      await bot.editMessageText(`❌ ERROR: Target not found or unsupported chain.`, {
        chat_id: chatId, message_id: waitMsg.message_id
      });
    }
  } catch(error) {
    console.error(`🚨 CATCH BLOCK ERROR:`, error.message);
    await bot.editMessageText(`🚨 SYSTEM FAILURE: ${error.message}`, {
      chat_id: chatId, message_id: waitMsg.message_id
    });
  }
}

bot.onText(/\/(cop|scan|shit)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const contractAddress = match[2].replace(/\s+/g, '');
  await runScanInChat(chatId, contractAddress);
});

bot.on('message', async (msg) => {
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return;
  if (SOLANA_CA_REGEX.test(text)) {
    await runScanInChat(msg.chat.id, text);
  }
});