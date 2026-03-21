let tokenClient;
let accessToken = null;
let gapiInited = false;
let gisInited = false;

// Settings (persist in localStorage)
const config = {
    clientId: localStorage.getItem('google_client_id') || '710668584134-j2bdh6dptd1d46uojgqofubfn70out0g.apps.googleusercontent.com',
    geminiKey: localStorage.getItem('gemini_api_key') || '',
    geminiModel: localStorage.getItem('gemini_model') || 'gemini-1.5-flash',
    criteria: localStorage.getItem('extraction_criteria') || "質問、依頼、内容確認の依頼、期限付きの連絡、自分が対応すべきタスク。ishigami|tlp|slp 宛のメールを重点的に。",
    doneTasks: JSON.parse(localStorage.getItem('done_tasks') || '[]'),
    archivedTasks: JSON.parse(localStorage.getItem('archived_tasks') || '[]')
};

let autoSyncInterval = null;
let lastFetchedTasks = []; // Cache for current tasks

// Global level init handlers
window.gapiLoaded = function() {
    gapi.load('client', () => {
        gapiInited = true;
        checkBeforeLogin();
    });
};

window.initGis = function() {
    gisInited = true;
    checkBeforeLogin();
};

function checkBeforeLogin() {
    // Only proceed if DOM is ready AND gapi/gis are inited
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkBeforeLogin);
        return;
    }

    if (config.clientId && gisInited) {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: config.clientId,
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
            callback: (resp) => {
                if (resp.error) {
                    console.error("Token error:", resp);
                    return;
                }
                accessToken = resp.access_token;
                onLoginSuccess();
            },
        });
        const loginBtn = document.getElementById('login-btn');
        if (loginBtn) loginBtn.style.display = 'block';
    } else if (!config.clientId) {
        const setupDiv = document.getElementById('setup-initial');
        if (setupDiv) setupDiv.style.display = 'block';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Nav & Settings listeners
    const navTasks = document.getElementById('nav-tasks');
    const navArchive = document.getElementById('nav-archive');
    const navSettings = document.getElementById('nav-settings');
    const saveBtn = document.getElementById('save-settings-btn');
    const cancelBtn = document.getElementById('cancel-settings-btn');
    const syncBtn = document.getElementById('sync-btn');
    const loginBtn = document.getElementById('login-btn');

    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            if (tokenClient) tokenClient.requestAccessToken({prompt: 'consent'});
            else alert("Google Auth Client is still initializing...");
        });
    }

    if (navTasks) navTasks.addEventListener('click', () => { showView('feed-view'); setActiveNav('nav-tasks'); });
    if (navArchive) navArchive.addEventListener('click', () => { showView('archive-view'); setActiveNav('nav-archive'); renderArchive(); });
    if (navSettings) navSettings.addEventListener('click', () => {
        showView('settings-modal');
        document.getElementById('client-id-input').value = config.clientId;
        document.getElementById('gemini-key-input').value = config.geminiKey;
        document.getElementById('criteria-textarea').value = config.criteria;
    });

    if (cancelBtn) cancelBtn.addEventListener('click', () => { document.getElementById('settings-modal').style.display = 'none'; });

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            config.clientId = document.getElementById('client-id-input').value;
            config.geminiKey = document.getElementById('gemini-key-input').value;
            let m = document.getElementById('gemini-model-select').value;
            config.geminiModel = m === 'custom' ? document.getElementById('gemini-custom-model').value : m;
            config.criteria = document.getElementById('criteria-textarea').value;
            
            localStorage.setItem('google_client_id', config.clientId);
            localStorage.setItem('gemini_api_key', config.geminiKey);
            localStorage.setItem('gemini_model', config.geminiModel);
            localStorage.setItem('extraction_criteria', config.criteria);
            
            document.getElementById('settings-modal').style.display = 'none';
            syncTasks();
        });
    }

    if (syncBtn) syncBtn.addEventListener('click', syncTasks);
    
    const sendChatBtn = document.getElementById('send-chat-btn');
    if (sendChatBtn) sendChatBtn.addEventListener('click', handleChat);
});

function onLoginSuccess() {
    const loginView = document.getElementById('login-view');
    const appView = document.getElementById('app-view');
    if (loginView) loginView.style.opacity = '0';
    setTimeout(() => {
        if (loginView) loginView.style.display = 'none';
        if (appView) appView.style.display = 'flex'; // Use flex for gmail container
        syncTasks();
        
        // Start auto-sync every 5 minutes
        if (autoSyncInterval) clearInterval(autoSyncInterval);
        autoSyncInterval = setInterval(syncTasks, 5 * 60 * 1000);
    }, 300);
}

function showView(viewId) {
    const taskList = document.getElementById('task-list');
    const settingsView = document.getElementById('settings-view');
    if (taskList) taskList.style.display = viewId === 'task-list' ? 'block' : 'none';
    if (settingsView) settingsView.style.display = viewId === 'settings-view' ? 'flex' : 'none';
}

