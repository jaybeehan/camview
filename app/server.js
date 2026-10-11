// CamView — a tiny live-view page for RTSP cameras and Eufy doorbells.
// No recording. go2rtc does the video work; this server only:
//   1. keeps the camera list (data/cameras.json) and mirrors it into go2rtc
//   2. serves the web page and proxies go2rtc through the same port
//   3. bridges Eufy P2P live streams (via eufy-security-ws) into go2rtc
// Zero npm dependencies (Node 22+: built-in fetch and WebSocket).

"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runScan, scanState } = require("./scan");
const auth = require("./auth");

const PORT = +(process.env.PORT || 8780);
const GO2RTC = new URL(process.env.GO2RTC_URL || "http://127.0.0.1:1984");
const EUFY_WS = process.env.EUFY_WS_URL || ""; // e.g. ws://127.0.0.1:3000 ; empty = Eufy off
const DATA_DIR = process.env.DATA_DIR || "/data";
const CAM_FILE = path.join(DATA_DIR, "cameras.json");
const PUBLIC = path.join(__dirname, "public");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- cameras
// camera = { id, name, type: "url" | "eufy", url?, serial?, autoplay }
let cameras = [];
try { cameras = JSON.parse(fs.readFileSync(CAM_FILE, "utf8")); } catch { cameras = []; }

function saveCameras() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CAM_FILE + ".tmp", JSON.stringify(cameras, null, 2));
  fs.renameSync(CAM_FILE + ".tmp", CAM_FILE);
}

function slug(name) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "cam";
  let id = base, n = 2;
  while (cameras.some((c) => c.id === id)) id = `${base}_${n++}`;
  return id;
}

// What go2rtc should pull for a camera.
function sourceFor(cam) {
  if (cam.type === "eufy") return `http://127.0.0.1:${PORT}/eufy/${encodeURIComponent(cam.serial)}`;
  return cam.url;
}

async function g2r(method, query) {
  const u = new URL("/api/streams?" + new URLSearchParams(query), GO2RTC);
  const r = await fetch(u, { method });
  if (!r.ok) throw new Error(`go2rtc ${method} ${r.status}`);
  return r;
}

// Make go2rtc's stream list match ours (only touches streams we own).
async function syncGo2rtc(removedIds = []) {
  try {
    const current = await (await g2r("GET", {})).json();
    for (const id of removedIds) if (current[id]) await g2r("DELETE", { src: id });
    for (const cam of cameras) {
      const want = sourceFor(cam);
      const have = current[cam.id]?.producers?.map((p) => p.url) || [];
      if (have.length === 1 && have[0] === want) continue;
      if (current[cam.id]) await g2r("DELETE", { src: cam.id });
      await g2r("PUT", { name: cam.id, src: want });
      log("go2rtc: set", cam.id);
    }
    return true;
  } catch (e) {
    log("go2rtc not reachable yet:", e.message);
    return false;
  }
}

// ---------------------------------------------------------------- Eufy control connection
// One long-lived connection used for: device list, login captcha / 2FA.
const eufy = { enabled: !!EUFY_WS, connected: false, loggedIn: false, devices: [], captcha: null, needCode: false, error: null, log: [] };

// Keep the bridge's recent log lines so the page can show why sign-in is stuck.
function eufyLog(level, text) {
  const line = `${new Date().toTimeString().slice(0, 8)} ${level ? level.toUpperCase() + " " : ""}${text}`.slice(0, 400);
  eufy.log.push(line);
  if (eufy.log.length > 40) eufy.log.splice(0, eufy.log.length - 40);
}
let ctl = null, ctlSeq = 0;
const ctlPending = new Map();

function ctlSend(command, extra = {}) {
  return new Promise((resolve, reject) => {
    if (!ctl || ctl.readyState !== 1) return reject(new Error("Eufy bridge not connected"));
    const messageId = "c" + ++ctlSeq;
    ctlPending.set(messageId, { resolve, reject });
    ctl.send(JSON.stringify({ messageId, command, ...extra }));
    setTimeout(() => { if (ctlPending.delete(messageId)) reject(new Error("timeout: " + command)); }, 30000);
  });
}

