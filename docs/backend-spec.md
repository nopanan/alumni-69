# alumni_69 — backend ที่ต้องต่อยอดจากฐานข้อมูลเดิม

ปรับปรุง: 4 พฤศจิกายน 2026 (Asia/Bangkok)

สถานะ: พัฒนา API แล้ว ติดตั้งตารางเสริม private/RPC สำหรับ server และ private slip bucket บน Supabase ของงานแล้ว ใช้ DATABASE_TRANSPORT=supabase เพื่อเชื่อมผ่าน API โดยไม่ต้องมี tenant/รหัสผ่าน PostgreSQL API รันบน Mac ได้และตรวจ /ready กับฐานข้อมูลจริงผ่านแล้ว ยังไม่ได้ deploy ตัว Node.js API ขึ้นเซิร์ฟเวอร์ ดูวิธีรันใน ../README.md

## แหล่งข้อมูลและขอบเขต

- ฐานข้อมูลเป้าหมายคือ Supabase แบบ self-hosted ที่ผู้ใช้ระบุ โดยใช้ schema `alumni_69`
- โปรเจกต์ cloud ชื่อ `srvc alumni` ที่ตรวจครั้งก่อนเป็นคนละปลายทาง ไม่ใช้เป็นหลักฐานว่า alumni_69 ยังไม่มีตาราง
- อ่าน system catalogs, source ของฟังก์ชัน/view, grants, ข้อมูลผังโต๊ะแบบไม่ระบุตัวบุคคล และการตั้งค่า Cron/Storage/Realtime
- ไม่อ่านรายละเอียดผู้จอง สลิป ประวัติ login หรือรหัสบัตร ไม่เรียกฟังก์ชันที่สร้างหรือแก้ข้อมูล
- หลักฐาน metadata อยู่ใน `database-inspection.json` ไม่มีข้อมูลเข้าสู่ระบบของ Studio
- snapshot เดิมยืนยันโครงสร้างและ source; ปัจจุบันชุดทดสอบ concurrent booking/flow ผ่านกับ PostgreSQL แยกทั้งแบบ direct และ RPC แล้ว ส่วนระบบจริงตรวจเฉพาะ readiness/ผัง/สิทธิ์ RPC/Storage ไม่สร้างรายการจองทดสอบในฐานจริง

## เงื่อนไขที่ผู้ใช้ยืนยันแล้ว

- หากส่งสลิปสำเร็จภายใน 1 ชั่วโมง ต้องคงสิทธิ์โต๊ะไว้ระหว่างรอเจ้าหน้าที่ตรวจ แม้ตรวจหลังครบชั่วโมง
- admin และ staff ยืนยันการโอนได้ ส่วน manager ดูรายงาน
- โต๊ะขายโต๊ะละ 3,500 บาท นั่งได้ 8 คน ออกบัตร 8 ใบต่อโต๊ะหลังยืนยันเงิน
- จองได้หลายโต๊ะต่อรายการ รวมยอดชำระ และต้องกรอกชื่อกับหมายเลขโทรศัพท์
- ต้องเก็บประวัติคนเข้าสู่ระบบ รวมคนที่ซื้อและยังไม่ซื้อ
- เรื่องเพิ่มเพื่อน OA และเข้ากลุ่มก่อนจองยังไม่ได้รับคำตอบเลือกกติกาที่ชัดเจน จึงไม่ถือว่าได้เปลี่ยนหรือยกเลิกข้อกำหนดบังคับเดิม การกดเข้ากลุ่มแล้วเป็นเพียง self-acknowledgement ไม่ใช่การตรวจสมาชิกจริง

## โครงสร้างที่มีจริง

โครงสร้างธุรกิจเดิมพบ 11 ตาราง 2 views และ 5 functions นอกเหนือจากนี้ติดตั้งตาราง API 4 ตารางและ helper ใน alumni_api_private รวมถึง public.alumni69_backend ที่เรียกได้เฉพาะ service_role แล้ว

