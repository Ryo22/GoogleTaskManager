let tokenClient;
let accessToken = null;
let gapiInited = false;
let gisInited = false;

// Settings (persist in localStorage)
const config = {
    clientId: localStorage.getItem('google_client_id') || '710668584134-j2bdh6dptd1d46uojgqofubfn70out0g.apps.googleusercontent.com',
    geminiKey: localStorage.getItem('gemini_api_key') || '',
    geminiModel: localStorage.getItem('gemini_model') || 'gemini-3.1-flash-lite-preview',
    criteria: localStorage.getItem('extraction_criteria') || "直近10日以内の ishigami@isl.gr.jp / tlp@isl.gr.jp / slp@isl.gr.jp 宛メールから、質問、依頼、内容確認、および総合的に見て対応が必要、または少しでも対応が必要と思わせるタスクを抽出してください。",
    doneTasks: JSON.parse(localStorage.getItem('done_tasks') || '[]'),
    archivedTasks: JSON.parse(localStorage.getItem('archived_tasks') || '[]')
};

let autoSyncInterval = null;
let lastFetchedTasks = []; // Cache for current tasks

window.gisLoaded = function() {
    console.log("Google Identity Services (GIS) loaded");
    gisInited = true;
    checkBeforeLogin();
};

function initGis() {
    // Legacy support
}

function checkBeforeLogin() {
    console.log("Checking before login status...", { inited: gisInited, hasClientId: !!config.clientId });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkBeforeLogin);
        return;
    }

    if (config.clientId && gisInited) {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: config.clientId,
            scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar',
            callback: (resp) => {
                if (resp.error) {
                    console.error("Token error:", resp);
                    alert("Auth failed: " + resp.error);
                    return;
                }
                accessToken = resp.access_token;
                onLoginSuccess();
            },
        });
        console.log("Token client initialized");
    } else if (!config.clientId) {
        console.warn("No Client ID found. Please set it in Settings.");
        const loginBtn = document.getElementById('login-btn');
        if (loginBtn) {
            loginBtn.innerText = "Please set Client ID in Settings first";
            loginBtn.disabled = true;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const navTasks    = document.getElementById('nav-tasks');
    const navArchive  = document.getElementById('nav-archive');
    const navSettings = document.getElementById('nav-settings');
    const saveBtn     = document.getElementById('save-settings-btn');
    const cancelBtn   = document.getElementById('cancel-settings-btn');
    const syncBtn     = document.getElementById('sync-btn');
    const loginBtn    = document.getElementById('login-btn');

    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            if (tokenClient) tokenClient.requestAccessToken({ prompt: 'consent' });
            else alert("Google Auth Client is still initializing...");
        });
    }

    if (navTasks) navTasks.addEventListener('click', () => {
        showView('feed-view');
        setActiveNav('nav-tasks');
    });

    if (navArchive) navArchive.addEventListener('click', () => {
        showView('archive-view');
        setActiveNav('nav-archive');
        renderArchive();
    });

    if (navSettings) navSettings.addEventListener('click', () => {
        openModal('settings-modal');

        const ci = document.getElementById('client-id-input');
        const gk = document.getElementById('gemini-key-input');
        const ct = document.getElementById('criteria-textarea');
        if (ci) ci.value = config.clientId || '';
        if (gk) gk.value = config.geminiKey || '';
        if (ct) ct.value = config.criteria || '';

        setActiveNav('nav-settings');
    });

    if (cancelBtn) cancelBtn.addEventListener('click', () => closeModal('settings-modal'));

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            config.clientId   = document.getElementById('client-id-input').value;
            config.geminiKey  = document.getElementById('gemini-key-input').value;
            const m           = document.getElementById('gemini-model-select').value;
            config.geminiModel = m === 'custom' ? document.getElementById('gemini-custom-model').value : m;
            config.criteria   = document.getElementById('criteria-textarea').value;

            localStorage.setItem('google_client_id',      config.clientId);
            localStorage.setItem('gemini_api_key',        config.geminiKey);
            localStorage.setItem('gemini_model',          config.geminiModel);
            localStorage.setItem('extraction_criteria',   config.criteria);

            closeModal('settings-modal');
            syncTasks();
        });
    }

    if (syncBtn) {
        syncBtn.title = "手動同期 (10d)";
        syncBtn.addEventListener('click', syncTasks);
    }

    // Model loading
    const fetchModelsBtn  = document.getElementById('fetch-models-btn');
    const modelSelect     = document.getElementById('gemini-model-select');
    const customModelInput = document.getElementById('gemini-custom-model');

    if (fetchModelsBtn) {
        fetchModelsBtn.addEventListener('click', async () => {
            const apiKey = document.getElementById('gemini-key-input').value;
            if (!apiKey) { alert("Please enter a Gemini API Key first."); return; }
            fetchModelsBtn.innerText = "Loading...";
            try {
                const res  = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
                const data = await res.json();
                if (data.models) {
                    const chatModels = data.models
                        .filter(m => m.supportedGenerationMethods.includes('generateContent'))
                        .map(m => m.name.replace('models/', ''));
                    modelSelect.innerHTML = chatModels.map(name => `<option value="${name}">${name}</option>`).join('') +
                        '<option value="custom">-- Custom ID --</option>';
                    alert(`${chatModels.length} models loaded successfully!`);
                } else {
                    alert("Failed to load models. Check your API key.");
                }
            } catch (err) {
                console.error(err);
                alert("Error fetching models.");
            } finally {
                fetchModelsBtn.innerText = "利用可能なモデルをロード";
            }
        });
    }

    if (modelSelect) {
        modelSelect.addEventListener('change', (e) => {
            if (customModelInput) {
                customModelInput.classList.toggle('hidden', e.target.value !== 'custom');
            }
        });
    }

    const sendChatBtn = document.getElementById('send-chat-btn');
    if (sendChatBtn) sendChatBtn.addEventListener('click', handleChat);
});

