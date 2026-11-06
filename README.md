# Aventas-Pay

Canonical checkout-session and automated payment verification core for the Aventas Discord bot, website, and frontend dashboard.

All components are strictly consolidated into three clear directories:

- **`website/`**: Unified payment server, checkout session management, product persistence (`/api/products`), dynamic decimal offset allocation (`.01`–`.49`), Slice Bank email parser, pure TLS IMAP Gmail watcher (polled strictly every 5 seconds), 5-point verification, atomic confirmation, admin API endpoints, and SQLite/D1 migrations.
- **`frontend/`**: Vite + React Admin Dashboard & Embed Engine:
  - Full Admin Dashboard: Dashboard (`/`), Products & Embeds (`/products`), Transactions (`/transactions`), Orders (`/orders`), Emails (`/emails`), Analytics (`/analytics`), Manual Review (`/manual-review`), Refunds (`/refunds`), and Settings (`/settings`).
  - Product Creation & Embed Generator: create products and copy responsive `<iframe>` code, 1-click popup buy buttons, direct pay URLs, and JavaScript `postMessage` listeners.
  - Direct Customer Checkout (`/pay/:productId` & `/checkout/:token`): interactive UPI QR code generator, live status polling, copy VPA/amount buttons, mobile deep linking, and built-in Slice Bank simulator.
  - IFrame Embed Widget (`/embed/:productId`): compact, borderless checkout widget designed to drop into any external website with automatic `postMessage({ event: 'aventas:paid', ... })` notification.
- **`bot/`**: Python async checkout client (`avantas_checkout`), order facts validation, server-to-server verification (`verify_checkout_session`), and test suite.

---

## Architecture & Workflow

```
1. Product or Order Created
   └─ Merchant creates product in dashboard or bot initiates order
   └─ Backend allocates unique collision-free decimal paise offset (e.g. ₹499.14)
   └─ Generates UPI URI (cvvbypasser@slc), QR code, and real-time checkout token

2. Merchant Integrates Checkout into Site
   └─ Drops embed code into any site:
      <iframe src="https://pay.example.com/embed/prod_123" width="420" height="640"></iframe>
   └─ Or uses 1-click buy button popup, or shares direct /pay/prod_123 link

3. Customer Pays via UPI App
   └─ Customer scans QR with Google Pay, PhonePe, Paytm, or CRED
   └─ Transfers exact amount (₹499.14) to Slice VPA cvvbypasser@slc
   └─ Slice Bank issues notification email:
      "Received ₹499.14 from Rahul Sharma via UPI. UPI Ref No / RRN: 629401841605..."

4. 5-Second Automated IMAP Ingestion & Verification
   └─ Background daemon checks Gmail IMAP TLS (imap.gmail.com:993) every 5 seconds
   └─ Decodes MIME + quoted-printable body, validates sender (noreply@slice.bank.in)
   └─ Matches exact decimal paise offset to pending order in active 10-minute time window
   └─ Executes 5-point security check: sender authentication, duplicate RRN, duplicate Gmail msg-ID, status check, time-window validity
   └─ Atomically marks order as SUCCESS / PAID with UTR and payer details

5. Customer & Merchant Notified in Real-Time
   └─ Customer screen immediately transitions to green "Payment Confirmed!"
   └─ Embed iframe fires postMessage({ event: 'aventas:paid', orderId, utr, amount }, '*')
   └─ Merchant's parent website unlocks digital download, delivers Discord role, or redirects!
```

---

## Local Verification & Testing

### 1. Website (Node.js)
```sh
cd website
npm install
npm run typecheck
node --experimental-strip-types --test test/payment.pipeline.test.ts
npm start # runs unified backend on http://localhost:4000
```

### 2. Frontend (Vite + React Admin & Checkout)
```sh
cd frontend
npm install
npm run typecheck
npm run build
npm run dev # launches frontend at http://localhost:5173
```

### 3. Bot (Python Async Client)
```sh
cd bot
python -m pytest
```

---

## Dual Account & Gmail 5s Monitor Configuration

Configure primary and backup accounts in `website/config/accounts.json` or through the admin dashboard (`/settings`):

```json
{
  "active": 1,
  "max_decimal_offset": 49,
  "poll_interval_seconds": 5,
  "account_1": {
    "email": "mxybeakxsh@gmail.com",
    "app_password": "ddke sckv icfe lnuu",
    "upi_id": "cvvbypasser@slc"
  },
  "account_2": {
    "email": "",
    "app_password": "",
    "upi_id": ""
  }
}
```

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_BASE_URL` / `VITE_PUBLIC_BASE_URL` | `http://localhost:4000` | Canonical public base URL for checkout links, embed iframes, and QR codes. |
| `ALLOW_DB_RESET` / `VITE_ALLOW_DB_RESET` | `false` | Security gate required to enable the "Clear Whole Database" action in Settings. |
| `DEMO_MODE` | `false` | When `true`, automated testing/screenshot scripts can inject mock records. Keep `false` in production. |
| `PORT` | `4000` | Port for unified server delivery (API + frontend). |



---

## Production Deployment & Security Recommendations

### HTTPS & Environment Configuration
In production environments, ensure all customer checkouts and dashboard routes are served behind HTTPS with trusted TLS certificates:
- Set `VITE_PUBLIC_BASE_URL` in your frontend environment (e.g. `VITE_PUBLIC_BASE_URL=https://pay.yourdomain.com`). This ensures generated iframe embeds, customer links, and QR deep-links resolve with the correct canonical domain instead of local ports.
- Ensure reverse proxies (Nginx, Caddy, Cloudflare) pass the `X-Forwarded-Proto: https` and `X-Forwarded-Host` headers to the Node backend.

### Security Headers & IFrame Embedding
- **`X-Frame-Options` & `Content-Security-Policy: frame-ancestors`**:
  - The direct checkout route (`/pay/:id`) and admin dashboard (`/`) should enforce strict clickjacking protection (`X-Frame-Options: DENY`).
  - The embed route (`/embed/:id`) is intentionally designed for embedding into merchant storefronts. Configure `frame-ancestors 'self' https://yourstore.com` or authorized merchant origins to prevent unauthorized framing.
- **Content Security Policy (CSP)**:
  - Enforce restrictive script sources (`script-src 'self'`) and image sources (`img-src 'self' data: https:`).
- **Admin Secret Key Protection**:
  - The universal admin key protects all financial and settlement data. Never expose `accounts.json` or SQLite database files to public web roots.