| ตาราง | หน้าที่ |
|---|---|
| `customers` | LINE ID ไม่ซ้ำ ชื่อแสดงผล รูป ชื่อจริง/โทรศัพท์ และเวลาเข้าใช้งานล่าสุด |
| `login_history` | บันทึกเวลาเข้าใช้งานแยกเป็นครั้ง |
| `staff_accounts` | อ้างอิง `auth.users` และบทบาท admin/manager/staff |
| `reserved_areas` | พื้นที่สงวน VIP แยกจากโต๊ะขาย |
| `event_tables` | ผังโต๊ะประเภท regular/staff ราคา 3,500 บาท และ 8 ที่นั่ง |
| `bookings` | เจ้าของ ชื่อ/เบอร์ผู้จอง ยอดรวม สถานะ เวลาหมดอายุ และผู้ยืนยัน |
| `booking_items` | โต๊ะทั้งหมดในรายการและราคาแต่ละโต๊ะ |
| `table_claims` | สิทธิ์ครอบครองโต๊ะปัจจุบัน ใช้ `table_id` เป็น primary key เพื่อกันครอบครองซ้ำ |
| `payments` | path สลิป เวลาส่ง ผลตรวจ ผู้ตรวจ และเหตุผลปฏิเสธ |
| `tickets` | บัตรรายที่นั่ง 1–8, UUID token ไม่ซ้ำ และเวลาใช้บัตร |
| `notification_outbox` | งานแจ้งเตือนตามรายการ พร้อมคีย์กันงานชนิดเดียวกันซ้ำ |

ข้อมูลผังที่ตรวจพบ: regular 194 โต๊ะ, staff 14 โต๊ะ และพื้นที่ VIP 1 รายการ ราคากับจำนวนที่นั่งของทุกโต๊ะใน inventory เป็น 3,500 บาท/8 ที่นั่ง

VIP อยู่ใน `reserved_areas` ไม่ใช่ `event_tables.kind` จึงต้องโหลดทั้งสองชุดเพื่อแสดงผัง และไม่แปลง VIP เป็นโต๊ะขายโดยไม่จำเป็น

จำนวนเงินใน schema เดิมใช้หน่วยบาทแบบ integer เช่น `3500` ต้องใช้หน่วยนี้อย่างสอดคล้องกัน ไม่เปลี่ยนเป็นสตางค์โดยไม่มี migration ที่ตั้งใจทำ

## ฟังก์ชันที่นำกลับมาใช้ได้

| ฟังก์ชัน | สิ่งที่มีแล้วจาก source |
|---|---|
| `record_login(p_line_id, p_display_name, p_picture_url)` | upsert คนตาม LINE ID อัปเดต last login และเพิ่ม login_history |
| `create_booking(p_customer, p_name, p_phone, p_tables)` | จองหลายโต๊ะ ตรวจ ID ไม่ซ้ำ รับเฉพาะ regular คำนวณจำนวน × 3500 ตั้งหมดอายุ 1 ชั่วโมง และสร้าง table_claims |
| `submit_slip(p_customer, p_booking, p_slip_path)` | ตรวจเจ้าของและ deadline เปลี่ยน pending_payment เป็น pending_review และเพิ่ม payments |
| `confirm_payment(p_booking, p_actor)` | ตรวจบทบาท admin/staff ยืนยันเงิน ออกบัตร 8 ใบต่อโต๊ะ และสร้าง outbox ชนิด tickets_ready ใน transaction เดียว เรียกซ้ำเมื่อ confirmed แล้วจะ return |
| `expire_bookings()` | หมดอายุเฉพาะ pending_payment และลบสิทธิ์ถือโต๊ะของรายการที่หมดอายุ ไม่คืนโต๊ะ pending_review |

เส้นทางจอง ส่งสลิป ยืนยัน และหมดอายุใช้ transaction advisory lock คีย์เดียวกันร่วมกับ primary key ของ table_claims เป็นฐานกลไกกันจองซ้ำที่มีอยู่แล้ว ไม่ต้องสร้างระบบ claim อีกชุด

พบ Cron ชื่อ `alumni_69_expire_bookings` เปิดใช้งานและตั้งรอบทุกนาที (`* * * * *`) และฟังก์ชันจอง/ส่งสลิปเรียก expire_bookings ด้วย

## Views และสีที่มีแล้ว

