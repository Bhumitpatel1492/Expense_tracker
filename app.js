/* Expense Tracker — multi-user PWA on Firebase.
 * Login: Firebase Auth (mobile number used as the username, password).
 * Data: Firestore, users/{uid} (profile + categories), books/{id} (shared, with memberUids) and books/{id}/transactions/{id}.
 * Security rules (firebase/firestore.rules) let each user read and write only their own data.
 * Reminders: Firebase Cloud Messaging tokens in users/{uid}/devices, sent by a GitHub Actions job. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch,
  query, where, arrayUnion, arrayRemove, deleteField,
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
// Books live at books/{bookId} with a member list, so a book can be shared:
//   books/{bookId}: { name, ownerUid, ownerName, memberUids: [uid…], members: { uid: { name, mobile, role } } }
//   books/{bookId}/transactions/{id}: { type, amount, category, party, mode, note, date, createdBy, createdByName, … }
// mobiles/{mobile}: { uid, name } lets a book owner add a member by mobile number.
const Store = {
  uid: null, profile: null, books: [], bookTx: {}, bookId: null,
  status: 'idle', error: '', unsubs: [], txUnsubs: new Map(), pending: false, ready: false,
  get allTxs() { return Object.values(this.bookTx).flat(); },
  get txs() { return this.bookTx[this.bookId] || []; },
  get book() { return this.books.find(b => b.id === this.bookId) || { id: this.bookId, name: 'Book', memberUids: [this.uid], ownerUid: this.uid }; },
  isOwner(b = this.book) { return b.ownerUid === this.uid; },
  isShared(b = this.book) { return (b.memberUids || []).length > 1; },
  me() { const p = this.profile || {}; return { name: p.name || 'Me', mobile: p.mobile || '' }; },
  setBook(id) {
    this.bookId = id;
    ls.set(`et_book_${this.uid}`, id);
    refreshView();
  },
  bookRef(id) { return doc(db, 'books', id); },
  txRef(id, bookId = this.bookId) { return doc(db, 'books', bookId, 'transactions', id); },
  userRef() { return doc(db, 'users', this.uid); },

  newBookData(name) {
    const me = this.me();
    return {
      name, ownerUid: this.uid, ownerName: me.name, memberUids: [this.uid],
      members: { [this.uid]: { name: me.name, mobile: me.mobile, role: 'owner' } },
      createdAt: Date.now(), updatedAt: Date.now(),
    };
  },
  createBook(name, id = uid()) {
    setDoc(this.bookRef(id), this.newBookData(name)).catch(e => this.fail(e));
    return id;
  },
  renameBook(id, name) { updateDoc(this.bookRef(id), { name, updatedAt: Date.now() }).catch(e => this.fail(e)); },
  deleteBook(id) {
    // Owner only: delete the book and all its entries (batches of max 500 writes).
    const refs = (this.bookTx[id] || []).map(t => this.txRef(t.id, id));
    refs.push(this.bookRef(id));
    for (let i = 0; i < refs.length; i += 450) {
      const batch = writeBatch(db);
      refs.slice(i, i + 450).forEach(r => batch.delete(r));
      batch.commit().catch(e => this.fail(e));
    }
  },
  async addMember(bookId, mobile) {
    const snap = await getDoc(doc(db, 'mobiles', mobile));
    if (!snap.exists()) throw new Error('No user with this mobile number. Ask them to sign up in the app first.');
    const { uid: memberUid, name } = snap.data();
    await updateDoc(this.bookRef(bookId), {
      memberUids: arrayUnion(memberUid),
      [`members.${memberUid}`]: { name: name || mobile, mobile, role: 'member' },
      updatedAt: Date.now(),
    });
    return name || mobile;
  },
  removeMember(bookId, memberUid) {
    return updateDoc(this.bookRef(bookId), { memberUids: arrayRemove(memberUid), [`members.${memberUid}`]: deleteField(), updatedAt: Date.now() });
  },

  async start(uid, profile) {
    this.stop();
    this.uid = uid;
    this.profile = profile;
    this.bookId = ls.get(`et_book_${uid}`);
    this.setStatus(navigator.onLine ? 'saving' : 'offline');
    this.unsubs.push(onSnapshot(this.userRef(), snap => {
      if (snap.exists()) { this.profile = snap.data(); refreshView(); }
    }, err => this.fail(err)));
    await this.ensureMobileLookup().catch(e => console.warn('mobile lookup', e));
    await this.migrateOldData().catch(e => console.warn('migration', e));
    if (this.uid !== uid) return; // logged out meanwhile
    this.unsubs.push(onSnapshot(query(collection(db, 'books'), where('memberUids', 'array-contains', uid)), snap => {
      this.books = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.name).localeCompare(b.name));
      if (!this.books.length && !snap.metadata.fromCache) {
        // First book (fixed id, so two phones can't create two).
        setDoc(this.bookRef(`${uid}-personal`), { ...this.newBookData('Personal'), createdAt: 0 }).catch(e => this.fail(e));
      }
      if (this.books.length && !this.books.some(b => b.id === this.bookId)) this.bookId = this.books[0].id;
      this.syncTxListeners();
      this.ready = true;
      refreshView();
      // Keep an open Members screen in step with the member list.
      if (sheetState && sheetState.kind === 'share') {
        if (this.books.some(b => b.id === sheetState.id)) {
          const typed = $('#fMemberMobile') ? $('#fMemberMobile').value : '';
          const msg = $('#fErr') ? $('#fErr').textContent : '';
          openShareSheet(sheetState.id);
          if ($('#fMemberMobile')) $('#fMemberMobile').value = typed;
          if ($('#fErr')) $('#fErr').textContent = msg;
        } else closeSheet();
      }
    }, err => this.fail(err)));
  },
  // One live listener per book the user can see.
  syncTxListeners() {
    const ids = new Set(this.books.map(b => b.id));
    for (const [id, un] of this.txUnsubs) if (!ids.has(id)) { un(); this.txUnsubs.delete(id); delete this.bookTx[id]; }
    for (const id of ids) {
      if (this.txUnsubs.has(id)) continue;
      this.txUnsubs.set(id, onSnapshot(collection(db, 'books', id, 'transactions'), { includeMetadataChanges: true }, snap => {
        this.bookTx[id] = snap.docs.map(d => ({ id: d.id, bookId: id, ...d.data() }));
        this.pending = snap.metadata.hasPendingWrites;
        this.setStatus(!navigator.onLine ? 'offline' : this.pending || snap.metadata.fromCache ? 'saving' : 'synced');
        refreshView();
      }, err => this.fail(err)));
    }
  },
  async ensureMobileLookup() {
    const p = this.profile;
    if (!p || !p.mobile) return;
    const ref = doc(db, 'mobiles', p.mobile);
    const snap = await getDoc(ref);
    if (!snap.exists() || snap.data().uid !== this.uid || snap.data().name !== p.name) await setDoc(ref, { uid: this.uid, name: p.name || '' });
  },
  // Version 2 kept books and entries under users/{uid}; copy them once into shareable books.
  async migrateOldData() {
    if (!this.profile || this.profile.booksV3) return;
    const [oldBooks, oldTxs] = await Promise.all([
      getDocs(collection(db, 'users', this.uid, 'books')),
      getDocs(collection(db, 'users', this.uid, 'transactions')),
    ]);
    const me = this.me();
    const books = oldBooks.docs.map(d => ({ id: d.id, ...d.data() }));
    if (oldTxs.size && !books.some(b => b.id === 'personal')) books.push({ id: 'personal', name: 'Personal', createdAt: 0 });
    const writes = [];
    for (const b of books) {
      const newId = b.id === 'personal' ? `${this.uid}-personal` : `${this.uid}-${b.id}`;
      writes.push([this.bookRef(newId), { ...this.newBookData(b.name || 'Book'), createdAt: b.createdAt || 0 }]);
      for (const t of oldTxs.docs) {
        const data = t.data();
        if ((data.bookId || 'personal') !== b.id) continue;
        const { bookId, ...rest } = data;
        writes.push([this.txRef(t.id, newId), { ...rest, createdBy: this.uid, createdByName: me.name }]);
      }
    }
    // Books first (the entries' security rule checks the book's member list), then entries.
    const bookWrites = writes.filter(([r]) => r.path.split('/').length === 2);
    const txWrites = writes.filter(([r]) => r.path.split('/').length > 2);
    for (const group of [bookWrites, txWrites]) {
      for (let i = 0; i < group.length; i += 450) {
        const batch = writeBatch(db);
        group.slice(i, i + 450).forEach(([r, v]) => batch.set(r, v));
        await batch.commit();
      }
    }
    await updateDoc(this.userRef(), { booksV3: true });
    this.profile = { ...this.profile, booksV3: true };
  },
  stop() {
    this.unsubs.forEach(u => u());
    this.txUnsubs.forEach(u => u());
    this.unsubs = [];
    this.txUnsubs = new Map();
    this.uid = null;
    this.profile = null;
    this.books = [];
    this.bookTx = {};
    this.ready = false;
  },
  fail(err) {
    console.error(err);
    this.setStatus('error', err.code === 'permission-denied' ? 'You do not have access to this data' : err.message);
  },
  setStatus(s, err = '') { this.status = s; this.error = err; updateSyncBadge(); },
  get doc() {
    const c = (this.profile && this.profile.categories) || {};
    return {
      categories: {
        expense: Array.isArray(c.expense) && c.expense.length ? c.expense : DEFAULT_CATS.expense,
        income: Array.isArray(c.income) && c.income.length ? c.income : DEFAULT_CATS.income,
      },
      transactions: this.txs, // current book only
    };
  },

  // Writes are applied locally at once (offline-safe) and synced by Firestore in the background.
  saveTx(id, data) { setDoc(this.txRef(id), data, { merge: true }).catch(e => this.fail(e)); },
  deleteTx(id) { deleteDoc(this.txRef(id)).catch(e => this.fail(e)); },
  setCategories(type, list) {
    if (this.profile) this.profile = { ...this.profile, categories: { ...this.doc.categories, [type]: list } };
    refreshView();
    updateDoc(this.userRef(), { [`categories.${type}`]: list }).catch(e => this.fail(e));
  },
};

// Running balance (#1): balance after each entry, oldest first, per book.
const balanceCache = new WeakMap();
function runningBalances(list) {
  if (balanceCache.has(list)) return balanceCache.get(list);
  const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
  const map = new Map();
  let bal = 0;
  for (const t of sorted) { bal += (t.type === 'income' ? 1 : -1) * Number(t.amount || 0); map.set(t.id, bal); }
  balanceCache.set(list, map);
  return map;
}
function bookTotals(id) {
  const list = Store.bookTx[id] || [];
  const inc = sum(list.filter(t => t.type === 'income'));
  const exp = sum(list.filter(t => t.type === 'expense'));
  const last = list.reduce((m, t) => Math.max(m, t.updatedAt || t.createdAt || 0), 0);
  return { inc, exp, bal: inc - exp, count: list.length, last };
}
const signed = n => `${n < 0 ? '−' : ''}${money(Math.abs(n))}`;

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
  tab: 'books',
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
    (!q || `${t.note || ''} ${t.category} ${t.mode || ''} ${t.party || ''} ${t.createdByName || ''}`.toLowerCase().includes(q))).sort(byNewest);
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
const TITLES = { books: 'My Books', dashboard: 'Dashboard', income: 'Income', expense: 'Expense', settings: 'Settings' };

// Book switcher shown above Dashboard / Income / Expense (like CashBook's books).
function bookBar() {
  const books = Store.books.length ? Store.books : [Store.book];
  return `<div class="bookbar" role="tablist" aria-label="Books">
    ${books.map(b => `<button class="book-chip${b.id === Store.bookId ? ' on' : ''}" data-action="pickBook" data-id="${esc(b.id)}" type="button">${Store.isShared(b) ? '👥' : '📒'} ${esc(b.name)}</button>`).join('')}
    <button class="book-chip add" data-action="newBook" type="button">+ New book</button>
  </div>`;
}

// Home screen (#2): every book with its balance, like CashBook's book list.
function timeAgo(ms) {
  if (!ms || ms < 1e12) return ''; // unknown time
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'Updated just now';
  if (s < 3600) return `Updated ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `Updated ${Math.floor(s / 3600)} h ago`;
  return `Updated ${new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
function viewBooks() {
  if (!Store.ready) return '<div class="empty"><div class="em">📒</div>Loading your books…</div>';
  const all = Store.books.map(b => ({ b, t: bookTotals(b.id) }));
  const inc = all.reduce((s, x) => s + x.t.inc, 0);
  const exp = all.reduce((s, x) => s + x.t.exp, 0);
  return `
    <section class="card hero">
      <div class="label">All books · Net balance</div>
      <div class="big">${signed(inc - exp)}</div>
      <div class="hero-split">
        <div><span>Total in</span><b>${money(inc)}</b></div>
        <div><span>Total out</span><b>${money(exp)}</b></div>
      </div>
    </section>
    <h3 class="section-title">Your books <small>${all.length}</small></h3>
    <div class="book-list">
      ${all.map(({ b, t }) => {
        const shared = Store.isShared(b);
        const who = !Store.isOwner(b) ? `Shared by ${esc(b.ownerName || 'owner')}` : shared ? `Shared with ${(b.memberUids || []).length - 1}` : '';
        const when = t.count ? timeAgo(t.last) : 'No entries yet';
        const line = [who, who ? when.replace('Updated ', '') : when].filter(Boolean).join(' · ');
        return `<button class="book-card${b.id === Store.bookId ? ' on' : ''}" data-action="openBook" data-id="${esc(b.id)}" type="button">
          <span class="book-ic">${shared ? '👥' : '📒'}</span>
          <span class="book-mid"><b>${esc(b.name)}</b>${line ? `<small>${line}</small>` : ''}
            <small class="book-io"><span class="in">In ${money(t.inc)}</span> · <span class="out">Out ${money(t.exp)}</span></small></span>
          <span class="book-bal ${t.bal < 0 ? 'neg' : 'pos'}">${signed(t.bal)}<small>${t.count} ${t.count === 1 ? 'entry' : 'entries'}</small></span>
        </button>`;
      }).join('')}
    </div>
    <button class="btn ghost block" style="margin-top:4px" data-action="newBook" type="button">+ Add new book</button>`;
}

function render() {
  const v = $('#view');
  if (!v) return;
  if (ui.tab === 'books') v.innerHTML = viewBooks();
  else if (ui.tab === 'dashboard') v.innerHTML = bookBar() + viewDashboard();
  else if (ui.tab === 'income' || ui.tab === 'expense') { v.innerHTML = bookBar() + viewTxnTab(ui.tab); renderResults(ui.tab); }
  else { v.innerHTML = viewSettings(); fillReminderStatus(); }
  $('#pageTitle').textContent = TITLES[ui.tab];
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  $('#fab').classList.toggle('hidden', ui.tab === 'settings');
  updateSyncBadge();
}

function txRow(t) {
  const party = t.party ? `${t.type === 'income' ? 'From' : 'To'} ${t.party}` : '';
  const by = Store.isShared() && t.createdBy && t.createdBy !== Store.uid ? `by ${t.createdByName || 'member'}` : '';
  const sub = [party, t.mode && t.type === 'expense' ? t.mode : '', t.note || '', by].filter(Boolean).join(' · ');
  const id = esc(t.id);
  const bal = runningBalances(Store.txs).get(t.id);
  return `<div class="tx ${t.type}">
    <button class="tx-main" data-action="edit" data-id="${id}" type="button">
      <span class="ic">${icon(t.category)}</span>
      <span class="mid"><b>${esc(t.category)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="amt">${t.type === 'income' ? '+' : '−'}${money(t.amount)}${bal !== undefined ? `<small class="run-bal">Bal ${signed(bal)}</small>` : ''}</span>
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
      <button class="icon-btn" data-action="dashMonth" data-dir="1" type="button" aria-label="Next month" ${m >= thisMonth() ? "disabled" : ""}>›</button>
    </div>

    <section class="card hero">
      <div class="label">${esc(Store.book.name)} · Balance${savePct !== null ? ` · ${savePct}% saved` : ''}</div>
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

    <section class="card today-card">
      <div><b>📄 Reports</b><div class="muted" style="font-size:13px">Download this book as PDF or Excel</div></div>
      <button class="btn ghost" data-action="openReport" type="button">Download</button>
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

// Future dates / months / years are never allowed: pickers stop at today and "›" is disabled there.
const FILTER_MAX = { day: () => today(), month: () => thisMonth(), year: () => thisYear(), from: () => today(), to: () => today() };

function periodInput(type, f) {
  const step = `data-action="stepPeriod" data-type="${type}"`;
  const next = atMax => `<button class="icon-btn" ${step} data-dir="1" type="button" ${atMax ? 'disabled aria-disabled="true" title="Future is not allowed"' : ''}>›</button>`;
  switch (f.period) {
    case 'day':
      return `<button class="icon-btn" ${step} data-dir="-1" type="button">‹</button>
        <input type="date" data-filter="day" data-type="${type}" value="${f.day}" max="${today()}">
        ${next(f.day >= today())}`;
    case 'month':
      return `<button class="icon-btn" ${step} data-dir="-1" type="button">‹</button>
        <input type="month" data-filter="month" data-type="${type}" value="${f.month}" max="${thisMonth()}">
        ${next(f.month >= thisMonth())}`;
    case 'year': {
      const years = new Set([thisYear(), f.year, ...Store.txs.map(t => t.date.slice(0, 4))]);
      const list = [...years].filter(y => y <= thisYear()).sort().reverse();
      return `<button class="icon-btn" ${step} data-dir="-1" type="button">‹</button>
        <select data-filter="year" data-type="${type}">${list.map(y => `<option ${y === f.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
        ${next(f.year >= thisYear())}`;
    }
    case 'range':
      return `<input type="date" data-filter="from" data-type="${type}" value="${f.from}" max="${f.to && f.to < today() ? f.to : today()}" aria-label="From">
        <span class="range-sep">to</span>
        <input type="date" data-filter="to" data-type="${type}" value="${f.to}" min="${f.from || ''}" max="${today()}" aria-label="To">`;
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
      <h3>Books <small>${Store.books.length} ${Store.books.length === 1 ? 'book' : 'books'}</small></h3>
      <div class="cat-list">
        ${Store.books.map(b => {
          const t = bookTotals(b.id);
          const owner = Store.isOwner(b);
          return `<div class="cat-item">
            <span>${Store.isShared(b) ? '👥' : '📒'}</span>
            <span class="n">${esc(b.name)}${b.id === Store.bookId ? ' <span class="pill on">Open</span>' : ''}
              <small class="muted" style="display:block">${owner ? '' : `Shared by ${esc(b.ownerName || 'owner')} · `}${t.count} ${t.count === 1 ? 'entry' : 'entries'} · balance ${signed(t.bal)}</small></span>
            <button class="x" data-action="shareBook" data-id="${esc(b.id)}" type="button" aria-label="Members of ${esc(b.name)}" title="Members">👥</button>
            ${owner ? `<button class="x" data-action="editBook" data-id="${esc(b.id)}" type="button" aria-label="Rename ${esc(b.name)}" title="Rename">✏️</button>
            <button class="x" data-action="delBook" data-id="${esc(b.id)}" type="button" aria-label="Delete ${esc(b.name)}" title="Delete">🗑</button>`
            : `<button class="x" data-action="leaveBook" data-id="${esc(b.id)}" type="button" aria-label="Leave ${esc(b.name)}" title="Leave book">🚪</button>`}
          </div>`;
        }).join('')}
      </div>
      <button class="btn ghost block" style="margin-top:12px" data-action="newBook" type="button">+ New book</button>
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
      <div class="set-row"><div>Storage<small>Private cloud (Firebase) · only you and people you share a book with</small></div></div>
      <div class="set-row"><div>Status<small>${esc(syncText)}</small></div></div>
      <div class="set-row"><div>Reports<small>${esc(Store.book.name)} · ${Store.txs.length} entries</small></div><button class="btn ghost" data-action="openReport" type="button">📄 PDF / Excel</button></div>
      <div class="set-row"><div>Export<small>Spreadsheet (CSV) of this book</small></div><button class="btn ghost" data-action="exportCsv" type="button">Export CSV</button></div>
      ${Store.error ? `<p class="error">${esc(Store.error)}</p>` : ''}
    </section>

    <button class="btn danger block" data-action="logout" type="button">Logout</button>
    <p class="note" style="text-align:center">Expense Tracker · v3.0</p>`;
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
    party: tx ? tx.party || '' : '',
    addingCat: false,
  };
  renderSheet();
  $('#sheetWrap').classList.remove('hidden');
  if (!tx) setTimeout(() => $('#fAmount') && $('#fAmount').focus(), 250);
}
function closeSheet() { $('#sheetWrap').classList.add('hidden'); sheetState = null; }

// New / rename book form (reuses the bottom sheet).
function openBookSheet(book = null) {
  sheetState = { kind: 'book', id: book ? book.id : null };
  $('#sheet').innerHTML = `
    <div class="grab"></div>
    <h2>${book ? 'Rename book' : 'New book'} <button class="icon-btn" data-action="closeSheet" type="button" aria-label="Close">✕</button></h2>
    <p class="muted" style="margin:-6px 0 14px;font-size:14px">Each book keeps its own entries and balance, e.g. Home, Shop, Trip.</p>
    <label class="field"><span>Book name</span><input id="fBookName" maxlength="30" placeholder="e.g. Shop" value="${esc(book ? book.name : '')}"></label>
    <p id="fErr" class="error"></p>
    <div class="sheet-actions"><button class="btn primary" data-action="saveBookForm" type="button">${book ? 'Save' : 'Create book'}</button></div>`;
  $('#sheetWrap').classList.remove('hidden');
  setTimeout(() => $('#fBookName') && $('#fBookName').focus(), 250);
}
// Members of a book (#3).
function openShareSheet(bookId) {
  const b = Store.books.find(x => x.id === bookId);
  if (!b) return;
  sheetState = { kind: 'share', id: bookId };
  const owner = Store.isOwner(b);
  const members = Object.entries(b.members || {}).sort((x, y) => (x[1].role === 'owner' ? -1 : 1) - (y[1].role === 'owner' ? -1 : 1));
  $('#sheet').innerHTML = `
    <div class="grab"></div>
    <h2>👥 ${esc(b.name)} <button class="icon-btn" data-action="closeSheet" type="button" aria-label="Close">✕</button></h2>
    <p class="muted" style="margin:-6px 0 12px;font-size:14px">Members can see this book and add, edit or delete its entries. Only the owner can add or remove members.</p>
    <div class="cat-list">
      ${members.map(([mid, m]) => `<div class="cat-item">
        <span>${m.role === 'owner' ? '👑' : '👤'}</span>
        <span class="n">${esc(m.name || '')}${mid === Store.uid ? ' (you)' : ''}<small class="muted" style="display:block">${esc(m.mobile || '')} · ${m.role === 'owner' ? 'Owner' : 'Member'}</small></span>
        ${owner && m.role !== 'owner' ? `<button class="x" data-action="removeMemberBtn" data-uid="${esc(mid)}" type="button" aria-label="Remove ${esc(m.name || '')}">✕</button>` : ''}
      </div>`).join('')}
    </div>
    ${owner ? `<p class="label-sm" style="margin-top:14px">Add member by mobile number</p>
      <div class="add-row" style="margin-top:0"><input id="fMemberMobile" type="tel" inputmode="numeric" maxlength="10" placeholder="10 digit mobile"><button class="btn primary" data-action="addMemberForm" type="button">Add</button></div>
      <p class="note">They must have an account in this app (signed up with the invite code).</p>` : ''}
    <p id="fErr" class="error"></p>`;
  $('#sheetWrap').classList.remove('hidden');
}

// Reports (#5): PDF (via the phone's "Save as PDF" print option) and Excel (.xlsx).
const REPORT_PERIODS = { month: 'This month', last: 'Last month', year: 'This year', all: 'All time', custom: 'Custom' };
function openReportSheet() {
  sheetState = { kind: 'report', period: 'month', from: thisMonth() + '-01', to: today() };
  renderReportSheet();
  $('#sheetWrap').classList.remove('hidden');
}
function renderReportSheet() {
  const s = sheetState;
  $('#sheet').innerHTML = `
    <div class="grab"></div>
    <h2>📄 Report <button class="icon-btn" data-action="closeSheet" type="button" aria-label="Close">✕</button></h2>
    <p class="muted" style="margin:-6px 0 12px;font-size:14px">Book: <b>${esc(Store.book.name)}</b></p>
    <p class="label-sm">Period</p>
    <div class="chips">${Object.entries(REPORT_PERIODS).map(([k, l]) => `<button class="chip${s.period === k ? ' on' : ''}" data-action="reportPeriod" data-p="${k}" type="button">${l}</button>`).join('')}</div>
    ${s.period === 'custom' ? `<div class="filter-row">
      <input id="rFrom" type="date" value="${s.from}" max="${today()}" aria-label="From"><span class="range-sep">to</span>
      <input id="rTo" type="date" value="${s.to}" max="${today()}" aria-label="To"></div>` : ''}
    <p id="fErr" class="error"></p>
    <div class="sheet-actions">
      <button class="btn primary" data-action="reportPdf" type="button">⬇ PDF</button>
      <button class="btn primary" data-action="reportExcel" type="button">⬇ Excel</button>
    </div>
    <p class="note">PDF opens the print screen: choose <b>Save as PDF</b>.</p>`;
}
function readReport() {
  const f = $('#rFrom'), t = $('#rTo');
  if (f) sheetState.from = f.value;
  if (t) sheetState.to = t.value;
}
function reportData() {
  const s = sheetState;
  let from = '', to = today(), label = REPORT_PERIODS[s.period];
  if (s.period === 'month') { from = thisMonth() + '-01'; label = fmtMonth(thisMonth()); }
  if (s.period === 'last') { const m = shiftMonth(thisMonth(), -1); from = m + '-01'; to = shiftDay(thisMonth() + '-01', -1); label = fmtMonth(m); }
  if (s.period === 'year') { from = thisYear() + '-01-01'; label = thisYear(); }
  if (s.period === 'custom') {
    from = s.from; to = s.to;
    if (!from || !to) { $('#fErr').textContent = 'Choose both dates'; return null; }
    if (from > to) { $('#fErr').textContent = '"From" date must be before "To" date'; return null; }
    if (to > today()) { $('#fErr').textContent = 'Future dates are not allowed'; return null; }
    label = `${fmtShort(from)} – ${fmtShort(to)}`;
  }
  const bal = runningBalances(Store.txs);
  const rows = Store.txs.filter(t => (!from || t.date >= from) && t.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
  if (!rows.length) { $('#fErr').textContent = 'No entries in this period'; return null; }
  const inc = sum(rows.filter(t => t.type === 'income'));
  const exp = sum(rows.filter(t => t.type === 'expense'));
  return { book: Store.book.name, label, rows, inc, exp, bal };
}
const fileSafe = s => String(s).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '');
function printReport(r) {
  const shared = Store.isShared();
  const area = $('#printArea') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'printArea' }));
  area.innerHTML = `
    <h1>${esc(r.book)}</h1>
    <p class="rp-sub">Report · ${esc(r.label)} · Generated ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</p>
    <table class="rp-sum"><tr><td>Total in<b class="in">${money(r.inc)}</b></td><td>Total out<b class="out">${money(r.exp)}</b></td><td>Net<b>${signed(r.inc - r.exp)}</b></td><td>Entries<b>${r.rows.length}</b></td></tr></table>
    <table class="rp-table">
      <thead><tr><th>Date</th><th>Details</th><th>Mode</th>${shared ? '<th>By</th>' : ''}<th class="num">In</th><th class="num">Out</th><th class="num">Balance</th></tr></thead>
      <tbody>${r.rows.map(t => `<tr>
        <td>${fmtShort(t.date)}</td>
        <td><b>${esc(t.category)}</b>${t.party ? `<br>${t.type === 'income' ? 'From' : 'To'} ${esc(t.party)}` : ''}${t.note ? `<br><i>${esc(t.note)}</i>` : ''}</td>
        <td>${t.type === 'expense' ? esc(t.mode || '') : ''}</td>${shared ? `<td>${esc(t.createdByName || '')}</td>` : ''}
        <td class="num in">${t.type === 'income' ? money(t.amount) : ''}</td>
        <td class="num out">${t.type === 'expense' ? money(t.amount) : ''}</td>
        <td class="num">${signed(r.bal.get(t.id))}</td></tr>`).join('')}</tbody>
    </table>`;
  const oldTitle = document.title;
  document.title = `${fileSafe(r.book)}-report-${fileSafe(r.label)}`; // used as the PDF file name
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); document.title = oldTitle; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const el = Object.assign(document.createElement('script'), { src, onload: res, onerror: () => rej(new Error('Could not load (check internet)')) });
    document.head.appendChild(el);
  });
}
async function excelReport(r, btn) {
  btn.disabled = true;
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    const shared = Store.isShared();
    const head = ['Date', 'Category', 'Party', 'Mode', 'Note', ...(shared ? ['Added by'] : []), 'In', 'Out', 'Balance'];
    const aoa = [
      [`${r.book} — ${r.label}`], [],
      ['Total in', r.inc], ['Total out', r.exp], ['Net', r.inc - r.exp], ['Entries', r.rows.length], [],
      head,
      ...r.rows.map(t => [t.date, t.category, t.party || '', t.type === 'expense' ? t.mode || '' : '', t.note || '',
        ...(shared ? [t.createdByName || ''] : []),
        t.type === 'income' ? Number(t.amount) : '', t.type === 'expense' ? Number(t.amount) : '', r.bal.get(t.id)]),
    ];
    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = head.map(h => ({ wch: h === 'Note' ? 28 : h === 'Category' || h === 'Party' ? 18 : 12 }));
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'Report');
    window.XLSX.writeFile(wb, `${fileSafe(r.book)}-report-${fileSafe(r.label)}.xlsx`);
    toast('Excel downloaded ✓');
  } catch (e) {
    $('#fErr') && ($('#fErr').textContent = 'Excel failed: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

function readSheet() {
  if (!sheetState) return;
  const a = $('#fAmount'); if (a) sheetState.amount = a.value;
  const d = $('#fDate'); if (d) sheetState.date = d.value;
  const n = $('#fNote'); if (n) sheetState.note = n.value;
  const p = $('#fParty'); if (p) sheetState.party = p.value;
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
    <label class="field"><span>${s.type === 'income' ? 'Received from' : 'Paid to'} (optional)</span><input id="fParty" list="partyList" maxlength="40" autocomplete="off" placeholder="${s.type === 'income' ? 'e.g. Company, client' : 'e.g. Shop name, person'}" value="${esc(s.party)}"></label>
    <datalist id="partyList">${[...new Set(Store.allTxs.map(t => t.party).filter(Boolean))].sort().map(p => `<option value="${esc(p)}">`).join('')}</datalist>
    <label class="field"><span>Date</span><input id="fDate" type="date" value="${s.date}" max="${today()}"></label>
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
  const bal = runningBalances(Store.txs);
  const rows = [['Date', 'Type', 'Category', 'Party', 'Amount', 'Mode', 'Note', 'Added by', 'Balance']];
  for (const t of [...Store.txs].sort(byNewest)) rows.push([t.date, t.type, t.category, t.party || '', t.amount, t.type === 'expense' ? t.mode || '' : '', t.note || '', t.createdByName || '', bal.get(t.id)]);
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${Store.book.name.replace(/[^\w-]+/g, "-")}-${today()}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------------- actions ---------------- */
const actions = {
  add(el) {
    if (ui.tab === 'books' && !el.dataset.type) return openBookSheet(); // + on the books screen makes a new book
    openSheet(el.dataset.type || (ui.tab === 'income' ? 'income' : 'expense'));
  },
  edit(el) { const t = Store.txs.find(x => x.id === el.dataset.id); if (t) openSheet(t.type, t); },
  closeSheet,
  dashMonth(el) {
    const m = shiftMonth(ui.dashMonth, Number(el.dataset.dir));
    if (m > thisMonth()) return toast('Future months are not allowed');
    ui.dashMonth = m;
    render();
  },
  period(el) { ui.filters[el.dataset.type].period = el.dataset.p; render(); },
  stepPeriod(el) {
    const f = ui.filters[el.dataset.type];
    const k = Number(el.dataset.dir);
    const key = f.period;
    let v = f[key];
    if (key === 'day') v = shiftDay(v || today(), k);
    if (key === 'month') v = shiftMonth(v || thisMonth(), k);
    if (key === 'year') v = String(Number(v || thisYear()) + k);
    if (v > FILTER_MAX[key]()) return toast('Future dates are not allowed');
    f[key] = v;
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
    if (s.date > today()) { err.textContent = 'Future date is not allowed. Choose today or an earlier date.'; $('#fDate').focus(); return; }
    const data = { type: s.type, amount, category: s.category, date: s.date, note: s.note.trim(), party: (s.party || '').trim().replace(/\s+/g, ' ') };
    if (s.type === 'expense') data.mode = s.mode; else data.mode = '';
    const now = Date.now();
    const id = s.id;
    closeSheet();
    if (id) Store.saveTx(id, { ...data, updatedAt: now });
    else Store.saveTx(uid(), { ...data, createdBy: Store.uid, createdByName: Store.me().name, createdAt: now, updatedAt: now });
    toast(id ? 'Updated ✓' : `${data.type === 'income' ? 'Income' : 'Expense'} saved ✓`);
  },
  pickBook(el) { Store.setBook(el.dataset.id); toast(`Opened ${Store.book.name}`); },
  openBook(el) { Store.bookId = el.dataset.id; ls.set(`et_book_${Store.uid}`, el.dataset.id); ui.tab = 'dashboard'; render(); window.scrollTo(0, 0); },
  newBook() { openBookSheet(); },
  editBook(el) { const b = Store.books.find(x => x.id === el.dataset.id); if (b) openBookSheet(b); },
  saveBookForm() {
    const name = $('#fBookName').value.trim().replace(/\s+/g, ' ');
    const err = $('#fErr');
    if (!name) { err.textContent = 'Enter a book name'; return; }
    const id = sheetState.id;
    if (Store.books.some(b => b.id !== id && b.ownerUid === Store.uid && b.name.toLowerCase() === name.toLowerCase())) { err.textContent = 'You already have a book with this name'; return; }
    closeSheet();
    if (id) {
      Store.renameBook(id, name);
      toast('Book renamed ✓');
    } else {
      Store.setBook(Store.createBook(name));
      toast(`📒 ${name} created`);
    }
  },
  delBook(el) {
    const b = Store.books.find(x => x.id === el.dataset.id);
    if (!b) return;
    if (!Store.isOwner(b)) return toast('Only the owner can delete this book');
    if (Store.books.length <= 1) return toast('Keep at least one book');
    const n = (Store.bookTx[b.id] || []).length;
    const shared = Store.isShared(b) ? '\nIt will also be removed for everyone it is shared with.' : '';
    if (!confirm(`Delete book "${b.name}"?${n ? `\nIts ${n} ${n === 1 ? 'entry' : 'entries'} will also be deleted.` : ''}${shared}\nThis cannot be undone.`)) return;
    if (b.id === Store.bookId) Store.setBook(Store.books.find(x => x.id !== b.id).id);
    Store.deleteBook(b.id);
    toast('Book deleted');
  },
  leaveBook(el) {
    const b = Store.books.find(x => x.id === el.dataset.id);
    if (!b) return;
    if (!confirm(`Leave "${b.name}"?\nYou will no longer see this book. ${b.ownerName || 'The owner'} can add you again.`)) return;
    if (b.id === Store.bookId) { const other = Store.books.find(x => x.id !== b.id); if (other) Store.setBook(other.id); }
    Store.removeMember(b.id, Store.uid).then(() => toast('You left the book')).catch(e => toast(e.message, 3500));
  },
  // Members screen (#3): owner adds people by mobile number; everyone sees who has access.
  shareBook(el) { openShareSheet(el.dataset.id); },
  async addMemberForm() {
    const mobile = ($('#fMemberMobile').value || '').replace(/\D/g, '');
    const err = $('#fErr');
    err.textContent = '';
    if (mobile.length !== 10) { err.textContent = 'Enter a 10 digit mobile number'; return; }
    if (mobile === Store.me().mobile) { err.textContent = 'That is your own number'; return; }
    const btn = $('[data-action=addMemberForm]');
    btn.disabled = true;
    try {
      const name = await Store.addMember(sheetState.id, mobile);
      toast(`${name} can now see and add entries ✓`);
      $('#fMemberMobile').value = '';
      btn.disabled = false;
    } catch (e) {
      err.textContent = e.code === 'permission-denied' ? 'Only the book owner can add members' : e.message;
      btn.disabled = false;
    }
  },
  removeMemberBtn(el) {
    const b = Store.books.find(x => x.id === sheetState.id);
    const m = b && b.members && b.members[el.dataset.uid];
    if (!confirm(`Remove ${m ? m.name : 'this member'} from "${b ? b.name : 'book'}"?`)) return;
    Store.removeMember(sheetState.id, el.dataset.uid).then(() => toast('Member removed')).catch(e => toast(e.message, 3500));
  },
  openReport() { openReportSheet(); },
  reportPeriod(el) { readReport(); sheetState.period = el.dataset.p; renderReportSheet(); },
  reportPdf() { readReport(); const r = reportData(); if (r) printReport(r); },
  reportExcel(el) { readReport(); const r = reportData(); if (r) excelReport(r, el); },
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
  const key = el.dataset.filter;
  let v = el.value;
  // A typed-in future value (pickers already block it) is pulled back to today / this month / this year.
  if (FILTER_MAX[key] && v && v > FILTER_MAX[key]()) { v = FILTER_MAX[key](); toast('Future dates are not allowed'); }
  f[key] = v;
  if (key === 'from' && f.to && f.from > f.to) f.to = f.from;
  if (key === 'to' && f.from && f.to < f.from) f.from = f.to;
  if (FILTER_MAX[key]) { render(); return; } // refresh inputs and the "›" buttons
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
  if (e.key === 'Enter' && e.target.id === 'fBookName') { e.preventDefault(); actions.saveBookForm(); }
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
