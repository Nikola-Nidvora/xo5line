// ============================================================
// XO5 · 5 в ряд · Модуль 5/8: интерфейс (DOM, модалки, таймеры, лобби-рендер)
// v2.0.6 (проблема 3: принудительный переход в онлайн при входе соперника)
// Держит весь DOM и визуальные состояния; сеть/транзакции — в xo5-online.js.
// ============================================================
import { doc, deleteDoc, getDoc, getDocs, updateDoc, setDoc, collection } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
  VERSION, AUTHORS,
  TURN_WARNING_TIME, TURN_AUTO_END_TIME, MOVE_REMINDER_MS,
  OPPONENT_OFFLINE_THRESHOLD, RECONNECT_TIMEOUT,
  JOIN_NOTIFICATION_DURATION, CONFETTI_COUNT, CONFETTI_LIFETIME_MS, CONFETTI_COLORS,
  STATUS_WAITING, STATUS_PLAYING, STATUS_PAUSED, STATUS_COMPLETED, STATUS_CANCELLED,
  LOBBY_MAIN, LOBBY_WAITING,
  VERSION_URL, UPDATE_CHECK_TIMEOUT_MS, SITE_HOME_URL,
  INITIAL_GRID_SIZE
} from './xo5-constants.js';
import * as core from './xo5-core.js';
import * as online from './xo5-online.js';
import * as bot from './xo5-bot.js';

// ---------- Версия модуля и регистрация в реестре ----------
export const MODULE_VERSION = '1.0.5';
if (typeof window !== 'undefined') {
  window.XO5_VERSIONS = window.XO5_VERSIONS || {};
  window.XO5_VERSIONS.ui = MODULE_VERSION;
}

// ---------- мелкие чистые утилиты ----------
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
export function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
export function randomPhrase(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
export function formatTime(ms) {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
export function validateUsername(name, maxLen) {
  if (!name) return 'Введите имя';
  if (name.length < 3) return 'Имя должно быть не менее 3 символов';
  if (name.length > maxLen) return `Имя должно быть не более ${maxLen} символов`;
  if (!/^[a-zA-Z0-9]+$/.test(name)) return 'Имя: только латинские буквы и цифры';
  return null;
}
export function validatePassword(pass) {
  if (!pass) return 'Введите пароль';
  if (pass.length < 6) return 'Пароль минимум 6 символов';
  return null;
}
export function setBusy(btn, on) {
  if (!btn) return;
  if (on) btn.classList.add('busy');
  else btn.classList.remove('busy');
}
export function generateInitialRevealed() {
  const revealed = [];
  const half = INITIAL_GRID_SIZE / 2;
  for (let x = -half; x < half; x++)
    for (let y = -half; y < half; y++)
      revealed.push(`${x},${y}`);
  return revealed;
}
export function nudgeTextFor(count, name) {
  if (count % 20 === 0) return `\u{1F680} Вам дал мега-пендель игрок ${name}!`;
  if (count % 3 === 0) return `\u{1F4A5} Вам дал большой пендель игрок ${name}!`;
  return `\u{1F9B6} Вас пнул игрок ${name}!`;
}

// ---------- версия ----------
export function displayVersion() {
  const versionText = `v${VERSION} | ${AUTHORS}`;
  document.querySelectorAll('.version').forEach(el => { el.textContent = versionText; });
}
displayVersion();

// ---------- сводка версий модулей ----------
export function collectModuleVersions() {
  const regs = (typeof window !== 'undefined' && window.XO5_VERSIONS) ? window.XO5_VERSIONS : {};
  const out = { game: VERSION };
  for (const k of Object.keys(regs).sort()) out[k] = regs[k];
  return out;
}
export function versionSummaryLine() {
  const all = collectModuleVersions();
  return Object.keys(all).map(k => `${k} ${all[k]}`).join(' \u00B7 ');
}
function renderDebugVersionsLine() {
  const el = document.getElementById('debug-versions-line');
  if (!el) return;
  el.textContent = versionSummaryLine();
  el.title = 'Версии модулей XO5 (debug.versions() — подробнее)';
}

// ---------- состояния UI-модуля ----------
let fullscreenMode = false;
let bossMode = false;
let sleepMode = false;
let idleCheckInterval = null;
let lastUserActivityAt = Date.now();
let idleWarningShown = false;
let accountDeletionInProgress = false;
let createInProgress = false;
let lobbyListDirty = true;
let lobbyPausedByVisibility = false;
let lobbyCleanupInterval = null;
let lobbyCountdownInterval = null;
let lastOppResumeFlag = false;
let opponentDisconnected = false;
let disconnectStartTime = null;
let forcedDisconnect = false;
let opponentCheckInterval = null;
let timerInterval = null;
let notifTimer = null;
let lastNudgeUi = '';
let undoLabelTimer = null;
let globalAudioContext = null;
let lastDotState = '';
let botThinkingUi = false;
// Проблема 3: флаг ожидаемого принудительного перехода в онлайн-игру
let onlineTransitionPending = false;
let onlineTransitionTimer = null;

export function isFullscreen() { return fullscreenMode; }
export function getSleepMode() { return sleepMode; }
export function getAccountDeletionInProgress() { return accountDeletionInProgress; }
export function getCreateInProgress() { return createInProgress; }
export function setCreateInProgress(v) { createInProgress = !!v; }
export function getLobbyPausedByVisibility() { return lobbyPausedByVisibility; }
export function setLobbyPausedByVisibility(v) { lobbyPausedByVisibility = !!v; }
export function setLobbyListDirty(v) { lobbyListDirty = !!v; }
export function getLastOppResumeFlag() { return lastOppResumeFlag; }
export function setLastOppResumeFlag(v) { lastOppResumeFlag = !!v; }
export function setForcedDisconnect(v) { forcedDisconnect = !!v; }
export function isOnlineTransitionPending() { return onlineTransitionPending; }

// ---------- уведомления сверху ----------
export function clearTopNotification() {
  const notif = document.getElementById('join-notification');
  if (notifTimer) { clearTimeout(notifTimer); notifTimer = null; }
  if (notif) notif.className = 'join-notification';
}
export function showTopNotification(text, isNudge) {
  const notif = document.getElementById('join-notification');
  if (!notif) return;
  if (notifTimer) { clearTimeout(notifTimer); notifTimer = null; }
  notif.textContent = text;
  notif.className = 'join-notification active' + (isNudge ? ' nudge' : '');
  notifTimer = setTimeout(() => {
    notif.className = 'join-notification';
    notifTimer = null;
  }, JOIN_NOTIFICATION_DURATION);
}
export function notifyOpponentJoined(playerName) {
  showTopNotification(`\u{1F514} Игрок ${playerName} присоединился!`, false);
  playBellSound();
}
function showSleepWarning() {
  const notif = document.getElementById('join-notification');
  if (!notif) return;
  if (notifTimer) { clearTimeout(notifTimer); notifTimer = null; }
  notif.textContent = '\u{1F634} Через 30 сек игра уснёт из-за неактивности. Кликните, чтобы остаться';
  notif.className = 'join-notification active sleep-warning';
}

// ---------- Проблема 3: принудительный переход в онлайн ----------
// Показывает плашку «Игрок X присоединился!» с кнопкой «Перейти».
// Через 3 секунды (или сразу по кнопке) вызывает callback.
// Отменить переход нельзя.
export function showOpponentJoinedTransition(opponentName, callback) {
  const notif = document.getElementById('join-notification');
  if (!notif) { callback(); return; }
  // Сбрасываем предыдущие таймеры
  if (notifTimer) { clearTimeout(notifTimer); notifTimer = null; }
  if (onlineTransitionTimer) { clearTimeout(onlineTransitionTimer); onlineTransitionTimer = null; }
  onlineTransitionPending = true;
  const safeName = escapeHtml(opponentName || 'Соперник');
  notif.innerHTML = `\u{1F514} Игрок ${safeName} присоединился! <button class="notif-go-btn" id="notif-go-btn">\u25B6\uFE0F Перейти</button>`;
  notif.className = 'join-notification active';
  playBellSound();
  const go = () => {
    if (!onlineTransitionPending) return;
    onlineTransitionPending = false;
    if (onlineTransitionTimer) { clearTimeout(onlineTransitionTimer); onlineTransitionTimer = null; }
    if (notifTimer) { clearTimeout(notifTimer); notifTimer = null; }
    notif.className = 'join-notification';
    notif.textContent = '';
    callback();
  };
  const goBtn = document.getElementById('notif-go-btn');
  if (goBtn) goBtn.addEventListener('click', go);
  onlineTransitionTimer = setTimeout(go, 3000);
}

// ---------- звук ----------
function initAudioContext() {
  if (!globalAudioContext) {
    try { globalAudioContext = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (globalAudioContext && globalAudioContext.state === 'suspended') globalAudioContext.resume().catch(() => {});
}
export function playBellSound() {
  try {
    initAudioContext();
    if (!globalAudioContext || globalAudioContext.state === 'suspended') return;
    const oscillator = globalAudioContext.createOscillator();
    const gainNode = globalAudioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(globalAudioContext.destination);
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, globalAudioContext.currentTime);
    gainNode.gain.setValueAtTime(0.3, globalAudioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, globalAudioContext.currentTime + 0.6);
    oscillator.start(globalAudioContext.currentTime);
    oscillator.stop(globalAudioContext.currentTime + 0.6);
  } catch (e) {}
}
document.addEventListener('click', initAudioContext, { once: true });
document.addEventListener('keydown', initAudioContext, { once: true });

// ---------- активность и сон ----------
function registerActivity() {
  if (sleepMode) return;
  lastUserActivityAt = Date.now();
  clearTopNotification();
  idleWarningShown = false;
}
export function startIdleMonitor() {
  stopIdleMonitor();
  lastUserActivityAt = Date.now();
  idleWarningShown = false;
  idleCheckInterval = setInterval(idleCheckTick, 5000);
}
export function stopIdleMonitor() {
  if (idleCheckInterval) { clearInterval(idleCheckInterval); idleCheckInterval = null; }
}
function idleCheckTick() {
  if (sleepMode || !online.getCurrentUser() || accountDeletionInProgress) return;
  const idleFor = Date.now() - lastUserActivityAt;
  const IDLE_WARN_BEFORE = 30 * 1000;
  if (idleFor >= getIdleSleepTimeout()) {
    enterSleepMode();
  } else if (!idleWarningShown && idleFor >= getIdleSleepTimeout() - IDLE_WARN_BEFORE) {
    idleWarningShown = true;
    showSleepWarning();
    playBellSound();
  }
}
function getIdleSleepTimeout() {
  return online.getIdleSleepTimeoutMs ? online.getIdleSleepTimeoutMs() : 5 * 60 * 1000;
}
function enterSleepMode() {
  if (sleepMode) return;
  sleepMode = true;
  clearTopNotification();
  stopIdleMonitor();
  online.pauseLobbySubscriptions();
  online.stopBanWatch();
  stopTimerUpdate();
  online.stopActivityUpdate();
  stopOpponentCheck();
  stopLobbyCleanup();
  stopLobbyCountdowns();
  online.stopWaitingTimer();
  online.stopCreatorHeartbeat();
  core.stopRenderLoop();
  if (globalAudioContext && globalAudioContext.state === 'running') globalAudioContext.suspend().catch(() => {});
  showScreensaver();
}
function showScreensaver() {
  const saver = document.getElementById('sleep-saver');
  if (!saver) return;
  saver.classList.add('active');
  saver.addEventListener('pointerdown', () => { location.reload(); }, { once: true });
}
window.enterSleepNow = function() {
  if (online.getCurrentUser() && !sleepMode && !accountDeletionInProgress) enterSleepMode();
};
window.addEventListener('pointerdown', registerActivity, true);
window.addEventListener('keydown', registerActivity, true);
window.addEventListener('wheel', registerActivity, { passive: true, capture: true });
window.addEventListener('scroll', registerActivity, { passive: true, capture: true });

// ---------- антибосс ----------
window.toggleBossMode = function() {
  bossMode = !bossMode;
  const o = document.getElementById('boss-overlay');
  if (o) o.style.display = bossMode ? 'block' : 'none';
};

// ---------- точка соединения ----------
export function paintConnectionDot(onlineOk, offline, blink, establishing) {
  const dot = document.getElementById('connection-dot');
  if (!dot) return;
  let cls, title;
  if (offline) {
    cls = 'offline';
    title = navigator.onLine ? 'Соединение с сервером: НЕТ ОТВЕТА' : 'Соединение: НЕТ СЕТИ';
  } else if (establishing) {
    cls = '';
    title = 'Соединение с сервером: установка...';
  } else {
    cls = 'online';
    title = 'Соединение с сервером: ОК';
  }
  const state = cls + '|' + title;
  if (state === lastDotState && !blink) return;
  lastDotState = state;
  dot.classList.remove('online', 'offline', 'blink-once');
  if (cls) dot.classList.add(cls);
  dot.title = title;
  if (blink) {
    dot.classList.remove('blink-once');
    void dot.offsetWidth;
    dot.classList.add('blink-once');
  }
}

// ---------- бан-оверлей ----------
export function showBanOverlay() { document.getElementById('ban-overlay').classList.add('active'); }
export function hideBanOverlay() { document.getElementById('ban-overlay').classList.remove('active'); }
const banLogoutBtn = document.getElementById('ban-logout-btn');
if (banLogoutBtn) {
  banLogoutBtn.addEventListener('click', async () => {
    if (online.setBanKickInactive) online.setBanKickInactive();
    hideBanOverlay();
    try { await signOut(online.getAuthObj()); } catch (e) {}
  });
}

// ---------- сообщения и модалки ----------
export function showMessage(elementId, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}
export function showResultModal(message) {
  if (online.getGameEndHandled()) return;
  const overlay = document.getElementById('result-overlay');
  if (overlay.classList.contains('active')) return;
  online.setGameEndHandled(true);
  document.getElementById('result-message').textContent = message;
  overlay.classList.add('active');
}
window.closeResultModal = function() {
  document.getElementById('result-overlay').classList.remove('active');
  const layer = document.getElementById('confetti-layer');
  if (layer) layer.remove();
  online.cleanupGame();
  resetGameDom();
  showScreen('lobby-screen');
};
window.closeConfirmModal = function() {
  document.getElementById('confirm-overlay').classList.remove('active');
};
export function closeConfirmModal() { window.closeConfirmModal(); }
window.surrender = function() {
  const g = online.getCurrentGame();
  if (!g || !g.id) return;
  if (g.status !== STATUS_PLAYING) return;
  document.getElementById('confirm-overlay').classList.add('active');
};

// ---------- конфетти ----------
export function spawnConfetti() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const old = document.getElementById('confetti-layer');
    if (old) old.remove();
    const layer = document.createElement('div');
    layer.id = 'confetti-layer';
    layer.className = 'confetti-layer';
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = (Math.random() * 100) + '%';
      piece.style.backgroundColor = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      piece.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
      piece.style.animationDelay = (Math.random() * 0.6) + 's';
      layer.appendChild(piece);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), CONFETTI_LIFETIME_MS);
  } catch (e) {}
}

