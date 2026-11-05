// ============================================================
// XO5 · 5 в ряд · Модуль 3/8: ядро (состояние, рендер, ввод)
// v2.0.5 (версионирование модулей)
// Без Firebase и без DOM-модалок. Связь с онлайном/UI — крючки.
// ============================================================
import {
  CELL_SIZE, REVEAL_RADIUS, MIN_ZOOM, MAX_ZOOM, CAMERA_BOUNDARY_PADDING,
  WIN_LINE_ANIMATION_DURATION, AIM_FADE_MS, LONG_PRESS_MS, DRAG_THRESHOLD_PX,
  DEBUG_REVEAL_RANGE, STATUS_PLAYING, OTHER,
  LOTTERY_SLOW_END, LOTTERY_FAST_END, LOTTERY_BRAKE_END, LOTTERY_REVEAL_END,
  LOTTERY_FADE_END, LOTTERY_OMEGA_SLOW, LOTTERY_OMEGA_FAST
} from './xo5-constants.js';

// ---------- Версия модуля и регистрация в реестре ----------
export const MODULE_VERSION = '1.0.0';
if (typeof window !== 'undefined') {
  window.XO5_VERSIONS = window.XO5_VERSIONS || {};
  window.XO5_VERSIONS.core = MODULE_VERSION;
}

// ---------- состояние партии и камеры ----------
export const gameState = {
  moves: {}, revealed: new Set(), currentTurn: null,
  playerX: null, playerO: null, lastMove: null,
  gameStartTime: null, turnStartTime: null,
  winningCells: null, winTime: null,
  playerXLastActivity: null, playerOLastActivity: null,
  pausedAt: null,
  turnRemainingFrozen: null,
  pausedTotalMs: 0,
  pauseRequestedBy: null,
  pauseRequestedByName: null,
  pauseResumeX: false,
  pauseResumeO: false
};
export const camera = {
  x: 0.5, y: 0.5, zoom: 2,
  targetX: 0.5, targetY: 0.5, targetZoom: 2,
  isDragging: false, dragStartX: 0, dragStartY: 0,
  dragCameraStartX: 0, dragCameraStartY: 0
};
let canvas = null;
let ctx = null;
let animationFrameId = null;
let renderErrorLogged = false;
let lastFrameTs = 0;
let canvasListenersAttached = false;
let lastCursorStyle = '';

// ---------- ввод ----------
export let touchMode = !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
const activePointers = new Map();
let pinching = false;
let pinchStartDist = 0;
let pinchStartZoom = 1;
let mousePixel = null;
let hoverActive = false;
let lastMouseAt = 0;
let mouseDownTime = 0;
let mouseDownPos = { x: 0, y: 0 };
let mouseDownButton = 0;
let draggedFlag = false;
let holdTimer = null;
let holdActive = false;
let crosshairX = null;
let crosshairY = null;

// ---------- прицел и подсветка ----------
let aimMode = 'mouse';
const hlAlpha = {};
let crossGreen = 0;
let aimKey = null;
let aimAvail = false;

// ---------- роль игрока и статус партии (ставятся извне) ----------
let mySymbol = 'X';
let gameStatus = null;

// ---------- подсветка последнего хода ----------
let lastHighlightedMove = null;
let highlightStartTime = 0;

// ---------- база открытых клеток и границы ----------
export let realRevealedSet = new Set();
let cachedBounds = null;
let boundsDirty = true;

// ---------- лотерея символа ----------
let lottery = null;
let lotteryRevealed = false;
let lotteryRevealTimer = null;
let lotteryRevealHook = null;

// ---------- крючки связи с онлайном ----------
let moveRequestHook = null;
export function setMoveRequestHook(fn) { moveRequestHook = fn; }
export function setLotteryRevealHook(fn) { lotteryRevealHook = fn; }

// ---------- сеттеры роли/статуса/режимов ----------
export function setMySymbol(s) { mySymbol = s; }
export function getMySymbol() { return mySymbol; }
export function setGameStatus(st) { gameStatus = st; }
export function getGameStatus() { return gameStatus; }
export function setAimMode(m) { aimMode = m; }
export function getAimMode() { return aimMode; }
export function setTouchMode(v) { touchMode = !!v; }
export function getTouchMode() { return touchMode; }
export function getAimDebug() {
  return { aimMode: aimMode, aimKey: aimKey, aimAlpha: aimKey ? (hlAlpha[aimKey] || 0) : 0, crossGreen: crossGreen };
}