function setActiveNav(navId) {
    ['nav-tasks', 'nav-settings'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.background = id === navId ? 'rgba(255,255,255,0.05)' : 'transparent';
    });
}

async function updateModelDropdown(providedKey) {
    const select = document.getElementById('gemini-model-select');
    const keyToUse = providedKey || config.geminiKey;
    if (!select || !keyToUse) return;

    try {
        // Use v1beta for listing as it often includes preview models
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keyToUse}`);
        const data = await response.json();
        
        if (data.error) {
            alert("API Error: " + data.error.message);
            return;
        }

        if (data.models) {
            console.log("Raw Models Data:", data.models);
            const currentSelected = config.geminiModel;
            const options = data.models.map(m => {
                const id = m.name.split('/').pop();
                return `<option value="${id}" ${id === currentSelected ? 'selected' : ''}>${m.displayName} (${id})</option>`;
            });
            
            select.innerHTML = `
                <option value="gemini-1.5-flash">gemini-1.5-flash (Default)</option>
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
    if (btn) { btn.innerText = 'Syncing...'; btn.disabled = true; }

    try {
        const gmailMsgs = await fetchGmailMessages();
        const tasks = await analyzeWithGemini(gmailMsgs);
        
        lastFetchedTasks = tasks;
        renderFilteredTasks();

        const status = document.getElementById('sync-status');
        if (status) status.innerText = `Auto-Sync Active (Last: ${new Date().toLocaleTimeString()})`;
    } catch (e) {
        console.error("Sync Error:", e);
        alert(`Sync failed: ${e.message}`);
    } finally {
        if (btn) { btn.innerText = '手動同期'; btn.disabled = false; }
    }
}