- `table_status`: staff = blocked/gray-black; confirmed = red; pending_review และ pending_payment ที่ยังไม่หมดเวลา = orange; ที่เหลือ = available/white
- `booking_summary`: จำนวนและมูลค่าของ confirmed, pending และ available คำนวณเฉพาะ regular ไม่รวม staff หรือ VIP
- ทั้งสอง view มี `security_invoker=true`
- `pending_review` ยังแสดงส้มและคงสิทธิ์ แม้เลย expires_at ตรงตามคำตอบล่าสุดของผู้ใช้
- pending_payment ที่หมดเวลาแสดงว่างได้ก่อน Cron เก็บกวาด แต่การสร้างรายการใหม่ยังผ่านฟังก์ชันที่จัดการ expiry และ claim

## Backend/API ที่ต้องพัฒนาหรือเชื่อมเพิ่ม

ตารางด้านล่างคือแผนขอบเขตเดิม API หลักถูกสร้างใน src/app.js แล้ว ส่วน LINE webhook/notification worker ยังเป็นงานต่อไป ให้ใช้ README.md เป็นสัญญา endpoint ปัจจุบัน (มีชื่อ logout/session และ refresh ที่ระบุชัดกว่าในแผนนี้)

| Endpoint/งาน | การต่อกับฐานข้อมูลและกติกา |
|---|---|
| `POST /auth/staff/login` / logout / session | Supabase Auth ตรวจ session ฝั่ง server และอ่าน role จาก staff_accounts |
| `GET /auth/line` + callback | LINE OAuth/OIDC ตรวจ token/state/nonce ผูก session ที่เชื่อถือได้ แล้วเรียก record_login |
| `GET/PATCH /me` | อ่าน/แก้ profile ของเจ้าของ session พร้อมตรวจชื่อและรูปแบบโทรศัพท์ |
| `GET /tables` | อ่าน table_status รวม reserved_areas ส่งเฉพาะข้อมูลผังที่เปิดเผยได้ |
| `POST /bookings` | ดึง customer จาก session ตรวจชื่อ/เบอร์และ LINE gate ก่อนเรียก create_booking ไม่รับราคา/เจ้าของรายการจาก client เป็นข้อเท็จจริง |
| `GET /bookings` / `GET /bookings/:id` | แสดงเฉพาะรายการของผู้จอง หรือเจ้าหน้าที่ตามสิทธิ์ รวมยอดและ deadline |
| `POST /bookings/:id/slip` | รับไฟล์ลง private Storage ตรวจขนาด/ชนิดไฟล์/เจ้าของ แล้วเรียก submit_slip หลังอัปโหลดสำเร็จภายใน deadline |
| `GET /admin/payments` | คิวรอตรวจสำหรับ admin/staff พร้อมสิทธิ์เปิดสลิปแบบจำกัดเวลา |
| `POST /admin/bookings/:id/confirm` | ตรวจ session ของ admin/staff และใช้ auth user ID ฝั่ง server เป็น p_actor ก่อนเรียก confirm_payment |
| `POST /admin/bookings/:id/reject` | ต้องเพิ่มการเปลี่ยนสถานะแบบ atomic พร้อมเหตุผลและกติกาส่งใหม่/คืนโต๊ะ ไม่มีฟังก์ชัน reject เดิม; API เพิ่ม transaction สำหรับขั้นตอนนี้แล้ว |
| `GET /admin/dashboard` | ตรวจ admin/manager/staff ก่อนอ่าน booking_summary พร้อมยอดรอตรวจและคนเข้าแล้วไม่ซื้อ |
| `GET /bookings/:id/tickets` | ตรวจเจ้าของและสถานะยืนยัน คืนบัตรเดิม ไม่สร้างบัตรใหม่เมื่อเปิดดู |
| `GET /tickets/:token` | หน้า/ข้อมูลรับบัตรตาม token ที่คาดเดาไม่ได้ กำหนดขอบเขตข้อมูลที่เปิดเผย |
| `POST /line/webhook` | ตรวจลายเซ็น raw body และจัดการ event ซ้ำ เก็บสถานะเพื่อน/บล็อกตามการออกแบบ |
| LINE notification worker | อ่าน outbox ส่งลิงก์รวมบัตรผ่าน OA บันทึกผลและ retry โดยไม่เปลี่ยน confirmed หากส่งไม่ได้ |

