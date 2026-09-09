CREATE TABLE wallets (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id UUID PRIMARY KEY,
  -- Wallet existence is validated after deterministic FOR UPDATE locking in the
  -- transfer transaction. Foreign-key checks would acquire KEY SHARE locks in
  -- caller order before that lock order, reintroducing an A→B/B→A deadlock.
  from_wallet_id UUID NOT NULL,
  to_wallet_id UUID NOT NULL,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'declined')),
  decline_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'completed' AND decline_reason IS NULL) OR (status = 'declined' AND decline_reason IS NOT NULL))
);

CREATE INDEX transfers_from_wallet_idx ON transfers(from_wallet_id);
CREATE INDEX transfers_to_wallet_idx ON transfers(to_wallet_id);
