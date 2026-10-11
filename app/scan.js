// Network scan: find devices on the home network that serve RTSP video.
// 1. ONVIF discovery (asks go2rtc, which multicasts a WS-Discovery probe)
// 2. TCP sweep of the local /24 subnet(s) for camera-ish ports
// 3. For every RTSP server: try common stream paths and confirm one returns video
// Nothing is stored; the optional username/password is only used for the test.

"use strict";
const net = require("net");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

const RTSP_PORTS = [554, 8554, 10554, 5543, 7447, 8555,
  ...String(process.env.SCAN_EXTRA_RTSP_PORTS || "").split(",").map(Number).filter((n) => n > 0 && n < 65536)];
const OTHER_PORTS = {
  80: "web page", 8080: "web page", 88: "web page", 8000: "Hikvision/web",
  34567: "XMEye/iCSee app port", 8899: "ONVIF (cheap cams)", 6668: "Tuya/Smart Life", 8800: "V380 app port",
  37777: "Dahua app port", 9000: "Reolink app port", 5000: "web/ONVIF",
};

// {user}/{pass} are filled in for the few brands that put the login in the path.
const PATHS = [
  "/", "/live/ch00_0", "/live/ch00_1", "/onvif1", "/11", "/12",
  "/stream1", "/stream2", "/live0", "/live", "/h264Preview_01_main",
  "/Streaming/Channels/101", "/cam/realmonitor?channel=1&subtype=0",
  "/user={user}&password={pass}&channel=1&stream=0.sdp?real_stream",
  "/user={user}_password={pass}_channel=1_stream=0.sdp",
  "/ch0_0.h264", "/live.sdp", "/h264", "/av0_0", "/ucast/11", "/1", "/0",
  "/videoMain", "/media/video1", "/live/main", "/main", "/unicast",
  "/stream0", "/video1", "/mpeg4", "/profile1", "/live/ch0",
];

// ---------------------------------------------------------------- helpers
function localSubnets() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      if (/^172\.(1[7-9]|2\d|3[01])\./.test(a.address)) continue; // docker bridges
      const base = a.address.split(".").slice(0, 3).join(".");
      if (!out.some((s) => s.base === base)) out.push({ base, self: a.address });
    }
  }
  return out;
}

function parseRange(text) {
  // "192.168.0.0/24", "192.168.0.50", or "192.168.0.10-60"
  const t = String(text || "").trim();
  let m = t.match(/^(\d+\.\d+\.\d+)\.(\d+)(?:\/24)?$/);
  if (m && t.endsWith("/24")) return range(m[1], 1, 254);
  if (m) return [t];
  m = t.match(/^(\d+\.\d+\.\d+)\.(\d+)-(\d+)$/);
  if (m) return range(m[1], +m[2], Math.min(254, +m[3]));
  return null;
}
function range(base, a, b) { const r = []; for (let i = a; i <= b; i++) r.push(`${base}.${i}`); return r; }

function tcpOpen(host, port, timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  });
  await Promise.all(workers);
}

// One RTSP request on its own connection. Returns { status, headers, body }.
function rtsp(host, port, method, url, extraHeaders = {}, timeout = 3500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let buf = Buffer.alloc(0), settled = false;
    const finish = (r) => { if (settled) return; settled = true; s.destroy(); resolve(r); };
    s.setTimeout(timeout, () => finish(null));
    s.on("error", () => finish(null));
    s.on("connect", () => {
      let req = `${method} ${url} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: CamView\r\n`;
      if (method === "DESCRIBE") req += "Accept: application/sdp\r\n";
      for (const [k, v] of Object.entries(extraHeaders)) req += `${k}: ${v}\r\n`;
      s.write(req + "\r\n");
    });
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.slice(0, end).toString("latin1").split("\r\n");
      const status = +(head[0].match(/RTSP\/1\.\d\s+(\d+)/) || [])[1] || 0;
      const headers = {};
      for (const l of head.slice(1)) { const i = l.indexOf(":"); if (i > 0) { const k = l.slice(0, i).trim().toLowerCase(); headers[k] = headers[k] ? headers[k] + "\n" + l.slice(i + 1).trim() : l.slice(i + 1).trim(); } }
      const len = +(headers["content-length"] || 0);
      if (buf.length - end - 4 >= len) finish({ status, headers, body: buf.slice(end + 4, end + 4 + len).toString("latin1") });
    });
  });
}

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
function authHeader(wwwAuth, method, uri, user, pass) {
  // prefer Digest when offered
  const lines = String(wwwAuth || "").split("\n");
  const digest = lines.find((l) => /^digest/i.test(l));
  if (digest) {
    const p = {}; digest.replace(/(\w+)="?([^",]*)"?/g, (_, k, v) => (p[k.toLowerCase()] = v));
    const ha1 = md5(`${user}:${p.realm}:${pass}`), ha2 = md5(`${method}:${uri}`);
    if (p.qop && /auth/.test(p.qop)) {
      const nc = "00000001", cnonce = crypto.randomBytes(8).toString("hex");
      const resp = md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:auth:${ha2}`);
      return `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${resp}"` + (p.opaque ? `, opaque="${p.opaque}"` : "");
    }
    return `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", response="${md5(`${ha1}:${p.nonce}:${ha2}`)}"` + (p.opaque ? `, opaque="${p.opaque}"` : "");
  }
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function sdpInfo(sdp) {
  const v = sdp.match(/m=video[^\n]*\n(?:[^m][^\n]*\n)*/);
  if (!v) return null;
  const codec = (v[0].match(/a=rtpmap:\d+\s+([A-Za-z0-9]+)/) || [])[1] || "video";
  return codec.toUpperCase();
}

