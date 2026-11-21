'use strict';
/* Personal Expense Tracker — vanilla JS PWA.
 * Storage: a JSON file (data.json) in a private GitHub repo via the GitHub Contents API.
 * The GitHub token is stored AES-GCM encrypted in config.js; the key is derived from mobile + password,
 * so only the correct login can decrypt it. Without a token the app runs in "local only" mode. */

const C = window.APP_CONFIG || {};

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

const defaultDoc = () => ({ version: 1, categories: structuredClone(DEFAULT_CATS), transactions: [], deleted: [] });
const normalize = d => ({
  version: 1,
  categories: {
    expense: Array.isArray(d?.categories?.expense) && d.categories.expense.length ? [...d.categories.expense] : [...DEFAULT_CATS.expense],
    income: Array.isArray(d?.categories?.income) && d.categories.income.length ? [...d.categories.income] : [...DEFAULT_CATS.income],
  },
  transactions: Array.isArray(d?.transactions) ? d.transactions.filter(t => t && t.id && t.date) : [],
  deleted: Array.isArray(d?.deleted) ? d.deleted : [],
});

/* ---------------- crypto / session ---------------- */
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function utf8ToB64(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64ToUtf8 = b => dec.decode(b64d(b.replace(/\s/g, '')));

async function deriveKey(mobile, password) {
  const base = await crypto.subtle.importKey('raw', enc.encode(`${mobile.trim()}:${password}`), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64d(C.auth.salt), iterations: C.auth.iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function decryptBox(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(box.iv) }, key, b64d(box.ct));
  return dec.decode(pt);
}

const SESSION_KEY = 'et_session';
const CACHE_KEY = 'et_cache_v1';
const TOKEN_KEY = 'et_device_token';
let session = ls.get(SESSION_KEY);
const remoteOn = () => !!(session && session.token && C.dataRepo);

/* ---------------- GitHub storage ---------------- */
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
function gh(path, opts = {}) {
  return fetch(`https://api.github.com/repos/${C.dataRepo}/contents/${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
}
async function httpErr(r) {
  let msg = `GitHub error ${r.status}`;
  try { const j = await r.json(); if (j.message) msg += `: ${j.message}`; } catch { /* ignore */ }
  if (r.status === 401) msg = 'GitHub token is invalid or expired';
  if (r.status === 404) msg = 'Data repo not found (check repo name / token access)';
  return new HttpError(r.status, msg);
}
async function ghGet(path) {
  const r = await gh(path);
  if (r.status === 404) {
    // 404 can mean "file missing" (fine) or "repo inaccessible". Distinguish by checking the repo.
    const repo = await fetch(`https://api.github.com/repos/${C.dataRepo}`, { cache: 'no-store', headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/vnd.github+json' } });
    if (!repo.ok) throw await httpErr(repo);
    return { data: null, sha: null };
  }
  if (!r.ok) throw await httpErr(r);
  const j = await r.json();
  let text = j.encoding === 'base64' && j.content ? b64ToUtf8(j.content) : '';
  if (!text && j.size > 0) {
    // Files over 1 MB come back without content; fetch the raw body instead.
    const r2 = await gh(path, { headers: { Accept: 'application/vnd.github.raw+json' } });
    if (!r2.ok) throw await httpErr(r2);
    text = await r2.text();
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`${path} in the data repo is not valid JSON`); }
  return { data, sha: j.sha };
}
async function ghPut(path, text, sha, message) {
  const body = { message, content: utf8ToB64(text) };
  if (sha) body.sha = sha;
  const r = await gh(path, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (r.status === 409 || r.status === 422) { const e = new Error('Save conflict'); e.conflict = true; throw e; }
  if (!r.ok) throw await httpErr(r);
  return (await r.json()).content.sha;
}

function serialize(d) {
  const tx = [...d.transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
  return '{\n"version": 1,\n"categories": ' + JSON.stringify(d.categories) +
    ',\n"deleted": ' + JSON.stringify(d.deleted) +
    ',\n"transactions": [\n' + tx.map(t => JSON.stringify(t)).join(',\n') + '\n]\n}\n';
}

// Merge remote + local: union by id, newest updatedAt wins, tombstones remove. Local categories win.
function merge(remote, local) {
  const deleted = new Set([...remote.deleted, ...local.deleted]);
  const map = new Map();
  for (const t of [...remote.transactions, ...local.transactions]) {
    if (deleted.has(t.id)) continue;
    const prev = map.get(t.id);
    if (!prev || (t.updatedAt || 0) >= (prev.updatedAt || 0)) map.set(t.id, t);
  }
  return { version: 1, categories: local.categories, deleted: [...deleted].slice(-3000), transactions: [...map.values()] };
}

const Store = {
  doc: defaultDoc(), sha: null, dirty: false, rev: 0, syncing: false, again: false,
  status: 'idle', error: '', lastSync: null,

  init() {
    const c = ls.get(CACHE_KEY);
    this.doc = normalize(c && c.doc);
    this.sha = (c && c.sha) || null;
    this.dirty = !!(c && c.dirty);
    this.lastSync = (c && c.lastSync) || null;
  },
  persist() { ls.set(CACHE_KEY, { doc: this.doc, sha: this.sha, dirty: this.dirty, lastSync: this.lastSync }); },
  get txs() { return this.doc.transactions; },

  mutate(fn) {
    fn(this.doc);
    this.dirty = true;
    this.rev++;
    this.persist();
    render();
    clearTimeout(this._t);
    this._t = setTimeout(() => this.sync(), 300);
  },
  setStatus(s, err = '') { this.status = s; this.error = err; updateSyncBadge(); },

  async sync() {
    if (!remoteOn()) { this.setStatus('local'); return; }
    if (this.syncing) { this.again = true; return; }
    if (!navigator.onLine) { this.setStatus('offline'); return; }
    this.syncing = true;
    this.again = false;
    this.setStatus('saving');
    const before = JSON.stringify(this.doc);
    try {
      for (let attempt = 0; ; attempt++) {
        const startRev = this.rev;
        const remote = await ghGet('data.json');
        if (this.rev !== startRev) continue; // edited while fetching — fetch again
        const wasDirty = this.dirty;
        const rdoc = remote.data ? normalize(remote.data) : null;
        this.doc = rdoc ? (wasDirty ? merge(rdoc, this.doc) : rdoc) : this.doc;
        this.sha = remote.sha;
        if (wasDirty || !rdoc) {
          try {
            this.sha = await ghPut('data.json', serialize(this.doc), remote.sha, `Update ${today()}`);
          } catch (e) {
            if (e.conflict && attempt < 4) { await sleep(700 * (attempt + 1)); continue; }
            throw e;
          }
        }
        if (this.rev === startRev) this.dirty = false;
        else this.again = true;
        break;
      }
      this.lastSync = Date.now();
      this.persist();
      this.setStatus('synced');
    } catch (e) {
      console.error(e);
      const offline = e instanceof TypeError || !navigator.onLine;
      this.setStatus(offline ? 'offline' : 'error', offline ? 'No internet — changes will sync later' : e.message);
      this.authFailed = e.status === 401 || e.status === 403 || (e.status === 404 && /not found/i.test(e.message));
      if (this.authFailed && ui.tab === 'settings' && !$('#sheetWrap:not(.hidden)')) render();
    } finally {
      this.syncing = false;
      if (JSON.stringify(this.doc) !== before && !$('#sheetWrap:not(.hidden)')) render();
      if (this.again) this.sync();
    }
  },
};

async function saveSubscription(sub) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await ghGet('subscriptions.json');
    const list = ((r.data && r.data.subscriptions) || []).filter(s => s.endpoint !== sub.endpoint);
    list.push({ ...sub, device: navigator.userAgent.slice(0, 140), addedAt: new Date().toISOString() });
    try {
      await ghPut('subscriptions.json', JSON.stringify({ subscriptions: list }, null, 2) + '\n', r.sha, 'Add reminder device');
      return;
    } catch (e) {
      if (!e.conflict) throw e;
      await sleep(700 * (attempt + 1));
    }
  }
  throw new Error('Could not save reminder device, try again');
}

