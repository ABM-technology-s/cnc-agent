'use strict';
// Citizen / NOMURA (Mitsubishi) через CNCnetPDM на ноутбуке.
// CNCnetPDM отдаёт поток SHDR по TCP: 2026-10-22T13:42:31Z|1013:avail|AVAILABLE|1013:STATUS|2|1013:STATN|3|
// Device Nr 10NN = станок cnc-NN.
const net = require('net');
const { sleep } = require('./util');

const PDM_HOST = '192.168.39.210';
const PDM_PORT = 7878;
const STALE_MS = 30000;   // данных по станку нет дольше 30 с -> ВЫКЛЮЧЕН

// STATN = Running Status контроллера Mitsubishi (таблица Inventcom, машинные данные)
const STATUS_MAP = {
  0: 'СТОИТ',      // NC Reset
  1: 'АВАРИЯ',     // Emergency
  2: 'СТОИТ',      // Ready - готов, программа не идёт
  3: 'РАБОТАЕТ',   // In Automatic running
  4: 'РАБОТАЕТ',   // With Synchronization
  5: 'РАБОТАЕТ',   // Cross Waiting
  6: 'СТОИТ',      // Stop
  7: 'СТОИТ',      // Hold (feed hold)
};

const devices = {};   // '1013' -> { avail, status, statn, at }
let started = false;

function handleLine(line) {
  const f = line.trim().split('|');
  for (let i = 1; i + 1 < f.length; i += 2) {
    const [nr, key] = f[i].split(':');
    if (!nr || !key) continue;
    const d = devices[nr] || (devices[nr] = {});
    d[key] = f[i + 1];
    d.at = Date.now();
  }
}

async function connectLoop(isStopped) {
  while (!isStopped()) {
    await new Promise(resolve => {
      const sock = net.connect(PDM_PORT, PDM_HOST);
      let buf = '';
      sock.setEncoding('utf8');
      sock.setTimeout(60000, () => sock.destroy(new Error('нет данных 60 с')));
      sock.on('connect', () => console.log(`[citizen] подключено к CNCnetPDM ${PDM_HOST}:${PDM_PORT}`));
      sock.on('data', chunk => {
        buf += chunk;
        let n;
        while ((n = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, n)); buf = buf.slice(n + 1); }
      });
      sock.on('error', e => console.log('[citizen] ошибка:', e.message));
      sock.on('close', resolve);
    });
    await sleep(5000);   // переподключение
  }
}

function decide(d) {
  if (!d || Date.now() - d.at > STALE_MS || d.avail !== 'AVAILABLE') return 'ВЫКЛЮЧЕН';
  return STATUS_MAP[d.STATN] || 'СТОИТ';
}

async function citizenLoop(m, isStopped) {
  if (!started) { started = true; connectLoop(isStopped); }
  const nr = String(1000 + parseInt(m.machineId.replace(/\D/g, ''), 10));
  while (!isStopped()) {
    const d = devices[nr];
    m.cncData = {
      status: decide(d),
      parts_done: null,
      alarms: null,
      messages: null,
      raw: d ? `STATUS=${d.STATUS} STATN=${d.STATN}` : null,
    };
    await sleep(2000);
  }
}

module.exports = { citizenLoop };