// ---------- символ игрока: шапка и лотерея ----------
export function setHeaderSymbolPlain(sym) {
  const symbolEl = document.getElementById('player-symbol');
  if (!symbolEl) return;
  symbolEl.textContent = sym;
  symbolEl.className = 'player-symbol ' + (sym === 'X' ? 'symbol-x' : 'symbol-o');
}
export function revealHeaderSymbol(sym) {
  const symbolEl = document.getElementById('player-symbol');
  if (!symbolEl) return;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const color = sym === 'X' ? '#667eea' : '#764ba2';
  const pop = () => {
    symbolEl.textContent = sym;
    symbolEl.className = 'player-symbol ' + (sym === 'X' ? 'symbol-x' : 'symbol-o') + ' symbol-pop';
    setTimeout(() => symbolEl.classList.remove('symbol-pop'), 700);
  };
  if (reduced || !core.getCanvasEl()) { pop(); return; }
  try {
    const cRect = core.getCanvasEl().getBoundingClientRect();
    const tRect = symbolEl.getBoundingClientRect();
    const clone = document.createElement('div');
    clone.textContent = sym;
    clone.style.position = 'fixed';
    clone.style.left = (cRect.left + cRect.width / 2) + 'px';
    clone.style.top = (cRect.top + cRect.height / 2) + 'px';
    clone.style.transform = 'translate(-50%, -50%)';
    clone.style.fontSize = '64px';
    clone.style.fontWeight = '900';
    clone.style.color = color;
    clone.style.zIndex = '10003';
    clone.style.pointerEvents = 'none';
    clone.style.textShadow = '0 2px 8px rgba(0,0,0,0.25)';
    clone.style.transition = 'left 0.7s cubic-bezier(0.25,0.8,0.35,1), top 0.7s cubic-bezier(0.25,0.8,0.35,1), font-size 0.7s cubic-bezier(0.25,0.8,0.35,1)';
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clone.style.left = (tRect.left + tRect.width / 2) + 'px';
        clone.style.top = (tRect.top + tRect.height / 2) + 'px';
        clone.style.fontSize = '36px';
      });
    });
    setTimeout(() => { clone.remove(); pop(); }, 720);
  } catch (e) { pop(); }
}
core.setLotteryRevealHook((sym, animated) => {
  if (animated) {
    revealHeaderSymbol(sym);
    showTopNotification(`\u{1F3AF} Вы играете за ${sym}!`, false);
  } else {
    setHeaderSymbolPlain(sym);
  }
});

// ---------- индикатор хода и шапка партии ----------
export function setTurnIndicator(text, cls) {
  const a = document.getElementById('turn-indicator');
  const b = document.getElementById('turn-indicator-fs');
  [a, b].forEach(el => {
    if (el) { el.textContent = text; el.className = 'turn-indicator ' + cls; }
  });
}
function setFsSymbol(sym) {
  const el = document.getElementById('fs-symbol');
  if (!el) return;
  if (!sym) { el.textContent = ''; el.className = 'fs-symbol'; return; }
  el.textContent = sym;
  el.className = 'fs-symbol ' + (sym === 'X' ? 'symbol-x' : 'symbol-o');
}
function setPlayerNameText() {
  const el = document.getElementById('player-name');
  if (!el) return;
  const user = online.getCurrentUser();
  el.textContent = '\u{1F464} ' + ((user && user.displayName) ? user.displayName : 'Игрок');
}
export function updateGameUI() {
  if (!core.getCanvasEl()) return;
  if (bot.isBotMode()) {
    const persona = bot.getBotPersona();
    const oppNameEl = document.getElementById('opponent-name');
    if (oppNameEl) oppNameEl.textContent = '\u{1F916} ' + (persona ? persona.name : 'Бот');
    const dot = document.getElementById('opponent-status-dot');
    if (dot) dot.style.display = 'none';
    const mySymbol = bot.getPlayerSymbol();
    const symbolEl = document.getElementById('player-symbol');
    symbolEl.textContent = mySymbol;
    symbolEl.className = 'player-symbol ' + (mySymbol === 'X' ? 'symbol-x' : 'symbol-o');
    setFsSymbol(mySymbol);
    setPlayerNameText();
    if (core.getGameStatus() === STATUS_COMPLETED) {
      setTurnIndicator('\u{1F3C6} Игра завершена', 'paused-turn');
      return;
    }
    const isMyTurn = core.gameState.currentTurn === mySymbol;
    setTurnIndicator(isMyTurn ? '\u{1F3AF} Ваш ход' : '\u{1F916} Ход бота', isMyTurn ? 'my-turn' : 'opponent-turn');
    return;
  }
  const user = online.getCurrentUser();
  const game = online.getCurrentGame();
  if (!user || !game) return;
  const mySymbol = user.uid === core.gameState.playerX ? 'X' : 'O';
  const symbolEl = document.getElementById('player-symbol');
  const myStatsEl = document.getElementById('my-stats-inline');
  const oppStatsEl = document.getElementById('opponent-stats-inline');
  if (core.isLotteryActive()) {
    symbolEl.textContent = '';
    symbolEl.className = 'player-symbol';
    if (myStatsEl) myStatsEl.style.visibility = 'hidden';
    if (oppStatsEl) oppStatsEl.style.visibility = 'hidden';
    setFsSymbol(null);
  } else {
    symbolEl.textContent = mySymbol;
    symbolEl.className = 'player-symbol ' + (mySymbol === 'X' ? 'symbol-x' : 'symbol-o');
    if (myStatsEl) myStatsEl.style.visibility = '';
    if (oppStatsEl) oppStatsEl.style.visibility = '';
    setFsSymbol(mySymbol);
  }
  setPlayerNameText();
  const opponentName = mySymbol === 'X' ? game.playerOName : game.playerXName;
  document.getElementById('opponent-name').textContent = opponentName || '...';
  if (game.status === STATUS_PAUSED) { setTurnIndicator('\u23F8\uFE0F Пауза', 'paused-turn'); return; }
  if (game.status === STATUS_COMPLETED) { setTurnIndicator('\u{1F3C6} Игра завершена', 'paused-turn'); return; }
  if (game.status === STATUS_CANCELLED) { setTurnIndicator('\u274C Отменена', 'paused-turn'); return; }
  const isMyTurn = core.gameState.currentTurn === mySymbol;
  setTurnIndicator(isMyTurn ? '\u{1F3AF} Ваш ход' : '\u23F3 Ход соперника', isMyTurn ? 'my-turn' : 'opponent-turn');
}

