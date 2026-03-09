const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// --- Configuration ---
// Read Telegram Bot Token from environment variable
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN environment variable is not set.');
    console.error('Please set TELEGRAM_BOT_TOKEN before starting the server.');
    process.exit(1);
}
// 保持 ADMIN_ID 为字符串类型，以避免大数字精度问题
const ADMIN_ID = process.env.ADMIN_ID;
const DEBUG = process.env.DEBUG == 'true';

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const bot = new TelegramBot(token, {
    polling: true,
    request: DEBUG ?  {
        proxy: 'http://127.0.0.1:7890'
    } : undefined
});

// In-memory storage for customer service agents and chats
let supportAgents = {}; // Stores { agentId: { name, chatId } }
// Map sessionId -> agentId (selected agent for the browser session)
let userChatsBySession = {}; // { sessionId: agentId }
// Map sessionId <-> socketId for current live connection
let sessionToSocket = {}; // { sessionId: socketId }
let socketToSession = {}; // { socketId: sessionId }
// --- New: userId based mapping (persistent across sessions/tabs if reused) ---
let userChatsByUser = {}; // { userId: agentId }
let userToSocket = {}; // { userId: socketId }
let socketToUser = {}; // { socketId: userId }
// Cache known Telegram users who have interacted with the bot: username(lowercased) -> chatId
let knownUsersByUsername = {}; 
// Offline queue: userId -> [ { agentName, message, ts } ]
let offlineQueuesByUser = {};
// In-memory chat history per user-agent pair: `${userId}::${agentId}` -> [ { from: 'user'|'agent', name, text, ts } ]
let historiesByUA = {};

function getHistoryKey(userId, agentId) {
    if (!userId || !agentId) return null;
    return `${userId}::${agentId}`;
}

function pushHistory(userId, agentId, entry) {
    const key = getHistoryKey(userId, agentId);
    if (!key) return;
    if (!historiesByUA[key]) historiesByUA[key] = [];
    historiesByUA[key].push(entry);
    // Trim to last 50 entries to bound memory
    if (historiesByUA[key].length > 50) {
        historiesByUA[key] = historiesByUA[key].slice(-50);
    }
}

function formatTs(ts) {
    const d = new Date(ts || Date.now());
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    return `${y}-${m}-${dd} ${hh}:${mm}`;
}

function buildHistorySnippet(userId, agentId, includeCount = 5, truncateEach = 200) {
    const key = getHistoryKey(userId, agentId);
    const items = key ? (historiesByUA[key] || []) : [];
    const recent = items.slice(-includeCount);
    if (recent.length === 0) return '';
    const lines = recent.map(it => {
        const who = it.from === 'agent' ? (it.name || '客服') : '用户';
        let text = String(it.text || '');
        if (truncateEach && text.length > truncateEach) {
            text = text.slice(0, truncateEach) + '…';
        }
        return `【${formatTs(it.ts)}】${who}：${text}`;
    });
    return lines.join('\n');
}

function enqueueOffline(userId, payload) {
    if (!userId) return;
    if (!offlineQueuesByUser[userId]) offlineQueuesByUser[userId] = [];
    const ts = Date.now();
    offlineQueuesByUser[userId].push({ ...payload, ts });
    // Record into history as agent message
    if (payload.agentId) {
        pushHistory(userId, payload.agentId, { from: 'agent', name: payload.agentName, text: payload.message, ts });
    }
}

function flushOffline(userId) {
    const socketId = userToSocket[userId];
    const targetSocket = socketId && (io.of('/').sockets.get(socketId) || io.sockets.sockets.get(socketId));
    if (!targetSocket) return;
    const queue = offlineQueuesByUser[userId];
    if (!queue || queue.length === 0) return;
    queue.forEach(item => {
        targetSocket.emit('agent_message', { agentId: item.agentId, agentName: item.agentName, message: item.message, ts: item.ts });
    });
    offlineQueuesByUser[userId] = [];
}

app.use(express.static('public'));

