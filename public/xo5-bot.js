// ============================================================
// XO5 · 5 в ряд · Модуль бота (v2.0.7)
// MODULE_VERSION 1.0.7
// Локальный ИИ для одиночной игры без Firebase.
// Прогрессия: Студент → Инженер → Гроссмейстер → Эксперт
// Статистика: localStorage (не влияет на онлайн-статистику)
// Архитектура: статический импорт ui, без top-level await,
// moveLog для надёжной отмены, wasUnlocked для отслеживания
// разблокировок, realRevealedSet для синхронизации раскрытия.
// v2.0.7: защита от двойной модалки (botResultShown),
// центрирование прицела на ход бота (centerOnCell).
// ============================================================
import {
  REVEAL_RADIUS, OTHER,
  STATUS_PLAYING, STATUS_COMPLETED,
  WIN_MODAL_DELAY
} from './xo5-constants.js';
import * as core from './xo5-core.js';
import * as ui from './xo5-ui.js';

// ---------- Версия модуля и регистрация в реестре ----------
export const MODULE_VERSION = '1.0.7';
if (typeof window !== 'undefined') {
  window.XO5_VERSIONS = window.XO5_VERSIONS || {};
  window.XO5_VERSIONS.bot = MODULE_VERSION;
}

// ---------- Константы ----------
const LS_KEY = 'xo5botStats';
const BOT_THINK_MIN_MS = 400;
const BOT_THINK_MAX_MS = 900;

// ---------- Персонажи ----------
export const PERSONAS = [
  { id: 'student',  name: 'Студент',      tag: 'лёгкий',     unlockNeed: 0, unlockOver: null,       unlockText: '' },
  { id: 'engineer', name: 'Инженер',      tag: 'средний',    unlockNeed: 1, unlockOver: 'student',  unlockText: '1 победа над Студентом' },
  { id: 'gm',       name: 'Гроссмейстер', tag: 'сложный',    unlockNeed: 2, unlockOver: 'engineer', unlockText: '2 победы над Инженером' },
  { id: 'expert',   name: 'Эксперт',      tag: 'экспертный', unlockNeed: 4, unlockOver: 'gm',       unlockText: '4 победы над Гроссмейстером' }
];

// ---------- Состояние ----------
let botMode = false;
let botPersonaId = 'student';
let playerSymbol = 'X';
let botSymbol = 'O';
let moveLog = [];
let undoInfo = null;
let botThinking = false;
let botTimerId = null;
let botResultTimerId = null;
// Защита от двойной модалки: если true — модалка уже показана или запланирована
let botResultShown = false;
let stats = defaultStats();
let wasUnlocked = {};

// ---------- Утилиты ----------
const key = (x, y) => x + ',' + y;
const parseKey = k => { const p = k.split(','); return { x: +p[0], y: +p[1] }; };
function defaultStats() {
  return {
    student: { w: 0, l: 0 },
    engineer: { w: 0, l: 0 },
    gm: { w: 0, l: 0 },
    expert: { w: 0, l: 0 }
  };
}
function refreshUndoButton() {
  if (ui && typeof ui.beginUndoCountdown === 'function') {
    ui.beginUndoCountdown();
  }
}

// ---------- Статистика ----------
export function loadBotStats() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.student && s.engineer && s.gm && s.expert) stats = s;
  } catch (e) {}
  return stats;
}
function saveStats() {
  localStorage.setItem(LS_KEY, JSON.stringify(stats));
}
export function saveBotStats() {
  saveStats();
}
export function getBotStats() {
  return stats;
}
export function resetBotStats() {
  stats = defaultStats();
  saveStats();
}