## สิทธิ์และสถาปัตยกรรม API

ตารางทั้ง 11 เปิด RLS และยังไม่มี policies ส่วน schema/functions/tables ให้สิทธิ์ที่ตรวจพบแก่ postgres/service_role จึงออกแบบให้ server เป็นตัวกลางต่อยอดได้ ผู้จองไม่ควรเรียกฟังก์ชันนี้ด้วยตัวตนที่ระบุเองจาก browser

- ทุกเส้นทางต้องตรวจ session และ owner/role ฝั่ง server ก่อนใช้ service_role ซึ่งข้าม RLS ได้
- `p_customer` ต้องมาจาก customer ที่ผูกกับ session ไม่ใช่ UUID ที่ผู้ใช้กรอกเอง
- `p_actor` ต้องมาจาก session เจ้าหน้าที่จริง ไม่รับค่าจาก client แม้ในฟังก์ชันจะตรวจว่ามีบัญชี admin/staff ก็ตาม
- เก็บ LINE identity mapping อย่างเชื่อถือได้ customers เดิมไม่มี auth_user_id; API จึงผูก customer_id ผ่าน opaque session ใน alumni_api_private.customer_sessions โดยตรวจ LINE OAuth ก่อนสร้าง session
- ไม่เปิด schema ให้ anon/authenticated หรือเพิ่ม RLS policy กว้างเพื่อให้ browser เขียนข้อมูลได้โดยตรง
- โหมด Supabase API ใช้ public.alumni69_backend เป็น RPC สำหรับ service_role เท่านั้น ทดสอบกับ PostgREST จริงแล้ว ไม่ต้อง expose alumni_69 หรือ alumni_api_private
- Studio port เป็นช่องทางบริหาร ไม่ใช้ Basic credentials ของ Studio ใน frontend หรือเป็น API ของผู้จอง
- เก็บ service key และ LINE secrets ฝั่ง server เท่านั้น ไม่บันทึกลงไฟล์เอกสารหรือ Git

## ส่วนที่ schema ยังรองรับไม่ครบ

1. **Storage สลิป:** สร้างและตรวจ private bucket alumni69-slips แล้ว API ตรวจไฟล์และสิทธิ์เจ้าของก่อนจัดเก็บ
2. **Realtime:** ไม่พบตาราง alumni_69 ใน publication ต้องเลือกช่องทาง server ส่ง realtime ที่ตรวจสิทธิ์ และโหลด summary ใหม่เมื่อมีการเปลี่ยนแปลงหรือ reconnect ไม่ expose bookings/payments ที่มีข้อมูลส่วนตัว
3. **LINE:** ยังไม่มีข้อมูลสถานะเพื่อน/คำยืนยันเข้ากลุ่มใน customers ต้องเพิ่มหากบังคับเป็น gate และเชื่อม Login channel/OA ภายใต้ provider ที่สอดคล้องกัน
4. **การปฏิเสธสลิป:** มีคอลัมน์ rejection_reason แต่ยังไม่มีฟังก์ชันจัดการ ต้องกำหนดส่งใหม่ก่อน deadline หรือปิดรายการ/คืนโต๊ะเมื่อเลย deadline และทำใน transaction เดียวกับ claim
5. **การส่ง LINE:** outbox มีเพียง status/created_at ต้องเพิ่มข้อมูล retry/lease/error/sent_at ที่จำเป็นสำหรับ worker กันส่งพร้อมกัน และจัดการงานค้าง
6. **Audit:** confirmed_by/payments มีผู้ตรวจและเวลาแล้ว แต่ยังไม่มีตาราง audit เหตุการณ์เปลี่ยนสิทธิ์/ข้อมูลอื่น หากต้องการตรวจสอบย้อนหลังครบให้เพิ่มเฉพาะส่วนที่จำเป็น
7. **Idempotency ของคำขอจอง:** ฟังก์ชันกันจองโต๊ะซ้ำได้แล้ว แต่ยังไม่มี request key สำหรับคืนผลเดิมของ HTTP retry API เพิ่มตาราง private booking_requests และตรวจ Idempotency-Key แล้ว ต้องติดตั้งด้วย db:setup ก่อนใช้กับฐานข้อมูลจริง
8. **ช่องทางรับบัตร:** มี token และ used_at แล้ว API อ่านบัตรแบบ JSON ถูกสร้างแล้ว ส่วนหน้าแสดงบัตรและรูปแบบ QR ยังต้องพัฒนาต่อ การใช้ used_at เพื่อ check-in ต้องเพิ่ม flow และสิทธิ์ผู้สแกนหากต้องการ

