"""
CiRA CORE -> Edge Gateway bridge.

Paste into a CiRA CORE *Python script* node placed after the deep-learning (detection) node,
or import it from there. Uses only the standard library (+ OpenCV/numpy, which CiRA CORE ships).

    from cira_to_gateway import send_result
    send_result(detections, frame_top, frame_side)

`detections` can be a list of dicts in almost any shape, e.g.
    [{"label": "dent", "confidence": 0.87, "x": 120, "y": 80, "w": 60, "h": 40}]
    [{"name": "tear", "score": 0.91, "bbox": [x, y, w, h]}]
    [{"class": "dent", "conf": 0.7, "x1": .., "y1": .., "x2": .., "y2": ..}]
Pixel coordinates are fine — the image size is sent along so the gateway normalises them.

Quick test without CiRA:   python cira_to_gateway.py some_box.jpg
"""
import base64
import json
import sys
import urllib.request

GATEWAY_URL = "http://127.0.0.1:8080/api/cira/result"   # edge gateway on the same PC
TIMEOUT_S = 0.8                                           # must stay below ai_timeout_ms


def _encode(frame, quality=80):
    """numpy BGR frame (OpenCV) or raw JPEG bytes -> base64 JPEG string."""
    if frame is None:
        return None
    if isinstance(frame, (bytes, bytearray)):
        return base64.b64encode(frame).decode()
    import cv2
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    return base64.b64encode(buf.tobytes()).decode() if ok else None


def _brightness(frame):
    try:
        import cv2
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
        return round(float(gray.mean()), 1)
    except Exception:
        return None  # the gateway measures it itself from the JPEG


def send_result(detections, frame_top=None, frame_side=None, parcel_id=None, seq=None, tracking=None):
    """Send one inspection to the gateway. Returns True on success. Never raises."""
    payload = {"detections": list(detections or []), "images": {}, "model": "cira-core"}
    if frame_top is not None and not isinstance(frame_top, (bytes, bytearray)):
        h, w = frame_top.shape[:2]
        payload.update(img_w=w, img_h=h, brightness=_brightness(frame_top))
    payload["images"]["top"] = _encode(frame_top)
    payload["images"]["side"] = _encode(frame_side)
    if parcel_id:
        payload["parcel_id"] = parcel_id   # from the MQTT trigger, if you subscribed to it
    if seq is not None:
        payload["seq"] = seq
    if tracking:
        payload["tracking"] = tracking     # if CiRA reads the barcode itself
    try:
        req = urllib.request.Request(GATEWAY_URL, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=TIMEOUT_S).read()
        return True
    except Exception as e:  # gateway down -> ESP32 firmware fail-safe still protects the line
        print("[cira_to_gateway] send failed:", e)
        return False


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python cira_to_gateway.py image.jpg [dent|tear]")
        sys.exit(1)
    data = open(sys.argv[1], "rb").read()
    cls = sys.argv[2] if len(sys.argv) > 2 else None
    dets = [{"label": cls, "confidence": 0.9, "x": 0.3, "y": 0.3, "w": 0.3, "h": 0.3}] if cls else []
    print("sent:", send_result(dets, data))
