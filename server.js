const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const {
  usernameExists,
  createPlayer,
  verifyPassword,
  updateElo,
  getLeaderboard,
  getPlayer,
  recordMatch,
  getMatchHistory,
} = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const matchmakingQueue = [];
const activeGames = {};
const challengeCodes = {};
const deviceAccounts = {};

function generateQuestion() {
  const ops = ["+", "-", "*"];
  const op = ops[Math.floor(Math.random() * ops.length)];
  let a, b, answer;

  if (op === "+") {
    a = Math.floor(Math.random() * 80) + 10;
    b = Math.floor(Math.random() * 80) + 10;
    answer = a + b;
  } else if (op === "-") {
    a = Math.floor(Math.random() * 80) + 20;
    b = Math.floor(Math.random() * a) + 1;
    answer = a - b;
  } else {
    a = Math.floor(Math.random() * 10) + 3;
    b = Math.floor(Math.random() * 10) + 3;
    answer = a * b;
  }

  return { question: `${a} ${op} ${b}`, answer };
}

function calcEloChange(winnerElo, loserElo) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  return Math.round(K * (1 - expected));
}

function generateChallengeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (challengeCodes[code]);
  return code;
}

function startGame(p1, p2, timedMode) {
  const gameId = `${p1.socket.id}-${p2.socket.id}`;
  const question = generateQuestion();

  const game = {
    gameId,
    isPractice: false,
    roundLocked: false,
    timedMode: !!timedMode,
    spectators: new Set(),
    players: {
      [p1.socket.id]: { username: p1.username, elo: p1.elo, score: 0, answered: false, streak: 0 },
      [p2.socket.id]: { username: p2.username, elo: p2.elo, score: 0, answered: false, streak: 0 },
    },
    question,
    round: 1,
    maxScore: 5,
  };

  activeGames[gameId] = game;
  p1.socket.join(gameId);
  p2.socket.join(gameId);
  p1.socket.gameId = gameId;
  p2.socket.gameId = gameId;

  io.to(gameId).emit("game:start", {
    gameId,
    isPractice: false,
    timedMode: game.timedMode,
    opponent: {
      [p1.socket.id]: p2.username,
      [p2.socket.id]: p1.username,
    },
    question: question.question,
    round: 1,
    scores: {
      [p1.username]: 0,
      [p2.username]: 0,
    },
  });

  if (game.timedMode) queueRoundTimeout(gameId);

  console.log(`Game started: ${p1.username} vs ${p2.username}`);
}

function queueRoundTimeout(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  const roundAtSchedule = game.round;

  setTimeout(() => {
    const current = activeGames[gameId];
    if (!current) return;
    if (current.round !== roundAtSchedule) return;
    if (current.roundLocked) return;

    current.roundLocked = true;
    io.to(gameId).emit("game:timeout", {
      question: current.question.question,
      answer: current.question.answer,
    });

    setTimeout(() => nextRound(gameId), 1500);
  }, 6000);
}

function nextRound(gameId) {
  const game = activeGames[gameId];
  if (!game) return;

  game.roundLocked = false;

  for (const pid in game.players) {
    game.players[pid].answered = false;
  }

  game.question = generateQuestion();
  game.round++;

  io.to(gameId).emit("game:round", {
    question: game.question.question,
    round: game.round,
    scores: Object.fromEntries(
      Object.values(game.players).map((p) => [p.username, p.score])
    ),
  });

  if (game.isPractice) queueCpuMove(gameId);
  if (game.timedMode) queueRoundTimeout(gameId);
}

