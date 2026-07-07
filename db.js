const Database = require("better-sqlite3");
const crypto = require("crypto");
const db = new Database("mathduel.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar TEXT DEFAULT '🧮',
    elo INTEGER DEFAULT 1000,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migration: add avatar column if upgrading from an older DB that lacks it
try {
  db.exec(`ALTER TABLE players ADD COLUMN avatar TEXT DEFAULT '🧮'`);
} catch (e) {
  // Column already exists, ignore
}

db.exec(`
  CREATE TABLE IF NOT EXISTS match_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player1 TEXT NOT NULL,
    player2 TEXT NOT NULL,
    winner TEXT NOT NULL,
    elo_change INTEGER DEFAULT 0,
    is_practice INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function usernameExists(username) {
  const player = db.prepare("SELECT id FROM players WHERE username = ?").get(username);
  return !!player;
}

function createPlayer(username, password, avatar) {
  const hash = hashPassword(password);
  db.prepare("INSERT INTO players (username, password_hash, avatar) VALUES (?, ?, ?)").run(username, hash, avatar || "🧮");
  return getPlayer(username);
}

function verifyPassword(username, password) {
  const player = db.prepare("SELECT * FROM players WHERE username = ?").get(username);
  if (!player) return false;
  return player.password_hash === hashPassword(password);
}

function updateElo(username, deltaElo, won) {
  db.prepare(`
    UPDATE players
    SET elo = elo + ?,
        wins = wins + ?,
        losses = losses + ?
    WHERE username = ?
  `).run(deltaElo, won ? 1 : 0, won ? 0 : 1, username);
}

function getLeaderboard() {
  return db.prepare(`
    SELECT username, avatar, elo, wins, losses,
      CASE WHEN (wins + losses) > 0
        THEN ROUND(wins * 100.0 / (wins + losses), 1)
        ELSE 0
      END as winrate
    FROM players
    ORDER BY elo DESC
    LIMIT 20
  `).all();
}

function getPlayer(username) {
  return db.prepare("SELECT id, username, avatar, elo, wins, losses, created_at FROM players WHERE username = ?").get(username);
}

function recordMatch(player1, player2, winner, eloChange, isPractice) {
  db.prepare(`
    INSERT INTO match_history (player1, player2, winner, elo_change, is_practice)
    VALUES (?, ?, ?, ?, ?)
  `).run(player1, player2, winner, eloChange, isPractice ? 1 : 0);
}

function getMatchHistory(username, limit = 10) {
  return db.prepare(`
    SELECT player1, player2, winner, elo_change, is_practice, created_at
    FROM match_history
    WHERE player1 = ? OR player2 = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(username, username, limit);
}

module.exports = {
  usernameExists,
  createPlayer,
  verifyPassword,
  updateElo,
  getLeaderboard,
  getPlayer,
  recordMatch,
  getMatchHistory,
};