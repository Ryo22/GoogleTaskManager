let tokenClient;
let accessToken = null;
let gapiInited = false;
let gisInited = false;

// Settings (persist in localStorage)
let config = {
    clientId: localStorage.getItem('google_client_id') || '',
    geminiKey: localStorage.getItem('gemini_api_key') || '',
    criteria: localStorage.getItem('extraction_criteria') || "質問、依頼、期限付きの連絡、自分が対応すべきタスク。"
};

function gapiLoaded() { gapi.load('client', () => { gapiInited = true; checkBeforeLogin(); }); }
function initGis() { checkBeforeLogin(); gisInited = true; }

function checkBeforeLogin() {
    if (config.clientId) {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: config.clientId,
            scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/chat.messages.readonly',
            callback: (resp) => {
                if (resp.error) return;
                accessToken = resp.access_token;
                onLoginSuccess();
            },
        });
        document.getElementById('login-btn').style.display = 'block';
    } else {
        document.getElementById('setup-initial').style.display = 'block';
    }
}

document.getElementById('login-btn').addEventListener('click', () => {
    tokenClient.requestAccessToken({prompt: 'consent'});
});

function onLoginSuccess() {
    document.getElementById('login-view').style.opacity = '0';
    setTimeout(() => {
        document.getElementById('login-view').style.display = 'none';
        document.getElementById('app-view').style.display = 'grid';
        syncTasks();
    }, 300);
}

// Navigation
document.getElementById('nav-tasks').addEventListener('click', () => { showView('task-list'); setActiveNav('nav-tasks'); });
document.getElementById('nav-settings').addEventListener('click', () => {
    showView('settings-view');
    setActiveNav('nav-settings');
    document.getElementById('client-id-input').value = config.clientId;
    document.getElementById('gemini-key-input').value = config.geminiKey;
    document.getElementById('criteria-textarea').value = config.criteria;
});

document.getElementById('save-settings-btn').addEventListener('click', () => {
    config.clientId = document.getElementById('client-id-input').value;
    config.geminiKey = document.getElementById('gemini-key-input').value;
    config.criteria = document.getElementById('criteria-textarea').value;
    
    localStorage.setItem('google_client_id', config.clientId);
    localStorage.setItem('gemini_api_key', config.geminiKey);
    localStorage.setItem('extraction_criteria', config.criteria);
    
    alert("設定を保存しました。反映するにはページをリロードしてください。");
    location.reload();
});

document.getElementById('cancel-settings-btn').addEventListener('click', () => { showView('task-list'); setActiveNav('nav-tasks'); });

function showView(viewId) {
    document.getElementById('task-list').style.display = viewId === 'task-list' ? 'block' : 'none';
    document.getElementById('settings-view').style.display = viewId === 'settings-view' ? 'flex' : 'none';
}

function setActiveNav(navId) {
    ['nav-tasks', 'nav-settings'].forEach(id => {
        document.getElementById(id).style.background = id === navId ? 'rgba(255,255,255,0.05)' : 'transparent';
    });
}

// Sync Logic
document.getElementById('sync-btn').addEventListener('click', syncTasks);

async function syncTasks() {
    const btn = document.getElementById('sync-btn');
    btn.innerText = 'Syncing...';
    btn.disabled = true;

    try {
        const gmailData = await fetchGmailMessages();
        // Chat API calls from browser might need discovery docs/specific handling, mocking for now but Gmail works.
        const tasks = await analyzeWithGemini(gmailData);
        renderTasks(tasks);
        document.getElementById('sync-status').innerText = `Last synced: ${new Date().toLocaleTimeString()}`;
    } catch (e) {
        console.error(e);
        alert("同期に失敗しました。APIキーやClient IDを確認してください。");
    } finally {
        btn.innerText = '手動同期';
        btn.disabled = false;
    }
}

async function fetchGmailMessages() {
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=is:unread', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await response.json();
    if (!data.messages) return [];

    const messages = await Promise.all(data.messages.map(async (m) => {
        const detail = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const msg = await detail.json();
        return {
            id: msg.id,
            snippet: msg.snippet,
            subject: msg.payload.headers.find(h => h.name === 'Subject')?.value || 'No Subject'
        };
    }));
    return messages;
}

async function analyzeWithGemini(messages) {
    if (!config.geminiKey) return [{ id: 0, source: 'System', priority: 'mid', title: 'APIキー未設定', desc: 'Gemini API KeyをSettingsから設定してください。', time: 'Now' }];

    const prompt = `
    以下のメール内容を分析し、ユーザーがアクション（返信、確認、タスク実行など）を起こすべきものを抽出してください。
    抽出条件: ${config.criteria}
    
    出力フォーマット（JSON配列のみ）:
    [{"source": "Gmail", "priority": "high|mid|low", "title": "件名/サマリー", "desc": "必要なアクションの説明", "time": "受信時期"}]
    
    データ:
    ${JSON.stringify(messages)}
    `;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });
    const result = await response.json();
    const text = result.candidates[0].content.parts[0].text;
    // Extract JSON from text (sometimes Gemini adds ```json block)
    const jsonMatch = text.match(/\[.*\]/s);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
}

function renderTasks(tasks) {
    const taskList = document.getElementById('task-list');
    if (tasks.length === 0) {
        taskList.innerHTML = '<div style="text-align:center; padding: 2rem; color:var(--text-dim);">アクションが必要な項目は見つかりませんでした。</div>';
        return;
    }
    taskList.innerHTML = tasks.map((task, idx) => `
        <div class="task-card glass-panel priority-${task.priority}">
            <div class="task-header">
                <span class="task-source">${task.source} • ${task.time || ''}</span>
                <span style="font-size: 0.7rem; color: ${getPriorityColor(task.priority)};">Priority: ${task.priority.toUpperCase()}</span>
            </div>
            <div class="task-title">${task.title}</div>
            <p class="task-desc">${task.desc}</p>
        </div>
    `).join('');
}

function getPriorityColor(priority) {
    switch (priority) {
        case 'high': return 'var(--error)';
        case 'mid': return 'var(--primary-glow)';
        case 'low': return 'var(--success)';
        default: return 'var(--text-dim)';
    }
}
