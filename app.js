let tokenClient;
let accessToken = null;
let gapiInited = false;
let gisInited = false;

// Settings (persist in localStorage)
const config = {
    clientId: localStorage.getItem('google_client_id') || '710668584134-j2bdh6dptd1d46uojgqofubfn70out0g.apps.googleusercontent.com',
    geminiKey: localStorage.getItem('gemini_api_key') || '',
    geminiModel: localStorage.getItem('gemini_model') || 'gemini-1.5-flash',
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
    if (navSettings) navSettings.addEventListener('click', async () => {
        showView('settings-view');
        setActiveNav('nav-settings');
        document.getElementById('client-id-input').value = config.clientId;
        document.getElementById('gemini-key-input').value = config.geminiKey;
        document.getElementById('criteria-textarea').value = config.criteria;

        const modelSelect = document.getElementById('gemini-model-select');
        const customInput = document.getElementById('gemini-custom-model');
        
        // Restore custom value if it's not a standard initial option
        const isInitial = ['gemini-1.5-flash', 'gemini-1.5-pro'].includes(config.geminiModel);
        if (!isInitial && config.geminiModel) {
            modelSelect.value = 'custom';
            customInput.style.display = 'block';
            customInput.value = config.geminiModel;
        } else {
            modelSelect.value = config.geminiModel || 'gemini-1.5-flash';
        }
    });

    const mSelect = document.getElementById('gemini-model-select');
    if (mSelect) {
        mSelect.addEventListener('change', (e) => {
            const cInput = document.getElementById('gemini-custom-model');
            cInput.style.display = e.target.value === 'custom' ? 'block' : 'none';
        });
    }

    if (document.getElementById('fetch-models-btn')) {
        document.getElementById('fetch-models-btn').addEventListener('click', async () => {
            const key = document.getElementById('gemini-key-input').value;
            if (!key) {
                alert("Please enter a Gemini API Key first.");
                return;
            }
            const btn = document.getElementById('fetch-models-btn');
            btn.innerText = "取得中...";
            await updateModelDropdown(key);
            btn.innerText = "利用可能なモデルを取得";
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const newClientId = document.getElementById('client-id-input').value;
            const newKey = document.getElementById('gemini-key-input').value;
            let newModel = document.getElementById('gemini-model-select').value;
            if (newModel === 'custom') {
                newModel = document.getElementById('gemini-custom-model').value.trim();
            }
            const newCriteria = document.getElementById('criteria-textarea').value;
            
            config.clientId = newClientId;
            config.geminiKey = newKey;
            config.geminiModel = newModel;
            config.criteria = newCriteria;

            localStorage.setItem('google_client_id', newClientId);
            localStorage.setItem('gemini_api_key', newKey);
            localStorage.setItem('gemini_model', newModel);
            localStorage.setItem('extraction_criteria', newCriteria);
            
            alert("Settings saved. Re-syncing tasks...");
            showView('task-list');
            setActiveNav('nav-tasks');
            syncTasks();
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
        renderTasks(tasks);
        const status = document.getElementById('sync-status');
        if (status) status.innerText = `Last synced: ${new Date().toLocaleTimeString()}`;
    } catch (e) {
        console.error("Sync Error:", e);
        alert(`Sync failed: ${e.message}`);
    } finally {
        if (btn) { btn.innerText = '手動同期'; btn.disabled = false; }
    }
}


async function fetchGmailMessages() {
    // Broad search: Anything in inbox from the last 7 days (read or unread)
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=label:inbox newer_than:7d', {
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
    Criteria: ${config.criteria}
    
    CRITICAL INSTRUCTIONS:
    - DO NOT limit the output. If there are many tasks, list them all (up to 20-30 items).
    - For each task, provide a CONCRETE and DETAILED action (e.g., "Reply to [Name] about [Subject] by tomorrow morning" instead of just "Check email").
    - You MUST include the "refId" which is the exact "id" from the source message data.
    
    Output JSON aggregate array only:
    [{"source": "Gmail", "priority": "high|mid|low", "title": "Specific Task Title", "desc": "Detailed Step-by-Step Action", "time": "Sender/Time", "refId": "original_id"}]
    
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

function renderTasks(tasks) {
    const list = document.getElementById('task-list');
    if (!list) return;
    
    if (tasks.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding: 2rem; color:var(--text-dim);">No action items found in your recent unread emails.</div>';
        return;
    }

    list.innerHTML = tasks.map(task => `
        <div class="task-card glass-panel priority-${task.priority || 'mid'}" onclick="window.open('${task.url}', '_blank')" style="cursor: pointer;">
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
