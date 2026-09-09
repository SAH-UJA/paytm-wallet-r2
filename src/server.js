import Fastify from 'fastify';
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import client from 'prom-client';

const { Pool } = pg;
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL || 'postgres://wallet:wallet@postgres:5432/wallet';
const pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_SIZE || 10) });

async function migrate() {
  // Kept here (rather than only in docker-compose) so a fresh managed Postgres
  // database is ready on its first hosted deploy too.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS transfers (
      id UUID PRIMARY KEY,
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
    CREATE INDEX IF NOT EXISTS transfers_from_wallet_idx ON transfers(from_wallet_id);
    CREATE INDEX IF NOT EXISTS transfers_to_wallet_idx ON transfers(to_wallet_id);
  `);
}

const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpDuration = new client.Histogram({ name: 'wallet_http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route', 'status_code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5], registers: [register] });
const transferEvents = new client.Counter({ name: 'wallet_transfer_events_total', help: 'Wallet transfer domain events', labelNames: ['event'], registers: [register] });

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

function error(statusCode, code, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  return e;
}

function paise(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw error(400, 'INVALID_AMOUNT', `${field} must be a non-negative integer number of paise`);
  return value;
}

function transferView(row) {
  return { id: row.id, from: row.from_wallet_id, to: row.to_wallet_id, amount_paise: Number(row.amount_paise), status: row.status, decline_reason: row.decline_reason, created_at: row.created_at };
}

function fingerprint(from, to, amount) {
  return createHash('sha256').update(JSON.stringify({ from, to, amount_paise: amount })).digest('hex');
}

app.addHook('onRequest', async (request, reply) => {
  request.correlationId = request.headers['x-correlation-id'] || randomUUID();
  reply.header('x-correlation-id', request.correlationId);
  request.startedAt = process.hrtime.bigint();
});
app.addHook('onResponse', async (request, reply) => {
  const seconds = Number(process.hrtime.bigint() - request.startedAt) / 1e9;
  httpDuration.labels(request.method, request.routeOptions?.url || 'unknown', String(reply.statusCode)).observe(seconds);
});
app.addHook('preHandler', async (request) => {
  if (request.routeOptions?.url === '/healthz' || request.routeOptions?.url === '/metrics') return;
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || !header.slice(7).trim()) throw error(401, 'UNAUTHORIZED', 'Use Authorization: Bearer <user-id>');
  request.userId = header.slice(7).trim();
});
app.setErrorHandler((err, request, reply) => {
  const status = err.statusCode || 500;
  request.log[status >= 500 ? 'error' : 'warn']({ correlation_id: request.correlationId, err, event: 'request_failed' }, err.message);
  reply.status(status).send({ error: err.code || 'INTERNAL_ERROR', message: status === 500 ? 'internal server error' : err.message, correlation_id: request.correlationId });
});

app.get('/healthz', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});
app.get('/metrics', async (_request, reply) => {
  reply.type(register.contentType);
  return register.metrics();
});

app.post('/wallets', async (request, reply) => {
  const initial = request.body?.initial_balance_paise === undefined ? 0 : paise(request.body.initial_balance_paise, 'initial_balance_paise');
  // The unique index is the race-free get-or-create authority. ON CONFLICT makes concurrent callers converge.
  const inserted = await pool.query('INSERT INTO wallets (id, user_id, balance_paise) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING RETURNING id, user_id, balance_paise', [randomUUID(), request.userId, initial]);
  const wallet = inserted.rows[0] || (await pool.query('SELECT id, user_id, balance_paise FROM wallets WHERE user_id = $1', [request.userId])).rows[0];
  reply.code(inserted.rows[0] ? 201 : 200);
  return { id: wallet.id, user_id: wallet.user_id, balance_paise: Number(wallet.balance_paise) };
});

app.get('/wallets/:id', async (request) => {
  const wallet = (await pool.query('SELECT id, user_id, balance_paise FROM wallets WHERE id = $1', [request.params.id])).rows[0];
  if (!wallet) throw error(404, 'WALLET_NOT_FOUND', 'wallet not found');
  if (wallet.user_id !== request.userId) throw error(403, 'FORBIDDEN', 'wallet does not belong to caller');
  return { id: wallet.id, user_id: wallet.user_id, balance_paise: Number(wallet.balance_paise) };
});

app.post('/transfers', async (request, reply) => {
  const { from, to, amount_paise: rawAmount, idempotency_key: key } = request.body || {};
  const amount = paise(rawAmount, 'amount_paise');
  if (!from || !to || !key || typeof key !== 'string') throw error(400, 'INVALID_REQUEST', 'from, to, amount_paise, and idempotency_key are required');
  if (from === to) throw error(400, 'SAME_WALLET', 'from and to must differ');
  if (amount === 0) throw error(400, 'INVALID_AMOUNT', 'amount_paise must be greater than zero');
  const hash = fingerprint(from, to, amount);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // This insert and the money movement share one transaction. Concurrent same-key inserts wait here.
    const created = (await db.query("INSERT INTO transfers (id, from_wallet_id, to_wallet_id, amount_paise, idempotency_key, request_fingerprint, status, decline_reason) VALUES ($1, $2, $3, $4, $5, $6, 'declined', 'processing') ON CONFLICT (idempotency_key) DO NOTHING RETURNING *", [randomUUID(), from, to, amount, key, hash])).rows[0];
    if (!created) {
      const existing = (await db.query('SELECT * FROM transfers WHERE idempotency_key = $1', [key])).rows[0];
      if (existing.request_fingerprint !== hash) throw error(409, 'IDEMPOTENCY_CONFLICT', 'idempotency_key was used with a different request');
      await db.query('COMMIT');
      transferEvents.labels('idempotent_replay').inc();
      request.log.info({ correlation_id: request.correlationId, event: 'idempotent_replay_hit', transfer_id: existing.id }, 'idempotent replay hit');
      return transferView(existing);
    }
    request.log.info({ correlation_id: request.correlationId, event: 'transfer_created', transfer_id: created.id }, 'transfer created');
    // Always acquire both wallet row locks by UUID order, preventing A→B/B→A deadlocks.
    const wallets = (await db.query('SELECT id, user_id FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[from, to]])).rows;
    const source = wallets.find((w) => w.id === from);
    const destination = wallets.find((w) => w.id === to);
    if (!source || !destination) throw error(404, 'WALLET_NOT_FOUND', 'source or destination wallet not found');
    if (source.user_id !== request.userId) throw error(403, 'FORBIDDEN', 'source wallet does not belong to caller');
    // Conditional debit is the final no-overdraft guard even after the row lock.
    const debit = await db.query('UPDATE wallets SET balance_paise = balance_paise - $1 WHERE id = $2 AND balance_paise >= $1 RETURNING balance_paise', [amount, from]);
    let result;
    if (!debit.rowCount) {
      result = (await db.query("UPDATE transfers SET status = 'declined', decline_reason = 'insufficient_funds' WHERE id = $1 RETURNING *", [created.id])).rows[0];
      transferEvents.labels('declined_insufficient_funds').inc();
      request.log.info({ correlation_id: request.correlationId, event: 'transfer_declined', transfer_id: result.id, reason: 'insufficient_funds' }, 'transfer declined');
    } else {
      request.log.info({ correlation_id: request.correlationId, event: 'wallet_debited', transfer_id: created.id, wallet_id: from, amount_paise: amount }, 'wallet debited');
      await db.query('UPDATE wallets SET balance_paise = balance_paise + $1 WHERE id = $2', [amount, to]);
      request.log.info({ correlation_id: request.correlationId, event: 'wallet_credited', transfer_id: created.id, wallet_id: to, amount_paise: amount }, 'wallet credited');
      result = (await db.query("UPDATE transfers SET status = 'completed', decline_reason = NULL WHERE id = $1 RETURNING *", [created.id])).rows[0];
      transferEvents.labels('created').inc();
    }
    await db.query('COMMIT');
    return transferView(result);
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally { db.release(); }
});

app.get('/transfers/:id', async (request) => {
  const row = (await pool.query('SELECT t.* FROM transfers t JOIN wallets w ON w.id = t.from_wallet_id WHERE t.id = $1 AND w.user_id = $2', [request.params.id, request.userId])).rows[0];
  if (!row) throw error(404, 'TRANSFER_NOT_FOUND', 'transfer not found');
  return transferView(row);
});

await migrate();
const close = async () => { await app.close(); await pool.end(); };
process.on('SIGTERM', close); process.on('SIGINT', close);
await app.listen({ port, host: '0.0.0.0' });
