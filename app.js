// --- Database Logic ---
const DB_NAME = 'KAKEI2_DB';
const DB_VERSION = 1;
const STORE_NAME = 'expenses';

let db;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('groupTitle', 'groupTitle', { unique: false });
            }
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
        request.onerror = (e) => reject(e);
    });
}

function saveExpense(expense) {
    return new Promise((resolve, reject) => {
        const trans = db.transaction([STORE_NAME], 'readwrite');
        const store = trans.objectStore(STORE_NAME);
        store.add(expense);
        trans.oncomplete = () => resolve();
        trans.onerror = (e) => reject(e);
    });
}

function getAllExpenses() {
    return new Promise((resolve, reject) => {
        const trans = db.transaction([STORE_NAME], 'readonly');
        const store = trans.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e);
    });
}

function clearAllData() {
    return new Promise((resolve, reject) => {
        const trans = db.transaction([STORE_NAME], 'readwrite');
        const store = trans.objectStore(STORE_NAME);
        store.clear();
        trans.oncomplete = () => resolve();
        trans.onerror = (e) => reject(e);
    });
}

function clearGroupData(groupTitle) {
    return new Promise((resolve, reject) => {
        const trans = db.transaction([STORE_NAME], 'readwrite');
        const store = trans.objectStore(STORE_NAME);
        const index = store.index('groupTitle');
        const request = index.openCursor(IDBKeyRange.only(groupTitle));
        request.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
        trans.oncomplete = () => resolve();
        trans.onerror = (e) => reject(e);
    });
}

// --- CSV行パースユーティリティ ---
function parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let char of line) {
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) {
            fields.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    fields.push(current.trim());
    return fields;
}

// --- 未確定CSV Parsing Logic ---
// フォーマット: ご利用年月日, 利用店名, 支払区分, カード利用者区分, ご利用金額
function parseDraftCSV(text, groupTitle) {
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
    
    const idxDate = headers.indexOf('ご利用年月日');
    const idxStore = headers.indexOf('利用店名');
    const idxType = headers.indexOf('支払区分');
    const idxUser = headers.indexOf('カード利用者区分');
    const idxAmount = headers.indexOf('ご利用金額');

    if (idxDate === -1 || idxAmount === -1) {
        alert('未確定CSVの必要な項目（ご利用年月日、ご利用金額など）が見つかりません。');
        return [];
    }

    const results = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const fields = parseCsvLine(line);
        if (fields.length <= Math.max(idxDate, idxAmount)) continue;

        const dateStr = fields[idxDate].replace(/^"|"$/g, '');
        const amountStr = fields[idxAmount].replace(/^"|"$/g, '').replace(/,/g, '');
        const amount = parseInt(amountStr, 10) || 0;

        results.push({
            date: dateStr,
            store: fields[idxStore] || '不明',
            type: fields[idxType] || '',
            user: fields[idxUser] || '',
            amount: amount,
            groupTitle: groupTitle
        });
    }
    return results;
}

// --- 確定CSV Parsing Logic ---
// フォーマット: D列(index 3)の2行目から: ご利用年月日, 利用店名, 支払い金額, 支払区分
function parseConfirmedCSV(text, groupTitle) {
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return [];

    const results = [];
    // 2行目(index 1)からデータ開始
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const fields = parseCsvLine(line);

        // D列(index 3)からデータ: ご利用年月日, 利用店名, 支払い金額, 支払区分
        if (fields.length < 7) continue; // D列+4項目 = 最低7列必要

        const dateStr = (fields[3] || '').replace(/^"|"$/g, '');
        const storeStr = (fields[4] || '').replace(/^"|"$/g, '');
        const amountStr = (fields[5] || '').replace(/^"|"$/g, '').replace(/,/g, '');
        const typeStr = (fields[6] || '').replace(/^"|"$/g, '');

        if (!dateStr) continue;
        const amount = parseInt(amountStr, 10) || 0;

        results.push({
            date: dateStr,
            store: storeStr || '不明',
            type: typeStr || '',
            user: '',
            amount: amount,
            groupTitle: groupTitle
        });
    }
    return results;
}

// --- UI Logic ---
let currentGroup = '';
let currentSearchTerm = '';