function endGame(gameId, winnerSocketId) {
  const game = activeGames[gameId];
  if (!game) return;

  if (game.isPractice) {
    const winner = game.players[winnerSocketId];
    const humanId = Object.keys(game.players).find((id) => id !== game.cpuSocketId);
    const human = game.players[humanId];

    io.to(gameId).emit("game:over", {
      isPractice: true,
      winner: winner.username,
      eloChange: 0,
      players: {},
    });

    recordMatch(human.username, winner.username, winner.username, 0, true);
    delete activeGames[gameId];
    console.log(`Practice game ended - winner: ${winner.username}`);
    return;
  }

  const playerIds = Object.keys(game.players);
  const loserId = playerIds.find((id) => id !== winnerSocketId);
  const winner = game.players[winnerSocketId];
  const loser = game.players[loserId];

  const baseEloChange = calcEloChange(winner.elo, loser.elo);
  const winnerSocket = [...io.sockets.sockets.values()].find(s => s.username === winner.username);
  const loserSocket = [...io.sockets.sockets.values()].find(s => s.username === loser.username);

  const isFarming = winnerSocket?.deviceId &&
    loserSocket?.deviceId &&
    winnerSocket.deviceId === loserSocket.deviceId;

  const eloChange = isFarming ? 0 : baseEloChange;
  if (isFarming) {
    console.log(`ELO farming detected: ${winner.username} vs ${loser.username} on same device — no ELO awarded`);
  }

  updateElo(winner.username, +eloChange, true);
  updateElo(loser.username, -eloChange, false);

  const winnerFinal = getPlayer(winner.username);
  const loserFinal = getPlayer(loser.username);

  io.to(gameId).emit("game:over", {
    isPractice: false,
    winner: winner.username,
    eloChange,
    players: {
      [winner.username]: { ...winnerFinal },
      [loser.username]: { ...loserFinal },
    },
  });

  recordMatch(winner.username, loser.username, winner.username, eloChange, false);
  delete activeGames[gameId];
  console.log(`${winner.username} beat ${loser.username} (+${eloChange} ELO)`);
}

// ─── Practice Mode ────────────────────────────────────────────────────────────

const CPU_NAMES = ["Botzilla", "Calcula-tron", "Sir Add-a-lot", "Mathy McMathface", "Glitch", "Numberwang"];

const CPU_DIFFICULTY = {
  easy:   { minDelay: 4000, maxDelay: 7000, accuracy: 0.50 },
  medium: { minDelay: 2500, maxDelay: 4500, accuracy: 0.70 },
  hard:   { minDelay: 1500, maxDelay: 3000, accuracy: 0.90 },
};

function startPracticeGame(socket, difficulty) {
  const diff = CPU_DIFFICULTY[difficulty] || CPU_DIFFICULTY.medium;
  const cpuName = CPU_NAMES[Math.floor(Math.random() * CPU_NAMES.length)];
  const gameId = `practice-${socket.id}`;
  const question = generateQuestion();
  const cpuId = "cpu-" + socket.id;

  const game = {
    gameId,
    isPractice: true,
    roundLocked: false,
    timedMode: false,
    cpuName,
    cpuSocketId: cpuId,
    cpuDiff: diff,
    players: {
      [socket.id]: { username: socket.username, elo: socket.elo, score: 0, answered: false, streak: 0 },
      [cpuId]: { username: cpuName, score: 0, answered: false, streak: 0 },
    },
    question,
    round: 1,
    maxScore: 5,
  };

  activeGames[gameId] = game;
  socket.gameId = gameId;
  socket.join(gameId);

  socket.emit("game:start", {
    gameId,
    isPractice: true,
    timedMode: false,
    opponent: { [socket.id]: cpuName },
    question: question.question,
    round: 1,
    scores: { [socket.username]: 0, [cpuName]: 0 },
  });

  queueCpuMove(gameId);
  console.log(`Practice game started: ${socket.username} vs ${cpuName} (${difficulty})`);
}

