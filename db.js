const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT DEFAULT '🧮',
      elo INTEGER DEFAULT 1000,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_history (
      id SERIAL PRIMARY KEY,
      player1 TEXT NOT NULL,
      player2 TEXT NOT NULL,
      winner TEXT NOT NULL,
      elo_change INTEGER DEFAULT 0,
      is_practice BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

init().then(() => console.log("Database ready")).catch(console.error);

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

async function usernameExists(username) {
  const res = await pool.query("SELECT id FROM players WHERE username = $1", [username]);
  return res.rows.length > 0;
}

async function createPlayer(username, password, avatar) {
  const hash = hashPassword(password);
  await pool.query(
    "INSERT INTO players (username, password_hash, avatar) VALUES ($1, $2, $3)",
    [username, hash, avatar || "🧮"]
  );
  return getPlayer(username);
}

async function verifyPassword(username, password) {
  const res = await pool.query("SELECT password_hash FROM players WHERE username = $1", [username]);
  if (res.rows.length === 0) return false;
  return res.rows[0].password_hash === hashPassword(password);
}

async function updateElo(username, deltaElo, won) {
  await pool.query(`
    UPDATE players
    SET elo = elo + $1,
        wins = wins + $2,
        losses = losses + $3
    WHERE username = $4
  `, [deltaElo, won ? 1 : 0, won ? 0 : 1, username]);
}

async function getLeaderboard() {
  const res = await pool.query(`
    SELECT username, avatar, elo, wins, losses,
      CASE WHEN (wins + losses) > 0
        THEN ROUND(wins * 100.0 / (wins + losses), 1)
        ELSE 0
      END as winrate
    FROM players
    ORDER BY elo DESC
    LIMIT 20
  `);
  return res.rows;
}

async function getPlayer(username) {
  const res = await pool.query(
    "SELECT id, username, avatar, elo, wins, losses, created_at FROM players WHERE username = $1",
    [username]
  );
  return res.rows[0] || null;
}

async function recordMatch(player1, player2, winner, eloChange, isPractice) {
  await pool.query(`
    INSERT INTO match_history (player1, player2, winner, elo_change, is_practice)
    VALUES ($1, $2, $3, $4, $5)
  `, [player1, player2, winner, eloChange, isPractice]);
}

async function getMatchHistory(username, limit = 10) {
  const res = await pool.query(`
    SELECT player1, player2, winner, elo_change, is_practice, created_at
    FROM match_history
    WHERE player1 = $1 OR player2 = $1
    ORDER BY id DESC
    LIMIT $2
  `, [username, limit]);
  return res.rows;
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