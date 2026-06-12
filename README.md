# TradeLoop

A multi-party trading card exchange: members list cards they have and want,
a matching engine finds closed loops (A→B→C→A) where everyone gets what they
want, all cards ship through one trusted hub (you), and Loop Credit — a
closed economy with no cash-out — squares any uneven trade.

## What's inside

- **Accounts** — register/login; the FIRST account created becomes hub admin
- **Binder** — have/want lists per member, with live card search
- **Card search** — proxies JustTCG (real prices + market activity) with a
  daily-budget guard and local caching; works offline on demo cards if no key
- **Matching engine** — finds direct swaps and 3–4-way loops, including
  "velocity mode" (match me with ANY fast-moving card — built for stores)
- **Trades & hub console** — lock a route, packages ship to the hub, admin
  checks them in, verifies condition, releases; cards change owners
- **Loop Credit ledger** — every settlement and deposit is a ledger row;
  balances are sums, so your books always reconcile. Deposits are SIMULATED
  until you connect a payment processor.

## Run it on your computer

1. Install Node.js LTS from https://nodejs.org (you already have this)
2. In PowerShell, go to this folder:  `cd path\to\tradeloop`
3. Install dependencies:  `npm install`
4. (Optional) live card data: copy `.env.example` to `.env` and put your
   JustTCG key in it
5. Start:  `npm start`
6. Open http://localhost:3000 — create your account first so you're the admin

The database is a single file (`tradeloop.db`) created automatically.

## Put it on the internet (Render — free tier)

1. Put this folder on GitHub (create a repo, upload these files).
   IMPORTANT: do NOT upload `.env` or `tradeloop.db` (see .gitignore).
2. Sign up at https://render.com → New → Web Service → connect the repo
3. Settings: Build command `npm install` · Start command `npm start`
4. Add environment variables in Render's dashboard:
   - `SESSION_SECRET` = any long random string
   - `JUSTTCG_API_KEY` = your key (optional)
5. Deploy. Render gives you a public URL like `https://tradeloop.onrender.com`
   that anyone can visit.

Note: on Render's free tier the disk is not persistent — the SQLite database
resets on redeploys. Fine for showing friends; before real users, either add
a Render persistent disk (paid) or move to Postgres (I can help with that).

## Honest production checklist (before real money/cards)

- [ ] Real payments (Stripe) replacing simulated deposits
- [ ] Postgres instead of SQLite; persistent session store
- [ ] Email verification + password reset
- [ ] Terms of service + closed-loop credit legal review (gift card /
      stored-value rules vary by state)
- [ ] Shipping labels & tracking integration for the hub
- [ ] Rate limiting and HTTPS-only cookies
