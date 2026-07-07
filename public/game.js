const socket = io();

let deviceId = localStorage.getItem("mathduel_device_id");
if (!deviceId) {
  deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem("mathduel_device_id", deviceId);
}

let myUsername = "";
let myAvatar = "🧮";
let currentGameId = "";
let opponentName = "";
let answered = false;
let isPracticeGame = false;
let authMode = "login";
let selectedAvatar = "🧮";
let timerInterval = null;

const AVATAR_OPTIONS = ["🧮", "🦊", "🐙", "🦖", "🐸", "🦉", "🐲", "🤖"];
const TIMER_CIRCUMFERENCE = 2 * Math.PI * 26;

// ─── Sound Effects ───────────────────────────────────────────────────────────

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, duration, type = "sine", volume = 0.15) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = volume;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}

function playCorrectSound() {
  playTone(523.25, 0.12, "sine", 0.15);
  setTimeout(() => playTone(659.25, 0.15, "sine", 0.15), 90);
}
function playWrongSound() { playTone(150, 0.25, "sawtooth", 0.1); }
function playWinSound() {
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => setTimeout(() => playTone(freq, 0.2, "sine", 0.18), i * 110));
}
function playLoseSound() {
  [392, 349.23, 293.66].forEach((freq, i) => setTimeout(() => playTone(freq, 0.3, "triangle", 0.12), i * 150));
}
function playTickSound() { playTone(800, 0.05, "square", 0.06); }

// ─── Screen Routing ─────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function toast(msg, duration = 2600) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), duration);
}

// ─── Avatar Picker ───────────────────────────────────────────────────────────handleAuthSubmit

function renderAvatarGrid() {
  const grid = document.getElementById("avatar-grid");
  grid.innerHTML = AVATAR_OPTIONS.map((a) =>
    `<button type="button" class="avatar-option ${a === selectedAvatar ? "selected" : ""}" data-avatar="${a}" onclick="selectAvatar('${a}')">${a}</button>`
  ).join("");
}

