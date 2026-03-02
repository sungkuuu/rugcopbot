require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.API_KEY.trim().replace(/\r?\n|\r/g, '');
const bot = new TelegramBot(token, {polling: true});

const ETHERSCAN_API_KEY = (process.env.ETHERSCAN_API_KEY || '').trim().replace(/\r?\n|\r/g, '');

// Known mixer / high-risk funding sources (Ethereum mainnet, lowercase)
const FUNDING_LABELS = {
  '0x910cbd523d972eb0a6f4ca4618745773403d30d0': '🚨 Tornado Cash (Mixer)',
  '0x722122df12d4e14e13ac3b6895a86e84145b6967': '🚨 Tornado Cash (Mixer)',
  '0x722122df12d4e14e13ac3b6895a86e84145b6966': '🚨 Tornado Cash (Mixer)',
  '0xd90e2f925da726b50c4ed8d0fb9452c698e3693e': '🚨 Tornado Cash (Mixer)',
  '0x722122df12d4e14e13ac3b6895a86e84145b6965': '🚨 Tornado Cash (Mixer)',
  '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936': '🚨 Tornado Cash (Mixer)',
  '0x12d66f87a04a9e220743712ce6d9bb1b5616b8fd': '🚨 Tornado Cash (Mixer)',
  '0x722122df12d4e14e13ac3b6895a86e84145b6964': '🚨 Tornado Cash (Mixer)',
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance 14',
  '0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be': 'Binance 1',
  '0xd551234ae421e3bcba99a0da6d736074f22192ff': 'Binance 2',
  '0x1151314c646ce4e0efd76d1af4760ae66a9fe30f': 'FixedFloat',
};

