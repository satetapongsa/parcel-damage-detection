# 📦 AI Parcel Box Damage Detection System

**ระบบประเมินและคัดแยกพัสดุชำรุดก่อนเข้าสู่ระบบขนส่ง ด้วย Edge AI (CiRA CORE) + IoT (ESP32) + Web Dashboard**

กล่องวิ่งบนสายพาน → กล้องถ่ายภาพ → AI ตรวจความเสียหาย → ถ้าชำรุด แขนปัดออกทันที → เก็บภาพเป็นหลักฐาน → ดูทุกอย่างได้บนเว็บ

| ตรวจได้ | ตัวอย่าง | ผล |
|---|---|---|
| 🟠 **รอยบุบ** (Dent) | กล่องยุบเป็นจุด | ปัดออก |
| 🟣 **ฉีกขาด** (Tear) | กระดาษขาด มีรู | ปัดออก |
| 🩷 **ผิดรูป / ยับเยิน** (Deform) | กล่องบี้ เบี้ยว ยุบทั้งด้าน | ปัดออก |
| 🔵 **เปียกน้ำ** (Wet) | คราบน้ำทำให้สีกล่องเข้มขึ้น | ปัดออก |
| ✅ ปกติ | รวมกล่องที่มีลายพิมพ์คล้ายรอยขาด | ผ่าน |

---

## 🗂️ โครงสร้างโปรเจค (คลิกเข้าไปดูได้)

| โฟลเดอร์ | ทำอะไร | ผู้รับผิดชอบ |
|---|---|---|
| 🧠 [`cira/`](cira) | สคริปต์ Python ต่อ **CiRA CORE** → Gateway, ตรวจเปียก/ผิดรูปด้วย OpenCV, รัน YOLO | AI & Computer Vision |
| 🤖 [`models/`](models) | โมเดลที่เทรนแล้ว (YOLOv11n normal/damaged) + ที่ใส่โมเดล CiRA | AI & Computer Vision |
| 🖼️ [`datasets/`](datasets) | ภาพตัวอย่างแต่ละคลาส + ลิงก์ dataset ภาพจริง + วิธีเก็บภาพเอง | AI & Computer Vision |
| 🔌 [`firmware/`](firmware/esp32_parcel_controller) | โค้ด **ESP32**: IR, Load cell, Servo แขนปัด, Tower light, Buzzer, สายพาน | Embedded & Control |
| 🏭 [`edge/`](edge) | **Edge Gateway** เครื่องหน้างาน: ตัดสินผล, Fail-safe, SQLite, Store-and-Forward, Station Console | Backend & Data Pipeline |
| ☁️ [`cloud/`](cloud) + [`api/`](api) | **Cloud API** (รันบน Vercel), ฐานข้อมูล Postgres | Backend & Data Pipeline |
| 📊 [`public/`](public) | **Web Dashboard** | Dashboard & UI |
| 🧪 [`simulator/`](simulator) | จำลองกล้อง + AI + ESP32 ใช้ demo ได้โดยไม่มีฮาร์ดแวร์ | ทุกคน |
| ✅ [`test/`](test) | ทดสอบอัตโนมัติ (รวม Offline fail-safe test) | ทุกคน |
| ⚙️ [`shared/`](shared) | ค่าพารามิเตอร์เริ่มต้น + ชื่อ MQTT topic | ทุกคน |

---

## 🔄 ระบบทำงานยังไง

```
  ┌──────────────────── หน้างาน (ทำงานได้แม้ไม่มีเน็ต) ────────────────────┐
  │                                                                         │
  │  Barcode ─┐                                                             │
  │  IR ──────┼─► ESP32 ◄──UART──► Edge Gateway ◄──MQTT/HTTP── CiRA CORE ◄── กล้อง 2 ตัว
  │  Load cell┘     │                  │  • ตัดสิน PASS / REJECT                 │
  │                 ▼                  │  • ตรวจสี/รูปทรง (เปียก, ผิดรูป)          │
  │   Servo แขนปัด + Tower light        │  • เก็บลง SQLite ก่อนเสมอ                │
  │                                    │                                         │
  └────────────────────────────────────┼─────────────────────────────────────────┘
                                       │ HTTPS (ส่งต่อเมื่อมีเน็ต)
                                       ▼
                      Cloud API + Postgres  ──►  Web Dashboard (Vercel)
```

- **เน็ตหลุด** → หน้างานยังคัดแยกได้ 100%, ไฟเหลือง, ข้อมูลรอในเครื่อง → เน็ตกลับมา **ส่งขึ้นเว็บอัตโนมัติ**
- **AI ไม่ตอบ / กล้องมืด** → ใช้ Fail-safe (ปัดออกไว้ก่อน)
- **ESP32 เป็นคนจับเวลาปัด** แม่นระดับ ms และถ้า PC ค้าง ESP32 ทำ Fail-safe เอง

---

## 🚀 ลองรันในเครื่อง (ไม่ต้องมีฮาร์ดแวร์)

