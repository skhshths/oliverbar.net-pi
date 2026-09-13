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
const express = require("express");
const Database = require("better-sqlite3");

// ---------- config ----------
const PORT = Number(process.env.PORT || 8081);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "chat.db");
const EDIT_PASSWORD = process.env.EDIT_PASSWORD || "asdfasdfasdf"; // admin key; override in .env
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

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
`);

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
  return m;
}
function dmRowToMsg(r) {
  const m = { id: r.id, from: r.from_name, ts: r.ts, reactions: JSON.parse(r.reactions_json || "{}") };
  if (r.deleted) { m.text = null; m.deleted = true; } else { m.text = r.text; }
  if (r.edited) m.edited = true;
  if (r.reply_json) m.replyTo = JSON.parse(r.reply_json);
  return m;
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
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Edit-Key, X-Chat-Session");
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
  if (!text) return res.status(400).json({ error: "text is required" });
  const replyToId = typeof req.body.replyTo === "string" ? req.body.replyTo : "";
  let replyJson = null;
  if (replyToId) {
    const o = db.prepare("SELECT * FROM global_messages WHERE id = ?").get(replyToId);
    if (o) replyJson = JSON.stringify({ id: o.id, who: o.name, text: o.deleted ? null : o.text });
  }
  const id = randomHex(6);
  db.prepare(
    "INSERT INTO global_messages (id, name, text, ts, reply_json, reactions_json) VALUES (?,?,?,?,?,'{}')"
  ).run(id, name, text, Date.now(), replyJson);
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
  if (!convId || !text) return res.status(400).json({ error: "convId and text are required" });
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
    "INSERT INTO dm_messages (id, conv_id, from_name, text, ts, reply_json, reactions_json) VALUES (?,?,?,?,?,?,'{}')"
  ).run(id, convId, fromName, text, ts, replyJson);
  bumpStat("totalDmMessages");
  const message = { from: fromName, text, ts };
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error: " + (err && err.message ? err.message : String(err)) });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`chat backend listening on 127.0.0.1:${PORT}, db=${DB_PATH}`);
});
