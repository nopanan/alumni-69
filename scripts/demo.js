// Local, disposable demonstration. Never uses .env or the live database.
import { createApp } from '../src/app.js';
import { Repository } from '../src/db.js';
import { testDatabase } from '../test/helpers/database.js';
import { testConfig } from '../test/helpers/config.js';
import { mockProviders, STAFF } from '../test/helpers/providers.js';

const database = await testDatabase();
const config = testConfig();
const port = Number(process.env.DEMO_PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DEMO_PORT');
config.appOrigin = `http://localhost:${port}`;
let app;
try {
  for (const [role, id] of Object.entries(STAFF)) {
    await database.pool.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${role}@example.test`]);
    await database.pool.query('INSERT INTO alumni_69.staff_accounts VALUES($1,$2)', [id, role]);
    await database.pool.query('INSERT INTO alumni_69.staff_users(auth_user_id,username) VALUES($1,$2)', [id, role]);
  }
  const repo = new Repository(database.pool, config);
  const alice = await repo.loginCustomer({ sub: 'demo-alice', name: 'Demo Alice' }, 'demo-line-access-alice');
  const bob = await repo.loginCustomer({ sub: 'demo-bob', name: 'Demo Bob' }, 'demo-line-access-bob');
  await repo.acknowledgeGroup(alice.customer.id);
  await repo.acknowledgeGroup(bob.customer.id);
  app = await createApp({ config, pool: database.pool, providers: mockProviders() });
  await app.listen({ host: '127.0.0.1', port });
  console.log('LOCAL DEMO: disposable PostgreSQL; LINE, staff Auth and Storage are simulated.');
  console.log(`API: http://localhost:${port}`);
  console.log(`Customer Alice bearer: ${alice.token}`);
  console.log(`Customer Bob bearer:   ${bob.token}`);
  console.log('Staff login: admin@example.test / staff@example.test / manager@example.test');
  console.log('Demo-only password: test-only-password');
  console.log('Ctrl+C stops the API and removes this demo database.');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close(); await database.close(); process.exit(0);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) {
  if (app) await app.close();
  await database.close();
  console.error(error.message); process.exitCode = 1;
}