async function updateUI(searchTerm = '') {
    currentSearchTerm = searchTerm;
    const allExpenses = await getAllExpenses();
    
    // グループごとのタブを生成（月番号順にソート）
    const groupTitles = [...new Set(allExpenses.map(e => e.groupTitle))];
    groupTitles.sort((a, b) => {
        // タイトルから数字を抽出してソート（例："3月分" → 3, "12月分" → 12）
        const numA = parseInt((a.match(/\d+/) || ['9999'])[0], 10);
        const numB = parseInt((b.match(/\d+/) || ['9999'])[0], 10);
        return numA - numB;
    });
    const tabsContainer = document.getElementById('monthTabs');
    tabsContainer.innerHTML = '';

    if (groupTitles.length === 0) {
        document.getElementById('expenseList').innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">データがありません</div>';
        document.getElementById('grandTotal').textContent = '0';
        document.getElementById('searchResultDisplay').classList.add('hidden');
        return;
    }

    if (!currentGroup || !groupTitles.includes(currentGroup)) {
        currentGroup = groupTitles[0];
    }

    groupTitles.forEach(title => {
        const btn = document.createElement('button');
        btn.className = `tab ${title === currentGroup ? 'active' : ''}`;
        btn.textContent = title;
        btn.onclick = () => {
            currentGroup = title;
            currentSearchTerm = '';
            document.getElementById('searchInput').value = '';
            updateUI();
        };
        tabsContainer.appendChild(btn);
    });

    // 明細リストの表示（選択中グループでフィルタ）
    let filtered = allExpenses.filter(e => e.groupTitle === currentGroup);
    
    // キーワード検索
    let searchTotal = 0;
    const isSearching = !!currentSearchTerm.trim();
    if (isSearching) {
        // 検索ワードを正規化（全角英数を半角に、半角カナを全角に、小文字化）
        const term = currentSearchTerm.normalize('NFKC').toLowerCase();
        filtered = filtered.filter(item => {
            // 対象文字列も同様に正規化して比較
            const target = `${item.store} ${item.type} ${item.user}`.normalize('NFKC').toLowerCase();
            const match = target.includes(term);
            if (match) searchTotal += item.amount;
            return match;
        });
        
        document.getElementById('searchResultDisplay').classList.remove('hidden');
        document.getElementById('searchTotal').textContent = `¥${searchTotal.toLocaleString()}`;
    } else {
        document.getElementById('searchResultDisplay').classList.add('hidden');
    }

    const listContainer = document.getElementById('expenseList');
    listContainer.innerHTML = '';

    let total = 0;
    filtered.forEach(item => {
        if (!isSearching) total += item.amount;
        const div = document.createElement('div');
        div.className = 'expense-item';
        div.innerHTML = `
            <div class="item-date">${item.date}</div>
            <div class="item-main">
                <span class="item-title">${item.store}</span>
                <span class="item-sub">${item.user ? item.user + ' | ' : ''}${item.type}</span>
            </div>
            <div class="item-amount">¥${item.amount.toLocaleString()}</div>
        `;
        listContainer.appendChild(div);
    });

    // 総合計は常にグループ全体の合計を表示（検索中も変わらない）
    if (!isSearching) {
        const groupAll = allExpenses.filter(e => e.groupTitle === currentGroup);
        total = groupAll.reduce((sum, e) => sum + e.amount, 0);
        document.getElementById('grandTotal').textContent = total.toLocaleString();
    }
}

// --- Search Interaction ---
document.getElementById('searchBtn').addEventListener('click', () => {
    const term = document.getElementById('searchInput').value;
    updateUI(term);
});

document.getElementById('searchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const term = e.target.value;
        updateUI(term);
    }
});

document.getElementById('clearSearch').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    updateUI('');
});

// --- Import Interaction ---
let pendingFileContent = null;
let pendingImportType = 'draft'; // 'draft' or 'confirmed'
const titleModal = document.getElementById('titleModal');
const batchTitleInput = document.getElementById('batchTitleInput');

function decodeFileContent(arrayBuffer) {
    const decoder = new TextDecoder('shift-jis');
    let text = decoder.decode(arrayBuffer);
    // 文字化けチェック（日本語が含まれるかヒューリスティック）
    if (!text.includes('ご利用') && !text.includes('年月日')) {
        text = new TextDecoder('utf-8').decode(arrayBuffer);
    }
    return text;
}

function handleFileSelect(e, importType) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
        pendingFileContent = event.target.result;
        pendingImportType = importType;
        batchTitleInput.value = '';
        titleModal.classList.remove('hidden');
        batchTitleInput.focus();
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
}

// 未確定CSV
document.getElementById('csvPickerDraft').addEventListener('change', (e) => {
    handleFileSelect(e, 'draft');
});

// 確定CSV
document.getElementById('csvPickerConfirmed').addEventListener('change', (e) => {
    handleFileSelect(e, 'confirmed');
});

document.getElementById('confirmImport').addEventListener('click', async () => {
    const title = batchTitleInput.value.trim();
    if (!title) {
        alert('名前を入力してください');
        return;
    }

    const text = decodeFileContent(pendingFileContent);

    let data;
    if (pendingImportType === 'confirmed') {
        data = parseConfirmedCSV(text, title);
    } else {
        data = parseDraftCSV(text, title);
    }

    for (const item of data) {
        await saveExpense(item);
    }

    titleModal.classList.add('hidden');
    pendingFileContent = null;
    currentGroup = title;
    updateUI();
});

document.getElementById('cancelImport').addEventListener('click', () => {
    titleModal.classList.add('hidden');
    pendingFileContent = null;
});

document.getElementById('clearData').addEventListener('click', async () => {
    if (!currentGroup) return;
    if (confirm(`「${currentGroup}」のデータを消去しますか？`)) {
        await clearGroupData(currentGroup);
        currentGroup = '';
        updateUI();
    }
});

// --- Theme Logic ---
const themeToggle = document.getElementById('themeToggle');
const sunIcon = document.getElementById('sunIcon');
const moonIcon = document.getElementById('moonIcon');

function setTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    if (theme === 'dark') {
        sunIcon.classList.add('hidden');
        moonIcon.classList.remove('hidden');
    } else {
        sunIcon.classList.remove('hidden');
        moonIcon.classList.add('hidden');
    }
}

themeToggle.addEventListener('click', () => {
    const current = document.body.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'light' : 'dark');
});

// Initialize
window.addEventListener('load', async () => {
    // Load theme
    const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(savedTheme);

    await initDB();
    updateUI();
});
