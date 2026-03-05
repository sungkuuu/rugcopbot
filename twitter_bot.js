require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const { OpenAI } = require('openai');

// ============================================================
// 🚓 RUGCOP TWITTER MENTION BOT
// 유저가 @rugcopbot [CA주소] 멘션하면 즉시 분석 후 답글
// ============================================================

const client = new TwitterApi({
  appKey:       process.env.TWITTER_APP_KEY,
  appSecret:    process.env.TWITTER_APP_SECRET,
  accessToken:  process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ETHERSCAN_API_KEY = (process.env.ETHERSCAN_API_KEY || '').trim();
const HELIUS_API_KEY    = (process.env.HELIUS_API_KEY    || '').trim();

// ============================================================
// ⚙️ 설정값
// ============================================================
const CONFIG = {
  POLL_INTERVAL_MS:   15000,  // 멘션 체크 간격 (15초)
  REPLY_DELAY_MS:     3000,   // 답글 간 딜레이
  MAX_REPLIES_PER_HR: 20,     // 시간당 최대 답글
};

// ============================================================
// 🛡️ 중복 방지
// ============================================================
const repliedTweets = new Set();
let lastMentionId   = null;
let repliesThisHour = 0;

setInterval(() => { repliesThisHour = 0; }, 60 * 60 * 1000);

// ============================================================
// 🔍 CA 추출 (EVM + Solana)
// ============================================================
const EVM_REGEX    = /0x[a-fA-F0-9]{40}/;
const SOLANA_REGEX = /[1-9A-HJ-NP-Za-km-z]{43,44}/;

function extractCA(text) {
  // 봇 멘션 제거 후 CA 추출
  const clean = text.replace(/@\w+/g, '').trim();
  const evm = clean.match(EVM_REGEX);
  if (evm) return { ca: evm[0], chain: 'evm' };
  const sol = clean.match(SOLANA_REGEX);
  if (sol) return { ca: sol[0], chain: 'solana' };
  return null;
}

// ============================================================
// 📡 GoPlus 분석
// ============================================================
async function analyzeEVM(ca) {
  const res  = await fetch(`https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${ca}`);
  const data = await res.json();
  if (data.code !== 1) return null;
  const sd = data.result?.[ca.toLowerCase()];
  if (!sd) return null;
  return {
    name:     sd.token_name    || '?',
    symbol:   sd.token_symbol  || '?',
    honeypot: sd.is_honeypot   === '1',
    mintable: sd.is_mintable   === '1',
    buyTax:   Math.round((sd.buy_tax  || 0) * 100),
    sellTax:  Math.round((sd.sell_tax || 0) * 100),
    creator:  sd.creator_address || null,
  };
}

async function analyzeSolana(ca) {
  const res  = await fetch(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${ca}`);
  const data = await res.json();
  if (data.code !== 1) return null;
  const key = Object.keys(data.result || {})[0];
  if (!key) return null;
  const sd   = data.result[key];
  const meta = sd.metadata || {};
  return {
    name:      meta.name   || '?',
    symbol:    meta.symbol || '?',
    freezable: sd.freezable?.status               === '1',
    mutable:   sd.balance_mutable_authority?.status === '1',
    closable:  sd.closable?.status                === '1',
    issuer:    sd.issuer || null,
  };
}

// ============================================================
// 🕵️ Dev Wallet 히스토리
// ============================================================
async function getEVMDevHistory(creatorAddress) {
  if (!ETHERSCAN_API_KEY || !creatorAddress) return null;
  try {
    const url  = `https://api.etherscan.io/api?module=account&action=txlist&address=${creatorAddress}&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.status !== '1') return null;

    const deployTxs = data.result
      .filter(tx => tx.to === '' && tx.contractAddress)
      .slice(0, 5);
    if (deployTxs.length === 0) return { total: 0, rugs: 0 };

    const checks = await Promise.all(
      deployTxs.map(tx => analyzeEVM(tx.contractAddress).catch(() => null))
    );
    const rugs = checks.filter(c => c?.honeypot || c?.mintable).length;
    return { total: checks.length, rugs };
  } catch { return null; }
}

async function getSolanaDevHistory(issuerAddress) {
  if (!HELIUS_API_KEY || !issuerAddress) return null;
  try {
    const res  = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'rugcop', method: 'getAssetsByAuthority',
        params: { authorityAddress: issuerAddress, page: 1, limit: 5 },
      }),
    });
    const data  = await res.json();
    const items = data.result?.items || [];
    if (items.length === 0) return { total: 0, rugs: 0 };

    const checks = await Promise.all(
      items.map(item => analyzeSolana(item.id).catch(() => null))
    );
    const rugs = checks.filter(c => c?.freezable || c?.mutable || c?.closable).length;
    return { total: checks.length, rugs };
  } catch { return null; }
}

