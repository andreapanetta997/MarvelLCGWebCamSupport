"""Prova l'intera catena (marker -> raddrizzamento -> carte -> riconoscimento) senza telecamera:
crea foto finte di un tavolo, viste in prospettiva, con luce irregolare, sfocatura e compressione JPEG.

    python test_synthetic.py                    simula una webcam 4K
    python test_synthetic.py --cam-width 1920   simula una webcam Full HD
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

import carddb
from cards import CARD_MM, analyze
from table import ARUCO_DICT, Table

ROOT = Path(__file__).parent


def place_card(canvas, img, center, rot_cw, ppm):
    """Incolla la carta sul tavolo, ruotata di rot_cw gradi in senso orario."""
    portrait = img.shape[0] >= img.shape[1]
    w_mm, h_mm = CARD_MM if portrait else CARD_MM[::-1]
    card = cv2.resize(img, (int(w_mm * ppm), int(h_mm * ppm)), interpolation=cv2.INTER_AREA)
    h, w = card.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), -rot_cw, 1.0)  # OpenCV: angolo positivo = antiorario
    M[:, 2] += np.array(center) - (w / 2, h / 2)
    size = (canvas.shape[1], canvas.shape[0])
    warped = cv2.warpAffine(card, M, size)
    mask = cv2.warpAffine(np.full((h, w), 255, np.uint8), M, size)
    canvas[mask > 0] = warped[mask > 0]


def make_scene(rng, index, ppm, table_mm, cam_size):
    tw, th = table_mm
    margin = 60  # mm di tavolo visibili fuori dai marker
    W, H = int((tw + 2 * margin) * ppm), int((th + 2 * margin) * ppm)
    canvas = np.full((H, W, 3), (40, 35, 30), np.uint8)
    canvas = cv2.add(canvas, rng.integers(0, 12, canvas.shape, dtype=np.uint8))  # trama della tovaglia

    # marker centrati sugli angoli dell'area di gioco
    dictionary = cv2.aruco.getPredefinedDictionary(ARUCO_DICT)
    msize = int(50 * ppm)
    for i, (x, y) in enumerate([(0, 0), (tw, 0), (tw, th), (0, th)]):
        cx, cy = int((x + margin) * ppm), int((y + margin) * ppm)
        pad = int(8 * ppm)
        canvas[cy - msize // 2 - pad:cy + msize // 2 + pad, cx - msize // 2 - pad:cx + msize // 2 + pad] = 255
        m = cv2.cvtColor(cv2.aruco.generateImageMarker(dictionary, i, msize), cv2.COLOR_GRAY2BGR)
        canvas[cy - msize // 2:cy - msize // 2 + msize, cx - msize // 2:cx - msize // 2 + msize] = m

    # carte su una griglia, con un po' di disordine
    truth = []
    for gx in range(110, int(tw) - 90, 120):
        for gy in range(110, int(th) - 90, 125):
            meta = index.meta[rng.integers(len(index.meta))]
            img = cv2.imread(str(carddb.DATA / "images" / f"{meta['id']}.png"))
            img = cv2.convertScaleAbs(img, alpha=rng.uniform(0.75, 1.2), beta=rng.uniform(-25, 25))
            rot = int(rng.choice([0, 0, 90, 180, 270]))
            jitter = rng.uniform(-4, 4)
            # le carte orizzontali ruotate di 90 occupano spazio verticale: ok con la griglia scelta
            center_mm = (gx + rng.uniform(-6, 6), gy + rng.uniform(-6, 6))
            place_card(canvas, img, ((center_mm[0] + margin) * ppm, (center_mm[1] + margin) * ppm), rot + jitter, ppm)
            truth.append({"id": meta["id"], "name": meta["name"], "rotation": rot, "center_mm": center_mm})

    # luce irregolare + riflesso
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    light = 0.8 + 0.3 * (xx / W) + 0.15 * np.exp(-((xx - W * rng.uniform(.2, .8)) ** 2 + (yy - H * rng.uniform(.2, .8)) ** 2) / (2 * (W / 10) ** 2))
    canvas = np.clip(canvas * light[..., None], 0, 255).astype(np.uint8)

    # vista della telecamera: prospettiva leggera, sfocatura, rumore, JPEG
    cw, ch = cam_size
    src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    s = min(cw / W, ch / H) * 0.97
    ox, oy = (cw - W * s) / 2, (ch - H * s) / 2
    dst = np.float32([[ox, oy], [ox + W * s, oy], [ox + W * s, oy + H * s], [ox, oy + H * s]])
    dst += rng.uniform(-0.03, 0.03, (4, 2)).astype(np.float32) * [cw, ch]
    frame = cv2.warpPerspective(canvas, cv2.getPerspectiveTransform(src, dst), (cw, ch))
    frame = cv2.GaussianBlur(frame, (3, 3), 0.8)
    frame = cv2.add(frame, rng.normal(0, 4, frame.shape).clip(0, 255).astype(np.uint8))
    _, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return cv2.imdecode(jpg, cv2.IMREAD_COLOR), truth


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cam-width", type=int, default=3840)
    ap.add_argument("--scenes", type=int, default=5)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--save", help="cartella dove salvare foto e soluzioni (per provare la pagina web)")
    args = ap.parse_args()
    save = Path(args.save) if args.save else None
    if save:
        save.mkdir(parents=True, exist_ok=True)

    cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    ppm = cfg["px_per_mm"]
    table_mm = (cfg["table_mm"]["width"], cfg["table_mm"]["height"])
    cam_size = (args.cam_width, args.cam_width * 9 // 16)
    index = carddb.build_index(cfg["packs"])
    rng = np.random.default_rng(args.seed)

    tot = found = right = rot_ok = 0
    for n in range(args.scenes):
        frame, truth = make_scene(rng, index, ppm, table_mm, cam_size)
        if save:
            cv2.imwrite(str(save / f"frame_{n}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
            (save / f"truth_{n}.json").write_text(json.dumps(truth, ensure_ascii=False), encoding="utf-8")
        table = Table(*table_mm, ppm)
        if not table.calibrate(frame):
            print(f"scena {n}: marker NON trovati")
            tot += len(truth)
            continue
        top = table.rectify(frame)
        cards = analyze(top, index, ppm)
        if n == 0:
            cv2.imwrite(str(ROOT / "test_frame.jpg"), frame)
            from app import draw
            cv2.imwrite(str(ROOT / "test_result.jpg"), draw(top, cards))
        for t in truth:
            tot += 1
            near = [c for c in cards if np.hypot(c["center_mm"][0] - t["center_mm"][0], c["center_mm"][1] - t["center_mm"][1]) < 20]
            if not near:
                print(f"  non trovata: {t['name']} (rot {t['rotation']})")
                continue
            c = near[0]
            found += 1
            # stessa carta o stessa immagine (ristampe identiche con codice diverso)
            if c["name"] == t["name"]:
                right += 1
                rot_ok += c["rotation"] == t["rotation"]
                if c["rotation"] != t["rotation"]:
                    print(f"  rotazione sbagliata: {t['name']} vera {t['rotation']} letta {c['rotation']}")
            else:
                print(f"  scambiata: {t['name']} -> {c['name']} (somiglianza {c['score']})")
        print(f"scena {n}: {len(truth)} carte, {len(cards)} rilevate")

    print(f"\nTelecamera {cam_size[0]}x{cam_size[1]} - {tot} carte")
    print(f"  trovate:       {found}/{tot}")
    print(f"  riconosciute:  {right}/{tot}")
    print(f"  rotazione ok:  {rot_ok}/{right}")


if __name__ == "__main__":
    main()