function selectAvatar(avatar) {
  selectedAvatar = avatar;
  renderAvatarGrid();
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function switchAuthTab(mode) {
  authMode = mode;
  document.getElementById("tab-login").classList.toggle("active", mode === "login");
  document.getElementById("tab-signup").classList.toggle("active", mode === "signup");
  document.getElementById("auth-submit-btn").textContent = mode === "login" ? "Log In 🏟️" : "Sign Up 🏟️";
  document.getElementById("auth-hint").textContent =
    mode === "login" ? `Don't have an account? Click "Sign Up" above.` : `Already have an account? Click "Log In" above.`;

  const avatarWrap = document.getElementById("avatar-picker-wrap");
  if (mode === "signup") {
    avatarWrap.style.display = "block";
    renderAvatarGrid();
  } else {
    avatarWrap.style.display = "none";
  }
}

function handleAuthSubmit() {
  const username = document.getElementById("username-input").value.trim();
  const password = document.getElementById("password-input").value.trim();

  if (!username || username.length < 2) return toast("😬 Username must be at least 2 characters");
  if (!password || password.length < 4) return toast("😬 Password must be at least 4 characters");

  if (authMode === "login") {
    socket.emit("auth:login", { username, password, deviceId });
  } else {
    socket.emit("auth:signup", { username, password, avatar: selectedAvatar, deviceId });
  }
}

socket.on("auth:success", (player) => {
  myUsername = player.username;
  myAvatar = player.avatar || "🧮";
  document.getElementById("menu-username").textContent = myUsername;
  document.getElementById("menu-elo").textContent = `⚡ ${player.elo} ELO`;
  document.getElementById("menu-avatar").textContent = myAvatar;
  document.getElementById("password-input").value = "";
  toast(`👋 Welcome, ${myUsername}!`);
  showScreen("screen-menu");
});

socket.on("auth:error", ({ message }) => toast(`🚫 ${message}`));

function handleLogout() {
  myUsername = "";
  document.title = "Math Duel ⚡";
  document.getElementById("username-input").value = "";
  document.getElementById("password-input").value = "";
  switchAuthTab("login");
  showScreen("screen-login");
}

// ─── Matchmaking ─────────────────────────────────────────────────────────────

function joinMatchmaking() {
  if (!myUsername) return toast("Please log in first!");
  socket.emit("matchmaking:join");
  showScreen("screen-matchmaking");
}

function cancelMatchmaking() {
  socket.emit("matchmaking:cancel");
  showScreen("screen-menu");
}

socket.on("matchmaking:waiting", () => {});

// ─── Practice Mode ───────────────────────────────────────────────────────────

function startPractice(difficulty) {
  if (!myUsername) return toast("Please log in first!");
  socket.emit("practice:start", { difficulty });
}

// ─── Friend Challenges ───────────────────────────────────────────────────────

function createChallenge() {
  console.log("createChallenge() called. myUsername =", myUsername);
  if (!myUsername) {
    console.log("BLOCKED - myUsername is empty");
    return toast("Please log in first!");
  }
  console.log("Emitting challenge:create now");
  socket.emit("challenge:create");
}

socket.on("challenge:created", ({ code }) => {
  document.getElementById("challenge-code-display").textContent = code;
  showScreen("screen-challenge-waiting");
});

function cancelChallenge() {
  socket.emit("challenge:cancel");
  showScreen("screen-challenge-menu");
}

function joinChallenge() {
  const code = document.getElementById("join-code-input").value.trim().toUpperCase();
  if (code.length !== 5) return toast("😬 Enter a valid 5-character code");
  socket.emit("challenge:join", { code });
}

socket.on("challenge:error", ({ message }) => toast(`🚫 ${message}`));

// ─── Timer Ring (Time Pressure Mode) ─────────────────────────────────────────

function startTimerRing(seconds) {
  const ring = document.getElementById("timer-ring");
  const fg = document.getElementById("timer-ring-fg");
  ring.style.display = "block";
  fg.style.strokeDasharray = `${TIMER_CIRCUMFERENCE}`;
  fg.style.strokeDashoffset = "0";

  let elapsed = 0;
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    elapsed += 0.1;
    const fraction = Math.min(elapsed / seconds, 1);
    fg.style.strokeDashoffset = `${TIMER_CIRCUMFERENCE * fraction}`;
    if (fraction >= 1) clearInterval(timerInterval);
  }, 100);
}

function stopTimerRing() {
  clearInterval(timerInterval);
  document.getElementById("timer-ring").style.display = "none";
}

// ─── Game ────────────────────────────────────────────────────────────────────

socket.on("game:start", (data) => {
  currentGameId = data.gameId;
  opponentName = data.opponent[socket.id];
  answered = false;
  isPracticeGame = !!data.isPractice;

  document.getElementById("game-you-name").innerHTML =
    "You" + (isPracticeGame ? `<span class="practice-tag">Practice</span>` : "");
  document.getElementById("game-opp-name").textContent = opponentName;
  document.getElementById("game-you-score").textContent = "0";
  document.getElementById("game-opp-score").textContent = "0";
  document.getElementById("question-display").textContent = data.question;
  document.getElementById("round-badge").textContent = `Round 1 · First to 5 wins 🏆`;
  document.getElementById("feedback-msg").textContent = "";
  document.getElementById("answer-input").value = "";
  document.getElementById("answer-input").disabled = false;

  if (data.timedMode) startTimerRing(6);
  else stopTimerRing();

  toast(isPracticeGame ? `🤖 Facing ${opponentName} — good luck!` : `⚔️ VS ${opponentName} — Fight!`, 2000);
 document.title = won ? "🏆 You Won! — Math Duel" : "😭 You Lost — Math Duel";
  setTimeout(() => { document.title = "Math Duel ⚡"; }, 5000);
  showScreen("screen-game");
  document.getElementById("answer-input").focus();
});

