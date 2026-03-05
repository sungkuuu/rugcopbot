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
const token = process.env.API_KEY.trim().replace(/\r?\n|\r/g, '');
const bot = new TelegramBot(token, { polling: true });
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

const ETHERSCAN_API_KEY = (process.env.ETHERSCAN_API_KEY || '').trim();
const HELIUS_API_KEY    = (process.env.HELIUS_API_KEY    || '').trim();

const twitter = new TwitterApi({
  appKey:            process.env.TWITTER_APP_KEY,
  appSecret:         process.env.TWITTER_APP_SECRET,
  accessToken:       process.env.TWITTER_ACCESS_TOKEN,
  accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

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

// 이미 트윗한 CA
const tweetedCAs = new Set();

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
    return flagCount >= 2 ? 90 : flagCount === 1 ? 75 : 15;
  } else {
    const honeypot = sd.is_honeypot === '1';
    const mintable = sd.is_mintable === '1';
    const sellTax  = Math.round((sd.sell_tax || 0) * 100);
    if (honeypot) return 99;
    if (mintable)  return 85;
    if (sellTax > 20) return 75;
    return 15;
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
async function tweetScamAlert(rug) {
  if (tweetedCAs.has(rug.ca)) return;
  if (!process.env.TWITTER_APP_KEY) return;

  const flagText = rug.flags.map(f => `🚨 ${f}`).join('\n');
  const shortCA  = `${rug.ca.slice(0,6)}...${rug.ca.slice(-6)}`;

  const text =
`🚨 SCAM ALERT — $${rug.symbol}

Token: ${rug.name}
CA: ${shortCA}
Chain: ${rug.chain}

${flagText}

Risk Score: ${rug.risk}%

🔍 Scan before you ape:
rugcop.xyz | t.me/RugCopBot

#${rug.chain === 'SOL' ? 'Solana' : 'Ethereum'} #RugPull #CryptoScam`;

  try {
    await twitter.v2.tweet(text);
    tweetedCAs.add(rug.ca);
    console.log(`🐦 Tweeted scam alert: ${rug.symbol}`);
  } catch(e) {
    console.error('Tweet failed:', e.message);
  }
}

// ============================================================
// PROCESS NEW TOKEN (Helius webhook에서 호출)
// ============================================================
async function processNewToken(ca, name, symbol) {
  console.log(`🔍 New token detected: ${symbol} (${ca})`);

  const sd = await scanSolanaToken(ca);
  if (!sd) return;

  const risk  = calcRisk(sd, 'SOL');
  const flags = getFlags(sd, 'SOL');
  const meta  = sd.metadata || {};

  // 70% 이상만 저장 + 알림
  if (risk < 70) {
    console.log(`✅ ${symbol} - Low risk (${risk}%), skipping`);
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

  saveRug(rug);
  await tweetScamAlert(rug);
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

// ============================================================
// EXPRESS SERVER START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 API server running on port ${PORT}`);
  console.log(`📡 Helius webhook ready at /webhook/helius`);
  console.log(`🔗 Recent rugs API at /api/recent-rugs`);
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

bot.on('polling_error', (error) => console.log("🚨 Polling Error:", error.message));
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
            [{ text: '🍌 Snipe with Banana Gun', url: 'https://t.me/BananaGunSniper_bot?start=ref_499191084' }],
            [{ text: '🤖 Snipe with Maestro',    url: 'https://t.me/maestro?start=r-sungku' }]
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