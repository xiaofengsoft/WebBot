document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // DOM Elements
    const sidebar = document.querySelector('.sidebar');
    const agentGrid = document.getElementById('agent-grid');
    const refreshBtn = document.getElementById('refresh-agents');
    const welcomeScreen = document.getElementById('welcome-screen');
    const chatWindowDiv = document.getElementById('chat-window');
    const messagesDiv = document.getElementById('messages');
    const backBtn = document.getElementById('back-to-agents');
    const agentNameEl = document.getElementById('agent-name');
    const agentAvatarEl = document.getElementById('agent-avatar');
    const form = document.getElementById('form');
    const input = document.getElementById('input');

    let selectedAgentName = '';
    let selectedAgentId = null;
    let messagesByAgent = {};
    let userId = null;
    let lastRenderedAgentId = null;
    let audioCtx = null;
    let canPlaySound = true;
    let externalContext = { createIp: '', vName: '', memberId: '' };

    const isMobile = () => window.innerWidth <= 768;

    function getExternalContextFromUrl() {
        try {
            const params = new URLSearchParams(window.location.search || '');
            return {
                // 兼容示例中的 LzUrl
                createIp: (params.get('CreateIp') || params.get('LzUrl') || '').trim(),
                vName: (params.get('VName') || '').trim(),
                memberId: (params.get('Id') || '').trim()
            };
        } catch (e) {
            return { createIp: '', vName: '', memberId: '' };
        }
    }

    externalContext = getExternalContextFromUrl();

    // --- 视图管理 ---
    function showChatView() {
        if (isMobile()) {
            sidebar.classList.add('hidden-mobile');
        }
        welcomeScreen.classList.add('hidden');
        chatWindowDiv.classList.remove('hidden');
    }

    function showSelectionView() {
        if (isMobile()) {
            sidebar.classList.remove('hidden-mobile');
            // 在移动端，返回时需要隐藏聊天窗口以显示客服列表
            chatWindowDiv.classList.add('hidden');
        } else {
            // 在PC端，返回时显示欢迎页，隐藏聊天窗口
            welcomeScreen.classList.remove('hidden');
            chatWindowDiv.classList.add('hidden');
        }
    }

    // --- 事件监听 ---
    socket.on('connect', () => {
        userId = getOrCreateUserId();
        socket.emit('register_user', userId);
        socket.emit('request_agents');
        restoreSession(); // 在连接建立后恢复会话
    });

    function getOrCreateUserId() {
        try {
            const existing = localStorage.getItem('user_id');
            if (existing) return existing;
        } catch (e) {}
        const uid = 'u_' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
        try { localStorage.setItem('user_id', uid); } catch (e) {}
        return uid;
    }

    socket.on('update_agents', (agents) => {
        renderAgentCards(agents);
        // 如果有已选客服，高亮显示
        if (selectedAgentId) {
            const selectedCard = document.querySelector(`.agent-card[data-id="${selectedAgentId}"]`);
            if (selectedCard) selectedCard.classList.add('selected');
        }
    });

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => socket.emit('request_agents'));
    }
    setInterval(() => {
        if (socket.connected) {
            socket.emit('request_agents');
        }
    }, 15000);

    socket.on('agent_selected', (agentName) => {
        selectedAgentName = agentName;
        showChatView();
        agentNameEl.textContent = selectedAgentName;
        const initial = (selectedAgentName || '?').trim().charAt(0).toUpperCase();
        agentAvatarEl.textContent = initial || 'K';
        saveSession();
        if (selectedAgentId && lastRenderedAgentId !== selectedAgentId) {
            renderMessagesForSelectedAgent();
        }
        const card = document.querySelector(`.agent-card[data-id="${selectedAgentId}"]`);
        if (card) {
            document.querySelectorAll('.agent-card.selected').forEach(el => el.classList.remove('selected'));
            card.classList.add('selected');
        }
    });

    if (backBtn) {
        backBtn.addEventListener('click', () => {
            showSelectionView();
        });
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!selectedAgentName) {
            console.error('请先选择客服');
            return;
        }
        if (input.value) {
            const message = input.value.trim();
            if (message) {
                socket.emit('web_message', {
                    message,
                    createIp: externalContext.createIp,
                    vName: externalContext.vName,
                    id: externalContext.memberId
                });
                appendMessage('我', message, 'user-message', { ts: Date.now(), persist: true });
                input.value = '';
            }
        }
    });

    socket.on('agent_message', (data) => {
        const aid = (data && data.agentId != null) ? String(data.agentId) : selectedAgentId;
        appendMessage(data.agentName, data.message, 'agent-message', { ts: data.ts, persist: true, agentId: aid });
        playNotify();
    });

    socket.on('error_message', (message) => {
        console.error(message);
    });

    // --- 辅助函数 ---
    function playNotify() {
        if (!canPlaySound || document.hidden) return;
        try {
            if (!audioCtx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                audioCtx = new AC();
            }
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
            const o = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            o.type = 'sine';
            o.frequency.setValueAtTime(880, audioCtx.currentTime);
            g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.1, audioCtx.currentTime + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.2);
            o.connect(g);
            g.connect(audioCtx.destination);
            o.start(audioCtx.currentTime);
            o.stop(audioCtx.currentTime + 0.2);
        } catch (e) {}
    }

    function renderAgentCards(agents) {
        agentGrid.innerHTML = '';
        if (!agents || agents.length === 0) {
            agentGrid.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">暂无客服在线</div>';
            return;
        }
        agents.forEach(agent => {
            const card = document.createElement('div');
            card.className = 'agent-card';
            card.setAttribute('data-id', agent.id);

            const initial = (agent.name || '?').trim().charAt(0).toUpperCase();
            card.innerHTML = `
                <div class="agent-badge">${initial}</div>
                <div class="agent-info">
                    <div class="agent-name">${agent.name}</div>
                    <div class="agent-sub">在线客服</div>
                </div>
            `;

            card.addEventListener('click', () => {
                document.querySelectorAll('.agent-card.selected').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
                selectedAgentId = card.getAttribute('data-id');
                selectedAgentName = agent.name;
                saveSession();
                socket.emit('select_agent', selectedAgentId);
                // 点击后立即切换视图并渲染消息
                showChatView();
                renderMessagesForSelectedAgent();
            });
            agentGrid.appendChild(card);
        });
        if (selectedAgentId) {
            const selectedCard = document.querySelector(`.agent-card[data-id="${selectedAgentId}"]`);
            if (selectedCard) selectedCard.classList.add('selected');
        }
    }

    function formatTime(ts) {
        try {
            const d = new Date(ts);
            const pad = (n) => (n < 10 ? '0' + n : '' + n);
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch (e) { return ''; }
    }

    function appendMessage(sender, text, messageClass, opts = { persist: true, ts: null, agentId: null }) {
        const belongAgentId = (opts && opts.agentId != null) ? String(opts.agentId) : selectedAgentId;
        
        if (opts && opts.persist) {
            const aid = belongAgentId;
            if (!aid) return;
            if (!messagesByAgent[aid]) messagesByAgent[aid] = [];
            messagesByAgent[aid].push({ sender, text, messageClass, ts: opts.ts || Date.now() });
            saveSession();
        }

        if (String(belongAgentId) === String(selectedAgentId)) {
            const messageElement = document.createElement('div');
            messageElement.className = `message ${messageClass}`;
            const time = formatTime(opts.ts || Date.now());
            // Sanitize text before inserting into innerHTML to prevent XSS
            const sanitizedText = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            messageElement.innerHTML = `
                <div class="sender">${sender}</div>
                <div class="text">${sanitizedText}</div>
                <div class="meta">${time}</div>
            `;
            messagesDiv.appendChild(messageElement);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
    }

    function renderMessagesForSelectedAgent() {
        messagesDiv.innerHTML = '';
        const list = (selectedAgentId && messagesByAgent[String(selectedAgentId)]) || [];
        list.forEach(m => appendMessage(m.sender, m.text, m.messageClass, { persist: false, ts: m.ts, agentId: selectedAgentId }));
        lastRenderedAgentId = selectedAgentId;
    }

    // --- 会话持久化 ---
    function getStateKey() {
        return `chat_state_${userId || getOrCreateUserId()}`;
    }

    function saveSession() {
        try {
            const state = { selectedAgentId, selectedAgentName, messagesByAgent };
            localStorage.setItem(getStateKey(), JSON.stringify(state));
        } catch (e) {}
    }

    function restoreSession() {
        try {
            const raw = localStorage.getItem(getStateKey());
            if (!raw) {
                showSelectionView(); // 没有会话，显示选择页
                return;
            }
            const state = JSON.parse(raw);
            if (!state) {
                showSelectionView();
                return;
            }
            selectedAgentId = state.selectedAgentId || null;
            selectedAgentName = state.selectedAgentName || '';
            messagesByAgent = state.messagesByAgent && typeof state.messagesByAgent === 'object' ? state.messagesByAgent : {};

            if (selectedAgentId && socket.connected) {
                showChatView();
                agentNameEl.textContent = selectedAgentName || '客服';
                const initial = (selectedAgentName || '?').trim().charAt(0).toUpperCase();
                agentAvatarEl.textContent = initial || 'K';
                renderMessagesForSelectedAgent();
                socket.emit('select_agent', selectedAgentId);
            } else {
                showSelectionView();
            }
        } catch (e) {
            console.error("Failed to restore session:", e);
            showSelectionView();
        }
    }

    // --- 初始化 ---
    // 初始视图由 restoreSession 控制
    userId = getOrCreateUserId(); // 确保 userId 在连接前已存在
});
