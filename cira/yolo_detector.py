"""
Run the downloaded YOLOv11n "PackageDamage" model (classes: normal / damaged) and send results
to the Edge Gateway. Two ways to use it:

 1) Inside a CiRA CORE Python script node:
        from yolo_detector import detect
        dets = detect(frame_bgr)                  # list of detections
        send_result(dets, frame_bgr)              # from cira_to_gateway.py

 2) Stand-alone (no CiRA) — webcam -> YOLO + colour check -> gateway, triggered by the IR beam:
        pip install ultralytics opencv-python paho-mqtt
        python yolo_detector.py --camera 0 --side-camera 1

The gateway maps "damaged" -> DEFORM (ยับเยิน/ผิดรูป) and ignores "normal".
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, "..", "models", "package-damage-yolo11n", "best.pt")
_model = None


def load(model_path=DEFAULT_MODEL):
    global _model
    if _model is None:
        from ultralytics import YOLO
        _model = YOLO(model_path)
    return _model


def detect(frame, cam="top", conf=0.25, model_path=DEFAULT_MODEL):
    """BGR frame -> [{"label", "confidence", "x1".."y2" (pixels), "cam"}]"""
    res = load(model_path)(frame, conf=conf, verbose=False)[0]
    names = res.names
    out = []
    for b in res.boxes:
        x1, y1, x2, y2 = [float(v) for v in b.xyxy[0]]
        out.append({"label": names[int(b.cls[0])], "confidence": round(float(b.conf[0]), 3),
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2, "cam": cam})
    return out


def main():
    import cv2
    import paho.mqtt.client as mqtt
    from cira_to_gateway import send_result
    from box_condition import analyze_box

    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--side-camera", type=int, default=-1)
    ap.add_argument("--broker", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    a = ap.parse_args()

    top = cv2.VideoCapture(a.camera)
    side = cv2.VideoCapture(a.side_camera) if a.side_camera >= 0 else None
    for cap in filter(None, [top, side]):
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    load(a.model)
    print("model loaded, waiting for IR triggers on parcel/edge/trigger …")

    def on_trigger(_c, _u, msg):
        t = json.loads(msg.payload)
        ok, f_top = top.read()
        f_side = side.read()[1] if side else None
        if not ok:
            print("camera read failed")
            return
        h, w = f_top.shape[:2]
        dets = detect(f_top, "top") + analyze_box(f_top, "top")
        if f_side is not None:
            dets += detect(f_side, "side") + analyze_box(f_side, "side")
        # gateway normalises pixel boxes with img_w/img_h (both cameras assumed same resolution)
        send_result(dets, f_top, f_side, parcel_id=t.get("parcel_id"), seq=t.get("seq"))
        print("parcel", t.get("seq"), [(d["label"], d["confidence"]) for d in dets])

    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    except AttributeError:  # paho-mqtt < 2
        client = mqtt.Client()
    client.on_message = on_trigger
    client.connect(a.broker, a.port)
    client.subscribe("parcel/edge/trigger")
    client.loop_forever()


if __name__ == "__main__":
    sys.path.insert(0, HERE)
    main()