// ===== Modal helpers =====
function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
}

// ===== View / Nav =====
function onLoginSuccess() {
    const loginView = document.getElementById('login-view');
    const appView   = document.getElementById('app-view');
    if (loginView) loginView.style.opacity = '0';
    setTimeout(() => {
        if (loginView) loginView.classList.add('hidden');
        if (appView)   appView.classList.remove('hidden');
        syncTasks();
        if (autoSyncInterval) clearInterval(autoSyncInterval);
        autoSyncInterval = setInterval(syncTasks, 5 * 60 * 1000);
    }, 300);
}

function showView(viewId) {
    ['feed-view', 'archive-view'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', id !== viewId);
    });
}

function setActiveNav(navId) {
    ['nav-tasks', 'nav-archive', 'nav-settings'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', id === navId);
    });
}

// ===== Sync =====
async function updateModelDropdown(providedKey) {
    const select   = document.getElementById('gemini-model-select');
    const keyToUse = providedKey || config.geminiKey;
    if (!select || !keyToUse) return;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keyToUse}`);
        const data     = await response.json();

        if (data.error) { alert("API Error: " + data.error.message); return; }

        if (data.models) {
            const currentSelected = config.geminiModel;
            const options = data.models.map(m => {
                const id = m.name.split('/').pop();
                return `<option value="${id}" ${id === currentSelected ? 'selected' : ''}>${m.displayName} (${id})</option>`;
            });
            select.innerHTML = `
                ${options.join('')}
                <option value="custom">-- カスタムIDを手動入力 --</option>
            `;
            alert(`利用可能モデル ${data.models.length} 件 をロードしました。リストになければカスタムIDを使ってください。`);
        }
    } catch (e) {
        console.error("Failed to fetch models", e);
        alert("取得失敗。APIキーまたはネットワークを確認してください。");
    }
}

async function syncTasks() {
    if (!accessToken) return;
    const btn = document.getElementById('sync-btn');
    if (btn) { btn.classList.add('spinning'); btn.disabled = true; }

    try {
        const gmailMsgs = await fetchGmailMessages();
        const tasks     = await analyzeWithGemini(gmailMsgs);

        lastFetchedTasks = tasks;
        renderFilteredTasks();

        const statusEl = document.getElementById('sync-status');
        if (statusEl) statusEl.innerText = `Auto-Sync: OK (${new Date().toLocaleTimeString()})`;
    } catch (err) {
        console.error("Sync failed:", err);
        const statusEl = document.getElementById('sync-status');
        if (statusEl) statusEl.innerText = "Sync Error";
    } finally {
        const syncBtn = document.getElementById('sync-btn');
        if (syncBtn) { syncBtn.classList.remove('spinning'); syncBtn.disabled = false; }
    }
}

async function fetchGmailMessages() {
    const query = `(to:ishigami@isl.gr.jp OR to:tlp@isl.gr.jp OR to:slp@isl.gr.jp) -from:tlp@isl.gr.jp -from:slp@isl.gr.jp newer_than:10d`;

    try {
        console.log("Fetching Gmail with 10d focus...");
        const response = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=200&q=${encodeURIComponent(query)}`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        const data = await response.json();
        if (!data.messages) return [];

        const messages   = [];
        const messageIds = data.messages.slice(0, 150);

        for (let i = 0; i < messageIds.length; i += 5) {
            const chunk = messageIds.slice(i, i + 5);
            const chunkResults = await Promise.all(chunk.map(async (m) => {
                try {
                    const detailRes = await fetch(
                        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`,
                        { headers: { 'Authorization': `Bearer ${accessToken}` } }
                    );
                    if (!detailRes.ok) return null;
                    const msg = await detailRes.json();
                    if (!msg.payload) return null;

                    const headers = msg.payload.headers;
                    return {
                        source:  'Gmail',
                        id:      msg.id,
                        snippet: msg.snippet,
                        from:    headers.find(h => h.name === 'From')?.value || 'Unknown',
                        subject: headers.find(h => h.name === 'Subject')?.value || 'No Subject',
                        url:     `https://mail.google.com/mail/u/0/#inbox/${msg.threadId || msg.id}`
                    };
                } catch (err) {
                    console.warn(`Failed to fetch detail for ${m.id}`, err);
                    return null;
                }
            }));
            messages.push(...chunkResults.filter(r => r !== null));
            await new Promise(r => setTimeout(r, 100));
        }

        return messages;
    } catch (err) {
        console.error("Gmail fetch error:", err);
        throw err;
    }
}

