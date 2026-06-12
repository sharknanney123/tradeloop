/* ===================================================================
   TradeLoop — server (Express + built-in SQLite)
   Run:  node server.js      → http://localhost:3000
   First registered account automatically becomes the hub admin.
   =================================================================== */
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const { db, isFast, balanceCents } = require("./db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 },
  })
);

const auth = (req, res, next) => (req.session.uid ? next() : res.status(401).json({ error: "Login required" }));
const admin = (req, res, next) => {
  const u = db.prepare("SELECT is_admin FROM users WHERE id=?").get(req.session.uid || 0);
  return u?.is_admin ? next() : res.status(403).json({ error: "Hub admin only" });
};
const me = (req) => db.prepare("SELECT id,email,name,is_admin,want_mode FROM users WHERE id=?").get(req.session.uid);

/* ----------------------------- auth ------------------------------ */
app.post("/api/register", (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: "email, password, name required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be 8+ characters" });
  const isFirst = db.prepare("SELECT COUNT(*) c FROM users").get().c === 0;
  try {
    const r = db
      .prepare("INSERT INTO users (email,pass_hash,name,is_admin) VALUES (?,?,?,?)")
      .run(email.toLowerCase().trim(), bcrypt.hashSync(password, 10), name.trim(), isFirst ? 1 : 0);
    req.session.uid = Number(r.lastInsertRowid);
    res.json({ user: me(req), note: isFirst ? "You are the hub admin." : undefined });
  } catch {
    res.status(400).json({ error: "That email is already registered" });
  }
});

app.post("/api/login", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE email=?").get((req.body.email || "").toLowerCase().trim());
  if (!u || !bcrypt.compareSync(req.body.password || "", u.pass_hash)) return res.status(401).json({ error: "Invalid email or password" });
  req.session.uid = u.id;
  res.json({ user: me(req) });
});

app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", auth, (req, res) => res.json({ user: me(req), balance_cents: balanceCents(req.session.uid) }));
app.post("/api/wantmode", auth, (req, res) => {
  const mode = req.body.mode === "velocity" ? "velocity" : "specific";
  db.prepare("UPDATE users SET want_mode=? WHERE id=?").run(mode, req.session.uid);
  res.json({ want_mode: mode });
});

/* ------------------- card search (JustTCG proxy) ------------------ */
let apiBudget = { used: 0, resetAt: nextMidnight() };
function nextMidnight() { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); }

app.get("/api/search", auth, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ cards: [], source: "none" });

  const local = db.prepare("SELECT * FROM cards WHERE name LIKE ? ORDER BY price_cents DESC LIMIT 20").all(`%${q}%`);
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) return res.json({ cards: local, source: "local", note: "Add JUSTTCG_API_KEY to .env for live search" });

  if (Date.now() > apiBudget.resetAt) apiBudget = { used: 0, resetAt: nextMidnight() };
  if (apiBudget.used >= 90) return res.json({ cards: local, source: "local-cache", note: "Daily JustTCG budget reached; serving cached cards" });

  try {
    const url = new URL("https://api.justtcg.com/v1/cards");
    url.searchParams.set("q", q);
    url.searchParams.set("condition", "Near Mint");
    const r = await fetch(url, { headers: { "x-api-key": key } });
    if (!r.ok) throw new Error(`JustTCG ${r.status}`);
    const json = await r.json();
    apiBudget.used = json._metadata ? (json._metadata.apiDailyLimit ?? 100) - (json._metadata.apiDailyRequestsRemaining ?? 0) : apiBudget.used + 1;

    const up = db.prepare(`INSERT INTO cards (id,name,set_name,game,number,rarity,tcgplayer_id,image_url,condition,printing,price_cents,changes_30d,change_pct_30d,source,fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'justtcg',datetime('now'))
      ON CONFLICT(id) DO UPDATE SET price_cents=excluded.price_cents, changes_30d=excluded.changes_30d, change_pct_30d=excluded.change_pct_30d, image_url=excluded.image_url, fetched_at=excluded.fetched_at`);
    const out = [];
    for (const c of json.data || []) {
      const v = c.variants?.[0];
      if (!v?.price) continue;
      const img = c.tcgplayerId ? `https://product-images.tcgplayer.com/fit-in/437x437/${c.tcgplayerId}.jpg` : null;
      up.run(c.id, c.name, c.set_name, c.game, c.number, c.rarity, String(c.tcgplayerId ?? ""), img, v.condition, v.printing,
        Math.round(v.price * 100), v.priceChangesCount30d ?? 0, v.priceChange30d ?? 0);
      out.push(db.prepare("SELECT * FROM cards WHERE id=?").get(c.id));
    }
    res.json({ cards: out.slice(0, 20), source: "justtcg" });
  } catch (e) {
    res.json({ cards: local, source: "local-fallback", note: `Live search failed (${e.message}); showing cached cards` });
  }
});

