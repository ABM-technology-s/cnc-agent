'use strict';
// Отправка данных станка на сервер
const https = require('https');
const http = require('http');
const { API_URL, SEND_INTERVAL, STALE_SEC } = require('./config');
const { sleep, errText } = require('./util');

function postJson(urlStr, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(payload);
    const isHttps = u.protocol === 'https:';
    const opts = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = (isHttps ? https : http).request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('таймаут 15с')));
    req.end(body);
  });
}

function camFresh(cam) {
  return !!(cam && cam.lastFrameAt && Date.now() - cam.lastFrameAt <= STALE_SEC * 1000);
}

function buildPayload(m) {
  const cam = m.cam, fresh = camFresh(cam);
  const d = m.cncData || {};
  const cncOk = !!m.cncIp && !!d.status && d.status !== 'ВЫКЛЮЧЕН';
  const p = {
    machineId: m.machineId,
    ts: new Date().toISOString(),
    ok: cncOk || fresh,
    people_count: fresh ? cam.people : null,
    person_in_zone: fresh ? cam.inZone : null,
    person_in_zone_raw: fresh ? cam.rawInZone : null,
    cnc_ip: m.cncIp,
    status: m.cncIp ? (d.status ?? null) : null,
    parts_done: d.parts_done ?? null,
    parts_plan: null,   // план не используется, поле оставлено для сервера
    alarms: d.alarms ?? null,
    messages: d.messages ?? null,
  };
  if (!p.ok) {
    const errs = [];
    if (m.cncIp) errs.push(`станок: ${d.status === 'ВЫКЛЮЧЕН' ? 'нет связи' : 'нет данных'}`);
    if (cam) errs.push('камера: ' + (cam.error || 'нет свежих данных'));
    p.error = errs.join('; ');
  }
  return p;
}

async function sendAllLoop(machines, isStopped) {
  await sleep(SEND_INTERVAL * 1000);   // дать собрать первые данные
  while (!isStopped()) {
    const t0 = Date.now();
    let line;
    try {
      const res = await postJson(API_URL, machines.map(m => buildPayload(m)));
      line = res.status >= 200 && res.status < 300
        ? `OK ${res.status}`
        : `ошибка HTTP ${res.status} ${res.text.slice(0, 100).replace(/\s+/g, ' ')}`;
    } catch (e) {
      line = 'ошибка ' + errText(e);
    }
    for (const m of machines) m.sendLine = line;
    await sleep(Math.max(200, SEND_INTERVAL * 1000 - (Date.now() - t0)));
  }
}

module.exports = { sendAllLoop, camFresh };
