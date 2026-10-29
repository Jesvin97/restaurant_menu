const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const menu = require('./menu.json');

const itemsById = new Map(menu.items.map((i) => [i.id, i]));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

class Store {
  constructor(file = config.stateFile, opts = {}) {
    this.file = file;
    this.persist = opts.persist !== false;
    this.now = opts.now || (() => Date.now());
    this.state = { secret: '', tables: {}, history: [], customers: {}, seq: 0 };
    if (this.persist && fs.existsSync(file)) {
      try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* start fresh */ }
    }
    if (!this.state.secret) this.state.secret = config.qrSecret || rid(16);
    if (config.qrSecret) this.state.secret = config.qrSecret;
    for (let i = 1; i <= config.tableCount; i++) {
      this.state.tables[i] = this.state.tables[i] || { session: null, pending: [] };
    }
    this.save();
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
    return { state: s.status === 'billed' ? 'billed' : 'active', code: s.code, orders: s.orders, bill: this.bill(s), customer: s.customer ? { name: s.customer.name } : null, requireContact: config.requireContact };
  }

  placeOrder(tableId, token, lines) {
    const t = this.table(tableId);
    if (!t) return { ok: false, status: 404, error: 'invalid table' };
    this._expire(t);
    const s = t.session;
    if (!s || !s.members.includes(sha(token || ''))) return { ok: false, status: 403, error: 'Your table session is not active. Please scan the QR again.' };
    if (s.status !== 'open') return { ok: false, status: 409, error: 'The bill has been generated; ordering is closed.' };
    if (!Array.isArray(lines) || !lines.length || lines.length > 60) return { ok: false, status: 400, error: 'Empty order' };
    const merged = new Map();
    for (const l of lines) {
      const item = itemsById.get(Number(l && l.id));
      const qty = Number(l && l.qty);
      if (!item || !Number.isInteger(qty) || qty < 1 || qty > 20) return { ok: false, status: 400, error: 'Invalid item' };
      merged.set(item.id, (merged.get(item.id) || 0) + qty);
    }
    // Prices always come from the server menu, never from the client.
    const items = [...merged].map(([id, qty]) => {
      const i = itemsById.get(id);
      return { id, name: i.name, veg: i.veg, price: i.price, qty };
    });
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
    s.status = 'billed';
    s.lastActive = this.now();
    this.save();
    return { ok: true, bill: this.bill(s) };
  }

  bill(s) {
    const lines = new Map();
    for (const o of s.orders) for (const i of o.items) {
      const l = lines.get(i.id) || { ...i, qty: 0 };
      l.qty += i.qty;
      lines.set(i.id, l);
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
    return { orders, lastSeq: this.state.seq, waiting: Object.entries(this.state.tables).filter(([, t]) => t.pending.length).map(([id]) => id) };
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

module.exports = { Store, menu, sha };
