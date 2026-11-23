// Pagina: telecamera, analisi continua e disegno dei risultati.
import { CARD_MM, Table, analyze, boxCorners, estimateScale, loadIndex } from './vision.js';

const PX_PER_MM = 2;      // risoluzione di lavoro: 2 px per mm basta per riconoscere e dimezza i tempi rispetto a 3
const MAX_GRAB = 2560;    // con i marker: lato massimo del fotogramma catturato
const MIN_INTERVAL = 120; // ms minimi tra due analisi (il resto del tempo lo usa l'analisi stessa)
const MOTION = 10;        // differenza media (0-255) oltre la quale l'immagine è mossa: si salta il fotogramma
const KEEP_MISSES = 2;    // una carta non vista viene mostrata ancora per questo numero di analisi
const MAX_TILT = 8;       // senza marker: gradi massimi di inclinazione del telefono per analizzare
const COLORS = { ready: '#50c850', exhausted: '#ff8c00', unknown: '#e63c3c' };

const $ = id => document.getElementById(id);
const settings = Object.assign({ width: 1000, height: 700, packs: ['core'], camera: '', noMarker: false },
  JSON.parse(localStorage.getItem('mc-settings') || '{}'));

let index = null, table = null, stream = null;
let tilt = null;          // inclinazione del telefono rispetto al piano (null = nessun sensore)
let rawPpm = null;        // senza marker: pixel per mm nel video originale (stimati dalle carte)
let tracked = [];         // carte mostrate: { card, misses }
let rate = 0;             // analisi al secondo (media mobile)

const status = msg => { $('status').textContent = msg; };

// ---------- avvio ----------

document.addEventListener('opencv-ready', init);
if (window.cv && cv.Mat) init();

async function init() {
  if (init.done) return;
  init.done = true;
  status('Caricamento carte…');
  await fillSettings();
  await reloadIndex();
  for (const id of ['start', 'recalibrate', 'analyze', 'nomarker']) $(id).disabled = false;
  $('start').onclick = () => (stream ? stopCamera() : startCamera());
  $('nomarker').onclick = () => setNoMarker(!settings.noMarker);
  $('recalibrate').onclick = () => { if (table) { table.H = null; status('Ricalibrazione: inquadra i 4 marker'); } };
  $('analyze').onclick = () => stream && process($('video'));
  $('photo').onchange = e => e.target.files[0] && analyzeImage(URL.createObjectURL(e.target.files[0]));
  $('save').onclick = saveSettings;
  const params = new URLSearchParams(location.search);  // es. ?test=test/frame_0.jpg&nomarker=1
  if (params.has('nomarker')) settings.noMarker = params.get('nomarker') === '1';
  showNoMarker();
  if (params.get('test')) analyzeImage(params.get('test'));
}

// ---------- modalità senza marker ----------
// Il telefono va tenuto parallelo al tavolo (fotocamera verso il basso, parte alta verso il lato
// opposto ai giocatori). La livella usa i sensori di orientamento; la scala si ricava dalle carte.

async function setNoMarker(on) {
  settings.noMarker = on;
  localStorage.setItem('mc-settings', JSON.stringify(settings));
  rawPpm = null;
  tracked = [];
  if (on) await startLevel();  // su iPhone il permesso va chiesto dentro un clic
  showNoMarker();
}

function showNoMarker() {
  $('nomarker').setAttribute('aria-pressed', settings.noMarker);
  $('nomarker').textContent = settings.noMarker ? '☑ Senza marker (attiva)' : '☐ Senza marker';
  $('recalibrate').hidden = settings.noMarker;
  $('level').hidden = !settings.noMarker || tilt === null;
}

async function startLevel() {
  if (startLevel.done || !window.DeviceOrientationEvent) return;
  try {
    if (DeviceOrientationEvent.requestPermission &&
        await DeviceOrientationEvent.requestPermission() !== 'granted') return;
  } catch { return; }
  startLevel.done = true;
  addEventListener('deviceorientation', e => {
    if (e.beta === null) return;  // PC: evento presente ma nessun sensore
    const r = Math.PI / 180;
    // angolo tra il telefono e il piano orizzontale, da beta (avanti/indietro) e gamma (sinistra/destra)
    tilt = Math.acos(Math.cos(e.beta * r) * Math.cos(e.gamma * r)) / r;
    const el = $('level');
    el.hidden = !settings.noMarker;
    el.className = tilt <= MAX_TILT ? 'ok' : '';
    el.textContent = tilt <= MAX_TILT ? `In piano ✓ ${tilt.toFixed(0)}°` : `Inclinato ${tilt.toFixed(0)}°: tienilo parallelo al tavolo`;
  });
}

async function reloadIndex() {
  index = await loadIndex(settings.packs);
  table = new Table(settings.width, settings.height, PX_PER_MM);
  status(`Pronto: ${index.meta.length} carte caricate`);
}

