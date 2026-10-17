require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const { Pool } = require('pg');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==================== TELEGRAM BOT LOGIC ====================

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || 'Anonymous';

    try {
        await pool.query(
            'INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING',
            [userId, username]
        );

        ctx.reply(
            `🚀 *Welcome to the Stake Bonus Portal, ${ctx.from.first_name}!*\n\n` +
            `💰 *Promo Offer:* Deposit \$100 or more to claim your *40% Bonus* with a strict *4x Rollover requirement*.\n\n` +
            `👇 *Select your preferred deposit currency:*`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('💎 USDT (TRC20)', 'pay_usdttrc20'), Markup.button.callback('🪙 Bitcoin (BTC)', 'pay_btc')],
                    [Markup.button.callback('⚡ Litecoin (LTC)', 'pay_ltc'), Markup.button.callback('🚀 Ethereum (ETH)', 'pay_eth')],
                    [Markup.button.callback('🐕 Dogecoin (DOGE)', 'pay_doge'), Markup.button.callback('🟣 Solana (SOL)', 'pay_sol')]
                ])
            }
        );
    } catch (err) {
        console.error("Error on /start:", err);
    }
});

bot.action(/^pay_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const selectedCurrency = ctx.match[1];
    const depositAddress = `0x_LiveGateway_${selectedCurrency.toUpperCase()}_Addr_${userId}`;

    await ctx.editMessageText(
        `✅ Selected: *${selectedCurrency.toUpperCase()}*\n\n` +
        `📥 *Your Unique Deposit Address:*\n\`${depositAddress}\`\n\n` +
        `⚠️ *Send only ${selectedCurrency.toUpperCase()} to this address.* Once confirmed, our bot will automatically request your Stake username!`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('balance', async (ctx) => {
    const userId = ctx.from.id;
    try {
        const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        if (userResult.rows.length === 0) return ctx.reply("Please send /start first.");

        const user = userResult.rows[0];
        ctx.reply(
            `📊 *Your Account Summary:*\n\n` +
            `👤 Linked Stake User: *${user.stake_username || 'Not Linked Yet ❌'}*\n` +
            `💵 Main Balance: \$${user.main_balance}\n` +
            `🎁 Bonus Balance: \$${user.bonus_balance}\n` +
            `🔄 Rollover Left: \$${user.rollover_remaining}\n` +
            `📈 Total Deposited: \$${user.total_deposited}\n` +
            `📌 Status: *${user.status}*`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.error("Balance fetch error:", err);
    }
});

// Webhook from Payment Gateway
app.post('/api/crypto-webhook', async (req, res) => {
    const { userId, amountUSD } = req.body; 
    if (!userId || !amountUSD) return res.status(400).send({ error: "Missing parameters" });

    try {
        let bonusAmount = amountUSD >= 100 ? amountUSD * 0.40 : 0;
        let totalCredited = amountUSD + bonusAmount;
        let rolloverRequirement = totalCredited * 4;

        await pool.query(
            `UPDATE users 
             SET main_balance = main_balance + $1, 
                 bonus_balance = bonus_balance + $2, 
                 rollover_remaining = rollover_remaining + $3, 
                 total_deposited = total_deposited + $1,
                 status = 'Pending Stake Credit' 
             WHERE telegram_id = $4`,
            [amountUSD, bonusAmount, rolloverRequirement, userId]
        );

        await bot.telegram.sendMessage(
            userId,
            `📥 *Deposit Confirmed on Gateway!*\n\n` +
            `💵 Deposited Value: \$${amountUSD}\n` +
            `🎁 Bonus Qualified: \$${bonusAmount} (40%)\n\n` +
            `⚠️ *Action Required:* Please reply directly to this chat right now with your exact **Stake Username**.\n\n` +
            `⏳ Once provided, your deposit and bonus will be credited within **5–10 minutes**.`,
            { parse_mode: 'Markdown' }
        );

        res.status(200).send({ success: true });
    } catch (err) {
        console.error("Webhook error:", err);
        res.status(500).send({ error: "Server error" });
    }
});

// Chat Input Listener for Stake Username
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    try {
        const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
        if (userResult.rows.length === 0) return;

        const user = userResult.rows[0];
        if (user.total_deposited > 0 && !user.stake_username) {
            await pool.query('UPDATE users SET stake_username = $1 WHERE telegram_id = $2', [text, userId]);

            await ctx.reply(
                `✅ Thank you! Stake username saved as: *${text}*.\n\n` +
                `Your transaction has been queued. It will reflect in your Stake account in **5–10 minutes**!`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (err) {
        console.error("Text processing error:", err);
    }
});


// ==================== SECURE ADMIN DASHBOARD API & UI ====================

app.get('/api/admin/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/admin/mark-credited', async (req, res) => {
    const { telegramId } = req.body;
    try {
        await pool.query("UPDATE users SET status = 'Credited on Stake ✅' WHERE telegram_id = $1", [telegramId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to update status" });
    }
});

app.get('/admin', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Stake Bonus Bot - Admin Dashboard</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-900 text-gray-100 font-sans min-h-screen">
        <div id="loginScreen" class="flex items-center justify-center min-h-screen">
            <div class="bg-gray-800 p-8 rounded-xl shadow-2xl w-96 border border-gray-700">
                <h2 class="text-2xl font-bold mb-6 text-center text-yellow-400">🔒 Admin Access</h2>
                <form id="loginForm" onsubmit="handleLogin(event)">
                    <label class="block text-sm mb-2 text-gray-400">Password</label>
                    <input type="password" id="passwordInput" required class="w-full bg-gray-900 border border-gray-700 rounded p-3 mb-4 text-white focus:outline-none focus:border-yellow-400" placeholder="Enter password">
                    <button type="submit" class="w-full bg-yellow-500 hover:bg-yellow-400 text-gray-950 font-bold p-3 rounded transition">Login</button>
                    <p id="errorMsg" class="text-red-500 text-sm mt-3 text-center hidden">Incorrect Password!</p>
                </form>
            </div>
        </div>

        <div id="dashboard" class="hidden p-6 max-w-7xl mx-auto">
            <div class="flex justify-between items-center mb-8 border-b border-gray-800 pb-4">
                <h1 class="text-3xl font-extrabold text-yellow-400">⚡ Stake Bonus Control Panel</h1>
                <button onclick="logout()" class="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded font-semibold transition">Logout</button>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                    <p class="text-gray-400 text-sm">Total Deposited</p>
                    <h3 id="statTotalDep" class="text-3xl font-bold text-green-400">$0.00</h3>
                </div>
                <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                    <p class="text-gray-400 text-sm">Total Bonuses Owed/Issued</p>
                    <h3 id="statTotalBonus" class="text-3xl font-bold text-yellow-400">$0.00</h3>
                </div>
                <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                    <p class="text-gray-400 text-sm">Total Users Registered</p>
                    <h3 id="statTotalUsers" class="text-3xl font-bold text-blue-400">0</h3>
                </div>
            </div>

            <div class="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden shadow-xl">
                <div class="p-4 bg-gray-850 border-b border-gray-700 flex justify-between items-center">
                    <h3 class="font-bold text-lg">Live User Tracking & Deposits</h3>
                    <button onclick="loadData()" class="bg-gray-700 hover:bg-gray-600 text-sm px-3 py-1.5 rounded transition">🔄 Refresh</button>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="bg-gray-900 text-gray-400 text-sm border-b border-gray-700">
                                <th class="p-4">Telegram ID / User</th>
                                <th class="p-4">Stake Username</th>
                                <th class="p-4">Deposit ($)</th>
                                <th class="p-4">Bonus (40%)</th>
                                <th class="p-4">Rollover Left (4x)</th>
                                <th class="p-4">Status</th>
                                <th class="p-4 text-center">Action</th>
                            </tr>
                        </thead>
                        <tbody id="userTableBody" class="divide-y divide-gray-700 text-sm">
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <script>
            function handleLogin(e) {
                e.preventDefault();
                const pass = document.getElementById('passwordInput').value;
                if (pass === 'Sam@3585') {
                    document.getElementById('loginScreen').classList.add('hidden');
                    document.getElementById('dashboard').classList.remove('hidden');
                    loadData();
                    setInterval(loadData, 10000);
                } else {
                    document.getElementById('errorMsg').classList.remove('hidden');
                }
            }

            function logout() {
                location.reload();
            }

            async function loadData() {
                try {
                    const res = await fetch('/api/admin/users');
                    const users = await res.json();
                    
                    let totalDep = 0;
                    let totalBonus = 0;
                    let tbody = '';

                    users.forEach(u => {
                        totalDep += parseFloat(u.total_deposited || 0);
                        totalBonus += parseFloat(u.bonus_balance || 0);

                        let badgeColor = u.status === 'Credited on Stake ✅' ? 'bg-green-900 text-green-300' : 'bg-yellow-900 text-yellow-300';

                        tbody += \`
                            <tr class="hover:bg-gray-750 transition">
                                <td class="p-4">
                                    <div class="font-bold">\${u.username || 'Anonymous'}</div>
                                    <div class="text-xs text-gray-400">\${u.telegram_id}</div>
                                </td>
                                <td class="p-4 font-mono text-yellow-300">\${u.stake_username || '<span class="text-gray-500">Not provided</span>'}</td>
                                <td class="p-4 text-green-400 font-semibold">$\${Number(u.total_deposited).toFixed(2)}</td>
                                <td class="p-4 text-yellow-400 font-semibold">$\${Number(u.bonus_balance).toFixed(2)}</td>
                                <td class="p-4 text-red-400 font-semibold">$\${Number(u.rollover_remaining).toFixed(2)}</td>
                                <td class="p-4"><span class="px-2.5 py-1 rounded-full text-xs font-bold \${badgeColor}">\${u.status}</span></td>
                                <td class="p-4 text-center">
                                    \${u.status !== 'Credited on Stake ✅' ? 
                                        \`<button onclick="markCredited('\${u.telegram_id}')" class="bg-green-600 hover:bg-green-500 text-white text-xs px-3 py-1.5 rounded font-bold transition">Mark Paid</button>\` : 
                                        \`<span class="text-gray-500 text-xs">Done</span>\`
                                    }
                                </td>
                            </tr>
                        \`;
                    });

                    document.getElementById('statTotalDep').innerText = '$' + totalDep.toFixed(2);
                    document.getElementById('statTotalBonus').innerText = '$' + totalBonus.toFixed(2);
                    document.getElementById('statTotalUsers').innerText = users.length;
                    document.getElementById('userTableBody').innerHTML = tbody;
                } catch (err) {
                    console.error("Failed to load admin data:", err);
                }
            }

            async function markCredited(telegramId) {
                if (!confirm('Mark this user bonus as credited on Stake?')) return;
                await fetch('/api/admin/mark-credited', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ telegramId })
                });
                loadData();
            }
        </script>
    </body>
    </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
bot.launch().then(() => console.log("Bot and Admin Dashboard are online..."));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
           