async function analyzeWithGemini(messages) {
    if (messages.length === 0) return [];
    if (!config.geminiKey) return [{
        source: 'System', priority: 'mid', title: 'API Key Missing', desc: 'Settingsから設定してください。'
    }];

    const modelName = config.geminiModel || 'gemini-1.5-flash';
    const apiUrl    = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${config.geminiKey}`;

    const prompt = `
    以下のメールリストを分析し、「対応が必要なタスク」を漏れなく抽出してください。

    ■ 抽出基準（優先順位）：
    1. 質問、依頼、内容確認などの依頼
    2. 総合的に見て対応が必要と思われる、または少しでも対応が必要そうなタスク（迷う場合は抽出に含める）
    3. 返信や確認を放置すると問題になりそうな連絡

    ■ ユーザー独自の抽出要件:
    ${config.criteria}

    ■ 出力形式 (JSON 配列のみ、他のテキストは一切含めないこと):
    [{"source": "Gmail", "priority": "high|mid|low", "title": "アクションの要約（動詞から始める）", "desc": "具体的な対応内容", "deadline": "今日中／明日中／今週中／〇月〇日まで／期限不明 のいずれか", "time": "From/Date", "refId": "id"}]

    ■ データ (JSON):
    ${JSON.stringify(messages.slice(0, 150))}
    `;

    try {
        const res = await fetch(apiUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const raw = await res.json();

        if (raw.error) {
            return [{ source: 'Error', priority: 'high', title: 'Gemini API Error', desc: raw.error.message }];
        }

        if (!raw.candidates || raw.candidates.length === 0) {
            return [{ source: 'Error', priority: 'high', title: 'AI Analysis Blocked', desc: 'AIが内容の分析を拒否しました。内容が長すぎるか、安全フィルターに制限された可能性があります。' }];
        }

        const text      = raw.candidates[0].content.parts[0].text;
        const jsonMatch = text.match(/\[.*\]/s);
        const results   = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

        return results.map(r => {
            const original = messages.find(m => m.id === r.refId);
            return { ...r, url: original ? original.url : '#' };
        });
    } catch (e) {
        console.error("Gemini Error:", e);
        return [{ source: 'Error', priority: 'high', title: 'Gemini Technical Failure', desc: e.message }];
    }
}

// ===== Render =====
function deadlineClass(deadline) {
    if (!deadline) return '';
    const d = deadline.replace(/\s/g, '');
    if (d === '今日中') return 'deadline--today';
    if (d === '明日中') return 'deadline--tomorrow';
    return 'deadline--other';
}

function renderSummary(tasks) {
    const el = document.getElementById('task-summary');
    if (!el || tasks.length === 0) { if (el) el.innerHTML = ''; return; }

    const high   = tasks.filter(t => t.priority === 'high').length;
    const today  = tasks.filter(t => (t.deadline || '').replace(/\s/g, '') === '今日中');
    const urgent = today.map(t => `<span class="summary-tag">${t.title}</span>`).join('');

    el.innerHTML = `
        <div class="summary-bar">
            <span class="summary-count">対応タスク <b>${tasks.length}</b> 件</span>
            ${high > 0 ? `<span class="summary-high">高優先度 ${high} 件</span>` : ''}
            ${today.length > 0 ? `<span class="summary-today">今日中: ${urgent}</span>` : ''}
        </div>
    `;
}

function renderTasks(tasks, isArchive = false) {
    const listId = isArchive ? 'archive-list' : 'task-list';
    const list   = document.getElementById(listId);
    if (!list) return;

    if (!isArchive) renderSummary(tasks);

    if (tasks.length === 0) {
        list.innerHTML = `<div class="task-empty">${isArchive ? 'No archived tasks.' : 'No action items found. All clear!'}</div>`;
        return;
    }

    list.innerHTML = tasks.map(task => `
        <div id="${isArchive ? 'arch-' : 'task-'}${task.refId}" class="task-row unread priority-${task.priority || 'mid'}">
            <div class="sender" onclick="window.open('${task.url}', '_blank')">${task.time || 'Unknown'}</div>
            <div class="title-snippet" onclick="window.open('${task.url}', '_blank')">
                <div class="task-title">${task.title}</div>
                <div class="task-desc">${task.desc}</div>
            </div>
            ${task.deadline ? `<div class="deadline-badge ${deadlineClass(task.deadline)}">${task.deadline}</div>` : '<div class="date"></div>'}
            <div class="actions">
                ${!isArchive
                    ? `<button onclick="addToCalendar('${task.refId}')" class="action-icon cal-btn" title="Googleカレンダーで確認・登録">📅</button>`
                    : ''
                }
                ${isArchive
                    ? `<button onclick="restoreTask('${task.refId}')" class="action-icon" title="Restore">⟲</button>`
                    : `<button onclick="dismissTask('${task.refId}')" class="action-icon" title="Done">✓</button>`
                }
            </div>
        </div>
    `).join('');
}

function renderFilteredTasks() {
    const filtered = lastFetchedTasks.filter(t => !config.doneTasks.includes(t.refId));
    renderTasks(filtered);
}

function renderArchive() {
    renderTasks(config.archivedTasks, true);
}

window.dismissTask = function(id) {
    if (!config.doneTasks.includes(id)) {
        config.doneTasks.push(id);
        localStorage.setItem('done_tasks', JSON.stringify(config.doneTasks));

        const task = lastFetchedTasks.find(t => t.refId === id);
        if (task) {
            config.archivedTasks.unshift(task);
            localStorage.setItem('archived_tasks', JSON.stringify(config.archivedTasks.slice(0, 50)));
        }

        const el = document.getElementById(`task-${id}`);
        if (el) {
            el.classList.add('task-dismissing');
            setTimeout(renderFilteredTasks, 300);
        } else {
            renderFilteredTasks();
        }
    }
};

// ===== Calendar =====
function deadlineToDate(deadline) {
    const today = new Date();
    const d = (deadline || '').replace(/\s/g, '');
    if (d === '今日中') { return new Date(today); }
    if (d === '明日中') { const t = new Date(today); t.setDate(t.getDate() + 1); return t; }
    if (d === '今週中') {
        const t = new Date(today);
        const daysUntilFriday = ((5 - t.getDay()) + 7) % 7 || 7;
        t.setDate(t.getDate() + daysUntilFriday);
        return t;
    }
    const match = d.match(/(\d+)月(\d+)日/);
    if (match) {
        const t = new Date(today.getFullYear(), parseInt(match[1]) - 1, parseInt(match[2]));
        if (t < today) t.setFullYear(today.getFullYear() + 1);
        return t;
    }
    return null;
}

window.addToCalendar = function(id) {
    const task = lastFetchedTasks.find(t => t.refId === id);
    if (!task) return;

    // YYYYMMDD 形式に変換
    const fmt = d => d.toISOString().split('T')[0].replace(/-/g, '');

    let eventDate = deadlineToDate(task.deadline);
    // 期限不明 or 解析失敗の場合は今日をデフォルトにしてカレンダーを開く
    if (!eventDate) eventDate = new Date();

    const endDate = new Date(eventDate);
    endDate.setDate(endDate.getDate() + 1);

    const details = [
        task.desc,
        task.time ? `差出人: ${task.time}` : '',
        task.url  ? `メール: ${task.url}` : ''
    ].filter(Boolean).join('\n');

    const params = new URLSearchParams({
        action:  'TEMPLATE',
        text:    `[対応] ${task.title}`,
        dates:   `${fmt(eventDate)}/${fmt(endDate)}`,
        details: details
    });

    window.open(`https://calendar.google.com/calendar/r/eventedit?${params}`, '_blank');
};

