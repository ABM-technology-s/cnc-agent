'use strict';
const path = require('path');
const fs = require('fs');

const API_URL = 'https://check.bmgsales.com.ua/api/upload_machine_status';
const CNC_INTERVAL = 2;      // опрос станка, сек
const CAM_INTERVAL = 5;      // кадр с камеры, сек
const SEND_INTERVAL = 5;     // отправка на сервер, сек
const DEFAULT_PORT = 8193;   // порт FOCAS
const DWELL_SEC = 5;        // сколько секунд человек должен быть в зоне
const DWELL_GAP_SEC = 20;     // пропуск кадра не сбрасывает таймер
const STALE_SEC = 60;        // данные камеры старше — устаревшие
const FRAME_DIR = path.join(__dirname, 'debug');

function loadMachines() {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'machine-tools.json'), 'utf8'));
  const res = [];
  for (const e of list) {
    if (!e.cncIp && !e.rtsp) continue;   // ни станка, ни камеры
    res.push({
      machineId: String(e.machineId ?? ''),
      cncIp: e.cncIp || null,
      cncPort: +(e.cncPort || DEFAULT_PORT),
      driver: e.driver || 'fanuc',   // 'citizen' = через CNCnetPDM
      cnc: null,          // клиент FOCAS
      cncData: null,      // { status, parts_done, parts_plan, alarms }
      rtsp: e.rtsp || null,
      personZone: e.personZone,
      cam: e.rtsp ? {
        people: null, rawInZone: null, inZone: null, error: null,
        lastFrameAt: 0, lastSeenAt: 0, inZoneSince: null,
        dwellSec: e.presenceDwellSec ?? DWELL_SEC,
      } : null,
      sendLine: null,
    });
  }
  return res;
}

module.exports = {
  API_URL, CNC_INTERVAL, CAM_INTERVAL, SEND_INTERVAL,
  DWELL_GAP_SEC, STALE_SEC, FRAME_DIR, loadMachines,
};
