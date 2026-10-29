# Restaurant QR Menu & Table Ordering

Zero-framework Node app (only dependency: `qrcode`, used to print QR codes).

## Two kinds of QR

| QR | URL | Behaviour |
|----|-----|-----------|
| **Counter** | `/menu` | Read-only menu: prices, veg/non-veg filter, sections (Breakfast, Lunch, Biryani, Breads, Grills, Chinese, Desserts, Beverages), search. |
| **Table** (static, one per table) | `/t/<n>?s=<signature>` | Ordering. Orders attach to that table. Guests build a cart, review it, and **Send to kitchen**; they only ever see dish names and quantities (no prices/totals). When done they tap **Ask for bill**; the counter is notified and generates the bill, which then appears on the guest's phone. |

## Why a leaving guest can't reorder on the same URL

The table QR is static, so the URL alone never grants access. Ordering needs a **table session**, and:

1. **Staff opens the table.** A scan on a free table only creates a "guest waiting" request and shows the guest a 3-character **pairing code**. Staff seat the device whose code the guest at the table reads out, so a request from someone with a photo of the QR can't become the host just by being first. (`AUTO_SEAT=1` skips this for small/trusted setups.)
2. The session is tied to the **device cookie** that was seated. Other phones at the table must enter a 4-digit **table code** (5 wrong tries -> 5-min lockout).
3. **Bill generated -> ordering locks.** Staff *Paid & close* **destroys the session**, so every device token from it is dead. The next party gets a brand-new session and the old phone is not a member (it would need the new code).
4. Sessions also **expire after idle** (`SESSION_IDLE_HOURS`, default 4).
5. Prices are always taken from the server menu; table URLs are HMAC-signed so tables can't be forged.

## Run

```bash
npm install
ADMIN_PASSWORD=choose-one BASE_URL=https://your.domain QR_SECRET=long-random npm start
npm run qr     # writes printable SVGs to qr/ (counter.svg, table-1.svg ...)
npm test         # 39 unit + HTTP tests (incl. security, fuzz, concurrency)
npm run lint
npm run e2e      # real-browser phone-size run (needs Playwright); SHOTS=dir saves screenshots
```

## Menu management (Staff -> Menu tab)

- **Out of stock:** untick a dish and it disappears from every guest menu immediately (orders for it are rejected). The next day the Orders tab asks "show it again?": *Yes* restores it, *No* keeps it hidden and it isn't asked again (re-enable any time from the Menu tab).
- **Excel upload:** columns `Category, Name, Description, Type (Veg/Non-Veg), Half, Full` (or a single `Price`), `Allergens` (comma separated, e.g. `dairy, gluten`). *Check file* previews and reports row-level errors; *Replace my menu* applies it. A CSV template is downloadable. On a normal server the imported menu is saved in the state file.
- **Allergy filter:** guests tap *Allergies*, choose what to avoid, and dishes whose Allergens column lists it are hidden (remembered on their phone). It relies on the kitchen's data, and the UI says so.

## Staff dashboard (`/admin`)

- **Orders** - every table's orders land here within ~3 s, with a beep. Move each through *New -> Sent to kitchen -> Served*; guests see the status on their phone. Leave this open on the counter screen (click once on the page so the browser allows the beep).
- **Tables** - seat waiting guests, void an order, reopen a bill, *Paid & close*.
- **Customers** - guests who gave name + number when the bill was generated (the bill is printed in their name).

## Guest details, reviews and ads

At "Get bill" the guest is asked for name and mobile (skippable unless `REQUIRE_CONTACT=1`) plus two **separate, unticked-by-default** consents: a Google-review message, and offers. Rules built in:

- Numbers are only used for the purpose the guest ticked; a later visit's choice overrides the earlier one (withdrawal works).
- *Customers -> Send review link* opens WhatsApp with a pre-filled message (needs `GOOGLE_REVIEW_URL`); staff press send. No SMS/WhatsApp provider is wired in - plug one in later if you want automatic sending.
- CSV exports are split by consent: **offers-consented** (use for Meta/Google ad custom audiences - they match on hashed phone numbers), review-consented, and all (billing records only). Cells are protected against spreadsheet formula injection.
- Staff can **delete** a guest's details on request. Check local rules (India's DPDP Act, TRAI rules for promotional SMS) before running campaigns.

## Staff access & security

- Staff sign in at `/admin` with `ADMIN_PASSWORD`. **There is no default password**: if unset, a random one is generated and printed in the server log for that run.
- Sign-in returns a 12-hour signed token (the password isn't kept in the browser). 8 wrong attempts lock that IP out for 10 minutes, even for the right password. Changing the password signs everyone out.
- Strict CSP (no inline script/style), `X-Frame-Options: DENY`, `nosniff`, no-referrer-style policies; cross-site POSTs are refused (Origin check) and JSON-only bodies block form-based CSRF.
- Guest POSTs are rate limited per IP; pairing requests per table are capped; the state file (guest phone numbers) is written `0600`, and a corrupt file is set aside rather than overwritten.
- Behind a proxy set `TRUST_PROXY=1` (automatic on Vercel) so rate limits see the real client IP.
- Limits you should know: rate limits are per server instance; uploaded `.xlsx` files are parsed by `exceljs` (staff-only, 3 MB cap) which carries a moderate `uuid` advisory in a code path this app doesn't use.

## Printing QR codes once

The table QR is permanent: it encodes `<your address>/t/<n>?s=<signature>`, and the signature is derived from `QR_SECRET` and the table number only. So a printed code keeps working through restarts, redeploys, wiped data, and removing then re-adding a table, as long as two things stay the same:

1. **`QR_SECRET`** - set it on the server before printing and never change it. (If it changes, the server warns, and *Setup* shows a permanent notice with the date.)
2. **The address** - it is part of the printed code. Set `BASE_URL` to your permanent domain *before* printing; don't print from a temporary `*.vercel.app` or `localhost` address. If you later move domains, keep the old one redirecting to the new one.

*Staff -> Setup -> Before you print* checks all of this and shows the secret's fingerprint. The codes themselves are safe to leave on tables: scanning one only asks staff to seat the guest, it never grants access.

## Number of tables

*Staff -> Setup* has a stepper for the number of tables (1-200) and shows every QR (counter + each table) to print. Adding is instant; removing only works for free tables from the highest number down. `TABLE_COUNT` is just the starting value.

Env: `PORT`, `BASE_URL`, `TABLE_COUNT` (12), `TAX_PERCENT` (5), `ADMIN_PASSWORD`, `TRUST_PROXY`, `AUTO_SEAT`, `SESSION_IDLE_HOURS`, `QR_SECRET`, `STATE_FILE`, `GOOGLE_REVIEW_URL`, `RESTAURANT_NAME`, `REQUIRE_CONTACT`, `COOKIE_SECURE=1` (set behind HTTPS).
Keep `QR_SECRET` stable: changing it invalidates printed table QRs. Edit the menu in `src/menu.json`.

Notes: state is a single JSON file (single process); serve over HTTPS in production.