// ============================================================
// 🧠 AI 리스크 스코어
// ============================================================
async function getAIRisk(chain, info, devHistory) {
  const devLine = devHistory
    ? `Dev wallet: ${devHistory.total} prev tokens, ${devHistory.rugs} risky/rugged.`
    : 'Dev wallet: unavailable.';

  const flags = chain === 'evm'
    ? `Honeypot: ${info.honeypot ? 'YES' : 'NO'}, Mintable: ${info.mintable ? 'YES' : 'NO'}, Buy Tax: ${info.buyTax}%, Sell Tax: ${info.sellTax}%`
    : `Freezable: ${info.freezable ? 'YES' : 'NO'}, Mutable: ${info.mutable ? 'YES' : 'NO'}, Closable: ${info.closable ? 'YES' : 'NO'}`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'system',
      content: `You are RugCop, elite crypto security bot on Twitter.
Chain: ${chain.toUpperCase()} | Token: ${info.name} (${info.symbol})
Flags: ${flags}
${devLine}
Give Risk Score (0-100%) + ONE punchy sentence under 180 chars total.
Format STRICTLY: Risk: [XX]% | [sentence]`,
    }],
    max_tokens: 80,
    temperature: 0,
  });
  return res.choices[0]?.message?.content?.trim() ?? 'Risk: N/A | Could not assess.';
}

// ============================================================
// 💬 답글 메시지 조립
// ============================================================
async function buildReply(ca, chain) {
  try {
    if (chain === 'evm') {
      const info = await analyzeEVM(ca);
      if (!info) return `🚓 RugCop: ❌ Token not found on Ethereum. Check the CA and try again.`;
      const dev    = await getEVMDevHistory(info.creator);
      const ai     = await getAIRisk('evm', info, dev);
      const devLine = dev
        ? (dev.rugs > 0 ? `⚠️ Dev: ${dev.rugs}/${dev.total} prev tokens RUGGED` : `✅ Dev: ${dev.total} prev tokens clean`)
        : '';
      return [
        `🚓 RugCop Scan | ${info.name} (${info.symbol})`,
        `⛓ ETH | 🍯 Honeypot: ${info.honeypot ? '🚨YES' : '✅NO'} | 🖨 Mint: ${info.mintable ? '🚨YES' : '✅NO'}`,
        `💸 Tax: Buy ${info.buyTax}% / Sell ${info.sellTax}%`,
        devLine,
        `🧠 ${ai}`,
        `📲 Full scan → @rugcopbot on Telegram`,
      ].filter(Boolean).join('\n');

    } else {
      const info = await analyzeSolana(ca);
      if (!info) return `🚓 RugCop: ❌ Token not found on Solana. Check the CA and try again.`;
      const dev    = await getSolanaDevHistory(info.issuer);
      const ai     = await getAIRisk('solana', info, dev);
      const devLine = dev
        ? (dev.rugs > 0 ? `⚠️ Dev: ${dev.rugs}/${dev.total} prev tokens RISKY` : `✅ Dev: ${dev.total} prev tokens clean`)
        : '';
      return [
        `🚓 RugCop Scan | ${info.name} (${info.symbol})`,
        `⛓ SOL | 🧊 Freeze: ${info.freezable ? '🚨YES' : '✅NO'} | ⚖️ Mutable: ${info.mutable ? '🚨YES' : '✅NO'} | 🗑 Close: ${info.closable ? '🚨YES' : '✅NO'}`,
        devLine,
        `🧠 ${ai}`,
        `📲 Full scan → @rugcopbot on Telegram`,
      ].filter(Boolean).join('\n');
    }
  } catch (e) {
    return `🚓 RugCop: ⚠️ Analysis failed. Try again or use @rugcopbot on Telegram.`;
  }
}