/* ----------------------------- binder ----------------------------- */
app.get("/api/binder", auth, (req, res) => {
  const rows = db.prepare("SELECT b.side, c.* FROM binder b JOIN cards c ON c.id=b.card_id WHERE b.user_id=?").all(req.session.uid);
  res.json({ have: rows.filter((r) => r.side === "have"), want: rows.filter((r) => r.side === "want") });
});

app.post("/api/binder", auth, (req, res) => {
  const { cardId, side } = req.body || {};
  if (!["have", "want"].includes(side)) return res.status(400).json({ error: "side must be have|want" });
  if (!db.prepare("SELECT 1 FROM cards WHERE id=?").get(cardId)) return res.status(404).json({ error: "Unknown card" });
  const other = side === "have" ? "want" : "have";
  if (db.prepare("SELECT 1 FROM binder WHERE user_id=? AND card_id=? AND side=?").get(req.session.uid, cardId, other))
    return res.status(400).json({ error: `Already in your ${other} list` });
  const existing = db.prepare("SELECT id FROM binder WHERE user_id=? AND card_id=? AND side=?").get(req.session.uid, cardId, side);
  if (existing) db.prepare("DELETE FROM binder WHERE id=?").run(existing.id);
  else db.prepare("INSERT INTO binder (user_id,card_id,side) VALUES (?,?,?)").run(req.session.uid, cardId, side);
  res.json({ ok: true, toggled: existing ? "removed" : "added" });
});

/* ------------------------------ board ----------------------------- */
app.get("/api/board", auth, (req, res) => {
  const cards = db.prepare(`
    SELECT c.*, 
      (SELECT GROUP_CONCAT(u.name) FROM binder b JOIN users u ON u.id=b.user_id WHERE b.card_id=c.id AND b.side='have') asks,
      (SELECT GROUP_CONCAT(u.name) FROM binder b JOIN users u ON u.id=b.user_id WHERE b.card_id=c.id AND b.side='want') bids
    FROM cards c
    WHERE EXISTS (SELECT 1 FROM binder b WHERE b.card_id=c.id)
    ORDER BY c.changes_30d DESC`).all();
  res.json({ cards: cards.map((c) => ({ ...c, fast: isFast(c) })) });
});

