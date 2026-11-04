import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { hash, opaque, encrypt } from './crypto.js';
import { fail } from './errors.js';

export const createPool = (config) => new pg.Pool({
  connectionString: config.databaseUrl, max: config.poolMax,
  connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
  statement_timeout: 15000, application_name: 'alumni69-api',
});

export async function transaction(pool, run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export class Repository {
  constructor(pool, config) { this.pool = pool; this.config = config; }
  async one(sql, params = [], client = this.pool) { return (await client.query(sql, params)).rows[0]; }
  async ready() {
    const row = await this.one(`SELECT to_regclass('alumni_api_private.customer_sessions') IS NOT NULL
      AND to_regclass('alumni_69.staff_users') IS NOT NULL
      AND to_regprocedure('alumni_69.create_booking(uuid,text,text,text[])') IS NOT NULL AS ready`);
    return row.ready;
  }
  async slipAttached(path) { return !!await this.one('SELECT id FROM alumni_69.payments WHERE slip_path=$1', [path]); }
  async staff(id) { return this.one('SELECT auth_user_id, role FROM alumni_69.staff_accounts WHERE auth_user_id=$1', [id]); }
  async staffLoginEmail(username) {
    const row = await this.one(`SELECT u.email FROM alumni_69.staff_users s
      JOIN auth.users u ON u.id=s.auth_user_id WHERE s.username=$1`, [username]);
    return row?.email || null;
  }
  async customerSession(token) {
    return this.one(`SELECT s.*, c.display_name, c.full_name, c.phone,
      a.group_acknowledged_at FROM alumni_api_private.customer_sessions s
      JOIN alumni_69.customers c ON c.id=s.customer_id
      LEFT JOIN alumni_api_private.line_acknowledgements a ON a.customer_id=c.id
      WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()`, [hash(token)]);
  }
  async loginCustomer(profile, accessToken) {
    const token = `cust_${opaque()}`;
    const customer = await transaction(this.pool, async (client) => {
      await client.query('DELETE FROM alumni_api_private.customer_sessions WHERE expires_at<clock_timestamp()');
      const { id } = await this.one('SELECT alumni_69.record_login($1,$2,$3) AS id', [profile.sub, profile.name || profile.sub, profile.picture || null], client);
      await client.query(`INSERT INTO alumni_api_private.customer_sessions(token_hash,customer_id,line_access_token,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 second')`, [hash(token), id, encrypt(accessToken, this.config.encryptionKey), this.config.sessionTtl]);
      return this.one('SELECT id, display_name, full_name, phone FROM alumni_69.customers WHERE id=$1', [id], client);
    });
    return { token, customer };
  }
  async logout(token) { await this.pool.query('DELETE FROM alumni_api_private.customer_sessions WHERE token_hash=$1', [hash(token)]); }
  async oauthStart(state, browser, nonce, verifier) {
    await this.pool.query('DELETE FROM alumni_api_private.oauth_states WHERE expires_at<clock_timestamp()');
    await this.pool.query(`INSERT INTO alumni_api_private.oauth_states VALUES($1,$2,$3,$4,clock_timestamp()+interval '10 minutes')`, [hash(state), hash(browser), nonce, verifier]);
  }
  async oauthConsume(state, browser) {
    return this.one(`DELETE FROM alumni_api_private.oauth_states WHERE state_hash=$1 AND browser_hash=$2
      AND expires_at>clock_timestamp() RETURNING nonce,code_verifier`, [hash(state), hash(browser)]);
  }
  async acknowledgeGroup(id) {
    return this.one(`INSERT INTO alumni_api_private.line_acknowledgements(customer_id) VALUES($1)
      ON CONFLICT(customer_id) DO UPDATE SET group_acknowledged_at=clock_timestamp() RETURNING group_acknowledged_at`, [id]);
  }
  async updateProfile(id, name, phone) {
    return this.one('UPDATE alumni_69.customers SET full_name=$2,phone=$3 WHERE id=$1 RETURNING id,display_name,full_name,phone', [id, name, phone]);
  }
  async tables() {
    const [tables, areas] = await Promise.all([
      this.pool.query('SELECT * FROM alumni_69.table_status ORDER BY zone,column_label,table_number'),
      this.pool.query('SELECT * FROM alumni_69.reserved_areas ORDER BY zone,id'),
    ]);
    return { tables: tables.rows, reserved_areas: areas.rows };
  }
  async booking(id, customerId, client = this.pool) {
    const booking = await this.one(`SELECT b.*,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('table_id',i.table_id,'unit_price',i.unit_price) ORDER BY i.table_id),'[]'::jsonb)
       FROM alumni_69.booking_items i WHERE i.booking_id=b.id) AS items,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'status',p.status,'submitted_at',p.submitted_at,'reviewed_at',p.reviewed_at,'rejection_reason',p.rejection_reason) ORDER BY p.submitted_at),'[]'::jsonb)
       FROM alumni_69.payments p WHERE p.booking_id=b.id) AS payments
      FROM alumni_69.bookings b WHERE b.id=$1 AND ($2::uuid IS NULL OR b.customer_id=$2)`, [id, customerId], client);
    if (!booking) fail(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    // The database status remains the source of truth; expose effective expiry separately.
    return { ...booking, payment_deadline_passed: new Date(booking.expires_at).getTime() <= Date.now() };
  }
  async bookings(customerId) {
    return (await this.pool.query(`SELECT id,booker_name,status,total_amount,created_at,expires_at,confirmed_at
      FROM alumni_69.bookings WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`, [customerId])).rows;
  }
  async createBooking(customerId, body, key) {
    const tables = [...body.table_ids].sort();
    const digest = hash(JSON.stringify({ name: body.booker_name, phone: body.phone, tables }));
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${customerId}:${key}`]);
      const previous = await this.one('SELECT * FROM alumni_api_private.booking_requests WHERE customer_id=$1 AND request_key=$2', [customerId, key], client);
      if (previous) {
        if (previous.body_hash !== digest) fail(409, 'IDEMPOTENCY_CONFLICT', 'This key was used for a different booking');
        return { booking: await this.booking(previous.booking_id, customerId, client), replayed: true };
      }
      const { id } = await this.one('SELECT alumni_69.create_booking($1,$2,$3,$4::text[]) AS id', [customerId, body.booker_name, body.phone, tables], client);
      await client.query('INSERT INTO alumni_api_private.booking_requests VALUES($1,$2,$3,$4)', [customerId, key, digest, id]);
      return { booking: await this.booking(id, customerId, client), replayed: false };
    });
  }
  async assertUploadable(id, customerId) {
    await this.booking(id, customerId);
    const valid = await this.one(`SELECT id FROM alumni_69.bookings WHERE id=$1 AND customer_id=$2
      AND status='pending_payment' AND expires_at>clock_timestamp()`, [id, customerId]);
    if (!valid) fail(409, 'NOT_AWAITING_PAYMENT', 'Booking expired or is not awaiting payment');
  }
  async submitSlip(id, customerId, path) {
    const payment = await this.one('SELECT alumni_69.submit_slip($1,$2,$3) AS id', [customerId, id, path]);
    return { payment_id: payment.id, booking: await this.booking(id, customerId) };
  }
  async confirm(id, actor) {
    await this.booking(id, null);
    await this.pool.query('SELECT alumni_69.confirm_payment($1,$2)', [id, actor]);
    return this.booking(id, null);
  }
  async reject(id, actor, reason) {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(690035008::bigint)');
      const booking = await this.booking(id, null, client);
      if (booking.status !== 'pending_review') fail(409, 'NOT_AWAITING_REVIEW', 'Booking is not awaiting review');
      const result = await client.query(`UPDATE alumni_69.payments SET status='rejected',reviewed_by=$2,
        reviewed_at=clock_timestamp(),rejection_reason=$3 WHERE booking_id=$1 AND status='pending'`, [id, actor, reason]);
      if (result.rowCount !== 1) fail(409, 'NO_PENDING_SLIP', 'No pending slip');
      const next = await this.one(`UPDATE alumni_69.bookings SET status=CASE WHEN expires_at>clock_timestamp()
        THEN 'pending_payment' ELSE 'cancelled' END WHERE id=$1 RETURNING status`, [id], client);
      if (next.status === 'cancelled') await client.query('DELETE FROM alumni_69.table_claims WHERE booking_id=$1', [id]);
      return this.booking(id, null, client);
    });
  }
  async pendingPayments() {
    return (await this.pool.query(`SELECT p.id,p.booking_id,p.submitted_at,b.booker_name,b.phone,b.total_amount
      FROM alumni_69.payments p JOIN alumni_69.bookings b ON b.id=p.booking_id
      WHERE p.status='pending' AND b.status='pending_review' ORDER BY p.submitted_at LIMIT 100`)).rows;
  }
  async slipPath(paymentId) {
    const row = await this.one('SELECT slip_path FROM alumni_69.payments WHERE id=$1', [paymentId]);
    if (!row) fail(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    return row.slip_path;
  }
  async tickets(id, customerId) {
    const booking = await this.booking(id, customerId);
    if (booking.status !== 'confirmed') fail(409, 'TICKETS_NOT_READY', 'Payment has not been confirmed');
    return (await this.pool.query('SELECT id,table_id,seat_number,token,used_at FROM alumni_69.tickets WHERE booking_id=$1 ORDER BY table_id,seat_number', [id])).rows;
  }
  async ticket(token) {
    const row = await this.one(`SELECT t.id,t.table_id,t.seat_number,t.used_at FROM alumni_69.tickets t
      JOIN alumni_69.bookings b ON b.id=t.booking_id WHERE t.token=$1 AND b.status='confirmed'`, [token]);
    if (!row) fail(404, 'TICKET_NOT_FOUND', 'Ticket not found');
    return row;
  }
  async dashboard() {
    const [summary, customers, review] = await Promise.all([
      this.one('SELECT * FROM alumni_69.booking_summary'),
      this.one(`SELECT count(*) AS total_customers,
        count(*) FILTER (WHERE EXISTS(SELECT 1 FROM alumni_69.bookings b WHERE b.customer_id=c.id AND b.status='confirmed')) AS buyers
        FROM alumni_69.customers c`),
      this.one(`SELECT count(*) AS pending_review_bookings FROM alumni_69.bookings WHERE status='pending_review'`),
    ]);
    return { ...summary, ...customers, non_buyers: String(BigInt(customers.total_customers) - BigInt(customers.buyers)), ...review };
  }
  slipObjectPath(customerId, bookingId, extension) { return `${customerId}/${bookingId}/${randomUUID()}.${extension}`; }
}
