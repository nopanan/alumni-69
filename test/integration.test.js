import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { testDatabase } from './helpers/database.js';
import { mockProviders, STAFF } from './helpers/providers.js';
import { testConfig } from './helpers/config.js';
import { SupabaseRepository } from '../src/supabase-db.js';
import { postgrestHarness } from './helpers/postgrest.js';

let database, pool, app, providers, rest;
const customerBody = (table_ids) => ({ booker_name: 'ผู้จองทดสอบ', phone: '0812345678', table_ids });
const staffHeaders = (role = 'staff') => ({ authorization: `Bearer test-staff-${role}` });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64');
function imagePayload(bytes = png, filename = 'slip.png') {
  const boundary = '----alumni69test';
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}
async function login(who, acknowledge = true) {
  const start = await app.inject('/auth/line');
  assert.equal(start.statusCode, 302);
  const url = new URL(start.headers.location);
  const callback = await app.inject({ url: `/auth/line/callback?state=${url.searchParams.get('state')}&code=${who}`,
    headers: { cookie: start.cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
  assert.equal(callback.statusCode, 302, callback.body);
  const token = callback.cookies.find((c) => c.name === 'alumni_session').value;
  const headers = { authorization: `Bearer ${token}` };
  if (acknowledge) assert.equal((await app.inject({ method: 'POST', url: '/me/line/group-acknowledgement', headers, payload: { acknowledged: true } })).statusCode, 200);
  const me = (await app.inject({ url: '/me', headers })).json();
  return { token, headers, id: me.id };
}
const book = (who, tables, key = randomUUID()) => app.inject({ method: 'POST', url: '/bookings', headers: { ...who.headers, 'idempotency-key': key }, payload: customerBody(tables) });
const upload = (who, id, bytes) => { const image = imagePayload(bytes); return app.inject({ method: 'POST', url: `/bookings/${id}/slip`, headers: { ...who.headers, ...image.headers }, payload: image.payload }); };
const confirm = (id, role = 'staff') => app.inject({ method: 'POST', url: `/admin/bookings/${id}/confirm`, headers: staffHeaders(role) });

before(async () => {
  database = await testDatabase(); pool = database.pool;
  for (const [role, id] of Object.entries(STAFF)) {
    await pool.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${role}@example.test`]);
    await pool.query('INSERT INTO alumni_69.staff_accounts VALUES($1,$2)', [id, role]);
    await pool.query('INSERT INTO alumni_69.staff_users(auth_user_id,username) VALUES($1,$2)', [id, role]);
  }
  providers = mockProviders();
  const config = testConfig();
  let repository;
  if (process.env.ALUMNI_TEST_TRANSPORT === 'supabase') {
    rest = await postgrestHarness(pool);
    config.supabaseUrl = rest.url;
    config.supabaseSecretKey = 'test-service-secret';
    repository = new SupabaseRepository(config);
  }
  app = await createApp({ config, pool, repository, providers });
}, { timeout: 60000 });
after(async () => { if (app) await app.close(); if (rest) await rest.close(); if (database) await database.close(); });

test('server-only RPC denies anon/authenticated roles and rejects arbitrary operations', async () => {
  for (const role of ['anon', 'authenticated']) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(() => client.query("SELECT public.alumni69_backend('ready','{}')"), { code: '42501' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE service_role');
    await assert.rejects(() => client.query("SELECT public.alumni69_backend('execute_sql','{}')"), { code: 'PT400' });
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('public health/table map; protected endpoints require verified sessions', async () => {
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject('/ready')).statusCode, 200);
  const map = (await app.inject('/tables')).json();
  assert.equal(map.tables.length, 41);
  assert.equal(map.tables.find((t) => t.id === 'STAFF1').color, 'gray-black');
  assert.equal(map.reserved_areas[0].color, 'blue-white');
  for (const url of ['/me', '/bookings', '/admin/dashboard', '/booking_summary']) assert.equal((await app.inject(url)).statusCode, 401);
  assert.equal((await app.inject({ url: '/admin/dashboard', headers: { authorization: 'Bearer forged-token' } })).statusCode, 401);
});

test('LINE OAuth requires browser-bound state and consumes state once', async () => {
  const start = await app.inject('/auth/line');
  const state = new URL(start.headers.location).searchParams.get('state');
  const url = `/auth/line/callback?state=${state}&code=state-test`;
  assert.equal((await app.inject(url)).statusCode, 401);
  const cookie = start.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 302);
  assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 401);
});

test('login records non-buyers and repeated login does not create duplicate customers', async () => {
  await login('non-buyer'); await login('non-buyer');
  const { rows: [row] } = await pool.query(`SELECT count(DISTINCT c.id)::int AS customers,count(h.id)::int AS logins
    FROM alumni_69.customers c JOIN alumni_69.login_history h ON h.customer_id=c.id WHERE c.line_user_id='line-test-non-buyer'`);
  assert.deepEqual(row, { customers: 1, logins: 2 });
});

test('booking requires group acknowledgement and current OA friendship', async () => {
  const who = await login('gate', false);
  assert.equal((await book(who, ['A1'])).json().error, 'LINE_GROUP_ACK_REQUIRED');
  await app.inject({ method: 'POST', url: '/me/line/group-acknowledgement', headers: who.headers, payload: { acknowledged: true } });
  providers.isFriend = false;
  try { assert.equal((await book(who, ['A1'])).json().error, 'LINE_OA_FRIEND_REQUIRED'); }
  finally { providers.isFriend = true; }
});

test('multi-table booking -> image upload -> confirm -> 16 tickets; ownership, roles and retries', async () => {
  const alice = await login('alice'), bob = await login('bob');
  const key = randomUUID();
  const created = await book(alice, ['A1', 'A2'], key);
  assert.equal(created.statusCode, 201, created.body);
  const booking = created.json().booking;
  assert.equal(booking.total_amount, 7000);
  assert.equal(booking.items.length, 2);
  assert.ok(Math.abs(new Date(booking.expires_at) - new Date(booking.created_at) - 3600000) < 2000);
  assert.equal((await book(alice, ['A2', 'A1'], key)).statusCode, 200);
  assert.equal((await book(alice, ['A3'], key)).statusCode, 409);
  assert.equal((await app.inject({ url: `/bookings/${booking.id}`, headers: bob.headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/booking_summary', headers: alice.headers })).statusCode, 401);
  assert.equal((await upload(bob, booking.id)).statusCode, 404);
  assert.equal((await app.inject({ url: `/bookings/${booking.id}/tickets`, headers: alice.headers })).statusCode, 409);
  const submitted = await upload(alice, booking.id);
  assert.equal(submitted.statusCode, 201, submitted.body);
  assert.equal(submitted.json().booking.status, 'pending_review');
  const paymentId = submitted.json().payment_id;
  assert.equal((await app.inject({ url: `/admin/payments/${paymentId}/slip`, headers: staffHeaders('manager') })).statusCode, 403);
  assert.equal((await confirm(booking.id, 'manager')).statusCode, 403);
  const confirmations = await Promise.all([confirm(booking.id), confirm(booking.id, 'admin')]);
  assert.deepEqual(confirmations.map((r) => r.statusCode), [200, 200]);
  const cards = await app.inject({ url: `/bookings/${booking.id}/tickets`, headers: alice.headers });
  assert.equal(cards.json().tickets.length, 16);
  assert.equal(new Set(cards.json().tickets.map((t) => t.token)).size, 16);
  const card = await app.inject(new URL(cards.json().tickets[0].url).pathname);
  assert.equal(card.statusCode, 200);
  assert.equal(card.json().booker_name, undefined);
  assert.equal((await app.inject({ url: `/bookings/${booking.id}/tickets`, headers: bob.headers })).statusCode, 404);
  const { rows: [outbox] } = await pool.query('SELECT count(*)::int AS count FROM alumni_69.notification_outbox WHERE booking_id=$1', [booking.id]);
  assert.equal(outbox.count, 1);
  const tables = (await app.inject('/tables')).json().tables;
  assert.equal(tables.find((t) => t.id === 'A1').color, 'red');
  for (const role of ['admin', 'manager', 'staff']) {
    const dashboard = await app.inject({ url: '/admin/dashboard', headers: staffHeaders(role) });
    assert.equal(dashboard.statusCode, 200);
    assert.equal(Number(dashboard.json().confirmed_amount), 7000);
    assert.ok(Number(dashboard.json().non_buyers) > 0);
    const summary = await app.inject({ url: '/booking_summary', headers: staffHeaders(role) });
    assert.equal(summary.statusCode, 200);
    const fields = ['confirmed_tables', 'pending_tables', 'available_tables', 'confirmed_amount', 'pending_amount', 'available_amount'];
    assert.deepEqual(Object.keys(summary.json()).sort(), [...fields].sort());
    for (const field of fields) assert.equal(summary.json()[field], dashboard.json()[field]);
  }
});

test('two actual PostgreSQL connections race for one table: exactly one success', async () => {
  const alice = await login('race-alice'), bob = await login('race-bob');
  const blocker = await pool.connect();
  await blocker.query('SELECT pg_advisory_lock(690035008::bigint)');
  const first = book(alice, ['A3']), second = book(bob, ['A3']);
  let concurrentWaiters = 0;
  try {
    for (let i = 0; i < 100; i++) {
      const { rows: [locks] } = await pool.query(`SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype='advisory' AND NOT granted`);
      concurrentWaiters = locks.waiting;
      if (concurrentWaiters >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally { await blocker.query('SELECT pg_advisory_unlock(690035008::bigint)'); blocker.release(); }
  const responses = await Promise.all([first, second]);
  assert.ok(concurrentWaiters >= 2, 'Both independent database transactions must overlap while waiting for the lock');
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]);
  const { rows: [row] } = await pool.query("SELECT count(*)::int AS claims FROM alumni_69.table_claims WHERE table_id='A3'");
  assert.equal(row.claims, 1);
});

test('multi-table request is atomic when one selected table is taken', async () => {
  const who = await login('atomic');
  assert.equal((await book(who, ['A1', 'A4'])).statusCode, 409);
  const { rows } = await pool.query("SELECT * FROM alumni_69.table_claims WHERE table_id='A4'");
  assert.equal(rows.length, 0);
  for (const ids of [['STAFF1'], ['VIP'], ['A4', 'A4']]) assert.ok((await book(who, ids)).statusCode >= 400);
  assert.equal((await app.inject({ method: 'POST', url: '/bookings', headers: { ...who.headers, 'idempotency-key': randomUUID() }, payload: { ...customerBody(['A4']), customer_id: randomUUID(), total_amount: 1 } })).statusCode, 400);
});

test('unpaid booking expires, releases its claim, and the table can be booked again', async () => {
  const who = await login('expire');
  const id = (await book(who, ['A5'])).json().booking.id;
  await pool.query("UPDATE alumni_69.bookings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
  assert.equal((await upload(who, id)).statusCode, 409);
  await pool.query('SELECT alumni_69.expire_bookings()');
  assert.equal((await app.inject({ url: `/bookings/${id}`, headers: who.headers })).json().status, 'expired');
  assert.equal((await book(who, ['A5'])).statusCode, 201);
});

test('timely submitted slip keeps claim past the hour until staff confirmation', async () => {
  const who = await login('hold-review');
  const id = (await book(who, ['A6'])).json().booking.id;
  assert.equal((await upload(who, id)).statusCode, 201);
  await pool.query("UPDATE alumni_69.bookings SET expires_at=clock_timestamp()-interval '2 hours' WHERE id=$1", [id]);
  await pool.query('SELECT alumni_69.expire_bookings()');
  assert.equal((await app.inject({ url: `/bookings/${id}`, headers: who.headers })).json().status, 'pending_review');
  assert.equal((await book(who, ['A6'])).statusCode, 409);
  assert.equal((await confirm(id)).statusCode, 200);
});

test('image content is checked; storage failure does not submit payment', async () => {
  const who = await login('files');
  const id = (await book(who, ['A7'])).json().booking.id;
  assert.equal((await upload(who, id, Buffer.from('<script>bad</script>'))).statusCode, 415);
  assert.equal((await upload(who, id, Buffer.alloc(5 * 1024 * 1024 + 1))).statusCode, 413);
  providers.uploadFailure = true;
  try { assert.equal((await upload(who, id)).statusCode, 502); }
  finally { providers.uploadFailure = false; }
  assert.equal((await app.inject({ url: `/bookings/${id}`, headers: who.headers })).json().status, 'pending_payment');
  assert.equal((await upload(who, id)).statusCode, 201);
});

test('upload finishing after deadline is refused and its unattached object is removed', async () => {
  const who = await login('late-upload');
  const id = (await book(who, ['A8'])).json().booking.id;
  const before = providers.objects.size;
  providers.afterUpload = () => pool.query("UPDATE alumni_69.bookings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
  try { assert.equal((await upload(who, id)).statusCode, 409); }
  finally { providers.afterUpload = null; }
  assert.equal(providers.objects.size, before);
  const { rows: [row] } = await pool.query('SELECT count(*)::int AS count FROM alumni_69.payments WHERE booking_id=$1', [id]);
  assert.equal(row.count, 0);
});

test('reject permits resubmission before original deadline and releases after deadline', async () => {
  const who = await login('reject');
  const id = (await book(who, ['A9'])).json().booking.id;
  await upload(who, id);
  const reject = () => app.inject({ method: 'POST', url: `/admin/bookings/${id}/reject`, headers: staffHeaders(), payload: { reason: 'ยอดไม่ตรง' } });
  assert.equal((await reject()).json().status, 'pending_payment');
  assert.equal((await upload(who, id)).statusCode, 201);
  await pool.query("UPDATE alumni_69.bookings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
  assert.equal((await reject()).json().status, 'cancelled');
  assert.equal((await book(who, ['A9'])).statusCode, 201);
});

test('customer cookie writes require trusted Origin; logout revokes opaque session', async () => {
  const who = await login('logout');
  const request = { method: 'POST', url: '/auth/logout', headers: { cookie: `alumni_session=${who.token}` } };
  assert.equal((await app.inject(request)).statusCode, 403);
  assert.equal((await app.inject({ ...request, headers: { ...request.headers, authorization: 'Basic invalid' } })).statusCode, 401);
  assert.equal((await app.inject({ ...request, headers: { ...request.headers, origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ ...request, headers: { ...request.headers, origin: 'http://localhost:5173' } })).statusCode, 204);
  assert.equal((await app.inject({ url: '/me', headers: who.headers })).statusCode, 401);
});

test('staff password login uses server-side role and rechecks it on later requests', async () => {
  const response = await app.inject({ method: 'POST', url: '/auth/staff/login', payload: { email: 'manager@example.test', password: 'test-only-password' } });
  assert.equal(response.json().role, 'manager');
  assert.equal((await app.inject({ url: '/admin/payments', headers: staffHeaders('manager') })).statusCode, 403);
  await pool.query("UPDATE alumni_69.staff_accounts SET role='manager' WHERE auth_user_id=$1", [STAFF.staff]);
  try { assert.equal((await app.inject({ url: '/admin/payments', headers: staffHeaders() })).statusCode, 403); }
  finally { await pool.query("UPDATE alumni_69.staff_accounts SET role='staff' WHERE auth_user_id=$1", [STAFF.staff]); }
});

test('staff username login preserves role checks and rejects ambiguous or invalid credentials', async () => {
  for (const role of ['admin', 'manager', 'staff']) {
    const response = await app.inject({ method: 'POST', url: '/auth/staff/login', payload: { username: role.toUpperCase(), password: 'test-only-password' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().role, role);
  }
  for (const payload of [
    { username: 'unknown-user', password: 'test-only-password' },
    { username: 'admin', password: 'wrong-password' },
  ]) assert.equal((await app.inject({ method: 'POST', url: '/auth/staff/login', payload })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/staff/login', payload: { email: 'admin@example.test', username: 'staff', password: 'test-only-password' } })).statusCode, 400);
});

test('listening HTTP API accepts real multipart flow and simultaneous booking requests', async () => {
  const alice = await login('http-alice'), bob = await login('http-bob');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const call = (path, options = {}) => fetch(address + path, options);
  const loggedIn = await call('/auth/staff/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'staff@example.test', password: 'test-only-password' }) });
  assert.equal(loggedIn.status, 200);
  const accessToken = (await loggedIn.json()).access_token;
  const create = (who, ids) => call('/bookings', { method: 'POST', headers: { ...who.headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(customerBody(ids)) });
  const created = await create(alice, ['A10', 'A11']);
  assert.equal(created.status, 201);
  const booking = (await created.json()).booking;
  assert.equal(booking.total_amount, 7000);
  const form = new FormData();
  form.set('file', new Blob([png], { type: 'image/png' }), 'slip.png');
  const sent = await call(`/bookings/${booking.id}/slip`, { method: 'POST', headers: alice.headers, body: form });
  assert.equal(sent.status, 201);
  const approved = await call(`/admin/bookings/${booking.id}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(approved.status, 200);
  const cards = await call(`/bookings/${booking.id}/tickets`, { headers: alice.headers });
  assert.equal((await cards.json()).tickets.length, 16);
  const race = await Promise.all([create(alice, ['A12']), create(bob, ['A12'])]);
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  for (const response of race) await response.json();
});