function updateSyncBadge() {
  const b = $('#syncBadge');
  if (!b) return;
  const labels = { idle: 'Loading', local: 'Local only', saving: 'Syncing…', synced: 'Synced', offline: 'Offline', error: 'Sync error' };
  b.className = 'sync ' + Store.status;
  b.textContent = labels[Store.status] || '';
  b.title = Store.error || '';
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
  return `<button class="tx ${t.type}" data-action="edit" data-id="${esc(t.id)}" type="button">
    <span class="ic">${icon(t.category)}</span>
    <span class="mid"><b>${esc(t.category)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    <span class="amt">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</span>
  </button>`;
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
  const last = Store.lastSync ? new Date(Store.lastSync).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
  return `
    <section class="card">
      <h3>Reminders</h3>
      <div class="muted" style="font-size:14px">A daily notification to add today's payments:</div>
      <div class="times"><span>6:35 PM</span><span>10:00 PM</span><span>11:00 PM</span></div>
      <div class="set-row"><div>Status on this phone</div><span id="remStatus" class="pill">…</span></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary" data-action="enableReminders" type="button">Turn on</button>
        <button class="btn" data-action="testNotif" type="button">Test</button>
      </div>
      ${remoteOn() && C.vapidPublicKey ? '' : '<p class="note">Connect GitHub below (Data &amp; sync) to turn on reminders.</p>'}
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
      <div class="set-row"><div>Storage<small>${remoteOn() ? `GitHub · ${esc(C.dataRepo)}` : 'This phone only (GitHub not connected)'}</small></div></div>
      ${(!remoteOn() || Store.authFailed) && C.dataRepo ? `
      <form class="add-row" data-form="connectGh" style="margin:4px 0 8px">
        <input name="token" type="password" autocomplete="off" placeholder="Paste GitHub token" required>
        <button class="btn primary" type="submit">Connect</button>
      </form>
      <p class="note" style="margin:0 0 6px">One-time: fine-grained token with Contents read/write on <b>${esc(C.dataRepo)}</b>. It is saved only on this phone.</p>` : ''}
      <div class="set-row"><div>Last synced<small>${esc(last)}</small></div><button class="btn ghost" data-action="syncNow" type="button">Sync now</button></div>
      <div class="set-row"><div>Entries<small>${Store.txs.length} total</small></div><button class="btn ghost" data-action="exportCsv" type="button">Export CSV</button></div>
      ${Store.error ? `<p class="error">${esc(Store.error)}</p>` : ''}
    </section>

    <button class="btn danger block" data-action="logout" type="button">Logout</button>
    <p class="note" style="text-align:center">Expense Tracker · v1.0</p>`;
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
  Store.mutate(doc => { doc.categories[type].push(name); });
  return name;
}

