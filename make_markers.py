"""Genera markers_A4.png: i 4 marker da stampare (al 100%, senza adattamento alla pagina),
ritagliare e mettere agli angoli dell'area di gioco."""
import cv2
import numpy as np

from table import ARUCO_DICT

DPI = 300
MM = DPI / 25.4
MARKER_MM = 50
LABELS = ["0 - ALTO SINISTRA", "1 - ALTO DESTRA", "2 - BASSO DESTRA", "3 - BASSO SINISTRA"]

page = np.full((int(297 * MM), int(210 * MM)), 255, np.uint8)
dictionary = cv2.aruco.getPredefinedDictionary(ARUCO_DICT)
size = int(MARKER_MM * MM)
for i, label in enumerate(LABELS):
    x = int((25 + (i % 2) * 95) * MM)
    y = int((40 + (i // 2) * 130) * MM)
    page[y:y + size, x:x + size] = cv2.aruco.generateImageMarker(dictionary, i, size)
    cv2.putText(page, label, (x, y + size + int(12 * MM)), cv2.FONT_HERSHEY_SIMPLEX, 1.6, 0, 3)

cv2.imwrite("markers_A4.png", page)
print("Creato markers_A4.png (A4, 300 dpi)")
