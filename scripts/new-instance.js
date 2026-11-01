// Prints the environment variables for a new deployed instance of this app.
// Usage: npm run instance -- biryani-house
const crypto = require('crypto');
const { listBrands, loadBrand } = require('../src/brand');

const id = process.argv[2];
if (!id || !listBrands().includes(id)) {
  console.error(`Usage: npm run instance -- <brand>\nBrands: ${listBrands().join(', ')}`);
  process.exit(1);
}
const b = loadBrand(id, {});
console.log(`# ${b.name}: set these on its own hosting project (same repo, same branch)
BRAND=${id}
ADMIN_PASSWORD=${crypto.randomBytes(9).toString('base64url')}
QR_SECRET=${crypto.randomBytes(16).toString('hex')}
COOKIE_SECURE=1
# BASE_URL=https://your-permanent-domain   (set before printing QR codes)
# GOOGLE_REVIEW_URL=...   RESTAURANT_NAME=...   DEMO_MODE=1 for a public sandbox`);
