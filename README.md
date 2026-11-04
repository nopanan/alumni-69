# alumni_69 backend

API ด้วย Node.js/Fastify เชื่อม PostgreSQL/Supabase แบบ self-hosted โดยใช้ฟังก์ชันเดิมใน schema `alumni_69`

## ทดลองได้ทันทีโดยไม่ใช้ .env

ต้องมี Node.js 22.16 ขึ้นไป และติดตั้ง dev dependencies ด้วย

```bash
npm ci --ignore-scripts
npm test
npm run demo
```

`npm test` สร้าง PostgreSQL 17 ชั่วคราวจาก schema snapshot ที่ตรวจไว้ ทดสอบ API กับฐานข้อมูลจริง แล้วลบฐานข้อมูลทดสอบเมื่อจบ ไม่อ่าน `.env` และไม่เชื่อมต่อฐานข้อมูลจริงของงาน PostgreSQL binary มาจาก npm package `embedded-postgres`; helper สร้าง symlinks ที่จำเป็นเอง จึงใช้ `--ignore-scripts` ได้

`npm run demo` เปิด API ที่ `http://localhost:3000` พร้อมฐานข้อมูลชั่วคราวสำหรับทดลองด้วย Postman/curl แสดง bearer token ของผู้จอง Alice/Bob ใน terminal และมีบัญชีจำลอง `admin@example.test`, `staff@example.test`, `manager@example.test` รหัสผ่าน `test-only-password`

**Demo จำลอง LINE, Supabase Auth และ Storage เท่านั้น** ไม่ส่ง LINE และไม่เก็บสลิปบน Supabase จริง ข้อมูลจองหายเมื่อกด Ctrl+C เปิดเฉพาะ 127.0.0.1 และไม่ใช้ .env; ห้ามนำ demo ไปเปิดเป็นบริการจริง ใช้ `DEMO_PORT=3001 npm run demo` หากพอร์ต 3000 ถูกใช้อยู่

นำเข้า [Postman collection](docs/alumni69.postman_collection.json) แล้วใส่ `customerToken` จาก terminal เลือกไฟล์ `test/fixtures/slip.png` ในคำขอ Upload slip จากนั้นรันตามลำดับ Login staff → Create booking → Upload slip → Confirm payment → Get tickets

## รันกับ Supabase ของงาน

โปรเจกต์นี้ตั้ง `.env` เป็น `DATABASE_TRANSPORT=supabase` แล้ว ใช้ Supabase API ผ่านคีย์ server และ RPC ที่จำกัดสิทธิ์เฉพาะ `service_role` ไม่ต้องมี `DATABASE_URL`, รหัสผ่าน PostgreSQL หรือ tenant เพื่อรัน backend ในโหมดนี้

ติดตั้งตาราง private จาก `db/setup-api.sql`, ตาราง username จาก `db/staff-users.sql`, RPC จาก `db/supabase-api.sql` และ bucket สลิปแบบ private บน Supabase ของงานแล้ว ฟังก์ชันและตารางจองเดิมไม่ถูกแทนที่ ตรวจกับระบบจริงแล้วว่า `/ready` ตอบ ready, อ่านผังได้ 208 โต๊ะ/พื้นที่ VIP 1 รายการ และ anon เรียก RPC ไม่ได้

```bash
npm run db:setup
npm start
```

ในโหมด Supabase API คำสั่ง `db:setup` ตรวจว่าตารางและ RPC พร้อมใช้งานเท่านั้น ไม่ติดตั้ง SQL ซ้ำ เปิด `http://localhost:3000/ready` เพื่อตรวจการเชื่อมต่อ

### เมื่อติดตั้งกับ Supabase อีก instance

1. หากยังไม่มี `.env` ให้คัดลอกจาก `.env.example` แล้วเลือก `DATABASE_TRANSPORT=supabase`
2. ใส่ `SUPABASE_URL` ของ API gateway, `SUPABASE_PUBLISHABLE_KEY` (หรือ anon key เดิม) และ `SUPABASE_SECRET_KEY` (หรือ service_role key เดิม)
3. รัน `npm run keygen` แล้วเก็บค่าใน `SESSION_ENCRYPTION_KEY` ของ instance ใหม่ อย่าเปลี่ยนค่านี้ขณะที่ต้องใช้ session เดิม
4. ใช้ SQL Editor ของ Studio รัน `db/setup-api.sql`, `db/staff-users.sql` แล้ว `db/supabase-api.sql` ตามลำดับ SQL เพิ่มเฉพาะตาราง private และ RPC สำหรับ server; ไม่มี endpoint รับ arbitrary SQL
5. รัน `npm run db:setup` เพื่อตรวจ RPC และ `npm run storage:setup` เพื่อสร้าง/ตรวจ private bucket
6. กรอก LINE Login Channel ID/Secret และตั้ง callback ให้ตรงกับ `LINE_REDIRECT_URI` ก่อนใช้ LINE Login จริง ค่าเหล่านี้ยังไม่ถูกกรอกในโปรเจกต์ปัจจุบัน
7. รัน `npm start`

