'use strict';
// Опрос станка FANUC: статус, детали, аварии
const { Fanuc } = require('./fanuc');
const { CNC_INTERVAL } = require('./config');
const { sleep, errText } = require('./util');

const WATCHDOG_MS = 120000;   // нет удачного чтения статуса дольше - принудительное переподключение
const POLL_TIMEOUT_MS = 15000;   // один опрос дольше - принудительное переподключение
// ошибки связи пробрасываем наверх (переподключение), остальные = функция не поддерживается
const FATAL = /timeout|desync|closed|ECONN|EPIPE|нет сокета/i;
const isFatal = e => FATAL.test(String((e && (e.message || e.code)) || e));
const OFF = () => ({ status: 'ВЫКЛЮЧЕН', parts_done: null, alarms: null, messages: null });

const dec = new TextDecoder('windows-1251');   // стойка отдаёт текст в 1251

// Текст аварии: обрезать по первому нулевому байту, перевести из 1251, убрать пробелы
function decodeText(buf) {
  if (!buf) return '';
  const zero = buf.indexOf(0);
  if (zero !== -1) buf = buf.subarray(0, zero);
  return dec.decode(buf).trim();
}

function decide(s) {
  if (s === null) return null;
  if (s.emergency === 1 || s.alarm === 1) return 'АВАРИЯ';
  if ((s.aut === 1 || s.aut === 10) && s.run === 3) return 'РАБОТАЕТ';
  if ([0, 3, 4, 5, 6, 7, 8, 9].includes(s.aut)) return 'НАЛАДКА';
  return 'СТОИТ';
}

async function macro(c, num) {
  try {
    const m = await c.readmacro(num);
    const v = m ? m[num] : null;
    return v == null ? null : Math.trunc(v);
  } catch (e) { if (isFatal(e)) throw e; return null; }
}

async function readAlarms(c) {
  try {
    const list = (await c.readalarmcode(-1, 1)) || [];
    return list.filter(x => x.alarmcode).map(x => ({ number: x.alarmcode, text: decodeText(x.text) }));
  } catch (e) { if (isFatal(e)) throw e; return []; }
}

async function readMessages(c) {
  try {
    const list = (await c.readopmsg()) || [];
    return list.map(x => ({ number: x.datano, text: decodeText(x.text) }));
  } catch (e) { if (isFatal(e)) throw e; return []; }
}

// Сбросить соединение (сторож или таймаут опроса); старый опрос, если ещё идёт, увидит m.cnc !== c и выйдет молча
function dropConn(m, reason) {
  const c = m.cnc;
  m.cnc = null;
  try { if (c && c.sock) c.sock.destroy(); } catch (e) {}
  m.reconnects = (m.reconnects || 0) + 1;
  m.failReason = reason;
  m.cncData = OFF();
  console.log(`[${m.machineId}] переподключение: ${reason}`);
}

async function readCnc(m) {
  let c = m.cnc;
  try {
    if (c === null) {
      c = m.cnc = new Fanuc(m.cncIp, m.cncPort);
      if (!(await c.connect())) throw new Error('нет связи');
    }
    const st = await c.readStatus();
    if (st === null) throw new Error('no status');
    if (m.cnc === c) m.lastOkAt = Date.now();
    const data = {
      status: decide(st),
      parts_done: await macro(c, 3901),
      alarms: await readAlarms(c),
      messages: await readMessages(c),
    };
    if (m.cnc !== c) return;   // соединение уже сброшено сторожем
    m.cncData = data;
    m.failReason = null;
  } catch (e) {
    const wasConnected = !!(c && c.connected);
    try { if (c) await c.disconnect(); } catch (e2) {}
    if (m.cnc !== c) return;
    m.cnc = null;
    m.cncData = OFF();
    if (wasConnected) m.reconnects = (m.reconnects || 0) + 1;
    const reason = errText(e);
    if (reason !== m.failReason) {   // одна строка на событие, без спама пока станок выключен
      console.log(`[${m.machineId}] переподключение: ${reason}`);
      m.failReason = reason;
    }
  }
}

// Свой цикл на каждый станок, медленный не тормозит остальные
async function cncLoop(m, isStopped) {
  let watchFrom = Date.now();
  while (!isStopped()) {
    const t0 = Date.now();
    let timer;
    const done = await Promise.race([
      readCnc(m).then(() => true, () => true),
      new Promise(r => { timer = setTimeout(() => r(false), POLL_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (!done) dropConn(m, `опрос дольше ${POLL_TIMEOUT_MS / 1000} с`);
    // сторож: соединение есть, а удачного чтения статуса давно нет
    const since = Math.max(m.lastOkAt || 0, watchFrom);
    if (m.cnc && m.cnc.connected && Date.now() - since > WATCHDOG_MS) {
      const sec = Math.round((Date.now() - since) / 1000);
      console.log(`[${m.machineId}] watchdog: нет данных ${sec}s, переподключение`);
      dropConn(m, 'watchdog');
      watchFrom = Date.now();
    }
    await sleep(Math.max(200, CNC_INTERVAL * 1000 - (Date.now() - t0)));
  }
}

module.exports = { cncLoop, decide };