// ---------- статистика в DOM ----------
function buildStatsHtml(w, l, n, gx, go) {
  return `\u{1F3C6} <span class="stat-num">${w}</span> \u2022 ` +
    `\u{1F614} <span class="stat-num">${l}</span> \u2022 ` +
    `\u26AA <span class="stat-num">${n}</span> \u2022 ` +
    `<span class="stat-x">X</span>: <span class="stat-num">${gx}</span> \u2022 ` +
    `<span class="stat-o">O</span>: <span class="stat-num">${go}</span>`;
}
export function renderMyStatsFromData(d) {
  const w = toNum(d.wins), l = toNum(d.losses), n = toNum(d.noResult);
  const gx = toNum(d.gamesAsX), go = toNum(d.gamesAsO);
  const el = document.getElementById('user-stats');
  if (el) {
    el.innerHTML = buildStatsHtml(w, l, n, gx, go);
    el.title = `Побед: ${w} \u2022 Поражений: ${l} \u2022 Без результата: ${n} \u2022 Крестиками: ${gx} \u2022 Ноликами: ${go}`;
  }
}
export async function loadMyStats() {
  const user = online.getCurrentUser();
  if (!user) return;
  try {
    const snap = await getDoc(doc(online.getDbObj(), 'users', user.uid));
    if (!snap.exists()) return;
    renderMyStatsFromData(snap.data());
  } catch (e) {}
}
function shortStatsLine(d) {
  return `\u2022 \u{1F3C6} ${toNum(d.wins)} \u2022 \u{1F614} ${toNum(d.losses)} \u2022 \u{1F3AE} ${toNum(d.gamesAsX) + toNum(d.gamesAsO)}`;
}
function renderShortStats(el, d) {
  if (!el) return;
  el.textContent = shortStatsLine(d);
  el.title = `Побед: ${toNum(d.wins)} \u2022 Поражений: ${toNum(d.losses)} \u2022 Всего игр: ${toNum(d.gamesAsX) + toNum(d.gamesAsO)}`;
}
export async function loadGameHeaderStats() {
  const user = online.getCurrentUser();
  const game = online.getCurrentGame();
  if (!user || !game) return;
  const myEl = document.getElementById('my-stats-inline');
  const oppEl = document.getElementById('opponent-stats-inline');
  const oppUid = user.uid === game.playerX ? game.playerO : game.playerX;
  const dbObj = online.getDbObj();
  const [mySnap, oppSnap] = await Promise.all([
    getDoc(doc(dbObj, 'users', user.uid)).catch(() => null),
    oppUid ? getDoc(doc(dbObj, 'users', oppUid)).catch(() => null) : Promise.resolve(null)
  ]);
  if (mySnap && mySnap.exists) renderShortStats(myEl, mySnap.data());
  if (oppSnap && oppSnap.exists) renderShortStats(oppEl, oppSnap.data());
}

// ---------- экраны ----------
export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  displayVersion();
  const container = document.getElementById('main-container');
  if (id !== 'game-screen' && fullscreenMode) {
    fullscreenMode = false;
    container.classList.remove('fullscreen-mode');
  }
  if (id === 'game-screen') {
    container.classList.add('game-mode');
    container.classList.remove('compact-mode');
    container.classList.remove('lobby-min');
    core.resizeCanvas(fullscreenMode);
  } else {
    container.classList.add('compact-mode');
    container.classList.remove('game-mode');
    if (id === 'lobby-screen') container.classList.add('lobby-min');
    else container.classList.remove('lobby-min');
  }
  const ttCoin = document.getElementById('top-coin');
  if (ttCoin) ttCoin.style.display = (id === 'game-screen') ? 'none' : '';
  const ttGear = document.getElementById('tt-gear');
  const ttFs = document.getElementById('tt-fs');
  const ttSleep = document.getElementById('tt-sleep');
  if (ttGear) ttGear.style.display = '';
  if (ttFs) ttFs.style.display = (id === 'game-screen') ? '' : 'none';
  if (ttSleep) ttSleep.style.display = (id === 'auth-screen') ? 'none' : '';
  refreshSettingsMenu();
  if (id === 'auth-screen') {
    setTimeout(() => {
      const u = document.getElementById('username');
      if (u) u.focus();
    }, 50);
  }
  if (id === 'lobby-screen') {
    lobbyPausedByVisibility = false;
    online.listenToAvailableGames();
    startLobbyCleanup();
    startLobbyCountdowns();
    online.startOrphanCheck();
    checkForUpdates();
    renderBotButton();
  } else {
    online.pauseLobbySubscriptions();
    hideBotButton();
  }
}
window.addEventListener('resize', () => {
  if (document.getElementById('game-screen').classList.contains('active')) core.resizeCanvas(fullscreenMode);
});

// ---------- меню шестерёнки и справка ----------
export function refreshSettingsMenu() {
  const lo = document.getElementById('mi-logout');
  const de = document.getElementById('mi-delete');
  const hasSession = !!(online.getCurrentUser() && online.getAppEntered());
  if (lo) lo.style.display = hasSession ? '' : 'none';
  if (de) de.style.display = hasSession ? '' : 'none';
}
window.toggleTopSettings = function(event) {
  event.stopPropagation();
  const menu = document.getElementById('top-settings-menu');
  if (!menu) return;
  if (menu.style.display === 'none') {
    refreshSettingsMenu();
    menu.style.display = 'flex';
  } else {
    menu.style.display = 'none';
  }
};
window.closeTopSettings = function() {
  const menu = document.getElementById('top-settings-menu');
  if (menu) menu.style.display = 'none';
};
document.addEventListener('click', () => { window.closeTopSettings(); });
window.openHelpModal = function() { document.getElementById('help-overlay').classList.add('active'); };
window.closeHelpModal = function() { document.getElementById('help-overlay').classList.remove('active'); };
const helpOverlayEl = document.getElementById('help-overlay');
if (helpOverlayEl) {
  helpOverlayEl.addEventListener('click', (e) => {
    if (e.target === helpOverlayEl) window.closeHelpModal();
  });
}
window.toggleFullscreenMode = function() {
  fullscreenMode = !fullscreenMode;
  const c = document.getElementById('main-container');
  if (c) c.classList.toggle('fullscreen-mode', fullscreenMode);
  core.resizeCanvas(fullscreenMode);
};
window.togglePasswordVisibility = function() {
  const inp = document.getElementById('password');
  const btn = document.getElementById('eye-btn');
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.textContent = '\u{1F648}';
    btn.title = 'Скрыть пароль';
  } else {
    inp.type = 'password';
    btn.textContent = '\u{1F441}\uFE0F';
    btn.title = 'Показать пароль';
  }
};

// ---------- навигация и маяк ----------
window.gotoSite = function() {
  location.replace(SITE_HOME_URL + '?upd=' + Date.now());
};
window.gotoHome = function() {
  window.closeTopSettings();
  location.replace(SITE_HOME_URL + '?upd=' + Date.now());
};
function showUpdateBanner(remoteVersion) {
  const banner = document.getElementById('update-banner');
  if (!banner || banner.classList.contains('active')) return;
  const text = document.getElementById('update-banner-text');
  if (text) text.textContent = `\u{1F514} Доступна новая версия игры: v${remoteVersion}. Запустите игру с главной страницы сайта.`;
  banner.classList.add('active');
}
window.dismissUpdateBanner = function() {
  const banner = document.getElementById('update-banner');
  if (banner) banner.classList.remove('active');
};
export function checkForUpdates() {
  return new Promise((resolve) => {
    let done = false;
    const s = document.createElement('script');
    const timer = setTimeout(() => finish(false), UPDATE_CHECK_TIMEOUT_MS);
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.onload = null; s.onerror = null;
      if (s.parentNode) s.parentNode.removeChild(s);
      if (ok) {
        const remote = window.XO5_SITE_VERSION && window.XO5_SITE_VERSION.game;
        if (remote && online.isNewerVersion(remote, VERSION)) showUpdateBanner(remote);
      }
      resolve(ok);
    }
    s.src = VERSION_URL + '?t=' + Date.now();
    s.async = true;
    s.onload = () => finish(true);
    s.onerror = () => finish(false);
    document.head.appendChild(s);
  });
}

// ---------- отладочная панель ----------
let debugPanelOpen = false;
function openDebugPanel() {
  debugPanelOpen = true;
  renderDebugVersionsLine();
  document.getElementById('debug-overlay').classList.add('active');
}
window.closeDebugPanel = function() {
  debugPanelOpen = false;
  document.getElementById('debug-overlay').classList.remove('active');
};
function updateDebugIndicator() {
  const indicator = document.getElementById('debug-indicator');
  const timerOn = document.getElementById('dbg-timer').checked;
  const revealOn = document.getElementById('dbg-reveal').checked;
  (timerOn || revealOn) ? indicator.classList.add('active') : indicator.classList.remove('active');
}
export function isTimerDisabled() { return document.getElementById('dbg-timer').checked; }
window.applyDebugSettings = function() {
  const revealAll = document.getElementById('dbg-reveal').checked;
  if (revealAll) core.addDebugRevealCells();
  else core.restoreRealRevealed();
  updateDebugIndicator();
};
window.resetDebugSettings = function() {
  document.getElementById('dbg-timer').checked = false;
  document.getElementById('dbg-reveal').checked = false;
  core.restoreRealRevealed();
  updateDebugIndicator();
};
document.querySelectorAll('.debug-option').forEach(opt => {
  opt.addEventListener('click', (e) => {
    const checkbox = opt.querySelector('input[type="checkbox"]');
    if (e.target !== checkbox) {
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    }
  });
});

