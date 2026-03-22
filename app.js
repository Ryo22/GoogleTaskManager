let tokenClient;
let accessToken = null;
let gapiInited = false;
let gisInited = false;

// Settings (persist in localStorage)
const config = {
    clientId:    localStorage.getItem('google_client_id')    || '710668584134-j2bdh6dptd1d46uojgqofubfn70out0g.apps.googleusercontent.com',
    geminiKey:   localStorage.getItem('gemini_api_key')      || '',
    geminiModel: localStorage.getItem('gemini_model')        || 'gemini-3.1-flash-lite-preview',
    criteria:    localStorage.getItem('extraction_criteria') || "直近10日以内の ishigami@isl.gr.jp / tlp@isl.gr.jp / slp@isl.gr.jp 宛メールから、質問、依頼、内容確認、および総合的に見て対応が必要、または少しでも対応が必要と思わせるタスクを抽出してください。",
    doneTasks:   JSON.parse(localStorage.getItem('done_tasks')     || '[]'),
    archivedTasks:JSON.parse(localStorage.getItem('archived_tasks') || '[]')
};

let autoSyncInterval = null;
let lastFetchedTasks = []; // Cache for current tasks

// ===== Filters & Sort =====
const activeFilters = { priority: null, deadline: null };
let   activeSort    = 'date-desc'; // 'date-desc' | 'date-asc' | 'priority'

function applyFilters(tasks) {
    return tasks.filter(t => {
        if (config.doneTasks.includes(t.refId)) return false;
        if (activeFilters.priority && t.priority !== activeFilters.priority) return false;
        if (activeFilters.deadline) {
            const d   = (t.deadline || '').replace(/\s/g, '');
            const map = { today: '今日中', tomorrow: '明日中', thisweek: '今週中', unknown: '期限不明' };
            if (d !== map[activeFilters.deadline]) return false;
        }
        return true;
    });
}

function applySort(tasks) {
    const priorityOrder = { high: 0, mid: 1, low: 2 };
    const toMs = t => t.receivedDate ? new Date(t.receivedDate).getTime() : 0;
    const copy  = [...tasks];
    if (activeSort === 'date-desc') return copy.sort((a, b) => toMs(b) - toMs(a));
    if (activeSort === 'date-asc')  return copy.sort((a, b) => toMs(a) - toMs(b));
    if (activeSort === 'priority')  return copy.sort((a, b) =>
        (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9) || toMs(b) - toMs(a));
    return copy;
}

window.setSort = function(value) {
    activeSort = value;
    document.querySelectorAll('.sort-chip').forEach(el =>
        el.classList.toggle('active', el.dataset.value === value)
    );
    renderFilteredTasks();
};

window.setFilter = function(type, value) {
    activeFilters[type] = (activeFilters[type] === value) ? null : value;
    document.querySelectorAll(`.filter-chip[data-type="${type}"]`).forEach(el => {
        el.classList.toggle('active', el.dataset.value === (activeFilters[type] ?? '__all__'));
    });
    renderFilteredTasks();
};

// ===== Google Drive appDataFolder helpers =====
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

function driveHeaders(extra = {}) {
    return { 'Authorization': `Bearer ${accessToken}`, ...extra };
}

