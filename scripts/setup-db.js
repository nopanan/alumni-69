import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { SupabaseRepository } from '../src/supabase-db.js';
let pool;
const configurationError = (message) => Object.assign(new Error(message), { code: 'SETUP_CONFIG' });
try {
  if (process.env.DATABASE_TRANSPORT === 'supabase') {
    try {
      if (!await new SupabaseRepository(readConfig()).ready()) throw new Error('RPC not ready');
    } catch {
      throw configurationError('โหมด Supabase API: ติดตั้ง db/setup-api.sql, db/staff-users.sql และ db/supabase-api.sql ตามลำดับผ่าน SQL Editor ใน Studio แล้วตรวจ server key');
    }
    console.log('Supabase API database connection ready; private API tables and server-only RPC are installed.');
  } else {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw configurationError('กรอก DATABASE_URL ในไฟล์ .env ก่อน');
  let url;
  try { url = new URL(connectionString); }
  catch { throw configurationError('รูปแบบ DATABASE_URL ไม่ถูกต้อง ต้องเป็น postgresql://USER:PASSWORD@HOST:PORT/DATABASE โดยแทนค่าตัวอย่างทั้งหมดด้วยค่าจริง'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw configurationError('DATABASE_URL ต้องระบุ PostgreSQL host และชื่อ database ให้ครบ');
  }
  let fields;
  try {
    const placeholder = (value) => /^(?:USER|PASSWORD|HOST|DB_USER|DB_PASSWORD|DB_PORT|YOUR_[A-Z_]+|<[^>]+>)$/i.test(decodeURIComponent(value));
    fields = [['ชื่อผู้ใช้', url.username], ['รหัสผ่าน', url.password], ['host', url.hostname], ['ชื่อ database', url.pathname.slice(1)]]
      .filter(([, value]) => placeholder(value)).map(([label]) => label);
  } catch { throw configurationError('DATABASE_URL มี URL encoding ไม่ถูกต้อง ตรวจอักขระพิเศษในชื่อผู้ใช้และรหัสผ่าน'); }
  if (fields.length) throw configurationError(`DATABASE_URL ยังเป็นค่าตัวอย่าง: ${fields.join(', ')} — กรุณาแทนด้วยค่า PostgreSQL จริง ไม่ใช่บัญชีเข้า Studio`);
  pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  const { rows: [row] } = await pool.query("SELECT to_regclass('alumni_69.customers') IS NOT NULL AS ready");
  if (!row.ready) throw configurationError('ฐานข้อมูลปลายทางไม่มี alumni_69.customers กรุณาตรวจชื่อ database และเซิร์ฟเวอร์');
  await pool.query(await readFile(new URL('../db/setup-api.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../db/staff-users.sql', import.meta.url), 'utf8'));
  console.log('Installed private API session/idempotency tables. Existing booking schema unchanged.');
  }
} catch (error) {
  const messages = {
    ENOTFOUND: 'หา PostgreSQL host ไม่พบ ตรวจ DATABASE_URL และ DNS',
    ECONNREFUSED: 'เชื่อมต่อ PostgreSQL ไม่สำเร็จ ตรวจ host, port และการเปิดรับ connection',
    ETIMEDOUT: 'เชื่อมต่อ PostgreSQL หมดเวลา ตรวจเครือข่ายและ firewall',
    '28P01': 'ชื่อผู้ใช้หรือรหัสผ่าน PostgreSQL ไม่ถูกต้อง',
    '28000': 'PostgreSQL ไม่อนุญาตการเข้าสู่ระบบจากเครื่องนี้ ตรวจสิทธิ์และการตั้งค่ารับ connection',
    '3D000': 'ไม่พบชื่อ database ที่ระบุใน DATABASE_URL',
    '42501': 'บัญชี PostgreSQL ไม่มีสิทธิ์ที่จำเป็นสำหรับติดตั้งตาราง API',
  };
  if (error.code === 'XX000' && /ENOIDENTIFIER|no tenant identifier provided/i.test(String(error.message))) {
    console.error('ติดตั้งตาราง API ไม่สำเร็จ');
    console.error('ปลายทางเป็น pooler ที่ต้องระบุ tenant: ใช้ชื่อผู้ใช้รูปแบบ DB_USER.POOLER_TENANT_ID โดยดูค่า POOLER_TENANT_ID จาก configuration ของ Supabase บนเซิร์ฟเวอร์');
    process.exitCode = 1;
  } else {
    console.error('ติดตั้งตาราง API ไม่สำเร็จ');
    // Never echo the connection URL, raw driver message or credentials.
    console.error(error.code === 'SETUP_CONFIG' ? error.message : messages[error.code] || 'ตรวจค่าการเชื่อมต่อ PostgreSQL, TLS และสิทธิ์ของบัญชีแล้วลองใหม่');
    process.exitCode = 1;
  }
} finally { if (pool) await pool.end(); }
