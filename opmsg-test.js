'use strict';
// Тест чтения сообщений оператора (экран MESSAGE) со стойки FANUC. Только чтение.
// Запуск: node opmsg-test.js [IP] [порт]   (по умолчанию cnc-1: 10.32.34.21 8193)
const { Fanuc } = require('./fanuc');

const ip = process.argv[2] || '10.32.34.21';
const port = +(process.argv[3] || 8193);
const dec = new TextDecoder('windows-1251');
const REC = 268; // int32 datano, int32 type, int32 char_num, char data[256]

function parse(data, len) {
  const out = [];
  for (let pos = 0; pos + 12 <= len; pos += REC) {
    const datano = data.readInt32BE(pos), type = data.readInt32BE(pos + 4), chars = data.readInt32BE(pos + 8);
    let txt = data.subarray(pos + 12, pos + 12 + Math.max(0, Math.min(chars, 256)));
    const z = txt.indexOf(0); if (z !== -1) txt = txt.subarray(0, z);
    out.push({ datano, type, chars, text: dec.decode(txt).trim() });
  }
  return out;
}

async function tryCmd(c, name, c3, v1, v2, v3) {
  try {
    const st = await c._req_rdsingle(1, 1, c3, v1, v2, v3);
    if (st.len > 0) {
      console.log(`${name}: длина ${st.len}`);
      for (const r of parse(st.data, st.len)) console.log('   ', JSON.stringify(r));
    } else if (st.error !== undefined) {
      console.log(`${name}: ошибка стойки ${st.error}`);
    } else {
      console.log(`${name}: пустой ответ (len ${st.len})`);
    }
  } catch (e) {
    console.log(`${name}: исключение ${e.message}`);
  }
}

(async () => {
  const c = new Fanuc(ip, port);
  if (!(await c.connect())) { console.log('нет связи с', ip); return; }
  console.log('подключено к', ip, c.sysinfo ? JSON.stringify(c.sysinfo) : '');
  for (const start of [0, 5, 10, 15]) await tryCmd(c, `rdopmsg3 0xD0 start=${start}`, 0xD0, start, -1, 5);
  await tryCmd(c, 'rdopmsg 0x34 type=0', 0x34, 0, 0, 0);
  await tryCmd(c, 'rdopmsg2 0x34 type=-1', 0x34, -1, 0, 0);
  try { await c.disconnect(); } catch (e) {}
})();