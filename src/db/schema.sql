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
  created_at            INTEGER NOT NULL,
  mode                  TEXT NOT NULL DEFAULT 'auto',  -- auto: exchange data settles it; manual: an admin enters the result
  published             INTEGER NOT NULL DEFAULT 1,    -- 0 = admin draft, hidden from users
  base_price            REAL,                          -- manual markets: reference price set by the admin
  note                  TEXT                           -- manual markets: description / resolution rules shown to users
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

-- Small key/value store for admin settings (e.g. which exchanges can be used).
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- One-time sign-in codes sent by email. Only a hash of the code is stored.
CREATE TABLE IF NOT EXISTS email_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Wrong code guesses per email across all codes, so requesting fresh codes doesn't reset the count.
CREATE TABLE IF NOT EXISTS email_code_failures (
  email         TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);

-- What the admin did, newest last. Paying out points can't be undone, so there is a record of who did what.
CREATE TABLE IF NOT EXISTS admin_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT,
  ip      TEXT
);

-- Points earned outside predictions (welcome bonus, tasks, referrals). When TestFPT is on, they
-- wait here until the player claims them to their wallet; claim_id links them to that claim.
CREATE TABLE IF NOT EXISTS rewards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,        -- welcome | task | x_connect | referral
  ref         TEXT,                 -- task id, referred user id, ...
  amount      INTEGER NOT NULL CHECK (amount > 0),
  created_at  INTEGER NOT NULL,
  claim_id    TEXT                  -- NULL until claimed; 'direct' when credited without a token
);
CREATE INDEX IF NOT EXISTS rewards_user ON rewards(user_id, claim_id);
CREATE UNIQUE INDEX IF NOT EXISTS rewards_once ON rewards(user_id, kind, ref) WHERE kind IN ('welcome', 'task', 'x_connect', 'referral');

-- Claims of rewards to a wallet as TestFPT. The player signs and pays the fee.
CREATE TABLE IF NOT EXISTS claims (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  wallet           TEXT NOT NULL,
  amount           INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'expired')),
  message          TEXT NOT NULL,   -- base64 of the exact message the wallet must sign
  last_valid_height INTEGER NOT NULL,
  signature        TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_user ON claims(user_id, created_at);

-- Tasks admins publish (follow on X, repost, share, visit a link) and who completed them.
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('follow', 'repost', 'like', 'share', 'link')),
  title            TEXT NOT NULL,
  target           TEXT NOT NULL,   -- X handle, post id, share text or URL depending on kind
  points           INTEGER NOT NULL CHECK (points > 0),
  max_completions  INTEGER,         -- NULL = no limit
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_completions (
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  x_username  TEXT,
  started_at  INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (task_id, user_id)
);

-- Small server settings, such as the TestFPT mint and its authority key.
CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
