"""Trova le carte nell'immagine raddrizzata del tavolo e le riconosce.

Limiti attuali (voluti, per partire semplici):
- serve uno sfondo uniforme (tovaglia o tappetino scuro a tinta unita);
- tra una carta e l'altra serve qualche millimetro di spazio (carte sovrapposte non vengono viste);
- le carte devono essere più o meno allineate al tavolo (dritte o ruotate di 90°, non a 45°).
"""
import cv2
import numpy as np

from carddb import descriptor

CARD_MM = (63.5, 88.9)
MIN_SCORE = 0.55  # sotto questa somiglianza la carta è "sconosciuta" (da tarare con le tue carte)

# rotazioni orarie applicabili all'immagine ritagliata
ROTATE = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def find_cards(top, px_per_mm):
    """Rettangoli (cv2.minAreaRect) delle carte trovate."""
    expected = CARD_MM[0] * CARD_MM[1] * px_per_mm ** 2
    # bordi cercati su ogni canale colore: una carta dal bordo scuro su un tavolo scuro
    # si distingue spesso solo per il colore, non per la luminosità
    blur = cv2.GaussianBlur(top, (5, 5), 0)
    edges = np.max([cv2.Canny(ch, 20, 60) for ch in cv2.split(blur)], axis=0)
    # chiude i piccoli buchi nel contorno (riflessi, bordi poco contrastati)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    candidates = []
    for c in contours:
        rect = cv2.minAreaRect(c)
        w, h = rect[1]
        area = w * h
        if not 0.7 * expected < area < 1.35 * expected:
            continue
        if not 1.25 < max(w, h) / max(min(w, h), 1) < 1.55:
            continue
        fill = cv2.contourArea(c) / area  # quanto il contorno somiglia davvero a un rettangolo
        if fill > 0.85:
            candidates.append((fill, rect))

    # lo stesso bordo produce più contorni: teniamo il migliore per ogni posizione
    rects = []
    min_dist = CARD_MM[0] * px_per_mm * 0.4
    for _, rect in sorted(candidates, key=lambda t: -t[0]):
        if all(np.hypot(rect[0][0] - r[0][0], rect[0][1] - r[0][1]) > min_dist for r in rects):
            rects.append(rect)
    return rects


def _order(pts):
    """Angoli in ordine: alto-sx, alto-dx, basso-dx, basso-sx (nel sistema del tavolo)."""
    s, d = pts.sum(axis=1), pts[:, 1] - pts[:, 0]
    return np.float32([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]])


def crop(top, rect):
    """La carta ritagliata così come giace sul tavolo (verticale o orizzontale)."""
    q = _order(cv2.boxPoints(rect))
    w = int(np.linalg.norm(q[1] - q[0]))
    h = int(np.linalg.norm(q[3] - q[0]))
    M = cv2.getPerspectiveTransform(q, np.float32([[0, 0], [w, 0], [w, h], [0, h]]))
    return cv2.warpPerspective(top, M, (w, h))


def identify(top, rect, index, px_per_mm):
    """Riconosce una carta e calcola di quanti gradi (orari) è ruotata rispetto alla stampa."""
    img = crop(top, rect)
    best = (-1.0, None, 0)
    for k in (0, 90, 180, 270):
        cand = img if k == 0 else cv2.rotate(img, ROTATE[k])
        if cand.shape[0] < cand.shape[1]:
            continue  # confrontiamo solo in verticale, come l'indice
        i, score = index.best(descriptor(cand))
        if score > best[0]:
            best = (score, i, k)

    score, i, k = best
    card = index.meta[i]
    # cand = img ruotata di k e coincide con la stampa ruotata di ref_rot  =>  sul tavolo è ruotata di ref_rot - k
    rotation = (card["ref_rot"] - k) % 360
    (cx, cy) = rect[0]
    known = score >= MIN_SCORE
    return {
        "id": card["id"] if known else None,
        "name": card["name"] if known else "?",
        "type_code": card["type_code"] if known else None,
        "text": card["text"] if known else "",
        "score": round(score, 3),
        "rotation": rotation,
        "exhausted": known and rotation in (90, 270),
        "center_mm": (round(cx / px_per_mm), round(cy / px_per_mm)),
        "rect": rect,
    }


def analyze(top, index, px_per_mm):
    return [identify(top, r, index, px_per_mm) for r in find_cards(top, px_per_mm)]
