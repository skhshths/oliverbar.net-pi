"use strict";

// Self-hosted chat/DM backend for oliverbar.net.
//
// This is the "hybrid" half: the write-heavy chat subsystem (global chat,
// DMs, presence, accounts, blocks) lives here on the Pi in SQLite — no daily
// write quota, unlike Cloudflare KV. The lightweight site config, pages, and
// games stay on the Cloudflare Worker. The frontend points its chat calls at
// this server (via the tunnel, https://piapi.oliverbar.net) and everything
// else at the Worker.
//
// Routes and data shapes mirror the Worker's chat routes exactly, so the
// frontend needs only its base URL changed, not its logic.

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const express = require("express");
const Database = require("better-sqlite3");
const multer = require("multer");
const https = require("https");

// Load KEY=value lines from a .env next to this file (without overriding
// anything systemd already set), so secrets can live in ~/misc/pi-api/.env.
(function loadDotEnv() {
  try {
    fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) return;
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    });
  } catch (e) { /* no .env — fine */ }
})();

// ---------- config ----------
const PORT = Number(process.env.PORT || 8081);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "chat.db");
const EDIT_PASSWORD = process.env.EDIT_PASSWORD || "asdfasdfasdf"; // admin key; override in .env
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
// Uploaded files land in their own folder on disk (not in the database).
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 15 * 1024 * 1024); // 15 MB
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Personal-area files live in their own private folder, separate from chat
// attachments, and are only ever served with the admin key.
const MY_UPLOADS_DIR = process.env.MY_UPLOADS_DIR || path.join(__dirname, "myfiles");
const MAX_MYFILE_BYTES = Number(process.env.MAX_MYFILE_BYTES || 100 * 1024 * 1024); // 100 MB
fs.mkdirSync(MY_UPLOADS_DIR, { recursive: true });

