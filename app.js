/* Expense Tracker — multi-user PWA on Firebase.
 * Login: Firebase Auth (mobile number used as the username, password).
 * Data: Firestore, users/{uid} (profile + categories) and users/{uid}/transactions/{id}.
 * Security rules (firebase/firestore.rules) let each user read and write only their own data.
 * Reminders: Firebase Cloud Messaging tokens in users/{uid}/devices, sent by a GitHub Actions job. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getMessaging, getToken, isSupported } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js';

const C = window.APP_CONFIG || {};
const fbApp = initializeApp(C.firebase);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const mobileToEmail = m => `${m}@${C.emailDomain || 'expensetracker.app'}`;

/* ---------------- helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const money = n => '₹' + inr.format(Math.round((Number(n) || 0) * 100) / 100);
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const thisMonth = () => today().slice(0, 7);
const thisYear = () => today().slice(0, 4);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const parseIso = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d || 1); };
const fmtDay = iso => parseIso(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = iso => parseIso(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtMonth = ym => { const [y, m] = ym.split('-').map(Number); return `${MONTH[m - 1]} ${y}`; };
const shiftMonth = (ym, k) => { const d = parseIso(ym + '-01'); d.setMonth(d.getMonth() + k); return isoDate(d).slice(0, 7); };
const shiftDay = (iso, k) => { const d = parseIso(iso); d.setDate(d.getDate() + k); return isoDate(d); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sum = list => list.reduce((s, t) => s + (Number(t.amount) || 0), 0);

const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------------- defaults ---------------- */
const DEFAULT_CATS = {
  expense: ['Food', 'Groceries', 'Transport', 'Fuel', 'Bills & Recharge', 'Rent', 'Shopping', 'Health', 'Entertainment', 'Education', 'Other'],
  income: ['Salary', 'Business', 'Freelance', 'Interest', 'Gift', 'Other'],
};
const ICONS = {
  Food: '🍔', Groceries: '🛒', Transport: '🚌', Fuel: '⛽', 'Bills & Recharge': '🧾', Rent: '🏠', Shopping: '🛍️',
  Health: '💊', Entertainment: '🎬', Education: '📚', Other: '📦', Salary: '💼', Business: '🏪', Freelance: '💻',
  Interest: '🏦', Gift: '🎁', Travel: '✈️', Tea: '☕', Mobile: '📱', EMI: '💳', Investment: '📈',
};
const icon = c => ICONS[c] || '🏷️';
const PAY_MODES = ['UPI', 'Cash', 'Card', 'Bank'];
const PERIODS = { day: 'Date', month: 'Month', year: 'Year', range: 'Range', all: 'All' };

/* ---------------- Firestore store ---------------- */
const Store = {
  uid: null, profile: null, txs: [], status: 'idle', error: '', unsubs: [], pending: false,
  get doc() {
    const c = (this.profile && this.profile.categories) || {};
    return {
      categories: {
        expense: Array.isArray(c.expense) && c.expense.length ? c.expense : DEFAULT_CATS.expense,
        income: Array.isArray(c.income) && c.income.length ? c.income : DEFAULT_CATS.income,
      },
      transactions: this.txs,
    };
  },
  userRef() { return doc(db, 'users', this.uid); },
  txRef(id) { return doc(db, 'users', this.uid, 'transactions', id); },

  start(uid, profile) {
    this.stop();
    this.uid = uid;
    this.profile = profile;
    this.setStatus(navigator.onLine ? 'saving' : 'offline');
    this.unsubs.push(onSnapshot(this.userRef(), snap => {
      if (snap.exists()) { this.profile = snap.data(); refreshView(); }
    }, err => this.fail(err)));
    this.unsubs.push(onSnapshot(collection(db, 'users', uid, 'transactions'), { includeMetadataChanges: true }, snap => {
      this.txs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.pending = snap.metadata.hasPendingWrites;
      this.setStatus(!navigator.onLine ? 'offline' : this.pending || snap.metadata.fromCache ? 'saving' : 'synced');
      refreshView();
    }, err => this.fail(err)));
  },
  stop() {
    this.unsubs.forEach(u => u());
    this.unsubs = [];
    this.uid = null;
    this.profile = null;
    this.txs = [];
  },
  fail(err) {
    console.error(err);
    this.setStatus('error', err.code === 'permission-denied' ? 'This account is not allowed to access data' : err.message);
  },
  setStatus(s, err = '') { this.status = s; this.error = err; updateSyncBadge(); },

  // Writes are applied locally at once (offline-safe) and synced by Firestore in the background.
  saveTx(id, data) { setDoc(this.txRef(id), data, { merge: true }).catch(e => this.fail(e)); },
  deleteTx(id) { deleteDoc(this.txRef(id)).catch(e => this.fail(e)); },
  setCategories(type, list) {
    if (this.profile) this.profile = { ...this.profile, categories: { ...this.doc.categories, [type]: list } };
    refreshView();
    updateDoc(this.userRef(), { [`categories.${type}`]: list }).catch(e => this.fail(e));
  },
};