// ---------- Прогрессия ----------
export function isPersonaUnlocked(id) {
  const p = PERSONAS.find(x => x.id === id);
  if (!p || !p.unlockNeed) return true;
  const over = stats[p.unlockOver];
  return !!over && over.w >= p.unlockNeed;
}
export function getUnlockedPersonas() {
  return PERSONAS.filter(p => isPersonaUnlocked(p.id));
}
export function getUnlockText(id) {
  const p = PERSONAS.find(x => x.id === id);
  return p ? p.unlockText : null;
}
function snapshotUnlocks() {
  wasUnlocked = {};
  for (const p of PERSONAS) wasUnlocked[p.id] = isPersonaUnlocked(p.id);
}

// ---------- Доска ----------
function revealAround(x, y) {
  for (let dx = -REVEAL_RADIUS; dx <= REVEAL_RADIUS; dx++) {
    for (let dy = -REVEAL_RADIUS; dy <= REVEAL_RADIUS; dy++) {
      if (Math.hypot(dx, dy) <= REVEAL_RADIUS) {
        const k = key(x + dx, y + dy);
        core.gameState.revealed.add(k);
        if (core.realRevealedSet) core.realRevealedSet.add(k);
      }
    }
  }
  core.invalidateBounds();
}
function initBoard() {
  moveLog = [];
  undoInfo = null;
  const initial = [];
  for (let x = -5; x < 5; x++) {
    for (let y = -5; y < 5; y++) {
      initial.push(key(x, y));
    }
  }
  core.setRevealedBase(initial);
  core.gameState.moves = {};
  core.gameState.currentTurn = 'X';
  core.gameState.gameStartTime = Date.now();
  core.gameState.turnStartTime = Date.now();
  core.gameState.winningCells = null;
  core.gameState.winTime = null;
  core.gameState.lastMove = null;
  core.resetCamera();
  core.setGameStatus(STATUS_PLAYING);
}
function available(x, y) {
  return core.getGameStatus() === STATUS_PLAYING
    && core.gameState.revealed.has(key(x, y))
    && !core.gameState.moves[key(x, y)];
}