// ---------- глобальная клавиатура ----------
const PAN_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0]
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    window.toggleBossMode();
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.ctrlKey && e.altKey && e.code === 'KeyD') {
    e.preventDefault();
    debugPanelOpen ? window.closeDebugPanel() : openDebugPanel();
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const gameScreenActive = document.getElementById('game-screen').classList.contains('active');
  if (!gameScreenActive) return;
  if (PAN_KEYS[e.code]) {
    e.preventDefault();
    core.panCameraByCell(PAN_KEYS[e.code][0], PAN_KEYS[e.code][1]);
    core.setAimMode('keys');
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); window.resetView(); }
  if (e.code === 'Equal' || e.code === 'NumpadAdd') { e.preventDefault(); window.zoomIn(); }
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') { e.preventDefault(); window.zoomOut(); }
  if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    e.preventDefault();
    const cell = core.getAimCell();
    if (cell) online.tryMakeMove(cell.x, cell.y);
  }
  if (e.code === 'Backspace') {
    e.preventDefault();
    window.undoMove();
  }
});
window.resetView = function() { core.resetView(); core.setAimMode('keys'); };
window.zoomIn = function() { core.zoomIn(); core.setAimMode('keys'); };
window.zoomOut = function() { core.zoomOut(); core.setAimMode('keys'); };

// ---------- таймеры партии (DOM) ----------
export function timerTick() {
  if (!core.getCanvasEl()) return;
  const now = Date.now();
  const game = online.getCurrentGame();
  const user = online.getCurrentUser();
  updateNudgeButton();
  if (bot.isBotMode()) {
    if (core.gameState.gameStartTime) {
      const partyElapsed = now - core.gameState.gameStartTime;
      document.getElementById('game-timer').textContent = formatTime(partyElapsed);
      const fsEl = document.getElementById('game-timer-fs');
      if (fsEl) fsEl.textContent = formatTime(partyElapsed);
    }
    const turnText = document.getElementById('turn-timer-text');
    if (turnText) {
      if (botThinkingUi) turnText.textContent = '\u{1F916} бот думает\u2026';
      else turnText.textContent = '\u221E';
    }
    const bar = document.getElementById('turn-progress-bar');
    if (bar) { bar.style.width = '100%'; bar.className = 'progress-bar state-normal'; }
    const txt = document.getElementById('progress-text');
    if (txt) txt.textContent = '\u221E';
    return;
  }
  if (game && game.status === STATUS_PAUSED) {
    const frozenTurn = core.gameState.turnRemainingFrozen != null ? core.gameState.turnRemainingFrozen : TURN_AUTO_END_TIME;
    document.getElementById('turn-timer-text').textContent = formatTime(frozenTurn) + ' (пауза)';
    const bar = document.getElementById('turn-progress-bar');
    const txt = document.getElementById('progress-text');
    const pct = Math.max(0, (frozenTurn / TURN_AUTO_END_TIME) * 100);
    bar.style.width = pct + '%';
    txt.textContent = formatTime(frozenTurn);
    bar.className = 'progress-bar state-paused';
    const frozenParty = (core.gameState.pausedAt || now) - (core.gameState.gameStartTime || now) - (core.gameState.pausedTotalMs || 0);
    const partyText = formatTime(frozenParty) + ' (пауза)';
    document.getElementById('game-timer').textContent = partyText;
    const fsEl = document.getElementById('game-timer-fs');
    if (fsEl) fsEl.textContent = partyText;
    updatePauseUI();
    return;
  }
  if (core.gameState.gameStartTime) {
    const partyElapsed = now - core.gameState.gameStartTime - (core.gameState.pausedTotalMs || 0);
    const partyText = formatTime(partyElapsed);
    document.getElementById('game-timer').textContent = partyText;
    const fsEl = document.getElementById('game-timer-fs');
    if (fsEl) fsEl.textContent = partyText;
  }
  if (core.gameState.turnStartTime && !isTimerDisabled()) {
    const elapsed = now - core.gameState.turnStartTime;
    const remaining = TURN_AUTO_END_TIME - elapsed;
    document.getElementById('turn-timer-text').textContent = formatTime(remaining);
    const bar = document.getElementById('turn-progress-bar');
    const txt = document.getElementById('progress-text');
    const pct = Math.max(0, (remaining / TURN_AUTO_END_TIME) * 100);
    bar.style.width = pct + '%';
    txt.textContent = formatTime(remaining);
    const myS = user.uid === core.gameState.playerX ? 'X' : 'O';
    if (core.gameState.currentTurn === myS && elapsed >= MOVE_REMINDER_MS && lastReminderTurnLocal !== core.gameState.turnStartTime) {
      lastReminderTurnLocal = core.gameState.turnStartTime;
      showTopNotification('\u{1F514} Ваш ход! Пора сделать ход.', false);
      playBellSound();
    }
    if (elapsed >= TURN_AUTO_END_TIME) {
      bar.style.width = '0%';
      txt.textContent = '0:00';
      if (core.gameState.currentTurn === myS) online.autoEndGame('timeout');
    } else if (elapsed >= TURN_WARNING_TIME) bar.className = 'progress-bar state-danger';
    else if (elapsed >= TURN_WARNING_TIME * 0.8) bar.className = 'progress-bar state-warning';
    else bar.className = 'progress-bar state-normal';
  } else if (isTimerDisabled()) {
    const bar = document.getElementById('turn-progress-bar');
    bar.style.width = '100%';
    bar.className = 'progress-bar state-normal';
    document.getElementById('progress-text').textContent = '\u221E';
    document.getElementById('turn-timer-text').textContent = '\u221E';
  }
}
let lastReminderTurnLocal = 0;
export function startTimerUpdate() {
  stopTimerUpdate();
  timerTick();
  timerInterval = setInterval(timerTick, 1000);
}
export function stopTimerUpdate() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ---------- статус соперника ----------
export function checkOpponentStatus() {
  if (bot.isBotMode()) return;
  if (!core.getCanvasEl() || !online.getCurrentUser()) return;
  const game = online.getCurrentGame();
  const dot = document.getElementById('opponent-status-dot');
  const banner = document.getElementById('disconnect-banner');
  const now = Date.now();
  if (game && game.status === STATUS_PAUSED) {
    opponentDisconnected = false;
    disconnectStartTime = null;
    forcedDisconnect = false;
    banner.classList.remove('active');
    dot.className = 'opponent-status paused-dot';
    dot.title = 'Игра на паузе';
    return;
  }
  const myS = online.getCurrentUser().uid === core.gameState.playerX ? 'X' : 'O';
  const oppAct = myS === 'X' ? core.gameState.playerOLastActivity : core.gameState.playerXLastActivity;
  const since = oppAct ? (now - oppAct) : Infinity;
  if (forcedDisconnect) {
    if (oppAct && since < 90000) {
      forcedDisconnect = false;
      opponentDisconnected = false;
      disconnectStartTime = null;
      banner.classList.remove('active');
      dot.className = 'opponent-status online';
      dot.title = 'Соперник в сети';
      return;
    }
    opponentDisconnected = true;
    if (!disconnectStartTime) disconnectStartTime = now;
    dot.className = 'opponent-status reconnecting';
    dot.title = 'Ожидание переподключения соперника';
    banner.classList.add('active');
    const rem = RECONNECT_TIMEOUT - (now - disconnectStartTime);
    if (rem <= 0) window.endGameDueDisconnect(null);
    else document.getElementById('disconnect-timer').textContent = formatTime(rem);
    return;
  }
  if (!oppAct) {
    const gameAge = Date.now() - (game.gameStartTime || Date.now());
    if (gameAge < 30000) {
      dot.className = 'opponent-status online';
      dot.title = 'Загрузка статуса соперника...';
      return;
    }
    if (!opponentDisconnected) { opponentDisconnected = true; disconnectStartTime = now; }
    dot.className = 'opponent-status offline';
    dot.title = 'Соперник не подключается';
    banner.classList.add('active');
    const rem = RECONNECT_TIMEOUT - (now - disconnectStartTime);
    if (rem <= 0) window.endGameDueDisconnect(null);
    else document.getElementById('disconnect-timer').textContent = formatTime(rem);
    return;
  }
  if (since <= OPPONENT_OFFLINE_THRESHOLD) {
    if (opponentDisconnected) { opponentDisconnected = false; disconnectStartTime = null; banner.classList.remove('active'); }
    dot.className = 'opponent-status online';
    dot.title = 'Соперник в сети';
  } else {
    if (!opponentDisconnected) { opponentDisconnected = true; disconnectStartTime = oppAct + OPPONENT_OFFLINE_THRESHOLD; }
    dot.className = 'opponent-status reconnecting';
    dot.title = 'Ожидание переподключения соперника';
    banner.classList.add('active');
    const rem = RECONNECT_TIMEOUT - (now - disconnectStartTime);
    if (rem <= 0) window.endGameDueDisconnect(null);
    else document.getElementById('disconnect-timer').textContent = formatTime(rem);
  }
}
export function startOpponentCheck() {
  if (opponentCheckInterval) clearInterval(opponentCheckInterval);
  opponentCheckInterval = setInterval(checkOpponentStatus, 5000);
}
export function stopOpponentCheck() {
  if (opponentCheckInterval) { clearInterval(opponentCheckInterval); opponentCheckInterval = null; }
}

