import { readConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { SupabaseRepository } from './supabase-db.js';

const config = readConfig();
const pool = config.databaseTransport === 'postgres' ? createPool(config) : null;
if (pool) pool.on('error', () => console.error('Database connection unavailable'));
const repository = pool ? undefined : new SupabaseRepository(config);
const app = await createApp({ config, pool, repository });
const stop = async () => { await app.close(); if (pool) await pool.end(); };
process.once('SIGINT', async () => { await stop(); process.exit(0); });
process.once('SIGTERM', async () => { await stop(); process.exit(0); });
try { await app.listen({ host: config.host, port: config.port }); }
catch { console.error('Could not start API; check configuration, database access and listen port'); await stop(); process.exitCode = 1; }