async function refreshEufyDevices(serials) {
  const list = [];
  for (const sn of serials) {
    try {
      const r = await ctlSend("device.get_properties", { serialNumber: sn });
      const p = r.properties || {};
      list.push({ serial: sn, name: p.name || sn, model: p.model || "" });
    } catch { list.push({ serial: sn, name: sn, model: "" }); }
  }
  eufy.devices = list;
  log(`eufy: ${list.length} device(s)`);
}

async function eufyStartListening() {
  const r = await ctlSend("start_listening");
  const st = r.state || {};
  const serials = (st.devices || []).map((d) => (typeof d === "string" ? d : d.serialNumber));
  // Eufy's newer ("mega") login can leave driver.connected false even though
  // sign-in worked, so having devices counts as signed in.
  eufy.loggedIn = !!st.driver?.connected || serials.length > 0;
  if (eufy.loggedIn) eufy.error = null;
  if (serials.length) await refreshEufyDevices(serials);
}

function connectEufyControl() {
  if (!EUFY_WS) return;
  let ws;
  try { ws = new WebSocket(EUFY_WS); } catch (e) { eufy.error = e.message; return setTimeout(connectEufyControl, 10000); }
  ctl = ws;
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "version") {
      eufy.connected = true; eufy.error = null;
      try {
        await ctlSend("set_api_schema", { schemaVersion: Math.min(21, m.maxSchemaVersion ?? 21) });
        await eufyStartListening();
        await ctlSend("driver.start_listening_logs").catch(() => {});
      } catch (e) { eufy.error = e.message; }
    } else if (m.type === "result") {
      const p = ctlPending.get(m.messageId); if (!p) return;
      ctlPending.delete(m.messageId);
      m.success ? p.resolve(m.result || {}) : p.reject(new Error(m.errorCode || "error"));
    } else if (m.type === "event") {
      const e = m.event || {};
      if (e.event === "captcha request") { eufy.captcha = { id: e.captchaId, image: e.captcha }; eufy.needCode = false; }
      else if (e.event === "verify code") { eufy.needCode = true; eufy.captcha = null; }
      else if (e.event === "connected") { eufy.loggedIn = true; eufy.captcha = null; eufy.needCode = false; eufyStartListening().catch(() => {}); }
      else if (e.event === "disconnected") { eufy.loggedIn = false; }
      else if (e.event === "device added" || e.event === "device removed") { eufyStartListening().catch(() => {}); }
      else if (e.event === "connection error") {
        const err = e.error || {};
        eufy.error = "Eufy sign-in failed: " + (err.message || err.name || JSON.stringify(err)).slice(0, 300);
        eufyLog("error", eufy.error);
      } else if (e.event === "logging") {
        const msg = e.message || {};
        const level = msg.meta?.logLevel || msg.logLevel || "";
        let text = msg.message ?? (Array.isArray(msg.argumentsArray) ? msg.argumentsArray.join(" ") : "");
        if (msg.arguments && Object.keys(msg.arguments).length) text += " " + JSON.stringify(msg.arguments);
        if (!/livestream|video data|audio data/i.test(text)) eufyLog(level, text);
      }
    }
  };
  // Node's WebSocket may fire only "error" (no "close") when the bridge isn't up
  // yet, so either event schedules exactly one reconnect.
  let retrying = false;
  const lost = () => {
    if (retrying) return; retrying = true;
    if (ctl === ws) ctl = null;
    eufy.connected = false; eufy.loggedIn = false;
    for (const p of ctlPending.values()) p.reject(new Error("closed"));
    ctlPending.clear();
    try { ws.close(); } catch {}
    setTimeout(connectEufyControl, 10000);
  };
  ws.onclose = lost;
  ws.onerror = () => { eufy.error = "Cannot reach Eufy bridge at " + EUFY_WS; lost(); };
}