socket.on("game:round", (data) => {
  if (spectatingGameId) {
    document.getElementById("spec-question-display").textContent = data.question;
    document.getElementById("spec-round-badge").textContent = `Round ${data.round}`;
    return;
  }
  answered = false;
  document.getElementById("question-display").textContent = data.question;
  document.getElementById("game-you-score").textContent = data.scores[myUsername] ?? 0;
  document.getElementById("game-opp-score").textContent = data.scores[opponentName] ?? 0;
  document.getElementById("round-badge").textContent = `Round ${data.round} · First to 5 wins 🏆`;
  document.getElementById("feedback-msg").textContent = "";
  document.getElementById("feedback-msg").className = "feedback-msg";
  document.getElementById("answer-input").value = "";
  document.getElementById("answer-input").disabled = false;
  document.getElementById("answer-input").focus();

  if (document.getElementById("timer-ring").style.display === "block") {
    startTimerRing(6);
  }
});

socket.on("game:timeout", (data) => {
  stopTimerRing();
  const fb = document.getElementById("feedback-msg");
  fb.textContent = `⏰ Time's up! Answer was ${data.answer}`;
  fb.className = "feedback-msg wrong";
  document.getElementById("answer-input").disabled = true;
  playWrongSound();
});

socket.on("game:point", (data) => {
  if (spectatingGameId) {
    document.getElementById("spec-p1-score").textContent =
      data.scores[document.getElementById("spec-p1-name").textContent] ?? 0;
    document.getElementById("spec-p2-score").textContent =
      data.scores[document.getElementById("spec-p2-name").textContent] ?? 0;
    return;
  }
  document.getElementById("game-you-score").textContent = data.scores[myUsername] ?? 0;
  document.getElementById("game-opp-score").textContent = data.scores[opponentName] ?? 0;

  const boxId = data.scorer === myUsername ? "game-you-score" : "game-opp-score";
  const scoreEl = document.getElementById(boxId);
  scoreEl.classList.add("bump");
  setTimeout(() => scoreEl.classList.remove("bump"), 250);

  const body = document.body;
  const fb = document.getElementById("feedback-msg");
  stopTimerRing();

  if (data.scorer === myUsername) {
    playCorrectSound();
    fb.textContent = "✅ Correct! Point scored!";
    fb.className = "feedback-msg correct";
    body.style.setProperty("--flash-color", "rgba(94,242,196,0.25)");
    body.classList.add("flash-correct");
    setTimeout(() => body.classList.remove("flash-correct"), 600);
    if (data.streak && data.streak >= 3) toast(`🔥 ${data.streak} in a row! You're on fire!`, 2200);
  } else {
    playWrongSound();
    fb.textContent = `😤 ${opponentName} got that one!`;
    fb.className = "feedback-msg wrong";
    body.style.setProperty("--flash-color", "rgba(255,107,91,0.2)");
    body.classList.add("flash-wrong");
    setTimeout(() => body.classList.remove("flash-wrong"), 600);
    if (data.streak && data.streak >= 3) toast(`⚠️ ${opponentName} is on a ${data.streak}-streak!`, 2200);
  }
  document.getElementById("answer-input").disabled = true;
});

socket.on("game:wrong", () => {
  playWrongSound();
  const fb = document.getElementById("feedback-msg");
  fb.textContent = "❌ Wrong! Try again...";
  fb.className = "feedback-msg wrong";
  document.getElementById("answer-input").value = "";
  document.getElementById("answer-input").focus();
  answered = false;
});