const MAX_CHAT_MESSAGES = 200;
const MAX_DM_MESSAGES = 300;
const MAX_NAME_LENGTH = 24;
const MAX_MESSAGE_LENGTH = 500;
const MIN_PIN_LENGTH = 3;
const MAX_PIN_LENGTH = 32;
const MAX_STATUS_LENGTH = 40;
const MAX_AVATAR_LENGTH = 4;
const MAX_EMOJI_LENGTH = 8;
const MAX_GROUP_PARTICIPANTS = 12;
const PBKDF2_ITERATIONS = 100000;
const ONLINE_WINDOW_MS = 300 * 1000;
const CHAT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- crypto helpers (same scheme as the Worker) ----------
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}
function hashPin(pin, saltHex) {
  return crypto
    .pbkdf2Sync(pin, Buffer.from(saltHex, "hex"), PBKDF2_ITERATIONS, 32, "sha256")
    .toString("hex");
}
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------- database ----------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    name_key TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
    created INTEGER NOT NULL, avatar TEXT DEFAULT '', status TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS blocks (
    owner_key TEXT NOT NULL, blocked_key TEXT NOT NULL, PRIMARY KEY (owner_key, blocked_key)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS last_seen (
    name_key TEXT PRIMARY KEY, ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS global_messages (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, text TEXT, ts INTEGER NOT NULL,
    deleted INTEGER DEFAULT 0, edited INTEGER DEFAULT 0, reply_json TEXT, reactions_json TEXT DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS pinned (
    id TEXT PRIMARY KEY, name TEXT, text TEXT, ts INTEGER, pinned_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, participants_json TEXT NOT NULL, set_key TEXT NOT NULL, created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, from_name TEXT NOT NULL, text TEXT, ts INTEGER NOT NULL,
    deleted INTEGER DEFAULT 0, edited INTEGER DEFAULT 0, reply_json TEXT, reactions_json TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_dm_conv ON dm_messages (conv_id, ts);
  CREATE TABLE IF NOT EXISTS threads (
    owner_key TEXT NOT NULL, conv_id TEXT NOT NULL, participants_json TEXT NOT NULL,
    last_ts INTEGER, last_text TEXT, last_from TEXT, PRIMARY KEY (owner_key, conv_id)
  );
  CREATE TABLE IF NOT EXISTS dm_locks (
    conv_id TEXT NOT NULL, owner_key TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
    PRIMARY KEY (conv_id, owner_key)
  );
  CREATE TABLE IF NOT EXISTS dm_reads (
    conv_id TEXT NOT NULL, owner_key TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (conv_id, owner_key)
  );
  CREATE TABLE IF NOT EXISTS stats (
    field TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER,
    filename TEXT NOT NULL, uploader TEXT, created INTEGER NOT NULL
  );
  -- ---- personal area (admin-only): notes, cross-device clipboard, private files ----
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, title TEXT DEFAULT '', body TEXT DEFAULT '',
    created INTEGER NOT NULL, updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS myfiles (
    id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER,
    filename TEXT NOT NULL, created INTEGER NOT NULL
  );
`);

// Add the attachment column to existing message tables if it isn't there yet
// (so upgrading an already-populated DB doesn't need a wipe).
function ensureColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
ensureColumn("global_messages", "attachment_json", "TEXT");
ensureColumn("dm_messages", "attachment_json", "TEXT");

function bumpStat(field) {
  db.prepare(
    "INSERT INTO stats (field, value) VALUES (?, 1) ON CONFLICT(field) DO UPDATE SET value = value + 1"
  ).run(field);
}
function getStat(field) {
  const row = db.prepare("SELECT value FROM stats WHERE field = ?").get(field);
  return row ? row.value : 0;
}

// ---------- account / session helpers ----------
function getAccount(name) {
  return db.prepare("SELECT * FROM accounts WHERE name_key = ?").get(name.toLowerCase());
}
function claimOrVerifyName(rawName, pin) {
  const key = rawName.toLowerCase();
  const rec = getAccount(rawName);
  if (rec) {
    if (!timingSafeEqual(hashPin(pin, rec.salt), rec.hash)) {
      return { ok: false, error: "That name is already claimed — wrong PIN." };
    }
    return { ok: true, name: rec.name };
  }
  const salt = randomHex(16);
  db.prepare(
    "INSERT INTO accounts (name_key, name, salt, hash, created, avatar, status) VALUES (?,?,?,?,?,'','')"
  ).run(key, rawName, salt, hashPin(pin, salt), Date.now());
  return { ok: true, name: rawName, claimed: true };
}
function sessionName(req) {
  const token = req.get("X-Chat-Session") || "";
  if (!token) return null;
  const row = db.prepare("SELECT name, created FROM sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (Date.now() - row.created > CHAT_SESSION_TTL_MS) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return row.name;
}
function isBlocked(ownerName, otherName) {
  const row = db
    .prepare("SELECT 1 FROM blocks WHERE owner_key = ? AND blocked_key = ?")
    .get(ownerName.toLowerCase(), otherName.toLowerCase());
  return !!row;
}
function canonical(name) {
  const rec = getAccount(name);
  return rec ? rec.name : name;
}
function participantSetKey(names) {
  if (!Array.isArray(names)) return "";
  return names.map((n) => n.toLowerCase()).sort().join(",");
}
function touchLastSeen(name) {
  db.prepare(
    "INSERT INTO last_seen (name_key, ts) VALUES (?, ?) ON CONFLICT(name_key) DO UPDATE SET ts = excluded.ts"
  ).run(name.toLowerCase(), Date.now());
}

// ---------- message (de)serialization ----------
function globalRowToMsg(r) {
  const m = { id: r.id, name: r.name, ts: r.ts, reactions: JSON.parse(r.reactions_json || "{}") };
  if (r.deleted) { m.text = null; m.deleted = true; } else { m.text = r.text; }
  if (r.edited) m.edited = true;
  if (r.reply_json) m.replyTo = JSON.parse(r.reply_json);
  if (!r.deleted && r.attachment_json) m.attachment = JSON.parse(r.attachment_json);
  return m;
}
function dmRowToMsg(r) {
  const m = { id: r.id, from: r.from_name, ts: r.ts, reactions: JSON.parse(r.reactions_json || "{}") };
  if (r.deleted) { m.text = null; m.deleted = true; } else { m.text = r.text; }
  if (r.edited) m.edited = true;
  if (r.reply_json) m.replyTo = JSON.parse(r.reply_json);
  if (!r.deleted && r.attachment_json) m.attachment = JSON.parse(r.attachment_json);
  return m;
}

// Pulls a validated attachment descriptor from a send request body, or null.
// The client uploads first (/api/upload), then sends the returned fileId.
function resolveAttachment(body) {
  const fileId = body && typeof body.attachment === "object" && body.attachment
    ? body.attachment.fileId : (typeof body.fileId === "string" ? body.fileId : "");
  if (!fileId || typeof fileId !== "string") return null;
  const row = db.prepare("SELECT id, name, type, size FROM files WHERE id = ?").get(fileId);
  if (!row) return null;
  return { fileId: row.id, name: row.name, type: row.type, size: row.size };
}
function upsertThread(ownerName, conversation, message) {
  db.prepare(
    `INSERT INTO threads (owner_key, conv_id, participants_json, last_ts, last_text, last_from)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(owner_key, conv_id) DO UPDATE SET
       participants_json = excluded.participants_json,
       last_ts = excluded.last_ts, last_text = excluded.last_text, last_from = excluded.last_from`
  ).run(
    ownerName.toLowerCase(), conversation.id, JSON.stringify(conversation.participants),
    message.ts, message.deleted ? null : message.text, message.from
  );
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Edit-Key, X-Chat-Session, X-Ultra-Admin");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

function requireSession(req, res) {
  const name = sessionName(req);
  if (!name) { res.status(401).json({ error: "Not logged in" }); return null; }
  return name;
}
function requireAdmin(req, res) {
  if (!timingSafeEqual(req.get("X-Edit-Key") || "", EDIT_PASSWORD)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- file uploads (stored on disk in UPLOADS_DIR, not the DB) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || "") || "").slice(0, 16).replace(/[^.\w]/g, "");
      cb(null, randomHex(16) + ext);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

app.post("/api/upload", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  upload.single("file")(req, res, (err) => {
    if (err) {
      const msg = err.code === "LIMIT_FILE_SIZE"
        ? `File too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB)`
        : "Upload failed";
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: "No file" });
    const id = randomHex(12);
    const original = (req.file.originalname || "file").slice(0, 200);
    const type = (req.file.mimetype || "application/octet-stream").slice(0, 100);
    db.prepare(
      "INSERT INTO files (id, name, type, size, filename, uploader, created) VALUES (?,?,?,?,?,?,?)"
    ).run(id, original, type, req.file.size, req.file.filename, name, Date.now());
    res.json({ fileId: id, name: original, type, size: req.file.size });
  });
});

// Capability-URL download: the id is unguessable, so the URL itself is the
// access token — which is what lets an <img src> load it without a session
// header. Images/video/pdf render inline; everything else downloads.
app.get("/api/file/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const full = path.join(UPLOADS_DIR, row.filename);
  if (!fs.existsSync(full)) return res.status(404).json({ error: "Not found" });
  const inlineOk = /^(image|video|audio)\//.test(row.type) || row.type === "application/pdf";
  res.set("Content-Type", row.type || "application/octet-stream");
  res.set("Content-Disposition",
    (inlineOk ? "inline" : "attachment") + '; filename="' + row.name.replace(/[^\w.\- ]/g, "_") + '"');
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(full).pipe(res);
});

// ---------- auth / accounts ----------
app.post("/api/chat/login", (req, res) => {
  const rawName = typeof req.body.name === "string" ? req.body.name.trim().slice(0, MAX_NAME_LENGTH) : "";
  const pin = typeof req.body.pin === "string" ? req.body.pin : "";
  if (!rawName) return res.status(400).json({ error: "name is required" });
  if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
    return res.status(400).json({ error: `PIN must be ${MIN_PIN_LENGTH}-${MAX_PIN_LENGTH} characters` });
  }
  const result = claimOrVerifyName(rawName, pin);
  if (!result.ok) return res.status(401).json({ error: result.error });
  if (result.claimed) bumpStat("totalAccountsCreated");
  const token = crypto.randomUUID();
  db.prepare("INSERT INTO sessions (token, name, created) VALUES (?,?,?)").run(token, result.name, Date.now());
  touchLastSeen(result.name);
  res.json({ token, name: result.name });
});

app.get("/api/chat/session", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  res.json({ name });
});

app.get("/api/chat/profile", (req, res) => {
  if (!requireSession(req, res)) return;
  const requested = String(req.query.names || "").split(",").map((n) => n.trim()).filter(Boolean);
  if (!requested.length) return res.status(400).json({ error: "names is required" });
  const result = {};
  requested.forEach((n) => {
    const rec = getAccount(n);
    result[n] = rec ? { name: rec.name, avatar: rec.avatar || "", status: rec.status || "" } : null;
  });
  res.json(result);
});

app.post("/api/chat/profile", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const avatar = typeof req.body.avatar === "string" ? req.body.avatar.trim().slice(0, MAX_AVATAR_LENGTH) : "";
  const status = typeof req.body.status === "string" ? req.body.status.trim().slice(0, MAX_STATUS_LENGTH) : "";
  const info = db.prepare("UPDATE accounts SET avatar = ?, status = ? WHERE name_key = ?").run(avatar, status, name.toLowerCase());
  if (!info.changes) return res.status(404).json({ error: "Account not found" });
  res.json({ ok: true, avatar, status });
});

app.post("/api/chat/change-pin", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const newPin = typeof req.body.newPin === "string" ? req.body.newPin : "";
  if (newPin.length < MIN_PIN_LENGTH || newPin.length > MAX_PIN_LENGTH) {
    return res.status(400).json({ error: `PIN must be ${MIN_PIN_LENGTH}-${MAX_PIN_LENGTH} characters` });
  }
  const salt = randomHex(16);
  const info = db.prepare("UPDATE accounts SET salt = ?, hash = ? WHERE name_key = ?").run(salt, hashPin(newPin, salt), name.toLowerCase());
  if (!info.changes) return res.status(404).json({ error: "Account not found" });
  res.json({ ok: true });
});

app.post("/api/chat/release-me", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  db.prepare("DELETE FROM accounts WHERE name_key = ?").run(name.toLowerCase());
  const token = req.get("X-Chat-Session") || "";
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  res.json({ ok: true });
});

// ---------- blocking ----------
app.post("/api/chat/block", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const target = typeof req.body.name === "string" ? req.body.name.trim() : "";
  if (!target) return res.status(400).json({ error: "name is required" });
  db.prepare("INSERT OR IGNORE INTO blocks (owner_key, blocked_key) VALUES (?,?)").run(name.toLowerCase(), target.toLowerCase());
  res.json({ ok: true });
});
app.post("/api/chat/unblock", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const target = typeof req.body.name === "string" ? req.body.name.trim().toLowerCase() : "";
  db.prepare("DELETE FROM blocks WHERE owner_key = ? AND blocked_key = ?").run(name.toLowerCase(), target);
  res.json({ ok: true });
});
app.get("/api/chat/blocks", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const rows = db.prepare("SELECT blocked_key FROM blocks WHERE owner_key = ?").all(name.toLowerCase());
  res.json(rows.map((r) => r.blocked_key));
});

// ---------- presence ----------
app.post("/api/chat/presence", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  touchLastSeen(name);
  res.json({ ok: true });
});
app.get("/api/chat/presence", (req, res) => {
  if (!requireSession(req, res)) return;
  const requested = String(req.query.names || "").split(",").map((n) => n.trim()).filter(Boolean);
  const result = {};
  requested.forEach((n) => {
    const row = db.prepare("SELECT ts FROM last_seen WHERE name_key = ?").get(n.toLowerCase());
    const ts = row ? row.ts : null;
    result[n] = { online: !!ts && Date.now() - ts < ONLINE_WINDOW_MS, lastSeen: ts };
  });
  res.json(result);
});

// ---------- global chat ----------
app.get("/api/chat", (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM (SELECT * FROM global_messages ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC`
  ).all(MAX_CHAT_MESSAGES);
  res.json(rows.map(globalRowToMsg));
});
app.post("/api/chat", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const text = typeof req.body.text === "string" ? req.body.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
  const attachment = resolveAttachment(req.body);
  if (!text && !attachment) return res.status(400).json({ error: "text is required" });
  const replyToId = typeof req.body.replyTo === "string" ? req.body.replyTo : "";
  let replyJson = null;
  if (replyToId) {
    const o = db.prepare("SELECT * FROM global_messages WHERE id = ?").get(replyToId);
    if (o) replyJson = JSON.stringify({ id: o.id, who: o.name, text: o.deleted ? null : o.text });
  }
  const id = randomHex(6);
  db.prepare(
    "INSERT INTO global_messages (id, name, text, ts, reply_json, reactions_json, attachment_json) VALUES (?,?,?,?,?,'{}',?)"
  ).run(id, name, text, Date.now(), replyJson, attachment ? JSON.stringify(attachment) : null);
  bumpStat("totalGlobalMessages");
  res.json({ ok: true, name, id });
});
app.post("/api/chat/edit", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const messageId = typeof req.body.messageId === "string" ? req.body.messageId : "";
  const text = typeof req.body.text === "string" ? req.body.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
  if (!messageId || !text) return res.status(400).json({ error: "messageId and text are required" });
  const msg = db.prepare("SELECT * FROM global_messages WHERE id = ?").get(messageId);
  if (!msg) return res.status(404).json({ error: "Message not found" });
  if (msg.name !== name) return res.status(403).json({ error: "Not your message" });
  if (msg.deleted) return res.status(400).json({ error: "Message was deleted" });
  db.prepare("UPDATE global_messages SET text = ?, edited = 1 WHERE id = ?").run(text, messageId);
  res.json({ ok: true });
});
app.post("/api/chat/delete", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const messageId = typeof req.body.messageId === "string" ? req.body.messageId : "";
  if (!messageId) return res.status(400).json({ error: "messageId is required" });
  const msg = db.prepare("SELECT * FROM global_messages WHERE id = ?").get(messageId);
  if (!msg) return res.status(404).json({ error: "Message not found" });
  if (msg.name !== name) return res.status(403).json({ error: "Not your message" });
  db.prepare("UPDATE global_messages SET text = NULL, deleted = 1, reactions_json = '{}' WHERE id = ?").run(messageId);
  res.json({ ok: true });
});
app.post("/api/chat/react", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const messageId = typeof req.body.messageId === "string" ? req.body.messageId : "";
  const emoji = typeof req.body.emoji === "string" ? req.body.emoji.trim().slice(0, MAX_EMOJI_LENGTH) : "";
  if (!messageId || !emoji) return res.status(400).json({ error: "messageId and emoji are required" });
  const msg = db.prepare("SELECT * FROM global_messages WHERE id = ?").get(messageId);
  if (!msg || msg.deleted) return res.status(404).json({ error: "Message not found" });
  const reactions = JSON.parse(msg.reactions_json || "{}");
  const list = reactions[emoji] || [];
  const idx = list.indexOf(name);
  if (idx === -1) list.push(name); else list.splice(idx, 1);
  if (list.length) reactions[emoji] = list; else delete reactions[emoji];
  db.prepare("UPDATE global_messages SET reactions_json = ? WHERE id = ?").run(JSON.stringify(reactions), messageId);
  res.json({ ok: true, reactions });
});