// ---------- канвас ----------
export function bindCanvas(el) {
  canvas = el;
  ctx = el ? el.getContext('2d') : null;
  renderErrorLogged = false;
}
export function releaseCanvas() {
  canvas = null;
  ctx = null;
}
export function getCanvasEl() { return canvas; }
export function resizeCanvas(isFullscreen) {
  if (!canvas) return;
  const wrapper = document.getElementById('canvas-wrapper');
  if (!wrapper) return;
  const rect = wrapper.getBoundingClientRect();
  const padding = isFullscreen ? 4 : 20;
  const w = Math.max(200, Math.floor(rect.width - padding));
  const h = Math.max(160, Math.floor(rect.height - padding));
  canvas.width = w; canvas.height = h;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
}

// ---------- геометрия клетки ----------
export function cellFromPixel(px, py) {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const size = CELL_SIZE * camera.zoom;
  return {
    x: Math.floor((px - cx) / size + camera.x),
    y: Math.floor((py - cy) / size + camera.y)
  };
}
export function getCenterCell() {
  return { x: Math.floor(camera.x), y: Math.floor(camera.y) };
}
export function getTouchCell() {
  if (!canvas || !mousePixel) return null;
  return cellFromPixel(mousePixel.x, mousePixel.y);
}
export function getHoverCell() {
  if (!canvas || !hoverActive || !mousePixel) return null;
  if (gameStatus !== STATUS_PLAYING) return null;
  return cellFromPixel(mousePixel.x, mousePixel.y);
}
export function getAimCell() {
  if (touchMode) return getCenterCell();
  if (aimMode === 'keys' || !mousePixel) return getCenterCell();
  return cellFromPixel(mousePixel.x, mousePixel.y);
}
export function canMoveInCell(cellX, cellY) {
  if (gameStatus !== STATUS_PLAYING) return false;
  if (gameState.currentTurn !== mySymbol) return false;
  const key = `${cellX},${cellY}`;
  if (!gameState.revealed.has(key)) return false;
  if (gameState.moves[key]) return false;
  return true;
}

