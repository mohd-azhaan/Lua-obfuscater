# LuaObf API — Production Backend

Secure, rate-limited API key & billing system for a Lua obfuscation SaaS.

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 (LTS) |
| Framework | Express 4 |
| Database | PostgreSQL 15 |
| Auth | JWT (HS256) + bcrypt |
| Billing | Stripe Subscriptions + Webhooks |
| Deployment | Railway |

---

## Architecture Overview

```
Client
  │
  ├─ POST /signup  /login            → JWT issued
  ├─ POST /create-api-key            → requires JWT
  ├─ DELETE /revoke-api-key/:prefix  → requires JWT
  │
  ├─ POST /obfuscate                 → requires X-API-Key
  │      └── validateApiKey middleware
  │            ├── hash key → lookup in api_keys
  │            ├── check is_revoked, is_banned
  │            ├── downgrade expired paid plans
  │            └── check daily_usage counter
  │
  ├─ GET  /usage                     → requires JWT
  ├─ POST /subscribe                 → requires JWT → Stripe Checkout
  ├─ POST /billing-portal            → requires JWT → Stripe Portal
  └─ POST /webhook                   → Stripe signature verified
```

---

## Database Schema

```
users            – accounts, plan, Stripe IDs
api_keys         – key_hash (SHA-256), prefix, revocation flag
daily_usage      – upserted counter per (user, date)
usage_log        – metadata only (NO code stored)
abuse_flags      – IP + user flagging log
webhook_events   – Stripe idempotency guard
```

---

## Plans

| Plan | Price | Requests/day |
|------|-------|-------------|
| free | $0 | 10 |
| basic | $1/month | 400 |

Daily limits reset at **midnight UTC**.

---

## Local Development Setup

### Prerequisites
- Node.js ≥ 18
- PostgreSQL 15 running locally
- Stripe account (test mode)

### 1. Clone and install

```bash
git clone https://github.com/yourname/luaobf-api
cd luaobf-api
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
NODE_ENV=development
PORT=3000

# Local Postgres
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/luaobf

# Generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=your_64_byte_hex_secret

# Stripe test keys (from dashboard.stripe.com → Developers → API keys)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...         # from `stripe listen` output
STRIPE_BASIC_PRICE_ID=price_...         # create in Stripe dashboard

# Limits
FREE_DAILY_LIMIT=10
BASIC_DAILY_LIMIT=400
MAX_CODE_BYTES=131072

ALLOWED_ORIGINS=http://localhost:5173
```

### 3. Run migrations

```bash
npm run migrate
```

### 4. Start Stripe webhook listener (separate terminal)

```bash
# Install Stripe CLI: https://stripe.com/docs/stripe-cli
stripe listen --forward-to localhost:3000/webhook
# Copy the whsec_... it prints → paste into STRIPE_WEBHOOK_SECRET
```

### 5. Start server

```bash
npm run dev
```

Server runs at `http://localhost:3000`

---

## Stripe Setup

### Create the Basic plan price

1. Go to **Stripe Dashboard → Products → Add Product**
2. Name: `LuaObf Basic`
3. Pricing: **Recurring**, $1.00/month
4. Copy the **Price ID** (`price_...`) → set as `STRIPE_BASIC_PRICE_ID`

### Webhook events to enable

In the Stripe Dashboard → Webhooks → Add endpoint:

- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.deleted`
- `customer.subscription.updated`

---

## Railway Deployment

### Step 1 — Create Railway project

```bash
# Install Railway CLI
npm install -g @railway/cli

railway login
railway init          # choose "Empty Project"
```

### Step 2 — Add PostgreSQL

```
Railway Dashboard → New → Database → PostgreSQL
```

Railway automatically injects `DATABASE_URL` into your service. ✅

### Step 3 — Set environment variables

```bash
railway variables set NODE_ENV=production
railway variables set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
railway variables set STRIPE_SECRET_KEY=sk_live_...
railway variables set STRIPE_WEBHOOK_SECRET=whsec_...
railway variables set STRIPE_BASIC_PRICE_ID=price_...
railway variables set FREE_DAILY_LIMIT=10
railway variables set BASIC_DAILY_LIMIT=400
railway variables set MAX_CODE_BYTES=131072
railway variables set ALLOWED_ORIGINS=https://yourdomain.com
```

### Step 4 — Deploy

```bash
railway up
```

Railway detects the `Dockerfile` and builds automatically.

The `startCommand` in `railway.toml` runs migrations then starts the server:
```
node src/db/migrate.js && node src/server.js
```

### Step 5 — Set Stripe production webhook

1. Railway Dashboard → your service → **Settings → Domains** → copy your URL
2. Stripe Dashboard → Webhooks → **Add endpoint**
3. URL: `https://your-app.railway.app/webhook`
4. Events: all listed above
5. Copy signing secret → `railway variables set STRIPE_WEBHOOK_SECRET=whsec_...`

### Step 6 — Verify

```bash
curl https://your-app.railway.app/health
# → {"status":"ok","db":"connected"}
```

---

## API Reference

### Authentication

All auth routes return a JWT. Pass it as:
```
Authorization: Bearer <token>
```

API key routes use:
```
X-API-Key: luaobf_<prefix>_<secret>
```

---

### POST /signup

```json
{
  "email": "dev@example.com",
  "password": "SecurePass1"
}
```

**Response 201:**
```json
{
  "token": "eyJ...",
  "user": { "id": "uuid", "email": "...", "plan": "free" }
}
```

---

### POST /login

```json
{ "email": "dev@example.com", "password": "SecurePass1" }
```

