import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../src/providers.js';

const config = {
  supabaseUrl: 'http://supabase.example.test', supabasePublishableKey: 'test-publishable-key',
  supabaseSecretKey: 'test-secret-key', slipBucket: 'test-slips',
  lineChannelId: '12345', lineChannelSecret: 'test-channel-secret', lineRedirectUri: 'http://localhost:3000/auth/line/callback',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const profile = { iss: 'https://access.line.me', aud: '12345', sub: 'Utest', nonce: 'expected-nonce', exp: Math.floor(Date.now() / 1000) + 600 };

test('LINE code exchange sends PKCE, channel credentials, redirect and nonce to fixed endpoints', async () => {
  const calls = [];
  const providers = createProviders(config, { fetchImpl: async (url, options) => {
    calls.push({ url: String(url), body: new URLSearchParams(options.body) });
    return String(url).endsWith('/token') ? json({ access_token: 'line-access', id_token: 'line-id-token' }) : json(profile);
  } });
  const result = await providers.exchangeLine('code', 'verifier', 'expected-nonce');
  assert.equal(result.profile.sub, 'Utest');
  assert.equal(calls[0].url, 'https://api.line.me/oauth2/v2.1/token');
  assert.equal(calls[0].body.get('code_verifier'), 'verifier');
  assert.equal(calls[0].body.get('client_secret'), 'test-channel-secret');
  assert.equal(calls[1].body.get('nonce'), 'expected-nonce');
  assert.equal(calls[1].body.get('client_id'), '12345');
});

test('LINE identity rejects wrong nonce, wrong audience, wrong issuer and expiry', async () => {
  for (const invalid of [{ nonce: 'wrong' }, { aud: 'other-channel' }, { iss: 'https://evil.example' }, { exp: 1 }, { exp: undefined }, { sub: {} }]) {
    const providers = createProviders(config, { fetchImpl: async (url) => String(url).endsWith('/token') ? json({ access_token: 'a', id_token: 'i' }) : json({ ...profile, ...invalid }) });
    await assert.rejects(() => providers.exchangeLine('code', 'verifier', 'expected-nonce'), { statusCode: 401 });
  }
});

test('LINE friendship reads authoritative friendFlag; provider failure is not treated as friendship', async () => {
  for (const friendFlag of [true, false]) {
    const providers = createProviders(config, { fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://api.line.me/friendship/v1/status');
      assert.equal(options.headers.Authorization, 'Bearer line-access');
      return json({ friendFlag });
    } });
    assert.equal(await providers.friendship('line-access'), friendFlag);
  }
  const providers = createProviders(config, { fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(() => providers.friendship('token'), { statusCode: 502 });
});

test('staff identity is obtained from Supabase Auth server using the supplied bearer', async () => {
  const providers = createProviders(config, { fetchImpl: async (url, options) => {
    assert.equal(String(url), 'http://supabase.example.test/auth/v1/user');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer caller-token');
    return json({ id: '00000000-0000-4000-8000-000000000001' });
  } });
  assert.equal((await providers.staffUser('caller-token')).id, '00000000-0000-4000-8000-000000000001');
});

test('staff Auth rejects invalid external token', async () => {
  const providers = createProviders(config, { fetchImpl: async () => json({ msg: 'invalid JWT', code: 'bad_jwt' }, 401) });
  await assert.rejects(() => providers.staffUser('forged-token'), { statusCode: 401 });
});

test('Storage uses server key and signed read URLs instead of public URLs', async () => {
  const calls = [];
  const providers = createProviders(config, { fetchImpl: async (url, options) => {
    calls.push({ url: String(url), method: options.method, headers: new Headers(options.headers) });
    if (String(url).includes('/object/sign/')) return json({ signedURL: '/object/sign/test-slips/customer/booking/file.png?token=signed' });
    return json({ Key: 'test-slips/customer/booking/file.png', Id: 'object-id' });
  } });
  await providers.uploadSlip('customer/booking/file.png', Buffer.from('image'), 'image/png');
  assert.equal(calls[0].headers.get('apikey'), 'test-secret-key');
  assert.equal(calls[0].headers.get('x-upsert'), 'false');
  assert.match(await providers.signedSlip('customer/booking/file.png'), /\/storage\/v1\/object\/sign\//);
});
