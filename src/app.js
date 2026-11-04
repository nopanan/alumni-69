import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { Repository } from './db.js';
import { createProviders } from './providers.js';
import { challenge, decrypt, opaque } from './crypto.js';
import { ApiError, fail } from './errors.js';

const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const bookingParams = object({ id: uuid });
const name = { type: 'string', minLength: 1, maxLength: 150, pattern: '\\S' };
const phone = { type: 'string', pattern: '^\\+?[0-9]{9,15}$' };
const MAX_SLIP = 5 * 1024 * 1024;

export function detectImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { type: 'image/png', ext: 'png' };
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { type: 'image/jpeg', ext: 'jpg' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  fail(415, 'INVALID_SLIP_TYPE', 'Slip must be a PNG, JPEG or WebP image');
}

export async function createApp({ config, pool, repository, providers = createProviders(config) }) {
  const app = Fastify({
    logger: config.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] } : false,
    logController: new LogController({ disableRequestLogging: true }), bodyLimit: MAX_SLIP + 65536,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const repo = repository || new Repository(pool, config);
  await app.register(cookie);
  if (config.rateLimit !== false) await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: MAX_SLIP, files: 1, fields: 0, parts: 1 } });
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' };
  const sessionCookie = config.secureCookies ? '__Host-alumni_session' : 'alumni_session';
  const oauthCookie = config.secureCookies ? '__Host-alumni_oauth' : 'alumni_oauth';
  const allowedOrigins = new Set([config.appOrigin, config.frontendOrigin]);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) fail(403, 'ORIGIN_NOT_ALLOWED', 'Origin not allowed');
    if (origin) reply.header('Access-Control-Allow-Origin', origin).header('Access-Control-Allow-Credentials', 'true').header('Vary', 'Origin');
    if (request.method === 'OPTIONS') return reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS')
      .header('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key').code(204).send();
  });
  const customer = async (request) => {
    const authorization = request.headers.authorization;
    const bearer = authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (authorization && !bearer) fail(401, 'INVALID_AUTHORIZATION', 'Use a Bearer token');
    const token = bearer || request.cookies[sessionCookie];
    if (!token || !/^cust_[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'LOGIN_REQUIRED', 'Please sign in with LINE');
    if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !allowedOrigins.has(request.headers.origin)) fail(403, 'ORIGIN_REQUIRED', 'Cookie requests require a trusted Origin header');
    const session = await repo.customerSession(token);
    if (!session) fail(401, 'SESSION_EXPIRED', 'Please sign in with LINE again');
    request.customer = session;
    request.customerToken = token;
  };
  const staff = (roles = ['admin', 'manager', 'staff']) => async (request) => {
    const token = request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token || token.startsWith('cust_')) fail(401, 'STAFF_LOGIN_REQUIRED', 'Staff login required');
    const user = await providers.staffUser(token);
    const account = await repo.staff(user.id);
    if (!account || !roles.includes(account.role)) fail(403, 'FORBIDDEN', 'Insufficient staff permissions');
    request.staff = account;
    request.staffToken = token;
  };
  const reviewer = staff(['admin', 'staff']);
  const gate = async (request) => {
    if (config.requireGroupAck && !request.customer.group_acknowledged_at) fail(403, 'LINE_GROUP_ACK_REQUIRED', 'Please acknowledge joining the event LINE group');
    if (config.requireOaFriend && !await providers.friendship(decrypt(request.customer.line_access_token, config.encryptionKey))) fail(403, 'LINE_OA_FRIEND_REQUIRED', 'Please add the event LINE OA as a friend');
  };

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async () => {
    if (!await repo.ready()) fail(503, 'DATABASE_SETUP_REQUIRED', 'Database setup is incomplete');
    return { status: 'ready' };
  });
  app.get('/tables', async () => repo.tables());
  app.get('/reserved_areas', async () => ({ reserved_areas: (await repo.tables()).reserved_areas }));

  app.post('/auth/staff/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { body: {
      ...object({ email: { type: 'string', minLength: 3, maxLength: 254 },
        username: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{2,49}$' },
        password: { type: 'string', minLength: 1, maxLength: 200 } }, ['password']),
      oneOf: [{ required: ['email'] }, { required: ['username'] }],
    } },
  }, async (request) => {
    const email = request.body.email || await repo.staffLoginEmail(request.body.username.toLowerCase());
    if (!email) fail(401, 'INVALID_LOGIN', 'Invalid staff credentials');
    const data = await providers.staffLogin(email, request.body.password);
    const account = await repo.staff(data.user.id);
    if (!account) fail(403, 'FORBIDDEN', 'This account has no staff role');
    return { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_in: data.session.expires_in, token_type: 'bearer', role: account.role };
  });
  app.post('/auth/staff/refresh', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: object({ refresh_token: { type: 'string', minLength: 1, maxLength: 4096 } }) },
  }, async (request) => {
    const data = await providers.staffRefresh(request.body.refresh_token);
    const account = await repo.staff(data.user.id);
    if (!account) fail(403, 'FORBIDDEN', 'This account has no staff role');
    return { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_in: data.session.expires_in, token_type: 'bearer', role: account.role };
  });
  app.post('/auth/staff/logout', { preHandler: staff() }, async (request, reply) => {
    await providers.staffLogout(request.staffToken);
    return reply.code(204).send();
  });
  app.get('/auth/staff/me', { preHandler: staff() }, async (request) => request.staff);

  app.get('/auth/line', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!config.lineChannelId || !config.lineChannelSecret || !config.lineRedirectUri) fail(503, 'LINE_NOT_CONFIGURED', 'LINE Login is not configured');
    const state = opaque(), browser = opaque(), nonce = opaque(), verifier = opaque();
    await repo.oauthStart(state, browser, nonce, verifier);
    const url = new URL('https://access.line.me/oauth2/v2.1/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: config.lineChannelId, redirect_uri: config.lineRedirectUri,
      state, scope: 'openid profile', nonce, code_challenge: challenge(verifier), code_challenge_method: 'S256', bot_prompt: 'aggressive' });
    reply.setCookie(oauthCookie, browser, { ...cookieOptions, maxAge: 600 });
    return reply.redirect(url.href);
  });
  app.get('/auth/line/callback', {
    schema: { querystring: object({ state: { type: 'string', minLength: 1, maxLength: 200 }, code: { type: 'string', minLength: 1, maxLength: 4096 }, error: { type: 'string', maxLength: 200 }, error_description: { type: 'string', maxLength: 1000 }, friendship_status_changed: { type: 'string', maxLength: 10 } }, ['state']) },
  }, async (request, reply) => {
    const browser = request.cookies[oauthCookie];
    if (!browser) fail(401, 'OAUTH_STATE_INVALID', 'Start LINE Login again');
    const state = await repo.oauthConsume(request.query.state, browser);
    reply.clearCookie(oauthCookie, cookieOptions);
    if (!state) fail(401, 'OAUTH_STATE_INVALID', 'Invalid or expired login state');
    if (request.query.error || !request.query.code) fail(401, 'LINE_LOGIN_CANCELLED', 'LINE Login was cancelled');
    const identity = await providers.exchangeLine(request.query.code, state.code_verifier, state.nonce);
    const session = await repo.loginCustomer(identity.profile, identity.accessToken);
    reply.setCookie(sessionCookie, session.token, { ...cookieOptions, maxAge: config.sessionTtl });
    return reply.redirect(`${config.frontendOrigin}/`);
  });
  app.post('/auth/logout', { preHandler: customer }, async (request, reply) => {
    await repo.logout(request.customerToken);
    reply.clearCookie(sessionCookie, cookieOptions);
    return reply.code(204).send();
  });
  app.get('/me', { preHandler: customer }, async (request) => ({
    id: request.customer.customer_id, display_name: request.customer.display_name, full_name: request.customer.full_name,
    phone: request.customer.phone, group_acknowledged_at: request.customer.group_acknowledged_at,
  }));
  app.patch('/me', { preHandler: customer, schema: { body: object({ full_name: name, phone }) } }, async (request) => repo.updateProfile(request.customer.customer_id, request.body.full_name.trim(), request.body.phone));
  app.get('/me/line', { preHandler: customer }, async (request) => ({
    oa_friend: await providers.friendship(decrypt(request.customer.line_access_token, config.encryptionKey)),
    group_acknowledged_at: request.customer.group_acknowledged_at, group_membership_verified: false,
    oa_add_friend_url: config.oaAddFriendUrl, group_invite_url: config.groupInviteUrl,
    require_oa_friend: config.requireOaFriend, require_group_ack: config.requireGroupAck,
  }));
  app.post('/me/line/group-acknowledgement', { preHandler: customer, schema: { body: object({ acknowledged: { const: true, type: 'boolean' } }) } }, async (request) => ({ ...await repo.acknowledgeGroup(request.customer.customer_id), group_membership_verified: false }));

  app.post('/bookings', { preHandler: [customer, gate], schema: {
    headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' } } },
    body: object({ booker_name: name, phone, table_ids: { type: 'array', minItems: 1, maxItems: 194, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 50 } } }),
  } }, async (request, reply) => {
    const result = await repo.createBooking(request.customer.customer_id, { ...request.body, booker_name: request.body.booker_name.trim() }, request.headers['idempotency-key']);
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.get('/bookings', { preHandler: customer }, async (request) => ({ bookings: await repo.bookings(request.customer.customer_id) }));
  app.get('/bookings/:id', { preHandler: customer, schema: { params: bookingParams } }, async (request) => repo.booking(request.params.id, request.customer.customer_id));
  app.post('/bookings/:id/slip', { preHandler: customer, schema: { params: bookingParams } }, async (request, reply) => {
    const id = request.params.id, customerId = request.customer.customer_id;
    await repo.assertUploadable(id, customerId);
    if (!request.isMultipart()) fail(415, 'MULTIPART_REQUIRED', 'Upload one image using multipart field file');
    let bytes;
    for await (const part of request.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'file') fail(400, 'INVALID_SLIP_FIELD', 'Upload one image using field file');
      bytes = await part.toBuffer();
    }
    if (!bytes?.length) fail(400, 'SLIP_REQUIRED', 'A slip image is required');
    const image = detectImage(bytes);
    const path = repo.slipObjectPath(customerId, id, image.ext);
    await providers.uploadSlip(path, bytes, image.type);
    try { return reply.code(201).send(await repo.submitSlip(id, customerId, path)); }
    catch (error) {
      // Remove only the new unattached object. Never delete an attached slip.
      const attached = await repo.slipAttached(path).catch(() => true);
      if (!attached) await providers.removeSlip(path).catch(() => app.log.error({ code: 'ORPHAN_SLIP', path }, 'Slip cleanup failed'));
      throw error;
    }
  });
  app.get('/bookings/:id/tickets', { preHandler: customer, schema: { params: bookingParams } }, async (request) => ({ tickets: (await repo.tickets(request.params.id, request.customer.customer_id)).map((ticket) => ({ ...ticket, url: `${config.appOrigin}/tickets/${ticket.token}` })) }));
  app.get('/tickets/:token', { schema: { params: object({ token: uuid }) } }, async (request) => repo.ticket(request.params.token));

  app.get('/admin/payments', { preHandler: reviewer }, async () => ({ payments: await repo.pendingPayments() }));
  app.get('/admin/payments/:id/slip', { preHandler: reviewer, schema: { params: bookingParams } }, async (request) => ({ url: await providers.signedSlip(await repo.slipPath(request.params.id)), expires_in: 120 }));
  app.get('/admin/bookings/:id', { preHandler: reviewer, schema: { params: bookingParams } }, async (request) => repo.booking(request.params.id, null));
  app.post('/admin/bookings/:id/confirm', { preHandler: reviewer, schema: { params: bookingParams } }, async (request) => repo.confirm(request.params.id, request.staff.auth_user_id));
  app.post('/admin/bookings/:id/reject', { preHandler: reviewer, schema: { params: bookingParams, body: object({ reason: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' } }) } }, async (request) => repo.reject(request.params.id, request.staff.auth_user_id, request.body.reason.trim()));
  app.get('/admin/dashboard', { preHandler: staff() }, async () => repo.dashboard());
  app.get('/booking_summary', { preHandler: staff() }, async () => {
    const dashboard = await repo.dashboard();
    const fields = ['confirmed_tables', 'pending_tables', 'available_tables', 'confirmed_amount', 'pending_amount', 'available_amount'];
    return Object.fromEntries(fields.map((field) => [field, dashboard[field]]));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    if (error.validation) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Invalid request', details: error.validation.map(({ instancePath, keyword }) => ({ path: instancePath, rule: keyword })) });
    if (error.code === '23505') return reply.code(409).send({ error: 'TABLE_UNAVAILABLE', message: 'A selected table is already reserved' });
    if (error.code === 'P0001') return reply.code(409).send({ error: 'BOOKING_STATE_CONFLICT', message: 'Booking or table is not available for this operation' });
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'REQUEST_REJECTED', message: error.statusCode === 413 ? 'Slip exceeds 5 MB limit' : 'Request rejected' });
    app.log.error({ code: error.code || 'UNEXPECTED', requestId: request.id }, 'Request failed');
    return reply.code(503).send({ error: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' });
  });
  return app;
}
