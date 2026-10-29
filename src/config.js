const path = require('path');
const crypto = require('crypto');

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

module.exports = {
  port: num(process.env.PORT, 3000),
  // Public base URL that QR codes point to, e.g. https://menu.myrestaurant.com
  baseUrlSet: Boolean(process.env.BASE_URL),
  baseUrl: (process.env.BASE_URL || `http://localhost:${num(process.env.PORT, 3000)}`).replace(/\/$/, ''),
  tableCount: num(process.env.TABLE_COUNT, 12),
  taxPercent: num(process.env.TAX_PERCENT, 5),
  // No built-in default password: if unset, a random one is generated per start and printed once.
  adminPassword: process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url'),
  adminPasswordGenerated: !process.env.ADMIN_PASSWORD,
  maxTables: 200,
  // Behind a reverse proxy / Vercel the client IP comes from X-Forwarded-For.
  trustProxy: process.env.TRUST_PROXY === '1' || Boolean(process.env.VERCEL),
  // If set to "1" the first scan on a free table opens it immediately.
  // Default is staff-approved seating, so a leftover/photographed QR can't open a table remotely.
  autoSeat: process.env.AUTO_SEAT === '1',
  sessionIdleHours: num(process.env.SESSION_IDLE_HOURS, 4),
  qrSecret: process.env.QR_SECRET || '',
  stateFile: process.env.STATE_FILE || path.join(__dirname, '..', 'data', 'state.json'),
  timezone: process.env.TZ_NAME || 'Asia/Kolkata',
  googleReviewUrl: process.env.GOOGLE_REVIEW_URL || '',
  restaurantName: process.env.RESTAURANT_NAME || 'our restaurant',
  requireContact: process.env.REQUIRE_CONTACT === '1',
  cookieSecure: process.env.COOKIE_SECURE === '1',
};