// ---------------------------------------------------------------- Eufy live stream bridge
// go2rtc opens GET /eufy/<serial> only while someone is watching. We open a
// dedicated bridge connection, start the P2P live stream, and pass the raw
// H.264/H.265 video straight through. When go2rtc hangs up, we stop the
// stream (and the bridge also stops it when our connection closes), so a
// battery doorbell only streams while it is actually on screen.
function eufyStream(serial, req, res) {
  if (!EUFY_WS) { res.writeHead(503); return res.end("Eufy not configured"); }
  log("eufy: start live stream", serial);
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
  const ws = new WebSocket(EUFY_WS);
  let done = false, gotData = false, bytes = 0;
  const finish = (why) => {
    if (done) return; done = true;
    clearTimeout(watchdog);
    log(`eufy: end live stream ${serial} (${why}, ${(bytes / 1e6).toFixed(1)} MB)`);
    try { if (ws.readyState === 1) ws.send(JSON.stringify({ messageId: "stop", command: "device.stop_livestream", serialNumber: serial })); } catch {}
    setTimeout(() => { try { ws.close(); } catch {} }, 300);
    res.end();
  };
  const watchdog = setTimeout(() => { if (!gotData) finish("no video within 40 s"); }, 40000);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "version") {
      ws.send(JSON.stringify({ messageId: "schema", command: "set_api_schema", schemaVersion: Math.min(21, m.maxSchemaVersion ?? 21) }));
    } else if (m.type === "result") {
      if (m.messageId === "schema") ws.send(JSON.stringify({ messageId: "start", command: "device.start_livestream", serialNumber: serial }));
      else if (m.messageId === "start" && !m.success) finish("bridge refused: " + m.errorCode);
    } else if (m.type === "event" && m.event?.serialNumber === serial) {
      const e = m.event;
      if (e.event === "livestream video data") {
        const chunk = Buffer.from(e.buffer?.data || e.buffer || []);
        if (!gotData) log(`eufy: video ${e.metadata?.videoCodec} ${e.metadata?.videoWidth}x${e.metadata?.videoHeight}`);
        gotData = true; bytes += chunk.length;
        res.write(chunk);
      } else if (e.event === "livestream stopped") finish("doorbell ended stream");
    }
  };
  ws.onclose = () => finish("bridge closed");
  ws.onerror = () => finish("bridge error");
  res.on("close", () => finish("viewer left"));
}

