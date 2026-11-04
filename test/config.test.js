import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';

const env = () => ({
  NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:3000', FRONTEND_ORIGIN: 'http://localhost:5173',
  SESSION_ENCRYPTION_KEY: 'a'.repeat(64), SUPABASE_URL: 'http://supabase.example.test',
  SUPABASE_PUBLISHABLE_KEY: 'test-public', SUPABASE_SECRET_KEY: 'test-secret',
});
test('Supabase transport starts without PostgreSQL URL but requires a server key', () => {
  const settings = { ...env(), DATABASE_TRANSPORT: 'supabase' };
  assert.equal(readConfig(settings).databaseUrl, null);
  assert.equal(readConfig(settings).databaseTransport, 'supabase');
  assert.throws(() => readConfig({ ...settings, SUPABASE_SECRET_KEY: '' }), /SUPABASE_SECRET_KEY/);
});
test('direct PostgreSQL transport still requires a connection URL', () => {
  assert.throws(() => readConfig({ ...env(), DATABASE_TRANSPORT: 'postgres' }), /DATABASE_URL/);
  assert.equal(readConfig({ ...env(), DATABASE_URL: 'postgresql://user:password@localhost/postgres' }).databaseTransport, 'postgres');
});
test('unknown transport cannot silently select a different backend', () => {
  assert.throws(() => readConfig({ ...env(), DATABASE_TRANSPORT: 'other' }), /DATABASE_TRANSPORT/);
});