// ---------- pinned (admin sets) ----------
app.get("/api/chat/pinned", (req, res) => {
  res.json(db.prepare("SELECT id, name, text, ts, pinned_at AS pinnedAt FROM pinned ORDER BY pinned_at ASC").all());
});
app.post("/api/chat/pin", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const messageId = typeof req.body.messageId === "string" ? req.body.messageId : "";
  const msg = db.prepare("SELECT * FROM global_messages WHERE id = ?").get(messageId);
  if (!msg || msg.deleted) return res.status(404).json({ error: "Message not found" });
  db.prepare("INSERT OR IGNORE INTO pinned (id, name, text, ts, pinned_at) VALUES (?,?,?,?,?)")
    .run(msg.id, msg.name, msg.text, msg.ts, Date.now());
  res.json({ ok: true });
});
app.post("/api/chat/unpin", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const messageId = typeof req.body.messageId === "string" ? req.body.messageId : "";
  db.prepare("DELETE FROM pinned WHERE id = ?").run(messageId);
  res.json({ ok: true });
});

// ---------- direct messages ----------
function getConversation(convId) {
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(convId);
  if (!row) return null;
  return { id: row.id, participants: JSON.parse(row.participants_json), createdAt: row.created };
}
function isParticipant(conversation, name) {
  return conversation.participants.map((p) => p.toLowerCase()).indexOf(name.toLowerCase()) !== -1;
}

