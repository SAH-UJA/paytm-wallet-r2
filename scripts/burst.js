#!/usr/bin/env node
// One command: BASE_URL=http://localhost:3000 node scripts/burst.js
// It creates isolated test users and runs all three required concurrency probes.
const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function api(path, { user, method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${user}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  return { status: response.status, json };
}
function assert(condition, detail) { if (!condition) throw new Error(detail); }
async function wallet(user, balance) {
  const r = await api('/wallets', { user, method: 'POST', body: { initial_balance_paise: balance } });
  assert(r.status === 201 || r.status === 200, `wallet failed: ${JSON.stringify(r)}`);
  return r.json;
}
async function balance(user, id) {
  const r = await api(`/wallets/${id}`, { user });
  assert(r.status === 200, `balance fetch failed: ${JSON.stringify(r)}`);
  return r.json.balance_paise;
}

console.log(`Running against ${base} (run ${run})`);

// 1. Race-free get-or-create.
const newUser = `race-${run}`;
const creates = await Promise.all(Array.from({ length: 50 }, () => wallet(newUser, 777)));
const distinct = new Set(creates.map((w) => w.id));
assert(distinct.size === 1, `expected one wallet, got ${distinct.size}`);
console.log(`PASS get-or-create: 50 concurrent requests returned one wallet (${[...distinct][0]})`);

// 2. Same-key retry storm; one transfer and identical results.
const aliceUser = `alice-${run}`, bobUser = `bob-${run}`;
const alice = await wallet(aliceUser, 100_000), bob = await wallet(bobUser, 100_000);
const same = { from: alice.id, to: bob.id, amount_paise: 12_345, idempotency_key: `storm-${run}` };
const storm = await Promise.all(Array.from({ length: 30 }, () => api('/transfers', { user: aliceUser, method: 'POST', body: same })));
assert(storm.every((r) => r.status === 200), `retry storm had failures: ${JSON.stringify(storm)}`);
assert(new Set(storm.map((r) => JSON.stringify(r.json))).size === 1, 'retry storm responses were not identical');
assert(await balance(aliceUser, alice.id) === 87_655, 'retry storm debited source more than once');
assert(await balance(bobUser, bob.id) === 112_345, 'retry storm credited destination more than once');
const conflict = await api('/transfers', { user: aliceUser, method: 'POST', body: { ...same, amount_paise: 1 } });
assert(conflict.status === 409, `same key/different body expected 409: ${JSON.stringify(conflict)}`);
console.log('PASS idempotency: 30 concurrent retries produced one identical completed transfer; mismatch returned 409');

// 3. Conservation under bidirectional contention, with some intentional overdrafts.
const users = ['a', 'b', 'c'].map((x) => `${x}-${run}`);
const wallets = await Promise.all(users.map((u) => wallet(u, 50_000)));
const before = (await Promise.all(wallets.map((w, i) => balance(users[i], w.id)))).reduce((a, b) => a + b, 0);
const transfers = Array.from({ length: 300 }, (_, i) => {
  const fromIndex = i % 3;
  const toIndex = (i % 2) ? (fromIndex + 1) % 3 : (fromIndex + 2) % 3;
  // Every 25th debit is deliberately too large and must decline without a partial credit.
  const amount = i % 25 === 0 ? 9_999_999 : (i % 900) + 1;
  return api('/transfers', { user: users[fromIndex], method: 'POST', body: { from: wallets[fromIndex].id, to: wallets[toIndex].id, amount_paise: amount, idempotency_key: `contention-${run}-${i}` } });
});
const results = await Promise.all(transfers);
assert(results.every((r) => r.status === 200), `contention call failed: ${JSON.stringify(results.find((r) => r.status !== 200))}`);
const afterBalances = await Promise.all(wallets.map((w, i) => balance(users[i], w.id)));
const after = afterBalances.reduce((a, b) => a + b, 0);
assert(before === after, `conservation failed: before=${before} after=${after}`);
assert(afterBalances.every((n) => n >= 0), `negative balance: ${afterBalances}`);
assert(results.some((r) => r.json.status === 'declined' && r.json.decline_reason === 'insufficient_funds'), 'expected at least one clean decline');
console.log(`PASS contention: total stayed ${after}; balances=${afterBalances.join(', ')}; ${results.filter((r) => r.json.status === 'declined').length} clean declines`);
console.log('All live probes passed. Metrics are at /metrics; logs include x-correlation-id.');