// ---------- баннеры пауз ----------
export function updatePauseUI() {
  if (bot.isBotMode()) {
    const reqBanner = document.getElementById('pause-request-banner');
    const pauseBanner = document.getElementById('pause-banner');
    const resumeBanner = document.getElementById('resume-notice-banner');
    if (reqBanner) reqBanner.classList.remove('active');
    if (pauseBanner) pauseBanner.classList.remove('active');
    if (resumeBanner) resumeBanner.classList.remove('active');
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) pauseBtn.style.display = 'none';
    const surrenderBtn = document.getElementById('surrender-btn');
    if (surrenderBtn) surrenderBtn.style.display = 'none';
    return;
  }
  const reqBanner = document.getElementById('pause-request-banner');
  const reqText = document.getElementById('pause-request-text');
  const reqButtons = document.getElementById('pause-request-buttons');
  const resumeBanner = document.getElementById('resume-notice-banner');
  const resumeText = document.getElementById('resume-notice-text');
  const pauseBanner = document.getElementById('pause-banner');
  const pauseLimit = document.getElementById('pause-limit-text');
  const pauseState = document.getElementById('pause-state-text');
  const pauseButtons = document.getElementById('pause-buttons');
  const pauseBtn = document.getElementById('pause-btn');
  const surrenderBtn = document.getElementById('surrender-btn');
  const disconnectBanner = document.getElementById('disconnect-banner');
  if (!reqBanner || !pauseBanner) return;
  const game = online.getCurrentGame();
  const user = online.getCurrentUser();
  if (!game || !user) return;
  const status = game.status;
  const now = Date.now();
  reqBanner.classList.remove('active');
  pauseBanner.classList.remove('active');
  resumeBanner.classList.remove('active');
  if (status === STATUS_PLAYING) {
    if (pauseBtn) { pauseBtn.style.display = ''; pauseBtn.textContent = '\u23F8\uFE0F Пауза'; }
    if (surrenderBtn) surrenderBtn.style.display = '';
    if (game.pauseRequestedBy) {
      if (game.pauseRequestedBy === user.uid) {
        reqText.textContent = '\u23F8\uFE0F Запрос паузы отправлен. Ожидание решения соперника...';
        reqButtons.innerHTML = `<button class="secondary" onclick="cancelPauseRequest(this)">Отменить запрос</button>`;
      } else {
        reqText.textContent = `\u23F8\uFE0F Игрок ${game.pauseRequestedByName || 'соперник'} предлагает поставить игру на паузу`;
        reqButtons.innerHTML = `<button onclick="acceptPause(this)">Согласен</button><button class="secondary" onclick="declinePause(this)">Отклонить</button>`;
      }
      reqBanner.classList.add('active');
    }
  } else if (status === STATUS_PAUSED) {
    if (pauseBtn) { pauseBtn.style.display = ''; pauseBtn.textContent = '\u23F8\uFE0F Вернуть паузу'; }
    if (surrenderBtn) surrenderBtn.style.display = 'none';
    disconnectBanner.classList.remove('active');
    const myS = user.uid === game.playerX ? 'X' : 'O';
    const myFlag = myS === 'X' ? game.pauseResumeX : game.pauseResumeO;
    const oppFlag = myS === 'X' ? game.pauseResumeO : game.pauseResumeX;
    const oppName = myS === 'X' ? game.playerOName : game.playerXName;
    if (oppFlag && !myFlag && resumeBanner) {
      resumeText.textContent = `\u25B6\uFE0F Игрок ${oppName || 'соперник'} продолжил игру! Нажмите «Продолжить», чтобы присоединиться.`;
      resumeBanner.classList.add('active');
    }
    if (online.endGameDuePauseExpiredIfOver()) return;
    const pauseRemaining = online.getPauseRemainingMs();
    pauseLimit.textContent = `До авто-отмены игры: ${formatTime(pauseRemaining)}`;
    if (pauseRemaining < online.getPauseWarnMs()) {
      pauseLimit.classList.add('warn');
      pauseLimit.textContent += ' — меньше суток!';
    } else {
      pauseLimit.classList.remove('warn');
    }
    if (myFlag) {
      pauseState.textContent = 'Вы готовы продолжить. Ожидание соперника... (кнопка «Вернуть паузу» внизу отменит готовность)';
      pauseButtons.innerHTML = `<button class="danger" onclick="cancelPausedGame(this)">Отменить игру</button>`;
    } else {
      pauseState.textContent = 'Оба игрока должны нажать «Продолжить» для возобновления.';
      pauseButtons.innerHTML = `<button onclick="pressResume(this)">\u25B6\uFE0F Продолжить</button><button class="danger" onclick="cancelPausedGame(this)">Отменить игру</button>`;
    }
    pauseBanner.classList.add('active');
  } else {
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (surrenderBtn) surrenderBtn.style.display = 'none';
  }
  core.refreshCanvasCursor();
}

// ---------- кнопка отмены хода ----------
export function beginUndoCountdown() {
  const btn = document.getElementById('undo-btn');
  if (!btn) return;
  btn.style.display = '';
  syncDynamicRow();
  if (bot.isBotMode()) {
    if (bot.canUndoBotMove()) {
      btn.textContent = '\u21A9\uFE0F Отменить [Backspace]';
      btn.disabled = false;
    } else {
      btn.disabled = true;
      btn.textContent = '\u21A9\uFE0F Отменить (—)';
    }
    return;
  }
  const tick = () => {
    const info = online.getUndoInfo();
    if (!info) return;
    const rem = Math.max(0, Math.ceil((info.deadline - Date.now()) / 1000));
    btn.textContent = `\u21A9\uFE0F Отменить ход (${rem}) [Backspace]`;
  };
  tick();
  if (undoLabelTimer) clearInterval(undoLabelTimer);
  undoLabelTimer = setInterval(tick, 200);
}
export function endUndoCountdown() {
  if (undoLabelTimer) { clearInterval(undoLabelTimer); undoLabelTimer = null; }
  if (bot.isBotMode()) return;
  const btn = document.getElementById('undo-btn');
  if (btn) btn.style.display = 'none';
  syncDynamicRow();
}
function syncDynamicRow() {
  const row = document.getElementById('controls-dynamic');
  if (!row) return;
  const u = document.getElementById('undo-btn');
  const n = document.getElementById('nudge-btn');
  const b = document.getElementById('bot-lobby-btn');
  const vis = (u && u.style.display !== 'none') || (n && n.style.display !== 'none') || (b && b.style.display !== 'none');
  row.style.display = vis ? 'flex' : 'none';
}

// ---------- кнопка пинка ----------
export function updateNudgeButton() {
  const btn = document.getElementById('nudge-btn');
  if (!btn) return;
  if (bot.isBotMode()) {
    if (lastNudgeUi !== 'hidden') { lastNudgeUi = 'hidden'; btn.style.display = 'none'; syncDynamicRow(); }
    return;
  }
  const game = online.getCurrentGame();
  const user = online.getCurrentUser();
  if (!game || !user || game.status !== STATUS_PLAYING) {
    if (lastNudgeUi !== 'hidden') { lastNudgeUi = 'hidden'; btn.style.display = 'none'; syncDynamicRow(); }
    return;
  }
  if (online.getUndoInfo()) {
    if (lastNudgeUi !== 'hidden-undo') { lastNudgeUi = 'hidden-undo'; btn.style.display = 'none'; syncDynamicRow(); }
    return;
  }
  const myS = user.uid === core.gameState.playerX ? 'X' : 'O';
  if (core.gameState.currentTurn === myS) {
    if (lastNudgeUi !== 'hidden') { lastNudgeUi = 'hidden'; btn.style.display = 'none'; syncDynamicRow(); }
    return;
  }
  const now = Date.now();
  const rem = online.getNudgeCooldownUntil() - now;
  const label = rem > 0 ? `\u{1F9B6} Пнуть (${Math.ceil(rem / 1000)})` : '\u{1F9B6} Пнуть';
  const disabled = rem > 0;
  const state = (disabled ? 'd' : 'e') + label;
  if (state === lastNudgeUi) return;
  lastNudgeUi = state;
  btn.style.display = '';
  btn.disabled = disabled;
  btn.textContent = label;
  syncDynamicRow();
}

// ---------- сброс DOM ----------
export function resetGameDom() {
  if (bot.isBotMode()) return;
  opponentDisconnected = false;
  disconnectStartTime = null;
  forcedDisconnect = false;
  lastOppResumeFlag = false;
  lastNudgeUi = '';
  lastReminderTurnLocal = 0;
  document.getElementById('disconnect-banner').classList.remove('active');
  document.getElementById('update-banner').classList.remove('active');
  document.getElementById('pause-request-banner').classList.remove('active');
  document.getElementById('pause-banner').classList.remove('active');
  document.getElementById('resume-notice-banner').classList.remove('active');
  const nudgeBtn = document.getElementById('nudge-btn');
  if (nudgeBtn) nudgeBtn.style.display = 'none';
  endUndoCountdown();
  syncDynamicRow();
}