function httpTitle(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/", timeout: 2500, headers: { "User-Agent": "CamView" } }, (res) => {
      let s = ""; res.setEncoding("latin1");
      res.on("data", (d) => { if (s.length < 20000) s += d; });
      res.on("end", () => {
        const title = (s.match(/<title[^>]*>([^<]{1,80})/i) || [])[1]?.trim();
        const server = res.headers["server"];
        resolve([title, server].filter(Boolean).join(" · ") || (res.headers["www-authenticate"] ? "login page" : ""));
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.on("error", () => resolve(""));
  });
}

// Try paths until we find video. Stops early on repeated login rejections so
// we can't trip a camera's lockout.
async function probeRtsp(host, port, user, pass, log) {
  const result = { port, answered: false, server: "", works: [], needsLogin: false, loginRejected: false, tried: 0 };
  const opt = await rtsp(host, port, "OPTIONS", `rtsp://${host}:${port}/`);
  if (!opt || !opt.status) return result;
  result.answered = true;
  result.server = opt.headers.server || "";
  let rejections = 0;
  for (const tpl of PATHS) {
    if (result.works.length >= 2) break;
    if (/\{user\}/.test(tpl) && !user) continue;
    const path = tpl.replace("{user}", encodeURIComponent(user || "")).replace("{pass}", encodeURIComponent(pass || ""));
    const url = `rtsp://${host}:${port}${path}`;
    result.tried++;
    let r = await rtsp(host, port, "DESCRIBE", url);
    if (r && r.status === 401) {
      result.needsLogin = true;
      if (!user) continue;
      r = await rtsp(host, port, "DESCRIBE", url, { Authorization: authHeader(r.headers["www-authenticate"], "DESCRIBE", url, user, pass) });
      if (r && r.status === 401) {
        if (++rejections >= 2) { result.loginRejected = true; log(`${host}:${port} login rejected twice — stopping to avoid a lockout`); break; }
        continue;
      }
    }
    if (r && r.status === 200) {
      const codec = sdpInfo(r.body);
      if (codec) {
        const auth = user && result.needsLogin && !/\{user\}/.test(tpl) ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || "")}@` : "";
        const full = `rtsp://${auth}${host}:${port}${path}`;
        if (!result.works.some((w) => w.codec === codec && w.path === path)) result.works.push({ url: full, path, codec });
      }
    }
  }
  return result;
}

