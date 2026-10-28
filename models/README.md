# Models

| โฟลเดอร์ | โมเดล | คลาส | ที่มา |
|---|---|---|---|
| [`package-damage-yolo11n/`](package-damage-yolo11n) | YOLOv11n (`best.pt`, 5.5 MB) เทรนแล้ว | `normal`, `damaged` | [cvtechniques/PackageDamage](https://huggingface.co/cvtechniques/PackageDamage) on Hugging Face, **MIT License** เทรนจาก ~2,787 ภาพ (Roboflow) |
| `cira/` (ใส่เอง) | โมเดลที่กลุ่มเทรนใน CiRA CORE | `dent`, `tear`, `deform`, `wet` | ไฟล์ export จาก CiRA CORE |

## ใช้งาน YOLO model ที่โหลดมา

```bash
pip install ultralytics opencv-python paho-mqtt
python cira/yolo_detector.py --camera 0 --side-camera 1
```

- Gateway แปลง `damaged` → **DEFORM** (ยับเยิน/ผิดรูป → ปัดออก) และ `normal` → ไม่นับ
- หรือใช้ใน CiRA CORE Python node: `from yolo_detector import detect` ดูใน [`cira/yolo_detector.py`](../cira/yolo_detector.py)
- โมเดลนี้ **ไม่มีคลาสเปียกน้ำ** ส่วนนี้ใช้การตรวจสี [`cira/box_condition.py`](../cira/box_condition.py) และ Gateway ตรวจซ้ำอัตโนมัติ
- ผลการเทรนของเจ้าของโมเดล: [`results.csv`](package-damage-yolo11n/results.csv), [`confusion_matrix_normalized.png`](package-damage-yolo11n/confusion_matrix_normalized.png)

> ⚠ ไฟล์ `.pt` เป็น PyTorch pickle เปิดด้วย `ultralytics` จากแหล่งที่เชื่อถือได้เท่านั้น
> ⚠ GitHub รับไฟล์ไม่เกิน 100 MB ต่อไฟล์ ถ้าโมเดล CiRA ใหญ่กว่านี้ให้ใช้ [Git LFS](https://git-lfs.com)