// ---------- лобби: рендер списка ----------
function getStatusText(status) {
  switch (status) {
    case STATUS_WAITING: return '\u23F3 Ожидание';
    case STATUS_PLAYING: return '\u2694\uFE0F Игра идёт';
    case STATUS_PAUSED: return '\u23F8\uFE0F Пауза';
    case STATUS_COMPLETED: return '\u{1F3C6} Завершена';
    case STATUS_CANCELLED: return '\u274C Отменена';
    default: return status;
  }
}
function finishedStatusLine(game) {
  if (game.status === STATUS_COMPLETED) {
    const winnerName = escapeHtml(game.winner === 'X' ? game.playerXName : game.playerOName) || '?';
    return `\u{1F3C6} Завершена, победитель: ${winnerName}`;
  }
  if (game.status === STATUS_CANCELLED) {
    switch (game.endReason) {
      case 'opponent_disconnected': return '\u{1F4E1} Завершена: соперник не переподключился';
      case 'pause_expired': return '\u23F0 Завершена: истёк лимит паузы';
      case 'cancelled_by_player': return '\u{1F6D1} Завершена: отменена игроком';
      case 'creator_left': return '\u{1F6AA} Завершена: создатель вошёл в другую игру';
      case 'account_deleted': return '\u{1F5D1}\uFE0F Завершена: аккаунт удалён';
      case 'account_banned': return '\u{1F6AB} Завершена: один из игроков заблокирован';
      case 'creator_dormant': return '\u{1F4A4} Завершена: создатель не заходил 30+ дней';
      default: return '\u26AA Завершена без результата';
    }
  }
  return getStatusText(game.status);
}
function statusLineFor(game) {
  return (game.status === STATUS_COMPLETED || game.status === STATUS_CANCELLED) ? finishedStatusLine(game) : getStatusText(game.status);
}
function countdownHtmlFor(game) {
  if (game.status !== STATUS_WAITING || !game.createdAt) return '';
  const expiry = game.createdAt + online.getWaitingTimeoutMs();
  return `\u2022 <span class="lobby-countdown" data-expiry="${expiry}">--:--</span>`;
}
export function updateLobbyCountdowns() {
  const list = document.getElementById('games-list');
  if (!list) return;
  const now = Date.now();
  list.querySelectorAll('.lobby-countdown').forEach((el) => {
    const expiry = parseInt(el.getAttribute('data-expiry'), 10);
    if (!expiry) return;
    el.textContent = '\u23F3 ' + formatTime(Math.max(0, expiry - now));
  });
}
export function startLobbyCountdowns() {
  stopLobbyCountdowns();
  updateLobbyCountdowns();
  lobbyCountdownInterval = setInterval(updateLobbyCountdowns, 1000);
}
export function stopLobbyCountdowns() {
  if (lobbyCountdownInterval) { clearInterval(lobbyCountdownInterval); lobbyCountdownInterval = null; }
}
export function startLobbyCleanup() {
  stopLobbyCleanup();
  lobbyCleanupInterval = setInterval(() => {
    if (document.getElementById('lobby-screen').classList.contains('active')) processLobbyList(false);
  }, 15000);
}
export function stopLobbyCleanup() {
  if (lobbyCleanupInterval) { clearInterval(lobbyCleanupInterval); lobbyCleanupInterval = null; }
}
export function updateCreateButton() {
  const btn = document.getElementById('create-game-btn');
  const statusEl = document.getElementById('lobby-status');
  const timerEl = document.getElementById('lobby-timer');
  if (!btn) return;
  if (online.getMyCreatedGameId()) {
    btn.style.display = '';
    btn.textContent = '\u274C Закрыть игру';
    btn.onclick = window.closeMyGame;
    btn.classList.add('danger');
    if (statusEl) statusEl.textContent = LOBBY_WAITING;
    if (timerEl) timerEl.style.display = 'block';
  } else {
    btn.textContent = '\u2795 Создать игру';
    btn.onclick = window.createGame;
    btn.classList.remove('danger');
    if (statusEl) statusEl.textContent = LOBBY_MAIN;
    if (timerEl) timerEl.style.display = 'none';
  }
}
function adjustCreateButtonForActive(hasActiveGame) {
  const btn = document.getElementById('create-game-btn');
  const statusEl = document.getElementById('lobby-status');
  if (!btn || online.getMyCreatedGameId()) return;
  if (hasActiveGame) {
    btn.style.display = 'none';
    if (statusEl) statusEl.textContent = 'У вас есть активная игра — создание недоступно';
  } else {
    btn.style.display = '';
    if (statusEl && !online.getWaitingStartTime()) statusEl.textContent = LOBBY_MAIN;
  }
}
export function processLobbyList(force) {
  const list = document.getElementById('games-list');
  const user = online.getCurrentUser();
  if (!list || !user) return;
  const now = Date.now();
  let snapshot = online.getLastLobbySnapshot();
  const stale = snapshot.filter(({ game }) => online.isCardStale(game, now));
  if (stale.length > 0) {
    stale.forEach(({ id }) => {
      deleteDoc(doc(online.getDbObj(), 'games', id)).catch(() => {});
      online.updateCatalog(rooms => {
        const i = rooms.findIndex(r => r.id === id);
        if (i >= 0) rooms.splice(i, 1);
      });
      deleteDoc(online.activityRef(id)).catch(() => {});
    });
    snapshot = snapshot.filter(({ game }) => !online.isCardStale(game, now));
    lobbyListDirty = true;
  }
  const myActive = [], joinable = [], ongoing = [], finished = [];
  snapshot.forEach(({ id, game }) => {
    const isMyGame = game.playerX === user.uid || game.playerO === user.uid;
    const isFinished = (game.status === STATUS_COMPLETED || game.status === STATUS_CANCELLED);
    if (isFinished) {
      finished.push({ id, game, mine: isMyGame });
      if (isMyGame) {
        const flag = (game.playerX === user.uid) ? 'statsAppliedX' : 'statsAppliedO';
        if (!game[flag]) online.applyMyStatsForGame(id, game);
      }
      return;
    }
    if (game.status !== STATUS_WAITING && game.status !== STATUS_PLAYING && game.status !== STATUS_PAUSED) return;
    if (isMyGame) myActive.push({ id, game });
    else if (game.status === STATUS_WAITING) joinable.push({ id, game });
    else ongoing.push({ id, game });
  });
  const sortByFreshness = (a, b) => {
    const sa = online.isStaleGame(a.game, now) ? 1 : 0;
    const sb = online.isStaleGame(b.game, now) ? 1 : 0;
    if (sa !== sb) return sa - sb;
    if (sa === 1) return online.getLastMoveAt(a.game) - online.getLastMoveAt(b.game);
    return online.getLastMoveAt(b.game) - online.getLastMoveAt(a.game);
  };
  myActive.sort(sortByFreshness);
  ongoing.sort(sortByFreshness);
  joinable.sort((a, b) => (b.game.createdAt || 0) - (a.game.createdAt || 0));
  finished.sort((a, b) => (b.game.endedAt || 0) - (a.game.endedAt || 0));
  adjustCreateButtonForActive(myActive.some(({ game }) => game.status === STATUS_PAUSED || game.status === STATUS_PLAYING));
  if (!force && !lobbyListDirty) { updateLobbyCountdowns(); return; }
  lobbyListDirty = false;
  list.innerHTML = '';
  if (myActive.length === 0 && joinable.length === 0 && ongoing.length === 0 && finished.length === 0) {
    list.innerHTML = '<div class="lobby-empty">Нет игр.<br>Создайте игру!</div>';
    return;
  }
  const addGroupTitle = (text) => {
    const t = document.createElement('div');
    t.className = 'lobby-group-title';
    t.textContent = text;
    list.appendChild(t);
  };
  if (myActive.length > 0) {
    addGroupTitle('\u{1F464} Ваши игры');
    myActive.forEach(({ id, game }) => {
      const playerName = escapeHtml(game.playerXName || game.playerOName);
      const roomName = escapeHtml(game.roomName || '???');
      const statusText = statusLineFor(game);
      const canEnter = (game.status === STATUS_PLAYING || game.status === STATUS_PAUSED);
      const countdownHtml = countdownHtmlFor(game);
      const item = document.createElement('div');
      item.className = 'lobby-item my-game';
      item.innerHTML = `<div class="game-info"><div class="game-name">\u{1F3E0} ${roomName}</div><div class="game-label">\u{1F464} ${playerName} (ваша игра)</div><div class="game-status">${statusText}${countdownHtml}</div></div>${canEnter ? `<button onclick="enterMyGame('${id}', this)">Войти</button>` : ''}`;
      list.appendChild(item);
    });
  }
  if (joinable.length > 0) {
    addGroupTitle('\u{1F3AE} Присоединиться');
    joinable.forEach(({ id, game }) => {
      const playerName = escapeHtml(game.playerXName || game.playerOName);
      const roomName = escapeHtml(game.roomName || '???');
      const statusText = statusLineFor(game);
      const countdownHtml = countdownHtmlFor(game);
      const item = document.createElement('div');
      item.className = 'lobby-item';
      item.innerHTML = `<div class="game-info"><div class="game-name">\u{1F3E0} ${roomName}</div><div class="game-status">\u{1F464} ${playerName} \u2022 ${statusText}${countdownHtml}</div></div><button onclick="joinGame('${id}', this)">Играть</button>`;
      list.appendChild(item);
    });
  }
  if (ongoing.length > 0) {
    addGroupTitle('\u2694\uFE0F Идут сейчас');
    ongoing.forEach(({ id, game }) => {
      const roomName = escapeHtml(game.roomName || '???');
      const statusText = statusLineFor(game);
      const playerXName = escapeHtml(game.playerXName || '?');
      const playerOName = escapeHtml(game.playerOName || '?');
      const item = document.createElement('div');
      item.className = 'lobby-item';
      item.innerHTML = `<div class="game-info"><div class="game-name">\u{1F3E0} ${roomName}</div><div class="game-status">\u{1F464} ${playerXName} \u2022 ${statusText} \u2022 \u{1F464} ${playerOName}</div></div>`;
      list.appendChild(item);
    });
  }
  if (finished.length > 0) {
    addGroupTitle('\u{1F3C1} Завершённые');
    finished.forEach(({ id, game, mine }) => {
      const roomName = escapeHtml(game.roomName || '???');
      const statusText = statusLineFor(game);
      const playerXName = escapeHtml(game.playerXName || '?');
      const playerOName = escapeHtml(game.playerOName || '?');
      const item = document.createElement('div');
      item.className = 'lobby-item finished-game' + (mine ? ' my-game' : '');
      item.innerHTML = `<div class="game-info"><div class="game-name">\u{1F3E0} ${roomName}</div><div class="game-status">\u{1F464} ${playerXName} \u2022 ${statusText} \u2022 \u{1F464} ${playerOName}${mine ? ' (ваша игра)' : ''}</div></div>`;
      list.appendChild(item);
    });
  }
  updateLobbyCountdowns();
}

// ---------- удаление аккаунта ----------
const delForm = document.getElementById('delete-account-form');
if (delForm) delForm.addEventListener('submit', (e) => { e.preventDefault(); });
function showDeleteAccountError(text) {
  const errEl = document.getElementById('delete-account-error');
  if (errEl) { errEl.textContent = text; errEl.style.display = 'block'; }
}
window.showDeleteAccountModal = function() {
  const user = online.getCurrentUser();
  if (!user) return;
  document.getElementById('delete-account-username').textContent = user.displayName || 'Игрок';
  const pwdInput = document.getElementById('delete-account-password');
  if (pwdInput) pwdInput.value = '';
  const errEl = document.getElementById('delete-account-error');
  if (errEl) errEl.style.display = 'none';
  const btn = document.getElementById('delete-account-confirm-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Да, удалить навсегда'; }
  document.getElementById('delete-account-overlay').classList.add('active');
  setTimeout(() => { if (pwdInput) pwdInput.focus(); }, 100);
};
window.closeDeleteAccountModal = function() {
  const pwdInput = document.getElementById('delete-account-password');
  if (pwdInput) pwdInput.value = '';
  const errEl = document.getElementById('delete-account-error');
  if (errEl) errEl.style.display = 'none';
  document.getElementById('delete-account-overlay').classList.remove('active');
};
window.confirmDeleteAccount = async function() {
  const user = online.getCurrentUser();
  if (!user) return;
  const passwordInput = document.getElementById('delete-account-password');
  const confirmBtn = document.getElementById('delete-account-confirm-btn');
  const password = passwordInput ? passwordInput.value : '';
  if (!password) {
    showDeleteAccountError('\u26A0\uFE0F Введите пароль для подтверждения удаления');
    if (passwordInput) passwordInput.focus();
    return;
  }
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Удаление...'; }
  try {
    await online.reauthForDelete(password);
  } catch (authErr) {
    console.warn('Ре-аутентификация не прошла:', authErr.code);
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Да, удалить навсегда'; }
    if (authErr.code === 'auth/wrong-password' || authErr.code === 'auth/invalid-credential') showDeleteAccountError('\u274C Неверный пароль. Аккаунт НЕ удалён.');
    else if (authErr.code === 'auth/too-many-requests') showDeleteAccountError('\u26A0\uFE0F Слишком много попыток. Подождите немного.');
    else showDeleteAccountError('\u274C Ошибка проверки пароля: ' + (authErr.message || authErr.code));
    if (passwordInput) { passwordInput.value = ''; passwordInput.focus(); }
    return;
  }
  accountDeletionInProgress = true;
  try {
    stopIdleMonitor();
    online.stopSessionHeartbeat();
    online.stopCreatorHeartbeat();
    online.stopWaitingTimer();
    stopLobbyCleanup();
    stopLobbyCountdowns();
    online.stopOrphanCheck();
    online.stopBanWatch();
    online.cleanupGame();
    resetGameDom();
    const authDeleted = await online.deleteAccountTransactions();
    accountDeletionInProgress = false;
    window.closeDeleteAccountModal();
    showScreen('auth-screen');
    if (authDeleted) showMessage('auth-success', '\u2705 Аккаунт полностью удалён. Вход больше невозможен.');
    else showMessage('auth-error', '\u26A0\uFE0F Профиль удалён, но запись входа осталась. Обратитесь к администратору.');
  } catch (error) {
    console.error('Ошибка при удалении аккаунта:', error);
    accountDeletionInProgress = false;
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Да, удалить навсегда'; }
    showDeleteAccountError('\u274C Ошибка при удалении: ' + (error.message || error));
  }
};