function updateSyncBadge() {
  const b = $('#syncBadge');
  if (!b) return;
  const labels = { idle: 'Loading', saving: 'Syncing…', synced: 'Synced', offline: 'Offline', error: 'Sync error' };
  b.className = 'sync ' + Store.status;
  b.textContent = labels[Store.status] || '';
  b.title = Store.error || '';
}

// Re-render without stealing focus from an input the user is typing in.
function refreshView() {
  if (!Store.uid) return;
  const active = document.activeElement;
  const typing = active && active.closest && active.closest('#view') && /INPUT|SELECT|TEXTAREA/.test(active.tagName);
  if (typing && (ui.tab === 'income' || ui.tab === 'expense')) { renderResults(ui.tab); return; }
  if (typing) return;
  render();
}

/* ---------------- UI state ---------------- */
const newFilter = () => ({ period: 'month', day: today(), month: thisMonth(), year: thisYear(), from: thisMonth() + '-01', to: today(), category: 'all', q: '' });
const ui = {
  tab: 'dashboard',
  dashMonth: thisMonth(),
  filters: { income: newFilter(), expense: newFilter() },
  catType: 'expense',
};
let sheetState = null;

function allCats(type) {
  const set = new Set(Store.doc.categories[type]);
  for (const t of Store.txs) if (t.type === type && t.category) set.add(t.category);
  return [...set];
}
function inPeriod(date, f) {
  switch (f.period) {
    case 'day': return date === f.day;
    case 'month': return date.startsWith(f.month);
    case 'year': return date.startsWith(f.year);
    case 'range': return (!f.from || date >= f.from) && (!f.to || date <= f.to);
    default: return true;
  }
}
const byNewest = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0));
function filtered(type, f) {
  const q = f.q.trim().toLowerCase();
  return Store.txs.filter(t => t.type === type && inPeriod(t.date, f) &&
    (f.category === 'all' || t.category === f.category) &&
    (!q || `${t.note || ''} ${t.category} ${t.mode || ''}`.toLowerCase().includes(q))).sort(byNewest);
}
function periodLabel(f) {
  switch (f.period) {
    case 'day': return fmtDay(f.day);
    case 'month': return fmtMonth(f.month);
    case 'year': return f.year;
    case 'range': return `${f.from ? fmtShort(f.from) : '…'} – ${f.to ? fmtShort(f.to) : '…'}`;
    default: return 'All time';
  }
}
function byCategory(list) {
  const m = new Map();
  for (const t of list) m.set(t.category, (m.get(t.category) || 0) + Number(t.amount || 0));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/* ---------------- views ---------------- */
const TITLES = { dashboard: 'Dashboard', income: 'Income', expense: 'Expense', settings: 'Settings' };

function render() {
  const v = $('#view');
  if (!v) return;
  if (ui.tab === 'dashboard') v.innerHTML = viewDashboard();
  else if (ui.tab === 'income' || ui.tab === 'expense') { v.innerHTML = viewTxnTab(ui.tab); renderResults(ui.tab); }
  else { v.innerHTML = viewSettings(); fillReminderStatus(); }
  $('#pageTitle').textContent = TITLES[ui.tab];
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  $('#fab').classList.toggle('hidden', ui.tab === 'settings');
  updateSyncBadge();
}

function txRow(t) {
  const sub = [t.mode && t.type === 'expense' ? t.mode : '', t.note || ''].filter(Boolean).join(' · ');
  const id = esc(t.id);
  return `<div class="tx ${t.type}">
    <button class="tx-main" data-action="edit" data-id="${id}" type="button">
      <span class="ic">${icon(t.category)}</span>
      <span class="mid"><b>${esc(t.category)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="amt">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</span>
    </button>
    <span class="tx-actions">
      <button class="tx-btn" data-action="edit" data-id="${id}" type="button" aria-label="Edit entry" title="Edit">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="tx-btn del" data-action="quickDelete" data-id="${id}" type="button" aria-label="Delete entry" title="Delete">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </span>
  </div>`;
}

function groupedList(list) {
  const groups = new Map();
  for (const t of list) { if (!groups.has(t.date)) groups.set(t.date, []); groups.get(t.date).push(t); }
  return [...groups.entries()].map(([d, items]) => `
    <div class="day-group">
      <div class="day-head"><span>${d === today() ? 'Today' : d === shiftDay(today(), -1) ? 'Yesterday' : fmtDay(d)}</span><span>${money(sum(items))}</span></div>
      <div class="tx-list">${items.map(txRow).join('')}</div>
    </div>`).join('');
}

function barsHtml(rows, total, green = false) {
  return `<div class="bars">${rows.map(([name, amt]) => `
    <div class="bar-row">
      <div class="top"><span>${icon(name)} ${esc(name)}</span><b>${money(amt)} <span class="muted" style="font-weight:500">· ${total ? Math.round(amt / total * 100) : 0}%</span></b></div>
      <div class="bar${green ? ' green' : ''}"><i style="width:${total ? Math.max(2, amt / total * 100) : 0}%"></i></div>
    </div>`).join('')}</div>`;
}

function viewDashboard() {
  const m = ui.dashMonth;
  const monthTx = Store.txs.filter(t => t.date.startsWith(m));
  const inc = sum(monthTx.filter(t => t.type === 'income'));
  const expList = monthTx.filter(t => t.type === 'expense');
  const exp = sum(expList);
  const bal = inc - exp;
  const todayExp = Store.txs.filter(t => t.type === 'expense' && t.date === today());
  const cats = byCategory(expList);

  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(m, i - 5));
  const series = months.map(mm => {
    const l = Store.txs.filter(t => t.date.startsWith(mm));
    return { mm, inc: sum(l.filter(t => t.type === 'income')), exp: sum(l.filter(t => t.type === 'expense')) };
  });
  const max = Math.max(1, ...series.map(s => Math.max(s.inc, s.exp)));
  const recent = [...Store.txs].sort(byNewest).slice(0, 5);
  const savePct = inc > 0 ? Math.round(bal / inc * 100) : null;

  return `
    <div class="month-nav">
      <button class="icon-btn" data-action="dashMonth" data-dir="-1" type="button" aria-label="Previous month">‹</button>
      <b>${fmtMonth(m)}</b>
      <button class="icon-btn" data-action="dashMonth" data-dir="1" type="button" aria-label="Next month">›</button>
    </div>

    <section class="card hero">
      <div class="label">Balance${savePct !== null ? ` · ${savePct}% saved` : ''}</div>
      <div class="big">${bal < 0 ? '−' : ''}${money(Math.abs(bal))}</div>
      <div class="hero-split">
        <div><span>Income</span><b>${money(inc)}</b></div>
        <div><span>Expense</span><b>${money(exp)}</b></div>
      </div>
    </section>

    <section class="card today-card">
      <div>
        <div class="muted" style="font-size:13px;font-weight:600">Today's spending</div>
        <div class="amt">${money(sum(todayExp))}</div>
        <div class="muted" style="font-size:13px">${todayExp.length} ${todayExp.length === 1 ? 'entry' : 'entries'}</div>
      </div>
      <button class="btn primary" data-action="add" data-type="expense" type="button">+ Add expense</button>
    </section>

    <section class="card">
      <h3>Expense by category <small>${fmtMonth(m)}</small></h3>
      ${cats.length ? barsHtml(cats.slice(0, 8), exp) : '<p class="muted" style="margin:0">No expenses this month.</p>'}
    </section>

    <section class="card">
      <h3>Last 6 months</h3>
      <div class="trend">
        ${series.map(s => `
          <div class="col${s.mm === m ? ' cur' : ''}" title="${fmtMonth(s.mm)}: income ${money(s.inc)}, expense ${money(s.exp)}">
            <div class="pair"><i class="inc" style="height:${s.inc / max * 100}%"></i><i class="exp" style="height:${s.exp / max * 100}%"></i></div>
            <span>${MON[Number(s.mm.slice(5)) - 1]}</span>
          </div>`).join('')}
      </div>
      <div class="legend"><span><i style="background:var(--green)"></i>Income</span><span><i style="background:var(--orange)"></i>Expense</span></div>
    </section>

    <section>
      <h3 style="margin:18px 4px 10px;font-size:15px">Recent</h3>
      ${recent.length ? `<div class="tx-list">${recent.map(txRow).join('')}</div>`
        : `<div class="empty"><div class="em">🧾</div>No entries yet. Tap <b>+</b> to add your first one.</div>`}
    </section>`;
}

