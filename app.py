"""MC Arbiter - prototipo: guarda il tavolo dall'alto e riconosce le carte in gioco.

    python app.py                 webcam dal vivo
    python app.py --image foto.jpg  analizza una foto (con i 4 marker visibili)

Tasti nella finestra: Q = esci, C = ricalibra i marker, SPAZIO = rianalizza subito, S = salva istantanea.
"""
import argparse
import json
import time
from pathlib import Path

import cv2

import carddb
from cards import analyze
from table import Table

ROOT = Path(__file__).parent
STILL_FRAMES = 15        # fotogrammi consecutivi senza movimento prima di analizzare (~0,5 s a 30 fps)
MOTION_THRESHOLD = 3.0   # differenza media (0-255) oltre la quale la scena "si sta muovendo"
COLORS = {"ready": (80, 200, 80), "exhausted": (0, 140, 255), "unknown": (60, 60, 230)}


def open_camera(cfg):
    cap = cv2.VideoCapture(cfg["index"], cv2.CAP_DSHOW)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, cfg["width"])
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, cfg["height"])
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"Telecamera {cfg['index']}: {w}x{h}")
    return cap


def draw(top, cards):
    view = top.copy()
    for c in cards:
        state = "unknown" if c["id"] is None else "exhausted" if c["exhausted"] else "ready"
        box = cv2.boxPoints(c["rect"]).astype(int)
        cv2.polylines(view, [box], True, COLORS[state], 4)
        x, y = box[:, 0].min(), box[:, 1].min() - 10
        label = c["name"] + (" [ESAURITA]" if c["exhausted"] else "")
        cv2.putText(view, label, (int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 5)
        cv2.putText(view, label, (int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX, 0.9, COLORS[state], 2)
    return view


def report(cards):
    print(f"\n--- {time.strftime('%H:%M:%S')}  {len(cards)} carte sul tavolo ---")
    for c in sorted(cards, key=lambda c: (c["center_mm"][1], c["center_mm"][0])):
        state = "ESAURITA" if c["exhausted"] else "pronta"
        print(f"  {c['name']:<32} {state:<9} pos {c['center_mm']} mm  somiglianza {c['score']}")


def show(view):
    scale = min(1.0, 1600 / view.shape[1], 900 / view.shape[0])
    cv2.imshow("MC Arbiter", cv2.resize(view, None, fx=scale, fy=scale))
    return cv2.waitKey(1) & 0xFF


def save_snapshot(top, cards):
    out = ROOT / "snapshots"
    out.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    cv2.imwrite(str(out / f"{stamp}.png"), top)
    data = [{k: v for k, v in c.items() if k != "rect"} for c in cards]
    (out / f"{stamp}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Istantanea salvata in snapshots/{stamp}.*")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", help="analizza una foto invece della webcam")
    ap.add_argument("--refresh", action="store_true", help="riscarica l'elenco carte da MarvelCDB")
    args = ap.parse_args()

    cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    index = carddb.build_index(cfg["packs"], args.refresh)
    ppm = cfg["px_per_mm"]
    table = Table(cfg["table_mm"]["width"], cfg["table_mm"]["height"], ppm)

    if args.image:
        frame = cv2.imread(args.image)
        if frame is None or not table.calibrate(frame):
            raise SystemExit("Immagine non leggibile o marker 0-3 non tutti visibili.")
        top = table.rectify(frame)
        cards = analyze(top, index, ppm)
        report(cards)
        show(draw(top, cards))
        cv2.waitKey(0)
        return

    cap = open_camera(cfg["camera"])
    prev, still, cards, top = None, 0, [], None
    while True:
        ok, frame = cap.read()
        if not ok:
            raise SystemExit("La telecamera non risponde.")

        if table.H is None and not table.calibrate(frame):
            view = frame.copy()
            cv2.putText(view, "Marker 0-3 non visibili", (40, 80), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 4)
            key = show(view)
        else:
            top = table.rectify(frame)
            # analizziamo solo quando la scena è ferma (niente mani sul tavolo)
            small = cv2.cvtColor(cv2.resize(top, None, fx=0.1, fy=0.1), cv2.COLOR_BGR2GRAY)
            moving = prev is not None and cv2.absdiff(small, prev).mean() > MOTION_THRESHOLD
            prev = small
            still = 0 if moving else still + 1
            if still == STILL_FRAMES:
                cards = analyze(top, index, ppm)
                report(cards)
            view = draw(top, cards)
            if moving:
                cv2.putText(view, "movimento...", (30, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 200, 255), 3)
            key = show(view)

        if key == ord("q"):
            break
        if key == ord("c"):
            table.H = None
        if key == ord(" ") and top is not None:
            cards = analyze(top, index, ppm)
            report(cards)
        if key == ord("s") and top is not None:
            save_snapshot(top, cards)

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
