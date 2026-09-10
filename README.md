# Wallet & P2P Transfer — R2

A deliberately small, API-only wallet service built around PostgreSQL transactions. Amounts are integer paise throughout; there are no floating-point monetary values.

## Run locally

```sh
docker compose up --build
```

The API is then available at `http://localhost:3000`. It uses a development-only PostgreSQL password in `docker-compose.yml`; set a real `DATABASE_URL` in a hosted environment. The app initializes its own schema at startup, so the same image also works with a fresh managed Postgres database.

For this exercise, the bearer token *is* the user identifier, e.g. `Authorization: Bearer alice`. `POST /wallets` creates/returns that caller's wallet. It accepts an optional `initial_balance_paise` only on the initial creation, which makes the service testable without a privileged top-up endpoint; retries do not change the balance.

```sh
curl -X POST http://localhost:3000/wallets \
  -H 'Authorization: Bearer alice' -H 'content-type: application/json' \
  -d '{"initial_balance_paise":100000}'
```

## API

- `POST /wallets` — caller's get-or-create wallet. Optional `initial_balance_paise` on its first call.
- `GET /wallets/:id` — caller may read their own wallet.
- `POST /transfers` — caller must own `from`; body: `from`, `to`, `amount_paise`, `idempotency_key`.
- `GET /transfers/:id` — source-wallet owner may read it.
- `GET /healthz` — PostgreSQL-aware readiness endpoint.
- `GET /metrics` — Prometheus metrics.

`POST /transfers` returns a persisted transfer with `completed` or `declined` status. An insufficient-funds attempt is a successful API operation with `status: "declined"` and `decline_reason: "insufficient_funds"`; it moves no money. A repeated identical idempotency key returns the original transfer. A key reused for a different `{from,to,amount_paise}` returns `409`.

## Live concurrency probes

With the service running, one command exercises all required probes:

```sh
BASE_URL=http://localhost:3000 node scripts/burst.js
```

It creates disposable users, then verifies 50 concurrent wallet creations converge to one ID, 30 same-key transfer retries produce one identical result and a mismatch gets `409`, and 300 conflicting transfers preserve the total while never producing a negative balance.

## One-page design note

### Data model

`wallets` has a database-enforced `UNIQUE(user_id)`, a UUID primary key, and `balance_paise BIGINT NOT NULL CHECK (balance_paise >= 0)`. `transfers` stores immutable request identity (`from_wallet_id`, `to_wallet_id`, `amount_paise`, SHA-256 request fingerprint) plus the result status. `UNIQUE(idempotency_key)` is deliberately in PostgreSQL rather than process memory. Wallet existence is validated while the two wallet rows are deterministically locked rather than by transfer-table foreign keys: FK checks acquire key-share locks in the caller's source/destination order and would undermine that global lock order under A→B/B→A contention.

### Simplest correct money movement

Each transfer runs in one PostgreSQL transaction. It locks the two wallet rows with `SELECT ... FOR UPDATE ORDER BY id`, so competing A→B and B→A transfers take locks in the same UUID order and cannot form a two-row deadlock cycle. It then performs an atomic conditional debit, `UPDATE wallets SET balance_paise = balance_paise - $amount WHERE id = $from AND balance_paise >= $amount`. A zero-row result records a declined transfer; otherwise the matching credit and completed result are committed together. A crash or failure rolls back both updates. This gives conservation and no-overdraft without global locks.

I rejected an application-side read/subtract/write because it loses updates under contention. I rejected defaulting the whole workload to `SERIALIZABLE`: it is correct with explicit retry handling, but adds abort/retry complexity and needless throughput loss for this narrow two-row operation. The deterministic row locks make the behavior and failure mode easy to explain.

### Idempotency

The transfer row (including its unique idempotency key) is inserted before money movement **inside the same transaction**. A concurrent duplicate waits on the unique index, then reads the committed row; it never gets a window to apply a second debit. The stored request fingerprint makes same-key/different-body a `409`, rather than silently treating it as a retry. A declined outcome is also persisted and therefore idempotent.

### Consistency and availability

I choose consistency: if PostgreSQL is unavailable, the API fails a transfer rather than accepting an ambiguous money movement. This deliberately gives up write availability during a database outage, which is appropriate for a money ledger.

### Operations and cost

The Dockerfile is multi-stage, runs as an unprivileged `wallet` user, and has a DB-aware health check. Fastify emits JSON logs, attaches/returns `x-correlation-id`, and logs transfer creation, debit, credit, decline, and replay. `/metrics` includes request duration (for p99 calculation), request counts/errors through HTTP labels, and domain counters for created, declined, and replayed transfers. Deploy the app image and set `DATABASE_URL` to a free managed PostgreSQL provider; use the host's log explorer or ship stdout to a free log viewer. Expected trial/free-tier cost: ₹0, subject to the selected providers' current free-tier terms.

### AI disclosure

I directed the core design: PostgreSQL as the source of truth, unique constraints for wallet creation/idempotency, deterministic row locks and conditional debit, plus the required container/observability surface. I used an AI coding assistant to accelerate implementation and tests, reviewed every schema/query and ran the supplied burst script. I retained and accepted the assistant's implementation-level choices only after review.

## Deployment checklist

1. Create a public repository under your own account and make normal, attributable commits as you build/review it.
2. In Render, choose **New → Blueprint**, select the repository, and approve the resources declared in `render.yaml`. It creates a free Docker web service and free Render Postgres database in Singapore, wiring the database connection string to `DATABASE_URL` without committing a secret.
3. Wait for the deploy to pass `/healthz`, then copy its public `onrender.com` URL.
4. Run `BASE_URL=https://your-service.example node scripts/burst.js` against the live URL.
5. Put the live URL, repository URL, public log/viewing evidence, and metrics URL in your response to the recruiter.

The last three steps require the candidate's own provider accounts and consent; they cannot be completed from this workspace.