// ---------------------------------------------------------------- go2rtc reverse proxy (/go2rtc/...)
function proxyHttp(req, res, subpath) {
  const opts = { host: GO2RTC.hostname, port: GO2RTC.port || 80, path: subpath, method: req.method, headers: { ...req.headers, host: GO2RTC.host } };
  const p = http.request(opts, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
  p.on("error", () => { res.writeHead(502); res.end("go2rtc not reachable"); });
  req.pipe(p);
}

function proxyUpgrade(req, socket, head) {
  const subpath = req.url.replace(/^\/go2rtc/, "") || "/";
  const up = net.connect(+(GO2RTC.port || 80), GO2RTC.hostname, () => {
    const headers = { ...req.headers, host: GO2RTC.host };
    delete headers.origin; // go2rtc checks Origin against its own host
    let raw = `${req.method} ${subpath} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
    up.write(raw + "\r\n"); if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
}

// ---------------------------------------------------------------- HTTP server
function readJson(req) {
  return new Promise((resolve) => {
    let s = ""; req.on("data", (d) => (s += d));
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } });
  });
}
function readRaw(req) {
  return new Promise((resolve) => { let s = ""; req.on("data", (d) => { if (s.length < 10000) s += d; }); req.on("end", () => resolve(s)); });
}
const isLoopback = (req) => /^(::ffff:)?127\.|^::1$/.test(req.socket.remoteAddress || "");
function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }

function validate(b) {
  const name = String(b.name || "").trim();
  if (!name) return "Name is required";
  if (b.type === "eufy") { if (!b.serial) return "Pick a Eufy device"; }
  else if (!/^(rtsp|rtsps|rtmp|http|https|onvif|ffmpeg):/i.test(String(b.url || "").trim())) return "URL should start with rtsp:// (or http://, onvif://)";
  return null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  try {
    // Only go2rtc (on this NAS) may open a doorbell stream.
    if (p.startsWith("/eufy/")) {
      if (!isLoopback(req)) { res.writeHead(403); return res.end("forbidden"); }
      return eufyStream(decodeURIComponent(p.slice(6)), req, res);
    }
    if (p === "/login") return auth.handleLogin(req, res, DATA_DIR, readRaw);
    if (p === "/logout") return auth.handleLogout(req, res);
    if (!auth.isSignedIn(req, DATA_DIR)) {
      if (req.method === "GET" && (p === "/" || p === "/index.html")) { res.writeHead(302, { Location: "login" }); return res.end(); }
      return json(res, 401, { error: "Not signed in" });
    }
    if (p === "/api/me") return json(res, 200, { auth: auth.authEnabled });
    if (p === "/go2rtc") { res.writeHead(302, { Location: "go2rtc/" }); return res.end(); }
    if (p.startsWith("/go2rtc/")) return proxyHttp(req, res, req.url.slice(7));

    if (p === "/api/cameras" && req.method === "GET") return json(res, 200, cameras);
    if (p === "/api/cameras" && req.method === "POST") {
      const b = await readJson(req); const err = validate(b);
      if (err) return json(res, 400, { error: err });
      const cam = { id: slug(b.name), name: String(b.name).trim(), type: b.type === "eufy" ? "eufy" : "url", autoplay: b.autoplay !== false };
      if (cam.type === "eufy") cam.serial = String(b.serial); else cam.url = String(b.url).trim();
      cameras.push(cam); saveCameras(); await syncGo2rtc();
      return json(res, 200, cam);
    }
    if (p === "/api/cameras/order" && req.method === "POST") {
      const { ids } = await readJson(req);
      if (Array.isArray(ids)) { cameras.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); saveCameras(); }
      return json(res, 200, cameras);
    }
    const m = p.match(/^\/api\/cameras\/([^/]+)$/);
    if (m) {
      const i = cameras.findIndex((c) => c.id === m[1]);
      if (i < 0) return json(res, 404, { error: "not found" });
      if (req.method === "DELETE") { const [gone] = cameras.splice(i, 1); saveCameras(); await syncGo2rtc([gone.id]); return json(res, 200, {}); }
      if (req.method === "PUT") {
        const b = { ...cameras[i], ...(await readJson(req)) }; const err = validate(b);
        if (err) return json(res, 400, { error: err });
        const cam = cameras[i];
        cam.name = String(b.name).trim(); cam.autoplay = b.autoplay !== false;
        if (cam.type === "eufy") cam.serial = String(b.serial); else cam.url = String(b.url).trim();
        saveCameras(); await syncGo2rtc();
        return json(res, 200, cam);
      }
    }

    if (p === "/api/scan" && req.method === "GET") return json(res, 200, scanState);
    if (p === "/api/scan" && req.method === "POST") {
      const b = await readJson(req);
      if (scanState.running) return json(res, 409, { error: "A scan is already running" });
      const self = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4").map((a) => a.address);
      runScan({ go2rtc: GO2RTC, rangeText: b.range, user: b.user || "", pass: b.pass || "", skip: b.range ? [] : self });
      return json(res, 200, {});
    }

    if (p === "/api/eufy" && req.method === "GET") return json(res, 200, eufy);
    if (p === "/api/eufy/captcha" && req.method === "POST") {
      const b = await readJson(req);
      await ctlSend("driver.set_captcha", { captchaId: eufy.captcha?.id, captcha: String(b.code || "") });
      eufy.captcha = null; return json(res, 200, {});
    }
    if (p === "/api/eufy/retry" && req.method === "POST") {
      eufy.error = null; eufyLog("", "Retrying sign-in…");
      ctlSend("driver.connect").catch((e) => { eufy.error = e.message; });
      return json(res, 200, {});
    }
    if (p === "/api/eufy/verify" && req.method === "POST") {
      const b = await readJson(req);
      await ctlSend("driver.set_verify_code", { verifyCode: String(b.code || "") });
      eufy.needCode = false; return json(res, 200, {});
    }

    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return fs.createReadStream(path.join(PUBLIC, "index.html")).pipe(res);
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.on("upgrade", (req, socket, head) => {
  if (!auth.isSignedIn(req, DATA_DIR)) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
  if (req.url.startsWith("/go2rtc/")) proxyUpgrade(req, socket, head);
  else socket.destroy();
});

server.listen(PORT, () => {
  if (!auth.authEnabled) log("No CAMVIEW_PASSWORD set — the page is open to anyone on the network");
  log(`CamView on http://0.0.0.0:${PORT}  (go2rtc ${GO2RTC.origin}, eufy ${EUFY_WS || "off"})`);
  // go2rtc may start after us; keep its stream list in step.
  syncGo2rtc();
  setInterval(syncGo2rtc, 60000);
  connectEufyControl();
  setInterval(() => { if (eufy.connected && !eufy.loggedIn) eufyStartListening().catch(() => {}); }, 30000);
});

// Exit promptly when Docker / Container Manager stops the container.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { log(`${sig} received, shutting down`); process.exit(0); });