**Response 200:**
```json
{ "token": "eyJ...", "user": { ... } }
```

---

### POST /create-api-key *(JWT required)*

```json
{ "label": "production" }
```

**Response 201:**
```json
{
  "message": "API key created – save this now, it will not be shown again",
  "api_key": "luaobf_a1b2c3d4_e5f6...",
  "prefix": "a1b2c3d4",
  "label": "production"
}
```

⚠️ **The raw key is shown exactly once.** Store it securely (e.g. `.env` file or secrets manager).

---

### DELETE /revoke-api-key/:prefix *(JWT required)*

```
DELETE /revoke-api-key/a1b2c3d4
```

**Response 200:**
```json
{ "message": "API key revoked" }
```

---

### POST /obfuscate *(API key required)*

```json
{
  "code": "local x = 42\nprint(x)",
  "options": {
    "renameVars": true,
    "encodeStrings": true,
    "encodeNumbers": true
  }
}
```

**Response 200:**
```json
{
  "obfuscated": "local _l0 = (6+36)\n-- 3f8a1c...\nprint(_l0)",
  "meta": {
    "input_bytes": 22,
    "output_bytes": 48,
    "duration_ms": 3,
    "requests_remaining": 9
  }
}
```

**Rate limit headers:**
```
X-RateLimit-Limit: 10
X-RateLimit-Used: 1
X-RateLimit-Remaining: 9
X-RateLimit-Reset: midnight UTC
```

**Error responses:**
- `401` — invalid / missing API key
- `403` — account suspended
- `422` — payload too large, not valid Lua, validation error
- `429` — daily limit reached

---

### GET /usage *(JWT required)*

```json
{
  "plan": "free",
  "daily_limit": 10,
  "used_today": 3,
  "remaining_today": 7,
  "resets_at": "midnight UTC",
  "history_30d": [
    { "usage_date": "2025-01-15", "request_count": 8 }
  ],
  "active_keys": [
    { "key_prefix": "a1b2c3d4", "label": "production", "last_used_at": "..." }
  ]
}
```

---

### POST /subscribe *(JWT required)*

```json
{ "plan": "basic" }
```

**Response 200:**
```json
{
  "checkout_url": "https://checkout.stripe.com/pay/cs_...",
  "session_id": "cs_..."
}
```

Redirect the user to `checkout_url`. After payment, Stripe fires the webhook which upgrades the user's plan automatically.

---

### POST /billing-portal *(JWT required)*

Returns a Stripe Customer Portal URL where users can:
- View invoices
- Update payment method
- Cancel subscription

```json
{ "portal_url": "https://billing.stripe.com/session/..." }
```

---

### POST /webhook

Stripe-only endpoint. Validates HMAC signature before processing.

Handled events:
- `checkout.session.completed` → activates plan
- `invoice.paid` → renews plan expiry
- `invoice.payment_failed` → sets `past_due`
- `customer.subscription.deleted` → downgrades to free
- `customer.subscription.updated` → syncs status

---

## Security Design

| Concern | Implementation |
|---------|---------------|
| Passwords | bcrypt, 12 rounds |
| API keys | SHA-256 hashed at rest, never stored raw |
| JWT | HS256, configurable expiry (default 7d) |
| Timing attacks | `crypto.timingSafeEqual` for key comparison; dummy bcrypt on failed login |
| SQL injection | Parameterised queries throughout (`pg` library) |
| Code privacy | Input code never written to disk or logs |
| Input size | Hard cap at 128 KB (configurable) |
| Rate limiting | Per-IP (global) + per-key (daily) + per-endpoint (auth) |
| Abuse detection | Request-rate spike, size spike, auto-ban on repeat flags |
| Webhooks | Stripe HMAC signature verified; idempotency table |
| Headers | Helmet.js: CSP, HSTS, X-Frame-Options, etc. |

---

## Production Checklist

- [ ] `JWT_SECRET` is 64+ bytes of random data
- [ ] `NODE_ENV=production`
- [ ] PostgreSQL SSL enabled (`rejectUnauthorized: false` for Railway)
- [ ] `ALLOWED_ORIGINS` set to your frontend domain(s)
- [ ] Stripe **live** keys (not test keys)
- [ ] Webhook endpoint verified in Stripe dashboard
- [ ] Health check passing: `GET /health`
- [ ] Log rotation configured (Winston DailyRotateFile)
- [ ] Database backups enabled in Railway

---

## Directory Structure

```
luaobf-api/
├── migrations/
│   └── 001_initial.sql      ← full DB schema
├── src/
│   ├── db/
│   │   ├── index.js         ← pg pool + query helper
│   │   └── migrate.js       ← migration runner
│   ├── middleware/
│   │   ├── auth.js          ← JWT validation
│   │   ├── apiKey.js        ← API key validation + quota
│   │   ├── rateLimiter.js   ← express-rate-limit configs
│   │   └── validate.js      ← express-validator helper
│   ├── routes/
│   │   ├── auth.js          ← /signup, /login
│   │   ├── keys.js          ← /create-api-key, /revoke-api-key
│   │   ├── obfuscate.js     ← /obfuscate
│   │   ├── usage.js         ← /usage
│   │   └── billing.js       ← /subscribe, /billing-portal, /webhook
│   ├── services/
│   │   ├── obfuscator.js    ← core transform logic
│   │   └── abuse.js         ← abuse detection
│   ├── utils/
│   │   ├── crypto.js        ← key generation + hashing
│   │   └── logger.js        ← Winston logger
│   └── server.js            ← Express app bootstrap
├── .env.example
├── Dockerfile
├── railway.toml
└── package.json
```
