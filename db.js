/* TradeLoop — database layer (Node built-in SQLite, no native deps) */
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, "tradeloop.db"));

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  want_mode TEXT DEFAULT 'specific',          -- 'specific' | 'velocity'
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,                        -- JustTCG card id (or demo id)
  name TEXT NOT NULL,
  set_name TEXT,
  game TEXT,
  number TEXT,
  rarity TEXT,
  tcgplayer_id TEXT,
  image_url TEXT,                             -- TCGplayer product photo
  condition TEXT DEFAULT 'Near Mint',
  printing TEXT,
  price_cents INTEGER DEFAULT 0,              -- market price in cents
  changes_30d INTEGER DEFAULT 0,              -- JustTCG priceChangesCount30d
  change_pct_30d REAL DEFAULT 0,              -- JustTCG priceChange30d
  source TEXT DEFAULT 'demo',                 -- 'justtcg' | 'demo'
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS binder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL REFERENCES cards(id),
  side TEXT NOT NULL CHECK (side IN ('have','want')),
  UNIQUE(user_id, card_id, side)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT DEFAULT 'locked',               -- locked | closed | void
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trade_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL REFERENCES trades(id),
  from_user INTEGER NOT NULL REFERENCES users(id),
  to_user INTEGER NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL REFERENCES cards(id),
  value_cents INTEGER NOT NULL,
  received INTEGER DEFAULT 0,
  checked INTEGER DEFAULT 0,
  credit_ok INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta_cents INTEGER NOT NULL,               -- + credit in, - credit out
  reason TEXT NOT NULL,                       -- deposit | settlement | adjustment
  trade_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

/* migration for databases created before image_url existed */
try { db.exec("ALTER TABLE cards ADD COLUMN image_url TEXT"); } catch {}

/* Seed demo cards so the app works before a JustTCG key is added.
   Real searches replace these over time. */
const seedCount = db.prepare("SELECT COUNT(*) c FROM cards").get().c;
if (seedCount === 0) {
  const ins = db.prepare(
    "INSERT INTO cards (id,name,set_name,game,number,rarity,price_cents,changes_30d,change_pct_30d,source) VALUES (?,?,?,?,?,?,?,?,?,'demo')"
  );
  ins.run("demo-charizard-ex", "Charizard ex (demo)", "Obsidian Flames", "Pokemon", "125/197", "Double Rare", 4200, 81, 12.5, );
  ins.run("demo-iono", "Iono Full Art (demo)", "Paldea Evolved", "Pokemon", "254/193", "Special Art", 2800, 64, 5.1);
  ins.run("demo-mew-ex", "Mew ex (demo)", "151", "Pokemon", "151/165", "Double Rare", 2400, 38, -3.2);
  ins.run("demo-boss", "Boss's Orders (demo)", "Paldea Evolved", "Pokemon", "172/193", "Rare", 900, 95, 21.0);
  ins.run("demo-candy", "Rare Candy (demo)", "Scarlet & Violet", "Pokemon", "191/198", "Uncommon", 300, 4, -15.0);
  ins.run("demo-pika", "Pikachu ex (demo)", "Surging Sparks", "Pokemon", "57/191", "Double Rare", 1900, 22, -8.0);
}

module.exports = {
  db,
  // velocity: ~3 price-moves/day on JustTCG ≈ hot. 45+/30d = fast mover.
  isFast: (card) => (card.changes_30d ?? 0) >= 45,
  balanceCents(userId) {
    return db.prepare("SELECT COALESCE(SUM(delta_cents),0) b FROM ledger WHERE user_id=?").get(userId).b;
  },
};