socket.on("game:over", (data) => {
  if (spectatingGameId) {
    toast(`🏆 ${data.winner} won the match!`, 3000);
    spectatingGameId = null;
    showScreen("screen-menu");
    return;
  }
  stopTimerRing();
  document.title = won ? "🏆 You Won! — Math Duel" : "😭 You Lost — Math Duel";
  setTimeout(() => { document.title = "Math Duel ⚡"; }, 5000);
  const won = data.winner === myUsername;

  if (won) playWinSound();
  else playLoseSound();

  document.getElementById("result-emoji").textContent = won ? "🏆" : "😭";
  document.getElementById("result-title").textContent = won ? "You Win!" : "You Lose!";
  document.getElementById("result-title").className = `result-title ${won ? "win" : "lose"}`;

if (data.isPractice) {
    document.getElementById("result-elo").textContent = won ? "Nice! No ELO at stake 🤖" : "Rematch the bot? 🤖";
    document.getElementById("result-elo").className = `result-elo ${won ? "gain" : "loss"}`;
    document.getElementById("elo-display-card").style.display = "none";
    document.getElementById("share-btn").style.display = "none";
  } else {
    const myData = data.players[myUsername];
    const eloText = won ? `+${data.eloChange} ELO` : `-${data.eloChange} ELO`;
    document.getElementById("result-elo").textContent = eloText;
    document.getElementById("result-elo").className = `result-elo ${won ? "gain" : "loss"}`;
    document.getElementById("new-elo-display").textContent = myData?.elo ?? "—";
    document.getElementById("elo-display-card").style.display = "block";
    document.getElementById("share-btn").style.display = "block";
  }

  showScreen("screen-gameover");
});

socket.on("game:opponent_disconnected", (data) => {
  stopTimerRing();
  playWinSound();
  toast(`🏃 Opponent ran away! +${data.eloChange} ELO for you`, 3000);
  setTimeout(() => {
    document.getElementById("result-emoji").textContent = "🏃";
    document.getElementById("result-title").textContent = "They Fled!";
    document.getElementById("result-title").className = "result-title win";
    document.getElementById("result-elo").textContent = `+${data.eloChange} ELO`;
    document.getElementById("result-elo").className = "result-elo gain";
    document.getElementById("elo-display-card").style.display = "block";
    showScreen("screen-gameover");
  }, 1200);
});

function submitAnswer() {
  if (answered) return;
  const val = document.getElementById("answer-input").value.trim();
  if (val === "") return;
  answered = true;
  socket.emit("game:answer", { answer: val });
}

function handleRematch() {
  if (isPracticeGame) showScreen("screen-practice-select");
  else joinMatchmaking();
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const screen = document.querySelector(".screen.active");
  if (screen?.id === "screen-game") submitAnswer();
  if (screen?.id === "screen-login") handleAuthSubmit();
  if (screen?.id === "screen-challenge-menu") joinChallenge();
});

// ─── Spectator Mode ───────────────────────────────────────────────────────────

let spectatingGameId = null;

function showSpectateList() {
  showScreen("screen-spectate-list");
  socket.emit("spectate:list");
}

socket.on("spectate:list:data", (games) => {
  const container = document.getElementById("spectate-list-container");

  if (!games.length) {
    container.innerHTML = `<p class="search-text" style="margin:20px 0;">No live matches right now. Check back soon!</p>`;
    return;
  }

  container.innerHTML = games.map((g) => `
    <div class="diff-card" onclick="joinSpectate('${g.gameId}')">
      <div class="diff-emoji">👀</div>
      <div class="diff-info">
        <div class="diff-name">${g.player1} (${g.score1}) vs ${g.player2} (${g.score2})</div>
        <div class="diff-desc">Round ${g.round} · First to 5 wins</div>
      </div>
    </div>
  `).join("");
});

function joinSpectate(gameId) {
  socket.emit("spectate:join", { gameId });
}

socket.on("spectate:joined", (data) => {
  spectatingGameId = data.gameId;
  document.getElementById("spec-p1-name").textContent = data.player1;
  document.getElementById("spec-p2-name").textContent = data.player2;
  document.getElementById("spec-p1-score").textContent = data.score1;
  document.getElementById("spec-p2-score").textContent = data.score2;
  document.getElementById("spec-question-display").textContent = data.question;
  document.getElementById("spec-round-badge").textContent = `Round ${data.round}`;
  showScreen("screen-spectating");
});

