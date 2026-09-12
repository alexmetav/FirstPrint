-- Firstprint schema (SQLite for development). Types map directly to PostgreSQL:
-- INTEGER → BIGINT, REAL → DOUBLE PRECISION, TEXT JSON → JSONB.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE,
  username        TEXT NOT NULL UNIQUE,
  needs_username  INTEGER NOT NULL DEFAULT 0,  -- 1 for wallet sign-ups with an auto username
  password_hash   TEXT,            -- scrypt; NULL for system/demo accounts
  points          INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  last_claim_day  TEXT,
  created_at      INTEGER NOT NULL
);

-- Solana wallets linked to accounts. One wallet belongs to one account.
CREATE TABLE IF NOT EXISTS wallets (
  address      TEXT PRIMARY KEY,           -- base58 public key
  user_id      TEXT NOT NULL REFERENCES users(id),
  chain        TEXT NOT NULL DEFAULT 'solana',
  wallet_name  TEXT,                        -- e.g. Phantom, Solflare, Backpack
  verified_at  INTEGER NOT NULL,
  last_login   INTEGER
);
CREATE INDEX IF NOT EXISTS wallets_user ON wallets(user_id);

-- One-time sign-in challenges. The exact message is stored and must match.
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce       TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  message     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);

-- Session tokens are stored hashed; the raw token lives only in the user's cookie.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Every balance change is recorded; users.points is a cached sum.
CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,   -- signup | daily | stake | refund | payout
  ref         TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS markets (
  id                    TEXT PRIMARY KEY,
  symbol                TEXT NOT NULL,
  name                  TEXT,
  exchange              TEXT NOT NULL,
  venues                TEXT NOT NULL,   -- JSON [{ venue, symbol }]
  source_url            TEXT,
  announced_listing_at  INTEGER NOT NULL,
  listing_at            INTEGER NOT NULL,
  opened_at             INTEGER NOT NULL,
  config                TEXT NOT NULL,   -- JSON MarketConfig
  scorecard             TEXT,            -- JSON
  status                TEXT NOT NULL CHECK (status IN ('open', 'locked', 'resolved', 'void')),
  kind                  TEXT NOT NULL DEFAULT 'listing' CHECK (kind IN ('listing', 'live_test')),
  hard_cap              INTEGER,
  retracted             INTEGER NOT NULL DEFAULT 0,
  halted_ms             INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS markets_status ON markets(status, listing_at);

CREATE TABLE IF NOT EXISTS predictions (
  id          TEXT PRIMARY KEY,
  market_id   TEXT NOT NULL REFERENCES markets(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  bucket      TEXT NOT NULL CHECK (bucket IN ('crash', 'down', 'flat', 'up', 'moon')),
  stake       INTEGER NOT NULL CHECK (stake > 0),
  placed_at   INTEGER NOT NULL,
  accepted    INTEGER,   -- set at close
  refund      INTEGER,   -- set at close / settlement
  weight      REAL,      -- set at close
  payout      INTEGER    -- set at settlement
);
CREATE INDEX IF NOT EXISTS predictions_market ON predictions(market_id, placed_at);
CREATE INDEX IF NOT EXISTS predictions_user ON predictions(user_id, placed_at);

CREATE TABLE IF NOT EXISTS candles (
  market_id  TEXT NOT NULL REFERENCES markets(id),
  venue      TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  close      REAL NOT NULL,
  volume     REAL NOT NULL,
  trades     INTEGER,
  PRIMARY KEY (market_id, venue, ts)
);

-- Full engine output is stored so every settlement can be audited.
CREATE TABLE IF NOT EXISTS settlements (
  market_id   TEXT PRIMARY KEY REFERENCES markets(id),
  result      TEXT NOT NULL,
  data_hash   TEXT NOT NULL,
  settled_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS known_symbols (
  venue       TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  PRIMARY KEY (venue, symbol)
);

CREATE TABLE IF NOT EXISTS detected_listings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange      TEXT NOT NULL,              -- venue id: binance, bybit, okx, ...
  symbol        TEXT,                       -- base asset, e.g. XYZ (null if not parsed)
  pair          TEXT,                       -- venue trading symbol, e.g. XYZUSDT
  source        TEXT NOT NULL CHECK (source IN ('announcement', 'symbol_diff')),
  title         TEXT,
  url           TEXT,
  listing_at    INTEGER,                    -- parsed trading start, if found
  published_at  INTEGER,
  detected_at   INTEGER NOT NULL,
  dedupe_key    TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'ignored')),
  market_id     TEXT REFERENCES markets(id)
);
CREATE INDEX IF NOT EXISTS detected_status ON detected_listings(status, detected_at);