// ============================================================
// 📬 멘션 폴링 (15초마다 체크)
// ============================================================
async function getMyUserId() {
  const me = await client.v2.me();
  return me.data.id;
}

async function pollMentions(myUserId) {
  try {
    const params = {
      max_results: 10,
      'tweet.fields': ['author_id', 'text', 'created_at'],
      expansions: ['author_id'],
    };
    if (lastMentionId) params.since_id = lastMentionId;

    const mentions = await client.v2.userMentionTimeline(myUserId, params);
    const tweets   = mentions.data?.data || [];

    if (tweets.length === 0) {
      console.log('👀 새 멘션 없음. 대기 중...');
      return;
    }

    // 가장 최신 ID 저장
    lastMentionId = tweets[0].id;

    for (const tweet of tweets) {
      if (repliedTweets.has(tweet.id))         continue;
      if (repliesThisHour >= CONFIG.MAX_REPLIES_PER_HR) {
        console.log('⏸ 시간당 한도 도달. 다음 시간에 재개.');
        break;
      }

      console.log(`\n🎯 멘션 감지: "${tweet.text.substring(0, 80)}"`);

      const found = extractCA(tweet.text);
      if (!found) {
        // CA 없는 멘션 — 사용법 안내 답글
        console.log('ℹ️ CA 없는 멘션 — 사용법 안내');
        try {
          await client.v2.reply(
            `🚓 RugCop here! Send me a contract address to scan.\n\nExample:\n@rugcopbot 0x1234...abcd (ETH)\n@rugcopbot 7xKXt...pump (SOL)\n\n📲 Or use @rugcopbot on Telegram for full scan!`,
            tweet.id
          );
          repliedTweets.add(tweet.id);
          repliesThisHour++;
        } catch (e) {
          console.log('⚠️ 사용법 안내 답글 실패:', e.message);
        }
        continue;
      }

      console.log(`🔍 CA 감지 [${found.chain.toUpperCase()}]: ${found.ca}`);

      await new Promise(r => setTimeout(r, CONFIG.REPLY_DELAY_MS));

      try {
        const replyText = await buildReply(found.ca, found.chain);
        console.log(`💬 답글:\n${replyText}`);

        await client.v2.reply(replyText, tweet.id);
        repliedTweets.add(tweet.id);
        repliesThisHour++;
        console.log('✅ 답글 성공!');
      } catch (e) {
        console.error('🚨 답글 실패:', e.message);
      }
    }

  } catch (e) {
    console.error('🚨 멘션 폴링 에러:', e.message);
  }
}

// ============================================================
// 🚀 시작
// ============================================================
async function main() {
  console.log('🚓 RUGCOP TWITTER MENTION BOT 시작!');
  console.log('📬 사용법: @rugcopbot [CA주소] 멘션하면 즉시 분석!\n');

  const myUserId = await getMyUserId();
  console.log(`✅ 봇 계정 ID: ${myUserId}`);
  console.log(`⏱ ${CONFIG.POLL_INTERVAL_MS / 1000}초마다 멘션 체크 시작...\n`);

  // 시작 시 최신 멘션 ID 초기화 (과거 멘션 무시)
  try {
    const init = await client.v2.userMentionTimeline(myUserId, { max_results: 5 });
    if (init.data?.data?.[0]) {
      lastMentionId = init.data.data[0].id;
      console.log(`📌 시작 기준점 설정: ${lastMentionId} (이전 멘션 무시)\n`);
    }
  } catch (e) {
    console.log('⚠️ 초기화 실패, 전체 멘션부터 처리:', e.message);
  }

  // 즉시 1회 실행 후 인터벌
  await pollMentions(myUserId);
  setInterval(() => pollMentions(myUserId), CONFIG.POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('🚨 시작 실패:', err.message);
  process.exit(1);
});