// --- Socket.IO Logic ---
io.on('connection', (socket) => {
    console.log('New web client connected:', socket.id);

    // Send the list of available agents to the new client
    socket.emit('update_agents', Object.values(supportAgents).map(agent => ({ id: agent.chatId, name: agent.name })));

    // Allow client to request the latest agent list on demand
    socket.on('request_agents', () => {
        socket.emit('update_agents', Object.values(supportAgents).map(agent => ({ id: agent.chatId, name: agent.name })));
    });

    // Web client registers a persistent userId (UUID/phone/email/dbid)
    socket.on('register_user', (userId) => {
        if (!userId || typeof userId !== 'string') return;
        socketToUser[socket.id] = userId;
        userToSocket[userId] = socket.id;
        const agentId = userChatsByUser[userId];
        if (agentId && supportAgents[agentId]) {
            socket.emit('agent_selected', supportAgents[agentId].name);
        }
        console.log(`User registered: user:${userId} -> socket ${socket.id}`);
        // Flush any offline messages queued for this user
        flushOffline(userId);
    });

    // Web client registers a stable sessionId
    socket.on('register_session', (sessionId) => {
        if (!sessionId || typeof sessionId !== 'string') return;
        socketToSession[socket.id] = sessionId;
        sessionToSocket[sessionId] = socket.id;
        // If this session had an agent selected previously, restore client state
        const agentId = userChatsBySession[sessionId];
        if (agentId && supportAgents[agentId]) {
            socket.emit('agent_selected', supportAgents[agentId].name);
        }
        console.log(`Session registered: session_${sessionId} -> socket ${socket.id}`);
    });

    socket.on('select_agent', (agentId) => {
        const sessionId = socketToSession[socket.id];
        const userId = socketToUser[socket.id];
        if (supportAgents[agentId]) {
            if (sessionId) userChatsBySession[sessionId] = agentId;
            if (userId) userChatsByUser[userId] = agentId;
            console.log(`Selection bound. session=${sessionId || '-'} user=${userId || '-'} -> agent ${supportAgents[agentId].name}`);
            socket.emit('agent_selected', supportAgents[agentId].name);
        } else {
            socket.emit('error_message', '所选客服不可用。');
        }
    });

    socket.on('web_message', (data) => {
        const sessionId = socketToSession[socket.id];
        const userId = socketToUser[socket.id];
        const agentId = userId ? userChatsByUser[userId] : userChatsBySession[sessionId];
        const agent = supportAgents[agentId];
        if (agent) {
            // Prefer user marker for stability across reconnects
            const marker = userId ? `user:${userId}` : `session_${sessionId}`;
            const ts = Date.now();
            if (userId && agentId) {
                pushHistory(userId, agentId, { from: 'user', name: '用户', text: data.message, ts });
            }
            const historyBlock = (userId && agentId) ? buildHistorySnippet(userId, agentId, 5, 200) : '';
            let message = historyBlock
                ? `来自网页用户（${marker}）\n—— 最近会话（最多 5 条） ——\n${historyBlock}\n—— 回复本消息可直接发送给该用户 ——`
                : `来自网页用户（${marker}）\n—— 最近会话（最多 5 条） ——\n【${formatTs(ts)}】用户：${data.message}\n—— 回复本消息可直接发送给该用户 ——`;
            // IMPORTANT: Append ASCII marker for reply routing compatibility
            if (userId) {
                message += `\n(${`user:${userId}`})`;
            } else if (sessionId) {
                message += `\n(${`session_${sessionId}`})`;
            }
            bot.sendMessage(agent.chatId, message);
            console.log(`Forwarding message from marker=${marker} to agent ${agent.name}`);
        } else {
            socket.emit('error_message', '请先选择客服。');
        }
    });

    socket.on('disconnect', () => {
        console.log('Web client disconnected:', socket.id);
        const sessionId = socketToSession[socket.id];
        const userId = socketToUser[socket.id];
        if (sessionId) delete sessionToSocket[sessionId];
        if (userId) delete userToSocket[userId];
        delete socketToSession[socket.id];
        delete socketToUser[socket.id];
    });
});

// --- Telegram Bot Logic ---