function periodInput(type, f) {
  const step = `data-action="stepPeriod" data-type="${type}"`;
  switch (f.period) {
    case 'day':
      return `<button class="icon-btn" ${step} data-dir="-1" type="button">‹</button>
        <input type="date" data-filter="day" data-type="${type}" value="${f.day}">
        <button class="icon-btn" ${step} data-dir="1" type="button">›</button>`;
    case 'month':
      return `<button class="icon-btn" ${step} data-dir="-1" type="button">‹</button>
        <input type="month" data-filter="month" data-type="${type}" value="${f.month}">
        <button class="icon-btn" ${step} data-dir="1" type="button">›</button>`;
    case 'year': {
      const years = new Set([thisYear(), f.year, ...Store.txs.map(t => t.date.slice(0, 4))]);
      return `<button class="icon-btn" ${step} data-dir="-1" type="button">‹</button>
        <select data-filter="year" data-type="${type}">${[...years].sort().reverse().map(y => `<option ${y === f.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <button class="icon-btn" ${step} data-dir="1" type="button">›</button>`;
    }
    case 'range':
      return `<input type="date" data-filter="from" data-type="${type}" value="${f.from}" aria-label="From">
        <span class="range-sep">to</span>
        <input type="date" data-filter="to" data-type="${type}" value="${f.to}" aria-label="To">`;
    default:
      return '<div class="all-time">Showing all entries</div>';
  }
}

function viewTxnTab(type) {
  const f = ui.filters[type];
  return `
    <section class="card">
      <div class="seg">${Object.entries(PERIODS).map(([p, l]) => `<button data-action="period" data-type="${type}" data-p="${p}" class="${f.period === p ? 'on' : ''}" type="button">${l}</button>`).join('')}</div>
      <div class="filter-row">${periodInput(type, f)}</div>
      <div class="filter-row two">
        <select data-filter="category" data-type="${type}" aria-label="Category">
          <option value="all">All categories</option>
          ${allCats(type).map(c => `<option value="${esc(c)}" ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <input type="search" data-filter="q" data-type="${type}" value="${esc(f.q)}" placeholder="Search note…" aria-label="Search">
      </div>
    </section>
    <div id="results"></div>`;
}

function renderResults(type) {
  const box = $('#results');
  if (!box) return;
  const f = ui.filters[type];
  const list = filtered(type, f);
  const total = sum(list);
  const cats = byCategory(list);
  const days = new Set(list.map(t => t.date)).size;
  box.innerHTML = `
    <section class="card">
      <div class="summary">
        <div>
          <div class="label">Total ${type} · ${esc(periodLabel(f))}</div>
          <div class="big ${type === 'income' ? 'inc' : 'exp'}">${money(total)}</div>
        </div>
        <div class="count">${list.length} ${list.length === 1 ? 'entry' : 'entries'}${type === 'expense' && days > 1 ? `<br>avg ${money(Math.round(total / days))}/day` : ''}</div>
      </div>
      ${f.category === 'all' && cats.length > 1 ? `<div style="margin-top:16px">${barsHtml(cats.slice(0, 6), total, type === 'income')}</div>` : ''}
    </section>
    ${list.length ? groupedList(list) : `<div class="empty"><div class="em">${type === 'income' ? '💰' : '🧾'}</div>No ${type} found for this filter.</div>`}`;
}

function viewSettings() {
  const t = ui.catType;
  const cats = Store.doc.categories[t];
  const p = Store.profile || {};
  const syncText = { synced: 'Saved to cloud', saving: 'Syncing…', offline: 'Offline: saved on this phone, will sync later', error: 'Sync error', idle: 'Loading' }[Store.status];
  return `
    <section class="card">
      <h3>Account</h3>
      <div class="set-row"><div>${esc(p.name || 'You')}<small>Mobile ${esc(p.mobile || '')}</small></div></div>
    </section>

    <section class="card">
      <h3>Reminders</h3>
      <div class="muted" style="font-size:14px">A daily notification to add today's payments:</div>
      <div class="times"><span>6:35 PM</span><span>10:00 PM</span><span>11:00 PM</span></div>
      <div class="set-row"><div>Status on this phone</div><span id="remStatus" class="pill">…</span></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary" data-action="enableReminders" type="button">Turn on</button>
        <button class="btn" data-action="testNotif" type="button">Test</button>
      </div>
      <p class="note">Each person gets reminders with their own totals.</p>
    </section>

    <section class="card">
      <h3>Categories</h3>
      <div class="seg two">
        <button data-action="catType" data-t="expense" class="${t === 'expense' ? 'on' : ''}" type="button">Expense</button>
        <button data-action="catType" data-t="income" class="${t === 'income' ? 'on' : ''}" type="button">Income</button>
      </div>
      <div class="cat-list">
        ${cats.map((c, i) => `<div class="cat-item"><span>${icon(c)}</span><span class="n">${esc(c)}</span>
          <button class="x" data-action="delCat" data-i="${i}" type="button" aria-label="Delete ${esc(c)}">✕</button></div>`).join('')}
      </div>
      <form class="add-row" data-form="addCat">
        <input name="cat" maxlength="30" placeholder="New ${t} category" required>
        <button class="btn primary" type="submit">Add</button>
      </form>
    </section>

    <section class="card">
      <h3>Data &amp; sync</h3>
      <div class="set-row"><div>Storage<small>Private cloud (Firebase) · only you can see it</small></div></div>
      <div class="set-row"><div>Status<small>${esc(syncText)}</small></div></div>
      <div class="set-row"><div>Entries<small>${Store.txs.length} total</small></div><button class="btn ghost" data-action="exportCsv" type="button">Export CSV</button></div>
      ${Store.error ? `<p class="error">${esc(Store.error)}</p>` : ''}
    </section>

    <button class="btn danger block" data-action="logout" type="button">Logout</button>
    <p class="note" style="text-align:center">Expense Tracker · v2.0</p>`;
}

/* ---------------- add / edit sheet ---------------- */
function openSheet(type = 'expense', tx = null) {
  sheetState = {
    id: tx ? tx.id : null,
    type: tx ? tx.type : type,
    amount: tx ? String(tx.amount) : '',
    category: tx ? tx.category : '',
    date: tx ? tx.date : today(),
    note: tx ? tx.note || '' : '',
    mode: tx ? tx.mode || 'UPI' : 'UPI',
    addingCat: false,
  };
  renderSheet();
  $('#sheetWrap').classList.remove('hidden');
  if (!tx) setTimeout(() => $('#fAmount') && $('#fAmount').focus(), 250);
}
function closeSheet() { $('#sheetWrap').classList.add('hidden'); sheetState = null; }
function readSheet() {
  if (!sheetState) return;
  const a = $('#fAmount'); if (a) sheetState.amount = a.value;
  const d = $('#fDate'); if (d) sheetState.date = d.value;
  const n = $('#fNote'); if (n) sheetState.note = n.value;
}
function renderSheet() {
  const s = sheetState;
  const cats = allCats(s.type);
  $('#sheet').innerHTML = `
    <div class="grab"></div>
    <h2>${s.id ? 'Edit' : 'Add'} entry <button class="icon-btn" data-action="closeSheet" type="button" aria-label="Close">✕</button></h2>
    <div class="seg two">
      <button data-action="sheetType" data-t="expense" class="${s.type === 'expense' ? 'on' : ''}" type="button">Expense</button>
      <button data-action="sheetType" data-t="income" class="${s.type === 'income' ? 'on' : ''}" type="button">Income</button>
    </div>
    <div class="amount-input"><span>₹</span><input id="fAmount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0" value="${esc(s.amount)}"></div>
    <p class="label-sm">Category</p>
    <div class="chips">
      ${cats.map(c => `<button class="chip${c === s.category ? ' on' : ''}" data-action="pickCat" data-c="${esc(c)}" type="button">${icon(c)} ${esc(c)}</button>`).join('')}
      <button class="chip add" data-action="newCat" type="button">+ New</button>
    </div>
    ${s.addingCat ? `<div class="new-cat"><input id="fNewCat" maxlength="30" placeholder="Category name"><button class="btn primary" data-action="saveNewCat" type="button">Add</button></div>` : ''}
    ${s.type === 'expense' ? `<p class="label-sm">Paid by</p>
      <div class="chips">${PAY_MODES.map(m => `<button class="chip${m === s.mode ? ' on' : ''}" data-action="pickMode" data-m="${m}" type="button">${m}</button>`).join('')}</div>` : ''}
    <label class="field"><span>Date</span><input id="fDate" type="date" value="${s.date}" max="${shiftDay(today(), 366)}"></label>
    <label class="field"><span>Note (optional)</span><input id="fNote" maxlength="120" placeholder="e.g. Lunch with friends" value="${esc(s.note)}"></label>
    <p id="fErr" class="error"></p>
    <div class="sheet-actions">
      ${s.id ? '<button class="btn danger" data-action="deleteTx" type="button">Delete</button>' : ''}
      <button class="btn primary" data-action="saveTx" type="button">${s.id ? 'Save changes' : 'Save'}</button>
    </div>`;
  if (s.addingCat) setTimeout(() => $('#fNewCat') && $('#fNewCat').focus(), 50);
}
function addCategory(type, name) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const existing = Store.doc.categories[type].find(c => c.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  Store.setCategories(type, [...Store.doc.categories[type], name]);
  return name;
}


/* ---------------- reminders (Firebase Cloud Messaging) ---------------- */
const FCM_KEY = 'et_fcm_token';
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function tokenId(token) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function reminderState() {
  if (!('serviceWorker' in navigator) || !('Notification' in window) || !(await isSupported().catch(() => false))) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && ls.get(FCM_KEY) ? 'on' : 'off';
}
async function fillReminderStatus() {
  const el = $('#remStatus');
  if (!el) return;
  const st = await reminderState().catch(() => 'off');
  const map = { on: ['Enabled', 'pill on'], off: ['Off', 'pill'], denied: ['Blocked in browser', 'pill bad'], unsupported: ['Not supported', 'pill bad'] };
  [el.textContent, el.className] = map[st];
}
async function enableReminders(btn) {
  if (!(await isSupported().catch(() => false))) return toast('This browser does not support notifications');
  btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notification permission was not given'); return; }
    const reg = await navigator.serviceWorker.ready;
    // A push subscription made with an older key blocks Firebase from subscribing: remove it.
    const old = await reg.pushManager.getSubscription();
    if (old && old.options && old.options.applicationServerKey && b64url(old.options.applicationServerKey) !== C.vapidKey) await old.unsubscribe();
    const token = await getToken(getMessaging(fbApp), { vapidKey: C.vapidKey, serviceWorkerRegistration: reg });
    if (!token) throw new Error('No push token received');
    await setDoc(doc(db, 'users', Store.uid, 'devices', await tokenId(token)), {
      token, device: navigator.userAgent.slice(0, 140), updatedAt: Date.now(),
    });
    ls.set(FCM_KEY, token);
    toast('Reminders enabled ✓');
  } catch (e) {
    console.error(e);
    toast('Could not enable: ' + e.message, 3500);
  } finally {
    btn.disabled = false;
    fillReminderStatus();
  }
}
async function testNotif() {
  if (!('Notification' in window)) return toast('Notifications not supported');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notification permission was not given');
  const reg = await navigator.serviceWorker.ready;
  reg.showNotification('💸 Expense reminder', {
    body: "Test: tap to add today's payments.", icon: 'icons/icon-192.png', badge: 'icons/badge-96.png',
    tag: 'test', data: { url: './#add' },
  });
}

function exportCsv() {
  const rows = [['Date', 'Type', 'Category', 'Amount', 'Paid by', 'Note']];
  for (const t of [...Store.txs].sort(byNewest)) rows.push([t.date, t.type, t.category, t.amount, t.type === 'expense' ? t.mode || '' : '', t.note || '']);
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `expenses-${today()}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------------- actions ---------------- */
const actions = {
  add(el) { openSheet(el.dataset.type || (ui.tab === 'income' ? 'income' : 'expense')); },
  edit(el) { const t = Store.txs.find(x => x.id === el.dataset.id); if (t) openSheet(t.type, t); },
  closeSheet,
  dashMonth(el) { ui.dashMonth = shiftMonth(ui.dashMonth, Number(el.dataset.dir)); render(); },
  period(el) { ui.filters[el.dataset.type].period = el.dataset.p; render(); },
  stepPeriod(el) {
    const f = ui.filters[el.dataset.type];
    const k = Number(el.dataset.dir);
    if (f.period === 'day') f.day = shiftDay(f.day || today(), k);
    if (f.period === 'month') f.month = shiftMonth(f.month || thisMonth(), k);
    if (f.period === 'year') f.year = String(Number(f.year || thisYear()) + k);
    render();
  },
  catType(el) { ui.catType = el.dataset.t; render(); },
  delCat(el) {
    const t = ui.catType;
    const name = Store.doc.categories[t][Number(el.dataset.i)];
    if (Store.doc.categories[t].length <= 1) return toast('Keep at least one category');
    if (!confirm(`Delete category "${name}"?\nOld entries keep this category name.`)) return;
    Store.setCategories(t, Store.doc.categories[t].filter(c => c !== name));
  },
  sheetType(el) { readSheet(); if (sheetState.type !== el.dataset.t) { sheetState.type = el.dataset.t; sheetState.category = ''; } renderSheet(); },
  pickCat(el) { readSheet(); sheetState.category = el.dataset.c; $$('#sheet [data-action="pickCat"]').forEach(b => b.classList.toggle('on', b === el)); },
  pickMode(el) { sheetState.mode = el.dataset.m; $$('#sheet [data-action="pickMode"]').forEach(b => b.classList.toggle('on', b === el)); },
  newCat() { readSheet(); sheetState.addingCat = true; renderSheet(); },
  saveNewCat() {
    readSheet();
    const name = addCategory(sheetState.type, $('#fNewCat').value);
    if (!name) return;
    sheetState.category = name;
    sheetState.addingCat = false;
    renderSheet();
  },
  saveTx() {
    readSheet();
    const s = sheetState;
    const amount = Math.round(parseFloat(s.amount) * 100) / 100;
    const err = $('#fErr');
    if (!(amount > 0)) { err.textContent = 'Enter an amount greater than 0'; $('#fAmount').focus(); return; }
    if (!s.category) { err.textContent = 'Choose a category'; return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date)) { err.textContent = 'Choose a date'; return; }
    const data = { type: s.type, amount, category: s.category, date: s.date, note: s.note.trim() };
    if (s.type === 'expense') data.mode = s.mode; else data.mode = '';
    const now = Date.now();
    const id = s.id;
    closeSheet();
    if (id) Store.saveTx(id, { ...data, updatedAt: now });
    else Store.saveTx(uid(), { ...data, createdAt: now, updatedAt: now });
    toast(id ? 'Updated ✓' : `${data.type === 'income' ? 'Income' : 'Expense'} saved ✓`);
  },
  quickDelete(el) {
    const t = Store.txs.find(x => x.id === el.dataset.id);
    if (!t) return;
    if (!confirm(`Delete this entry?\n${t.category} · ${money(t.amount)} · ${fmtShort(t.date)}`)) return;
    Store.deleteTx(t.id);
    toast('Deleted');
  },
  deleteTx() {
    const id = sheetState.id;
    if (!confirm('Delete this entry?')) return;
    closeSheet();
    Store.deleteTx(id);
    toast('Deleted');
  },
  syncNow() {
    const msg = { synced: 'All changes are saved to the cloud', saving: 'Syncing…', offline: 'Offline: changes will sync when you are online' }[Store.status];
    toast(Store.status === 'error' ? Store.error || 'Sync error' : msg || 'Loading…', 3000);
  },
  enableReminders(el) { enableReminders(el); },
  testNotif() { testNotif().catch(e => toast(e.message)); },
  exportCsv,
  async logout() {
    const warn = Store.pending ? '\nSome changes are not synced yet and will be lost.' : '';
    if (!confirm('Logout from this phone?' + warn)) return;
    ls.del(FCM_KEY);
    Store.stop();
    await signOut(auth);
    location.reload();
  },
};

document.addEventListener('click', e => {
  const tab = e.target.closest('.tabbar button[data-tab]');
  if (tab) { ui.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
});

function onFilter(e) {
  const el = e.target.closest('[data-filter]');
  if (!el) return;
  const type = el.dataset.type;
  const f = ui.filters[type];
  f[el.dataset.filter] = el.value;
  renderResults(type);
}
document.addEventListener('input', e => { if (e.target.matches('[data-filter="q"]')) onFilter(e); });
document.addEventListener('change', e => { if (e.target.matches('[data-filter]:not([data-filter="q"])')) onFilter(e); });

document.addEventListener('submit', e => {
  const form = e.target.closest('[data-form="addCat"]');
  if (!form) return;
  e.preventDefault();
  const name = addCategory(ui.catType, form.cat.value);
  if (name) toast(`Added "${name}"`);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sheetState) closeSheet();
  if (e.key === 'Enter' && e.target.id === 'fNewCat') { e.preventDefault(); actions.saveNewCat(); }
});


/* ---------------- login, sign-up & boot ---------------- */
let authMode = 'login';
let signingUp = false;

function setAuthMode(mode) {
  authMode = mode;
  $('#modeLogin').classList.toggle('on', mode === 'login');
  $('#modeSignup').classList.toggle('on', mode === 'signup');
  $$('.signup-only').forEach(el => el.classList.toggle('hidden', mode !== 'signup'));
  $('#loginBtn').textContent = mode === 'signup' ? 'Create account' : 'Login';
  $('#loginPass').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#loginError').textContent = '';
}
$('#modeLogin').addEventListener('click', () => setAuthMode('login'));
$('#modeSignup').addEventListener('click', () => setAuthMode('signup'));

function showLogin(msg = '') {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#loginError').textContent = msg;
}

$('#pwToggle').addEventListener('click', () => {
  const p = $('#loginPass');
  const show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  $('#pwToggle').textContent = show ? 'Hide' : 'Show';
});

function authMessage(e) {
  const code = (e && e.code) || '';
  if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(code)) return 'Wrong mobile number or password';
  if (code.includes('email-already-in-use')) return 'This mobile number already has an account. Please login.';
  if (code.includes('weak-password')) return 'Password must be at least 6 characters';
  if (code.includes('too-many-requests')) return 'Too many tries. Please wait a few minutes.';
  if (code.includes('network-request-failed')) return 'No internet connection';
  if (code === 'permission-denied') return 'Invite code is not correct';
  return (e && e.message) || 'Something went wrong';
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#loginError');
  const btn = $('#loginBtn');
  err.textContent = '';
  const mobile = $('#loginMobile').value.replace(/\D/g, '');
  const pass = $('#loginPass').value;
  if (mobile.length !== 10) { err.textContent = 'Enter a valid 10 digit mobile number'; return; }
  if (pass.length < 6) { err.textContent = 'Password must be at least 6 characters'; return; }
  btn.disabled = true;
  btn.textContent = authMode === 'signup' ? 'Creating…' : 'Checking…';
  try {
    if (authMode === 'signup') {
      const name = $('#loginName').value.trim();
      const invite = $('#loginInvite').value.trim().toUpperCase();
      if (!name) throw Object.assign(new Error('Enter your name'), { code: 'x' });
      if (!invite) throw Object.assign(new Error('Enter the invite code'), { code: 'x' });
      signingUp = true;
      const cred = await createUserWithEmailAndPassword(auth, mobileToEmail(mobile), pass);
      const profile = { name, mobile, invite, categories: structuredClone(DEFAULT_CATS), createdAt: Date.now() };
      try {
        await setDoc(doc(db, 'users', cred.user.uid), profile);
      } catch (ex) {
        await cred.user.delete().catch(() => signOut(auth)); // wrong invite: remove the half-made account
        throw ex;
      }
      signingUp = false;
      enterApp(cred.user, profile);
    } else {
      await signInWithEmailAndPassword(auth, mobileToEmail(mobile), pass);
    }
    $('#loginPass').value = '';
  } catch (ex) {
    signingUp = false;
    console.error(ex);
    err.textContent = authMessage(ex);
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'signup' ? 'Create account' : 'Login';
  }
});

function enterApp(user, profile) {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  Store.start(user.uid, profile);
  render();
  handleHash();
}

onAuthStateChanged(auth, async user => {
  if (signingUp) return; // the sign-up handler finishes the setup itself
  if (!user) { Store.stop(); showLogin(); return; }
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (!snap.exists()) {
      await signOut(auth);
      showLogin('This account is not set up. Please sign up with an invite code.');
      return;
    }
    enterApp(user, snap.data());
  } catch (e) {
    // Offline with nothing cached yet: still open the app; data appears once online.
    console.error(e);
    enterApp(user, null);
  }
});

function handleHash() {
  if (location.hash === '#add') {
    history.replaceState(null, '', location.pathname + location.search);
    if (Store.uid) openSheet('expense');
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(reg => reg.update())
    .catch(e => console.warn('SW registration failed', e));
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'open-add' && Store.uid) { closeSheet(); openSheet('expense'); }
  });
}
window.addEventListener('hashchange', handleHash);
window.addEventListener('online', () => Store.uid && Store.setStatus(Store.pending ? 'saving' : 'synced'));
window.addEventListener('offline', () => Store.uid && Store.setStatus('offline'));