สิ่งเหล่านี้เป็นสิ่งที่ไม่พบจาก schema/config ที่อ่าน ไม่ได้ยืนยันว่าไม่มี external API หรือ worker บนระบบอื่น เพราะยังไม่มี source/deployment ของบริการนั้นให้ตรวจ

## กติกาเวลาและรายงาน

- ใช้เวลา server เก็บ timestamptz และแสดง Asia/Bangkok
- ส่งไฟล์และเรียก submit_slip สำเร็จก่อน expires_at จึงถือว่าส่งทัน การเริ่ม upload อย่างเดียวไม่พอ
- หลัง pending_review ห้าม Cron คืนโต๊ะเพราะเลยชั่วโมง ซึ่งโค้ดเดิมทำถูกตามกติกานี้แล้ว
- ยอดยืนยันนับเฉพาะ confirmed ยอด pending เป็นมูลค่ากำลังจอง และมูลค่า available เป็นมูลค่าที่ยังขายได้ ไม่ใช่รายได้
- คนซื้อให้นับ customer ที่มี confirmed อย่างน้อยหนึ่งรายการ ส่วนคนยังไม่ซื้อให้ใช้ NOT EXISTS confirmed ไม่ใช้เพียงไม่มีรายการจอง
- อย่า join tickets/payments เพื่อรวมยอดโดยไม่ aggregate ก่อน เพราะหลายบัตร/หลายหลักฐานอาจคูณจำนวนซ้ำ
- หลังอนุมัติจอง 3 โต๊ะต้องได้ยอด 10,500 บาทและบัตร 24 ใบ ส่ง LINE ไม่สำเร็จต้องยังเปิดดูบัตรบนเว็บได้

## ลำดับพัฒนาต่อ

1. เลือกวิธี session ของ LINE และเจ้าหน้าที่ ตรวจ Supabase Auth/API version และ endpoint ที่ instance เปิดใช้จริง พร้อมยืนยันกติกา OA/กลุ่ม
2. ทำ API สำหรับอ่านผัง/จอง/ดูรายการ โดยใช้ฟังก์ชันเดิมและ owner/role checks
3. สร้าง private slip upload และ flow ตรวจ/ปฏิเสธ โดยรักษากติกา deadline/คงโต๊ะรอตรวจ
4. ต่อ dashboard กับ booking_summary และช่องทาง realtime ที่ไม่ส่งข้อมูลส่วนตัวข้ามผู้ใช้
5. ทำหน้า/ข้อมูลบัตรและ LINE worker/webhook บน outbox เดิม
6. ตรวจรับบนสภาพแวดล้อมทดสอบ: แย่งโต๊ะพร้อมกัน, จองหลายโต๊ะแบบ atomic, ส่งสลิปชน deadline/Cron, manager อนุมัติไม่ได้, อนุมัติซ้ำ, ส่ง LINE ล้มเหลวแล้ว retry

## เอกสารอ้างอิง

- LINE Login และการผูก OA: https://developers.line.biz/en/docs/line-login/link-a-bot/
- LINE friendship status: https://developers.line.biz/en/reference/line-login/#get-friendship-status
- Supabase Custom OAuth/OIDC: https://supabase.com/docs/guides/auth/custom-oauth-providers (ต้องตรวจ compatibility ของ self-hosted instance ก่อนใช้)
- Supabase Realtime: https://supabase.com/docs/guides/realtime/postgres-changes
- Supabase Cron: https://supabase.com/docs/guides/cron
