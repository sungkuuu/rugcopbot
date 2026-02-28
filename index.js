require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.API_KEY.trim().replace(/\r?\n|\r/g, ''); 
const bot = new TelegramBot(token, {polling: true});

bot.on('polling_error', (error) => {
    console.log("🚨 Polling Error:", error.message);
});

console.log("🚨 RUGCOP RADAR 가동 완료 (엑스레이 암구호 모드) 🚨");

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
            resultMsg = `🚓 <b>RUGCOP INSPECTION REPORT</b> 🚓\n\n⛓️ <b>Chain:</b> Ethereum\n🪙 <b>Token:</b> ${sd.token_name || "?"} (${sd.token_symbol || "?"})\n📍 <b>Address:</b> <code>${contractAddress}</code>\n\n🍯 <b>Honeypot:</b> ${sd.is_honeypot === "1" ? "🚨 YES (SCAM)" : "✅ NO"}\n💸 <b>Tax:</b> Buy ${Math.round((sd.buy_tax||0)*100)}% | Sell ${Math.round((sd.sell_tax||0)*100)}%\n🖨️ <b>Mintable:</b> ${sd.is_mintable === "1" ? "⚠️ YES" : "✅ NO"}\n\n<i>💡 Verified. Tap below to snipe.</i>`;
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
            resultMsg = `🚓 <b>RUGCOP INSPECTION REPORT</b> 🚓\n\n⛓️ <b>Chain:</b> Solana\n🪙 <b>Token:</b> ${meta.name || "?"} (${meta.symbol || "?"})\n📍 <b>Address:</b> <code>${contractAddress}</code>\n\n⚖️ <b>Balance Mutable:</b> ${sd.balance_mutable_authority?.status === "1" ? "⚠️ YES" : "✅ NO"}\n🧊 <b>Freezable:</b> ${sd.freezable?.status === "1" ? "⚠️ YES" : "✅ NO"}\n🗑️ <b>Closable:</b> ${sd.closable?.status === "1" ? "⚠️ YES" : "✅ NO"}\n\n<i>💡 Verified. Tap below to snipe.</i>`;
        } else {
            console.log(`❌ Solana Parsing Failed. API Raw Data Below:`);
            console.log(JSON.stringify(data, null, 2));
            resultMsg = `🚨 <b>API Debug Data:</b>\n<pre>${JSON.stringify(data, null, 2)}</pre>`;
        }
    } else {
        console.log(`⚠️ Invalid address format. Not EVM, Not Solana.`);
    }

    if (resultMsg) {
        console.log(`📤 Sending Result to Telegram...`);
        await bot.editMessageText(resultMsg, {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🍌 Snipe with Banana Gun', url: `https://t.me/BananaGunSniper_bot?start=snp_${contractAddress}` }],
                    [{ text: '🤖 Snipe with Maestro', url: `https://t.me/maestro?start=${contractAddress}` }]
                ]
            }
        });
    } else {
        console.log(`📤 Sending Fallback Error to Telegram...`);
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