socket.on("spectate:error", ({ message }) => toast(`🚫 ${message}`));

function leaveSpectating() {
  socket.emit("spectate:leave");
  spectatingGameId = null;
  showScreen("screen-menu");
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

function showLeaderboard() {
  showScreen("screen-leaderboard");
  socket.emit("player:leaderboard");
}

socket.on("leaderboard:data", (rows) => {
  const medals = ["🥇", "🥈", "🥉"];
  const tbody = document.getElementById("lb-body");

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px;">No players yet!</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r, i) => `
    <tr class="${i < 3 ? `rank-${i + 1}` : ""}">
      <td>${medals[i] ?? `<span class="lb-medal">${i + 1}</span>`}</td>
      <td>${r.avatar || "🧮"} ${r.username}</td>
      <td>${r.wins}W / ${r.losses}L</td>
      <td class="elo-val">${r.elo}</td>
    </tr>
  `).join("");
});

// ─── Copy Challenge Code ──────────────────────────────────────────────────────

function copyCode() {
  const code = document.getElementById("challenge-code-display").textContent;
  navigator.clipboard.writeText(code).then(() => {
    toast("📋 Code copied! Send it to your friend.");
  }).catch(() => {
    toast("Code: " + code + " — copy it manually!");
  });
}

// ─── Share / Brag ─────────────────────────────────────────────────────────────

function shareResult() {
  const elo = document.getElementById("new-elo-display").textContent;
  const won = document.getElementById("result-title").textContent === "You Win!";
  const opponent = opponentName;

  const text = won
    ? `⚡ Just hit ${elo} ELO on Math Duel! Destroyed ${opponent} in a 1v1 math battle 🧮🔥 Can you beat me? Play at https://math-duel-production.up.railway.app/`
    : `💀 Just lost to ${opponent} on Math Duel and dropped to ${elo} ELO... the math humbled me 😭 Play at https://math-duel-production.up.railway.app/`;

  if (navigator.share) {
    navigator.share({ title: "Math Duel", text }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text).then(() => {
      toast("📣 Copied to clipboard — paste it anywhere!");
    }).catch(() => {
      toast(text);
    });
  }
}

// ─── Match History ───────────────────────────────────────────────────────────

function showHistory() {
  showScreen("screen-history");
  socket.emit("player:history");
}

socket.on("history:data", (rows) => {
  const tbody = document.getElementById("history-body");

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px;">No matches played yet!</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r) => {
    const opponent = r.player1 === myUsername ? r.player2 : r.player1;
    const won = r.winner === myUsername;
    const resultText = won ? "✅ Won" : "❌ Lost";
    const resultClass = won ? "correct" : "wrong";
    const eloText = r.is_practice ? "—" : (won ? `+${r.elo_change}` : `-${r.elo_change}`);
    const practiceTag = r.is_practice ? ` <span class="practice-tag">Practice</span>` : "";
    const when = new Date(r.created_at).toLocaleDateString();

    return `
      <tr>
        <td>${opponent}${practiceTag}</td>
        <td class="feedback-msg ${resultClass}" style="margin:0;min-height:auto;text-align:left;font-size:0.9rem;">${resultText}</td>
        <td class="elo-val">${eloText}</td>
        <td style="color:var(--muted);font-size:0.85rem;">${when}</td>
      </tr>
    `;
  }).join("");
});

function togglePasswordVisibility() {
  const input = document.getElementById("password-input");
  const btn = document.getElementById("toggle-password");
  if (input.type === "password") {
    input.type = "text";
    input.classList.add("pw-field");
    btn.textContent = "🙈";
  } else {
    input.type = "password";
    input.classList.remove("pw-field");
    btn.textContent = "👁️";
  }
}
