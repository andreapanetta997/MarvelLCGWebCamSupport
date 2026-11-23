// Visione: stessa logica di table.py, cards.py e carddb.descriptor() in Python, ma con OpenCV.js.
// Tutte le Mat create qui vengono liberate con .delete() (OpenCV.js non ha garbage collector).

export const CARD_MM = [63.5, 88.9];
export const MIN_SCORE = 0.55;
const THUMB_W = 20, THUMB_H = 28, MARGIN = 0.05;

// ---------- indice carte ----------

export async function loadIndex(packs) {
  const metas = [], parts = [];
  for (const p of packs) {
    const [meta, bin] = await Promise.all([
      fetch(`data/${p}.json`).then(r => r.json()),
      fetch(`data/${p}.bin`).then(r => r.arrayBuffer()),
    ]);
    metas.push(...meta);
    parts.push(new Int8Array(bin));
  }
  const dim = THUMB_W * THUMB_H * 3;
  const descs = new Int8Array(metas.length * dim);
  let off = 0;
  for (const part of parts) { descs.set(part, off); off += part.length; }
  return { meta: metas, descs, dim };
}

function best(index, d) {
  let bi = -1, bs = -Infinity;
  const { descs, dim, meta } = index;
  for (let i = 0; i < meta.length; i++) {
    let s = 0;
    const o = i * dim;
    for (let j = 0; j < dim; j++) s += descs[o + j] * d[j];
    s *= meta[i].scale;
    if (s > bs) { bs = s; bi = i; }
  }
  return [bi, bs];
}

// Miniatura a colori normalizzata (come carddb.descriptor). card: Mat BGR, verticale.
export function descriptor(card) {
  const h = card.rows, w = card.cols;
  const my = Math.trunc(h * MARGIN), mx = Math.trunc(w * MARGIN);
  const roi = card.roi(new cv.Rect(mx, my, w - 2 * mx, h - 2 * my));
  const small = new cv.Mat();
  cv.resize(roi, small, new cv.Size(THUMB_W, THUMB_H), 0, 0, cv.INTER_AREA);
  const px = small.data, n = THUMB_W * THUMB_H;
  const v = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += px[i * 3 + c];
    mean /= n;
    let varr = 0;
    for (let i = 0; i < n; i++) varr += (px[i * 3 + c] - mean) ** 2;
    const std = Math.sqrt(varr / n) + 1e-6;
    for (let i = 0; i < n; i++) v[i * 3 + c] = (px[i * 3 + c] - mean) / std;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) + 1e-6;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  roi.delete(); small.delete();
  return v;
}

// ---------- tavolo ----------

export class Table {
  constructor(widthMm, heightMm, pxPerMm) {
    this.ppm = pxPerMm;
    this.size = new cv.Size(Math.trunc(widthMm * pxPerMm), Math.trunc(heightMm * pxPerMm));
    this.H = null;
  }

  // Cerca i marker 0..3 nel fotogramma (BGR). Se ci sono tutti, fissa l'omografia.
  calibrate(frame) {
    const gray = new cv.Mat();
    cv.cvtColor(frame, gray, cv.COLOR_BGR2GRAY);
    const dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);
    const detector = new cv.aruco_ArucoDetector(dict, new cv.aruco_DetectorParameters(), new cv.aruco_RefineParameters(10, 3, true));
    const corners = new cv.MatVector(), ids = new cv.Mat(), rejected = new cv.MatVector();
    detector.detectMarkers(gray, corners, ids, rejected);
    const centers = {};
    for (let i = 0; i < ids.rows; i++) {
      const c = corners.get(i).data32F;
      centers[ids.data32S[i]] = [(c[0] + c[2] + c[4] + c[6]) / 4, (c[1] + c[3] + c[5] + c[7]) / 4];
    }
    gray.delete(); corners.delete(); ids.delete(); rejected.delete(); detector.delete(); dict.delete();
    if (![0, 1, 2, 3].every(k => k in centers)) return Object.keys(centers).map(Number);

    const { width: w, height: h } = this.size;
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, [...centers[0], ...centers[1], ...centers[2], ...centers[3]]);
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    if (this.H) this.H.delete();
    this.H = cv.getPerspectiveTransform(src, dst);
    src.delete(); dst.delete();
    return true;
  }

  rectify(frame) {
    const top = new cv.Mat();
    cv.warpPerspective(frame, top, this.H, this.size);
    return top;
  }
}