// ファイル名からファイルIDを検索（なければ null）
async function driveFindFile(name) {
    try {
        const res = await fetch(
            `${DRIVE_API}/files?spaces=appDataFolder&q=${encodeURIComponent(`name='${name}'`)}&fields=files(id,name)`,
            { headers: driveHeaders() }
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.files?.[0]?.id || null;
    } catch (e) { console.warn('driveFindFile error', e); return null; }
}

// ファイルIDの内容を JSON として読み込む
async function driveReadFile(fileId) {
    try {
        const res = await fetch(
            `${DRIVE_API}/files/${fileId}?alt=media`,
            { headers: driveHeaders() }
        );
        if (!res.ok) return null;
        return await res.json();
    } catch (e) { console.warn('driveReadFile error', e); return null; }
}

// ファイルを作成または上書き保存する（data はオブジェクト）
async function driveWriteFile(fileId, name, data) {
    const body = JSON.stringify(data);
    try {
        if (fileId) {
            // 既存ファイルを上書き
            const res = await fetch(
                `${DRIVE_UPLOAD}/files/${fileId}?uploadType=media`,
                { method: 'PATCH', headers: driveHeaders({ 'Content-Type': 'application/json' }), body }
            );
            if (!res.ok) console.warn('driveWriteFile update error', await res.text());
            return fileId;
        } else {
            // 新規作成（multipart）
            const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
            const boundary = 'boundary_xyz';
            const multipart = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
            const res = await fetch(
                `${DRIVE_UPLOAD}/files?uploadType=multipart`,
                { method: 'POST', headers: driveHeaders({ 'Content-Type': `multipart/related; boundary=${boundary}` }), body: multipart }
            );
            if (!res.ok) { console.warn('driveWriteFile create error', await res.text()); return null; }
            const created = await res.json();
            return created.id || null;
        }
    } catch (e) { console.warn('driveWriteFile error', e); return null; }
}

// ファイルを削除する
async function driveDeleteFile(fileId) {
    if (!fileId) return;
    try {
        await fetch(`${DRIVE_API}/files/${fileId}`, { method: 'DELETE', headers: driveHeaders() });
    } catch (e) { console.warn('driveDeleteFile error', e); }
}

// ===== Gmail メッセージキャッシュ（in-memory + Drive flush）=====
let _msgCache   = null;   // Map<id, message>  ← null は未ロード
let _msgCacheId = null;   // Drive ファイルID

async function loadMsgCache() {
    if (_msgCache !== null) return;   // 既にロード済み
    _msgCacheId = await driveFindFile('gmail_cache.json');
    if (_msgCacheId) {
        const data = await driveReadFile(_msgCacheId);
        _msgCache = new Map(Array.isArray(data) ? data.map(m => [m.id, m]) : []);
    } else {
        _msgCache = new Map();
    }
}

async function flushMsgCache() {
    if (!_msgCache || _msgCache.size === 0) return;
    const arr  = [..._msgCache.values()];
    const newId = await driveWriteFile(_msgCacheId, 'gmail_cache.json', arr);
    if (newId) _msgCacheId = newId;
}

// ids[] から in-memory キャッシュを検索
function cacheGet(ids) {
    const map = new Map();
    if (!_msgCache) return map;
    ids.forEach(id => { if (_msgCache.has(id)) map.set(id, _msgCache.get(id)); });
    return map;
}

// メッセージを in-memory キャッシュに追加（Drive flush は syncTasks 末尾で一括）
function cacheSet(messages) {
    if (!_msgCache) _msgCache = new Map();
    messages.forEach(m => _msgCache.set(m.id, m));
}

window.clearGmailCache = async function() {
    if (!accessToken) { alert('ログインが必要です。'); return; }
    try {
        await loadMsgCache();
        if (_msgCacheId) {
            await driveDeleteFile(_msgCacheId);
            _msgCacheId = null;
        }
        _msgCache = new Map();
        alert('メールキャッシュをクリアしました。次回同期時に全件再取得します。');
    } catch (e) { alert('エラー: ' + e.message); }
};

window.gisLoaded = function() {
    console.log("Google Identity Services (GIS) loaded");
    gisInited = true;
    checkBeforeLogin();
};

function initGis() {
    // Legacy support
}

// ===== Auth helpers =====
function handleTokenResponse(resp) {
    if (resp.error) {
        // サイレントログイン失敗 → ボタン表示（エラーは通知しない）
        console.warn('Token response error:', resp.error);
        showLoginButton();
        return;
    }
    accessToken = resp.access_token;
    localStorage.setItem('was_logged_in', '1');
    onLoginSuccess();
    // 55 分後にサイレントリフレッシュ（アクセストークンの有効期限は1時間）
    setTimeout(silentRefresh, 55 * 60 * 1000);
}

function silentRefresh() {
    if (accessToken && tokenClient) {
        tokenClient.requestAccessToken({ prompt: '' });
    }
}

function showLoginButton() {
    const btn    = document.getElementById('login-btn');
    const status = document.getElementById('login-status');
    if (btn)    { btn.classList.remove('hidden'); }
    if (status) { status.innerText = 'Googleアカウントでサインインしてください'; }
}

window.logout = function() {
    accessToken = null;
    localStorage.removeItem('was_logged_in');
    const loginView = document.getElementById('login-view');
    const appView   = document.getElementById('app-view');
    if (loginView) { loginView.style.opacity = '1'; loginView.classList.remove('hidden'); }
    if (appView)   { appView.classList.add('hidden'); }
    showLoginButton();
    if (autoSyncInterval) { clearInterval(autoSyncInterval); autoSyncInterval = null; }
};

function checkBeforeLogin() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkBeforeLogin);
        return;
    }

    if (config.clientId && gisInited) {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: config.clientId,
            scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.appdata',
            callback: handleTokenResponse,
        });

        if (localStorage.getItem('was_logged_in')) {
            // 既ログイン済み → UI なしでサイレントログインを試みる
            const status = document.getElementById('login-status');
            if (status) status.innerText = '認証を確認中...';
            tokenClient.requestAccessToken({ prompt: '' });
            // 8秒以内に成功しなければログインボタンを表示（フォールバック）
            setTimeout(() => { if (!accessToken) showLoginButton(); }, 8000);
        } else {
            showLoginButton();
        }
    } else if (!config.clientId) {
        const loginBtn = document.getElementById('login-btn');
        if (loginBtn) {
            loginBtn.innerText = 'Settings で Client ID を設定してください';
            loginBtn.disabled  = true;
            loginBtn.classList.remove('hidden');
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
            if (tokenClient) tokenClient.requestAccessToken({ prompt: 'select_account' });
            else alert("Google Auth Client はまだ初期化中です。しばらくお待ちください。");
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
        if (ci) ci.value = config.clientId  || '';
        if (gk) gk.value = config.geminiKey || '';
        if (ct) ct.value = config.criteria  || '';

        setActiveNav('nav-settings');
    });

    if (cancelBtn) cancelBtn.addEventListener('click', () => closeModal('settings-modal'));

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            config.clientId    = document.getElementById('client-id-input').value;
            config.geminiKey   = document.getElementById('gemini-key-input').value;
            const m            = document.getElementById('gemini-model-select').value;
            config.geminiModel = m === 'custom' ? document.getElementById('gemini-custom-model').value : m;
            config.criteria    = document.getElementById('criteria-textarea').value;

            localStorage.setItem('google_client_id',    config.clientId);
            localStorage.setItem('gemini_api_key',      config.geminiKey);
            localStorage.setItem('gemini_model',        config.geminiModel);
            localStorage.setItem('extraction_criteria', config.criteria);

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

