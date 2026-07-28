import sys

import cv2
import numpy as np


def diagnose_image(img_bgr, detector, engine):
    """Run detection and OCR, returning an annotated image and diagnostic rows."""
    h, w = img_bgr.shape[:2]
    annotated = img_bgr.copy()
    rows = []
    for i, region in enumerate(detector.detect(img_bgr)):
        x, y, bw, bh = region.bbox
        x, y = max(0, x), max(0, y)
        x2, y2 = min(w, x + bw), min(h, y + bh)
        text = ""
        if x2 > x and y2 > y:
            crop = cv2.cvtColor(img_bgr[y:y2, x:x2], cv2.COLOR_BGR2RGB)
            text = engine.read(crop).strip()
        color = (0, 180, 0) if text else (0, 0, 220)
        cv2.rectangle(annotated, (x, y), (x2, y2), color, 2)
        cv2.putText(annotated, str(i), (x, max(12, y - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
        rows.append({"idx": i, "bbox": [x, y, x2 - x, y2 - y], "text": text})
    return annotated, rows


def _write_report(path, rows):
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            txt = r["text"] if r["text"] else "<rỗng>"
            f.write(f'#{r["idx"]}  bbox={r["bbox"]}  text="{txt}"\n')


def main(argv):
    import argparse

    from server.detector import Detector
    from server.ocr import OcrRegistry

    p = argparse.ArgumentParser()
    p.add_argument("image")
    p.add_argument("--lang", default="ja")
    p.add_argument("--conf", type=float, default=None)
    p.add_argument("--input-size", type=int, default=None)
    args = p.parse_args(argv)

    img = cv2.imdecode(np.fromfile(args.image, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"không đọc được ảnh: {args.image}")

    det = Detector(device="cuda", conf_thresh=args.conf, input_size=args.input_size)
    engine = OcrRegistry(device="cuda").get(args.lang)
    annotated, rows = diagnose_image(img, det, engine)

    out_png, out_txt = args.image + ".diag.png", args.image + ".diag.txt"
    cv2.imencode(".png", annotated)[1].tofile(out_png)
    _write_report(out_txt, rows)
    empty = sum(1 for r in rows if not r["text"])
    print(f"{len(rows)} block, {empty} rỗng → {out_png} / {out_txt}")


if __name__ == "__main__":
    main(sys.argv[1:])
