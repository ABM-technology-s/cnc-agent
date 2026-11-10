'use strict';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hideRtsp = s => String(s).replace(/rtsp:\/\/\S+/g, 'rtsp://***');
const errText = e => hideRtsp((e && (e.message || e.code)) || e);
module.exports = { sleep, hideRtsp, errText };