// Command to add a new support agent:
// 1) Self-register: /addsupport <Name>
// 2) Register another user: /addsupport <Name> <tg_id|@username>
//    If @username is used, that user must have sent a message to this bot at least once.
bot.onText(/\/addsupport\s+(\S+)(?:\s+(\S+))?/, (msg, match) => {
    // 使用字符串比较
    if (!msg.from || String(msg.from.id) !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, '仅管理员可以执行此命令。');
        return;
    }
    const requesterChatId = msg.chat.id;
    const name = match[1];
    const target = match[2];

    let targetChatId = requesterChatId; // default self-register
    let username = undefined;

    if (target) {
        if (target.startsWith('@')) {
            username = target.slice(1).toLowerCase();
            const resolved = knownUsersByUsername[username];
            if (!resolved) {
                bot.sendMessage(requesterChatId, `无法解析 @${username}。请对方先与机器人开始对话后再尝试。`);
                return;
            }
            targetChatId = resolved;
        } else if (/^\d+$/.test(target)) {
            targetChatId = Number(target);
        } else {
            bot.sendMessage(requesterChatId, '无效的目标。请使用数字 Telegram ID 或 @用户名。');
            return;
        }
    }

    const existed = Boolean(supportAgents[targetChatId]);
    supportAgents[targetChatId] = { name, chatId: targetChatId, username };
    if (existed) {
        console.log(`Updated support agent: ${name} with Chat ID: ${targetChatId}`);
        bot.sendMessage(requesterChatId, `已更新客服：${name}（chatId: ${targetChatId}）。`);
    } else {
        console.log(`Added new support agent: ${name} with Chat ID: ${targetChatId}`);
        bot.sendMessage(requesterChatId, `已添加客服：${name}（chatId: ${targetChatId}）。`);
    }

    // Broadcast only agents with resolved chatId to web clients
    io.emit('update_agents', Object.values(supportAgents)
        .filter(agent => !!agent.chatId)
        .map(agent => ({ id: agent.chatId, name: agent.name }))
    );
});

// List all registered support agents
bot.onText(/\/listsupport$/, (msg) => {
    // 使用字符串比较
    if (!msg.from || String(msg.from.id) !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, '仅管理员可以执行此命令。');
        return;
    }
    const chatId = msg.chat.id;
    const agents = Object.values(supportAgents);
    if (agents.length === 0) {
        bot.sendMessage(chatId, '尚未注册任何客服。使用 /addsupport <名称> 进行注册。');
        return;
    }
    const lines = agents.map(a => `• ${a.name}（chatId: ${a.chatId}${a.username ? `, @${a.username}` : ''}）`).join('\n');
    bot.sendMessage(chatId, `当前客服列表：\n${lines}`);
});

// Remove support agent: /removesupport <tg_id|@username|me>
bot.onText(/\/removesupport(?:\s+(\S+))?$/, (msg, match) => {
    // 使用字符串比较
    if (!msg.from || String(msg.from.id) !== ADMIN_ID) {
        bot.sendMessage(msg.chat.id, '仅管理员可以执行此命令。');
        return;
    }
    const chatId = msg.chat.id;
    const arg = match[1];
    let targetChatId;

    if (!arg || arg.toLowerCase() === 'me') {
        targetChatId = chatId;
    } else if (arg.startsWith('@')) {
        const uname = arg.slice(1).toLowerCase();
        targetChatId = knownUsersByUsername[uname];
    } else if (/^\d+$/.test(arg)) {
        targetChatId = Number(arg);
    }

    if (!targetChatId || !supportAgents[targetChatId]) {
        bot.sendMessage(chatId, '未在客服列表中找到目标。');
        return;
    }

    const removed = supportAgents[targetChatId];
    delete supportAgents[targetChatId];
    bot.sendMessage(chatId, `已移除客服：${removed.name}（chatId: ${targetChatId}）。`);
    io.emit('update_agents', Object.values(supportAgents).map(agent => ({ id: agent.chatId, name: agent.name })));
});

