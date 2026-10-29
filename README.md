# Restaurant QR Menu & Table Ordering

Zero-framework Node app (only dependency: `qrcode`, used to print QR codes).

## Two kinds of QR

| QR | URL | Behaviour |
|----|-----|-----------|
| **Counter** | `/menu` | Read-only menu: prices, veg/non-veg filter, sections (Breakfast, Lunch, Biryani, Breads, Grills, Chinese, Desserts, Beverages), search. |
| **Table** (static, one per table) | `/t/<n>?s=<signature>` | Ordering. Orders attach to that table; cart -> one click **Order & get bill** (GST included). |

## Why a leaving guest can't reorder on the same URL

The table QR is static, so the URL alone never grants access. Ordering needs a **table session**, and:

1. **Staff opens the table.** A scan on a free table only creates a "guest waiting" request; staff click *Seat guest* in `/admin`. A photo of the QR can't open a table remotely. (`AUTO_SEAT=1` skips this for small/trusted setups.)
2. The session is tied to the **device cookie** that was seated. Other phones at the table must enter a 4-digit **table code** (5 wrong tries -> 5-min lockout).
3. **Bill generated -> ordering locks.** Staff *Paid & close* **destroys the session**, so every device token from it is dead. The next party gets a brand-new session and the old phone is not a member (it would need the new code).
4. Sessions also **expire after idle** (`SESSION_IDLE_HOURS`, default 4).
5. Prices are always taken from the server menu; table URLs are HMAC-signed so tables can't be forged.

## Run

```bash
npm install
ADMIN_PASSWORD=choose-one BASE_URL=https://your.domain QR_SECRET=long-random npm start
npm run qr     # writes printable SVGs to qr/ (counter.svg, table-1.svg ...)
npm test
```

## Staff dashboard (`/admin`)

- **Live orders** - every table's orders land here within ~3 s, with a beep. Move each through *New -> Sent to kitchen -> Served*; guests see the status on their phone. Leave this open on the counter screen (click once on the page so the browser allows the beep).
- **Tables** - seat waiting guests, void an order, reopen a bill, *Paid & close*.
- **Customers** - guests who gave name + number when the bill was generated (the bill is printed in their name).

## Guest details, reviews and ads

At "Get bill" the guest is asked for name and mobile (skippable unless `REQUIRE_CONTACT=1`) plus two **separate, unticked-by-default** consents: a Google-review message, and offers. Rules built in:

- Numbers are only used for the purpose the guest ticked; a later visit's choice overrides the earlier one (withdrawal works).
- *Customers -> Send review link* opens WhatsApp with a pre-filled message (needs `GOOGLE_REVIEW_URL`); staff press send. No SMS/WhatsApp provider is wired in - plug one in later if you want automatic sending.
- CSV exports are split by consent: **offers-consented** (use for Meta/Google ad custom audiences - they match on hashed phone numbers), review-consented, and all (billing records only). Cells are protected against spreadsheet formula injection.
- Staff can **delete** a guest's details on request. Check local rules (India's DPDP Act, TRAI rules for promotional SMS) before running campaigns.

Env: `PORT`, `BASE_URL`, `TABLE_COUNT` (12), `TAX_PERCENT` (5), `ADMIN_PASSWORD`, `AUTO_SEAT`, `SESSION_IDLE_HOURS`, `QR_SECRET`, `STATE_FILE`, `GOOGLE_REVIEW_URL`, `RESTAURANT_NAME`, `REQUIRE_CONTACT`, `COOKIE_SECURE=1` (set behind HTTPS).
Keep `QR_SECRET` stable: changing it invalidates printed table QRs. Edit the menu in `src/menu.json`.

Notes: state is a single JSON file (single process); serve over HTTPS in production.
