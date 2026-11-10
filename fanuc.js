'use strict';
const net = require('net');

const FTYPE_OPN_REQU = 0x0101, FTYPE_OPN_RESP = 0x0102;
const FTYPE_VAR_REQU = 0x2101, FTYPE_VAR_RESP = 0x2102;
const FTYPE_CLS_REQU = 0x0201, FTYPE_CLS_RESP = 0x0202;
const FRAMEHEAD = Buffer.from([0xa0, 0xa0, 0xa0, 0xa0]);
const FRAME_DST = Buffer.from([0x00, 0x02]);

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; }

function encap(ftype, payload, fvers = 1) {
  if (ftype === FTYPE_VAR_REQU) {
    if (Array.isArray(payload)) {
      const pre = payload.map(t => Buffer.concat([u16(t.length + 2), t]));
      payload = Buffer.concat([u16(pre.length), ...pre]);
    } else {
      payload = Buffer.concat([u16(1), u16(payload.length + 2), payload]);
    }
  }
  const h = Buffer.alloc(6);
  h.writeUInt16BE(fvers, 0); h.writeUInt16BE(ftype, 2); h.writeUInt16BE(payload.length, 4);
  return Buffer.concat([FRAMEHEAD, h, payload]);
}

function decap(data) {
  if (data.length < 10) return { len: -1 };
  if (!data.subarray(0, 4).equals(FRAMEHEAD)) return { len: -1 };
  const fvers = data.readUInt16BE(4), ftype = data.readUInt16BE(6), len1 = data.readUInt16BE(8);
  if (len1 + 10 !== data.length) return { len: -1 };
  if (len1 === 0) return { len: 0, ftype, fvers, data: Buffer.from('0') };
  data = data.subarray(10);
  if (ftype === FTYPE_VAR_RESP) {
    const re = [];
    const qu = data.readUInt16BE(0);
    let n = 2;
    for (let t = 0; t < qu; t++) {
      const le = data.readUInt16BE(n);
      re.push(data.subarray(n + 2, n + le));
      n += le;
    }
    return { len: len1, ftype, fvers, data: re };
  }
  return { len: len1, ftype, fvers, data };
}

function rdsub(c1, c2, c3, v1 = 0, v2 = 0, v3 = 0, v4 = 0, v5 = 0) {
  const b = Buffer.alloc(26);
  b.writeUInt16BE(c1, 0); b.writeUInt16BE(c2, 2); b.writeUInt16BE(c3, 4);
  [v1, v2, v3, v4, v5].forEach((v, i) => b.writeInt32BE(v, 6 + i * 4));
  return b;
}

function decode8(val) {
  if (val.length < 8) throw new Error('short value');
  if (val[5] === 2 || val[5] === 10) {
    if (val[6] === 0xff && val[7] === 0xff) return null;
    return val.readInt32BE(0) / Math.pow(val[5], val[7]);
  }
  return null;
}

class Fanuc {
  constructor(ip, port = 8193) {
    this.ip = ip; this.port = port;
    this.sock = null; this.connected = false; this.sysinfo = null;
    this._buf = Buffer.alloc(0); this._waiter = null; this._err = null;
  }

  _onData(d) {
    this._buf = Buffer.concat([this._buf, d]);
    this._check();
  }

  _check() {
    if (!this._waiter) return;
    const b = this._buf;
    let take = 0;
    if (b.length >= 10 && b.subarray(0, 4).equals(FRAMEHEAD)) {
      const need = b.readUInt16BE(8) + 10;
      if (b.length >= need) take = need;
    } else if (b.length >= 4 && !b.subarray(0, 4).equals(FRAMEHEAD)) {
      take = b.length; // мусор - вернём как есть, decap даст len -1
    }
    if (take) {
      const pkt = b.subarray(0, take);
      this._buf = b.subarray(take);
      const w = this._waiter; this._waiter = null;
      clearTimeout(w.timer); w.resolve(pkt);
    } else if (this._err) {
      const w = this._waiter; this._waiter = null;
      clearTimeout(w.timer); w.reject(this._err);
    }
  }