// Help command
bot.onText(/\/help$/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = [
        '命令列表：',
        '/addsupport <名称> — 将自己注册为客服，显示名称为 <名称>。',
        '/addsupport <名称> <tg_id|@用户名> — 将他人注册为客服（对方需先与机器人对话）。',
        '/listsupport — 查看所有客服。',
        '/removesupport <tg_id|@用户名|me> — 移除客服。',
        '/whoami — 查看你的 chatId、用户名和姓名（并缓存你的用户名）。'
    ].join('\n');
    bot.sendMessage(chatId, helpText);
});

// Who am I: return chatId, username and display name
bot.onText(/\/whoami$/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from && msg.from.username ? `@${msg.from.username}` : '(无)';
    const displayName = [msg.from && msg.from.first_name, msg.from && msg.from.last_name]
        .filter(Boolean)
        .join(' ') || '(无)';
    // Update username cache
    if (msg.from && msg.from.username) {
        knownUsersByUsername[String(msg.from.username).toLowerCase()] = chatId;
    }
    const text = [
        '你的 Telegram 身份：',
        `chatId：${chatId}`,
        `用户名：${username}`,
        `姓名：${displayName}`,
    ].join('\n');
    bot.sendMessage(chatId, text);
});

// Listen for replies from agents
bot.on('message', (msg) => {
    // Ignore commands
    if (typeof msg.text === 'string' && msg.text.startsWith('/')) {
        return;
    }

    // Check if the message is from a registered agent
    const agent = supportAgents[msg.chat.id];
    if (agent && msg.reply_to_message) {
        // Extract the original user's socket ID from the message
        const originalMessage = msg.reply_to_message.text || '';
        // Prefer user marker
        let matchUser = originalMessage.match(/\(user:([^\)]+)\)/);
        if (matchUser && matchUser[1]) {
            const userId = matchUser[1];
            const socketId = userToSocket[userId];
            const targetSocket = socketId && (io.of('/').sockets.get(socketId) || io.sockets.sockets.get(socketId));
            if (targetSocket) {
                const ts = msg && msg.date ? msg.date * 1000 : Date.now();
                targetSocket.emit('agent_message', { agentId: agent.chatId, agentName: agent.name, message: msg.text, ts });
                // Record into history (live agent -> user)
                pushHistory(userId, agent.chatId, { from: 'agent', name: agent.name, text: msg.text, ts });
                console.log(`Forwarding reply from agent ${agent.name} to user ${userId}`);
                bot.sendMessage(msg.chat.id, '已投递给用户。');
            } else {
                // Queue offline message and notify agent
                enqueueOffline(userId, { agentId: agent.chatId, agentName: agent.name, message: msg.text });
                bot.sendMessage(msg.chat.id, `用户当前不在线，消息已入队，将在其上线后自动发送（user:${userId}）。`);
            }
            return;
        }
        // Fallback to session marker
        let match = originalMessage.match(/\(session_([\w-]+)\)/);
        const isSession = Boolean(match && match[1]);
        if (!isSession) {
            // Backward compatibility: old socket_ marker
            match = originalMessage.match(/\(socket_([\w-]+)\)/);
        }
        
        if (match && match[1]) {
            if (isSession) {
                const sessionId = match[1];
                const socketId = sessionToSocket[sessionId];
                const targetSocket = socketId && (io.of('/').sockets.get(socketId) || io.sockets.sockets.get(socketId));
                if (targetSocket) {
                    const ts = msg && msg.date ? msg.date * 1000 : Date.now();
                    targetSocket.emit('agent_message', { 
                        agentId: agent.chatId,
                        agentName: agent.name,
                        message: msg.text,
                        ts
                    });
                    console.log(`Forwarding reply from agent ${agent.name} to session ${sessionId}`);
                    bot.sendMessage(msg.chat.id, '已投递给用户。');
                } else {
                    bot.sendMessage(msg.chat.id, `用户当前不在线或暂时离开（session_${sessionId}）。`);
                }
            } else {
                // Old path using socket id
                const socketId = match[1];
                const targetSocket = io.of('/').sockets.get(socketId) || io.sockets.sockets.get(socketId);
                if (targetSocket) {
                    const ts = msg && msg.date ? msg.date * 1000 : Date.now();
                    targetSocket.emit('agent_message', { 
                        agentId: agent.chatId,
                        agentName: agent.name,
                        message: msg.text,
                        ts
                    });
                    console.log(`Forwarding reply from agent ${agent.name} to socket ${socketId}`);
                    bot.sendMessage(msg.chat.id, '已投递给用户。');
                } else {
                    bot.sendMessage(msg.chat.id, `用户已离线或不再连接。`);
                }
            }
        } 
    } else if (agent && typeof msg.text === 'string') {
        // Fallback: allow agent to send messages that begin with markers
        // Preferred: user:<id>: 内容
        let mUser = msg.text.match(/^\s*user:([^\s:]+)\s*[:：]\s*([\s\S]*)$/);
        if (mUser) {
            const userId = mUser[1];
            const body = mUser[2] || '';
            const socketId = userToSocket[userId];
            const targetSocket = socketId && (io.of('/').sockets.get(socketId) || io.sockets.sockets.get(socketId));
            if (targetSocket) {
                const ts = Date.now();
                targetSocket.emit('agent_message', { agentId: agent.chatId, agentName: agent.name, message: body, ts });
                // Record into history (manual user:<id> path)
                pushHistory(userId, agent.chatId, { from: 'agent', name: agent.name, text: body, ts });
                console.log(`Forwarding manual-tag message from agent ${agent.name} to user ${userId}`);
                bot.sendMessage(msg.chat.id, '已投递给用户。');
            } else {
                // Queue offline manual message
                enqueueOffline(userId, { agentId: agent.chatId, agentName: agent.name, message: body });
                bot.sendMessage(msg.chat.id, `用户当前不在线，消息已入队，将在其上线后自动发送（user:${userId}）。`);
            }
            return;
        }
        // Example: session_ABC123: Hello user (preferred fallback), or legacy socket_ABC123
        let m2 = msg.text.match(/^\s*session_([\w-]+)\s*[:：]\s*([\s\S]*)$/);
        if (m2) {
            const sessionId = m2[1];
            const body = m2[2] || '';
            const socketId = sessionToSocket[sessionId];
            const targetSocket = socketId && (io.of('/').sockets.get(socketId) || io.sockets.sockets.get(socketId));
            if (targetSocket) {
                const ts = Date.now();
                targetSocket.emit('agent_message', {
                    agentId: agent.chatId,
                    agentName: agent.name,
                    message: body,
                    ts
                });
                console.log(`Forwarding manual-tag message from agent ${agent.name} to session ${sessionId}`);
                bot.sendMessage(msg.chat.id, '已投递给用户。');
            } else {
                // No stable userId available via session marker; cannot queue reliably
                bot.sendMessage(msg.chat.id, `用户当前不在线或暂时离开（session_${sessionId}）。`);
            }
        } else {
            // Legacy manual format
            m2 = msg.text.match(/^\s*socket_([\w-]+)\s*[:：]\s*([\s\S]*)$/);
            if (m2) {
                const socketId = m2[1];
                const body = m2[2] || '';
                const targetSocket = io.of('/').sockets.get(socketId) || io.sockets.sockets.get(socketId);
                if (targetSocket) {
                    const ts = Date.now();
                    targetSocket.emit('agent_message', {
                        agentId: agent.chatId,
                        agentName: agent.name,
                        message: body,
                        ts
                    });
                    console.log(`Forwarding manual-tag message from agent ${agent.name} to socket ${socketId}`);
                    bot.sendMessage(msg.chat.id, '已投递给用户。');
                } else {
                    bot.sendMessage(msg.chat.id, `用户已离线或不再连接。`);
                }
            } else {
            // Diagnostic hint if agent forgot to reply
            console.log(`Agent ${agent.name} sent a non-reply message without socket_ tag; not routed.`);
            bot.sendMessage(msg.chat.id, '未投递。请直接回复用户的消息，或在消息前加上 “session_<id>: 你的内容”。');
            }
        }
    }
    // Record known usernames for future @username resolution
    if (msg.from && msg.from.username) {
        knownUsersByUsername[String(msg.from.username).toLowerCase()] = msg.chat.id;
    }
});


server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});

console.log('Telegram bot is running...');