// ===== Drive persistence for tasks =====
let _tasksFileId = null;

async function loadTasksFromDrive() {
    try {
        if (!_tasksFileId) _tasksFileId = await driveFindFile('tasks.json');
        if (!_tasksFileId) return null;
        return await driveReadFile(_tasksFileId);
    } catch (e) { console.warn('loadTasksFromDrive error', e); return null; }
}

async function saveTasksToDrive(tasks) {
    try {
        const newId = await driveWriteFile(_tasksFileId, 'tasks.json', { tasks, synced_at: new Date().toISOString() });
        if (newId) _tasksFileId = newId;
    } catch (e) { console.warn('saveTasksToDrive error', e); }
}

async function reloadFromDrive() {
    const data = await loadTasksFromDrive();
    if (data?.tasks?.length) {
        lastFetchedTasks = data.tasks;
        renderFilteredTasks();
    }
}

async function loadAndDisplayTasks() {
    setSyncStatus('データを読み込み中...');
    const data = await loadTasksFromDrive();
    if (data?.tasks?.length) {
        lastFetchedTasks = data.tasks;
        renderFilteredTasks();
        const t = data.synced_at
            ? new Date(data.synced_at).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })
            : '不明';
        setSyncStatus(`最終同期: ${t}　(↻ で再取得)`);
    } else {
        await syncTasks(); // Drive にデータなし → 初回同期
    }
}