// ---------- открытая зона и её границы ----------
export function setRevealedBase(arr) {
  realRevealedSet = new Set(arr);
  gameState.revealed = new Set(realRevealedSet);
  invalidateBounds();
}
export function addDebugRevealCells() {
  for (let x = -DEBUG_REVEAL_RANGE; x <= DEBUG_REVEAL_RANGE; x++)
    for (let y = -DEBUG_REVEAL_RANGE; y <= DEBUG_REVEAL_RANGE; y++)
      gameState.revealed.add(`${x},${y}`);
  invalidateBounds();
}
export function restoreRealRevealed() {
  gameState.revealed = new Set(realRevealedSet);
  invalidateBounds();
}
export function getOpenAreaBounds() {
  if (!boundsDirty && cachedBounds) return cachedBounds;
  if (gameState.revealed.size === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  gameState.revealed.forEach(key => {
    const [x, y] = key.split(',').map(Number);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  });
  cachedBounds = { minX, maxX, minY, maxY };
  boundsDirty = false;
  return cachedBounds;
}
export function invalidateBounds() { boundsDirty = true; cachedBounds = null; }
export function clampCameraToOpenArea() {
  const bounds = getOpenAreaBounds();
  if (!bounds) return;
  const p = CAMERA_BOUNDARY_PADDING;
  camera.targetX = Math.max(bounds.minX - p, Math.min(bounds.maxX + 1 + p, camera.targetX));
  camera.targetY = Math.max(bounds.minY - p, Math.min(bounds.maxY + 1 + p, camera.targetY));
}

// ---------- камера: панорама, зум, центр ----------
export function panCameraByCell(dx, dy) {
  camera.targetX += dx;
  camera.targetY += dy;
}
export function smoothCenterOn(x, y) { camera.targetX = x + 0.5; camera.targetY = y + 0.5; }
export function resetView() {
  if (gameState.lastMove) {
    const [x, y] = gameState.lastMove.split(',').map(Number);
    smoothCenterOn(x, y);
  } else {
    camera.targetX = 0.5;
    camera.targetY = 0.5;
    camera.targetZoom = 2;
  }
  if (canvas && !touchMode) {
    mousePixel = { x: canvas.width / 2, y: canvas.height / 2 };
    hoverActive = true;
    lastMouseAt = Date.now();
  }
}
export function zoomIn() { camera.targetZoom = Math.min(MAX_ZOOM, camera.targetZoom * 1.3); }
export function zoomOut() { camera.targetZoom = Math.max(MIN_ZOOM, camera.targetZoom / 1.3); }
function updateCamera() {
  clampCameraToOpenArea();
  const lerp = 0.15;
  camera.x += (camera.targetX - camera.x) * lerp;
  camera.y += (camera.targetY - camera.y) * lerp;
  camera.zoom += (camera.targetZoom - camera.zoom) * lerp;
}

// ---------- победная линия ----------
export function checkWinnerInMap(movesMap, x, y, symbol) {
  const dirs = [[[1,0],[-1,0]], [[0,1],[0,-1]], [[1,1],[-1,-1]], [[1,-1],[-1,1]]];
  for (const [d1, d2] of dirs) {
    let cells = [`${x},${y}`];
    for (let i = 1; i < 5; i++) { const k = `${x + d1[0]*i},${y + d1[1]*i}`; if (movesMap[k] === symbol) cells.push(k); else break; }
    for (let i = 1; i < 5; i++) { const k = `${x + d2[0]*i},${y + d2[1]*i}`; if (movesMap[k] === symbol) cells.push(k); else break; }
    if (cells.length >= 5) {
      cells.sort((a, b) => {
        const [ax, ay] = a.split(',').map(Number);
        const [bx, by] = b.split(',').map(Number);
        return ax !== bx ? ax - bx : ay - by;
      });
      return cells;
    }
  }
  return null;
}

// ---------- локальное применение/откат хода ----------
export function applyMoveLocally(cellKey, sym, revealedAdded, winningCells) {
  gameState.moves[cellKey] = sym;
  for (const nk of revealedAdded) {
    gameState.revealed.add(nk);
    realRevealedSet.add(nk);
  }
  gameState.currentTurn = OTHER[sym];
  gameState.turnStartTime = Date.now();
  gameState.lastMove = cellKey;
  lastHighlightedMove = cellKey;
  highlightStartTime = Date.now();
  if (winningCells) {
    gameState.winningCells = winningCells;
    gameState.winTime = Date.now();
  }
  invalidateBounds();
}
export function rollbackMoveLocally(cellKey, revealedAdded, prev) {
  delete gameState.moves[cellKey];
  for (const nk of revealedAdded) {
    gameState.revealed.delete(nk);
    realRevealedSet.delete(nk);
  }
  gameState.currentTurn = prev.currentTurn;
  gameState.turnStartTime = prev.turnStartTime;
  gameState.lastMove = prev.lastMove;
  lastHighlightedMove = prev.lastHighlightedMove;
  highlightStartTime = prev.highlightStartTime;
  gameState.winningCells = prev.winningCells;
  gameState.winTime = prev.winTime;
  invalidateBounds();
}
// синхронизация оптимистичного хода, пока транзакция в пути
export function applyOptimisticSync(cellKey, sym, addedKeys) {
  gameState.moves[cellKey] = sym;
  for (const nk of addedKeys) {
    gameState.revealed.add(nk);
    realRevealedSet.add(nk);
  }
  gameState.currentTurn = OTHER[sym];
  gameState.lastMove = cellKey;
  invalidateBounds();
}
// полная синхронизация состояния из серверного документа
export function syncFromServer(g) {
  gameState.moves = g.moves || {};
  setRevealedBase(g.revealed || []);
  gameState.currentTurn = g.currentTurn;
  gameState.playerX = g.playerX;
  gameState.playerO = g.playerO;
  gameState.lastMove = g.lastMove;
  gameState.gameStartTime = g.gameStartTime;
  gameState.turnStartTime = g.turnStartTime;
  gameState.winningCells = g.winningCells || null;
  gameState.winTime = g.winTime || null;
  gameState.pausedAt = g.pausedAt || null;
  gameState.turnRemainingFrozen = g.turnRemainingFrozen != null ? g.turnRemainingFrozen : null;
  gameState.pausedTotalMs = g.pausedTotalMs || 0;
  gameState.pauseRequestedBy = g.pauseRequestedBy || null;
  gameState.pauseRequestedByName = g.pauseRequestedByName || null;
  gameState.pauseResumeX = !!g.pauseResumeX;
  gameState.pauseResumeO = !!g.pauseResumeO;
  if (g.playerXLastActivity && (!gameState.playerXLastActivity || g.playerXLastActivity > gameState.playerXLastActivity)) gameState.playerXLastActivity = g.playerXLastActivity;
  if (g.playerOLastActivity && (!gameState.playerOLastActivity || g.playerOLastActivity > gameState.playerOLastActivity)) gameState.playerOLastActivity = g.playerOLastActivity;
}
export function highlightMove(key) {
  lastHighlightedMove = key;
  highlightStartTime = Date.now();
}
export function snapshotHighlight() {
  return { lastHighlightedMove: lastHighlightedMove, highlightStartTime: highlightStartTime };
}
export function restoreHighlight(snap) {
  lastHighlightedMove = snap.lastHighlightedMove;
  highlightStartTime = snap.highlightStartTime;
}

// ---------- лотерея символа ----------
export function dropLottery() {
  lottery = null;
  lotteryRevealed = false;
  if (lotteryRevealTimer) { clearTimeout(lotteryRevealTimer); lotteryRevealTimer = null; }
}
export function beginLottery(sym, reducedMotion) {
  dropLottery();
  if (reducedMotion || !canvas) {
    lotteryRevealed = true;
    return;
  }
  lottery = { startTime: Date.now(), mySymbol: sym };
  lotteryRevealTimer = setTimeout(() => {
    lotteryRevealTimer = null;
    if (lottery && !lotteryRevealed && gameStatus === STATUS_PLAYING) {
      lotteryRevealed = true;
      if (lotteryRevealHook) lotteryRevealHook(sym, true);
    }
  }, LOTTERY_BRAKE_END);
}
export function cancelLotteryPlain(sym) {
  lottery = null;
  if (lotteryRevealTimer) { clearTimeout(lotteryRevealTimer); lotteryRevealTimer = null; }
  if (!lotteryRevealed) {
    lotteryRevealed = true;
    if (lotteryRevealHook) lotteryRevealHook(sym, false);
  }
}
export function isLotteryActive() { return !!lottery && !lotteryRevealed; }
export function isLotteryRevealed() { return lotteryRevealed; }

// ---------- прицел: плавная подсветка и цвет ----------
function mixChannel(a, b, t) { return Math.round(a + (b - a) * t); }
export function updateAimVisuals(dt) {
  if (!canvas) return;
  const cell = getAimCell();
  const key = cell.x + ',' + cell.y;
  const avail = canMoveInCell(cell.x, cell.y);
  aimKey = key;
  aimAvail = avail;
  const rate = dt / AIM_FADE_MS;
  if (avail && !(key in hlAlpha)) hlAlpha[key] = 0;
  for (const k in hlAlpha) {
    const target = (k === key && avail) ? 1 : 0;
    let a = hlAlpha[k] + (target > hlAlpha[k] ? rate : -rate);
    a = Math.max(0, Math.min(1, a));
    if (a <= 0) delete hlAlpha[k]; else hlAlpha[k] = a;
  }
  const g = avail ? 1 : 0;
  crossGreen += (g > crossGreen) ? Math.min(1 - crossGreen, rate) : Math.max(-crossGreen, -rate);
}
function drawCellHighlights(minX, maxX, minY, maxY, centerX, centerY, size) {
  for (const k in hlAlpha) {
    const a = hlAlpha[k];
    if (a <= 0) continue;
    const [x, y] = k.split(',').map(Number);
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    if (!gameState.revealed.has(k)) continue;
    const sx = centerX + (x - camera.x) * size;
    const sy = centerY + (y - camera.y) * size;
    ctx.fillStyle = 'rgba(129,199,132,' + (0.18 * a).toFixed(3) + ')';
    ctx.fillRect(sx, sy, size, size);
    ctx.strokeStyle = 'rgba(76,175,80,' + (0.45 * a).toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, sy + 0.5, size - 1, size - 1);
  }
}
function drawCrosshair() {
  if (!canvas || !ctx) {
    crosshairX = null;
    crosshairY = null;
    return;
  }
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const size = CELL_SIZE * camera.zoom;
  let px, py;
  if (touchMode) {
    const cell = getCenterCell();
    px = cx + (cell.x + 0.5 - camera.x) * size;
    py = cy + (cell.y + 0.5 - camera.y) * size;
  } else if (aimMode === 'mouse' && mousePixel) {
    px = mousePixel.x;
    py = mousePixel.y;
  } else {
    const cell = getCenterCell();
    px = cx + (cell.x + 0.5 - camera.x) * size;
    py = cy + (cell.y + 0.5 - camera.y) * size;
  }
  crosshairX = px;
  crosshairY = py;
  const col = 'rgb(' + mixChannel(120, 76, crossGreen) + ',' + mixChannel(120, 175, crossGreen) + ',' + mixChannel(120, 80, crossGreen) + ')';
  const r = Math.max(6, size * 0.22);
  const tick = Math.max(3, size * 0.12);
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px - r - tick, py); ctx.lineTo(px - r + tick / 2, py);
  ctx.moveTo(px + r - tick / 2, py); ctx.lineTo(px + r + tick, py);
  ctx.moveTo(px, py - r - tick); ctx.lineTo(px, py - r + tick / 2);
  ctx.moveTo(px, py + r - tick / 2); ctx.lineTo(px, py + r + tick);
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(px, py, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
export function refreshCanvasCursor() {
  if (!canvas) return;
  let val;
  if (touchMode) {
    val = 'default';
  } else if ((camera.isDragging && draggedFlag) || holdActive) {
    val = 'grabbing';
  } else if (gameStatus !== STATUS_PLAYING) {
    val = 'default';
  } else {
    val = 'none';
  }
  if (val !== lastCursorStyle) {
    lastCursorStyle = val;
    canvas.style.cursor = val;
  }
}

// ---------- лотерея: отрисовка ----------
function lotteryAngle(t) {
  if (t <= LOTTERY_SLOW_END) return LOTTERY_OMEGA_SLOW * t;
  const aSlow = LOTTERY_OMEGA_SLOW * LOTTERY_SLOW_END;
  if (t <= LOTTERY_FAST_END) return aSlow + LOTTERY_OMEGA_FAST * (t - LOTTERY_SLOW_END);
  const aFast = aSlow + LOTTERY_OMEGA_FAST * (LOTTERY_FAST_END - LOTTERY_SLOW_END);
  const u = Math.min(1, (t - LOTTERY_FAST_END) / (LOTTERY_BRAKE_END - LOTTERY_FAST_END));
  return aFast + LOTTERY_OMEGA_FAST * (LOTTERY_BRAKE_END - LOTTERY_FAST_END) * (u - u * u + u * u * u / 3);
}
function drawCoin(x, y, symbol, theta, scale, glow, alpha) {
  const color = symbol === 'X' ? '#667eea' : '#764ba2';
  const R = 46 * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (glow > 0) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.shadowBlur = 0;
  const c = Math.cos(theta);
  if (Math.abs(c) < 0.06) {
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.9);
    ctx.lineTo(0, R * 0.9);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#9e9e9e';
    ctx.stroke();
  } else {
    ctx.scale(c, 1);
    ctx.fillStyle = color;
    ctx.font = `900 ${Math.round(58 * scale)}px Segoe UI, Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(symbol, 0, 2);
  }
  ctx.restore();
}
function drawLottery() {
  if (!lottery || !canvas || !ctx) return;
  const t = Date.now() - lottery.startTime;
  if (t >= LOTTERY_FADE_END) { lottery = null; return; }
  const myS = lottery.mySymbol;
  const oppS = OTHER[myS];
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  let overlayAlpha = 1;
  if (t > LOTTERY_REVEAL_END) {
    overlayAlpha = Math.max(0, 1 - (t - LOTTERY_REVEAL_END) / (LOTTERY_FADE_END - LOTTERY_REVEAL_END));
  }
  ctx.save();
  ctx.globalAlpha = 0.65 * overlayAlpha;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = overlayAlpha;
  if (t < LOTTERY_BRAKE_END) {
    const theta = lotteryAngle(t);
    drawCoin(cx - 80, cy, 'X', theta, 1, 0, overlayAlpha);
    drawCoin(cx + 80, cy, 'O', theta, 1, 0, overlayAlpha);
    ctx.fillStyle = '#666';
    ctx.font = 'bold 15px Segoe UI, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\u{1F3B0} Розыгрыш символа...', cx, cy - 95);
  } else {
    const r = Math.min(1, (t - LOTTERY_BRAKE_END) / 1200);
    const ease = 1 - Math.pow(1 - r, 3);
    const myStartX = myS === 'X' ? cx - 80 : cx + 80;
    const oppStartX = myS === 'X' ? cx + 80 : cx - 80;
    const oppTargetX = oppStartX + (oppStartX > cx ? 100 : -100);
    const myX = myStartX + (cx - myStartX) * ease;
    const oppX = oppStartX + (oppTargetX - oppStartX) * ease;
    const myScale = 1 + 0.55 * ease;
    const myGlow = 28 * ease;
    const oppAlpha = overlayAlpha * (1 - 0.55 * ease);
    drawCoin(oppX, cy, oppS, 0, 1, 0, oppAlpha);
    drawCoin(myX, cy, myS, 0, myScale, myGlow, overlayAlpha);
    if (r > 0.45) {
      const labelAlpha = overlayAlpha * Math.min(1, (r - 0.45) / 0.4);
      ctx.globalAlpha = labelAlpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 15px Segoe UI, Arial';
      ctx.fillStyle = myS === 'X' ? '#667eea' : '#764ba2';
      ctx.fillText('ВЫ', cx, cy + 85);
      ctx.fillStyle = '#999';
      ctx.fillText('СОПЕРНИК', oppX, cy + 62);
    }
  }
  ctx.restore();
}

// ---------- победная линия: отрисовка ----------
function drawWinningLine() {
  if (!gameState.winningCells || gameState.winningCells.length < 2 || !gameState.winTime) return;
  const centerX = canvas.width / 2, centerY = canvas.height / 2, size = CELL_SIZE * camera.zoom;
  const [fx, fy] = gameState.winningCells[0].split(',').map(Number);
  const [lx, ly] = gameState.winningCells[gameState.winningCells.length - 1].split(',').map(Number);
  const sx = centerX + (fx + 0.5 - camera.x) * size, sy = centerY + (fy + 0.5 - camera.y) * size;
  const ex = centerX + (lx + 0.5 - camera.x) * size, ey = centerY + (ly + 0.5 - camera.y) * size;
  const elapsed = (Date.now() - gameState.winTime) / 1000;
  const progress = Math.min(1, elapsed / WIN_LINE_ANIMATION_DURATION);
  const cx2 = sx + (ex - sx) * progress, cy2 = sy + (ey - sy) * progress;
  let lw = 4, alpha = 1, glow = 15;
  if (progress >= 1) {
    const p = ((elapsed - WIN_LINE_ANIMATION_DURATION) % 1.5) / 1.5;
    const pulse = Math.sin(p * Math.PI * 2);
    alpha = 0.7 + 0.3 * pulse; lw = 4 + 2 * pulse; glow = 15 + 10 * pulse;
  }
  ctx.save();
  ctx.shadowColor = `rgba(255,50,50,${alpha * 0.8})`; ctx.shadowBlur = glow;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cx2, cy2);
  ctx.strokeStyle = `rgba(255,50,50,${alpha})`; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();
  ctx.shadowBlur = 0;
  if (progress >= 1) {
    ctx.fillStyle = `rgba(255,50,50,${alpha})`;
    ctx.beginPath(); ctx.arc(sx, sy, lw + 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex, ey, lw + 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ---------- поле: отрисовка ----------
function drawBoard() {
  if (!canvas || !ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const centerX = canvas.width / 2, centerY = canvas.height / 2, size = CELL_SIZE * camera.zoom;
  const visibleRangeX = Math.ceil(canvas.width / (2 * size)) + 2;
  const visibleRangeY = Math.ceil(canvas.height / (2 * size)) + 2;
  let minX = Math.floor(camera.x - visibleRangeX), maxX = Math.ceil(camera.x + visibleRangeX);
  let minY = Math.floor(camera.y - visibleRangeY), maxY = Math.ceil(camera.y + visibleRangeY);
  const bounds = getOpenAreaBounds();
  if (bounds) {
    minX = Math.max(minX, bounds.minX); maxX = Math.min(maxX, bounds.maxX);
    minY = Math.max(minY, bounds.minY); maxY = Math.min(maxY, bounds.maxY);
  }
  if (minX <= maxX && minY <= maxY) {
    ctx.beginPath();
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const key = `${x},${y}`;
        if (!gameState.revealed.has(key)) continue;
        const screenX = centerX + (x - camera.x) * size;
        const screenY = centerY + (y - camera.y) * size;
        ctx.rect(screenX, screenY, size, size);
      }
    }
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (lastHighlightedMove) {
      const elapsed = Date.now() - highlightStartTime;
      if (elapsed < 3000) {
        const [hx, hy] = lastHighlightedMove.split(',').map(Number);
        if (hx >= minX && hx <= maxX && hy >= minY && hy <= maxY && gameState.revealed.has(lastHighlightedMove)) {
          const sx = centerX + (hx - camera.x) * size;
          const sy = centerY + (hy - camera.y) * size;
          ctx.fillStyle = `rgba(255, 215, 0, ${Math.max(0, 1 - elapsed / 3000) * 0.6})`;
          ctx.fillRect(sx, sy, size, size);
        }
      } else {
        lastHighlightedMove = null;
      }
    }
    drawCellHighlights(minX, maxX, minY, maxY, centerX, centerY, size);
    ctx.font = `bold ${size * 0.75}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const key = `${x},${y}`;
        const symbol = gameState.moves[key];
        if (!symbol) continue;
        const screenX = centerX + (x - camera.x) * size;
        const screenY = centerY + (y - camera.y) * size;
        ctx.fillStyle = symbol === 'X' ? '#667eea' : '#764ba2';
        ctx.fillText(symbol, screenX + size / 2, screenY + size / 2);
      }
    }
  }
  drawWinningLine();
  drawCrosshair();
  drawLottery();
}

