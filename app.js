let tokenClient;
let accessToken = null;
let gapiInited = false;
let gisInited = false;

// Settings (persist in localStorage)
const config = {
    clientId: localStorage.getItem('google_client_id') || '710668584134-j2bdh6dptd1d46uojgqofubfn70out0g.apps.googleusercontent.com',
    geminiKey: localStorage.getItem('gemini_api_key') || '',
    criteria: localStorage.getItem('extraction_criteria') || "質問、依頼、期限付きの連絡、自分が対応すべきタスク。"
};

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
            scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/chat.messages.readonly',
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

    if (navTasks) navTasks.addEventListener('click', () => { showView('task-list'); setActiveNav('nav-tasks'); });
    if (navSettings) navSettings.addEventListener('click', () => {
        showView('settings-view');
        setActiveNav('nav-settings');
        document.getElementById('client-id-input').value = config.clientId;
        document.getElementById('gemini-key-input').value = config.geminiKey;
        document.getElementById('criteria-textarea').value = config.criteria;
    });

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const newClientId = document.getElementById('client-id-input').value;
            const newKey = document.getElementById('gemini-key-input').value;
            const newCriteria = document.getElementById('criteria-textarea').value;
            
            localStorage.setItem('google_client_id', newClientId);
            localStorage.setItem('gemini_api_key', newKey);
            localStorage.setItem('extraction_criteria', newCriteria);
            
            alert("Success: Saved. Reloading page...");
            location.reload();
        });
    }

    if (cancelBtn) cancelBtn.addEventListener('click', () => { showView('task-list'); setActiveNav('nav-tasks'); });
    if (syncBtn) syncBtn.addEventListener('click', syncTasks);
});

function onLoginSuccess() {
    const loginView = document.getElementById('login-view');
    const appView = document.getElementById('app-view');
    if (loginView) loginView.style.opacity = '0';
    setTimeout(() => {
        if (loginView) loginView.style.display = 'none';
        if (appView) appView.style.display = 'grid';
        syncTasks();
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

async function syncTasks() {
    if (!accessToken) return;
    const btn = document.getElementById('sync-btn');
    if (btn) { btn.innerText = 'Syncing...'; btn.disabled = true; }

    try {
        const messages = await fetchGmailMessages();
        const tasks = await analyzeWithGemini(messages);
        renderTasks(tasks);
        const status = document.getElementById('sync-status');
        if (status) status.innerText = `Last synced: ${new Date().toLocaleTimeString()}`;
    } catch (e) {
        console.error("Sync Error:", e);
        alert("Sync failed: Check Console for 403 errors. Make sure Gmail API is ENABLED in Google Cloud.");
    } finally {
        if (btn) { btn.innerText = '手動同期'; btn.disabled = false; }
    }
}

async function fetchGmailMessages() {
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=is:unread', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    // Check for 403 Forbidden
    if (response.status === 403) {
        throw new Error("Gmail API Forbidden (403): Please enable Gmail API in Google Cloud Console.");
    }
    const data = await response.json();
    if (!data.messages) return [];

    const messages = await Promise.all(data.messages.map(async (m) => {
        const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const msg = await detailRes.json();
        const headers = msg.payload.headers;
        return {
            id: msg.id,
            snippet: msg.snippet,
            from: headers.find(h => h.name === 'From')?.value || 'Unknown',
            subject: headers.find(h => h.name === 'Subject')?.value || 'No Subject'
        };
    }));
    return messages;
}

async function analyzeWithGemini(messages) {
    if (messages.length === 0) return [];
    if (!config.geminiKey) return [{ source: 'System', priority: 'mid', title: 'API Key Missing', desc: 'Please set Gemini API Key in Settings.' }];

    const prompt = `
    Analyze the following unread Gmail messages and extract "ACTION REQUIRED" items.
    Extraction Criteria: ${config.criteria}
    
    Output JSON aggregate (Strictly JSON array only):
    [{"source": "Gmail", "priority": "high|mid|low", "title": "Subject", "desc": "Detailed action needed", "time": "Sender"}]
    
    Messages:
    ${JSON.stringify(messages.slice(0, 10))}
    `;

    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${config.geminiKey}`, {
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
        return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
        console.error("Gemini Error:", e);
        return [{ source: 'Error', priority: 'high', title: 'Gemini Technical Failure', desc: e.message }];
    }
}

function renderTasks(tasks) {
    const list = document.getElementById('task-list');
    if (!list) return;
    
    if (tasks.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding: 2rem; color:var(--text-dim);">No action items found in your recent unread emails.</div>';
        return;
    }

    list.innerHTML = tasks.map(task => `
        <div class="task-card glass-panel priority-${task.priority || 'mid'}">
            <div class="task-header">
                <span class="task-source">${task.source} • ${task.time || ''}</span>
                <span style="font-size: 0.7rem; color: ${getPriorityColor(task.priority)};">Priority: ${String(task.priority).toUpperCase()}</span>
            </div>
            <div class="task-title">${task.title}</div>
            <p class="task-desc">${task.desc}</p>
        </div>
    `).join('');
}

function getPriorityColor(p) {
    if (p === 'high') return 'var(--error)';
    if (p === 'mid') return 'var(--primary-glow)';
    return 'var(--success)';
}