app.post("/api/dm/start", (req, res) => {
  const fromName = requireSession(req, res); if (!fromName) return;
  const requested = Array.isArray(req.body.participants) ? req.body.participants : [];
  const seen = {};
  const uniqueOthers = [];
  requested
    .map((n) => (typeof n === "string" ? n.trim().slice(0, MAX_NAME_LENGTH) : ""))
    .filter((n) => n && n.toLowerCase() !== fromName.toLowerCase())
    .forEach((n) => { const k = n.toLowerCase(); if (!seen[k]) { seen[k] = true; uniqueOthers.push(n); } });
  if (!uniqueOthers.length) return res.status(400).json({ error: "Need at least one other person" });
  if (uniqueOthers.length + 1 > MAX_GROUP_PARTICIPANTS) {
    return res.status(400).json({ error: `Groups are capped at ${MAX_GROUP_PARTICIPANTS} people` });
  }
  const participants = [fromName].concat(uniqueOthers).map(canonical);
  const setKey = participantSetKey(participants);
  if (participants.length === 2 && isBlocked(uniqueOthers[0], fromName)) {
    return res.status(403).json({ error: "This person isn't accepting messages from you" });
  }
  const existing = db.prepare("SELECT id, participants_json FROM conversations WHERE set_key = ?").get(setKey);
  if (existing) return res.json({ convId: existing.id, participants: JSON.parse(existing.participants_json) });
  const convId = randomHex(8);
  db.prepare("INSERT INTO conversations (id, participants_json, set_key, created) VALUES (?,?,?,?)")
    .run(convId, JSON.stringify(participants), setKey, Date.now());
  res.json({ convId, participants });
});

app.post("/api/dm/send", (req, res) => {
  const fromName = requireSession(req, res); if (!fromName) return;
  const convId = typeof req.body.convId === "string" ? req.body.convId : "";
  const text = typeof req.body.text === "string" ? req.body.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
  const attachment = resolveAttachment(req.body);
  if (!convId || (!text && !attachment)) return res.status(400).json({ error: "convId and text are required" });
  const conversation = getConversation(convId);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  if (!isParticipant(conversation, fromName)) return res.status(403).json({ error: "Not a participant in this conversation" });
  if (conversation.participants.length === 2) {
    const other = conversation.participants.find((p) => p.toLowerCase() !== fromName.toLowerCase());
    if (other && isBlocked(other, fromName)) {
      return res.status(403).json({ error: "This person isn't accepting messages from you" });
    }
  }
  const replyToId = typeof req.body.replyTo === "string" ? req.body.replyTo : "";
  let replyJson = null;
  if (replyToId) {
    const o = db.prepare("SELECT * FROM dm_messages WHERE id = ? AND conv_id = ?").get(replyToId, convId);
    if (o) replyJson = JSON.stringify({ id: o.id, who: o.from_name, text: o.deleted ? null : o.text });
  }
  const id = randomHex(6);
  const ts = Date.now();
  db.prepare(
    "INSERT INTO dm_messages (id, conv_id, from_name, text, ts, reply_json, reactions_json, attachment_json) VALUES (?,?,?,?,?,?,'{}',?)"
  ).run(id, convId, fromName, text, ts, replyJson, attachment ? JSON.stringify(attachment) : null);
  bumpStat("totalDmMessages");
  const message = { from: fromName, text: text || (attachment ? "📎 " + attachment.name : ""), ts };
  conversation.participants.forEach((p) => upsertThread(p, conversation, message));
  res.json({ ok: true, id });
});

app.get("/api/dm/threads", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const rows = db.prepare(
    "SELECT conv_id, participants_json, last_ts, last_text, last_from FROM threads WHERE owner_key = ? ORDER BY last_ts DESC"
  ).all(name.toLowerCase());
  const threads = rows.map((r) => {
    const locked = !!db.prepare("SELECT 1 FROM dm_locks WHERE conv_id = ? AND owner_key = ?").get(r.conv_id, name.toLowerCase());
    return {
      convId: r.conv_id, participants: JSON.parse(r.participants_json),
      lastTs: r.last_ts, lastText: r.last_text, lastFrom: r.last_from, locked,
    };
  });
  res.json(threads);
});

app.post("/api/dm/lock", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const convId = typeof req.body.convId === "string" ? req.body.convId : "";
  const pin = typeof req.body.pin === "string" ? req.body.pin : "";
  if (!convId) return res.status(400).json({ error: "convId is required" });
  if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
    return res.status(400).json({ error: `PIN must be ${MIN_PIN_LENGTH}-${MAX_PIN_LENGTH} characters` });
  }
  const conversation = getConversation(convId);
  if (!conversation || !isParticipant(conversation, name)) return res.status(404).json({ error: "Conversation not found" });
  const salt = randomHex(16);
  db.prepare(
    `INSERT INTO dm_locks (conv_id, owner_key, salt, hash) VALUES (?,?,?,?)
     ON CONFLICT(conv_id, owner_key) DO UPDATE SET salt = excluded.salt, hash = excluded.hash`
  ).run(convId, name.toLowerCase(), salt, hashPin(pin, salt));
  res.json({ ok: true });
});
app.post("/api/dm/unlock", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const convId = typeof req.body.convId === "string" ? req.body.convId : "";
  const pin = typeof req.body.pin === "string" ? req.body.pin : "";
  if (!convId) return res.status(400).json({ error: "convId is required" });
  const lock = db.prepare("SELECT salt, hash FROM dm_locks WHERE conv_id = ? AND owner_key = ?").get(convId, name.toLowerCase());
  if (!lock) return res.json({ ok: true, locked: false });
  if (!timingSafeEqual(hashPin(pin, lock.salt), lock.hash)) return res.status(401).json({ error: "Wrong PIN for this conversation." });
  res.json({ ok: true, locked: true });
});
app.post("/api/dm/lock/remove", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const convId = typeof req.body.convId === "string" ? req.body.convId : "";
  const pin = typeof req.body.pin === "string" ? req.body.pin : "";
  if (!convId) return res.status(400).json({ error: "convId is required" });
  const lock = db.prepare("SELECT salt, hash FROM dm_locks WHERE conv_id = ? AND owner_key = ?").get(convId, name.toLowerCase());
  if (!lock) return res.json({ ok: true });
  if (!timingSafeEqual(hashPin(pin, lock.salt), lock.hash)) return res.status(401).json({ error: "Wrong PIN for this conversation." });
  db.prepare("DELETE FROM dm_locks WHERE conv_id = ? AND owner_key = ?").run(convId, name.toLowerCase());
  res.json({ ok: true });
});