/* --------------------------- matching ----------------------------- */
function findRoutes() {
  const users = db.prepare("SELECT id,name,want_mode FROM users").all();
  const binderRows = db.prepare("SELECT user_id,card_id,side FROM binder").all();
  const cards = Object.fromEntries(db.prepare("SELECT * FROM cards").all().map((c) => [c.id, c]));
  const traders = users.map((u) => ({
    ...u,
    have: binderRows.filter((b) => b.user_id === u.id && b.side === "have").map((b) => b.card_id),
    want: binderRows.filter((b) => b.user_id === u.id && b.side === "want").map((b) => b.card_id),
  }));
  const wants = (t, cardId) =>
    t.want_mode === "velocity" ? isFast(cards[cardId]) && !t.have.includes(cardId) : t.want.includes(cardId);

  const edges = {};
  traders.forEach((a) => {
    edges[a.id] = [];
    traders.forEach((b) => {
      if (a.id === b.id) return;
      a.have.forEach((cardId) => { if (wants(b, cardId)) edges[a.id].push({ to: b.id, card: cardId }); });
    });
  });

  const routes = [], seen = new Set(), ids = traders.map((t) => t.id);
  const dfs = (start, cur, path, usedU, usedC) => {
    for (const e of edges[cur] || []) {
      if (usedC.has(e.card)) continue;
      if (e.to === start && path.length >= 1) {
        const route = [...path, { from: cur, to: e.to, card: e.card }];
        const key = route.map((s) => `${s.from}>${s.card}>${s.to}`).sort().join("|");
        if (!seen.has(key)) { seen.add(key); routes.push(route); }
        continue;
      }
      if (usedU.has(e.to) || path.length + 1 >= 4) continue;
      if (ids.indexOf(e.to) < ids.indexOf(start)) continue;
      usedU.add(e.to); usedC.add(e.card);
      dfs(start, e.to, [...path, { from: cur, to: e.to, card: e.card }], usedU, usedC);
      usedU.delete(e.to); usedC.delete(e.card);
    }
  };
  ids.forEach((id) => dfs(id, id, [], new Set([id]), new Set()));

  const nameOf = Object.fromEntries(traders.map((t) => [t.id, t.name]));
  return routes.slice(0, 12).map((route) => {
    const settle = {};
    route.forEach((s) => {
      const v = cards[s.card]?.price_cents ?? 0;
      settle[s.from] = (settle[s.from] || 0) - v;
      settle[s.to] = (settle[s.to] || 0) + v;
    });
    return {
      legs: route.map((s) => ({ ...s, fromName: nameOf[s.from], toName: nameOf[s.to], card: cards[s.card] })),
      settlement: Object.entries(settle).map(([uid, cents]) => ({ userId: +uid, name: nameOf[uid], cents })),
    };
  });
}

app.get("/api/matches", auth, (req, res) => res.json({ routes: findRoutes() }));

/* ----------------------------- trades ----------------------------- */
app.post("/api/trades/lock", auth, (req, res) => {
  const { legs } = req.body || {};
  if (!Array.isArray(legs) || legs.length < 2) return res.status(400).json({ error: "legs required" });
  if (!legs.some((l) => l.from === req.session.uid || l.to === req.session.uid))
    return res.status(403).json({ error: "You can only lock routes you are part of" });
  const t = db.prepare("INSERT INTO trades (status) VALUES ('locked')").run();
  const ins = db.prepare("INSERT INTO trade_legs (trade_id,from_user,to_user,card_id,value_cents) VALUES (?,?,?,?,?)");
  for (const l of legs) {
    const card = db.prepare("SELECT * FROM cards WHERE id=?").get(l.card?.id || l.card);
    if (!card) return res.status(400).json({ error: "Unknown card in route" });
    ins.run(Number(t.lastInsertRowid), l.from, l.to, card.id, card.price_cents);
  }
  res.json({ tradeId: Number(t.lastInsertRowid), status: "locked", note: "All parties now ship to the hub." });
});

const tradeView = (id) => ({
  trade: db.prepare("SELECT * FROM trades WHERE id=?").get(id),
  legs: db.prepare(`SELECT l.*, uf.name from_name, ut.name to_name, c.name card_name, c.rarity, c.set_name
    FROM trade_legs l JOIN users uf ON uf.id=l.from_user JOIN users ut ON ut.id=l.to_user JOIN cards c ON c.id=l.card_id
    WHERE l.trade_id=?`).all(id),
});

