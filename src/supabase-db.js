import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { hash, opaque, encrypt } from './crypto.js';
import { ApiError } from './errors.js';

// Uses a fixed, service-role-only RPC with named operations, never arbitrary SQL.
export class SupabaseRepository {
  constructor(config, client) {
    this.config = config;
    this.client = client || createClient(config.supabaseUrl, config.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) }) },
    });
  }
  async call(action, data = {}) {
    const { data: result, error } = await this.client.rpc('alumni69_backend', { p_action: action, p_data: data });
    if (error) {
      if (/^PT[45][0-9]{2}$/.test(error.code || '')) throw new ApiError(Number(error.code.slice(2)), error.message, error.message.replaceAll('_', ' '));
      // Preserve only error code for the existing safe HTTP error mapper.
      const failure = new Error('Database RPC failed');
      failure.code = error.code || 'RPC_UNAVAILABLE';
      throw failure;
    }
    return result;
  }
  decorate(booking) { return { ...booking, payment_deadline_passed: new Date(booking.expires_at).getTime() <= Date.now() }; }
  ready() { return this.call('ready'); }
  slipAttached(path) { return this.call('slip_attached', { path }); }
  staff(id) { return this.call('staff', { id }); }
  staffLoginEmail(username) { return this.call('staff_login_email', { username }); }
  customerSession(token) { return this.call('customer_session', { token_hash: hash(token) }); }
  async loginCustomer(profile, accessToken) {
    const token = `cust_${opaque()}`;
    const customer = await this.call('login_customer', { line_id: profile.sub, display_name: profile.name || profile.sub,
      picture_url: profile.picture || null, token_hash: hash(token), line_access_token: encrypt(accessToken, this.config.encryptionKey), ttl: this.config.sessionTtl });
    return { token, customer };
  }
  logout(token) { return this.call('logout', { token_hash: hash(token) }); }
  oauthStart(state, browser, nonce, verifier) { return this.call('oauth_start', { state_hash: hash(state), browser_hash: hash(browser), nonce, verifier }); }
  oauthConsume(state, browser) { return this.call('oauth_consume', { state_hash: hash(state), browser_hash: hash(browser) }); }
  acknowledgeGroup(id) { return this.call('acknowledge_group', { id }); }
  updateProfile(id, name, phone) { return this.call('update_profile', { id, name, phone }); }
  tables() { return this.call('tables'); }
  async booking(id, customerId) { return this.decorate(await this.call('booking', { id, customer_id: customerId })); }
  bookings(customerId) { return this.call('bookings', { customer_id: customerId }); }
  async createBooking(customerId, body, key) {
    const tables = [...body.table_ids].sort();
    const bodyHash = hash(JSON.stringify({ name: body.booker_name, phone: body.phone, tables }));
    const result = await this.call('create_booking', { customer_id: customerId, name: body.booker_name, phone: body.phone, tables, key, body_hash: bodyHash });
    return { ...result, booking: this.decorate(result.booking) };
  }
  assertUploadable(id, customerId) { return this.call('assert_uploadable', { id, customer_id: customerId }); }
  async submitSlip(id, customerId, path) {
    const result = await this.call('submit_slip', { id, customer_id: customerId, path });
    return { ...result, booking: this.decorate(result.booking) };
  }
  async confirm(id, actor) { return this.decorate(await this.call('confirm', { id, actor })); }
  async reject(id, actor, reason) { return this.decorate(await this.call('reject', { id, actor, reason })); }
  pendingPayments() { return this.call('pending_payments'); }
  slipPath(id) { return this.call('slip_path', { id }); }
  tickets(id, customerId) { return this.call('tickets', { id, customer_id: customerId }); }
  ticket(token) { return this.call('ticket', { token }); }
  dashboard() { return this.call('dashboard'); }
  slipObjectPath(customerId, bookingId, extension) { return `${customerId}/${bookingId}/${randomUUID()}.${extension}`; }
}