app.post("/api/dm/leave", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const convId = typeof req.body.convId === "string" ? req.body.convId : "";
  if (!convId) return res.status(400).json({ error: "convId is required" });
  db.prepare("DELETE FROM threads WHERE owner_key = ? AND conv_id = ?").run(name.toLowerCase(), convId);
  res.json({ ok: true });
});

app.get("/api/dm/messages", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const convId = String(req.query.convId || "");
  if (!convId) return res.status(400).json({ error: "convId is required" });
  const conversation = getConversation(convId);
  if (!conversation || !isParticipant(conversation, name)) return res.status(404).json({ error: "Conversation not found" });
  const rows = db.prepare(
    `SELECT * FROM (SELECT * FROM dm_messages WHERE conv_id = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC`
  ).all(convId, MAX_DM_MESSAGES);
  const reads = {};
  conversation.participants.forEach((p) => {
    const row = db.prepare("SELECT ts FROM dm_reads WHERE conv_id = ? AND owner_key = ?").get(convId, p.toLowerCase());
    reads[p] = row ? row.ts : 0;
  });
  res.json({ messages: rows.map(dmRowToMsg), participants: conversation.participants, reads });
});

app.post("/api/dm/edit", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const convId = typeof req.body.convId === "string" ? req.body.convId : "";
  const messageId = typeof req.body.messageId === "string" ? req.body.messageId : "";
  const text = typeof req.body.text === "string" ? req.body.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
  if (!convId || !messageId || !text) return res.status(400).json({ error: "convId, messageId and text are required" });
  const msg = db.prepare("SELECT * FROM dm_messages WHERE id = ? AND conv_id = ?").get(messageId, convId);
  if (!msg) return res.status(404).json({ error: "Message not found" });
  if (msg.from_name !== name) return res.status(403).json({ error: "Not your message" });
  if (msg.deleted) return res.status(400).json({ error: "Message was deleted" });
  db.prepare("UPDATE dm_messages SET text = ?, edited = 1 WHERE id = ?").run(text, messageId);
  res.json({ ok: true });
});
app.post("/api/dm/delete", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const convId = typeof req.body.convId === "string" ? req.body.convId : "";
  const messageId = typeof req.body.messageId === "string" ? req.body.messageId : "";
  if (!convId || !messageId) return res.status(400).json({ error: "convId and messageId are required" });
  const msg = db.prepare("SELECT * FROM dm_messages WHERE id = ? AND conv_id = ?").get(messageId, convId);
  if (!msg) return res.status(404).json({ error: "Message not found" });
  if (msg.from_name !== name) return res.status(403).json({ error: "Not your message" });
  db.prepare("UPDATE dm_messages SET text = NULL, deleted = 1, reactions_json = '{}' WHERE id = ?").run(messageId);
  res.json({ ok: true });
});
app.post("/api/dm/react", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const convId = typeof req.body.convId === "string" ? req.body.convId : "";
  const messageId = typeof req.body.messageId === "string" ? req.body.messageId : "";
  const emoji = typeof req.body.emoji === "string" ? req.body.emoji.trim().slice(0, MAX_EMOJI_LENGTH) : "";
  if (!convId || !messageId || !emoji) return res.status(400).json({ error: "convId, messageId and emoji are required" });
  const conversation = getConversation(convId);
  if (!conversation || !isParticipant(conversation, name)) return res.status(404).json({ error: "Conversation not found" });
  const msg = db.prepare("SELECT * FROM dm_messages WHERE id = ? AND conv_id = ?").get(messageId, convId);
  if (!msg || msg.deleted) return res.status(404).json({ error: "Message not found" });
  const reactions = JSON.parse(msg.reactions_json || "{}");
  const list = reactions[emoji] || [];
  const idx = list.indexOf(name);
  if (idx === -1) list.push(name); else list.splice(idx, 1);
  if (list.length) reactions[emoji] = list; else delete reactions[emoji];
  db.prepare("UPDATE dm_messages SET reactions_json = ? WHERE id = ?").run(JSON.stringify(reactions), messageId);
  res.json({ ok: true, reactions });
});
app.post("/api/dm/read", (req, res) => {
  const name = requireSession(req, res); if (!name) return;
  const convId = typeof req.body.convId === "string" ? req.body.convId : "";
  if (!convId) return res.status(400).json({ error: "convId is required" });
  db.prepare(
    "INSERT INTO dm_reads (conv_id, owner_key, ts) VALUES (?,?,?) ON CONFLICT(conv_id, owner_key) DO UPDATE SET ts = excluded.ts"
  ).run(convId, name.toLowerCase(), Date.now());
  res.json({ ok: true });
});

// ---------- admin ----------
app.get("/api/chat/names", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const list = db.prepare("SELECT name, created AS createdAt, avatar, status FROM accounts ORDER BY created ASC").all();
  res.json(list);
});
app.post("/api/chat/names/release", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = typeof req.body.name === "string" ? req.body.name : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  db.prepare("DELETE FROM accounts WHERE name_key = ?").run(name.toLowerCase());
  res.json({ ok: true });
});
app.post("/api/chat/clear", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.exec("DELETE FROM global_messages; DELETE FROM pinned;");
  res.json({ ok: true });
});
// Chat stats for the admin dashboard (the Worker supplies triggers + live-tab count).
app.get("/api/admin/chat-stats", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    totalGlobalMessages: getStat("totalGlobalMessages"),
    totalDmMessages: getStat("totalDmMessages"),
    totalAccounts: db.prepare("SELECT COUNT(*) AS c FROM accounts").get().c,
  });
});

// ======================================================================
//  PERSONAL AREA (personal.oliverbar.net) — admin-key only, private to me
// ======================================================================