async function onvifDiscover(go2rtc) {
  try {
    const r = await fetch(new URL("/api/onvif", go2rtc), { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.sources || []).map((s) => ({ name: s.name, url: s.url }));
  } catch { return []; }
}

async function onvifProfiles(go2rtc, host, port, user, pass) {
  try {
    const src = `onvif://${encodeURIComponent(user || "")}:${encodeURIComponent(pass || "")}@${host}:${port}`;
    const r = await fetch(new URL("/api/onvif?src=" + encodeURIComponent(src), go2rtc), { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.sources || []).map((s) => s.url).filter((u) => /^rtsp/i.test(u));
  } catch { return []; }
}

// ---------------------------------------------------------------- the job
const state = { running: false, phase: "", progress: 0, total: 0, devices: [], log: [], subnets: [], startedAt: null, finishedAt: null };

function readArp() {
  try {
    const map = {};
    for (const l of require("fs").readFileSync("/proc/net/arp", "utf8").split("\n").slice(1)) {
      const f = l.trim().split(/\s+/);
      if (f.length >= 4 && f[3] !== "00:00:00:00:00:00") map[f[0]] = f[3].toUpperCase();
    }
    return map;
  } catch { return {}; }
}

async function runScan({ go2rtc, rangeText, user, pass, skip = [] }) {
  if (state.running) return;
  Object.assign(state, { running: true, phase: "Starting", progress: 0, total: 0, devices: [], log: [], startedAt: Date.now(), finishedAt: null });
  const log = (m) => { state.log.push(m); if (state.log.length > 60) state.log.shift(); };
  try {
    let hosts;
    if (rangeText) {
      hosts = parseRange(rangeText);
      if (!hosts) throw new Error("Range should look like 192.168.0.0/24, 192.168.0.50 or 192.168.0.10-60");
      state.subnets = [rangeText];
    } else {
      const subs = localSubnets();
      if (!subs.length) throw new Error("Couldn't work out the home network — enter a range instead");
      hosts = subs.flatMap((s) => range(s.base, 1, 254));
      state.subnets = subs.map((s) => s.base + ".0/24");
    }

    state.phase = "Asking cameras to announce themselves (ONVIF)";
    const onvifPromise = onvifDiscover(go2rtc);

    const ports = [...RTSP_PORTS, ...Object.keys(OTHER_PORTS).map(Number)];
    const jobs = hosts.flatMap((h) => ports.map((p) => [h, p]));
    const open = {};
    state.phase = `Checking ${hosts.length} addresses for camera ports`;
    state.total = jobs.length;
    await pool(jobs, 256, async ([h, p]) => {
      if (await tcpOpen(h, p)) (open[h] ||= []).push(p);
      state.progress++;
    });

    const onvif = await onvifPromise;
    const arp = readArp();
    for (const o of onvif) {
      const m = o.url.match(/@?([\d.]+)(?::(\d+))?/);
      if (m) (open[m[1]] ||= []);
    }

    const ips = Object.keys(open).filter((ip) => !skip.includes(ip))
      .sort((a, b) => a.split(".").map(Number).reduce((x, y) => x * 256 + y) - b.split(".").map(Number).reduce((x, y) => x * 256 + y));
    state.phase = `Testing ${ips.length} device(s) for video streams`;
    state.progress = 0; state.total = ips.length;

    await pool(ips, 6, async (ip) => {
      const portsOpen = (open[ip] || []).sort((a, b) => a - b);
      const dev = { ip, mac: arp[ip] || "", ports: portsOpen, hints: [], rtsp: [], onvif: null, web: "", verdict: "" };
      for (const p of portsOpen) if (OTHER_PORTS[p] && !/web/.test(OTHER_PORTS[p])) dev.hints.push(OTHER_PORTS[p]);
      const webPort = [80, 8080, 88, 8000, 5000].find((p) => portsOpen.includes(p));
      if (webPort) dev.web = await httpTitle(ip, webPort);

      const ov = onvif.find((o) => o.url.includes(`@${ip}`) || o.url.includes(`//${ip}`));
      if (ov) {
        const port = +(ov.url.match(/:(\d+)(?:\/|$)/) || [])[1] || 80;
        dev.onvif = { name: ov.name, port, profiles: await onvifProfiles(go2rtc, ip, port, user, pass) };
      }
      for (const p of portsOpen.filter((p) => RTSP_PORTS.includes(p))) {
        const r = await probeRtsp(ip, p, user, pass, log);
        if (r.answered) dev.rtsp.push(r);
      }

      const works = dev.rtsp.flatMap((r) => r.works);
      if (works.length) dev.verdict = "works";
      else if (dev.onvif?.profiles?.length) dev.verdict = "onvif";
      else if (dev.rtsp.some((r) => r.loginRejected)) dev.verdict = "badlogin";
      else if (dev.rtsp.some((r) => r.needsLogin)) dev.verdict = user ? "nopath" : "login";
      else if (dev.rtsp.length) dev.verdict = "nopath";
      else if (dev.onvif) dev.verdict = "onvif-login";
      else dev.verdict = "none";

      // only list things that look like cameras
      if (dev.rtsp.length || dev.onvif || dev.hints.length) state.devices.push(dev);
      state.progress++;
    });
    state.devices.sort((a, b) => ["works", "onvif", "login", "onvif-login", "badlogin", "nopath", "none"].indexOf(a.verdict) - ["works", "onvif", "login", "onvif-login", "badlogin", "nopath", "none"].indexOf(b.verdict));
    state.phase = `Done — ${state.devices.length} camera-like device(s)`;
  } catch (e) {
    state.phase = "Error: " + e.message;
  } finally {
    state.running = false; state.finishedAt = Date.now();
  }
}

module.exports = { runScan, scanState: state, _test: { probeRtsp, parseRange, authHeader } };
