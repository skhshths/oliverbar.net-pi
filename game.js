"use strict";

// ======================================================================
//  RPG game backend (oliverbar.net/game) — OSRS-flavoured, minimalist.
//
//  Server-authoritative: the client asks to attack a target and the Pi
//  resolves the whole fight (hits, xp, loot, rare drops) so nothing can be
//  faked by editing the page. Player data lives on the Pi in SQLite, keyed
//  by the same account name used for chat. One boss spawns every minute.
//
//  Registered from server.js:  require("./game")(app, db, helpers)
//  where helpers = { requireSession, randomHex }.
// ======================================================================

module.exports = function registerGame(app, db, helpers) {
  const requireSession = helpers.requireSession;
  const randomHex = helpers.randomHex;

  // ---------- OSRS-style xp curve ----------
  const LEVEL_XP = [0, 0]; // index by level; LEVEL_XP[1] = 0
  (function buildTable() {
    let total = 0;
    for (let lvl = 1; lvl < 99; lvl++) {
      total += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
      LEVEL_XP[lvl + 1] = Math.floor(total / 4);
    }
  })();
  const MAX_LEVEL = 99;
  function levelFromXp(xp) {
    let lvl = 1;
    for (let i = 2; i <= MAX_LEVEL; i++) { if (xp >= LEVEL_XP[i]) lvl = i; else break; }
    return lvl;
  }
  const START_HP_XP = LEVEL_XP[10]; // Hitpoints starts at level 10, like OSRS

  // ---------- content: items ----------
  // type: weapon | armor | material | unique | dye
  // armor/weapon carry combat bonuses; materials/uniques sell for coins;
  // dyes recolor a dyeable armour piece and are consumed on use.
  const ITEMS = {
    // --- weapons (buyable, plus one boss weapon) ---
    bronze_sword: { name: "Bronze Sword", type: "weapon", slot: "weapon", atk: 1, str: 2, value: 15, buy: 60 },
    iron_sword:   { name: "Iron Sword",   type: "weapon", slot: "weapon", atk: 3, str: 4, value: 45, buy: 220 },
    steel_sword:  { name: "Steel Sword",  type: "weapon", slot: "weapon", atk: 6, str: 7, value: 140, buy: 900 },
    mithril_sword:{ name: "Mithril Sword",type: "weapon", slot: "weapon", atk: 10, str: 11, value: 400, buy: 3200 },
    warden_blade: { name: "Warden's Blade", type: "weapon", slot: "weapon", atk: 16, str: 16, value: 2500, glow: true },
    // ranged + magic weapons so those styles have gear of their own
    oak_shortbow: { name: "Oak Shortbow", type: "weapon", slot: "weapon", rng: 4, value: 40, buy: 200 },
    yew_longbow:  { name: "Yew Longbow", type: "weapon", slot: "weapon", rng: 10, value: 300, buy: 2400 },
    apprentice_staff: { name: "Apprentice Staff", type: "weapon", slot: "weapon", mag: 4, value: 40, buy: 200 },
    sorcerer_staff:   { name: "Sorcerer Staff", type: "weapon", slot: "weapon", mag: 10, value: 300, buy: 2400 },

    // --- armour sets (dyeable). base is the undyed metal colour ---
    bronze_helm: { name: "Bronze Helm", type: "armor", slot: "helmet", def: 2, value: 20, buy: 80, dyeable: true, base: "#8a6a3f" },
    bronze_body: { name: "Bronze Platebody", type: "armor", slot: "body", def: 4, value: 40, buy: 180, dyeable: true, base: "#8a6a3f" },
    bronze_legs: { name: "Bronze Platelegs", type: "armor", slot: "legs", def: 3, value: 30, buy: 130, dyeable: true, base: "#8a6a3f" },

    iron_helm: { name: "Iron Helm", type: "armor", slot: "helmet", def: 4, value: 55, buy: 300, dyeable: true, base: "#9a9a9a" },
    iron_body: { name: "Iron Platebody", type: "armor", slot: "body", def: 8, value: 110, buy: 650, dyeable: true, base: "#9a9a9a" },
    iron_legs: { name: "Iron Platelegs", type: "armor", slot: "legs", def: 6, value: 80, buy: 480, dyeable: true, base: "#9a9a9a" },

    steel_helm: { name: "Steel Helm", type: "armor", slot: "helmet", def: 7, value: 160, buy: 1100, dyeable: true, base: "#c3c7cc" },
    steel_body: { name: "Steel Platebody", type: "armor", slot: "body", def: 13, value: 320, buy: 2400, dyeable: true, base: "#c3c7cc" },
    steel_legs: { name: "Steel Platelegs", type: "armor", slot: "legs", def: 10, value: 240, buy: 1700, dyeable: true, base: "#c3c7cc" },

    // Warden set: boss-only, best in slot, dyeable, faintly glowing gold base
    warden_helm: { name: "Warden's Helm", type: "armor", slot: "helmet", def: 12, str: 2, value: 1800, dyeable: true, base: "#d8b45a", glow: true },
    warden_body: { name: "Warden's Aegis", type: "armor", slot: "body", def: 20, str: 4, value: 4000, dyeable: true, base: "#d8b45a", glow: true },
    warden_legs: { name: "Warden's Greaves", type: "armor", slot: "legs", def: 15, str: 2, value: 2600, dyeable: true, base: "#d8b45a", glow: true },

    // --- materials (sold for coins) ---
    rat_hide:    { name: "Rat Hide", type: "material", value: 3 },
    goblin_ear:  { name: "Goblin Ear", type: "material", value: 6 },
    bone:        { name: "Bone", type: "material", value: 10 },
    wolf_pelt:   { name: "Wolf Pelt", type: "material", value: 22 },
    golem_core:  { name: "Golem Core", type: "material", value: 55 },
    wraith_dust: { name: "Wraith Dust", type: "material", value: 95 },
    molten_shard:{ name: "Molten Shard", type: "material", value: 180 },

    // --- secret uniques (the super-rare per-enemy drops; global notify) ---
    rat_king_tail: { name: "Rat King's Tail", type: "unique", value: 1500, glow: true },
    goblin_crown:  { name: "Goblin Crown", type: "unique", value: 2500, glow: true },
    cursed_skull:  { name: "Cursed Skull", type: "unique", value: 4000, glow: true },
    alpha_fang:    { name: "Alpha Fang", type: "unique", value: 7000, glow: true },
    golem_heart:   { name: "Golem Heart", type: "unique", value: 12000, glow: true },
    wraith_veil:   { name: "Wraith Veil", type: "unique", value: 20000, glow: true },
    warden_sigil:  { name: "Warden's Sigil", type: "unique", value: 50000, glow: true },

    // --- dyes (cosmetic; applied to dyeable armour, consumed) ---
    dye_crimson:   { name: "Crimson Dye", type: "dye", color: "#c0392b", value: 300 },
    dye_azure:     { name: "Azure Dye", type: "dye", color: "#2e6fd6", value: 300 },
    dye_emerald:   { name: "Emerald Dye", type: "dye", color: "#27a35a", value: 400 },
    dye_amber:     { name: "Amber Dye", type: "dye", color: "#e08a1e", value: 500 },
    dye_violet:    { name: "Violet Dye", type: "dye", color: "#8e44ad", value: 800 },
    dye_onyx:      { name: "Onyx Dye", type: "dye", color: "#1a1a1f", value: 2500, glow: true },
    dye_prismatic: { name: "Prismatic Dye", type: "dye", color: "prismatic", value: 30000, glow: true },
  };

  // ---------- content: enemies ----------
  // Each enemy has a signature secret unique (super rare -> global notify),
  // plus coins, materials, and a chance at dyes that gets richer with tier.
  const ENEMIES = {
    rat:      { name: "Giant Rat", level: 2,  hp: 6,   atk: 1,  def: 1,  maxHit: 1,  xp: 12,  color: "#7d7368",
      coins: [1, 4],   materials: [{ id: "rat_hide", min: 1, max: 2, chance: 0.7 }],
      dyes: [{ id: "dye_crimson", chance: 1/220 }, { id: "dye_azure", chance: 1/260 }],
      unique: { id: "rat_king_tail", chance: 1/450 } },
    goblin:   { name: "Goblin", level: 6,  hp: 15,  atk: 5,  def: 3,  maxHit: 2,  xp: 22,  color: "#5c8a3a",
      coins: [3, 10],  materials: [{ id: "goblin_ear", min: 1, max: 2, chance: 0.65 }],
      dyes: [{ id: "dye_azure", chance: 1/240 }, { id: "dye_emerald", chance: 1/300 }],
      unique: { id: "goblin_crown", chance: 1/600 } },
    skeleton: { name: "Skeleton", level: 14, hp: 30,  atk: 12, def: 9,  maxHit: 4,  xp: 44,  color: "#d8d6cf",
      coins: [8, 22],  materials: [{ id: "bone", min: 1, max: 3, chance: 0.8 }],
      dyes: [{ id: "dye_emerald", chance: 1/260 }, { id: "dye_amber", chance: 1/340 }],
      unique: { id: "cursed_skull", chance: 1/800 } },
    wolf:     { name: "Dire Wolf", level: 24, hp: 48,  atk: 22, def: 16, maxHit: 6,  xp: 76,  color: "#6b6f76",
      coins: [15, 40], materials: [{ id: "wolf_pelt", min: 1, max: 2, chance: 0.6 }],
      dyes: [{ id: "dye_amber", chance: 1/240 }, { id: "dye_violet", chance: 1/420 }],
      unique: { id: "alpha_fang", chance: 1/1000 } },
    golem:    { name: "Stone Golem", level: 40, hp: 90,  atk: 36, def: 34, maxHit: 9,  xp: 140, color: "#8a8f97",
      coins: [30, 80], materials: [{ id: "golem_core", min: 1, max: 1, chance: 0.5 }],
      dyes: [{ id: "dye_violet", chance: 1/260 }, { id: "dye_onyx", chance: 1/1400 }],
      unique: { id: "golem_heart", chance: 1/1200 } },
    wraith:   { name: "Wraith", level: 58, hp: 150, atk: 54, def: 48, maxHit: 13, xp: 240, color: "#9b8fd6",
      coins: [60, 150],materials: [{ id: "wraith_dust", min: 1, max: 2, chance: 0.55 }],
      dyes: [{ id: "dye_onyx", chance: 1/700 }, { id: "dye_prismatic", chance: 1/6000 }],
      unique: { id: "wraith_veil", chance: 1/1500 } },
  };

  // ---------- content: boss ----------
  const BOSS = {
    id: "molten_warden", name: "The Molten Warden", level: 80, hp: 200, atk: 64, def: 55, maxHit: 13,
    xp: 900, color: "#d8542a",
    coins: [300, 700],
    materials: [{ id: "molten_shard", min: 2, max: 5, chance: 1 }],
    // boss is the reliable path to endgame gear + the best dyes
    gear: [ // rolled as a group; each has its own chance
      { id: "warden_helm", chance: 1/22 },
      { id: "warden_legs", chance: 1/26 },
      { id: "warden_body", chance: 1/40 },
      { id: "warden_blade", chance: 1/45 },
    ],
    dyes: [{ id: "dye_onyx", chance: 1/14 }, { id: "dye_prismatic", chance: 1/700 }],
    unique: { id: "warden_sigil", chance: 1/120 }, // still global-notify worthy
  };
  const BOSS_PERIOD_MS = 60 * 1000;   // spawns every minute
  const BOSS_WINDOW_MS = 45 * 1000;   // killable for the first 45s of each minute

  function bossState(now) {
    now = now || Date.now();
    const into = now % BOSS_PERIOD_MS;
    const active = into < BOSS_WINDOW_MS;
    const spawnId = Math.floor(now / BOSS_PERIOD_MS); // identifies this spawn
    return {
      active, spawnId,
      msLeft: active ? BOSS_WINDOW_MS - into : 0,
      nextSpawnMs: active ? 0 : BOSS_PERIOD_MS - into,
    };
  }

  // ---------- tables ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_players (
      name_key TEXT PRIMARY KEY, name TEXT NOT NULL,
      coins INTEGER DEFAULT 0,
      skills_json TEXT NOT NULL, inventory_json TEXT NOT NULL, equipment_json TEXT NOT NULL,
      total_kills INTEGER DEFAULT 0, boss_kills INTEGER DEFAULT 0,
      last_boss_spawn INTEGER DEFAULT -1, last_action INTEGER DEFAULT 0,
      created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_feed (
      id TEXT PRIMARY KEY, name TEXT, item TEXT, item_name TEXT, source TEXT, kind TEXT, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_game_feed_ts ON game_feed (ts);
  `);

  // ---------- helpers ----------
  var SKILL_KEYS = ["attack", "strength", "defence", "hitpoints", "ranged", "magic"];
  function freshSkills() {
    return { attack: 0, strength: 0, defence: 0, hitpoints: START_HP_XP, ranged: 0, magic: 0 };
  }
  // tolerate older rows that predate ranged/magic
  function normSkills(s) {
    s = s || {};
    SKILL_KEYS.forEach(function (k) { if (typeof s[k] !== "number") s[k] = (k === "hitpoints" ? START_HP_XP : 0); });
    return s;
  }
  function getPlayer(name) {
    const row = db.prepare("SELECT * FROM game_players WHERE name_key = ?").get(name.toLowerCase());
    if (!row) return null;
    return {
      name: row.name, coins: row.coins,
      skills: JSON.parse(row.skills_json), inventory: JSON.parse(row.inventory_json),
      equipment: JSON.parse(row.equipment_json),
      totalKills: row.total_kills, bossKills: row.boss_kills,
      lastBossSpawn: row.last_boss_spawn, lastAction: row.last_action,
    };
  }
  function createPlayer(name) {
    const now = Date.now();
    const skills = freshSkills();
    const inventory = {};
    const equipment = { weapon: null, helmet: null, body: null, legs: null };
    db.prepare(
      `INSERT INTO game_players (name_key, name, coins, skills_json, inventory_json, equipment_json, created, updated)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(name.toLowerCase(), name, 0, JSON.stringify(skills), JSON.stringify(inventory), JSON.stringify(equipment), now, now);
    return getPlayer(name);
  }
  function savePlayer(name, p) {
    db.prepare(
      `UPDATE game_players SET coins=?, skills_json=?, inventory_json=?, equipment_json=?,
        total_kills=?, boss_kills=?, last_boss_spawn=?, last_action=?, updated=? WHERE name_key=?`
    ).run(p.coins, JSON.stringify(p.skills), JSON.stringify(p.inventory), JSON.stringify(p.equipment),
      p.totalKills, p.bossKills, p.lastBossSpawn, p.lastAction, Date.now(), name.toLowerCase());
  }
  function addItem(inv, id, qty) { inv[id] = (inv[id] || 0) + (qty || 1); }
  function removeItem(inv, id, qty) {
    if (!inv[id]) return false;
    inv[id] -= (qty || 1);
    if (inv[id] <= 0) delete inv[id];
    return true;
  }

  function skillLevels(skills) {
    skills = normSkills(skills);
    const out = {};
    SKILL_KEYS.forEach((k) => { out[k] = levelFromXp(skills[k]); });
    return out;
  }
  function combatLevel(lv) {
    // simplified OSRS combat level: base + best of the three attack styles
    const base = 0.25 * (lv.defence + lv.hitpoints);
    const melee = 0.325 * (lv.attack + lv.strength);
    const ranged = 0.325 * Math.floor(lv.ranged * 1.5);
    const magic = 0.325 * Math.floor(lv.magic * 1.5);
    return Math.floor(base + Math.max(melee, ranged, magic));
  }
  function equipBonuses(equipment) {
    let atk = 0, str = 0, def = 0, rng = 0, mag = 0;
    Object.keys(equipment).forEach((slot) => {
      const e = equipment[slot];
      if (!e || !e.item) return;
      const it = ITEMS[e.item];
      if (!it) return;
      atk += it.atk || 0; str += it.str || 0; def += it.def || 0; rng += it.rng || 0; mag += it.mag || 0;
    });
    return { atk, str, def, rng, mag };
  }
  // Combat profile for a given style ("melee" | "ranged" | "magic").
  function playerCombat(p, style) {
    style = style || "melee";
    const lv = skillLevels(p.skills);
    const bon = equipBonuses(p.equipment);
    let accuracy, maxHit;
    if (style === "ranged") {
      accuracy = lv.ranged + bon.rng + 6;
      maxHit = Math.max(1, Math.floor((lv.ranged + bon.rng) / 6) + 1);
    } else if (style === "magic") {
      accuracy = lv.magic + bon.mag + 6;
      maxHit = Math.max(1, Math.floor((lv.magic + bon.mag) / 6) + 1);
    } else {
      accuracy = lv.attack + bon.atk + 6;
      maxHit = Math.max(1, Math.floor((lv.strength + bon.str) / 6) + 1);
    }
    return {
      style, levels: lv,
      maxHit: maxHit, accuracy: accuracy,
      defence: lv.defence + bon.def + 6,
      maxHp: 10 + Math.max(0, lv.hitpoints - 10),
      combat: combatLevel(lv),
    };
  }
  function hitChance(att, def) {
    const a = att + 8, d = def + 8;
    return Math.max(0.05, Math.min(0.97, a / (a + d)));
  }
  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  // Resolve a full fight; returns hit sequence + whether the player won.
  function resolveFight(pc, foe) {
    let foeHp = foe.hp, myHp = pc.maxHp;
    const hits = [];
    let guard = 0;
    while (foeHp > 0 && myHp > 0 && guard++ < 300) {
      // player swings — a landed hit does at least 1, so fights stay punchy
      const pd = Math.random() < hitChance(pc.accuracy, foe.def) ? randInt(1, pc.maxHit) : 0;
      foeHp -= pd; if (foeHp < 0) foeHp = 0;
      hits.push({ by: "player", dmg: pd, foeHp });
      if (foeHp <= 0) break;
      // foe swings back
      const fd = Math.random() < hitChance(foe.atk, pc.defence) ? randInt(1, foe.maxHit) : 0;
      myHp -= fd; if (myHp < 0) myHp = 0;
      hits.push({ by: "foe", dmg: fd, myHp });
    }
    return { win: foeHp <= 0 && myHp > 0, hits, myHp, foeHp };
  }

  function rollLoot(def, p, feedRows, playerName, sourceName) {
    const loot = { coins: 0, items: [] };
    // coins
    loot.coins = randInt(def.coins[0], def.coins[1]);
    p.coins += loot.coins;
    // materials
    (def.materials || []).forEach((m) => {
      if (Math.random() < m.chance) {
        const q = randInt(m.min, m.max);
        addItem(p.inventory, m.id, q);
        loot.items.push({ id: m.id, name: ITEMS[m.id].name, qty: q, kind: "material" });
      }
    });
    // boss gear rolls
    (def.gear || []).forEach((g) => {
      if (Math.random() < g.chance) {
        addItem(p.inventory, g.id, 1);
        const entry = { id: g.id, name: ITEMS[g.id].name, qty: 1, kind: "gear", glow: !!ITEMS[g.id].glow };
        loot.items.push(entry);
        feedRows.push({ item: g.id, itemName: ITEMS[g.id].name, kind: "gear", name: playerName, source: sourceName });
      }
    });
    // dyes
    (def.dyes || []).forEach((d) => {
      if (Math.random() < d.chance) {
        addItem(p.inventory, d.id, 1);
        const rare = d.id === "dye_prismatic" || d.id === "dye_onyx";
        loot.items.push({ id: d.id, name: ITEMS[d.id].name, qty: 1, kind: "dye", glow: !!ITEMS[d.id].glow });
        if (rare) feedRows.push({ item: d.id, itemName: ITEMS[d.id].name, kind: "dye", name: playerName, source: sourceName });
      }
    });
    // signature unique — the super-rare, always global
    if (def.unique && Math.random() < def.unique.chance) {
      addItem(p.inventory, def.unique.id, 1);
      loot.items.push({ id: def.unique.id, name: ITEMS[def.unique.id].name, qty: 1, kind: "unique", glow: true });
      feedRows.push({ item: def.unique.id, itemName: ITEMS[def.unique.id].name, kind: "unique", name: playerName, source: sourceName });
    }
    return loot;
  }

  function grantXp(p, foeXp, style) {
    p.skills = normSkills(p.skills);
    let gains;
    if (style === "ranged") {
      gains = { ranged: Math.round(foeXp * 1.1), defence: Math.round(foeXp * 0.45), hitpoints: Math.round(foeXp * 0.33) };
    } else if (style === "magic") {
      gains = { magic: Math.round(foeXp * 1.1), defence: Math.round(foeXp * 0.45), hitpoints: Math.round(foeXp * 0.33) };
    } else {
      gains = { attack: Math.round(foeXp * 0.55), strength: Math.round(foeXp * 0.55), defence: Math.round(foeXp * 0.45), hitpoints: Math.round(foeXp * 0.33) };
    }
    const levelUps = [];
    Object.keys(gains).forEach((sk) => {
      const before = levelFromXp(p.skills[sk]);
      p.skills[sk] += gains[sk];
      const after = levelFromXp(p.skills[sk]);
      if (after > before) levelUps.push({ skill: sk, level: after });
    });
    return { gains, levelUps };
  }

  function pushFeed(rows) {
    if (!rows.length) return;
    const now = Date.now();
    const stmt = db.prepare("INSERT INTO game_feed (id, name, item, item_name, source, kind, ts) VALUES (?,?,?,?,?,?,?)");
    rows.forEach((r, i) => stmt.run(randomHex(8), r.name, r.item, r.itemName, r.source, r.kind, now + i));
    // keep the feed bounded
    db.prepare("DELETE FROM game_feed WHERE id NOT IN (SELECT id FROM game_feed ORDER BY ts DESC LIMIT 100)").run();
  }

  // Public snapshot of a player for the client
  function publicState(p) {
    const pcM = playerCombat(p, "melee");
    const pcR = playerCombat(p, "ranged");
    const pcMag = playerCombat(p, "magic");
    const sk = normSkills(p.skills);
    const skills = {};
    SKILL_KEYS.forEach((k) => { skills[k] = { xp: sk[k], level: pcM.levels[k] }; });
    return {
      name: p.name, coins: p.coins,
      skills: skills,
      combat: pcM.combat, maxHit: pcM.maxHit, maxHp: pcM.maxHp,
      // authoritative per-style numbers so the client can render live hits/misses
      combatStats: {
        melee: { acc: pcM.accuracy, maxHit: pcM.maxHit },
        ranged: { acc: pcR.accuracy, maxHit: pcR.maxHit },
        magic: { acc: pcMag.accuracy, maxHit: pcMag.maxHit },
        defence: pcM.defence,
      },
      inventory: p.inventory, equipment: p.equipment,
      totalKills: p.totalKills, bossKills: p.bossKills,
    };
  }

  // xp thresholds so the client can draw progress bars without the whole table
  function xpBar(xp) {
    const lvl = levelFromXp(xp);
    const cur = LEVEL_XP[lvl] || 0;
    const next = lvl >= MAX_LEVEL ? cur : LEVEL_XP[lvl + 1];
    return { level: lvl, xp, curBase: cur, nextAt: next };
  }
  function barsFor(p) {
    const sk = normSkills(p.skills);
    const bars = {};
    SKILL_KEYS.forEach((k) => { bars[k] = xpBar(sk[k]); });
    return bars;
  }

  // ================= routes =================

  // Static content the client renders from (single source of truth).
  app.get("/api/game/defs", (req, res) => {
    res.json({ items: ITEMS, enemies: ENEMIES, boss: BOSS, levelXp: LEVEL_XP });
  });

  // Full player state (auto-creates a player row on first call).
  app.get("/api/game/state", (req, res) => {
    const name = requireSession(req, res); if (!name) return;
    let p = getPlayer(name);
    if (!p) p = createPlayer(name);
    const st = publicState(p);
    st.bars = barsFor(p);
    res.json(st);
  });

  // World status: server clock + boss timer.
  app.get("/api/game/world", (req, res) => {
    const now = Date.now();
    res.json({ now, boss: bossState(now) });
  });

  // Global rare-drop feed (poll with ?since=<ts>).
  app.get("/api/game/feed", (req, res) => {
    const since = Number(req.query.since || 0);
    const rows = db.prepare(
      "SELECT name, item, item_name AS itemName, source, kind, ts FROM game_feed WHERE ts > ? ORDER BY ts ASC LIMIT 50"
    ).all(since);
    res.json({ now: Date.now(), events: rows });
  });

  // Attack a regular enemy or the boss. Server resolves the whole fight.
  app.post("/api/game/attack", (req, res) => {
    const name = requireSession(req, res); if (!name) return;
    let p = getPlayer(name); if (!p) p = createPlayer(name);

    const target = typeof req.body.target === "string" ? req.body.target : "";
    let style = typeof req.body.style === "string" ? req.body.style : "melee";
    if (["melee", "ranged", "magic"].indexOf(style) === -1) style = "melee";
    const isBoss = target === "boss";
    const def = isBoss ? BOSS : ENEMIES[target];
    if (!def) return res.status(400).json({ error: "No such enemy" });

    const now = Date.now();
    // anti-spam pacing (server-authoritative)
    const minGap = isBoss ? 0 : 550;
    if (now - p.lastAction < minGap) return res.status(429).json({ error: "Too fast" });

    if (isBoss) {
      const bs = bossState(now);
      if (!bs.active) return res.status(400).json({ error: "The boss isn't here right now." });
      if (p.lastBossSpawn === bs.spawnId) return res.status(400).json({ error: "You've already defeated the Warden this spawn." });
    }

    const pc = playerCombat(p, style);
    const foe = { hp: def.hp, atk: def.atk, def: def.def, maxHit: def.maxHit };
    const fight = resolveFight(pc, foe);
    p.lastAction = now;

    if (!fight.win) {
      savePlayer(name, p);
      return res.json({ result: "defeat", hits: fight.hits, maxHp: pc.maxHp, foeName: def.name });
    }

    // victory
    const feedRows = [];
    const xpRes = grantXp(p, def.xp, style);
    const loot = rollLoot(def, p, feedRows, p.name, def.name);
    p.totalKills += 1;
    if (isBoss) { p.bossKills += 1; p.lastBossSpawn = bossState(now).spawnId; }
    if (feedRows.length) pushFeed(feedRows);
    savePlayer(name, p);

    const st = publicState(p);
    st.bars = barsFor(p);
    res.json({
      result: "win", foeName: def.name, isBoss, style,
      hits: fight.hits, maxHp: pc.maxHp,
      xpGains: xpRes.gains, levelUps: xpRes.levelUps,
      loot, state: st,
      globalDrops: feedRows.map((r) => ({ item: r.item, itemName: r.itemName, kind: r.kind })),
    });
  });

  // Real-time kill: the client whittles an enemy's HP locally (so it can show
  // hit/miss/block and HP bars), then reports the kill here to be awarded.
  // Rate-limited per enemy so it can't be spammed faster than a real fight.
  app.post("/api/game/kill", (req, res) => {
    const name = requireSession(req, res); if (!name) return;
    let p = getPlayer(name); if (!p) p = createPlayer(name);
    const target = typeof req.body.target === "string" ? req.body.target : "";
    let style = typeof req.body.style === "string" ? req.body.style : "melee";
    if (["melee", "ranged", "magic"].indexOf(style) === -1) style = "melee";
    const isBoss = target === "boss";
    const def = isBoss ? BOSS : ENEMIES[target];
    if (!def) return res.status(400).json({ error: "No such enemy" });

    const now = Date.now();
    if (isBoss) {
      const bs = bossState(now);
      if (!bs.active) return res.status(400).json({ error: "The boss isn't here right now." });
      if (p.lastBossSpawn === bs.spawnId) return res.status(400).json({ error: "Already defeated this spawn." });
    } else {
      // loose floor tied to the enemy's toughness; won't throttle a fast legit kill
      const minGap = Math.max(250, Math.min(1000, Math.round(def.hp * 5)));
      if (now - p.lastAction < minGap) return res.status(429).json({ error: "Too fast" });
    }

    const feedRows = [];
    const xpRes = grantXp(p, def.xp, style);
    const loot = rollLoot(def, p, feedRows, p.name, def.name);
    p.totalKills += 1;
    p.lastAction = now;
    if (isBoss) { p.bossKills += 1; p.lastBossSpawn = bossState(now).spawnId; }
    if (feedRows.length) pushFeed(feedRows);
    savePlayer(name, p);

    const st = publicState(p);
    st.bars = barsFor(p);
    res.json({
      foeName: def.name, isBoss: isBoss, style: style,
      xpGains: xpRes.gains, levelUps: xpRes.levelUps,
      loot: loot, state: st,
      globalDrops: feedRows.map((r) => ({ item: r.item, itemName: r.itemName, kind: r.kind })),
    });
  });

  // Equip an item you own.
  app.post("/api/game/equip", (req, res) => {
    const name = requireSession(req, res); if (!name) return;
    const p = getPlayer(name); if (!p) return res.status(400).json({ error: "No player" });
    const itemId = typeof req.body.item === "string" ? req.body.item : "";
    const it = ITEMS[itemId];
    if (!it || (it.type !== "weapon" && it.type !== "armor")) return res.status(400).json({ error: "Can't equip that" });
    if (!p.inventory[itemId]) return res.status(400).json({ error: "You don't have that" });
    const slot = it.slot;
    // return the currently-equipped piece to the bag
    const cur = p.equipment[slot];
    if (cur && cur.item) addItem(p.inventory, cur.item, 1);
    removeItem(p.inventory, itemId, 1);
    p.equipment[slot] = { item: itemId, dye: null };
    savePlayer(name, p);
    res.json({ ok: true, state: publicState(p) });
  });

  app.post("/api/game/unequip", (req, res) => {
    const name = requireSession(req, res); if (!name) return;
    const p = getPlayer(name); if (!p) return res.status(400).json({ error: "No player" });
    const slot = typeof req.body.slot === "string" ? req.body.slot : "";
    if (!(slot in p.equipment)) return res.status(400).json({ error: "Bad slot" });
    const cur = p.equipment[slot];
    if (cur && cur.item) addItem(p.inventory, cur.item, 1);
    p.equipment[slot] = null;
    savePlayer(name, p);
    res.json({ ok: true, state: publicState(p) });
  });

  // Apply a dye to an equipped, dyeable armour piece (consumes the dye).
  app.post("/api/game/dye", (req, res) => {
    const name = requireSession(req, res); if (!name) return;
    const p = getPlayer(name); if (!p) return res.status(400).json({ error: "No player" });
    const slot = typeof req.body.slot === "string" ? req.body.slot : "";
    const dyeId = typeof req.body.dye === "string" ? req.body.dye : "";
    const dye = ITEMS[dyeId];
    if (!dye || dye.type !== "dye") return res.status(400).json({ error: "Not a dye" });
    if (!p.inventory[dyeId]) return res.status(400).json({ error: "You don't have that dye" });
    const eq = p.equipment[slot];
    if (!eq || !eq.item) return res.status(400).json({ error: "Nothing equipped there" });
    if (!ITEMS[eq.item].dyeable) return res.status(400).json({ error: "That piece can't be dyed" });
    removeItem(p.inventory, dyeId, 1);
    eq.dye = dyeId;
    savePlayer(name, p);
    res.json({ ok: true, state: publicState(p) });
  });

  // Strip a dye back off (does not refund the dye).
  app.post("/api/game/undye", (req, res) => {
    const name = requireSession(req, res); if (!name) return;
    const p = getPlayer(name); if (!p) return res.status(400).json({ error: "No player" });
    const slot = typeof req.body.slot === "string" ? req.body.slot : "";
    const eq = p.equipment[slot];
    if (eq && eq.item) { eq.dye = null; savePlayer(name, p); }
    res.json({ ok: true, state: publicState(p) });
  });

  // Shop buy.
  app.post("/api/game/buy", (req, res) => {
    const name = requireSession(req, res); if (!name) return;
    const p = getPlayer(name); if (!p) return res.status(400).json({ error: "No player" });
    const itemId = typeof req.body.item === "string" ? req.body.item : "";
    const it = ITEMS[itemId];
    if (!it || !it.buy) return res.status(400).json({ error: "Not for sale" });
    if (p.coins < it.buy) return res.status(400).json({ error: "Not enough coins" });
    p.coins -= it.buy;
    addItem(p.inventory, itemId, 1);
    savePlayer(name, p);
    res.json({ ok: true, state: publicState(p) });
  });

  // Sell an item from the bag for coins.
  app.post("/api/game/sell", (req, res) => {
    const name = requireSession(req, res); if (!name) return;
    const p = getPlayer(name); if (!p) return res.status(400).json({ error: "No player" });
    const itemId = typeof req.body.item === "string" ? req.body.item : "";
    let qty = Number(req.body.qty || 1); if (!(qty > 0)) qty = 1;
    const it = ITEMS[itemId];
    if (!it) return res.status(400).json({ error: "No such item" });
    const have = p.inventory[itemId] || 0;
    if (have < qty) qty = have;
    if (qty <= 0) return res.status(400).json({ error: "You don't have that" });
    removeItem(p.inventory, itemId, qty);
    const gained = (it.value || 0) * qty;
    p.coins += gained;
    savePlayer(name, p);
    res.json({ ok: true, gained, state: publicState(p) });
  });

  // Ground-coin pickup. The client scatters coins in the world and calls this
  // when you walk over one; the server decides the (small) amount and rate-
  // limits so it can't be spammed for infinite money.
  const lastPickup = {};
  app.post("/api/game/pickup", (req, res) => {
    const name = requireSession(req, res); if (!name) return;
    let p = getPlayer(name); if (!p) p = createPlayer(name);
    const now = Date.now();
    const key = name.toLowerCase();
    if (now - (lastPickup[key] || 0) < 220) return res.status(429).json({ error: "Too fast" });
    lastPickup[key] = now;
    const amount = randInt(1, 6);
    p.coins += amount;
    savePlayer(name, p);
    res.json({ amount: amount, coins: p.coins });
  });

  // Leaderboard (top by total level then kills).
  app.get("/api/game/leaderboard", (req, res) => {
    const rows = db.prepare("SELECT name, skills_json, total_kills, boss_kills FROM game_players").all();
    const board = rows.map((r) => {
      const s = JSON.parse(r.skills_json);
      const lv = skillLevels(s);
      const total = SKILL_KEYS.reduce((sum, k) => sum + lv[k], 0);
      return { name: r.name, totalLevel: total, combat: combatLevel(lv), kills: r.total_kills, bossKills: r.boss_kills };
    });
    board.sort((a, b) => b.totalLevel - a.totalLevel || b.kills - a.kills);
    res.json(board.slice(0, 25));
  });
};