// ---------- notes ----------
app.get("/api/notes", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare("SELECT id, title, body, created, updated FROM notes ORDER BY updated DESC").all();
  res.json(rows);
});
app.post("/api/notes", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = typeof req.body.id === "string" && req.body.id ? req.body.id : "";
  const title = typeof req.body.title === "string" ? req.body.title.slice(0, 200) : "";
  const body = typeof req.body.body === "string" ? req.body.body.slice(0, 100000) : "";
  const now = Date.now();
  if (id) {
    const info = db.prepare("UPDATE notes SET title = ?, body = ?, updated = ? WHERE id = ?").run(title, body, now, id);
    if (info.changes) return res.json({ id, title, body, updated: now });
  }
  const newId = randomHex(8);
  db.prepare("INSERT INTO notes (id, title, body, created, updated) VALUES (?,?,?,?,?)").run(newId, title, body, now, now);
  res.json({ id: newId, title, body, created: now, updated: now });
});
app.post("/api/notes/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = typeof req.body.id === "string" ? req.body.id : "";
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ---------- cross-device clipboard ----------
const MAX_CLIPS = 50;
app.get("/api/clipboard", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(db.prepare("SELECT id, text, created FROM clips ORDER BY created DESC LIMIT ?").all(MAX_CLIPS));
});
app.post("/api/clipboard", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const text = typeof req.body.text === "string" ? req.body.text.slice(0, 50000) : "";
  if (!text.trim()) return res.status(400).json({ error: "text is required" });
  const id = randomHex(8);
  const created = Date.now();
  db.prepare("INSERT INTO clips (id, text, created) VALUES (?,?,?)").run(id, text, created);
  // Trim to the most recent MAX_CLIPS so this never grows unbounded.
  db.prepare("DELETE FROM clips WHERE id NOT IN (SELECT id FROM clips ORDER BY created DESC LIMIT ?)").run(MAX_CLIPS);
  res.json({ id, text, created });
});
app.post("/api/clipboard/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = typeof req.body.id === "string" ? req.body.id : "";
  if (id === "*") db.exec("DELETE FROM clips;");
  else db.prepare("DELETE FROM clips WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ---------- personal files (private; served ONLY with the admin key) ----------
const myUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MY_UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || "") || "").slice(0, 16).replace(/[^.\w]/g, "");
      cb(null, randomHex(16) + ext);
    },
  }),
  limits: { fileSize: MAX_MYFILE_BYTES, files: 1 },
});
app.get("/api/myfiles", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(db.prepare("SELECT id, name, type, size, created FROM myfiles ORDER BY created DESC").all());
});
app.post("/api/myfiles/upload", (req, res) => {
  if (!requireAdmin(req, res)) return;
  myUpload.single("file")(req, res, (err) => {
    if (err) {
      const msg = err.code === "LIMIT_FILE_SIZE"
        ? `File too large (max ${Math.round(MAX_MYFILE_BYTES / 1024 / 1024)} MB)`
        : "Upload failed";
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: "No file" });
    const id = randomHex(12);
    const original = (req.file.originalname || "file").slice(0, 200);
    const type = (req.file.mimetype || "application/octet-stream").slice(0, 100);
    db.prepare("INSERT INTO myfiles (id, name, type, size, filename, created) VALUES (?,?,?,?,?,?)")
      .run(id, original, type, req.file.size, req.file.filename, Date.now());
    res.json({ id, name: original, type, size: req.file.size });
  });
});
// Unlike chat attachments, personal files are NOT capability URLs — they
// require the admin key, so the frontend fetches them and makes a blob URL.
app.get("/api/myfiles/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const row = db.prepare("SELECT * FROM myfiles WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const full = path.join(MY_UPLOADS_DIR, row.filename);
  if (!fs.existsSync(full)) return res.status(404).json({ error: "Not found" });
  const inlineOk = /^(image|video|audio)\//.test(row.type) || row.type === "application/pdf";
  res.set("Content-Type", row.type || "application/octet-stream");
  res.set("Content-Disposition",
    (inlineOk ? "inline" : "attachment") + '; filename="' + row.name.replace(/[^\w.\- ]/g, "_") + '"');
  fs.createReadStream(full).pipe(res);
});
app.post("/api/myfiles/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = typeof req.body.id === "string" ? req.body.id : "";
  const row = db.prepare("SELECT filename FROM myfiles WHERE id = ?").get(id);
  if (row) {
    try { fs.unlinkSync(path.join(MY_UPLOADS_DIR, row.filename)); } catch (e) {}
    db.prepare("DELETE FROM myfiles WHERE id = ?").run(id);
  }
  res.json({ ok: true });
});

// ---------- Pi system dashboard ----------
// Reads live vitals off the host. Each probe is best-effort: on a non-Pi box
// (or if a command is missing) the field comes back null instead of erroring.
function sh(cmd) {
  try { return execSync(cmd, { timeout: 2000 }).toString().trim(); } catch (e) { return null; }
}
app.get("/api/admin/system", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const out = { ts: Date.now() };

  // CPU temperature (°C)
  const tempRaw = sh("vcgencmd measure_temp") || "";
  let temp = null;
  const tm = tempRaw.match(/([\d.]+)/);
  if (tm) temp = Number(tm[1]);
  if (temp === null) {
    try { temp = Number(fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8")) / 1000; } catch (e) {}
  }
  out.tempC = temp;

  // Throttle / undervoltage flags (the charger problem shows up here)
  const thr = sh("vcgencmd get_throttled") || "";
  const hm = thr.match(/0x([0-9a-fA-F]+)/);
  if (hm) {
    const bits = parseInt(hm[1], 16);
    out.throttled = {
      raw: "0x" + bits.toString(16),
      undervoltageNow: !!(bits & 0x1),
      throttledNow: !!(bits & 0x4),
      undervoltageEver: !!(bits & 0x10000),
      throttledEver: !!(bits & 0x40000),
      ok: bits === 0,
    };
  } else {
    out.throttled = null;
  }

  // Uptime + load
  try {
    const up = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    out.uptimeSec = Math.round(up);
  } catch (e) { out.uptimeSec = null; }
  try {
    const la = fs.readFileSync("/proc/loadavg", "utf8").split(" ");
    out.load = { "1m": Number(la[0]), "5m": Number(la[1]), "15m": Number(la[2]) };
  } catch (e) { out.load = null; }

  // Memory (from /proc/meminfo, in kB)
  try {
    const mi = fs.readFileSync("/proc/meminfo", "utf8");
    const grab = (k) => { const m = mi.match(new RegExp(k + ":\\s+(\\d+)")); return m ? Number(m[1]) * 1024 : null; };
    const total = grab("MemTotal"), avail = grab("MemAvailable");
    out.mem = { total, available: avail, used: total && avail ? total - avail : null };
  } catch (e) { out.mem = null; }

  // Disk usage of the root filesystem
  const dfOut = sh("df -kP /");
  if (dfOut) {
    const line = dfOut.trim().split("\n").pop().split(/\s+/);
    if (line.length >= 4) {
      out.disk = { total: Number(line[1]) * 1024, used: Number(line[2]) * 1024, available: Number(line[3]) * 1024 };
    }
  } else { out.disk = null; }

  // Is the chat service healthy? (itself, so always true here, but handy)
  out.service = { up: true };
  // Sizes of our own data on disk
  const dirSize = (dir) => {
    try {
      return fs.readdirSync(dir).reduce((sum, f) => {
        try { return sum + fs.statSync(path.join(dir, f)).size; } catch (e) { return sum; }
      }, 0);
    } catch (e) { return null; }
  };
  out.storage = {
    db: (() => { try { return fs.statSync(DB_PATH).size; } catch (e) { return null; } })(),
    uploads: dirSize(UPLOADS_DIR),
    myfiles: dirSize(MY_UPLOADS_DIR),
  };

  res.json(out);
});

// ---------- RPG game (oliverbar.net/game) ----------
// ---------- ULTRA download counter (oliverbar.net) ----------
// One count per device per platform: the page sends a random per-browser id
// (kept in localStorage), and the (device, platform) primary key makes repeat
// downloads from the same machine a no-op.
db.exec(`CREATE TABLE IF NOT EXISTS downloads (
  device TEXT NOT NULL, platform TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (device, platform)
)`);
function downloadCounts() {
  const rows = db.prepare("SELECT platform, COUNT(*) AS c FROM downloads GROUP BY platform").all();
  const out = { windows: 0, mac: 0 };
  rows.forEach((r) => { if (r.platform in out) out[r.platform] = r.c; });
  out.total = out.windows + out.mac;
  return out;
}
app.get("/api/downloads", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(downloadCounts());
});
app.post("/api/downloads/count", (req, res) => {
  const platform = req.body && req.body.platform;
  const device = req.body && typeof req.body.device === "string" ? req.body.device : "";
  if (platform !== "windows" && platform !== "mac") return res.status(400).json({ error: "bad platform" });
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(device)) return res.status(400).json({ error: "bad device" });
  const info = db.prepare("INSERT OR IGNORE INTO downloads (device, platform, ts) VALUES (?,?,?)")
    .run(device, platform, Date.now());
  res.json(Object.assign({ counted: info.changes === 1 }, downloadCounts()));
});

