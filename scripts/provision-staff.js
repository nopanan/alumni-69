// Operator-only bootstrap. No public signup/role-management endpoint is added.
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { readConfig } from '../src/config.js';

const config = readConfig();
const file = process.env.STAFF_CREDENTIALS_FILE || '.env.staff-credentials.json';
const roles = new Set(['admin', 'manager', 'staff']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message) => { throw new Error(message); };
const client = createClient(config.supabaseUrl, config.supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) },
});
let document;
const save = async () => { await writeFile(file, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 }); await chmod(file, 0o600); };
async function studioQuery(query) {
  const username = process.env.STUDIO_USERNAME, password = process.env.STUDIO_PASSWORD;
  if (!username || !password) fail('Set STUDIO_USERNAME and STUDIO_PASSWORD for this operator command');
  const url = new URL('/api/platform/pg-meta/default/query', config.supabaseUrl);
  const response = await fetch(url, { method: 'POST', headers: {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    'Content-Type': 'application/json',
  }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15000), redirect: 'manual' });
  if (!response.ok) fail(`Studio request failed (${response.status}); account passwords are preserved in the private file`);
  const rows = await response.json();
  if (!Array.isArray(rows)) fail('Unexpected Studio response; no credentials were printed');
  return rows;
}

try {
  document = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(document.accounts) || document.accounts.length !== 3) fail('Prepare exactly three accounts in the private credentials file');
  const seenRoles = new Set(), seenEmails = new Set(), seenUsernames = new Set();
  for (const account of document.accounts) {
    if (!roles.has(account.role) || seenRoles.has(account.role)) fail('Account roles must be admin, manager and staff exactly once');
    account.username ||= account.role;
    if (!/^[a-z][a-z0-9._-]{2,49}$/.test(account.username) || seenUsernames.has(account.username)) fail('Staff usernames must be unique lowercase names');
    if (typeof account.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) || seenEmails.has(account.email.toLowerCase())) fail('Account emails must be valid and unique');
    if (typeof account.password !== 'string' || account.password.length < 6) fail('Use a password of at least 6 characters; Supabase Auth applies its configured policy');
    if (account.userId && !uuid.test(account.userId)) fail('Invalid stored Auth user ID');
    seenRoles.add(account.role); seenEmails.add(account.email.toLowerCase());
    seenUsernames.add(account.username);
  }
  const existing = new Map();
  for (let page = 1; ; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 100 });
    if (error) fail(`Cannot inspect existing Auth accounts (${error.status || 'auth error'})`);
    for (const user of data.users) if (user.email) existing.set(user.email.toLowerCase(), user);
    if (data.users.length < 100) break;
  }
  for (const account of document.accounts) {
    const user = existing.get(account.email.toLowerCase());
    if (user && user.id !== account.userId) fail('A requested email already belongs to another account; no existing password or role will be changed');
  }
  await studioQuery("SELECT to_regclass('alumni_69.staff_accounts') IS NOT NULL AS ready");
  for (const account of document.accounts) {
    if (account.userId) continue;
    const { data, error } = await client.auth.admin.createUser({
      email: account.email, password: account.password, email_confirm: true,
      app_metadata: { created_by: 'alumni69_staff_setup' },
    });
    if (error || !data.user) fail(`Cannot create ${account.role} account (${error?.status || 'auth error'}); rerun preserves completed accounts`);
    if (!uuid.test(data.user.id)) fail('Unexpected Auth user ID; role assignment stopped');
    account.userId = data.user.id;
    await save();
    console.log(`Created Auth account for ${account.role}; password not printed.`);
  }
  // Values interpolated below are validated UUIDs and allowlisted role names only.
  const values = document.accounts.map((a) => `('${a.userId}'::uuid,'${a.role}')`).join(',');
  const logins = document.accounts.map((a) => `('${a.userId}'::uuid,'${a.username}')`).join(',');
  await studioQuery(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM alumni_69.staff_accounts s JOIN (VALUES ${values}) AS wanted(id,role)
      ON s.auth_user_id=wanted.id WHERE s.role<>wanted.role) THEN
      RAISE EXCEPTION 'Existing staff role differs; manual review required';
    END IF;
    INSERT INTO alumni_69.staff_accounts(auth_user_id,role) VALUES ${values} ON CONFLICT(auth_user_id) DO NOTHING;
    IF EXISTS(SELECT 1 FROM alumni_69.staff_users s JOIN (VALUES ${logins}) AS wanted(id,username)
      ON s.username=wanted.username WHERE s.auth_user_id<>wanted.id) THEN
      RAISE EXCEPTION 'Username already belongs to another staff account';
    END IF;
    INSERT INTO alumni_69.staff_users(auth_user_id,username) VALUES ${logins} ON CONFLICT(auth_user_id) DO NOTHING;
  END $$;`);
  for (const account of document.accounts) account.roleAssigned = true;
  await save();
  console.log('Assigned admin, manager and staff roles; existing account roles were not replaced.');
} catch (error) {
  // Only operator-authored errors are printed; never dump SDK response objects.
  console.error(error instanceof SyntaxError ? 'Invalid private credentials JSON' : error.message);
  process.exitCode = 1;
}