function queueCpuMove(gameId) {
  const game = activeGames[gameId];
  if (!game || !game.isPractice) return;

  const { minDelay, maxDelay, accuracy } = game.cpuDiff;
  const delay = minDelay + Math.random() * (maxDelay - minDelay);
  const roundAtSchedule = game.round;

  setTimeout(() => {
    const current = activeGames[gameId];
    if (!current) return;
    if (current.round !== roundAtSchedule) return;
    if (current.roundLocked) return;

    const cpu = current.players[current.cpuSocketId];
    if (!cpu || cpu.answered) return;

    const willBeCorrect = Math.random() < accuracy;
    cpu.answered = true;

    if (willBeCorrect) {
      current.roundLocked = true;
      cpu.score++;
      cpu.streak = (cpu.streak || 0) + 1;

      const humanId = Object.keys(current.players).find((id) => id !== current.cpuSocketId);
      current.players[humanId].streak = 0;

      const scores = Object.fromEntries(
        Object.values(current.players).map((p) => [p.username, p.score])
      );
      io.to(gameId).emit("game:point", {
        scorer: cpu.username,
        scores,
        streak: cpu.streak,
      });

      if (cpu.score >= current.maxScore) {
        endGame(gameId, current.cpuSocketId);
      } else {
        setTimeout(() => nextRound(gameId), 1200);
      }
    }
  }, delay);
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on("auth:signup", ({ username, password, avatar, deviceId }) => {
    const trimmed = (username || "").trim();
    const pass = (password || "").trim();

    if (trimmed.length < 2) {
      return socket.emit("auth:error", { message: "Username must be at least 2 characters!" });
    }
    if (pass.length < 4) {
      return socket.emit("auth:error", { message: "Password must be at least 4 characters!" });
    }
    if (usernameExists(trimmed)) {
      return socket.emit("auth:error", { message: "That username is already taken!" });
    }

    const player = createPlayer(trimmed, pass, avatar);
    socket.username = player.username;
    socket.elo = player.elo;
    socket.deviceId = deviceId;

    if (deviceId) {
      if (!deviceAccounts[deviceId]) deviceAccounts[deviceId] = new Set();
      deviceAccounts[deviceId].add(trimmed);
    }

    socket.emit("auth:success", player);
    console.log(`New account created: ${trimmed}`);
  });

  socket.on("auth:login", ({ username, password, deviceId }) => {
    const trimmed = (username || "").trim();
    const pass = (password || "").trim();

    if (!usernameExists(trimmed)) {
      return socket.emit("auth:error", { message: "No account with that username. Sign up instead!" });
    }
    if (!verifyPassword(trimmed, pass)) {
      return socket.emit("auth:error", { message: "Wrong password!" });
    }

    const player = getPlayer(trimmed);
    socket.username = player.username;
    socket.elo = player.elo;
    socket.deviceId = deviceId;

    if (deviceId) {
      if (!deviceAccounts[deviceId]) deviceAccounts[deviceId] = new Set();
      deviceAccounts[deviceId].add(trimmed);
      socket.altAccountFlag = deviceAccounts[deviceId].size > 1;
    }

    socket.emit("auth:success", player);
    console.log(`${trimmed} logged in${socket.altAccountFlag ? " [ALT ACCOUNT]" : ""}`);
  });

  socket.on("player:leaderboard", () => {
    socket.emit("leaderboard:data", getLeaderboard());
  });

  socket.on("player:history", () => {
    if (!socket.username) return;
    socket.emit("history:data", getMatchHistory(socket.username, 10));
  });

  socket.on("matchmaking:join", () => {
    const username = socket.username;
    if (!username) return;
    if (matchmakingQueue.find((p) => p.socket.id === socket.id)) return;

    matchmakingQueue.push({ socket, username, elo: socket.elo });
    socket.emit("matchmaking:waiting");
    console.log(`${username} joined matchmaking queue (${matchmakingQueue.length} in queue)`);

    if (matchmakingQueue.length >= 2) {
      const p1 = matchmakingQueue.shift();
      const p2 = matchmakingQueue.shift();
      startGame(p1, p2, true);
    }
  });

  socket.on("matchmaking:cancel", () => {
    const idx = matchmakingQueue.findIndex((p) => p.socket.id === socket.id);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);
    console.log(`${socket.username} left queue`);
  });

  socket.on("practice:start", ({ difficulty }) => {
    if (!socket.username) return;
    startPracticeGame(socket, difficulty);
  });

  // ─── Friend Challenges ────────────────────────────────────────────────────

  socket.on("challenge:create", () => {
    if (!socket.username) return;
    const code = generateChallengeCode();
    challengeCodes[code] = { socket, username: socket.username, elo: socket.elo };
    socket.challengeCode = code;
    socket.emit("challenge:created", { code });
    console.log(`${socket.username} created challenge code ${code}`);
  });

  socket.on("challenge:cancel", () => {
    if (socket.challengeCode && challengeCodes[socket.challengeCode]) {
      delete challengeCodes[socket.challengeCode];
      socket.challengeCode = null;
    }
  });

  socket.on("challenge:join", ({ code }) => {
    if (!socket.username) return;
    const trimmedCode = (code || "").trim().toUpperCase();
    const challenge = challengeCodes[trimmedCode];

    if (!challenge) {
      return socket.emit("challenge:error", { message: "Invalid or expired code!" });
    }
    if (challenge.socket.id === socket.id) {
      return socket.emit("challenge:error", { message: "You can't challenge yourself!" });
    }

    delete challengeCodes[trimmedCode];
    const p1 = { socket: challenge.socket, username: challenge.username, elo: challenge.elo };
    const p2 = { socket, username: socket.username, elo: socket.elo };
    startGame(p1, p2, true);
  });

  // ─── Spectator Mode ───────────────────────────────────────────────────────

  socket.on("spectate:list", () => {
    const liveGames = Object.values(activeGames)
      .filter((g) => !g.isPractice)
      .map((g) => {
        const [p1, p2] = Object.values(g.players);
        return {
          gameId: g.gameId,
          player1: p1.username,
          player2: p2.username,
          score1: p1.score,
          score2: p2.score,
          round: g.round,
        };
      });
    socket.emit("spectate:list:data", liveGames);
  });

  socket.on("spectate:join", ({ gameId }) => {
    if (!socket.username) return;
    const game = activeGames[gameId];
    if (!game || game.isPractice) {
      return socket.emit("spectate:error", { message: "That match has ended." });
    }
    if (game.players[socket.id]) {
      return socket.emit("spectate:error", { message: "You can't spectate your own match!" });
    }

    game.spectators.add(socket.id);
    socket.spectatingGameId = gameId;
    socket.join(gameId);

    const [p1, p2] = Object.values(game.players);
    socket.emit("spectate:joined", {
      gameId,
      player1: p1.username,
      player2: p2.username,
      score1: p1.score,
      score2: p2.score,
      question: game.question.question,
      round: game.round,
    });

    console.log(`${socket.username} is now spectating ${gameId}`);
  });

  socket.on("spectate:leave", () => {
    const gameId = socket.spectatingGameId;
    if (gameId && activeGames[gameId]) {
      activeGames[gameId].spectators.delete(socket.id);
      socket.leave(gameId);
    }
    socket.spectatingGameId = null;
  });

  // ─── Gameplay ─────────────────────────────────────────────────────────────

  socket.on("game:answer", ({ answer }) => {
    const gameId = socket.gameId;
    if (!gameId) return;
    const game = activeGames[gameId];
    if (!game) {
      console.log(`Answer arrived after game already ended - ignoring`);
      return;
    }
    if (game.roundLocked) return;

    const player = game.players[socket.id];
    if (!player || player.answered) {
      console.log(`Ignored duplicate/late answer from ${socket.username}`);
      return;
    }

    player.answered = true;
    const correct = parseInt(answer) === game.question.answer;
    console.log(`Q: "${game.question.question}" = ${game.question.answer} | Got: "${answer}" | Correct: ${correct}`);

    if (correct) {
      game.roundLocked = true;
      player.score++;
      player.streak = (player.streak || 0) + 1;

      const opponentId = Object.keys(game.players).find((id) => id !== socket.id);
      if (opponentId) game.players[opponentId].streak = 0;

      const scores = Object.fromEntries(
        Object.values(game.players).map((p) => [p.username, p.score])
      );

      io.to(gameId).emit("game:point", {
        scorer: player.username,
        scores,
        streak: player.streak,
      });

      if (player.score >= game.maxScore) {
        endGame(gameId, socket.id);
      } else {
        setTimeout(() => nextRound(gameId), 1200);
      }
    } else {
      player.streak = 0;
      socket.emit("game:wrong");
    }
  });

  socket.on("disconnect", () => {
    const idx = matchmakingQueue.findIndex((p) => p.socket.id === socket.id);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);

    if (socket.challengeCode && challengeCodes[socket.challengeCode]) {
      delete challengeCodes[socket.challengeCode];
    }

    if (socket.spectatingGameId && activeGames[socket.spectatingGameId]) {
      activeGames[socket.spectatingGameId].spectators.delete(socket.id);
    }

    const gameId = socket.gameId;
    if (gameId && activeGames[gameId]) {
      const game = activeGames[gameId];
      if (!game.isPractice) {
        const remainingId = Object.keys(game.players).find((id) => id !== socket.id);
        if (remainingId) {
          const winner = game.players[remainingId];
          const loser = game.players[socket.id];
          const eloChange = calcEloChange(winner.elo, loser.elo);
          updateElo(winner.username, +eloChange, true);
          updateElo(loser.username, -eloChange, false);
          recordMatch(winner.username, loser.username, winner.username, eloChange, false);
          io.to(remainingId).emit("game:opponent_disconnected", { eloChange });
        }
      }
      delete activeGames[gameId];
    }

    console.log(`Disconnected: ${socket.id}`);
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Math Duel server running at http://localhost:${PORT}`);
});