// ---------- impostazioni ----------

async function fillSettings() {
  $('width').value = settings.width;
  $('height').value = settings.height;
  const packs = await fetch('data/packs.json').then(r => r.json());
  $('packs').append(...Object.entries(packs).map(([code, p]) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${code}"> ${p.name} <small>(${p.faces})</small>`;
    label.firstChild.checked = settings.packs.includes(code);
    return label;
  }));
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    devices.forEach((d, i) => $('camera').add(new Option(d.label || `Telecamera ${i + 1}`, d.deviceId)));
    $('camera').value = settings.camera;
  } catch { /* nessun permesso ancora: si vedranno dopo il primo avvio */ }
}

async function saveSettings() {
  settings.width = Number($('width').value);
  settings.height = Number($('height').value);
  settings.packs = [...$('packs').querySelectorAll('input:checked')].map(i => i.value);
  settings.camera = $('camera').value;
  localStorage.setItem('mc-settings', JSON.stringify(settings));
  await reloadIndex();
  if (stream) { stopCamera(); startCamera(); }
}

// ---------- telecamera ----------

async function startCamera() {
  const video = { width: { ideal: 3840 }, height: { ideal: 2160 } };
  if (settings.camera) video.deviceId = { exact: settings.camera };
  else video.facingMode = { ideal: 'environment' };  // fotocamera posteriore sul cellulare
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (e) {
    status(`Telecamera non disponibile: ${e.message}`);
    return;
  }
  $('video').srcObject = stream;
  $('video').classList.add('live');
  await $('video').play();
  const s = stream.getVideoTracks()[0].getSettings();
  status(`Telecamera ${s.width}×${s.height}: ${settings.noMarker ? 'inquadra le carte dall\'alto' : 'inquadra i 4 marker'}`);
  if (settings.noMarker) startLevel();
  $('start').textContent = 'Ferma telecamera';
  navigator.wakeLock?.request('screen').catch(() => {});  // niente schermo che si spegne sul cellulare
  tracked = [];
  loop();
}

function stopCamera() {
  stream.getTracks().forEach(t => t.stop());
  stream = null;
  $('video').classList.remove('live');
  $('start').textContent = 'Avvia telecamera';
}

// Analisi continua: appena finita un'analisi si passa alla successiva (con una pausa minima).
// Si salta il fotogramma se l'immagine è mossa o, senza marker, se il telefono è inclinato.
async function loop() {
  if (!stream) return;
  const t0 = performance.now();
  const v = $('video');
  if (v.videoWidth) {
    const level = !settings.noMarker || tilt === null || tilt <= MAX_TILT;
    if (motion(v) > MOTION) status('Immagine mossa…');
    else if (level) {
      process(v);
      const dt = performance.now() - t0;
      rate = rate ? rate * 0.8 + (1000 / Math.max(dt, MIN_INTERVAL)) * 0.2 : 1000 / Math.max(dt, MIN_INTERVAL);
    }
  }
  setTimeout(loop, Math.max(10, MIN_INTERVAL - (performance.now() - t0)));
}

// Differenza media tra un'anteprima minuscola e quella precedente.
const small = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
let prevSmall = null;
function motion(v) {
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, small.width, small.height);
  const px = ctx.getImageData(0, 0, small.width, small.height).data;
  let diff = 0;
  if (prevSmall) for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i + 1] - prevSmall[i + 1]);
  prevSmall = px;
  return diff / (px.length / 4);
}

// ---------- analisi ----------

// Cattura la sorgente (video o immagine) già rimpicciolita dal browser: molto più veloce
// che leggere il fotogramma intero e ridimensionarlo con OpenCV.
const grabCanvas = document.createElement('canvas');
function grab(source, scale) {
  const w = source.videoWidth || source.naturalWidth, h = source.videoHeight || source.naturalHeight;
  grabCanvas.width = Math.round(w * scale);
  grabCanvas.height = Math.round(h * scale);
  const ctx = grabCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, grabCanvas.width, grabCanvas.height);
  const rgba = cv.imread(grabCanvas), frame = new cv.Mat();
  cv.cvtColor(rgba, frame, cv.COLOR_RGBA2BGR);
  rgba.delete();
  return frame;
}

async function analyzeImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  table.H = null;
  rawPpm = null;
  tracked = [];
  process(img);
}