// ===== View / Nav =====
function onLoginSuccess() {
    const loginView = document.getElementById('login-view');
    const appView   = document.getElementById('app-view');
    if (loginView) loginView.style.opacity = '0';
    setTimeout(() => {
        if (loginView) loginView.classList.add('hidden');
        if (appView)   appView.classList.remove('hidden');
        loadAndDisplayTasks();                                // API を呼ばず DB から読む
        if (autoSyncInterval) clearInterval(autoSyncInterval);
        autoSyncInterval = setInterval(reloadFromDrive, 5 * 60 * 1000); // Drive 読み込みのみ
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

function setSyncStatus(text) {
    const el = document.getElementById('sync-status');
    if (el) el.innerText = text;
}

async function syncTasks() {
    if (!accessToken) return;
    const btn = document.getElementById('sync-btn');
    if (btn) { btn.classList.add('spinning'); btn.disabled = true; }

    try {
        setSyncStatus('メールを取得中...');
        const gmailMsgs = await fetchGmailMessages();
        setSyncStatus(`${gmailMsgs.length}件を AI 分析中...`);

        // バッチ完了ごとに逐次描画
        const tasks = await analyzeWithGemini(gmailMsgs, (partial) => {
            lastFetchedTasks = partial;
            renderFilteredTasks();
            setSyncStatus(`AI分析中... ${partial.length}件検出（継続中）`);
        });

        lastFetchedTasks = tasks;
        renderFilteredTasks();
        await saveTasksToDrive(tasks);  // Drive に保存（次回起動時に再利用）
        setSyncStatus(`完了 ${new Date().toLocaleTimeString()} (${gmailMsgs.length}件分析 / ${tasks.length}件検出)`);
    } catch (err) {
        console.error("Sync failed:", err);
        setSyncStatus('同期エラー');
    } finally {
        const syncBtn = document.getElementById('sync-btn');
        if (syncBtn) { syncBtn.classList.remove('spinning'); syncBtn.disabled = false; }
    }
}

async function fetchGmailMessages() {
    const query = `(to:ishigami@isl.gr.jp OR to:tlp@isl.gr.jp OR to:slp@isl.gr.jp) -from:tlp@isl.gr.jp -from:slp@isl.gr.jp newer_than:30d`;
    const headers = { 'Authorization': `Bearer ${accessToken}` };

    // ── Step 1: ページネーションで最大1000件のIDを取得 ──────────────
    setSyncStatus('メールIDを取得中...');
    let allIds = [];
    let pageToken = null;
    for (let page = 0; page < 2; page++) {
        try {
            const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=${encodeURIComponent(query)}`
                      + (pageToken ? `&pageToken=${pageToken}` : '');
            const res  = await fetch(url, { headers });
            const data = await res.json();
            if (!data.messages) break;
            allIds.push(...data.messages.map(m => m.id));
            setSyncStatus(`メールID取得: ${allIds.length}件...`);
            if (!data.nextPageToken) break;
            pageToken = data.nextPageToken;
        } catch (e) {
            console.warn('Pagination error page', page, e);
            break;
        }
    }
    if (allIds.length === 0) return [];

    // ── Step 2: Drive キャッシュをロードして確認 ─────────────────────
    setSyncStatus(`${allIds.length}件のIDを確認中...`);
    await loadMsgCache();
    const cached = cacheGet(allIds);
    const newIds = allIds.filter(id => !cached.has(id));
    setSyncStatus(`キャッシュ済: ${cached.size}件 / 新規取得: ${newIds.length}件`);

    // ── Step 3: 未キャッシュのメール詳細を10並列で取得 ──────────────
    const newMessages = [];
    for (let i = 0; i < newIds.length; i += 10) {
        setSyncStatus(`詳細取得中... ${Math.min(i + 10, newIds.length)} / ${newIds.length}件`);
        const chunk   = newIds.slice(i, i + 10);
        const results = await Promise.all(chunk.map(async id => {
            try {
                // format=metadata で snippet+指定ヘッダのみ取得（高速）
                const res = await fetch(
                    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`
                    + `?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
                    { headers }
                );
                if (!res.ok) return null;
                const msg = await res.json();
                if (!msg.payload) return null;
                const hdrs = msg.payload.headers;
                return {
                    source:  'Gmail',
                    id:      msg.id,
                    snippet: msg.snippet,
                    from:    hdrs.find(h => h.name === 'From')?.value    || 'Unknown',
                    subject: hdrs.find(h => h.name === 'Subject')?.value || 'No Subject',
                    date:    hdrs.find(h => h.name === 'Date')?.value    || '',
                    url:     `https://mail.google.com/mail/u/0/#inbox/${msg.threadId || msg.id}`
                };
            } catch (e) {
                console.warn('Failed to fetch detail', id, e);
                return null;
            }
        }));
        const valid = results.filter(Boolean);
        newMessages.push(...valid);
        cacheSet(valid);   // in-memory のみ（Drive flush は関数末尾で一括）
        await new Promise(r => setTimeout(r, 80));
    }

    // ── Step 4: キャッシュ + 新規 を結合して返す ────────────────────
    const all = [...cached.values(), ...newMessages];
    all.sort((a, b) => (b.id > a.id ? 1 : -1));

    // ── Step 5: Drive に一括フラッシュ ──────────────────────────────
    if (newMessages.length > 0) {
        setSyncStatus('キャッシュをDriveに保存中...');
        await flushMsgCache();
    }

    return all;
}

