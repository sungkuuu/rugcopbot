require('dotenv').config();
const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TelegramBot = require('node-telegram-bot-api');

const token = process.env.API_KEY.trim().replace(/\r?\n|\r/g, '');
const bot = new TelegramBot(token, { polling: true });

const ETHERSCAN_API_KEY = (process.env.ETHERSCAN_API_KEY || '').trim().replace(/\r?\n|\r/g, '');

// Etherscan: fetch contract source code (full)
async function getContractSourceCode(contractAddress) {
  if (!ETHERSCAN_API_KEY) return '';
  const apiUrl = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getsourcecode&address=${contractAddress}&apikey=${ETHERSCAN_API_KEY}`;
  try {
    const res = await fetch(apiUrl);
    const data = await res.json();
    if (
      data.status !== '1' ||
      !data.result ||
      data.result.length === 0 ||
      !data.result[0].SourceCode
    ) {
      return '';
    }
    let raw = data.result[0].SourceCode || '';

    if (raw.startsWith('{{')) {
      raw = raw.slice(1, -1);
    }
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.sources) {
          let combined = '';
          for (const key in parsed.sources) {
            combined += parsed.sources[key].content || '';
            combined += '\n';
          }
          return combined;
        }
      } catch (e) {}
    }
    return raw || '';
  } catch (e) {
    return '';
  }
}

// OpenAI gpt-4o-mini: EVM = code snippet, Solana = JSON data (hybrid)
async function getAIAudit(sourceCode, sd = {}) {
  if (!process.env.OPENAI_API_KEY) return 'N/A (no OpenAI API key)';

  const isSolana = sourceCode === 'SOLANA_TOKEN';
  const snippet = isSolana
    ? "No smart contract code available (Solana ecosystem). Read the ON-CHAIN SECURITY DATA JSON carefully."
    : (sourceCode && typeof sourceCode === 'string' ? sourceCode.slice(0, 3000) : '');
  const chainContext = isSolana ? "Solana" : "Ethereum/EVM";

  const systemPrompt = `You are a highly cynical, elite crypto security auditor looking for meme coin rugpulls.
CHAIN: ${chainContext}

ON-CHAIN SECURITY DATA (JSON):
${JSON.stringify(sd)}

STRICT RULES:

If EVM and 'is_mintable' or 'mintable' is "1" or true, increase Risk Score to at least 80% and warn about infinite mint dump.

If Solana and ANY of 'freezable', 'balance_mutable', or 'closable' (or similar admin flags) are "1" or true, increase Risk Score to at least 80% and warn about developer admin privileges.

If Solana and all admin flags are safely renounced ("0", false, or NO), give a Risk Score around 10-20% and explicitly state: "Renounced authorities ensure basic technical safety, but beware of dev/social dumping."

Provide an estimated Risk Score (0-100%) and a 1-sentence punchy explanation. Format STRICTLY as: Risk: [XX]% | [1-sentence explanation]`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: snippet }
      ],
      max_tokens: 200,
      temperature: 0
    });
    const text = completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content
      ? completion.choices[0].message.content.trim()
      : 'N/A (empty response)';
    return text;
  } catch (e) {
    return `N/A (${e.message || 'API error'})`;
  }
}

bot.on('polling_error', (error) => {
  console.log("🚨 Polling Error:", error.message);
});

console.log("🚨 RUGCOP RADAR is online. (Ethereum + Solana)");

bot.onText(/\/(cop|scan|shit)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const contractAddress = match[2].replace(/\s+/g, '');

  console.log(`\n========================================`);
  console.log(`🎯 [NEW SCAN] Target: ${contractAddress}`);
  console.log(`📏 Length: ${contractAddress.length}`);

  const waitMsg = await bot.sendMessage(
    chatId,
    `🚨 RUGCOP RADAR ACTIVATED 🚨\n🎯 Target Locked: <code>${contractAddress}</code>\n\n🐶 Sniffing the contract...\nHold tight, pulling on-chain data... ⏳`,
    { parse_mode: 'HTML' }
  );

  try {
    const isEVM = contractAddress.startsWith('0x');
    const isSolana = !isEVM && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(contractAddress);

    console.log(
      `🔍 Chain branch -> isEVM (Ethereum): ${isEVM}, isSolana: ${isSolana}`
    );

    let resultMsg = null;

    if (isEVM) {
      console.log(`⛓️ Fetching Ethereum (GoPlus + OpenAI audit)...`);
      const apiUrl = `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${contractAddress}`;
      const response = await fetch(apiUrl);
      const data = await response.json();

      if (
        data.code === 1 &&
        data.result &&
        data.result[contractAddress.toLowerCase()]
      ) {
        const sd = data.result[contractAddress.toLowerCase()];
        const sourceCode = await getContractSourceCode(contractAddress);
        let aiAudit = 'N/A (no verified source)';
        if (sourceCode) {
          aiAudit = await getAIAudit(sourceCode, sd);
        }
        const auditLine = `🧠 <b>AI Risk & Audit:</b> ${aiAudit}`;
        resultMsg =
          `🚓 <b>RUGCOP INSPECTION REPORT</b> 🚓\n\n` +
          `⛓️ <b>Chain:</b> Ethereum\n` +
          `🪙 <b>Token:</b> ${sd.token_name || "?"} (${sd.token_symbol || "?"})\n` +
          `📍 <b>Address:</b> <code>${contractAddress}</code>\n\n` +
          `🍯 <b>Honeypot:</b> ${sd.is_honeypot === "1" ? "🚨 YES" : "✅ NO"}\n` +
          `💸 <b>Tax:</b> Buy ${Math.round((sd.buy_tax||0)*100)}% | Sell ${Math.round((sd.sell_tax||0)*100)}%\n` +
          `🖨️ <b>Mintable:</b> ${sd.is_mintable === "1" ? "🚨 YES" : "✅ NO"}\n\n` +
          `${auditLine}\n\n` +
          `💡 On-chain analysis complete. Tap below to snipe.`;
      }
    } else if (isSolana) {
      console.log(`⛓️ Fetching Solana (GoPlus only, no Etherscan)...`);
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
        let aiAudit = await getAIAudit('SOLANA_TOKEN', sd);
        const auditLine = `🧠 <b>AI Risk & Audit:</b> ${aiAudit}`;
        resultMsg =
          `🚓 <b>RUGCOP INSPECTION REPORT</b> 🚓\n\n` +
          `⛓️ <b>Chain:</b> Solana\n` +
          `🪙 <b>Token:</b> ${meta.name || "?"} (${meta.symbol || "?"})\n` +
          `📍 <b>Address:</b> <code>${contractAddress}</code>\n\n` +
          `⚖️ <b>Balance Mutable:</b> ${sd.balance_mutable_authority?.status === "1" ? "🚨 YES" : "✅ NO"}\n` +
          `🧊 <b>Freezable:</b> ${sd.freezable?.status === "1" ? "🚨 YES" : "✅ NO"}\n` +
          `🗑️ <b>Closable:</b> ${sd.closable?.status === "1" ? "🚨 YES" : "✅ NO"}\n\n` +
          `${auditLine}\n\n` +
          `💡 On-chain analysis complete. Tap below to snipe.`;
      } else {
        console.log(`❌ Solana parsing failed. API raw data logged.`);
        console.log(JSON.stringify(data, null, 2));
        resultMsg = `🚨 <b>API Debug Data:</b>\n<pre>${JSON.stringify(
          data,
          null,
          2
        )}</pre>`;
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
    await bot.editMessageText(
      `🚨 SYSTEM FAILURE: Network congestion or API error.\nLog: ${error.message}`,
      {
        chat_id: chatId,
        message_id: waitMsg.message_id
      }
    );
  }
});