// ---------- ULTRA feedback + admin panel (admin.oliverbar.net) ----------
// Only the SHA-256 of the admin password lives here; the password itself is
// a 32-char random string that isn't stored anywhere.
const ULTRA_ADMIN_HASH = process.env.ULTRA_ADMIN_HASH ||
  "233f315d89e47fcfb08f829fb0f4165c4cc4a5e2a3945afbad510f4ce2b6c9f4";
db.exec(`CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY, kind TEXT, message TEXT NOT NULL, contact TEXT,
  platform TEXT, ua TEXT, ts INTEGER NOT NULL, read INTEGER DEFAULT 0
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_downloads_ts ON downloads (ts)");

const feedbackHits = new Map(); // ip -> [timestamps], simple spam brake
const FEEDBACK_WINDOW_MS = 10 * 60 * 1000;
const FEEDBACK_DAILY_CAP = 300; // global ceiling so a flood can't fill the disk
// This server only listens on 127.0.0.1 behind the Cloudflare tunnel, so
// CF-Connecting-IP is written by Cloudflare and can't be forged by a client.
// (X-Forwarded-For is deliberately ignored — it's client-controlled.)
function clientIp(req) {
  return String(req.get("CF-Connecting-IP") || "unknown").trim().slice(0, 64);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of feedbackHits) {
    if (!ts.some((t) => now - t < FEEDBACK_WINDOW_MS)) feedbackHits.delete(ip);
  }
}, 5 * 60 * 1000).unref();
app.post("/api/feedback", (req, res) => {
  const b = req.body || {};
  const message = typeof b.message === "string" ? b.message.trim().slice(0, 2000) : "";
  if (message.length < 3) return res.status(400).json({ error: "Please write a little more." });
  const kind = ["bug", "idea", "other"].indexOf(b.kind) !== -1 ? b.kind : "other";
  const contact = typeof b.contact === "string" ? b.contact.trim().slice(0, 120) : "";
  const platform = ["windows", "mac", "other"].indexOf(b.platform) !== -1 ? b.platform : "other";
  const ip = clientIp(req), now = Date.now();
  const recent = (feedbackHits.get(ip) || []).filter((t) => now - t < FEEDBACK_WINDOW_MS);
  if (recent.length >= 5) return res.status(429).json({ error: "That's a lot of feedback — try again in a few minutes." });
  const today = db.prepare("SELECT COUNT(*) AS c FROM feedback WHERE ts >= ?").get(now - 86400000).c;
  if (today >= FEEDBACK_DAILY_CAP) return res.status(429).json({ error: "Feedback is busy right now — please try again tomorrow." });
  recent.push(now); feedbackHits.set(ip, recent);
  db.prepare("INSERT INTO feedback (id, kind, message, contact, platform, ua, ts) VALUES (?,?,?,?,?,?,?)")
    .run(randomHex(8), kind, message, contact, platform, String(req.get("User-Agent") || "").slice(0, 200), now);
  res.json({ ok: true });
});

function requireUltraAdmin(req, res) {
  const given = String(req.get("X-Ultra-Admin") || "");
  const h = crypto.createHash("sha256").update(given).digest("hex");
  if (!given || !timingSafeEqual(h, ULTRA_ADMIN_HASH)) { res.status(401).json({ error: "Wrong password" }); return false; }
  return true;
}
app.get("/api/ultra-admin/overview", (req, res) => {
  if (!requireUltraAdmin(req, res)) return;
  const DAY = 86400000, now = Date.now(), since = now - 30 * DAY;
  const rows = db.prepare("SELECT platform, ts FROM downloads WHERE ts >= ?").all(since);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * DAY); d.setHours(0, 0, 0, 0);
    days.push({ day: d.getTime(), windows: 0, mac: 0 });
  }
  rows.forEach((r) => {
    const d = new Date(r.ts); d.setHours(0, 0, 0, 0);
    const slot = days.find((x) => x.day === d.getTime());
    if (slot && (r.platform === "windows" || r.platform === "mac")) slot[r.platform]++;
  });
  const fb = db.prepare("SELECT COUNT(*) AS c, SUM(CASE WHEN read=0 THEN 1 ELSE 0 END) AS u FROM feedback").get();
  res.json({
    downloads: downloadCounts(),
    last24h: db.prepare("SELECT COUNT(*) AS c FROM downloads WHERE ts >= ?").get(now - DAY).c,
    last7d: db.prepare("SELECT COUNT(*) AS c FROM downloads WHERE ts >= ?").get(now - 7 * DAY).c,
    daily: days,
    feedback: { total: fb.c || 0, unread: fb.u || 0 },
    experimental: (() => {
      const e = { windows: 0, mac: 0 };
      try {
        db.prepare("SELECT platform, COUNT(*) AS c FROM exp_downloads GROUP BY platform").all()
          .forEach((r) => { if (r.platform in e) e[r.platform] = r.c; });
      } catch (x) { /* table created further down on first boot */ }
      e.total = e.windows + e.mac;
      e.configured = !!process.env.GITHUB_EXPERIMENTAL_TOKEN;
      return e;
    })(),
  });
});
app.get("/api/ultra-admin/feedback", (req, res) => {
  if (!requireUltraAdmin(req, res)) return;
  res.json(db.prepare("SELECT id, kind, message, contact, platform, ua, ts, read FROM feedback ORDER BY ts DESC LIMIT 500").all());
});
app.post("/api/ultra-admin/feedback/read", (req, res) => {
  if (!requireUltraAdmin(req, res)) return;
  const id = String((req.body && req.body.id) || "");
  const read = req.body && req.body.read === false ? 0 : 1;
  if (id === "*") db.prepare("UPDATE feedback SET read = 1").run();
  else db.prepare("UPDATE feedback SET read = ? WHERE id = ?").run(read, id);
  res.json({ ok: true });
});
app.post("/api/ultra-admin/feedback/delete", (req, res) => {
  if (!requireUltraAdmin(req, res)) return;
  db.prepare("DELETE FROM feedback WHERE id = ?").run(String((req.body && req.body.id) || ""));
  res.json({ ok: true });
});

// ---------- ULTRA Experimental: key-gated downloads (oliverbar.net/experimental) ----------
// The builds live in the PRIVATE repo skhshths/ULTRA-experimental, so they can
// only be fetched with a GitHub token. That token stays on the Pi (.env:
// GITHUB_EXPERIMENTAL_TOKEN, read-only). The key itself is read from
// EXPERIMENTAL_KEY.txt in that repo, so editing that file rotates the key.
const EXP_REPO = process.env.EXPERIMENTAL_REPO || "skhshths/ULTRA-experimental";
const EXP_ASSETS = { windows: "ULTRA-windows-x64.exe", mac: "ULTRA-macos.zip" };
const TICKET_SECRET = crypto.randomBytes(32); // tickets die on restart — fine, they last 10 min
const TICKET_TTL_MS = 10 * 60 * 1000;
db.exec(`CREATE TABLE IF NOT EXISTS exp_downloads (
  device TEXT NOT NULL, platform TEXT NOT NULL, ts INTEGER NOT NULL, release TEXT,
  PRIMARY KEY (device, platform)
)`);

function ghRequest(apiPath, accept) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_EXPERIMENTAL_TOKEN;
    if (!token) return reject(Object.assign(new Error("not configured"), { notConfigured: true }));
    const req = https.request({
      host: "api.github.com", path: apiPath, method: "GET",
      headers: { "Authorization": "Bearer " + token, "Accept": accept || "application/vnd.github+json",
        "User-Agent": "oliverbar-pi", "X-GitHub-Api-Version": "2022-11-28" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { if (body.length < 2e6) body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("GitHub timed out")));
    req.end();
  });
}
const expCache = { key: null, keyAt: 0, release: null, relAt: 0 };
async function experimentalKey() {
  if (expCache.key && Date.now() - expCache.keyAt < 5 * 60 * 1000) return expCache.key;
  const r = await ghRequest(`/repos/${EXP_REPO}/contents/EXPERIMENTAL_KEY.txt`, "application/vnd.github.raw");
  if (r.status !== 200) { if (expCache.key) return expCache.key; throw new Error("key fetch " + r.status); }
  expCache.key = r.body.trim(); expCache.keyAt = Date.now();
  return expCache.key;
}
async function experimentalRelease() {
  if (expCache.release && Date.now() - expCache.relAt < 2 * 60 * 1000) return expCache.release;
  const r = await ghRequest(`/repos/${EXP_REPO}/releases/latest`);
  if (r.status !== 200) { if (expCache.release) return expCache.release; throw new Error("release fetch " + r.status); }
  const j = JSON.parse(r.body);
  const rel = { name: j.name || j.tag_name, tag: j.tag_name, published: j.published_at, assets: {} };
  (j.assets || []).forEach((a) => {
    for (const p in EXP_ASSETS) if (a.name === EXP_ASSETS[p]) rel.assets[p] = { id: a.id, name: a.name, size: a.size };
  });
  expCache.release = rel; expCache.relAt = Date.now();
  return rel;
}
function signTicket(device) {
  const payload = Buffer.from(JSON.stringify({ d: device, e: Date.now() + TICKET_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", TICKET_SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}
function readTicket(t) {
  const [payload, sig] = String(t || "").split(".");
  if (!payload || !sig) return null;
  const want = crypto.createHmac("sha256", TICKET_SECRET).update(payload).digest("base64url");
  if (!timingSafeEqual(sig, want)) return null;
  try { const o = JSON.parse(Buffer.from(payload, "base64url").toString()); return o.e > Date.now() ? o : null; }
  catch (e) { return null; }
}
const keyFails = new Map(); // ip -> [timestamps of wrong keys]
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of keyFails) if (!ts.some((t) => now - t < FEEDBACK_WINDOW_MS)) keyFails.delete(ip);
}, 5 * 60 * 1000).unref();

app.post("/api/experimental/verify", async (req, res) => {
  const ip = clientIp(req), now = Date.now();
  const fails = (keyFails.get(ip) || []).filter((t) => now - t < FEEDBACK_WINDOW_MS);
  if (fails.length >= 10) return res.status(429).json({ error: "Too many wrong keys — wait a few minutes and try again." });
  const key = typeof (req.body && req.body.key) === "string" ? req.body.key.trim() : "";
  const device = typeof (req.body && req.body.device) === "string" ? req.body.device : "";
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(device)) return res.status(400).json({ error: "bad device" });
  try {
    const real = await experimentalKey();
    const h = (s) => crypto.createHash("sha256").update(s).digest("hex"); // equal-length compare
    if (!key || !timingSafeEqual(h(key), h(real))) {
      fails.push(now); keyFails.set(ip, fails);
      return res.status(401).json({ error: "That key isn't right." });
    }
    const rel = await experimentalRelease();
    res.json({ ok: true, ticket: signTicket(device), release: {
      name: rel.name, tag: rel.tag, published: rel.published,
      windows: rel.assets.windows ? { size: rel.assets.windows.size } : null,
      mac: rel.assets.mac ? { size: rel.assets.mac.size } : null,
    } });
  } catch (e) {
    console.error("experimental verify:", e.message);
    res.status(503).json({ error: e.notConfigured ? "Experimental downloads aren't set up on the server yet." : "Couldn't reach GitHub — try again in a moment." });
  }
});

// Browser downloads need a plain GET link, so the ticket rides in the URL.
// We never stream the file ourselves: GitHub answers the token-authenticated
// asset request with a short-lived signed URL, and we send the browser there.
app.get("/api/experimental/download/:platform", async (req, res) => {
  const platform = req.params.platform;
  if (!EXP_ASSETS[platform]) return res.status(404).send("Unknown platform");
  const t = readTicket(req.query.t);
  if (!t) return res.status(403).send("This download link has expired. Go back to oliverbar.net/experimental and enter the key again.");
  try {
    const rel = await experimentalRelease();
    const asset = rel.assets[platform];
    if (!asset) return res.status(404).send("No " + platform + " build in the latest experimental release.");
    const r = await ghRequest(`/repos/${EXP_REPO}/releases/assets/${asset.id}`, "application/octet-stream");
    if (r.status < 300 || r.status >= 400 || !r.headers.location) throw new Error("asset fetch " + r.status);
    db.prepare("INSERT OR IGNORE INTO exp_downloads (device, platform, ts, release) VALUES (?,?,?,?)")
      .run(t.d, platform, Date.now(), rel.tag);
    res.set("Cache-Control", "no-store");
    res.redirect(302, r.headers.location);
  } catch (e) {
    console.error("experimental download:", e.message);
    res.status(502).send("Couldn't fetch the build from GitHub — try again in a moment.");
  }
});

require("./game")(app, db, { requireSession, randomHex });

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error: " + (err && err.message ? err.message : String(err)) });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`chat backend listening on 127.0.0.1:${PORT}, db=${DB_PATH}`);
});