  _recv(timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // поздний ответ сдвинул бы все следующие ответы: помечаем соединение сломанным и закрываем сокет
        this._waiter = null;
        const e = new Error('timeout');
        this._err = e;
        if (this.sock) this.sock.destroy();
        reject(e);
      }, timeoutMs);
      this._waiter = { resolve, reject, timer };
      this._check();
    });
  }

  _send(buf) {
    if (!this.sock || this.sock.destroyed) throw new Error('нет сокета');
    this.sock.write(buf);
  }

  async _xfer(buf) {
    if (this._err) throw this._err;   // соединение уже сломано - сразу ошибка, цикл переподключится
    this._buf = Buffer.alloc(0);      // протокол запрос-ответ: остатки прошлых ответов выбрасываем
    this._send(buf);
    return decap(await this._recv());
  }

  async connect() {
    this._buf = Buffer.alloc(0); this._err = null;
    await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.ip, port: this.port });
      const timer = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, 5000);
      s.once('connect', () => { clearTimeout(timer); s.setKeepAlive(true, 10000); resolve(); });
      s.once('error', e => { clearTimeout(timer); reject(e); });
      s.on('data', d => this._onData(d));
      s.on('error', e => { this._err = e; this._check(); });
      s.on('close', () => { this._err = this._err || new Error('closed'); this._check(); });
      this.sock = s;
    });
    const data = await this._xfer(encap(FTYPE_OPN_REQU, FRAME_DST));
    if (data.ftype === FTYPE_OPN_RESP) this.connected = true;
    await this.getsysinfo();
    return this.connected;
  }

  async disconnect() {
    try {
      if (this.connected) {
        const data = await this._xfer(encap(FTYPE_CLS_REQU, Buffer.alloc(0)));
        if (data.ftype === FTYPE_CLS_RESP) return true;
      }
      return false;
    } finally {
      this.connected = false;
      if (this.sock) this.sock.destroy();
      this.sock = null;
    }
  }

  async _req_rdsingle(c1, c2, c3, v1 = 0, v2 = 0, v3 = 0, v4 = 0, v5 = 0, pl = Buffer.alloc(0)) {
    const cmd = rdsub(c1, c2, c3).subarray(0, 6);
    const t = await this._xfer(encap(FTYPE_VAR_REQU, Buffer.concat([rdsub(c1, c2, c3, v1, v2, v3, v4, v5), pl])));
    if (t.len === 0) return { len: -1 };
    if (t.ftype !== FTYPE_VAR_RESP) return { len: -1 };
    const d = t.data[0];
    if (!d) throw new Error('пустой ответ');
    const ok = Buffer.concat([cmd, Buffer.alloc(6)]);
    if (d.length >= 12 && d.subarray(0, 12).equals(ok))
      return { len: d.readUInt16BE(12), data: d.subarray(14) };
    if (d.length >= 6 && d.subarray(0, 6).equals(cmd))
      return { len: 0, data: d.subarray(6), error: d.readInt16BE(6) };
    // ответ не на эту команду - рассинхрон, нужно переподключение
    if (!this._desyncLogged) {
      this._desyncLogged = true;
      console.log(`[fanuc ${this.ip}] desync: ждали ${cmd.toString('hex')}, пришло ${d.subarray(0, 6).toString('hex')}`);
    }
    throw new Error('desync');
  }

  async getsysinfo() {
    const st = await this._req_rdsingle(1, 1, 0x18);
    if (st.len === 0x12) {
      const d = st.data;
      this.sysinfo = {
        addinfo: d.readUInt16BE(0), maxaxis: d.readUInt16BE(2),
        cnctype: d.subarray(4, 6).toString('latin1'), mttype: d.subarray(6, 8).toString('latin1'),
        series: d.subarray(8, 12).toString('latin1'), version: d.subarray(12, 16).toString('latin1'),
        axes: d.subarray(16, 18).toString('latin1'),
      };
    }
  }

  async readStatus() {
    const st = await this._req_rdsingle(1, 1, 0x19, 0);
    let names = null;
    if (st.len === 0x12) names = ['hdck', 'tmmode', 'aut', 'run', 'motion', 'mstb', 'emergency', 'alarm', 'edit'];
    else if (st.len === 0x0e) names = ['aut', 'run', 'motion', 'mstb', 'emergency', 'alarm', 'edit'];
    if (!names) return null;
    const s = {};
    names.forEach((n, i) => { s[n] = st.data.readUInt16BE(i * 2); });
    return s;
  }

  async readmacro(first, last = 0) {
    if (last === 0) last = first;
    const st = await this._req_rdsingle(1, 1, 0x15, first, last);
    if (st.len <= 0) return null;
    const r = {};
    for (let pos = 0; pos < st.len; pos += 8) { r[first] = decode8(st.data.subarray(pos, pos + 8)); first++; }
    return r;
  }

  async readprognum() {
    const st = await this._req_rdsingle(1, 1, 0x1c);
    if (st.len < 8) return null;
    if (st.data.length !== 8) throw new Error('bad prognum');
    return { run: st.data.readInt32BE(0), main: st.data.readInt32BE(4) };
  }

  async readprogname() {
    const st = await this._req_rdsingle(1, 1, 0xb9);
    if (st.len >= 0) {
      let p = st.data; const z = p.indexOf(0);
      if (z >= 0) p = p.subarray(0, z);
      return new TextDecoder('utf-8', { fatal: true }).decode(p); // как p.decode()
    }
    return null;
  }

  async readalarmcode(type, withtext = 0, maxmsgs = -1, textlength = 32) {
    if (maxmsgs <= 0) {
      if (!this.sysinfo) throw new Error('нет sysinfo');
      maxmsgs = parseInt(this.sysinfo.axes.trim(), 10);
      if (isNaN(maxmsgs)) throw new Error('bad axes');
    }
    const st = await this._req_rdsingle(1, 1, 0x23, type, maxmsgs, withtext, textlength);
    if (st.len > 0) {
      const ret = [], d = st.data;
      for (let pos = 0; pos < st.len; pos += 16 + textlength) {
        const e = { alarmcode: d.readInt32BE(pos), alarmtype: d.readInt32BE(pos + 4), axis: d.readInt32BE(pos + 8) };
        const txlen = d.readInt32BE(pos + 12);
    if (txlen > 0 && withtext > 0) e.text = d.subarray(pos + 16, pos + 16 + Math.min(txlen, textlength));
        ret.push(e);
      }
      return ret;
    }
    return null;
  }

  // Сообщения оператора (экран MESSAGE): номер 2000-2999 и текст.
  // Запись 268 байт: int32 datano, int32 type, int32 char_num, char data[256]; datano -1 = пустой слот
  async readopmsg() {
    let st = await this._req_rdsingle(1, 1, 0xd0, 0, -1, 5);   // cnc_rdopmsg3: 5 слотов с начала
    if (!(st.len > 0)) st = await this._req_rdsingle(1, 1, 0x34, -1);   // запасной вариант cnc_rdopmsg2
    if (!(st.len > 0)) return null;
    const ret = [], d = st.data;
    for (let pos = 0; pos + 12 <= st.len; pos += 268) {
      const datano = d.readInt32BE(pos);
      if (datano === -1) continue;
      const chars = Math.max(0, Math.min(d.readInt32BE(pos + 8), 256));
      ret.push({ datano, type: d.readInt32BE(pos + 4), text: d.subarray(pos + 12, pos + 12 + chars) });
    }
    return ret;
  }
}

module.exports = { Fanuc, encap, decap, rdsub, decode8 };
