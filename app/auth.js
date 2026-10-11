// Optional password for the whole CamView page (set CAMVIEW_PASSWORD).
// Sign-in sets a signed cookie that lasts 90 days. The signature includes the
// password, so changing the password signs everyone out.

"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PASSWORD = process.env.CAMVIEW_PASSWORD || "";
const COOKIE = "camview_session";
const MAX_AGE_S = 90 * 24 * 3600;

let secret;
function getSecret(dataDir) {
  if (secret) return secret;
  const f = path.join(dataDir, ".camview-secret");
  try { secret = fs.readFileSync(f, "utf8").trim(); } catch {}
  if (!secret || secret.length < 32) {
    secret = crypto.randomBytes(32).toString("hex");
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f, secret, { mode: 0o600 }); } catch {}
  }
  return secret;
}

const sign = (dataDir, exp) => crypto.createHmac("sha256", getSecret(dataDir)).update(`${exp}|${PASSWORD}`).digest("base64url");

function makeToken(dataDir) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  return `${exp}.${sign(dataDir, exp)}`;
}

function cookieValue(req) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
}

function isSignedIn(req, dataDir) {
  if (!PASSWORD) return true;
  const [exp, sig] = cookieValue(req).split(".");
  if (!exp || !sig || +exp < Date.now() / 1000) return false;
  const want = Buffer.from(sign(dataDir, exp)), got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function passwordMatches(pw) {
  const a = crypto.createHash("sha256").update(String(pw)).digest();
  const b = crypto.createHash("sha256").update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Slow down guessing: after 5 wrong tries from one address, wait 30 s per try.
const failures = new Map(); // ip -> { count, until }
function tooSoon(ip) { const f = failures.get(ip); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
function noteFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count++; if (f.count >= 5) f.until = Date.now() + 30000;
  failures.set(ip, f);
}

const setCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

function loginPage(msg = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CamView · Sign in</title>
<style>
  html,body{margin:0;height:100%;background:#0e1013;color:#e7e9ec;font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  body{display:grid;place-items:center;padding:16px;box-sizing:border-box}
  form{background:#171a1f;border:1px solid #262a31;border-radius:12px;padding:22px;width:min(340px,100%);box-sizing:border-box}
  h1{font-size:18px;margin:0 0 14px}
  input{width:100%;box-sizing:border-box;font:inherit;color:inherit;background:#0e1013;border:1px solid #262a31;border-radius:8px;padding:10px 12px}
  button{margin-top:12px;width:100%;font:inherit;font-weight:600;background:#4fa3ff;color:#06121f;border:0;border-radius:8px;padding:10px;cursor:pointer}
  .msg{color:#ff5d5d;min-height:20px;margin-top:10px;font-size:13px}
</style></head><body>
<form method="post" action="login">
  <h1>CamView</h1>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button>Sign in</button>
  <div class="msg">${msg.replace(/[<>&]/g, "")}</div>
</form></body></html>`;
}

async function handleLogin(req, res, dataDir, readBody) {
  const ip = req.socket.remoteAddress || "";
  const html = (code, body, headers = {}) => { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers }); res.end(body); };
  if (req.method === "GET") return html(200, loginPage());
  const wait = tooSoon(ip);
  if (wait) return html(429, loginPage(`Too many tries — wait ${wait} s and try again.`));
  const body = await readBody(req);
  const pw = new URLSearchParams(body).get("password") ?? "";
  if (!passwordMatches(pw)) { noteFailure(ip); return html(401, loginPage("Wrong password.")); }
  failures.delete(ip);
  res.writeHead(303, { Location: "./", "Set-Cookie": setCookie(makeToken(dataDir), MAX_AGE_S), "Cache-Control": "no-store" });
  res.end();
}

function handleLogout(req, res) {
  res.writeHead(303, { Location: "login", "Set-Cookie": setCookie("", 0), "Cache-Control": "no-store" });
  res.end();
}

module.exports = { authEnabled: !!PASSWORD, isSignedIn, handleLogin, handleLogout };
