// Pagina: telecamera, rilevamento del movimento, analisi e disegno dei risultati.
import { Table, analyze, boxCorners, estimateScale, loadIndex } from './vision.js';

const PX_PER_MM = 3;
const CHECK_MS = 200;     // ogni quanto controlliamo se il tavolo si muove
const STILL_CHECKS = 3;   // controlli fermi di fila prima di analizzare (~0,6 s)
const MOTION = 3;         // differenza media (0-255) oltre la quale c'è movimento
const COLORS = { ready: '#50c850', exhausted: '#ff8c00', unknown: '#e63c3c' };
const MAX_TILT = 8;       // senza marker: gradi massimi di inclinazione del telefono per analizzare

const $ = id => document.getElementById(id);
const settings = Object.assign({ width: 1000, height: 700, packs: ['core'], camera: '', noMarker: false },
  JSON.parse(localStorage.getItem('mc-settings') || '{}'));

let index = null, table = null, stream = null, timer = null;
let prevSmall = null, still = 0;
let tilt = null;          // inclinazione del telefono rispetto al piano (null = nessun sensore)

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
  $('analyze').onclick = () => analyzeVideo(true);
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
  if (on) await startLevel();  // su iPhone il permesso va chiesto dentro un clic
  showNoMarker();
}

function showNoMarker() {
  $('nomarker').setAttribute('aria-pressed', settings.noMarker);
  $('nomarker').textContent = `Senza marker: ${settings.noMarker ? 'sì' : 'no'}`;
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
  timer = setInterval(watch, CHECK_MS);
}

function stopCamera() {
  clearInterval(timer);
  stream.getTracks().forEach(t => t.stop());
  stream = null;
  $('video').classList.remove('live');
  $('start').textContent = 'Avvia telecamera';
}

// Confronta un'anteprima minuscola con la precedente: analizza solo quando il tavolo è fermo.
const small = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
function watch() {
  const v = $('video');
  if (!v.videoWidth) return;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, small.width, small.height);
  const px = ctx.getImageData(0, 0, small.width, small.height).data;
  let diff = 0;
  if (prevSmall) for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i + 1] - prevSmall[i + 1]);
  diff /= px.length / 4;
  prevSmall = px;
  still = diff > MOTION ? 0 : still + 1;
  if (settings.noMarker) {
    // senza marker si analizza solo con il telefono fermo e in piano (se ha i sensori)
    if (still === STILL_CHECKS && (tilt === null || tilt <= MAX_TILT)) analyzeVideo(false);
  } else if (still === STILL_CHECKS || !table.H) {
    analyzeVideo(false);
  }
}

// ---------- analisi ----------

const grab = document.createElement('canvas');
function analyzeVideo(force) {
  const v = $('video');
  if (!v.videoWidth) return;
  grab.width = v.videoWidth;
  grab.height = v.videoHeight;
  grab.getContext('2d').drawImage(v, 0, 0);
  process(grab, force);
}

async function analyzeImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  table.H = null;
  process(img, true);
}

function process(source, force) {
  const rgba = cv.imread(source), frame = new cv.Mat();
  cv.cvtColor(rgba, frame, cv.COLOR_RGBA2BGR);
  rgba.delete();
  const t0 = performance.now();
  let top, note = '';
  if (settings.noMarker) {
    top = scaleFromCards(frame);
    frame.delete();
    if (!top) { status('Nessuna carta trovata per stimare la scala: avvicina il telefono o migliora la luce'); return; }
    note = ` · scala stimata da ${top.cardsUsed} carte`;
  } else {
    if (!table.H) {
      const found = table.calibrate(frame);
      if (found !== true) {
        status(`Marker visibili: ${found.length ? found.join(', ') : 'nessuno'} — servono 0, 1, 2, 3`);
        frame.delete();
        return;
      }
    }
    top = table.rectify(frame);
    frame.delete();
  }
  const cards = analyze(top, index, top.ppm || PX_PER_MM);
  status(`${cards.length} carte · analisi in ${Math.round(performance.now() - t0)} ms${note}${force ? '' : ' (tavolo fermo)'}`);
  render(top, cards);
  top.delete();
  window.lastResult = cards.map(({ rect, ...c }) => c);  // usato dai test automatici
}

// Senza marker: l'immagine viene presa così com'è e ridimensionata in modo che 1 mm = PX_PER_MM pixel,
// usando la dimensione media delle carte trovate. La stima si fa su una copia piccola (più veloce).
function scaleFromCards(frame) {
  const f = Math.min(1, 1600 / Math.max(frame.cols, frame.rows));
  const small = new cv.Mat();
  cv.resize(frame, small, new cv.Size(Math.round(frame.cols * f), Math.round(frame.rows * f)), 0, 0, cv.INTER_AREA);
  const est = estimateScale(small);
  small.delete();
  if (!est) return null;
  const s = Math.min(2, PX_PER_MM / (est.ppm / f));  // fattore dal fotogramma originale alla scala voluta
  const top = new cv.Mat();
  cv.resize(frame, top, new cv.Size(Math.round(frame.cols * s), Math.round(frame.rows * s)), 0, 0, s < 1 ? cv.INTER_AREA : cv.INTER_LINEAR);
  top.cardsUsed = est.count;
  top.ppm = (est.ppm / f) * s;  // = PX_PER_MM, salvo carte minuscole (ingrandimento limitato a 2x)
  return top;
}

function render(top, cards) {
  const canvas = $('table');
  const scale = Math.min(1, (canvas.clientWidth * devicePixelRatio || 1400) / top.cols);
  const disp = new cv.Mat(), rgba = new cv.Mat();
  cv.resize(top, disp, new cv.Size(Math.round(top.cols * scale), Math.round(top.rows * scale)), 0, 0, cv.INTER_AREA);
  cv.cvtColor(disp, rgba, cv.COLOR_BGR2RGBA);
  cv.imshow(canvas, rgba);
  disp.delete(); rgba.delete();

  const ctx = canvas.getContext('2d');
  ctx.lineWidth = Math.max(2, 3 * scale * 2);
  ctx.font = `bold ${Math.max(11, Math.round(26 * scale))}px system-ui`;
  for (const c of cards) {
    const state = c.id === null ? 'unknown' : c.exhausted ? 'exhausted' : 'ready';
    const q = boxCorners(c.rect).map(([x, y]) => [x * scale, y * scale]);
    ctx.strokeStyle = ctx.fillStyle = COLORS[state];
    ctx.beginPath();
    q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    const label = c.name + (c.exhausted ? ' ⟳' : '');
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.strokeText(label, q[0][0], q[0][1] - 6);
    ctx.fillText(label, q[0][0], q[0][1] - 6);
    ctx.lineWidth = Math.max(2, 3 * scale * 2);
  }

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
