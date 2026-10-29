// Generates printable QR codes: qr/counter.svg and qr/table-<n>.svg
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const config = require('../src/config');
const { Store } = require('../src/store');

(async () => {
  const store = new Store();
  const dir = path.join(__dirname, '..', 'qr');
  fs.mkdirSync(dir, { recursive: true });
  const make = async (file, url) => { fs.writeFileSync(path.join(dir, file), await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })); console.log(file.padEnd(14), url); };
  await make('counter.svg', `${config.baseUrl}/menu`);
  for (let i = 1; i <= config.tableCount; i++) await make(`table-${i}.svg`, `${config.baseUrl}/t/${i}?s=${store.sign(i)}`);
  console.log('\nKeep QR_SECRET (or data/state.json) stable — changing it invalidates printed table QRs.');
})();