อย่า expose schema `alumni_api_private` ผ่าน PostgREST และเก็บ server key เฉพาะ backend ฟังก์ชัน `public.alumni69_backend` ใช้ SECURITY INVOKER และ revoke EXECUTE จาก PUBLIC/anon/authenticated พร้อมตรวจ service_role ซ้ำภายใน ฟังก์ชันนี้รับเฉพาะชื่อ operation ที่กำหนดไว้ ไม่รับ SQL หรือชื่อ table จาก client การตรวจ session และ owner/role ของ API ยังคงเดิม

### ทางเลือกเชื่อม PostgreSQL โดยตรง

โค้ดยังรองรับ `DATABASE_TRANSPORT=postgres` โดยต้องกรอก `DATABASE_URL` ที่เชื่อมต่อได้จริง ในโหมดนี้ `npm run db:setup` ติดตั้งตาราง private ผ่าน PostgreSQL และไม่ต้องใช้ RPC

หากใช้ Supavisor ให้ระบุชื่อผู้ใช้เป็น `DB_USER.POOLER_TENANT_ID` ตาม [คู่มือ Accessing Postgres](https://supabase.com/docs/guides/self-hosting/accessing-postgres) ส่วนชื่อ database ของงานนี้คือ `postgres` และ `alumni_69` คือ schema ไม่ใช้บัญชี Basic ของ Studio เป็นข้อมูล PostgreSQL

บัญชีเจ้าหน้าที่ต้องมีใน Supabase Auth และมี mapping ใน `alumni_69.staff_accounts` ก่อน API นี้ไม่เปิดให้สมัคร admin/manager/staff เอง ใช้ HTTPS และ `NODE_ENV=production` เมื่อ deploy จริง โดย APP_ORIGIN/FRONTEND_ORIGIN ควรอยู่ภายใต้ site เดียวกันสำหรับ SameSite=Lax cookie

## Authentication

มีตาราง `alumni_69.staff_users` สำหรับ username `admin`, `manager`, `staff` ผูกกับ `staff_accounts` ผ่าน `auth_user_id` ส่วนรหัสผ่านยังจัดการเป็น hash ใน `auth.users` ของ Supabase Auth ไม่สร้างคอลัมน์รหัสผ่านซ้ำในตารางแอป API รับ `username` หรือ `email` อย่างใดอย่างหนึ่ง และตรวจรหัสผ่านผ่าน Supabase Auth เหมือนเดิม

```http
POST /auth/staff/login
Content-Type: application/json

{"username":"admin","password":"<รหัสผ่านที่กำหนด>"}
```

ใน Postman ใช้คำขอ **Login staff with username** และเลือก private Environment ของบทบาทที่ต้องการ ซึ่งมี `staffUsername`/`staffPassword` ให้แล้ว

บัญชีเริ่มต้นบน Supabase ของงานถูกสร้างและทดสอบ login แล้ว: `admin@alumni69.test`, `manager@alumni69.test`, `staff@alumni69.test` ใช้เป็นชื่อเข้าสู่ระบบสำหรับทดสอบ .env เก็บคีย์เชื่อมต่อ ส่วนรหัสผ่านเจ้าหน้าที่ตามที่เจ้าของงานกำหนดอยู่ใน `.env.staff-credentials.json` ซึ่งเป็นไฟล์ private และถูก ignore จาก Git

สำหรับ Postman ให้นำเข้า collection แล้วนำเข้า `.env.postman.admin.json`, `.env.postman.manager.json` หรือ `.env.postman.staff.json` จากโฟลเดอร์ backend เลือก environment ของบทบาทที่ต้องการและส่งคำขอ Login staff ระบบจะบันทึก access token ให้ request ถัดไปอัตโนมัติ ไฟล์ environment มีรหัสผ่านจริง จึงเก็บเฉพาะเครื่องผู้ดูแล

ทดสอบกับบัญชีจริงแล้วว่า admin/manager/staff อ่าน booking_summary ได้ ส่วนคิวตรวจสลิปเปิดเฉพาะ admin/staff และ manager ได้ 403 ไม่มีการจองหรือยืนยันเงินระหว่างตรวจบัญชี

สคริปต์ operator `npm run staff:setup` ใช้ private credentials file และต้องมี `STUDIO_USERNAME`/`STUDIO_PASSWORD` ใน environment ของคำสั่งนั้น ใช้เฉพาะการ bootstrap ไม่ใช่ public API ไม่ reset รหัสผ่านหรือเขียนทับสิทธิ์บัญชีเดิม

- **ผู้จอง:** เปิด `GET /auth/line` → LINE Login → callback ตั้ง HttpOnly session cookie → กลับ FRONTEND_ORIGIN เก็บ session แบบ opaque/hash ในฐานข้อมูล และลบ session จริงเมื่อ logout
- **เจ้าหน้าที่:** `POST /auth/staff/login` ด้วย username/password หรือ email/password จะได้ Supabase access/refresh token ส่ง access token เป็น `Authorization: Bearer ...` ทุกคำขอหลังบ้าน API ตรวจตัวตนกับ Supabase Auth และอ่าน role จากฐานข้อมูลทุกครั้ง
- **Cookie:** คำขอ POST/PATCH ที่ใช้ cookie ต้องส่ง `Origin` ตรง APP_ORIGIN หรือ FRONTEND_ORIGIN; frontend ใช้ `credentials: 'include'`
- **ผู้จองใน demo/Postman:** ใช้ `Authorization: Bearer cust_...` จาก terminal ไม่ต้องเปิด LINE จริง
- **Gate ก่อนจอง:** ค่าเริ่มต้นยังบังคับเพิ่มเพื่อน OA และกดยืนยันเข้ากลุ่มด้วยตนเอง โดยตรวจเพื่อนจริงก่อนจอง แต่การกดยืนยันกลุ่มยังไม่ใช่การตรวจสมาชิกจริง ตั้งค่าผ่าน `REQUIRE_LINE_OA_FRIEND` / `REQUIRE_LINE_GROUP_ACK` ตามกติกาที่เจ้าของงานตกลง

## API หลัก

| Method | Path | สิทธิ์/การใช้งาน |
|---|---|---|
| GET | `/health`, `/ready` | สถานะ API / การเชื่อมฐานข้อมูลและ setup |
| GET | `/tables` | ผังโต๊ะและ VIP ไม่มีข้อมูลผู้จองคนอื่น |
| GET | `/reserved_areas` | พื้นที่สงวน เช่น VIP เปิดอ่านได้โดยไม่ต้อง login |
| GET | `/auth/line`, `/auth/line/callback` | เริ่ม/รับผล LINE Login แบบ state+nonce+PKCE |
| POST | `/auth/staff/login`, `/auth/staff/refresh` | เข้าสู่ระบบ/ต่ออายุ token เจ้าหน้าที่ |
| GET | `/auth/staff/me` | ตัวตนและบทบาทเจ้าหน้าที่ |
| POST | `/auth/staff/logout` | revoke Supabase session; access JWT ที่ออกแล้วอาจใช้ได้จนหมดอายุตามพฤติกรรม Supabase |
| POST | `/auth/logout` | ลบ session ผู้จอง |
| GET/PATCH | `/me` | อ่าน/แก้ชื่อและเบอร์ของตนเอง |
| GET | `/me/line` | สถานะเพื่อน OA/คำยืนยันกลุ่ม/ลิงก์เข้าร่วม |
| POST | `/me/line/group-acknowledgement` | `{ "acknowledged": true }` |
| POST | `/bookings` | สร้างรายการของตนเอง ต้องมี Idempotency-Key |
| GET | `/bookings`, `/bookings/:id` | รายการของตนเอง; list ล่าสุดไม่เกิน 100 รายการ |
| POST | `/bookings/:id/slip` | multipart field `file`, PNG/JPEG/WebP ≤ 5 MB |
| GET | `/bookings/:id/tickets` | บัตรของตนเองหลังยืนยัน พร้อม URL รายใบ |
| GET | `/tickets/:token` | ข้อมูลบัตรแบบ JSON ผ่านรหัสลับ ไม่แสดงชื่อ/โทรศัพท์ |
| GET | `/admin/dashboard` | admin/manager/staff ดูจำนวนโต๊ะ ยอดเงิน และผู้ซื้อ/ยังไม่ซื้อ |
| GET | `/booking_summary` | admin/manager/staff ดูเฉพาะจำนวนและมูลค่าโต๊ะ confirmed/pending/available ต้องส่ง Bearer token เจ้าหน้าที่ |
| GET | `/admin/payments` | admin/staff ดูคิวรอตรวจ ไม่เกิน 100 รายการ |
| GET | `/admin/payments/:id/slip` | admin/staff รับ signed URL อายุ 120 วินาที |
| GET | `/admin/bookings/:id` | admin/staff ดูรายละเอียดรายการ |
| POST | `/admin/bookings/:id/confirm` | admin/staff อนุมัติ โดยใช้ actor จาก session |
| POST | `/admin/bookings/:id/reject` | admin/staff ปฏิเสธ `{ "reason": "ยอดไม่ตรง" }` |

สร้างรายการ:

```http
POST /bookings
Authorization: Bearer <customer-token>
Idempotency-Key: request-unique-0001
Content-Type: application/json

{"booker_name":"ชื่อผู้จอง","phone":"0812345678","table_ids":["A1","A2"]}
```

ได้ `201` พร้อม `booking.id`, `total_amount=7000`, `expires_at` และ items; หากส่ง request เดิมด้วย key เดิม ได้ `200` และ booking เดิม หาก key เดิมแต่เนื้อหาเปลี่ยน ได้ `409`

เมื่อส่งสลิปสำเร็จภายใน 1 ชั่วโมงสถานะเป็น `pending_review` และยังถือโต๊ะจนตรวจ แม้เลยกำหนดแล้ว หากปฏิเสธก่อน deadline จะให้ส่งใหม่โดยไม่ต่อเวลา หากเลย deadline จะเป็น cancelled และคืนโต๊ะ

อนุมัติซ้ำไม่เพิ่มบัตรหรือ outbox ซ้ำ จอง 2 โต๊ะได้ 16 ใบ และราคาใช้หน่วยบาทตาม schema เดิม ผล dashboard บางค่าเป็น string เพราะ PostgreSQL count/sum ส่ง bigint เพื่อรักษาความแม่นยำ

## ขอบเขตการทดสอบและงานที่ยังไม่รวม

ทดสอบกับ PostgreSQL จริงโดยใช้ source ฟังก์ชันที่ตรวจไว้ รวม flow หลายโต๊ะ, การรอ lock พร้อมกันของสอง connection, การตรวจสิทธิ์, หมดอายุ, รอตรวจเกินชั่วโมง, ไฟล์ผิดชนิด/เกินขนาด, Storage ล้มเหลว, deadline ขณะ upload และการอนุมัติซ้ำ ส่วน LINE/Supabase Auth/Storage ใช้ provider จำลอง รวมถึงทดสอบ provider HTTP contracts แยกด้วย fake fetch

ผลตรวจล่าสุด 4 พฤศจิกายน 2026: `npm test` ผ่าน **43/43 กรณี** ครอบคลุมทั้ง PostgreSQL โดยตรงและ Supabase RPC ผ่าน HTTP โดยใช้ PostgreSQL ชั่วคราวกับ role จริง รวมการตรวจว่า anon/authenticated เรียก RPC ไม่ได้ และทดสอบแย่งโต๊ะ/รับบัตรผ่านทั้งสองวิธี บน Supabase ของงานตรวจแบบอ่านอย่างเดียวว่า API จริง `/health`, `/ready`, `/tables` ตอบ 200 และ private Storage พร้อมใช้งาน โดยไม่สร้างรายการจองหรือยืนยันเงินบนระบบจริง

ยังต้องทดสอบ flow ผู้ใช้จริงบน staging กับ LINE/OA, บัญชีเจ้าหน้าที่ Supabase Auth และการอัปโหลด/ตรวจสลิปจริง แม้ตรวจ server key และ private Storage กับ instance ของงานแล้ว ระบบส่งบัตรผ่าน LINE worker, webhook, realtime push และหน้าแสดงบัตร/QR ยังอยู่นอก implementation รอบนี้ `confirm_payment` สร้าง outbox สำหรับส่งบัตรไว้แล้ว แต่ยังไม่มี worker ส่งข้อความจริง

Rate limit ปัจจุบันอยู่ในหน่วยความจำต่อ process และใช้ remote IP ตรง หาก deploy หลาย instance/ผ่าน proxy ต้องตั้ง shared limiter และ trusted proxy ให้เหมาะสม อัตราเริ่มต้น 120 ครั้ง/นาที, staff login 5 ครั้ง/นาที

เอกสารฐานข้อมูลเดิม: [backend-spec.md](docs/backend-spec.md) และ [database-inspection.json](docs/database-inspection.json)
