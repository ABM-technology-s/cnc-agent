'use strict';
// Камеры: кадр через ffmpeg, поиск человека в зоне через Python YOLO
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { CAM_INTERVAL, DWELL_GAP_SEC, FRAME_DIR } = require('./config');
const { sleep, hideRtsp, errText } = require('./util');

// SAVE_DEBUG=1 — сохранять кадр с нарисованной зоной и рамками (debug-<id>.jpg)
const SAVE_DEBUG = process.env.SAVE_DEBUG === '1';

function grabFrame(rtsp, outFile) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-rtsp_transport', 'tcp', '-i', rtsp, '-vf', 'hflip,vflip',
      '-frames:v', '1', '-q:v', '2', '-y', outFile]);
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg 20с таймаут (камера недоступна?)')); }, 20000);
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', e => { clearTimeout(timer); reject(new Error('ffmpeg не запустился: ' + e.message)); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(outFile);
      else reject(new Error(hideRtsp(err.slice(-300) || `ffmpeg exit ${code}`).replace(/\s+/g, ' ').trim()));
    });
  });
}

// Один общий Python-воркер на все камеры, запросы строго по очереди
let py = null, pyReady = false, waiting = null, pyError = null;

function startWorker() {
  pyReady = false;
  const venvPy = path.join(__dirname, 'venv', 'bin', 'python');
  const p = spawn(fs.existsSync(venvPy) ? venvPy : 'python3', [path.join(__dirname, 'person_worker.py')], { cwd: __dirname });
  py = p;
  p.on('error', e => { pyError = 'python не запустился: ' + e.message; });
  p.stderr.on('data', () => {});
  p.stdin.on('error', () => {});
  p.on('exit', () => {
    if (py === p) { py = null; pyReady = false; }
    if (waiting) { const w = waiting; waiting = null; w({ ok: false, error: 'python-воркер завершился' }); }
  });
  readline.createInterface({ input: p.stdout }).on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.ready) { pyReady = true; pyError = null; return; }
    if (waiting) { const w = waiting; waiting = null; w(msg); }
  });
}

function askWorker(file, zone, out) {
  return new Promise((resolve, reject) => {
    if (!py) startWorker();
    if (!pyReady) return reject(new Error(pyError || 'YOLO ещё загружается'));
    let done = false;
    const timer = setTimeout(() => {
      done = true; waiting = null;
      try { py.kill(); } catch (e) {}   // завис — перезапуск, чтобы поздний ответ не ушёл другой камере
      reject(new Error('YOLO 15с таймаут'));
    }, 15000);
    waiting = msg => { if (done) return; clearTimeout(timer); msg.ok ? resolve(msg) : reject(new Error(msg.error)); };
    py.stdin.write(JSON.stringify({ file, zone, out }) + '\n');
  });
}

let queue = Promise.resolve();
function detectPerson(file, zone, out) {
  const r = queue.then(() => askWorker(file, zone, out));
  queue = r.catch(() => {});
  return r;
}

// Таймер присутствия: человек засчитывается, если пробыл в зоне dwellSec
function applyDwell(cam, raw) {
  if (raw === null) return null;
  const t = Date.now(), gap = DWELL_GAP_SEC * 1000, need = cam.dwellSec * 1000;
  if (raw) {
    if (cam.inZoneSince === null || t - cam.lastSeenAt > gap) cam.inZoneSince = t;
    cam.lastSeenAt = t;
    return t - cam.inZoneSince >= need;
  }
  if (cam.inZoneSince !== null && t - cam.lastSeenAt > gap) cam.inZoneSince = null;
  return cam.inZoneSince !== null && t - cam.inZoneSince >= need && t - cam.lastSeenAt <= gap;
}

async function camTick(m) {
  const cam = m.cam;
  const id = m.machineId.replace(/[^\w.-]/g, '_');
  const frame = path.join(FRAME_DIR, `frame-${id}.jpg`);
  const out = SAVE_DEBUG ? path.join(FRAME_DIR, `debug-${id}.jpg`) : undefined;
  await grabFrame(m.rtsp, frame);
  try {
    const r = await detectPerson(frame, m.personZone, out);
    cam.people = r.people;
    cam.rawInZone = r.inZone === null ? null : r.inZone > 0;
    cam.error = null;
  } catch (e) {
    cam.people = null; cam.rawInZone = null;
    cam.error = 'детекция человека: ' + errText(e);
  }
  cam.inZone = applyDwell(cam, cam.rawInZone);
  cam.lastFrameAt = Date.now();
}

async function camLoop(m, isStopped) {
  while (!isStopped()) {
    const t0 = Date.now();
    try { await camTick(m); } catch (e) { m.cam.error = errText(e); }
    await sleep(Math.max(500, CAM_INTERVAL * 1000 - (Date.now() - t0)));
  }
}

function stopWorker() { try { if (py) py.kill(); } catch (e) {} }

module.exports = { camLoop, startWorker, stopWorker };
