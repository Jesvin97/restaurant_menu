const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const defaultMenu = require('./menu.json');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

class Store {
  constructor(file = config.stateFile, opts = {}) {
    this.file = file;
    this.persist = opts.persist !== false;
    this.now = opts.now || (() => Date.now());
    this.state = { secret: '', tables: {}, history: [], customers: {}, seq: 0, menu: null, unavailable: {} };
    if (this.persist && fs.existsSync(file)) {
      try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* start fresh */ }
    }
    if (!this.state.secret) this.state.secret = config.qrSecret || rid(16);
    if (config.qrSecret) this.state.secret = config.qrSecret;
    for (let i = 1; i <= config.tableCount; i++) {
      this.state.tables[i] = this.state.tables[i] || { session: null, pending: [] };
    }
    this.setMenu(this.state.menu || defaultMenu, false);
    this.save();
  }

  // ---- menu & availability ---------------------------------------------
  setMenu(menu, persist = true) {
    this.menu = menu;
    if (persist) this.state.menu = menu; // only imported menus are persisted; the default stays in menu.json
    this.itemsById = new Map(menu.items.map((i) => [i.id, i]));
    // Forget availability flags for dishes that no longer exist.
    for (const id of Object.keys(this.state.unavailable)) if (!this.itemsById.has(id)) delete this.state.unavailable[id];
    if (persist) this.save();
  }

  today() { return new Date(this.now()).toLocaleDateString('en-CA', { timeZone: config.timezone }); }

  /** Menu as guests see it: unavailable dishes are removed entirely. */
  publicMenu() {
    const m = this.menu;
    const items = m.items.filter((i) => !this.state.unavailable[i.id]);
    const used = new Set(items.map((i) => i.category));
    return { categories: m.categories.filter((c) => used.has(c.id)), items };
  }

  adminMenu() {
    return { ...this.menu, items: this.menu.items.map((i) => ({ ...i, available: !this.state.unavailable[i.id] })) };
  }

  setAvailability(itemId, available) {
    if (!this.itemsById.has(itemId)) return { ok: false, status: 404, error: 'unknown dish' };
    if (available) delete this.state.unavailable[itemId];
    else this.state.unavailable[itemId] = { since: this.today(), prompted: false };
    this.save();
    return { ok: true };
  }

  /** Next-day prompts: dishes hidden on an earlier day that staff haven't been asked about yet. */
  restockNotices() {
    const today = this.today();
    return Object.entries(this.state.unavailable)
      .filter(([, u]) => u.since !== today && !u.prompted)
      .map(([id, u]) => ({ itemId: id, name: this.itemsById.get(id).name, since: u.since }));
  }

  answerRestock(itemId, bringBack) {
    const u = this.state.unavailable[itemId];
    if (!u) return { ok: false, status: 404, error: 'not hidden' };
    if (bringBack) delete this.state.unavailable[itemId]; else u.prompted = true; // 'no' = stay hidden, don't ask again
    this.save();
    return { ok: true };
  }

  save() {
    if (!this.persist) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  // ---- static table QR signature -------------------------------------
  sign(tableId) {
    return crypto.createHmac('sha256', this.state.secret).update(`table:${tableId}`).digest('hex').slice(0, 20);
  }
  verify(tableId, sig) {
    const a = Buffer.from(this.sign(tableId));
    const b = Buffer.from(String(sig || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  table(id) { return this.state.tables[id] || null; }

  // Lazily expire sessions nobody has touched for a long time.
  _expire(t) {
    const s = t.session;
    if (s && this.now() - s.lastActive > config.sessionIdleHours * 3600e3) this._close(t, 'expired');
    t.pending = t.pending.filter((p) => this.now() - p.at < 15 * 60e3);
  }

  _close(t, reason) {
    const s = t.session;
    if (!s) return;
    if (s.orders.length) {
      if (s.customer) this._recordCustomer(s.customer, this.bill(s).total);
      this.state.history.push({ ...this.bill(s), sessionId: s.id, closedAt: this.now(), reason, customerPhone: s.customer && s.customer.phone });
      this.state.history = this.state.history.slice(-2000);
    }
    // Dropping the session invalidates every device token that belonged to it.
    t.session = null;
  }

  _recordCustomer(c, total) {
    const prev = this.state.customers[c.phone];
    this.state.customers[c.phone] = {
      phone: c.phone, name: c.name,
      // Latest choice wins, so a guest can withdraw consent on a later visit.
      consentReview: c.consentReview, consentOffers: c.consentOffers, consentAt: c.consentAt,
      visits: (prev ? prev.visits : 0) + 1, spent: (prev ? prev.spent : 0) + total,
      firstVisit: prev ? prev.firstVisit : this.now(), lastVisit: this.now(),
      reviewRequestedAt: prev ? prev.reviewRequestedAt || null : null,
    };
  }

  _open(t, tokenHash) {
    t.session = {
      id: rid(6), status: 'open', members: [tokenHash], code: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
      orders: [], openedAt: this.now(), lastActive: this.now(), fails: 0, lockedUntil: 0,
    };
    t.pending = t.pending.filter((p) => p.token !== tokenHash);
  }

  // ---- guest flow -----------------------------------------------------
  /** Called when a device scans the static table QR. */
  enter(tableId, token) {
    const t = this.table(tableId);
    if (!t) return { state: 'invalid' };
    this._expire(t);
    const h = sha(token);
    if (t.session) {
      if (t.session.members.includes(h)) return { state: 'active' };
      return { state: 'needs_code' };
    }
    if (config.autoSeat) { this._open(t, h); this.save(); return { state: 'active' }; }
    if (!t.pending.some((p) => p.token === h)) t.pending.push({ token: h, at: this.now() });
    this.save();
    return { state: 'pending' };
  }

  join(tableId, token, code) {
    const t = this.table(tableId);
    if (!t) return { ok: false, error: 'invalid table' };
    this._expire(t);
    const s = t.session;
    if (!s) return { ok: false, error: 'This table is not open. Please scan again.' };
    if (s.lockedUntil > this.now()) return { ok: false, error: 'Too many wrong codes. Ask a staff member.' };
    if (String(code) !== s.code) {
      if (++s.fails >= 5) { s.fails = 0; s.lockedUntil = this.now() + 5 * 60e3; }
      this.save();
      return { ok: false, error: 'Wrong table code' };
    }
    s.fails = 0;
    const h = sha(token);
    if (!s.members.includes(h)) s.members.push(h);
    this.save();
    return { ok: true };
  }

  /** Resolve the caller's view of the table, promoting a pending device once staff has seated it. */
  view(tableId, token) {
    const t = this.table(tableId);
    if (!t) return { state: 'invalid' };
    this._expire(t);
    const h = sha(token || '');
    const s = t.session;
    if (!s) {
      return { state: t.pending.some((p) => p.token === h) ? 'pending' : 'closed' };
    }
    if (!s.members.includes(h)) return { state: 'needs_code' };
    const base = { code: s.code, customer: s.customer ? { name: s.customer.name } : null, requireContact: config.requireContact };
    // Guests only see what they ordered (names, quantities, kitchen status) - never prices or totals - until the counter bills.
    const orders = s.orders.map((o) => ({ id: o.id, at: o.at, status: o.status, items: o.items.map((i) => ({ name: i.name, qty: i.qty, veg: i.veg })) }));
    const state = { open: 'active', closing: 'closing', billed: 'billed' }[s.status];
    return { state, orders, ...base, ...(s.status === 'billed' ? { bill: this.bill(s) } : {}) };
  }

  placeOrder(tableId, token, lines) {
    const t = this.table(tableId);
    if (!t) return { ok: false, status: 404, error: 'invalid table' };
    this._expire(t);
    const s = t.session;
    if (!s || !s.members.includes(sha(token || ''))) return { ok: false, status: 403, error: 'Your table session is not active. Please scan the QR again.' };
    if (s.status !== 'open') return { ok: false, status: 409, error: 'The bill has been requested; ordering is closed.' };
    if (!Array.isArray(lines) || !lines.length || lines.length > 60) return { ok: false, status: 400, error: 'Empty order' };
    const merged = new Map();
    for (const l of lines) {
      const item = this.itemsById.get(String(l && l.id));
      const qty = Number(l && l.qty);
      const opt = item && item.options.find((o) => o.id === (l.opt || item.options[0].id));
      if (!item || !opt || !Number.isInteger(qty) || qty < 1 || qty > 20) return { ok: false, status: 400, error: 'Invalid item' };
      if (this.state.unavailable[item.id]) return { ok: false, status: 409, error: `${item.name} is not available right now`, unavailable: item.id };
      const key = `${item.id}|${opt.id}`;
      merged.set(key, { item, opt, qty: (merged.has(key) ? merged.get(key).qty : 0) + qty });
    }
    // Prices always come from the server menu, never from the client.
    const items = [...merged.values()].map(({ item, opt, qty }) => ({
      id: item.id, opt: opt.id, name: item.name + (opt.label ? ` (${opt.label})` : ''), veg: item.veg, price: opt.price, qty,
    }));
    const order = { id: rid(4), seq: ++this.state.seq, at: this.now(), status: 'new', items };
    s.orders.push(order);
    s.lastActive = this.now();
    this.save();
    return { ok: true, order };
  }

  static normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? '+91' + d : null;
  }

  /** Validates guest contact details. Marketing flags are only true when explicitly ticked. */
  static cleanContact(c) {
    const name = String((c && c.name) || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
    const phone = Store.normalizePhone(c && c.phone);
    if (!name || !phone) return null;
    return { name, phone, consentReview: c.review === true, consentOffers: c.offers === true, consentAt: null };
  }

  setContact(tableId, token, contact) {
    const t = this.table(tableId);
    if (!t) return { ok: false, status: 404, error: 'invalid table' };
    this._expire(t);
    const s = t.session;
    if (!s || !s.members.includes(sha(token || ''))) return { ok: false, status: 403, error: 'Your table session is not active.' };
    const c = Store.cleanContact(contact);
    if (!c) return { ok: false, status: 400, error: 'Enter your name and a valid 10-digit mobile number' };
    c.consentAt = this.now();
    s.customer = c;
    this.save();
    return { ok: true };
  }

  requestBill(tableId, token) {
    const t = this.table(tableId);
    if (!t) return { ok: false, status: 404, error: 'invalid table' };
    this._expire(t);
    const s = t.session;
    if (!s || !s.members.includes(sha(token || ''))) return { ok: false, status: 403, error: 'Your table session is not active.' };
    if (!s.orders.length) return { ok: false, status: 400, error: 'Nothing ordered yet' };
    if (config.requireContact && !s.customer) return { ok: false, status: 400, error: 'Name and mobile number are required for the bill' };
    if (s.status === 'open') {
      // The guest never sees a total here: this only notifies the counter, which generates the bill.
      s.status = 'closing';
      s.billRequestedAt = this.now();
      s.billSeq = ++this.state.seq;
    }
    s.lastActive = this.now();
    this.save();
    return { ok: true, status: s.status };
  }

  /** Counter action: lock ordering and reveal the total to the guest. */
  generateBill(tableId) {
    const t = this.table(tableId);
    const s = t && t.session;
    if (!s) return { ok: false, status: 404, error: 'no session' };
    if (!s.orders.length) return { ok: false, status: 400, error: 'Nothing ordered yet' };
    s.status = 'billed';
    this.save();
    return { ok: true, bill: this.bill(s) };
  }

  bill(s) {
    const lines = new Map();
    for (const o of s.orders) for (const i of o.items) {
      const k = `${i.id}|${i.opt}`;
      const l = lines.get(k) || { ...i, qty: 0 };
      l.qty += i.qty;
      lines.set(k, l);
    }
    const items = [...lines.values()].map((l) => ({ ...l, amount: l.price * l.qty }));
    const subtotal = items.reduce((a, l) => a + l.amount, 0);
    const tax = Math.round((subtotal * config.taxPercent) / 100);
    return { items, subtotal, taxPercent: config.taxPercent, tax, total: subtotal + tax };
  }

  // ---- staff ----------------------------------------------------------
  adminTables() {
    return Object.entries(this.state.tables).map(([id, t]) => {
      this._expire(t);
      const s = t.session;
      return {
        id, pending: t.pending.length,
        session: s && { id: s.id, status: s.status, code: s.code, devices: s.members.length, openedAt: s.openedAt, orders: s.orders, bill: this.bill(s) },
      };
    });
  }

  /** Live feed for the counter/kitchen screen: every open order across all tables, oldest first. */
  adminOrders() {
    const orders = [];
    for (const [tableId, t] of Object.entries(this.state.tables)) {
      this._expire(t);
      if (t.session) for (const o of t.session.orders) orders.push({ ...o, tableId, customer: t.session.customer ? t.session.customer.name : null });
    }
    orders.sort((a, b) => a.seq - b.seq);
    const billRequests = Object.entries(this.state.tables)
      .filter(([, t]) => t.session && t.session.status === 'closing')
      .map(([tableId, t]) => ({ tableId, at: t.session.billRequestedAt, seq: t.session.billSeq, customer: t.session.customer ? t.session.customer.name : null, total: this.bill(t.session).total }));
    return { orders, billRequests, restock: this.restockNotices(), lastSeq: this.state.seq, waiting: Object.entries(this.state.tables).filter(([, t]) => t.pending.length).map(([id]) => id) };
  }

  setOrderStatus(tableId, orderId, status) {
    const t = this.table(tableId);
    const o = t && t.session && t.session.orders.find((x) => x.id === orderId);
    if (!o) return { ok: false, status: 404, error: 'order not found' };
    if (!['new', 'kitchen', 'served'].includes(status)) return { ok: false, status: 400, error: 'bad status' };
    o.status = status;
    this.save();
    return { ok: true };
  }

  customers() {
    return Object.values(this.state.customers).sort((a, b) => b.lastVisit - a.lastVisit);
  }
  markReviewRequested(phone) {
    const c = this.state.customers[phone];
    if (!c) return { ok: false, status: 404, error: 'not found' };
    c.reviewRequestedAt = this.now();
    this.save();
    return { ok: true };
  }
  deleteCustomer(phone) {
    delete this.state.customers[phone];
    this.state.history.forEach((h) => { if (h.customerPhone === phone) delete h.customerPhone; });
    this.save();
    return { ok: true };
  }

  seat(tableId) {
    const t = this.table(tableId);
    if (!t) return { ok: false, status: 404, error: 'invalid table' };
    this._expire(t);
    if (t.session) return { ok: false, status: 409, error: 'Table already has an active session' };
    if (!t.pending.length) return { ok: false, status: 409, error: 'No guest is waiting at this table' };
    // The earliest waiting device becomes the host; others must use the code.
    this._open(t, t.pending[0].token);
    t.pending = [];
    this.save();
    return { ok: true };
  }

  closeTable(tableId, reason = 'paid') {
    const t = this.table(tableId);
    if (!t) return { ok: false, status: 404, error: 'invalid table' };
    this._close(t, reason);
    t.pending = [];
    this.save();
    return { ok: true };
  }

  reopen(tableId) {
    const t = this.table(tableId);
    if (!t || !t.session) return { ok: false, status: 404, error: 'no session' };
    t.session.status = 'open';
    t.session.billRequestedAt = null;
    this.save();
    return { ok: true };
  }

  voidOrder(tableId, orderId) {
    const t = this.table(tableId);
    if (!t || !t.session) return { ok: false, status: 404, error: 'no session' };
    t.session.orders = t.session.orders.filter((o) => o.id !== orderId);
    this.save();
    return { ok: true };
  }
}

module.exports = { Store, sha };