async function fetchGmailMessages() {
    // Specific query matching user criteria:
    // To: ishigami|tlp|slp, Newer: 7d, NOT from: tlp|slp
    const q = '(to:ishigami@isl.gr.jp OR to:tlp@isl.gr.jp OR to:slp@isl.gr.jp) -from:tlp@isl.gr.jp -from:slp@isl.gr.jp newer_than:7d';
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    // Check for 403 Forbidden
    if (response.status === 403) {
        throw new Error("Gmail API Forbidden (403): Please enable Gmail API in Google Cloud Console.");
    }
    const data = await response.json();
    if (!data.messages) return [];

    const messages = [];
    const messageIds = data.messages.slice(0, 40); // Detailed fetch limited to 40 items to avoid rate limits

    // Fetch details in small chunks to avoid 429 Too Many Requests
    for (let i = 0; i < messageIds.length; i += 5) {
        const chunk = messageIds.slice(i, i + 5);
        const chunkResults = await Promise.all(chunk.map(async (m) => {
            try {
                const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                if (!detailRes.ok) return null;
                const msg = await detailRes.json();
                if (!msg.payload) return null;
                
                const headers = msg.payload.headers;
                return {
                    source: 'Gmail',
                    id: msg.id,
                    snippet: msg.snippet,
                    from: headers.find(h => h.name === 'From')?.value || 'Unknown',
                    subject: headers.find(h => h.name === 'Subject')?.value || 'No Subject',
                    url: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId || msg.id}`
                };
            } catch (err) {
                console.warn(`Failed to fetch detail for ${m.id}`, err);
                return null;
            }
        }));
        messages.push(...chunkResults.filter(r => r !== null));
        // Small delay to be polite to the API
        await new Promise(r => setTimeout(r, 100));
    }
    
    return messages;
}

async function analyzeWithGemini(messages) {
    if (messages.length === 0) return [];
    if (!config.geminiKey) return [{ source: 'System', priority: 'mid', title: 'API Key Missing', desc: 'Settingsから設定してください。' }];

    const modelName = config.geminiModel || 'gemini-1.5-flash';
    // Use v1beta endpoint as default to support latest/preview models
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${config.geminiKey}`;
    
    const prompt = `
    Analyze these Gmail messages and extract EVERY "ACTION REQUIRED" task.
    User's Extraction Criteria:
    - Target Recipient: ishigami@isl.gr.jp OR tlp@isl.gr.jp OR slp@isl.gr.jp 宛のメール
    - Rules: 質問、依頼、内容確認の依頼、期限付きの連絡、自分が対応すべきタスク
    - Exclusivity: 具体的で詳細な手順を出力すること
    
    CRITICAL INSTRUCTIONS:
    - Provide a CONCRETE and DETAILED action (e.g., "Reply to [Name] about [Subject] by tomorrow morning").
    - You MUST include the "refId" which is the exact "id" from the source message data.
    
    Output JSON aggregate array only:
    [{"source": "Gmail", "priority": "high|mid|low", "title": "Task Title", "desc": "Step-by-Step Action", "time": "From/Date", "refId": "id"}]
    
    Data:
    ${JSON.stringify(messages.slice(0, 40))}
    `;

    try {
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const raw = await res.json();
        
        if (raw.error) {
            return [{ source: 'Error', priority: 'high', title: 'Gemini API Error', desc: raw.error.message }];
        }
        
        if (!raw.candidates || raw.candidates.length === 0) {
            return [{ source: 'Error', priority: 'high', title: 'AI Analysis Blocked', desc: 'AIが内容の分析を拒否しました。内容が長すぎるか、安全フィルターに制限された可能性があります。' }];
        }
        
        const text = raw.candidates[0].content.parts[0].text;
        const jsonMatch = text.match(/\[.*\]/s);
        let results = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        
        // Map original URLs back based on refId
        return results.map(r => {
            const original = messages.find(m => m.id === r.refId);
            return { ...r, url: original ? original.url : '#' };
        });
    } catch (e) {
        console.error("Gemini Error:", e);
        return [{ source: 'Error', priority: 'high', title: 'Gemini Technical Failure', desc: e.message }];
    }
}

function renderTasks(tasks, isArchive = false) {
    const listId = isArchive ? 'archive-list' : 'task-list';
    const list = document.getElementById(listId);
    if (!list) return;
    
    if (tasks.length === 0) {
        list.innerHTML = `<div style="text-align:center; padding: 2rem; color:var(--gmail-text-dim);">${isArchive ? 'No archived tasks.' : 'No action items found. All clear!'}</div>`;
        return;
    }

    list.innerHTML = tasks.map(task => `
        <div id="${isArchive ? 'arch-' : 'task-'}${task.refId}" class="task-row unread priority-${task.priority || 'mid'}">
            <div class="sender" onclick="window.open('${task.url}', '_blank')">${task.time || 'Unknown'}</div>
            <div class="title-snippet" onclick="window.open('${task.url}', '_blank')">
                <b>${task.title}</b> - <span>${task.desc}</span>
            </div>
            <div class="date">${isArchive ? '' : 'Now'}</div>
            <div class="actions">
                ${isArchive ? 
                    `<button onclick="restoreTask('${task.refId}')" class="action-icon" title="Restore" style="border:none;background:none;font-size:18px;">⟲</button>` :
                    `<button onclick="dismissTask('${task.refId}')" class="action-icon" title="Done" style="border:none;background:none;font-size:18px;">✓</button>`
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
        
        // Save to archive storage
        const task = lastFetchedTasks.find(t => t.refId === id);
        if (task) {
            config.archivedTasks.unshift(task);
            localStorage.setItem('archived_tasks', JSON.stringify(config.archivedTasks.slice(0, 50)));
        }

        // Immediate visual feedback: Hide the element
        const el = document.getElementById(`task-${id}`);
        if (el) {
            el.style.opacity = '0';
            el.style.transform = 'translateY(-20px)';
            setTimeout(renderFilteredTasks, 300);
        } else {
            renderFilteredTasks();
        }
    }
}

window.restoreTask = function(id) {
    config.doneTasks = config.doneTasks.filter(tid => tid !== id);
    config.archivedTasks = config.archivedTasks.filter(t => t.refId !== id);
    localStorage.setItem('done_tasks', JSON.stringify(config.doneTasks));
    localStorage.setItem('archived_tasks', JSON.stringify(config.archivedTasks));
    renderArchive();
    renderFilteredTasks();
}

async function handleChat() {
    const input = document.getElementById('chat-input');
    const history = document.getElementById('chat-history');
    const query = input.value.trim();
    if (!query) return;

    // Add user message to UI
    appendChatMessage('user', query);
    input.value = '';

    const modelName = config.geminiModel === 'custom' ? 
        document.getElementById('gemini-custom-model').value : config.geminiModel;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${config.geminiKey}`;

    const context = `
    You are an AI assistant analyzing the following tasks from the user's Gmail.
    Tasks: ${JSON.stringify(lastFetchedTasks.slice(0, 20))}
    Answer the user's question based on this context. 
    Use Japanese.
    `;

    try {
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: `${context}\n\nUser: ${query}` }] }] })
        });
        const raw = await res.json();
        const responseText = raw.candidates[0].content.parts[0].text;
        appendChatMessage('ai', responseText);
    } catch (e) {
        appendChatMessage('ai', "Error: " + e.message);
    }
}

function appendChatMessage(role, text) {
    const history = document.getElementById('chat-history');
    const msg = document.createElement('div');
    msg.style.padding = '10px 14px';
    msg.style.borderRadius = '12px';
    msg.style.maxWidth = '85%';
    if (role === 'user') {
        msg.style.alignSelf = 'flex-end';
        msg.style.background = 'rgba(99, 102, 241, 0.2)';
        msg.style.border = '1px solid var(--primary-glow)';
    } else {
        msg.style.alignSelf = 'flex-start';
        msg.style.background = 'rgba(255, 255, 255, 0.05)';
        msg.style.border = '1px solid var(--glass-border)';
    }
    msg.innerText = text;
    history.appendChild(msg);
    history.scrollTop = history.scrollHeight;
}

function getPriorityColor(p) {
    if (p === 'high') return 'var(--error)';
    if (p === 'mid') return 'var(--primary-glow)';
    return 'var(--success)';
}
