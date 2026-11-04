// Run the same API/concurrency/ownership suite over actual HTTP RPC + PostgreSQL.
process.env.ALUMNI_TEST_TRANSPORT = 'supabase';
await import('./integration.test.js');