// ---------- бот-режим: модалка выбора ----------
let botSelectedPersona = 'student';
let botSelectedSide = 'X';
function unlockHintFor(p) {
  if (!p || !p.unlockNeed) return '';
  const over = bot.PERSONAS.find(x => x.id === p.unlockOver);
  const word = (p.unlockNeed === 1) ? 'победа' : 'победы';
  return `${p.unlockNeed} ${word} над ${over ? over.name : 'предыдущим уровнем'}`;
}
export function showBotSelectModal() {
  // Проблема 3: блокировка при ожидаемом переходе в онлайн
  if (onlineTransitionPending) {
    showMessage('lobby-error', '\u23F3 Соперник зашёл в вашу игру. Идёт переход в онлайн-партию...');
    return;
  }
  // Проблема 3: блокировка при активной онлайн-партии
  if (online.getMyActiveGameId()) {
    showMessage('lobby-error', '\u26A0\uFE0F У вас есть активная онлайн-игра. Завершите её перед запуском бота.');
    return;
  }
  bot.loadBotStats();
  const unlocked = bot.getUnlockedPersonas();
  botSelectedPersona = unlocked.length ? unlocked[0].id : 'student';
  botSelectedSide = 'X';
  renderBotPersonas();
  renderBotSides();
  document.getElementById('bot-select-overlay').classList.add('active');
}
window.closeBotSelectModal = function() {
  document.getElementById('bot-select-overlay').classList.remove('active');
};
function renderBotPersonas() {
  const container = document.getElementById('bot-personas');
  if (!container) return;
  container.innerHTML = '';
  bot.PERSONAS.forEach(p => {
    const unlocked = bot.isPersonaUnlocked(p.id);
    const btn = document.createElement('button');
    btn.className = 'bot-persona-btn' + (p.id === botSelectedPersona && unlocked ? ' sel' : '') + (!unlocked ? ' locked' : '');
    btn.disabled = !unlocked;
    const st = bot.getBotStats()[p.id];
    btn.innerHTML = (unlocked ? '' : '\u{1F512} ') + p.name + '<br><span class="bot-tag">' + p.tag + '</span><br><span class="bot-score">' + st.w + 'W / ' + st.l + 'L</span>';
    if (!unlocked) btn.title = 'Откроется: ' + unlockHintFor(p);
    btn.addEventListener('click', () => {
      if (!bot.isPersonaUnlocked(p.id)) return;
      botSelectedPersona = p.id;
      renderBotPersonas();
    });
    container.appendChild(btn);
  });
}
function renderBotSides() {
  const container = document.getElementById('bot-sides');
  if (!container) return;
  container.innerHTML = '';
  ['X', 'O', 'random'].forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'bot-side-btn' + (s === botSelectedSide ? ' sel' : '');
    btn.textContent = s === 'random' ? '\u{1F3B2} Случайно' : 'Играть за ' + s;
    btn.addEventListener('click', () => { botSelectedSide = s; renderBotSides(); });
    container.appendChild(btn);
  });
}
window.startBotGameFromUI = function() {
  window.closeBotSelectModal();
  bot.startBotGame(botSelectedPersona, botSelectedSide);
  online.startGame(false);
  enterBotGameUI();
};
function ensureBotLobbyButton() {
  let btn = document.getElementById('bot-lobby-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'bot-lobby-btn';
    btn.type = 'button';
    btn.className = 'secondary';
    btn.textContent = '\u{1F3E0} В лобби (отмена игры)';
    btn.addEventListener('click', () => { window.botToLobby(); });
    const row = document.getElementById('controls-dynamic');
    if (row) row.appendChild(btn);
  }
  return btn;
}
function hideBotLobbyButton() {
  const btn = document.getElementById('bot-lobby-btn');
  if (btn) btn.style.display = 'none';
  syncDynamicRow();
}
function enterBotGameUI() {
  hideOnlineElementsInBotMode();
  const oppName = document.getElementById('opponent-name');
  if (oppName) {
    const persona = bot.getBotPersona();
    oppName.textContent = '\u{1F916} ' + (persona ? persona.name : 'Бот');
    oppName.title = persona ? ('Уровень: ' + persona.tag) : '';
  }
  const dot = document.getElementById('opponent-status-dot');
  if (dot) dot.style.display = 'none';
  const oppStats = document.getElementById('opponent-stats-inline');
  if (oppStats) oppStats.style.display = 'none';
  const myStats = document.getElementById('my-stats-inline');
  if (myStats) myStats.style.display = 'none';
  const lobbyBtn = ensureBotLobbyButton();
  if (lobbyBtn) lobbyBtn.style.display = '';
  syncDynamicRow();
  setPlayerNameText();
}
export function hideOnlineElementsInBotMode() {
  const ids = ['nudge-btn', 'pause-btn', 'surrender-btn', 'disconnect-banner', 'pause-request-banner', 'resume-notice-banner', 'pause-banner'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
}
export function showOnlineElements() {
  const ids = ['disconnect-banner', 'pause-request-banner', 'resume-notice-banner', 'pause-banner'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
  const dot = document.getElementById('opponent-status-dot');
  if (dot) dot.style.display = '';
  const oppStats = document.getElementById('opponent-stats-inline');
  if (oppStats) oppStats.style.display = '';
  const myStats = document.getElementById('my-stats-inline');
  if (myStats) myStats.style.display = '';
  hideBotLobbyButton();
}
export function showBotThinking(v) {
  botThinkingUi = !!v;
  const el = document.getElementById('bot-thinking-indicator');
  if (el) el.style.display = v ? 'inline-block' : 'none';
}
export function showBotResult(playerWon, personaId, st, newly) {
  const persona = bot.PERSONAS.find(p => p.id === personaId);
  const overlay = document.getElementById('bot-result-overlay');
  const title = document.getElementById('bot-result-title');
  const text = document.getElementById('bot-result-text');
  const unlock = document.getElementById('bot-result-unlock');
  if (!overlay) return;
  title.textContent = playerWon ? '\u{1F389} Победа!' : '\u{1F614} Поражение';
  text.textContent = (playerWon ? 'Ты обыграл «' + (persona ? persona.name : 'бота') + '».' : '«' + (persona ? persona.name : 'Бот') + '» оказался сильнее.') + ' Счёт: ' + st.w + ' побед / ' + st.l + ' поражений.';
  unlock.textContent = (newly && newly.length) ? '\u{1F513} Открыт уровень: ' + newly.join(', ') + '!' : '';
  overlay.classList.add('active');
  if (playerWon) spawnConfetti();
  showBotThinking(false);
  bot.stopBotGame();
  stopTimerUpdate();
  endUndoCountdown();
  setTurnIndicator('\u{1F3C6} Игра завершена', 'paused-turn');
}
window.botPlayAgain = function() {
  // Проблема 3: блокировка новой бот-игры при ожидаемом переходе в онлайн
  if (onlineTransitionPending) {
    showMessage('lobby-error', '\u23F3 Соперник зашёл в вашу игру. Идёт переход в онлайн-партию...');
    return;
  }
  document.getElementById('bot-result-overlay').classList.remove('active');
  bot.startBotGame(botSelectedPersona, botSelectedSide === 'X' ? 'O' : 'X');
  online.startGame(false);
  enterBotGameUI();
};
window.botToLobby = function() {
  const overlay = document.getElementById('bot-result-overlay');
  if (overlay) overlay.classList.remove('active');
  online.cleanupGame();
  hideBotLobbyButton();
  showScreen('lobby-screen');
};
export function renderBotButton() {
  const btn = document.getElementById('bot-game-btn');
  if (!btn) return;
  btn.style.display = '';
  btn.onclick = () => showBotSelectModal();
}
export function hideBotButton() {
  const btn = document.getElementById('bot-game-btn');
  if (btn) btn.style.display = 'none';
}

// ---------- отладочный объект ----------
const DEBUG_ALLOWED = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.search.indexOf('debug=1') !== -1;
if (DEBUG_ALLOWED) {
  window.debug = {
    get gameState() { return core.gameState; },
    get camera() { return core.camera; },
    get myCreatedGameId() { return online.getMyCreatedGameId(); },
    get myActiveGameId() { return online.getMyActiveGameId(); },
    get currentGame() { return online.getCurrentGame(); },
    get currentUser() { return online.getCurrentUser(); },
    get realRevealedSet() { return core.realRevealedSet; },
    get hoverCell() { return core.getHoverCell(); },
    get centerCell() { return core.getCenterCell(); },
    get touchCell() { return core.getTouchCell(); },
    get aimCell() { return core.getAimCell(); },
    get aimMode() { return core.getAimMode(); },
    get aimDebug() { return core.getAimDebug(); },
    get touchMode() { return core.getTouchMode(); },
    get fullscreenMode() { return fullscreenMode; },
    get bossMode() { return bossMode; },
    get sleepMode() { return sleepMode; },
    get optimisticMove() { return online.getOptimisticMove(); },
    get undoInfo() { return online.getUndoInfo(); },
    get undoUsedThisCycle() { return online.getUndoUsedThisCycle(); },
    get lobbyPausedByVisibility() { return lobbyPausedByVisibility; },
    get accountDeletionInProgress() { return accountDeletionInProgress; },
    get lobbyConfig() { return online.lobbyConfig; },
    get botMode() { return bot.isBotMode(); },
    get botStats() { return bot.getBotStats(); },
    get onlineTransitionPending() { return onlineTransitionPending; },
    get savedData() {
      return {
        activeGameId: online.getSavedActiveGameId(),
        createdGameId_session: online.getSavedCreatedGameId(),
        createdGameId_persistent: online.getPersistentCreatedGameId()
      };
    },
    versions() {
      const all = collectModuleVersions();
      console.log('%c=== Версии модулей XO5 ===', 'color: #667eea; font-weight: bold;');
      console.table(all);
      return all;
    },
    simulateUpdate(ver) {
      showUpdateBanner(ver || '9.9.9');
      return 'Баннер обновления показан (тест).';
    },
    async checkUpdates() {
      const ok = await checkForUpdates();
      return ok ? 'Маяк загружен, версия сайта: ' + (window.XO5_SITE_VERSION && window.XO5_SITE_VERSION.game) : 'Маяк недоступен (сеть или CORS).';
    },
    boss() {
      window.toggleBossMode();
      return 'Антибосс переключён: ' + (bossMode ? 'включён' : 'выключен');
    },
    getSessionIds() {
      const info = {
        browserId: online.BROWSER_ID.substring(0, 8),
        tabId: online.TAB_ID.substring(0, 8),
        sessionId: online.SESSION_ID.substring(0, 20)
      };
      console.table([info]);
      return info;
    },
    getConnection() {
      const info = online.getConnectionDebug();
      console.table([info]);
      return info;
    },
    get activity() {
      const gs = core.gameState;
      const g = online.getCurrentGame();
      const info = {
        playerXLastActivity: gs.playerXLastActivity ? new Date(gs.playerXLastActivity).toLocaleString() : null,
        playerOLastActivity: gs.playerOLastActivity ? new Date(gs.playerOLastActivity).toLocaleString() : null,
        currentGameStartTime: g && g.gameStartTime ? new Date(g.gameStartTime).toLocaleString() : null
      };
      console.table([info]);
      return info;
    },
    async myStats() {
      const user = online.getCurrentUser();
      if (!user) { console.log('Нет активного пользователя'); return null; }
      try {
        const snap = await getDoc(doc(online.getDbObj(), 'users', user.uid));
        const d = snap.exists() ? snap.data() : {};
        const info = {
          wins: toNum(d.wins), losses: toNum(d.losses), noResult: toNum(d.noResult),
          gamesAsX: toNum(d.gamesAsX), gamesAsO: toNum(d.gamesAsO),
          lastLoginAt: d.lastLoginAt ? new Date(d.lastLoginAt).toLocaleString() : '-'
        };
        console.table([info]);
        return info;
      } catch (e) { console.error('Ошибка:', e); }
    },
    async sessionInfo() {
      const user = online.getCurrentUser();
      if (!user) { console.log('Нет активного пользователя'); return null; }
      try {
        const snap = await getDoc(doc(online.getDbObj(), 'users', user.uid));
        const d = snap.exists() ? snap.data() : {};
        const now = Date.now();
        const info = {
          mySessionId: String(online.SESSION_ID).substring(0, 20),
          activeSessionId: String(d.activeSessionId || '-').substring(0, 20),
          leaseUntil: d.sessionLeaseUntil ? new Date(d.sessionLeaseUntil).toLocaleTimeString() : '-',
          leaseActive: d.sessionLeaseUntil ? (now < d.sessionLeaseUntil) : false,
          lastActivity: d.sessionLastActivity ? new Date(d.sessionLastActivity).toLocaleTimeString() : '-',
          lastLoginAt: d.lastLoginAt ? new Date(d.lastLoginAt).toLocaleString() : '-'
        };
        console.table([info]);
        return info;
      } catch (e) { console.error('Ошибка:', e); }
    },
    async simulateTakeover() {
      const user = online.getCurrentUser();
      if (!user) { console.log('Нет активного пользователя'); return; }
      try {
        await updateDoc(doc(online.getDbObj(), 'users', user.uid), {
          activeSessionId: 'xxx-takeover-test',
          sessionLeaseUntil: Date.now() + 120000
        });
        console.log('%c[TEST] activeSessionId подменён. В течение 60 сек сессия должна быть прервана.', 'color: #ff9800; font-weight: bold;');
      } catch (e) { console.error('Ошибка:', e); }
    },
    async countMyGames() {
      const n = await online.countMyActiveGames();
      console.log(`Ваших активных игр: ${n} из 3`);
      return n;
    },
    async forcePauseAge(hours) {
      const g = online.getCurrentGame();
      if (!g || !g.id || g.status !== STATUS_PAUSED) { console.log('Игра не на паузе'); return; }
      try {
        await updateDoc(doc(online.getDbObj(), 'games', g.id), { pausedAt: Date.now() - Math.round(hours * 3600 * 1000) });
        console.log(`Возраст паузы установлен: ${hours} ч`);
      } catch (e) { console.error('Ошибка:', e); }
    },
    async setNudgeCount(n) {
      const g = online.getCurrentGame();
      if (!g || !g.id) { console.log('Нет активной игры'); return; }
      try {
        await updateDoc(doc(online.getDbObj(), 'games', g.id), { nudgeCount: n });
        console.log(`Счётчик пинков установлен: ${n}`);
      } catch (e) { console.error('Ошибка:', e); }
    },
    async rebuildCatalog() { await online.rebuildCatalog(); },
    sleepNow() {
      if (!online.getCurrentUser()) { console.log('Нет активного пользователя'); return; }
      enterSleepMode();
    },
    async listGames() {
      try {
        const snapshot = await getDocs(collection(online.getDbObj(), 'games'));
        const games = [];
        snapshot.forEach(docSnap => {
          const g = docSnap.data();
          games.push({
            id: docSnap.id, room: g.roomName || '?', key: g.roomKey || '-', status: g.status,
            winner: g.winner ? (g.winner === 'X' ? g.playerXName : g.playerOName) || '?' : '-',
            playerX: g.playerXName || '?', playerO: g.playerOName || '-',
            creator: g.createdByName || '?',
            age: g.createdAt ? Math.floor((Date.now() - g.createdAt) / 1000) + 's' : '-'
          });
        });
        console.table(games);
        return games;
      } catch (e) { console.error('Ошибка:', e); }
    },
    async deleteGame(id) {
      try {
        await deleteDoc(doc(online.getDbObj(), 'games', id));
        online.updateCatalog(rooms => {
          const i = rooms.findIndex(r => r.id === id);
          if (i >= 0) rooms.splice(i, 1);
        });
        deleteDoc(online.activityRef(id)).catch(() => {});
        console.log(`Игра ${id} удалена`);
      } catch (e) { console.error('Ошибка:', e); }
    },
    async deleteAllGames(confirmWord) {
      if (confirmWord !== 'I_UNDERSTAND') {
        console.log('%c[WARN] Удаление ВСЕХ игр требует подтверждения: debug.deleteAllGames("I_UNDERSTAND")', 'color: #ff5252; font-weight: bold;');
        return;
      }
      try {
        const snapshot = await getDocs(collection(online.getDbObj(), 'games'));
        let count = 0;
        for (const docSnap of snapshot.docs) {
          await deleteDoc(docSnap.ref);
          deleteDoc(online.activityRef(docSnap.id)).catch(() => {});
          count++;
        }
        await setDoc(online.catalogRef(), { rooms: [], updatedAt: Date.now() });
        console.log(`Удалено игр: ${count}, каталог очищен`);
      } catch (e) { console.error('Ошибка:', e); }
    },
    clearSaved() {
      online.clearSavedActiveGameId();
      online.clearSavedCreatedGameId();
      console.log('Сохранённые данные очищены');
    },
    resetBotStats() {
      bot.resetBotStats();
      console.log('Статистика бота сброшена');
    },
    help() {
      console.log('%c=== Отладка 5 в ряд v' + VERSION + ' ===', 'color: #667eea; font-weight: bold;');
      console.log('Свойства: gameState, camera, hoverCell, centerCell, touchCell, aimCell, aimMode, aimDebug, touchMode, fullscreenMode, bossMode, sleepMode, botMode, botStats, optimisticMove, undoInfo, activity, savedData, lobbyConfig, onlineTransitionPending и др.');
      console.log('Команды:');
      console.log('  debug.versions()         - версии игры и всех модулей');
      console.log('  debug.myStats()          - моя статистика (включая lastLoginAt)');
      console.log('  debug.sessionInfo()      - информация о сессии (lease, activity)');
      console.log('  debug.simulateTakeover() - тест перехвата сессии другим браузером');
      console.log('  debug.countMyGames()     - сколько у меня активных игр');
      console.log('  debug.forcePauseAge(h)   - подставить возраст паузы в часах');
      console.log('  debug.setNudgeCount(n)   - установить счётчик пинков');
      console.log('  debug.rebuildCatalog()   - пересборка каталога лобби');
      console.log('  debug.sleepNow()         - сразу уснуть (тест скринсейвера)');
      console.log('  debug.boss()             - переключить антибосс (белый экран)');
      console.log('  debug.listGames()        - таблица всех игр в Firestore');
      console.log('  debug.deleteGame(id)     - удалить одну игру');
      console.log('  debug.deleteAllGames("I_UNDERSTAND") - удалить все игры');
      console.log('  debug.clearSaved()       - очистить сохранённые id игр');
      console.log('  debug.resetBotStats()    - сбросить статистику бота');
      console.log('  debug.simulateUpdate(v)  - показать баннер обновления (тест маяка)');
      console.log('  debug.checkUpdates()     - запросить маяк версий с сайта');
      console.log('  debug.getConnection()    - состояние соединения с сервером');
      console.log('  Дворник протухших — только в админке (xo5_admin).');
    }
  };
  console.log('%c[DEBUG] window.debug доступен (localhost или ?debug=1)', 'color: #a6e3a1; font-weight: bold;');
}
console.log(`%c[UI] модуль интерфейса загружен (ui ${MODULE_VERSION})`, 'color: #667eea; font-weight: bold;');