// ---------- цикл рендера ----------
export function startRenderLoop() {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  function render() {
    const nowTs = performance.now();
    const dt = Math.min(50, nowTs - (lastFrameTs || nowTs));
    lastFrameTs = nowTs;
    try {
      updateCamera();
      updateAimVisuals(dt);
      drawBoard();
    } catch (err) {
      if (!renderErrorLogged) {
        renderErrorLogged = true;
        console.error('Ошибка рендера (цикл продолжен):', err);
      }
    }
    animationFrameId = requestAnimationFrame(render);
  }
  render();
}
export function stopRenderLoop() {
  if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
}

// ---------- ввод: мышь и тач ----------
function updateMousePixel(e) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  mousePixel = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  lastMouseAt = Date.now();
}
function clearHoldTimer() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
}
function pinchDistance() {
  const pts = Array.from(activePointers.values());
  if (pts.length < 2) return 0;
  const dx = pts[0].x - pts[1].x;
  const dy = pts[0].y - pts[1].y;
  return Math.sqrt(dx * dx + dy * dy);
}
function handlePointerEnter(e) {
  if (e.pointerType === 'touch') return;
  hoverActive = true;
  aimMode = 'mouse';
  updateMousePixel(e);
  refreshCanvasCursor();
}
function handlePointerLeave(e) {
  if (e.pointerType === 'touch') {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinching = false;
    camera.isDragging = false;
    holdActive = false;
    clearHoldTimer();
    return;
  }
  hoverActive = false;
  mousePixel = null;
  camera.isDragging = false;
  holdActive = false;
  clearHoldTimer();
  crosshairX = null;
  crosshairY = null;
  refreshCanvasCursor();
}
function handlePointerDown(e) {
  if (e.pointerType === 'touch') {
    touchMode = true;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) {
      pinching = true;
      pinchStartDist = pinchDistance();
      pinchStartZoom = camera.targetZoom;
      camera.isDragging = false;
      draggedFlag = false;
      holdActive = false;
      clearHoldTimer();
      return;
    }
    if (activePointers.size > 2) return;
  }
  updateMousePixel(e);
  try { if (e.pointerId !== undefined) canvas.setPointerCapture(e.pointerId); } catch (err) {}
  camera.isDragging = true;
  draggedFlag = false;
  holdActive = false;
  mouseDownButton = e.button;
  mouseDownTime = Date.now();
  mouseDownPos = { x: e.clientX, y: e.clientY };
  camera.dragStartX = e.clientX;
  camera.dragStartY = e.clientY;
  camera.dragCameraStartX = camera.targetX;
  camera.dragCameraStartY = camera.targetY;
  clearHoldTimer();
  holdTimer = setTimeout(() => {
    if (camera.isDragging) {
      holdActive = true;
      refreshCanvasCursor();
    }
  }, LONG_PRESS_MS);
}
function handlePointerMove(e) {
  if (e.pointerType === 'touch' && activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinching && activePointers.size >= 2) {
      const d = pinchDistance();
      if (pinchStartDist > 0 && d > 0) {
        camera.targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartZoom * (d / pinchStartDist)));
      }
      return;
    }
  }
  if (e.pointerType !== 'touch') aimMode = 'mouse';
  updateMousePixel(e);
  if (!camera.isDragging) return;
  const moved = Math.abs(e.clientX - mouseDownPos.x) + Math.abs(e.clientY - mouseDownPos.y);
  if (moved > DRAG_THRESHOLD_PX) draggedFlag = true;
  if (draggedFlag) {
    camera.targetX = camera.dragCameraStartX - (e.clientX - camera.dragStartX) / (CELL_SIZE * camera.zoom);
    camera.targetY = camera.dragCameraStartY - (e.clientY - camera.dragStartY) / (CELL_SIZE * camera.zoom);
  }
  refreshCanvasCursor();
}
function handlePointerUp(e) {
  if (e.pointerType === 'touch') {
    activePointers.delete(e.pointerId);
    if (pinching) {
      if (activePointers.size < 2) pinching = false;
      camera.isDragging = false;
      draggedFlag = false;
      holdActive = false;
      clearHoldTimer();
      return;
    }
  }
  clearHoldTimer();
  const heldMs = Date.now() - mouseDownTime;
  const wasDrag = draggedFlag;
  const wasHold = holdActive;
  const wasLeftButton = (mouseDownButton === 0 && e.button === 0) || e.pointerType === 'touch';
  camera.isDragging = false;
  draggedFlag = false;
  holdActive = false;
  try { if (e.pointerId !== undefined) canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  refreshCanvasCursor();
  if (!wasLeftButton) return;
  if (!wasDrag && !wasHold && heldMs < LONG_PRESS_MS && moveRequestHook) {
    if (touchMode) {
      const tc = getTouchCell();
      const cc = getCenterCell();
      if (tc && tc.x === cc.x && tc.y === cc.y) moveRequestHook(cc.x, cc.y);
    } else {
      const cell = getAimCell();
      if (cell) moveRequestHook(cell.x, cell.y);
    }
  }
}
function handleWheel(e) {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1.15 : 0.87;
  const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.targetZoom * delta));
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const wx = camera.targetX + (mx - cx) / (CELL_SIZE * camera.targetZoom);
  const wy = camera.targetY + (my - cy) / (CELL_SIZE * camera.targetZoom);
  camera.targetX = wx - (mx - cx) / (CELL_SIZE * nz);
  camera.targetY = wy - (my - cy) / (CELL_SIZE * nz);
  camera.targetZoom = nz;
}
function handleContextMenu(e) { e.preventDefault(); }
export function attachCanvasListeners(el) {
  if (canvasListenersAttached) return;
  el.addEventListener('wheel', handleWheel, { passive: false });
  el.addEventListener('pointerdown', handlePointerDown);
  el.addEventListener('pointermove', handlePointerMove);
  el.addEventListener('pointerup', handlePointerUp);
  el.addEventListener('pointercancel', handlePointerLeave);
  el.addEventListener('pointerleave', handlePointerLeave);
  el.addEventListener('pointerenter', handlePointerEnter);
  el.addEventListener('contextmenu', handleContextMenu);
  canvasListenersAttached = true;
}
export function detachCanvasListeners(el) {
  if (!canvasListenersAttached || !el) return;
  el.removeEventListener('wheel', handleWheel);
  el.removeEventListener('pointerdown', handlePointerDown);
  el.removeEventListener('pointermove', handlePointerMove);
  el.removeEventListener('pointerup', handlePointerUp);
  el.removeEventListener('pointercancel', handlePointerLeave);
  el.removeEventListener('pointerleave', handlePointerLeave);
  el.removeEventListener('pointerenter', handlePointerEnter);
  el.removeEventListener('contextmenu', handleContextMenu);
  canvasListenersAttached = false;
}

// ---------- полный сброс ядра (выход из партии) ----------
export function resetCoreState() {
  stopRenderLoop();
  mousePixel = null;
  hoverActive = false;
  holdActive = false;
  clearHoldTimer();
  draggedFlag = false;
  crosshairX = null;
  crosshairY = null;
  lastMouseAt = 0;
  aimMode = 'mouse';
  crossGreen = 0;
  aimKey = null;
  aimAvail = false;
  for (const k in hlAlpha) delete hlAlpha[k];
  lastHighlightedMove = null;
  highlightStartTime = 0;
  dropLottery();
  lastCursorStyle = '';
  pinching = false;
  activePointers.clear();
  camera.isDragging = false;
}
export function resetCamera() {
  camera.x = 0.5; camera.y = 0.5; camera.zoom = 2;
  camera.targetX = 0.5; camera.targetY = 0.5; camera.targetZoom = 2;
}

console.log(`%c[CORE] модуль ядра загружен (core ${MODULE_VERSION})`, 'color: #2196f3; font-weight: bold;');