// JSON 抽出：そのまま → 配列部分のみ → 空配列の順でフォールバック
function extractJsonArray(text) {
    try { return JSON.parse(text.trim()); } catch {}
    const m = text.match(/\[[\s\S]*\]/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return [];
}

// 1バッチ分の Gemini 呼び出し
async function analyzeOneBatch(apiUrl, batch, allMessages) {
    const prompt = `
    以下のメールリストを分析し、「対応が必要なタスク」を漏れなく抽出してください。

    ■ 抽出基準：
    1. 質問・依頼・内容確認など返信が必要なもの
    2. 少しでも対応が必要と思われるもの（迷う場合は含める）
    3. 放置すると問題になりそうな連絡

    ■ ユーザー独自の抽出要件:
    ${config.criteria}

    ■ 出力形式 (JSON 配列のみ。前後に説明文を一切つけないこと):
    [{"source":"Gmail","priority":"high|mid|low","title":"動詞から始めるアクション要約","desc":"具体的な対応内容","deadline":"今日中／明日中／今週中／〇月〇日まで／期限不明","time":"差出人 / 受信日","refId":"id"}]

    ■ メールデータ (JSON):
    ${JSON.stringify(batch)}
    `;

    try {
        const res = await fetch(apiUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                contents:         [{ parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: 8192 }
            })
        });
        const raw = await res.json();
        if (raw.error) { console.error('Gemini batch error', raw.error.message); return []; }
        if (!raw.candidates?.length) return [];

        const text    = raw.candidates[0].content.parts[0].text;
        const results = extractJsonArray(text);
        return results.map(r => {
            const orig = allMessages.find(m => m.id === r.refId);
            return {
                ...r,
                url:          orig ? orig.url  : '#',
                receivedDate: orig ? orig.date : '',   // 実際の受信日時
                senderFrom:   orig ? orig.from : ''    // 実際の差出人
            };
        });
    } catch (e) {
        console.error('analyzeOneBatch error', e);
        return [];
    }
}

async function analyzeWithGemini(messages, onProgress) {
    if (messages.length === 0) return [];
    if (!config.geminiKey) return [{
        source: 'System', priority: 'mid', title: 'API Key Missing', desc: 'Settingsから設定してください。'
    }];

    const modelName = config.geminiModel || 'gemini-2.0-flash-lite';
    const apiUrl    = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${config.geminiKey}`;

    // 150件ずつバッチ（最大 900件 = 6バッチ）
    const BATCH_SIZE = 150;
    const targets    = messages.slice(0, 900);
    const batches    = [];
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        batches.push(targets.slice(i, i + BATCH_SIZE));
    }

    const allResults = [];
    for (let b = 0; b < batches.length; b++) {
        setSyncStatus(`AI分析中... バッチ ${b + 1} / ${batches.length}（計 ${targets.length} 件）`);
        const results = await analyzeOneBatch(apiUrl, batches[b], messages);
        allResults.push(...results);

        // バッチ完了ごとに画面へ反映
        if (onProgress) onProgress([...allResults]);

        // バッチ間にウェイト（レートリミット対策）
        if (b < batches.length - 1) await new Promise(r => setTimeout(r, 1200));
    }

    return allResults;
}

// ===== Render =====

// 受信日時を「M/D HH:mm」形式で表示
function formatReceivedDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        if (isNaN(d)) return dateStr;
        const m    = d.getMonth() + 1;
        const dd   = d.getDate();
        const hhmm = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        const yr   = d.getFullYear();
        const now  = new Date();
        return yr === now.getFullYear() ? `${m}/${dd} ${hhmm}` : `${yr}/${m}/${dd}`;
    } catch { return dateStr; }
}

// "山田 太郎 <taro@example.com>" → "山田 太郎"
function extractSenderName(from) {
    if (!from) return '';
    const m = from.match(/^"?([^"<]+?)"?\s*</);
    if (m) return m[1].trim();
    const em = from.match(/^([^@\s]+)@/);
    return em ? em[1] : from;
}

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

    list.innerHTML = tasks.map(task => {
        const dateLabel   = formatReceivedDate(task.receivedDate) || task.time || '';
        const senderLabel = extractSenderName(task.senderFrom)    || '';
        return `
        <div id="${isArchive ? 'arch-' : 'task-'}${task.refId}" class="task-row unread priority-${task.priority || 'mid'}">
            <div class="sender" onclick="window.open('${task.url}', '_blank')">
                <div class="received-date">${dateLabel}</div>
                ${senderLabel ? `<div class="received-from">${senderLabel}</div>` : ''}
            </div>
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
    `; }).join('');
}

function renderFilteredTasks() {
    renderTasks(applySort(applyFilters(lastFetchedTasks)));
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