app.get("/api/trades", auth, (req, res) => {
  const ids = db.prepare("SELECT DISTINCT trade_id FROM trade_legs WHERE from_user=? OR to_user=?").all(req.session.uid, req.session.uid);
  res.json({ trades: ids.map((r) => tradeView(r.trade_id)) });
});

/* --------------------------- hub admin ---------------------------- */
app.get("/api/admin/trades", auth, admin, (req, res) => {
  const ids = db.prepare("SELECT id FROM trades ORDER BY id DESC").all();
  res.json({ trades: ids.map((r) => tradeView(r.id)) });
});

app.post("/api/admin/legs/:id/toggle", auth, admin, (req, res) => {
  const field = ["received", "checked", "credit_ok"].includes(req.body.field) ? req.body.field : null;
  if (!field) return res.status(400).json({ error: "field must be received|checked|credit_ok" });
  db.prepare(`UPDATE trade_legs SET ${field} = 1 - ${field} WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/trades/:id/release", auth, admin, (req, res) => {
  const { trade, legs } = tradeView(req.params.id);
  if (!trade || trade.status !== "locked") return res.status(400).json({ error: "Trade is not locked" });
  if (!legs.every((l) => l.received && l.checked)) return res.status(400).json({ error: "All packages must be received & checked" });

  // settlement: receiver pays value, shipper is credited value (nets per user)
  const settle = {};
  legs.forEach((l) => {
    settle[l.from_user] = (settle[l.from_user] || 0) + l.value_cents;
    settle[l.to_user] = (settle[l.to_user] || 0) - l.value_cents;
  });
  for (const [uid, cents] of Object.entries(settle)) {
    if (cents < 0 && balanceCents(+uid) < -cents)
      return res.status(400).json({ error: `${db.prepare("SELECT name FROM users WHERE id=?").get(+uid).name} lacks credit to settle (${(-cents / 100).toFixed(2)} needed)` });
  }
  const ins = db.prepare("INSERT INTO ledger (user_id,delta_cents,reason,trade_id) VALUES (?,?,'settlement',?)");
  for (const [uid, cents] of Object.entries(settle)) if (cents !== 0) ins.run(+uid, cents, trade.id);

  // move cards: remove from shipper's have + receiver's want; add to receiver's have
  for (const l of legs) {
    db.prepare("DELETE FROM binder WHERE user_id=? AND card_id=? AND side='have'").run(l.from_user, l.card_id);
    db.prepare("DELETE FROM binder WHERE user_id=? AND card_id=? AND side='want'").run(l.to_user, l.card_id);
    db.prepare("INSERT OR IGNORE INTO binder (user_id,card_id,side) VALUES (?,?,'have')").run(l.to_user, l.card_id);
  }
  db.prepare("UPDATE trades SET status='closed' WHERE id=?").run(trade.id);
  res.json({ ok: true, status: "closed" });
});

app.post("/api/admin/trades/:id/void", auth, admin, (req, res) => {
  db.prepare("UPDATE trades SET status='void' WHERE id=? AND status='locked'").run(req.params.id);
  res.json({ ok: true });
});

/* ----------------------------- wallet ----------------------------- */
app.post("/api/deposit", auth, (req, res) => {
  const cents = Math.round(Number(req.body.amount) * 100);
  if (!cents || cents < 100 || cents > 50000) return res.status(400).json({ error: "Amount must be $1–$500" });
  // SIMULATED until a payment processor is integrated — clearly labeled in UI
  db.prepare("INSERT INTO ledger (user_id,delta_cents,reason) VALUES (?,?,'deposit (simulated)')").run(req.session.uid, cents);
  res.json({ balance_cents: balanceCents(req.session.uid) });
});

app.get("/api/ledger", auth, (req, res) => {
  res.json({
    balance_cents: balanceCents(req.session.uid),
    entries: db.prepare("SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 50").all(req.session.uid),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TradeLoop running → http://localhost:${PORT}`));