window.restoreTask = function(id) {
    config.doneTasks    = config.doneTasks.filter(tid => tid !== id);
    config.archivedTasks = config.archivedTasks.filter(t => t.refId !== id);
    localStorage.setItem('done_tasks',      JSON.stringify(config.doneTasks));
    localStorage.setItem('archived_tasks',  JSON.stringify(config.archivedTasks));
    renderArchive();
    renderFilteredTasks();
};

// ===== Chat =====
async function handleChat() {
    const input = document.getElementById('chat-input');
    const query = input.value.trim();
    if (!query) return;

    appendChatMessage('user', query);
    input.value = '';

    const modelName = config.geminiModel === 'custom'
        ? document.getElementById('gemini-custom-model').value
        : config.geminiModel;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${config.geminiKey}`;

    const context = `
    You are an AI assistant analyzing the following tasks from the user's Gmail.
    Tasks: ${JSON.stringify(lastFetchedTasks.slice(0, 20))}
    Answer the user's question based on this context.
    Use Japanese.
    `;

    try {
        const res = await fetch(apiUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ contents: [{ parts: [{ text: `${context}\n\nUser: ${query}` }] }] })
        });
        const raw          = await res.json();
        const responseText = raw.candidates[0].content.parts[0].text;
        appendChatMessage('ai', responseText);
    } catch (e) {
        appendChatMessage('ai', "Error: " + e.message);
    }
}

function appendChatMessage(role, text) {
    const history = document.getElementById('chat-history');
    const msg     = document.createElement('div');
    msg.classList.add('chat-message', `chat-message--${role}`);
    msg.innerText = text;
    history.appendChild(msg);
    history.scrollTop = history.scrollHeight;
}
