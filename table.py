"""Il tavolo visto dall'alto.

Quattro marker ArUco (id 0..3) segnano gli angoli dell'area di gioco:
0 = in alto a sinistra, 1 = in alto a destra, 2 = in basso a destra, 3 = in basso a sinistra
("alto" = lato opposto ai giocatori). Dai loro centri si ricava un'immagine raddrizzata
in cui 1 mm del tavolo = px_per_mm pixel.
"""
import cv2
import numpy as np

ARUCO_DICT = cv2.aruco.DICT_4X4_50


class Table:
    def __init__(self, width_mm, height_mm, px_per_mm):
        self.px_per_mm = px_per_mm
        self.size = (int(width_mm * px_per_mm), int(height_mm * px_per_mm))
        self.detector = cv2.aruco.ArucoDetector(
            cv2.aruco.getPredefinedDictionary(ARUCO_DICT), cv2.aruco.DetectorParameters())
        self.H = None  # omografia telecamera -> tavolo

    def calibrate(self, frame):
        """Cerca i 4 marker; se li trova fissa l'omografia. La telecamera è fissa, basta farlo una volta."""
        corners, ids, _ = self.detector.detectMarkers(frame)
        if ids is None:
            return False
        centers = {int(i): c[0].mean(axis=0) for i, c in zip(ids.ravel(), corners)}
        if not all(k in centers for k in range(4)):
            return False
        w, h = self.size
        src = np.float32([centers[0], centers[1], centers[2], centers[3]])
        dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        self.H = cv2.getPerspectiveTransform(src, dst)
        return True

    def rectify(self, frame):
        return cv2.warpPerspective(frame, self.H, self.size)