function process(source) {
  const t0 = performance.now();
  const w = source.videoWidth || source.naturalWidth;
  let top, ppm;

  if (settings.noMarker) {
    if (!rawPpm) {
      // prima stima della scala su una copia piccola
      const g = Math.min(1, 1600 / w);
      const f = grab(source, g);
      const est = estimateScale(f);
      f.delete();
      if (!est) { status('Nessuna carta trovata per stimare la scala: avvicina il telefono o migliora la luce'); return; }
      rawPpm = est.ppm / g;
    }
    const s = Math.min(2, PX_PER_MM / rawPpm);
    top = grab(source, s);
    ppm = rawPpm * s;
  } else {
    const g = Math.min(1, MAX_GRAB / w);
    const frame = grab(source, g);
    if (!table.H || table.grabWidth !== frame.cols) {
      const found = table.calibrate(frame);
      if (found !== true) {
        status(`Marker visibili: ${found.length ? found.join(', ') : 'nessuno'} — servono 0, 1, 2, 3`);
        frame.delete();
        return;
      }
      table.grabWidth = frame.cols;
    }
    top = table.rectify(frame);
    frame.delete();
    ppm = PX_PER_MM;
  }

  const cards = analyze(top, index, ppm);
  if (settings.noMarker) updateScale(cards, ppm);
  const shown = track(cards);
  const ms = Math.round(performance.now() - t0);
  status(`${cards.length} carte · ${ms} ms${stream && rate ? ` · ${rate.toFixed(1)} analisi/s` : ''}`);
  render(top, shown);
  top.delete();
  window.lastResult = cards.map(({ rect, ...c }) => c);  // usato dai test automatici
}

// Senza marker: aggiorna la scala con la dimensione delle carte appena riconosciute (se il telefono
// si avvicina o si allontana la scala lo segue). Dopo 3 analisi vuote si rifà la stima da zero.
function updateScale(cards, ppm) {
  const sizes = cards.filter(c => c.id)
    .map(c => Math.sqrt(c.rect.size.width * c.rect.size.height / (CARD_MM[0] * CARD_MM[1])) / ppm)
    .sort((a, b) => a - b);
  if (sizes.length) {
    rawPpm *= sizes[Math.floor(sizes.length / 2)];
    updateScale.empty = 0;
  } else if (++updateScale.empty >= 3) {
    rawPpm = null;
  }
}
updateScale.empty = 0;

// Una carta che sparisce per una o due analisi (riflesso, mano) resta visibile, tratteggiata.
function track(cards) {
  const near = (a, b) => Math.hypot(a.centerMm[0] - b.centerMm[0], a.centerMm[1] - b.centerMm[1]) < CARD_MM[0] * 0.6;
  const kept = tracked
    .filter(t => t.card.id && !cards.some(c => near(c, t.card)))
    .map(t => ({ card: t.card, misses: t.misses + 1 }))
    .filter(t => t.misses <= KEEP_MISSES);
  tracked = [...cards.map(card => ({ card, misses: 0 })), ...kept];
  return tracked;
}

function render(top, shown) {
  const canvas = $('table');
  const scale = Math.min(1, (canvas.clientWidth * devicePixelRatio || 1400) / top.cols);
  const disp = new cv.Mat(), rgba = new cv.Mat();
  cv.resize(top, disp, new cv.Size(Math.round(top.cols * scale), Math.round(top.rows * scale)), 0, 0, cv.INTER_AREA);
  cv.cvtColor(disp, rgba, cv.COLOR_BGR2RGBA);
  cv.imshow(canvas, rgba);
  disp.delete(); rgba.delete();

  const ctx = canvas.getContext('2d');
  const line = Math.max(2, 4 * scale);
  ctx.font = `bold ${Math.max(11, Math.round(18 * scale * 2))}px system-ui`;
  for (const { card: c, misses } of shown) {
    const state = c.id === null ? 'unknown' : c.exhausted ? 'exhausted' : 'ready';
    const q = boxCorners(c.rect).map(([x, y]) => [x * scale, y * scale]);
    ctx.setLineDash(misses ? [8, 6] : []);
    ctx.lineWidth = line;
    ctx.strokeStyle = ctx.fillStyle = COLORS[state];
    ctx.beginPath();
    q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    const label = c.name + (c.exhausted ? ' ⟳' : '');
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.strokeText(label, q[0][0], q[0][1] - 6);
    ctx.fillText(label, q[0][0], q[0][1] - 6);
  }

  const cards = shown.map(t => t.card);
  $('count').textContent = `Carte sul tavolo: ${cards.length}`;
  $('cards').replaceChildren(...cards
    .sort((a, b) => a.centerMm[1] - b.centerMm[1] || a.centerMm[0] - b.centerMm[0])
    .map(c => {
      const li = document.createElement('li');
      li.className = c.id === null ? 'unknown' : c.exhausted ? 'exhausted' : '';
      li.innerHTML = c.id
        ? `<a href="https://marvelcdb.com/card/${c.id}" target="_blank" rel="noopener">${c.name}</a> — ${c.exhausted ? 'esaurita' : 'pronta'} <small>${c.score}</small>`
        : `Carta non riconosciuta <small>${c.score}</small>`;
      return li;
    }));
}
