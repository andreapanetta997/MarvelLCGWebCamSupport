"""Database delle carte Marvel Champions.

Scarica dati e immagini da MarvelCDB (una volta sola, poi usa la cache in data/)
e costruisce l'indice usato per riconoscere le carte inquadrate.
"""
import json
import time
from pathlib import Path

import cv2
import numpy as np
import requests

DATA = Path(__file__).parent / "data"
API = "https://marvelcdb.com/api/public/cards/?encounter=1"  # encounter=1 include anche cattivi e incontri
SITE = "https://marvelcdb.com"
HEADERS = {"User-Agent": "mc-arbiter/0.1 (progetto hobbistico)"}

# Descrittore: miniatura a colori della carta (verticale). Bassa risoluzione = robusta a sfocatura e riflessi.
THUMB_W, THUMB_H = 20, 28
MARGIN = 0.05  # bordo tagliato su ogni lato (angoli arrotondati, bustine)


def load_cards(refresh=False):
    path = DATA / "cards.json"
    if refresh or not path.exists():
        DATA.mkdir(exist_ok=True)
        r = requests.get(API, headers=HEADERS, timeout=60)
        r.raise_for_status()
        path.write_text(r.text, encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))


def faces(cards, packs):
    """Ogni lato stampato di ogni carta dei pack scelti ("all" = tutti)."""
    out = {}

    def add(card, src, name=None):
        if src:
            fid = Path(src).stem  # es. "01001a", "01137b"
            out.setdefault(fid, {
                "id": fid,
                "pack": pack,
                "code": card["code"],
                "name": name or card["name"],
                "type_code": card.get("type_code"),
                "text": card.get("real_text") or "",
                "src": src,
            })

    for c in cards:
        pack = c.get("pack_code")
        if packs != "all" and pack not in packs:
            continue
        for card in (c, c.get("linked_card")):
            if card:
                add(card, card.get("imagesrc"))
                add(card, card.get("backimagesrc"), card.get("back_name") or card["name"])
    return list(out.values())


def download_images(face_list):
    img_dir = DATA / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    missing = [f for f in face_list if not (img_dir / f"{f['id']}.png").exists()]
    for i, f in enumerate(missing, 1):
        r = requests.get(SITE + f["src"], headers=HEADERS, timeout=60)
        if r.status_code == 200:
            (img_dir / f"{f['id']}.png").write_bytes(r.content)
        else:
            print(f"\n  immagine non disponibile: {f['id']} ({r.status_code})")
        print(f"\r  scaricate {i}/{len(missing)} immagini", end="", flush=True)
        time.sleep(0.1)  # gentili con il server
    if missing:
        print()


def descriptor(card_bgr):
    """Vettore normalizzato di una carta in verticale: indipendente da luminosità e contrasto."""
    h, w = card_bgr.shape[:2]
    my, mx = int(h * MARGIN), int(w * MARGIN)
    small = cv2.resize(card_bgr[my:h - my, mx:w - mx], (THUMB_W, THUMB_H), interpolation=cv2.INTER_AREA)
    v = small.astype(np.float32)
    v -= v.mean(axis=(0, 1))
    v /= v.std(axis=(0, 1)) + 1e-6
    v = v.ravel()
    return v / (np.linalg.norm(v) + 1e-6)


class Index:
    def __init__(self, descs, meta):
        self.descs = descs  # N x D
        self.meta = meta    # per ogni riga: dati della carta + "ref_rot" (gradi orari per portarla in verticale)

    def best(self, desc):
        scores = self.descs @ desc
        i = int(scores.argmax())
        return i, float(scores[i])


def build_index(packs, refresh=False):
    face_list = faces(load_cards(refresh), packs)
    download_images(face_list)
    descs, meta = [], []
    for f in face_list:
        img = cv2.imread(str(DATA / "images" / f"{f['id']}.png"), cv2.IMREAD_COLOR)
        if img is None:
            continue
        ref_rot = 0
        if img.shape[1] > img.shape[0]:  # carta orizzontale (schemi): la portiamo in verticale
            img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
            ref_rot = 90
        descs.append(descriptor(img))
        meta.append({**f, "ref_rot": ref_rot})
    print(f"Indice pronto: {len(meta)} lati di carta")
    return Index(np.array(descs, dtype=np.float32), meta)
