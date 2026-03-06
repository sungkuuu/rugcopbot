require('dotenv').config();
const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { TwitterApi } = require('twitter-api-v2');

// ============================================================
// INIT
// ============================================================
const bot = new TelegramBot(process.env.API_KEY, { polling: true });
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
// RECENT RUGS STORAGE (JSON 파일)
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

function saveRug(rug) {
  const rugs = loadRugs();
  // 중복 방지
  if (rugs.find(r => r.ca === rug.ca)) return;
  // 최신 50개만 유지
  rugs.unshift(rug);
  if (rugs.length > 50) rugs.splice(50);
  fs.writeFileSync(RUGS_FILE, JSON.stringify(rugs, null, 2));
  console.log(`💾 Rug saved: ${rug.name} (${rug.ca.slice(0,8)}...)`);
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

💰 Vol 24h: $${Number(volume24h).toLocaleString('en-US', {maximumFractionDigits:0})}
📊 MCap: $${Number(marketCap).toLocaleString('en-US')}

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

  saveRug(rug);
  if (rug.risk >= 80 || rug.risk <= 30) await tweetAlert(rug);
}

// ============================================================
// DEXSCREENER + PUMP.FUN 트렌딩/신규 토큰 자동 스캔 (15분마다)
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

    let risk = 0;
    let flags = [];

    if (sd.freezable?.status === '1')               { risk += 35; flags.push('FREEZABLE'); }
    if (sd.balance_mutable_authority?.status === '1'){ risk += 30; flags.push('MUTABLE'); }
    if (sd.closable?.status === '1')                 { risk += 20; flags.push('CLOSABLE'); }
    if (sd.transfer_fee_enable?.status === '1')      { risk += 15; flags.push('TRANSFER_FEE'); }

    const topHolders = sd.top_holders || [];
    const top10pct = topHolders.slice(0,10).reduce((s,h) => s + parseFloat(h.percent||0), 0);
    if (top10pct > 80) { risk += 25; flags.push(`TOP10_HOLD_${Math.round(top10pct)}%`); }
    else if (top10pct > 50) { risk += 10; flags.push(`TOP10_HOLD_${Math.round(top10pct)}%`); }

    if (sd.lp_holders) {
      const lockedLP = sd.lp_holders.filter(h => h.is_locked === 1);
      if (lockedLP.length === 0) { risk += 15; flags.push('LP_UNLOCKED'); }
      else flags.push('LP_LOCKED');
    }
    if (risk < 10) risk = 10;

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
    console.log('🔥 Scanning trending tokens (DexScreener + pump.fun)...');

    // 1) DexScreener 트렌딩
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

    // 2) pump.fun 신규 토큰
    const pumpRes = await fetch('https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=last_trade_timestamp&order=DESC&includeNsfw=false');
    const pumpData = await pumpRes.json();
    const pumpList = Array.isArray(pumpData) ? pumpData : (pumpData?.data ?? pumpData?.coins ?? []);
    const pumpCoins = pumpList.slice(0, 20);

    for (const coin of pumpCoins) {
      const ca = coin.mint ?? coin.address ?? coin.token_address;
      if (!ca) continue;
      await scanOneSolanaToken(ca, {
        name: coin.name ?? coin.title,
        symbol: coin.symbol,
        description: coin.description,
      });
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
app.get('/api/recent-rugs', (req, res) => {
  const rugs = loadRugs();
  // 시간 포맷 추가
  const formatted = rugs.map(r => ({
    ...r,
    timeAgo: getTimeAgo(r.time),
    riskLabel: getRiskLabel(r.risk ?? 0),
  }));
  res.json(formatted);
});

app.get('/api/stats', (req, res) => {
  const rugs = loadRugs();
  res.json({
    totalRugs: rugs.length,
    last24h:   rugs.filter(r => Date.now() - r.time < 86400000).length,
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
app.listen(PORT, () => {
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

async function getAIAudit(sourceCode, sd = {}) {
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
    ? `Freezable: ${solFreezable}, Balance Mutable: ${solMutable}, Closable: ${solClosable}`
    : `Honeypot: ${isHoneypot}, Mintable: ${isMintable}, Buy Tax: ${buyTax}%, Sell Tax: ${sellTax}%`;

  const systemPrompt = `You are a highly cynical, elite crypto security auditor looking for meme coin rugpulls.
CHAIN: ${chainContext}
CRITICAL ON-CHAIN DATA: ${securityDataText}
STRICT RULES:
IF CHAIN IS EVM: If 'Mintable' is YES, increase Risk Score to at least 80%.
IF CHAIN IS SOLANA: If ANY of Freezable, Balance Mutable, or Closable is YES, Risk Score at least 80%.
IF CHAIN IS SOLANA AND ALL flags are NO: Risk Score around 10-20%, state "Renounced authorities ensure basic technical safety, but beware of dev/social dumping."
Format STRICTLY as: Risk: [XX]% | [1-sentence explanation]`;

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

bot.onText(/\/(cop|scan|shit)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const contractAddress = match[2].replace(/\s+/g, '');

  const waitMsg = await bot.sendMessage(chatId,
    `🚨 RUGCOP RADAR ACTIVATED 🚨\n🎯 Target Locked: <code>${contractAddress}</code>\n\n🐶 Sniffing the contract...\nHold tight, pulling on-chain data... ⏳`,
    { parse_mode: 'HTML' }
  );

  try {
    const isEVM    = contractAddress.startsWith('0x');
    const isSolana = !isEVM && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(contractAddress);
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
    } else if (isSolana) {
      const res  = await fetch(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${contractAddress}`);
      const data = await res.json();
      const key  = Object.keys(data.result || {})[0];
      if (data.code === 1 && data.result && key) {
        const sd      = data.result[key];
        const meta    = sd.metadata || {};
        const aiAudit = await getAIAudit('SOLANA_TOKEN', sd);
        resultMsg =
          `🚓 <b>RUGCOP INSPECTION REPORT</b> 🚓\n\n` +
          `⛓️ <b>Chain:</b> Solana\n` +
          `🪙 <b>Token:</b> ${meta.name || "?"} (${meta.symbol || "?"})\n` +
          `📍 <b>Address:</b> <code>${contractAddress}</code>\n\n` +
          `⚖️ <b>Balance Mutable:</b> ${sd.balance_mutable_authority?.status === "1" ? "🚨 YES" : "✅ NO"}\n` +
          `🧊 <b>Freezable:</b> ${sd.freezable?.status === "1" ? "🚨 YES" : "✅ NO"}\n` +
          `🗑️ <b>Closable:</b> ${sd.closable?.status === "1" ? "🚨 YES" : "✅ NO"}\n\n` +
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
            [{ text: '🍌 Snipe with Banana Gun', url: 'https://t.me/BananaGunSniper_bot?start=ref_rugcop' }]
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
});