ต้องมี [Node.js 22.13+](https://nodejs.org)

```bash
npm install
npm run demo
```

| เปิด | คืออะไร |
|---|---|
| http://localhost:3000 | **Web Dashboard** |
| http://localhost:8080 | **Station Console** จอหน้างาน (สแกนบาร์โค้ด, ดูผล, ปรับค่าตอนออฟไลน์) |

ทดสอบทั้งหมด: `npm test` · ปุ่มใน simulator (`npm run sim`): `d` กล้องมืด · `a` ปิด AI · `j` สายพานติด · `r` กล่องถัดไปชำรุด

---

## ☁️ Deploy เว็บขึ้น Vercel

1. ไปที่ [vercel.com/new](https://vercel.com/new) → **Import** repo นี้ → ไม่ต้องตั้ง build ใด ๆ
2. แท็บ **Storage** ของโปรเจค → **Create Database → Neon (Postgres)** → Connect (Vercel ใส่ `DATABASE_URL` ให้เอง)
3. **Settings → Environment Variables** เพิ่ม
   - `INGEST_API_KEY` = รหัสลับที่เครื่องหน้างานใช้ส่งข้อมูล (ตั้งเอง ยาว ๆ)
   - `ADMIN_KEY` = รหัสสำหรับแก้ค่า/รับทราบแจ้งเตือนบนเว็บ (ไม่ใส่ = ใครก็แก้ได้)
4. **Redeploy** → เปิด `https://<ชื่อโปรเจค>.vercel.app/api/health` ต้องเห็น `"db":"postgres"`
5. (ไม่บังคับ) ใส่ข้อมูลตัวอย่างให้เว็บมีอะไรโชว์:
   ```bash
   npm run seed -- --url https://<ชื่อโปรเจค>.vercel.app --key <INGEST_API_KEY>
   ```

ตัวอย่างค่าทั้งหมดอยู่ใน [`.env.example`](.env.example)

---

## 🏭 ต่อเครื่องหน้างานเข้ากับเว็บ

บนเครื่องที่ต่อ ESP32 + CiRA CORE (Windows PowerShell):

```powershell
$env:CLOUD_URL="https://<ชื่อโปรเจค>.vercel.app"
$env:INGEST_API_KEY="<รหัสเดียวกับบน Vercel>"
$env:ESP32_PORT="COM5"
npm run edge
```

(Linux/Jetson: `CLOUD_URL=... INGEST_API_KEY=... ESP32_PORT=/dev/ttyUSB0 npm run edge`) — ภายใน 5 วินาที สถานีจะขึ้น **ONLINE** บนเว็บ

### เชื่อม CiRA CORE ([`cira/`](cira))

| วิธี | ทำยังไง |
|---|---|
| **A. Python node** (แนะนำ) | ใน flow: `Camera → Deep Detect → Python script` แล้วเรียก `send_result(detections, frame_top, frame_side)` จาก [`cira_to_gateway.py`](cira/cira_to_gateway.py) |
| **B. MQTT node** | Publish JSON ไปที่ `mqtt://<IP Gateway>:1883` topic `parcel/edge/cira/result` (ตัวอย่าง payload ใน [`cira_to_gateway.py`](cira/cira_to_gateway.py)) |
| **C. ไม่ใช้ CiRA** | `python cira/yolo_detector.py` ใช้โมเดล YOLO ที่โหลดมา ([`models/`](models)) |

- ชื่อคลาสจาก CiRA ตั้งได้หลายแบบ: `dent/บุบ`, `tear/ฉีก`, `deform/damaged/ผิดรูป`, `wet/เปียก`
- ถ้าโมเดล CiRA ยังไม่มีคลาสเปียก/ผิดรูป **Gateway ตรวจให้เองด้วยสีและรูปทรง** ([`edge/condition.js`](edge/condition.js)) เปิด/ปิดได้ในหน้าตั้งค่า

### ต่อ ESP32 ([`firmware/`](firmware/esp32_parcel_controller))

Library: ArduinoJson v7, ESP32Servo, HX711 (Bogdan Necula) · ตั้ง `HX_CALIBRATION` ด้วยตุ้มน้ำหนักจริง

| อุปกรณ์ | Pin | | อุปกรณ์ | Pin |
|---|---|---|---|---|
| IR Breakbeam | GPIO32 | | Tower light เขียว/เหลือง/แดง | 25 / 26 / 27 |
| Servo แขนปัด | GPIO13 | | Buzzer | GPIO14 |
| HX711 DT / SCK | 16 / 17 | | Relay สายพาน | GPIO33 |

---

## 📊 หน้าเว็บ Dashboard (ตามสไลด์)

| แท็บ | สำหรับ | มีอะไร |
|---|---|---|
| **ภาพรวม** | Hub Manager | KPI ตรวจทั้งหมด / ผ่าน / ชำรุด / แจ้งเตือน, กราฟปริมาณ, อัตราของเสีย, สถานะระบบ |
| **Live Monitoring** | Hub Operator | กล่องล่าสุด + ภาพ + กรอบความเสียหาย, Tower light, แผงคัดแยก, Feed เรียลไทม์ |
| **หลักฐาน (Tracking)** | Claim & QA | ค้นด้วยเลขพัสดุ, ภาพหลักฐาน, เหตุผลที่ปัดออก, ประวัติ, Export CSV |
| **แจ้งเตือน** | ทุกคน | กล้องมีปัญหา, สายพานติด, AI ตอบช้า, เน็ตหลุด |
| **Analytics** | Hub Manager | แยก 4 ประเภทความเสียหาย, สาเหตุ, อัตราของเสียตามชั่วโมง, เทียบสถานี |
| **ตั้งค่า** | ทีมเทคนิค | ปรับดีเลย์แขนปัด, Threshold แต่ละคลาส ฯลฯ **ไม่ต้องแก้โค้ด** |

---

## 🧪 Reliability & Failure test (ตามสไลด์)

| Test | วิธีทดสอบ | ผลที่ต้องได้ |
|---|---|---|
| False positive | กล่องลายกราฟิกคล้ายรอยขาด | **PASS** |
| Offline fail-safe | ถอด LAN ขณะกล่องชำรุดวิ่ง | แขนยังปัด, ไฟเหลือง, เสียบกลับ → ข้อมูลขึ้นเว็บครบ ([`test/offline.test.js`](test/offline.test.js)) |
| Delay time tuning | เปลี่ยนความเร็วสายพาน → ปรับ `reject_delay_ms` บนเว็บ | ESP32 ได้ค่าใหม่ภายใน 5 วินาที |
| Vision fault | เอามือบังกล้อง | แจ้งเตือน VISION_FAULT + ไฟเหลือง |
| Belt jam | บัง IR ค้าง > 3 วินาที | สายพานหยุด + แจ้งเตือน BELT_JAM |

---

## 👥 ทีมผู้จัดทำ

| รหัส | ชื่อ | หน้าที่ |
|---|---|---|
| 66013507 | วชิระ เฟื้อแก้ว | AI & Computer Vision |
| 66039252 | นนทพัทธ์ จีนเกิด | Embedded & Control |
| 66027138 | ณัฐวัฒน์ ปราณวรกิจ | Backend & Data Pipeline |
| 66088911 | เศรษฐพงศ์ สงวนสุข | Dashboard & UI |

<details>
<summary>📖 รายละเอียดเชิงเทคนิค (พารามิเตอร์, API, Environment variables)</summary>

### พารามิเตอร์ (แท็บตั้งค่า) — ค่าเริ่มต้นใน [`shared/common.js`](shared/common.js)

| ค่า | Default | ความหมาย |
|---|---|---|
| `reject_delay_ms` | 1500 | เวลาจาก IR → แขนปัด |
| `servo_hold_ms` | 400 | แขนยื่นค้าง |
| `conf_dent` / `conf_tear` | 0.6 | Threshold |
| `conf_deform` / `conf_wet` | 0.5 | Threshold |
| `cv_check` | 1 | Gateway ตรวจสี/รูปทรงเอง |
| `min_box_area` | 0.002 | ตัดกรอบเล็ก (noise) |
| `brightness_min` | 40 | ต่ำกว่านี้ = กล้องมีปัญหา |
| `jam_timeout_ms` | 3000 | IR บังนานเกิน = สายพานติด |
| `ai_timeout_ms` | 1000 | ต้องน้อยกว่า `reject_delay_ms` |
| `failsafe_action` | REJECT | ทำอะไรเมื่อ AI/กล้องเสีย |
| `scan_window_ms` | 15000 | หน้าต่างจับคู่บาร์โค้ด |

### API

- Edge → Cloud (ต้องมี header `x-api-key`): `POST /api/ingest/inspection` · `/api/ingest/alert` · `/api/ingest/status`
- Dashboard: `GET /api/summary` · `/api/timeseries` · `/api/breakdown` · `/api/inspections` · `/api/inspections/:id` · `/api/images/:name` · `/api/export.csv` · `/api/alerts` · `/api/edges` · `/api/feed` · `GET|PUT /api/config/:edge`

### Environment variables

| ตัวแปร | ใช้ที่ | ความหมาย |
|---|---|---|
| `DATABASE_URL` | Cloud | Postgres (ไม่ใส่ = ใช้ SQLite ในเครื่อง) |
| `INGEST_API_KEY` | Cloud + Edge | รหัสส่งข้อมูล |
| `ADMIN_KEY` | Cloud | รหัสแก้ค่าบนเว็บ |
| `CLOUD_URL` | Edge | URL เว็บ เช่น `https://xxx.vercel.app` |
| `EDGE_ID` | Edge | ชื่อสถานี (default `hub-01`) |
| `ESP32_PORT` / `ESP32_BAUD` | Edge | พอร์ต serial |
| `EDGE_HTTP_PORT` / `EDGE_BROKER_PORT` | Edge | 8080 / 1883 |

</details>