// ---------- ИИ ----------
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
function candidates(moves) {
  const stones = Object.keys(moves);
  if (!stones.length) return [{ x: 0, y: 0 }];
  const set = new Set();
  for (const s of stones) {
    const p = parseKey(s);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const k = key(p.x + dx, p.y + dy);
        if (!moves[k] && core.gameState.revealed.has(k)) set.add(k);
      }
    }
  }
  return Array.from(set, parseKey);
}
function lineScore(count, open) {
  if (count >= 5) return 1e7;
  if (count === 4) return open === 2 ? 1e6 : 1e5;
  if (count === 3) return open === 2 ? 1e4 : 1e3;
  if (count === 2) return open === 2 ? 1e2 : 10;
  return open === 2 ? 5 : 1;
}
function evalCell(x, y, sym, moves) {
  let total = 0;
  for (const [dx, dy] of DIRS) {
    let count = 1;
    let open = 0;
    let fx = x + dx;
    let fy = y + dy;
    while (moves[key(fx, fy)] === sym) {
      count++;
      fx += dx;
      fy += dy;
    }
    if (!moves[key(fx, fy)]) open++;
    let bx = x - dx;
    let by = y - dy;
    while (moves[key(bx, by)] === sym) {
      count++;
      bx -= dx;
      by -= dy;
    }
    if (!moves[key(bx, by)]) open++;
    total += lineScore(count, open);
  }
  return total;
}
function moveScore(x, y, me, moves) {
  return evalCell(x, y, me, moves) + 0.9 * evalCell(x, y, OTHER[me], moves);
}
function runsScore(moves, sym) {
  let total = 0;
  for (const k in moves) {
    if (moves[k] !== sym) continue;
    const p = parseKey(k);
    for (const [dx, dy] of DIRS) {
      if (moves[key(p.x - dx, p.y - dy)] === sym) continue;
      let count = 0;
      let fx = p.x;
      let fy = p.y;
      while (moves[key(fx, fy)] === sym) {
        count++;
        fx += dx;
        fy += dy;
      }
      let open = 0;
      if (!moves[key(p.x - dx, p.y - dy)]) open++;
      if (!moves[key(fx, fy)]) open++;
      total += lineScore(count, open);
    }
  }
  return total;
}
function boardPersp(moves, side) {
  return runsScore(moves, side) - runsScore(moves, OTHER[side]);
}
function checkWinInMap(moves, x, y, sym) {
  for (const [dx, dy] of DIRS) {
    let count = 1;
    let fx = x + dx;
    let fy = y + dy;
    while (moves[key(fx, fy)] === sym) {
      count++;
      fx += dx;
      fy += dy;
    }
    let bx = x - dx;
    let by = y - dy;
    while (moves[key(bx, by)] === sym) {
      count++;
      bx -= dx;
      by -= dy;
    }
    if (count >= 5) return true;
  }
  return false;
}
function negamax(depth, alpha, beta, side, K) {
  const moves = core.gameState.moves;
  const cands = candidates(moves);
  if (!cands.length) return 0;
  for (const c of cands) {
    if (checkWinInMap(moves, c.x, c.y, side)) return 1e9 - (4 - depth);
  }
  if (depth === 0) return boardPersp(moves, side);
  const scored = cands
    .map(c => ({ c, s: moveScore(c.x, c.y, side, moves) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, K);
  let best = -Infinity;
  for (const e of scored) {
    const k = key(e.c.x, e.c.y);
    moves[k] = side;
    const v = -negamax(depth - 1, -beta, -alpha, OTHER[side], 8);
    delete moves[k];
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}
function searchBest(side, depth, K) {
  const moves = core.gameState.moves;
  const cands = candidates(moves);
  const scored = cands
    .map(c => ({ c, s: moveScore(c.x, c.y, side, moves) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, K);
  let best = scored[0].c;
  let bestV = -Infinity;
  for (const e of scored) {
    const k = key(e.c.x, e.c.y);
    moves[k] = side;
    const v = -negamax(depth - 1, -1e18, 1e18, OTHER[side], 8);
    delete moves[k];
    if (v > bestV) {
      bestV = v;
      best = e.c;
    }
  }
  return best;
}
export function computeBotMove() {
  const me = botSymbol;
  const opp = playerSymbol;
  const moves = core.gameState.moves;
  const cands = candidates(moves);
  if (!cands.length) return null;
  let winCell = null;
  let blockCell = null;
  let open4 = null;
  let block4 = null;
  for (const c of cands) {
    const attack = evalCell(c.x, c.y, me, moves);
    const defense = evalCell(c.x, c.y, opp, moves);
    if (attack >= 1e7 && !winCell) winCell = c;
    if (defense >= 1e7 && !blockCell) blockCell = c;
    if (attack >= 1e6 && !open4) open4 = c;
    if (defense >= 1e6 && !block4) block4 = c;
  }
  // Студент: блокирует всегда, свой выигрыш — с вероятностью 0.7, иначе шум из топ-6
  if (botPersonaId === 'student') {
    if (blockCell) return blockCell;
    if (winCell && Math.random() < 0.7) return winCell;
    const scored = cands
      .map(c => ({ c, s: moveScore(c.x, c.y, me, moves) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.min(6, cands.length));
    return scored[Math.floor(Math.random() * scored.length)].c;
  }
  // Жёсткие правила для всех остальных
  if (winCell) return winCell;
  if (blockCell) return blockCell;
  // Инженер: чистая жадная эвристика
  if (botPersonaId === 'engineer') {
    let best = cands[0];
    let bs = -Infinity;
    for (const c of cands) {
      const s = moveScore(c.x, c.y, me, moves);
      if (s > bs) {
        bs = s;
        best = c;
      }
    }
    return best;
  }
  // Гроссмейстер/Эксперт: открытые и блокирующие четвёрки в приоритете
  if (open4) return open4;
  if (block4) return block4;
  const n = cands.length;
  if (botPersonaId === 'gm') return searchBest(me, n <= 8 ? 3 : 2, 10);
  return searchBest(me, n <= 6 ? 4 : 3, 12); // expert
}

// ---------- Игровой цикл ----------
function place(x, y, sym) {
  const k = key(x, y);
  core.gameState.moves[k] = sym;
  moveLog.push(k);
  revealAround(x, y);
  core.gameState.lastMove = k;
  core.highlightMove(k);
}
export function scheduleBotMove() {
  if (botThinking) return;
  botThinking = true;
  ui.showBotThinking(true);
  refreshUndoButton();
  const delay = BOT_THINK_MIN_MS + Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS);
  botTimerId = setTimeout(() => {
    botTimerId = null;
    if (!botMode) {
      botThinking = false;
      ui.showBotThinking(false);
      refreshUndoButton();
      return;
    }
    let move = null;
    try {
      move = computeBotMove();
    } catch (e) {
      console.warn('Бот упал, запасной ход:', e);
      const cands = candidates(core.gameState.moves);
      move = cands.length ? cands[0] : null;
    }
    botThinking = false;
    ui.showBotThinking(false);
    if (!move) {
      // Нет доступных ходов — передаём ход игроку (защита от зависания)
      core.gameState.currentTurn = playerSymbol;
      ui.updateGameUI();
      refreshUndoButton();
      return;
    }
    place(move.x, move.y, botSymbol);
    // НОВОЕ В v2.0.7: центрируем камеру и прицел на клетке хода бота,
    // чтобы игрок сразу видел, где бот поставил символ
    core.centerOnCell(move.x, move.y);
    const winCells = core.checkWinnerInMap(core.gameState.moves, move.x, move.y, botSymbol);
    if (winCells) {
      core.gameState.winningCells = winCells;
      core.gameState.winTime = Date.now();
      finishGame(false);
      return;
    }
    core.gameState.currentTurn = playerSymbol;
    core.gameState.turnStartTime = Date.now();
    ui.updateGameUI();
    refreshUndoButton();
  }, delay);
}
export function onPlayerMove(cellX, cellY) {
  if (!botMode || botThinking) return false;
  if (core.getGameStatus() !== STATUS_PLAYING) return false;
  if (core.gameState.currentTurn !== playerSymbol) return false;
  if (!available(cellX, cellY)) return false;
  const lenBefore = moveLog.length;
  place(cellX, cellY, playerSymbol);
  const winCells = core.checkWinnerInMap(core.gameState.moves, cellX, cellY, playerSymbol);
  if (winCells) {
    core.gameState.winningCells = winCells;
    core.gameState.winTime = Date.now();
    finishGame(true);
    return true;
  }
  core.gameState.currentTurn = botSymbol;
  core.gameState.turnStartTime = Date.now();
  undoInfo = { len: lenBefore };
  ui.updateGameUI();
  refreshUndoButton();
  scheduleBotMove();
  return true;
}
function finishGame(playerWon) {
  if (botTimerId) {
    clearTimeout(botTimerId);
    botTimerId = null;
  }
  if (botResultTimerId) {
    clearTimeout(botResultTimerId);
    botResultTimerId = null;
  }
  botThinking = false;
  ui.showBotThinking(false);
  undoInfo = null;
  const st = stats[botPersonaId];
  if (playerWon) st.w++;
  else st.l++;
  saveStats();
  const newly = PERSONAS
    .filter(p => isPersonaUnlocked(p.id) && !wasUnlocked[p.id])
    .map(p => p.name);
  core.setGameStatus(STATUS_COMPLETED);
  ui.updateGameUI();
  refreshUndoButton();
  // НОВОЕ В v2.0.7: защита от двойной модалки.
  // Если модалка уже показана/запланирована — не запускаем повторную.
  if (botResultShown) return;
  botResultShown = true;
  // Захватываем локальные копии, чтобы не зависеть от глобального
  // состояния, если между setTimeout и его срабатыванием что-то поменяется
  const personaId = botPersonaId;
  const resultStats = { w: st.w, l: st.l };
  // Не показываем модалку мгновенно — даём core.drawWinningLine()
  // проиграть анимацию красной линии
  botResultTimerId = setTimeout(() => {
    botResultTimerId = null;
    if (core.getGameStatus() !== STATUS_COMPLETED) return;
    ui.showBotResult(playerWon, personaId, resultStats, newly);
    botMode = false;
    ui.updateGameUI();
    refreshUndoButton();
  }, WIN_MODAL_DELAY);
}

// ---------- Отмена ----------
export function canUndoBotMove() {
  return botMode
    && !botThinking
    && core.getGameStatus() === STATUS_PLAYING
    && core.gameState.currentTurn === playerSymbol
    && undoInfo !== null
    && moveLog.length > undoInfo.len;
}
export function undoBotMove() {
  if (!canUndoBotMove()) return false;
  if (botTimerId) {
    clearTimeout(botTimerId);
    botTimerId = null;
  }
  botThinking = false;
  ui.showBotThinking(false);
  while (moveLog.length > undoInfo.len) {
    const k = moveLog.pop();
    delete core.gameState.moves[k];
  }
  core.gameState.currentTurn = playerSymbol;
  core.gameState.turnStartTime = Date.now();
  core.gameState.winningCells = null;
  core.gameState.winTime = null;
  core.gameState.lastMove = moveLog.length ? moveLog[moveLog.length - 1] : null;
  undoInfo = null;
  core.invalidateBounds();
  core.highlightMove(core.gameState.lastMove || '');
  ui.updateGameUI();
  refreshUndoButton();
  return true;
}

// ---------- Публичный API ----------
export function getPlayMode() {
  return botMode ? 'bot' : 'online';
}
export function isBotMode() {
  return botMode;
}
export function isBotThinking() {
  return botThinking;
}
export function getBotPersona() {
  return PERSONAS.find(p => p.id === botPersonaId);
}
export function getBotSymbol() {
  return botSymbol;
}
export function getPlayerSymbol() {
  return playerSymbol;
}
export function getUndoInfo() {
  return undoInfo ? { len: undoInfo.len } : null;
}
export function startBotGame(personaId, playerSide) {
  loadBotStats();
  if (!isPersonaUnlocked(personaId)) return false;
  // Сбрасываем любые предыдущие таймеры/флаги
  if (botTimerId) {
    clearTimeout(botTimerId);
    botTimerId = null;
  }
  if (botResultTimerId) {
    clearTimeout(botResultTimerId);
    botResultTimerId = null;
  }
  botThinking = false;
  botResultShown = false;
  snapshotUnlocks();
  botMode = true;
  botPersonaId = personaId;
  playerSymbol = (playerSide === 'random') ? (Math.random() < 0.5 ? 'X' : 'O') : playerSide;
  botSymbol = OTHER[playerSymbol];
  initBoard();
  core.setMySymbol(playerSymbol);
  ui.updateGameUI();
  refreshUndoButton();
  if (core.gameState.currentTurn === botSymbol) scheduleBotMove();
  return true;
}
export function stopBotGame() {
  botMode = false;
  if (botTimerId) {
    clearTimeout(botTimerId);
    botTimerId = null;
  }
  if (botResultTimerId) {
    clearTimeout(botResultTimerId);
    botResultTimerId = null;
  }
  botThinking = false;
  botResultShown = false;
  undoInfo = null;
  ui.showBotThinking(false);
  refreshUndoButton();
}

export const resetBotState = stopBotGame;
export const exitBotGame = stopBotGame;

console.log(`%c[BOT] модуль бота загружен (bot ${MODULE_VERSION})`, 'color: #ab47bc; font-weight: bold;');