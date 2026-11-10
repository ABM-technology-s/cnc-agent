'use strict';
// Агент: все станки FANUC + камеры из machine-tools.json, отправка на сервер.
// Запуск: node combined.js (служба cnc-agent). Адрес сервера: переменная API_URL.
// В лог пишется строка только когда у станка что-то изменилось.
const fs = require('fs');
const { loadMachines, FRAME_DIR } = require('./config');
const { cncLoop } = require('./cnc');
const { citizenLoop } = require('./citizen');
const { camLoop, startWorker, stopWorker } = require('./camera');
const { sendAllLoop, camFresh } = require('./sender');
const { sleep, errText } = require('./util');

let stop = false, machines = [];
const isStopped = () => stop;
const yn = v => v == null ? '?' : (v ? 'да' : 'нет');

// Короткая строка о станке для лога
function summary(m) {
  const parts = [];
  if (m.cncIp) {
    const d = m.cncData || {};
    parts.push(d.status === 'ВЫКЛЮЧЕН' ? `ВЫКЛЮЧЕН / НЕТ СВЯЗИ (${m.cncIp}:${m.cncPort})` : (d.status || 'НЕТ ДАННЫХ'));
    parts.push(`деталей ${d.parts_done ?? '?'}/${d.parts_plan ?? '?'}`);
    const a = (d.alarms || []).map(x => `${x.number} ${x.text}`);
    parts.push(a.length ? 'аварии: ' + a.join('; ') : 'аварий нет');
  }
  if (m.cam) {
    parts.push(camFresh(m.cam) ? `оператор в зоне: ${yn(m.cam.inZone)}` : 'камера: нет свежих данных');
    if (m.cam.error) parts.push('ошибка камеры: ' + m.cam.error);
  }
  if (m.sendLine) parts.push('сервер ' + m.sendLine);
  return parts.join(' | ');
}

async function main() {
  try { machines = loadMachines(); }
  catch (e) { console.log('Ошибка machine-tools.json:', e.message); process.exit(1); }
  if (!machines.length) { console.log('Нет станков (нужен cncIp или rtsp)'); process.exit(1); }

  if (machines.some(m => m.cam)) { fs.mkdirSync(FRAME_DIR, { recursive: true }); startWorker(); }
  for (const m of machines) {
    if (m.cncIp) (m.driver === 'citizen' ? citizenLoop : cncLoop)(m, isStopped);
    if (m.cam) camLoop(m, isStopped);
  }
  sendAllLoop(machines, isStopped);

  const last = {};
  const HEARTBEAT_MS = 10 * 60 * 1000;
  let hbAt = Date.now();
  while (!stop) {
    if (Date.now() - hbAt >= HEARTBEAT_MS) {
      hbAt = Date.now();
      for (const m of machines) {
        const ago = m.lastOkAt ? `${Math.round((Date.now() - m.lastOkAt) / 1000)}s` : '—';
        console.log(`[${m.machineId}] heartbeat: последний ок ${ago} назад, переподключений ${m.reconnects || 0}, ${summary(m)}`);
      }
    }
    for (const m of machines) {
      const line = summary(m);
      if (line !== last[m.machineId]) { console.log(`[${m.machineId}] ${line}`); last[m.machineId] = line; }
    }
    await sleep(2000);
  }
}

async function quit() {
  stop = true;
  console.log('Выход...');
  stopWorker();
  for (const m of machines) { try { if (m.cnc) await m.cnc.disconnect(); } catch (e) {} }
  process.exit(0);
}
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('uncaughtException', e => console.log('Ошибка:', errText(e)));
process.on('unhandledRejection', e => console.log('Ошибка:', errText(e)));

main();
