# Datasets

## มีอะไรในโฟลเดอร์นี้

| โฟลเดอร์ | คืออะไร |
|---|---|
| [`synthetic/`](synthetic) | ภาพจำลองจาก simulator แยกตามคลาส: `normal`, `normal_printed_graphic` (ลายพิมพ์คล้ายรอยขาด ต้อง PASS), `dent`, `tear`, `deform`, `wet` ใช้สาธิตและทดสอบระบบ **ไม่ใช่ภาพจริง** สร้างใหม่ได้ด้วย `node scripts/make-samples.js` |
| `real/` (สร้างเอง) | ภาพจริงจากกล้องหน้างานที่กลุ่มเก็บเอง ดูวิธีด้านล่าง |

## Dataset ภาพจริงสาธารณะ (ต้องสมัคร/ล็อกอินก่อนดาวน์โหลด จึงยังไม่ได้โหลดมาไว้)

| Dataset | เนื้อหา | License |
|---|---|---|
| [Damaged Package Detection (Roboflow)](https://universe.roboflow.com/ameesh/damaged-package-detection-xjkol) | กล่องปกติ / กล่องเสียหาย | CC BY 4.0 |
| [Damaged Parcel Detection (Roboflow)](https://universe.roboflow.com/nmd-lf3ie/damaged-parcel-detection) | พัสดุเสียหาย | ดูหน้า dataset |
| [damaged boxes detection (Roboflow)](https://universe.roboflow.com/smart-damage-detection-for-logistics-packages-using-computer-vision/damaged-boxes-detection-imbqp) | กล่องเสียหาย (segmentation) | ดูหน้า dataset |
| [TAMPAR (Hugging Face)](https://huggingface.co/datasets/voxel51/TAMPAR) | พัสดุถูกแกะ/ดัดแปลง ~900 ภาพ, 3.7 GB (ใหญ่เกินจะเก็บใน Git) | CC BY 4.0 |

วิธีโหลดจาก Roboflow: สมัครฟรี → เปิดหน้า dataset → **Download Dataset** → เลือก format (YOLO หรือที่ CiRA CORE รับได้) → แตกไฟล์ไว้ที่ `datasets/real/roboflow-<ชื่อ>/`

> ยังไม่พบ dataset สาธารณะของ **กล่องเปียกน้ำ** โดยเฉพาะ ระบบจึงใช้การตรวจสี (เข้มขึ้น + อิ่มสีขึ้น) ใน [`edge/condition.js`](../edge/condition.js) / [`cira/box_condition.py`](../cira/box_condition.py) แทน และแนะนำให้เก็บภาพจริงเพิ่ม

## เก็บภาพจริงเอง (แนะนำสำหรับเทรนใน CiRA CORE)

1. ตั้งกล้องตำแหน่งเดียวกับตอนใช้งานจริง แสงเดียวกัน
2. ถ่ายอย่างน้อยคลาสละ 100–200 ภาพ หมุนกล่อง/เปลี่ยนตำแหน่งความเสียหาย
3. เก็บตามโครงสร้างนี้

```
datasets/real/
  normal/    กล่องปกติ (รวมกล่องที่มีลายพิมพ์ เทปสี สติกเกอร์)
  dent/      รอยบุบ
  tear/      ฉีกขาด
  deform/    ผิดรูป ยับเยิน บี้ ยุบ
  wet/       เปียกน้ำ (ราดน้ำบนกล่องจริง ถ่ายตอนยังชื้น)
```

4. Label กรอบใน CiRA CORE แล้วเทรน ตั้งชื่อคลาสเป็นภาษาอังกฤษตามชื่อโฟลเดอร์ (Gateway รู้จักชื่อ `dent`, `tear`, `deform`, `wet`, `damaged`, `normal` และคำไทย บุบ/ฉีก/ผิดรูป/เปียก)