/* ---------------- reminders ---------------- */
function b64urlToBytes(s) {
  const p = '='.repeat((4 - s.length % 4) % 4);
  return b64d((s + p).replace(/-/g, '+').replace(/_/g, '/'));
}
async function reminderState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  return sub && ls.get('et_push_saved') === sub.endpoint ? 'on' : 'off';
}
async function fillReminderStatus() {
  const el = $('#remStatus');
  if (!el) return;
  const st = await reminderState().catch(() => 'off');
  const map = { on: ['Enabled', 'pill on'], off: ['Off', 'pill'], denied: ['Blocked in browser', 'pill bad'], unsupported: ['Not supported', 'pill bad'] };
  [el.textContent, el.className] = map[st];
}
async function enableReminders(btn) {
  if (!remoteOn()) return toast('Set up GitHub sync first (see README)');
  if (!C.vapidPublicKey) return toast('VAPID public key missing in config.js');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('This browser does not support push notifications');
  btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notification permission was not given'); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(C.vapidPublicKey) });
    await saveSubscription(sub.toJSON());
    ls.set('et_push_saved', sub.endpoint);
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
    Store.mutate(doc => { doc.categories[t] = doc.categories[t].filter(c => c !== name); });
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
    Store.mutate(doc => {
      const t = id && doc.transactions.find(x => x.id === id);
      if (t) Object.assign(t, data, { updatedAt: now });
      else doc.transactions.push({ id: uid(), ...data, createdAt: now, updatedAt: now });
    });
    toast(id ? 'Updated ✓' : `${data.type === 'income' ? 'Income' : 'Expense'} saved ✓`);
  },
  deleteTx() {
    const id = sheetState.id;
    if (!confirm('Delete this entry?')) return;
    closeSheet();
    Store.mutate(doc => {
      doc.transactions = doc.transactions.filter(t => t.id !== id);
      doc.deleted.push(id);
    });
    toast('Deleted');
  },
  syncNow() {
    if (!remoteOn()) return toast('Local mode: data is saved on this phone only');
    if (Store.status === 'error' && Store.error) toast(Store.error, 3500);
    Store.sync();
  },
  enableReminders(el) { enableReminders(el); },
  testNotif() { testNotif().catch(e => toast(e.message)); },
  exportCsv,
  logout() {
    const warn = Store.dirty && remoteOn() ? '\nSome changes are not synced yet and will be lost.' : '';
    if (!confirm('Logout from this phone?' + warn)) return;
    ls.del(SESSION_KEY);
    ls.del(CACHE_KEY);
    session = null;
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

document.addEventListener('submit', async e => {
  const gh = e.target.closest('[data-form="connectGh"]');
  if (gh) {
    e.preventDefault();
    const token = gh.token.value.trim();
    const btn = gh.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const r = await fetch(`https://api.github.com/repos/${C.dataRepo}/contents/`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      if (r.status === 401) throw new Error('Token is invalid or expired');
      if (r.status === 404 || r.status === 403) throw new Error(`Token has no access to ${C.dataRepo}`);
      if (!r.ok) throw new Error(`GitHub error ${r.status}`);
      session = { ...session, token };
      Store.authFailed = false;
      ls.set(SESSION_KEY, session);
      ls.set(TOKEN_KEY, token);
      Store.dirty = true; // upload entries saved on this phone so far
      Store.persist();
      toast('GitHub connected ✓');
      render();
      Store.sync();
    } catch (ex) {
      toast(ex instanceof TypeError ? 'No internet connection' : ex.message, 3500);
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
    return;
  }
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

/* ---------------- login & boot ---------------- */
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

$('#pwToggle').addEventListener('click', () => {
  const p = $('#loginPass');
  const show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  $('#pwToggle').textContent = show ? 'Hide' : 'Show';
});

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#loginError');
  const btn = $('#loginBtn');
  err.textContent = '';
  const mobile = $('#loginMobile').value.replace(/\D/g, '');
  const pass = $('#loginPass').value;
  if (mobile.length !== 10) { err.textContent = 'Enter a valid 10 digit mobile number'; return; }
  if (!C.auth || !C.auth.check) { err.textContent = 'App is not configured (config.js missing)'; return; }
  if (!window.crypto || !crypto.subtle) { err.textContent = 'Open the app over https to login'; return; }
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const key = await deriveKey(mobile, pass);
    let ok = false;
    try { ok = (await decryptBox(key, C.auth.check)) === 'expense-tracker-ok'; } catch { ok = false; }
    if (!ok) { err.textContent = 'Wrong mobile number or password'; return; }
    // A token pasted in Settings on this device wins over the one in config.js.
    const token = ls.get(TOKEN_KEY) || (C.auth.token ? await decryptBox(key, C.auth.token) : null);
    session = { token, at: Date.now() };
    ls.set(SESSION_KEY, session);
    $('#loginPass').value = '';
    boot();
  } catch (ex) {
    console.error(ex);
    err.textContent = 'Login failed: ' + ex.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Login';
  }
});

function handleHash() {
  if (location.hash === '#add') {
    history.replaceState(null, '', location.pathname + location.search);
    if (session) openSheet('expense');
  }
}

function boot() {
  // Logged in before GitHub sync was set up: ask to log in again so the token can be unlocked.
  if (session && !session.token && C.auth && C.auth.token) {
    session = null;
    ls.del(SESSION_KEY);
    showLogin();
    $('#loginError').textContent = 'GitHub sync is now set up. Please log in again.';
    return;
  }
  if (!session) { showLogin(); return; }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  Store.init();
  render();
  Store.sync();
  handleHash();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(reg => reg.update())
    .catch(e => console.warn('SW registration failed', e));
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'open-add' && session) { closeSheet(); openSheet('expense'); }
  });
}
window.addEventListener('hashchange', handleHash);
window.addEventListener('online', () => session && Store.sync());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && remoteOn() && (!Store.lastSync || Date.now() - Store.lastSync > 30000)) Store.sync();
});

boot();