async function getDeployerFunding(contractAddress) {
  if (!ETHERSCAN_API_KEY) return 'N/A (no Etherscan API key)';
  const base = 'https://api.etherscan.io/api';
  try {
    const creatorRes = await fetch(
      `${base}?module=contract&action=getcontractcreation&contractaddresses=${contractAddress}&apikey=${ETHERSCAN_API_KEY}`
    );
    const creatorData = await creatorRes.json();
    if (creatorData.status !== '1' || !creatorData.result?.length) return 'Deployer not found';
    const deployer = (creatorData.result[0].contractCreator || '').toLowerCase();
    if (!deployer) return 'Deployer not found';

    const txRes = await fetch(
      `${base}?module=account&action=txlist&address=${deployer}&startblock=0&endblock=99999999&sort=asc&page=1&offset=10&apikey=${ETHERSCAN_API_KEY}`
    );
    const txData = await txRes.json();
    if (txData.status !== '1' || !txData.result?.length) return `Deployer: ${deployer.slice(0, 6)}...${deployer.slice(-4)}`;

    const firstIncoming = txData.result.find((tx) => (tx.to || '').toLowerCase() === deployer);
    const funder = firstIncoming
      ? (firstIncoming.from || '').toLowerCase()
      : (txData.result[0].from || '').toLowerCase();
    const label = FUNDING_LABELS[funder];
    if (label) return label;
    return `EOA: ${funder.slice(0, 6)}...${funder.slice(-4)}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

async function getContractSourceCode(contractAddress) {
  if (!ETHERSCAN_API_KEY) return '';
  const base = 'https://api.etherscan.io/api';
  try {
    const res = await fetch(
      `${base}?module=contract&action=getsourcecode&address=${contractAddress}&apikey=${ETHERSCAN_API_KEY}`
    );
    const data = await res.json();
    if (data.status !== '1' || !data.result?.length || data.result[0].SourceCode === '') return '';
    let raw = data.result[0].SourceCode || '';
    if (raw.startsWith('{{')) {
      raw = raw.slice(1, -1);
    }
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.sources) {
          return Object.values(parsed.sources).map((s) => (s.content || '')).join('\n');
        }
      } catch (_) {}
    }
    return raw;
  } catch (e) {
    return '';
  }
}

// Scam pattern analyzer (rugpull-style keywords → 0–99% similarity)
const SCAM_PATTERNS = [
  { pattern: /\bblacklist\b|isBlacklisted|addToBlacklist|_isBlacklisted|blacklist\s*\[/gi, weight: 15 },
  { pattern: /\bdisableTrading\b|tradingEnabled\s*=\s*false|setTradingEnabled\s*\(\s*false|tradingOpen\s*=\s*false/gi, weight: 15 },
  { pattern: /\b_mint\s*\([^)]*to\s*,\s*[^)]*\)|mint\s*\(\s*[^)]*\)\s*external\s*onlyOwner|_mint\s*\([^)]*amount/gi, weight: 12 },
  { pattern: /takeFee|_takeFee|takeSellFee|feeReceiver|feeRecipient|balanceOf\s*\(\s*owner\s*\)\s*\+|transfer\s*\(\s*owner/gi, weight: 18 },
  { pattern: /excludeFromFee\s*\(\s*owner|includeInFee\s*\(\s*owner|isExcludedFromFee\s*\[\s*owner\s\]/gi, weight: 12 },
  { pattern: /maxTxAmount\s*=\s*0|setMaxTxAmount\s*\(|maxSellAmount\s*=\s*0|maxBuyAmount\s*=\s*0/gi, weight: 10 },
  { pattern: /selfdestruct\s*\(|suicide\s*\(|delegatecall\s*\([^)]*\)/gi, weight: 22 },
  { pattern: /sellLimit|buyLimit|setSellLimit\s*\(\s*0|setBuyLimit\s*\(\s*0/gi, weight: 8 },
  { pattern: /antibot|antiBot|anti_bot|blockBot|_blockBot/gi, weight: 10 },
  { pattern: /cooldown|cooldownEnabled|setCooldown|transferCooldown/gi, weight: 6 },
  { pattern: /swapAndLiquifyEnabled\s*=\s*false|swapAndLiquify\s*\(\s*\)/gi, weight: 5 },
  { pattern: /renounceOwnership\s*\(\s*\)|transferOwnership\s*\(\s*0x0\s*\)/gi, weight: 3 },
];

function calcScamCodeSimilarity(sourceCode) {
  if (!sourceCode || typeof sourceCode !== 'string') return { score: 0, warning: false };
  const normalized = sourceCode.replace(/\s+/g, ' ').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  let total = 0;
  for (const { pattern, weight } of SCAM_PATTERNS) {
    const matches = normalized.match(pattern);
    if (matches) total += weight * Math.min(matches.length, 3);
  }
  const score = Math.min(99, Math.round(total));
  const warning = score >= 40;
  return { score, warning };
}

bot.on('polling_error', (error) => {
    console.log("🚨 Polling Error:", error.message);
});

console.log("🚨 RUGCOP RADAR is online.");

// 🔥 암구호 /xray 완벽 탑재
bot.onText(/\/(cop|scan|shit)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const contractAddress = match[2].replace(/\s+/g, '');

  console.log(`\n========================================`);
  console.log(`🎯 [NEW SCAN] Target: ${contractAddress}`);
  console.log(`📏 Length: ${contractAddress.length}`);

  const waitMsg = await bot.sendMessage(chatId, `🚨 RUGCOP RADAR ACTIVATED 🚨\n🎯 Target Locked: <code>${contractAddress}</code>\n\n🐶 Sniffing the contract...\nHold tight, pulling on-chain data... ⏳`, {parse_mode: 'HTML'});

  try {
    const isEVM = contractAddress.startsWith('0x');
    const isSolana = !isEVM && contractAddress.length >= 30 && contractAddress.length <= 45; 
    
    console.log(`🔍 Type Check -> isEVM: ${isEVM}, isSolana: ${isSolana}`);

    let resultMsg = null;

    if (isEVM) {
        console.log(`⛓️  Fetching Ethereum API...`);
        const apiUrl = `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${contractAddress}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        
        if (data.code === 1 && data.result && data.result[contractAddress.toLowerCase()]) {
            const sd = data.result[contractAddress.toLowerCase()];
            const sourceCode = await getContractSourceCode(contractAddress);
            const { score: similarityScore, warning: similarityWarning } = calcScamCodeSimilarity(sourceCode);
            const similarityLine = sourceCode
              ? `🧬 <b>Scam Similarity:</b> ${similarityScore}%${similarityWarning ? ' 🚨 HIGH RISK' : ''}`
              : '🧬 <b>Scam Similarity:</b> N/A (no verified source)';
            resultMsg = `🚓 <b>RUGCOP INSPECTION REPORT</b> 🚓\n\n⛓️ <b>Chain:</b> Ethereum\n🪙 <b>Token:</b> ${sd.token_name || "?"} (${sd.token_symbol || "?"})\n📍 <b>Address:</b> <code>${contractAddress}</code>\n\n🍯 <b>Honeypot:</b> ${sd.is_honeypot === "1" ? "🚨 YES" : "✅ NO"}\n💸 <b>Tax:</b> Buy ${Math.round((sd.buy_tax||0)*100)}% | Sell ${Math.round((sd.sell_tax||0)*100)}%\n🖨️ <b>Mintable:</b> ${sd.is_mintable === "1" ? "🚨 YES" : "✅ NO"}\n${similarityLine}\n\n💡 On-chain analysis complete. Tap below to snipe.`;
        }
    } else if (isSolana) {
        console.log(`⛓️  Fetching Solana API...`);
        const apiUrl = `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${contractAddress}`;
        console.log(`🔗 Request URL: ${apiUrl}`);
        
        const response = await fetch(apiUrl);
        const data = await response.json();
        
        console.log(`📥 API Response Code: ${data.code}`);
        
        const resultKey = Object.keys(data.result || {})[0];
        
        if (data.code === 1 && data.result && resultKey) {
            console.log(`✅ Solana Parsing Success!`);
            const sd = data.result[resultKey];
            const meta = sd.metadata || {};
            resultMsg = `🚓 <b>RUGCOP INSPECTION REPORT</b> 🚓\n\n⛓️ <b>Chain:</b> Solana\n🪙 <b>Token:</b> ${meta.name || "?"} (${meta.symbol || "?"})\n📍 <b>Address:</b> <code>${contractAddress}</code>\n\n⚖️ <b>Balance Mutable:</b> ${sd.balance_mutable_authority?.status === "1" ? "🚨 YES" : "✅ NO"}\n🧊 <b>Freezable:</b> ${sd.freezable?.status === "1" ? "🚨 YES" : "✅ NO"}\n🗑️ <b>Closable:</b> ${sd.closable?.status === "1" ? "🚨 YES" : "✅ NO"}\n\n🧬 <b>Scam Similarity:</b> N/A (Etherscan source not used for Solana)\n\n💡 On-chain analysis complete. Tap below to snipe.`;
        } else {
            console.log(`❌ Solana parsing failed. API raw data logged.`);
            console.log(JSON.stringify(data, null, 2));
            resultMsg = `🚨 <b>API Debug Data:</b>\n<pre>${JSON.stringify(data, null, 2)}</pre>`;
        }
    } else {
        console.log(`⚠️ Invalid address format. Not EVM, not Solana.`);
    }

    if (resultMsg) {
        console.log(`📤 Sending Result to Telegram...`);
        await bot.editMessageText(resultMsg, {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🍌 Snipe with Banana Gun', url: 'https://t.me/BananaGunSniper_bot?start=ref_499191084' }],
                    [{ text: '🤖 Snipe with Maestro', url: 'https://t.me/maestro?start=r-sungku' }]
                ]
            }
        });
    } else {
        console.log(`📤 Sending fallback error to Telegram.`);
        await bot.editMessageText(`❌ ERROR: Target not found or unsupported chain.`, {
            chat_id: chatId,
            message_id: waitMsg.message_id
        });
    }

  } catch (error) {
    console.error(`🚨 CATCH BLOCK ERROR:`, error.message);
    await bot.editMessageText(`🚨 SYSTEM FAILURE: Network congestion or API error.\nLog: ${error.message}`, {
        chat_id: chatId,
        message_id: waitMsg.message_id
    });
  }
});