// ---------- carte ----------

export function findCards(top, ppm) {
  const expected = CARD_MM[0] * CARD_MM[1] * ppm ** 2;
  const blur = new cv.Mat(), chans = new cv.MatVector(), edges = new cv.Mat(), e = new cv.Mat();
  cv.GaussianBlur(top, blur, new cv.Size(5, 5), 0);
  cv.split(blur, chans);
  // bordi su ogni canale colore, poi il massimo (carte scure su tavolo scuro)
  for (let c = 0; c < 3; c++) {
    cv.Canny(chans.get(c), c === 0 ? edges : e, 20, 60);
    if (c > 0) cv.max(edges, e, edges);
  }
  const kernel = cv.Mat.ones(7, 7, cv.CV_8U);
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
  const contours = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const candidates = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const rect = cv.minAreaRect(cnt);
    const { width: w, height: h } = rect.size;
    const area = w * h;
    const ratio = Math.max(w, h) / Math.max(Math.min(w, h), 1);
    if (area > 0.7 * expected && area < 1.35 * expected && ratio > 1.25 && ratio < 1.55) {
      const fill = cv.contourArea(cnt) / area;
      if (fill > 0.85) candidates.push([fill, rect]);
    }
    cnt.delete();
  }
  blur.delete(); chans.delete(); edges.delete(); e.delete(); kernel.delete(); contours.delete(); hier.delete();

  const rects = [], minDist = CARD_MM[0] * ppm * 0.4;
  for (const [, r] of candidates.sort((a, b) => b[0] - a[0])) {
    if (rects.every(o => Math.hypot(r.center.x - o.center.x, r.center.y - o.center.y) > minDist)) rects.push(r);
  }
  return rects;
}

// angoli in ordine alto-sx, alto-dx, basso-dx, basso-sx
export function boxCorners(rect) {
  const p = cv.RotatedRect.points(rect).map(q => [q.x, q.y]);
  const pick = f => p.reduce((a, b) => (f(b) < f(a) ? b : a));
  return [pick(q => q[0] + q[1]), pick(q => q[1] - q[0]), pick(q => -(q[0] + q[1])), pick(q => q[0] - q[1])];
}

function crop(top, rect) {
  const q = boxCorners(rect);
  const w = Math.trunc(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]));
  const h = Math.trunc(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]));
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, q.flat());
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const M = cv.getPerspectiveTransform(src, dst);
  const out = new cv.Mat();
  cv.warpPerspective(top, out, M, new cv.Size(w, h));
  src.delete(); dst.delete(); M.delete();
  return out;
}

const ROTATE = { 90: cv => cv.ROTATE_90_CLOCKWISE, 180: cv => cv.ROTATE_180, 270: cv => cv.ROTATE_90_COUNTERCLOCKWISE };

export function identify(top, rect, index, ppm) {
  const img = crop(top, rect);
  let bestScore = -1, bestI = 0, bestK = 0;
  for (const k of [0, 90, 180, 270]) {
    let cand = img;
    if (k) { cand = new cv.Mat(); cv.rotate(img, cand, ROTATE[k](cv)); }
    if (cand.rows >= cand.cols) {
      const [i, s] = best(index, descriptor(cand));
      if (s > bestScore) [bestScore, bestI, bestK] = [s, i, k];
    }
    if (k) cand.delete();
  }
  img.delete();
  const card = index.meta[bestI];
  // ruotata di k coincide con la stampa ruotata di ref_rot => sul tavolo è ruotata di ref_rot - k
  const rotation = (((card.ref_rot - bestK) % 360) + 360) % 360;
  const known = bestScore >= MIN_SCORE;
  return {
    id: known ? card.id : null,
    name: known ? card.name : '?',
    type: known ? card.type : null,
    score: Math.round(bestScore * 1000) / 1000,
    rotation,
    exhausted: known && (rotation === 90 || rotation === 270),
    centerMm: [Math.round(rect.center.x / ppm), Math.round(rect.center.y / ppm)],
    rect,
  };
}

export function analyze(top, index, ppm) {
  return findCards(top, ppm).map(r => identify(top, r, index, ppm));
}
