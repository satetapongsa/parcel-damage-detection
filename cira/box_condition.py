"""
Box condition check with OpenCV — WET and DEFORM, no training needed.
Same algorithm as edge/condition.js (the gateway also runs it, so this is optional on the CiRA side).

  WET    : water makes cardboard darker AND more saturated, hue stays brown.
           Dent shadows are darker but keep the saturation -> not counted.
  DEFORM : silhouette area / minimum-area rectangle ("fill"). A crushed box leaves gaps.

    from box_condition import analyze_box
    dets = analyze_box(frame_bgr, cam="top")   # -> [{"label":"wet","confidence":0.8,"x":..,"y":..,"w":..,"h":..}, ...]
"""
import cv2
import numpy as np


def analyze_box(frame, cam="top", work_width=200):
    if frame is None:
        return []
    h0, w0 = frame.shape[:2]
    scale = work_width / float(w0)
    img = cv2.resize(frame, (work_width, max(1, int(h0 * scale))), interpolation=cv2.INTER_AREA)
    H, W = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hue = hsv[..., 0].astype(np.float32) * 2.0           # 0..360
    sat = hsv[..., 1].astype(np.float32) / 255.0
    val = hsv[..., 2].astype(np.float32) / 255.0
    card = (hue >= 12) & (hue <= 50) & (sat >= 0.22) & (val >= 0.12)

    mask = card.astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    box = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(box)
    if area < 0.03 * W * H:
        return []  # no box in view

    out = []
    (rw, rh) = cv2.minAreaRect(box)[1]
    fill = area / max(rw * rh, 1.0)
    deform_conf = float(np.clip((0.97 - fill) / 0.17, 0, 1))
    x, y, w, h = cv2.boundingRect(box)
    if deform_conf > 0.15:
        out.append({"label": "deform", "confidence": round(deform_conf, 3),
                    "x": x / W, "y": y / H, "w": w / W, "h": h / H, "cam": cam, "src": "cv"})

    inside = np.zeros((H, W), np.uint8)
    cv2.drawContours(inside, [box], -1, 1, thickness=-1)
    sel = (inside > 0) & card
    if sel.sum() > 0:
        med_v, med_s = np.median(val[sel]), np.median(sat[sel])
        wet = (sel & (val < med_v * 0.8) & (sat > med_s + 0.08)).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(wet, connectivity=4)
        if n > 1:
            i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            blob = stats[i, cv2.CC_STAT_AREA]
            wet_conf = float(np.clip((blob / area) / 0.06, 0, 1))
            if wet_conf > 0.15 and blob >= 12:
                bx, by, bw, bh = stats[i, :4]
                out.append({"label": "wet", "confidence": round(wet_conf, 3),
                            "x": bx / W, "y": by / H, "w": bw / W, "h": bh / H, "cam": cam, "src": "cv"})
    return out


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("usage: python box_condition.py image.jpg")
        sys.exit(1)
    print(analyze_box(cv2.imread(sys.argv[1])))
