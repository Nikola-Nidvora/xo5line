// ============================================================
// XO5 · 5 в ряд · Модуль 4/8: онлайн (Firebase, сессии, лобби, транзакции)
// v2.0.7 (центрирование прицела на ход соперника на ПК)
// ============================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, updateProfile, onAuthStateChanged,
  browserLocalPersistence, setPersistence,
  deleteUser, reauthenticateWithCredential, EmailAuthProvider
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, updateDoc, deleteDoc,
  onSnapshot, query, where, setDoc, runTransaction, increment
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
  TURN_AUTO_END_TIME, TURN_WARNING_TIME, WAITING_TIMEOUT, PLAYING_INACTIVE_TIMEOUT,
  PAUSE_MAX_MS, RECONNECT_TIMEOUT, IDLE_SLEEP_TIMEOUT, PAUSE_WARN_MS,
  WIN_MODAL_DELAY, ACTIVITY_UPDATE_INTERVAL, OPPONENT_OFFLINE_THRESHOLD,
  WAITING_CHECK_INTERVAL, FINISHED_GAME_TIMEOUT, JOIN_NOTIFICATION_DURATION,
  CREATOR_HEARTBEAT_INTERVAL, LOBBY_CLEANUP_INTERVAL, SESSION_HEARTBEAT_INTERVAL,
  SESSION_LEASE_MS, SESSION_RELEASE_GRACE_MS, BLOCKED_RETRY_INTERVAL,
  MAX_ACTIVE_GAMES, CONNECTION_CHECK_INTERVAL, CONNECTION_PING_INTERVAL, CONNECTION_TIMEOUT,
  UNDO_WINDOW_MS, ROOM_NUMBER_MAX, NUDGE_COOLDOWN_MS, NUDGE_PONG_TIMEOUT,
  NUDGE_STALE_NOW_MS, MOVE_REMINDER_MS, FORCE_CLEAR_FRESH_MS,
  MAX_CATALOG_ROOMS, ORPHAN_CHECK_INTERVAL, ORPHAN_HEAL_THRESHOLD,
  NAME_MAX_REGISTER, NAME_MAX_LOGIN, EMAIL_DOMAIN, NAME_RULE_HINT,
  OTHER, LOBBY_MAIN, LOBBY_WAITING,
  STATUS_WAITING, STATUS_PLAYING, STATUS_PAUSED, STATUS_COMPLETED, STATUS_CANCELLED,
  LOOSER_PHRASES, CANCEL_PHRASES, GAME_CONFIG_DEFAULTS
} from './xo5-constants.js';
import * as core from './xo5-core.js';
import * as ui from './xo5-ui.js';
import * as bot from './xo5-bot.js';

// ---------- Версия модуля и регистрация в реестре ----------
export const MODULE_VERSION = '1.0.4';
if (typeof window !== 'undefined') {
  window.XO5_VERSIONS = window.XO5_VERSIONS || {};
  window.XO5_VERSIONS.online = MODULE_VERSION;
}

// ---------- Firebase ----------
const firebaseConfig = {
  apiKey: "AIzaSyBErGlVe3j1IIPYiBGz2TAJxr96uV1Nff0",
  authDomain: "xo5line.firebaseapp.com",
  projectId: "xo5line",
  storageBucket: "xo5line.firebasestorage.app",
  messagingSenderId: "465510523600",
  appId: "1:465510523600:web:ad8c4b628d32ea3dc2f4d5"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

setPersistence(auth, browserLocalPersistence).then(() => {
  console.log('%c[OK] Сессия будет сохраняться после закрытия браузера', 'color: #4caf50; font-weight: bold;');
}).catch((error) => {
  console.log('[WARN] Не удалось установить персистентность:', error);
});

// ---------- удалённый конфиг ----------
export let lobbyConfig = { staleGameDays: 5 };
function numMin(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  if (n < min) return min;
  if (n > max) return max;
  return Math.round(n);
}
function applyGameConfig(g) {
  const d = GAME_CONFIG_DEFAULTS;
  const autoEnd = numMin(g.turnAutoEndMin, d.turnAutoEndMin, 1, 240);
  const warn = numMin(g.turnWarningMin, d.turnWarningMin, 1, 240);
  TURN_AUTO_END_TIME = autoEnd * 60000;
  TURN_WARNING_TIME = Math.min(warn, Math.max(1, autoEnd - 1)) * 60000;
  WAITING_TIMEOUT = numMin(g.waitingTimeoutMin, d.waitingTimeoutMin, 1, 120) * 60000;
  PLAYING_INACTIVE_TIMEOUT = numMin(g.playingInactiveMin, d.playingInactiveMin, 5, 1440) * 60000;
  PAUSE_MAX_MS = numMin(g.pauseMaxHours, d.pauseMaxHours, 1, 720) * 3600000;
  RECONNECT_TIMEOUT = numMin(g.reconnectMin, d.reconnectMin, 1, 240) * 60000;
  IDLE_SLEEP_TIMEOUT = numMin(g.idleSleepMin, d.idleSleepMin, 1, 120) * 60000;
}
export async function loadRemoteConfig() {
  try {
    const snap = await getDoc(doc(db, 'config', 'app'));
    if (snap.exists()) {
      const d = snap.data();
      const j = d.janitor || {};
      const days = Number(j.staleGameDays);
      if (Number.isFinite(days) && days >= 1 && days <= 365) lobbyConfig.staleGameDays = days;
      applyGameConfig(d.game || {});
    }
  } catch (e) {
    console.warn('[CONFIG] config/app недоступен, пороги по умолчанию:', e && e.code ? e.code : e);
  }
}
export function getLastMoveAt(g) { return g.turnStartTime || g.gameStartTime || g.createdAt || 0; }
export function isStaleGame(g, now) {
  const anchor = getLastMoveAt(g);
  return anchor > 0 && (now - anchor) > lobbyConfig.staleGameDays * 86400000;
}
export function isCardStale(card, now) {
  if (card.status === STATUS_WAITING) return (now - (card.createdAt || 0)) > WAITING_TIMEOUT;
  if (card.status === STATUS_COMPLETED || card.status === STATUS_CANCELLED) return card.endedAt && (now - card.endedAt) > FINISHED_GAME_TIMEOUT;
  if (card.status === STATUS_PAUSED) return card.pausedAt && (now - card.pausedAt) > PAUSE_MAX_MS;
  return false;
}
export function isNewerVersion(remote, local) {
  const pa = String(remote).split('.').map(Number);
  const pb = String(local).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = pa[i] || 0, b = pb[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

// ---------- идентификаторы сессии ----------
function getBrowserId() {
  try {
    let id = localStorage.getItem('ttt5BrowserSessionId');
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
      localStorage.setItem('ttt5BrowserSessionId', id);
    }
    return id;
  } catch (e) {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
}
function getTabId() {
  try {
    let id = sessionStorage.getItem('ttt5TabId');
    if (!id) {
      id = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
      sessionStorage.setItem('ttt5TabId', id);
    }
    return id;
  } catch (e) {
    return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  }
}
export const BROWSER_ID = getBrowserId();
export const TAB_ID = getTabId();
export const SESSION_ID = BROWSER_ID + ':' + TAB_ID;

// ---------- глобальное состояние ----------
export let currentUser = null;
export let currentGame = null;
export let myCreatedGameId = null;
export let myCreatedSlot = null;
export let myActiveGameId = null;
export let appEntered = false;
export let gameEndHandled = false;
export let lastLobbySnapshot = [];
export let waitingStartTime = null;
let gameListener = null;
let activityListener = null;
let gamesListener = null;
let myCreatedGameListener = null;
let sessionHeartbeatInterval = null;
let creatorHeartbeatInterval = null;
let waitingTimerInterval = null;
let activityInterval = null;
let orphanCheckInterval = null;
const orphanCheckingIds = new Set();
let pendingUser = null;
let blockCheckInterval = null;
let banListener = null;
export let banKickActive = false;
let lastKnownMoveCount = 0;
let optimisticMove = null;
let moveInFlightPromise = null;
let undoInfo = null;
let undoHideTimer = null;
let undoUsedThisCycle = false;
let nudgeCooldownUntil = 0;
let nudgeProbe = null;
let nudgeProbeTimer = null;
let lastNudgeSeenAt = 0;
let lastPongedAt = 0;
let rebuildInProgress = false;

export function getCurrentUser() { return currentUser; }
export function getCurrentGame() { return currentGame; }
export function getMyCreatedGameId() { return myCreatedGameId; }
export function getMyActiveGameId() { return myActiveGameId; }
export function getAppEntered() { return appEntered; }
export function getGameEndHandled() { return gameEndHandled; }
export function setGameEndHandled(v) { gameEndHandled = !!v; }
export function getLastLobbySnapshot() { return lastLobbySnapshot; }
export function getWaitingStartTime() { return waitingStartTime; }
export function getUndoInfo() { return undoInfo; }
export function getUndoUsedThisCycle() { return undoUsedThisCycle; }
export function getNudgeCooldownUntil() { return nudgeCooldownUntil; }
export function getOptimisticMove() { return optimisticMove; }
export function getBanKickActive() { return banKickActive; }

// ---------- сохранённые id игр ----------
export function saveCreatedGameId(gameId) {
  try {
    sessionStorage.setItem('myCreatedGameId', gameId);
    localStorage.setItem('myCreatedGameId_persistent', gameId);
  } catch (e) {}
}
export function getSavedCreatedGameId() { try { return sessionStorage.getItem('myCreatedGameId'); } catch (e) { return null; } }
export function getPersistentCreatedGameId() { try { return localStorage.getItem('myCreatedGameId_persistent'); } catch (e) { return null; } }
export function clearSavedCreatedGameId() {
  try {
    sessionStorage.removeItem('myCreatedGameId');
    localStorage.removeItem('myCreatedGameId_persistent');
  } catch (e) {}
}
export function saveActiveGameId(gameId) { try { localStorage.setItem('myActiveGameId', gameId); } catch (e) {} }
export function getSavedActiveGameId() { try { return localStorage.getItem('myActiveGameId'); } catch (e) { return null; } }
export function clearSavedActiveGameId() { try { localStorage.removeItem('myActiveGameId'); } catch (e) {} }

// ---------- соединение ----------
let lastConnectionOk = 0;
let connectionError = false;
let connectionMonitorInterval = null;
let connectionPingInterval = null;
export function getConnectionDebug() {
  return { navigatorOnline: navigator.onLine, lastSuccessAgoSec: lastConnectionOk ? Math.floor((Date.now() - lastConnectionOk) / 1000) : null, connectionError: connectionError };
}
export function markConnectionOk(withBlink) {
  lastConnectionOk = Date.now();
  connectionError = false;
  ui.paintConnectionDot(true, false, withBlink);
}
export function markConnectionError() {
  connectionError = true;
  ui.paintConnectionDot(false, true, false);
}
function refreshConnectionDot() {
  const now = Date.now();
  let offline = false;
  if (!navigator.onLine || connectionError || (lastConnectionOk > 0 && now - lastConnectionOk > CONNECTION_TIMEOUT)) offline = true;
  ui.paintConnectionDot(!offline, offline, false, lastConnectionOk === 0);
}
export function startConnectionMonitor() {
  if (connectionMonitorInterval) clearInterval(connectionMonitorInterval);
  connectionMonitorInterval = setInterval(refreshConnectionDot, CONNECTION_CHECK_INTERVAL);
  if (connectionPingInterval) clearInterval(connectionPingInterval);
  connectionPingInterval = setInterval(() => {
    if (document.hidden || !currentUser || ui.getSleepMode()) return;
    const lobbyEl = document.getElementById('lobby-screen');
    if (!lobbyEl || !lobbyEl.classList.contains('active')) return;
    getDoc(catalogRef()).then(() => markConnectionOk(false)).catch(() => markConnectionError());
  }, CONNECTION_PING_INTERVAL);
}
window.addEventListener('online', () => refreshConnectionDot());
window.addEventListener('offline', () => refreshConnectionDot());

// ---------- каталог лобби ----------
export function catalogRef() { return doc(db, 'meta', 'lobby'); }
export function activityRef(gameId) { return doc(db, 'activity', gameId); }
export function cardFromGame(id, g) {
  return {
    id: id, roomName: g.roomName || '???', status: g.status,
    playerX: g.playerX || null, playerO: g.playerO || null,
    playerXName: g.playerXName || null, playerOName: g.playerOName || null,
    createdBy: g.createdBy || null, createdByName: g.createdByName || null,
    createdAt: g.createdAt || null, endedAt: g.endedAt || null,
    endReason: g.endReason || null, winner: g.winner || null,
    pausedAt: g.pausedAt || null,
    statsAppliedX: !!g.statsAppliedX, statsAppliedO: !!g.statsAppliedO,
    changedAt: Date.now()
  };
}
function upsertRoom(rooms, card) {
  const i = rooms.findIndex(r => r.id === card.id);
  if (i >= 0) rooms[i] = { ...rooms[i], ...card };
  else rooms.push(card);
}
function removeRoom(rooms, id) {
  const i = rooms.findIndex(r => r.id === id);
  if (i >= 0) rooms.splice(i, 1);
}
function trimRooms(rooms) {
  while (rooms.length > MAX_CATALOG_ROOMS) {
    let idx = rooms.findIndex(r => r.status === STATUS_COMPLETED || r.status === STATUS_CANCELLED);
    if (idx < 0) {
      idx = 0;
      for (let i = 1; i < rooms.length; i++) {
        if ((rooms[i].createdAt || 0) < (rooms[idx].createdAt || 0)) idx = i;
      }
    }
    rooms.splice(idx, 1);
  }
}
export async function updateCatalog(mutator) {
  try {
    await runTransaction(db, async (tx) => {
      const ref = catalogRef();
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : null;
      const rooms = data && Array.isArray(data.rooms) ? data.rooms.slice() : [];
      mutator(rooms);
      trimRooms(rooms);
      tx.set(ref, { rooms: rooms, updatedAt: Date.now() });
    });
  } catch (e) {
    console.warn('Каталог лобби не обновлён:', e && e.code ? e.code : e);
  }
}
export function upsertCatalogFromGame(gameId, game) {
  updateCatalog(rooms => upsertRoom(rooms, cardFromGame(gameId, game)));
}
export async function rebuildCatalog() {
  if (rebuildInProgress) return;
  rebuildInProgress = true;
  try {
    const snapshot = await getDocs(collection(db, 'games'));
    const now = Date.now();
    const rooms = [];
    snapshot.forEach(d => {
      const g = d.data();
      if (isStaleGame(g, now)) deleteDoc(doc(db, 'games', d.id)).catch(() => {});
      else rooms.push(cardFromGame(d.id, g));
    });
    await setDoc(catalogRef(), { rooms: rooms, updatedAt: now });
    markConnectionOk(false);
    console.log('[CATALOG] Пересобран, комнат:', rooms.length);
  } catch (e) {
    console.warn('Пересборка каталога не удалась:', e && e.code ? e.code : e);
    if (e && e.code === 'permission-denied') ui.showMessage('lobby-error', '\u26A0\uFE0F Нет доступа к каталогу лобби. Добавьте правило для /meta в консоли Firebase.');
  } finally {
    rebuildInProgress = false;
  }
}
export function startOrphanCheck() {
  stopOrphanCheck();
  orphanCheckInterval = setInterval(verifyOrphanedCards, ORPHAN_CHECK_INTERVAL);
}
export function stopOrphanCheck() {
  if (orphanCheckInterval) { clearInterval(orphanCheckInterval); orphanCheckInterval = null; }
}
function verifyOrphanedCards() {
  if (!currentUser) return;
  const now = Date.now();
  lastLobbySnapshot.forEach(({ id, game }) => {
    if (game.status === STATUS_COMPLETED || game.status === STATUS_CANCELLED) return;
    let suspicious = false;
    if (game.status === STATUS_WAITING) {
      const age = now - (game.createdAt || 0);
      suspicious = age > 120000 && age < WAITING_TIMEOUT;
    } else if (game.status === STATUS_PLAYING || game.status === STATUS_PAUSED) {
      const anchor = game.changedAt || game.createdAt || 0;
      suspicious = anchor && (now - anchor) > ORPHAN_HEAL_THRESHOLD;
    }
    if (!suspicious || orphanCheckingIds.has(id)) return;
    orphanCheckingIds.add(id);
    getDoc(doc(db, 'games', id)).then(snap => {
      if (!snap.exists()) {
        console.warn(`[HEAL] Игра ${id} не найдена — карточка удаляется из каталога`);
        updateCatalog(rooms => removeRoom(rooms, id));
        deleteDoc(activityRef(id)).catch(() => {});
        return;
      }
      const g = snap.data();
      if (g.status !== game.status) {
        console.warn(`[HEAL] Рассинхрон каталога по игре ${id}: каталог=${game.status}, документ=${g.status} — карточка лечится`);
        upsertCatalogFromGame(id, g);
        return;
      }
      if (g.status === STATUS_PLAYING && g.turnStartTime && (now - g.turnStartTime) > PLAYING_INACTIVE_TIMEOUT) {
        console.warn(`[HEAL] Игра ${id} заброшена — удаляется`);
        deleteDoc(doc(db, 'games', id)).catch(() => {});
        updateCatalog(rooms => removeRoom(rooms, id));
        deleteDoc(activityRef(id)).catch(() => {});
        return;
      }
      updateCatalog(rooms => {
        const r = rooms.find(x => x.id === id);
        if (r) r.changedAt = Date.now();
      });
    }).catch(e => {
      console.warn('Проверка карточки не удалась:', e);
    }).finally(() => {
      orphanCheckingIds.delete(id);
    });
  });
}

// ---------- сессии ----------
export function sessionActiveFromData(data) {
  if (!data.activeSessionId || !data.sessionLeaseUntil) return false;
  if (data.activeSessionId === SESSION_ID) return false;
  return Date.now() < data.sessionLeaseUntil;
}
async function checkSessionActive(uid) {
  try {
    const userDoc = await getDoc(doc(db, 'users', uid));
    markConnectionOk(false);
    if (!userDoc.exists()) return false;
    return sessionActiveFromData(userDoc.data());
  } catch (e) { markConnectionError(); return false; }
}
async function claimSession(uid) {
  try {
    await updateDoc(doc(db, 'users', uid), {
      activeSessionId: SESSION_ID,
      sessionLeaseUntil: Date.now() + SESSION_LEASE_MS,
      sessionLastActivity: Date.now()
    });
    markConnectionOk(false);
    return true;
  } catch (e) { markConnectionError(); return false; }
}
async function claimSessionWithLogin(uid) {
  try {
    await updateDoc(doc(db, 'users', uid), {
      activeSessionId: SESSION_ID,
      sessionLeaseUntil: Date.now() + SESSION_LEASE_MS,
      sessionLastActivity: Date.now(),
      lastLoginAt: Date.now()
    });
    markConnectionOk(false);
    return true;
  } catch (e) { markConnectionError(); return false; }
}
export async function releaseSession(uid) {
  try {
    await updateDoc(doc(db, 'users', uid), {
      activeSessionId: null, sessionLeaseUntil: null, sessionLastActivity: null
    });
  } catch (e) {
    console.log('releaseSession: документ не найден или уже удалён');
  }
}
async function graceSession(uid) {
  try {
    await updateDoc(doc(db, 'users', uid), { sessionLeaseUntil: Date.now() + SESSION_RELEASE_GRACE_MS });
  } catch (e) {}
}
function startSessionHeartbeat(uid) {
  stopSessionHeartbeat();
  sessionHeartbeatInterval = setInterval(async () => {
    if (!currentUser || ui.getAccountDeletionInProgress()) return;
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      if (!snap.exists()) { stopSessionHeartbeat(); return; }
      const d = snap.data();
      if (d.activeSessionId === SESSION_ID) {
        await updateDoc(doc(db, 'users', uid), {
          sessionLeaseUntil: Date.now() + SESSION_LEASE_MS,
          sessionLastActivity: Date.now()
        });
        markConnectionOk(true);
      } else if (d.activeSessionId == null || !d.sessionLeaseUntil || Date.now() > d.sessionLeaseUntil) {
        const ok = await claimSession(uid);
        if (!ok) console.warn('heartbeat: не удалось вернуть слот сессии');
      } else {
        stopSessionHeartbeat();
        await signOut(auth);
        ui.showMessage('auth-error', '\u26A0\uFE0F Сессия перехвачена другим браузером. Вход отменён.');
      }
    } catch (e) { markConnectionError(); }
  }, SESSION_HEARTBEAT_INTERVAL);
}
export function stopSessionHeartbeat() {
  if (sessionHeartbeatInterval) { clearInterval(sessionHeartbeatInterval); sessionHeartbeatInterval = null; }
}
window.addEventListener('pagehide', () => {
  if (currentUser && appEntered && !ui.getAccountDeletionInProgress() && !ui.getSleepMode()) graceSession(currentUser.uid);
});

// ---------- профиль и вход ----------
async function ensureProfileExists(user) {
  try {
    const profileSnap = await getDoc(doc(db, 'users', user.uid));
    if (!profileSnap.exists()) {
      await setDoc(doc(db, 'users', user.uid), {
        username: user.displayName || 'Игрок',
        createdAt: Date.now(), lastLoginAt: Date.now(),
        activeSessionId: SESSION_ID,
        sessionLeaseUntil: Date.now() + SESSION_LEASE_MS,
        sessionLastActivity: Date.now(),
        wins: 0, losses: 0, noResult: 0, gamesAsX: 0, gamesAsO: 0
      });
      console.log('%c[FIX] Профиль пересоздан', 'color: #ff9800; font-weight: bold;');
    }
  } catch (e) {
    console.warn('Не удалось проверить/создать профиль:', e);
  }
}

let enterAppInFlight = false;
export async function enterApp(user, steal) {
  if (appEntered || enterAppInFlight) return;
  enterAppInFlight = true;
  try {
    let profileSnap = null;
    try {
      profileSnap = await getDoc(doc(db, 'users', user.uid));
      markConnectionOk(false);
    } catch (e) {
      markConnectionError();
      console.warn('[ENTER] Не удалось прочитать профиль:', e && e.code ? e.code : e);
    }
    if (profileSnap && profileSnap.exists()) {
      const pd = profileSnap.data();
      if (pd.banned === true) {
        console.warn('[BAN] Вход заблокирован: у профиля banned=true');
        ui.showBanOverlay();
        return;
      }
      if (sessionActiveFromData(pd) && !steal) {
        console.warn('[SESSION] вход заблокирован активной сессией');
        startBlockedState(user);
        return;
      }
    } else {
      try {
        const trashSnap = await getDoc(doc(db, 'trash', user.uid));
        if (trashSnap.exists()) {
          console.warn('[TRASH] Вход заблокирован: аккаунт удалён');
          try { await signOut(auth); } catch (e) {}
          ui.showMessage('auth-error', '\u{1F5D1}\uFE0F Аккаунт удалён. Вход невозможен.');
          return;
        }
      } catch (e) {
        console.warn('[TRASH] Проверка корзины недоступна:', e && e.code ? e.code : e);
      }
    }
    stopBlockedState();
    if (!profileSnap || !profileSnap.exists()) await ensureProfileExists(user);
    let claimed = await claimSessionWithLogin(user.uid);
    if (!claimed) {
      await new Promise(r => setTimeout(r, 1200));
      claimed = await claimSessionWithLogin(user.uid);
    }
    if (!claimed) {
      try { await signOut(auth); } catch (e) {}
      ui.showMessage('auth-error', '\u26A0\uFE0F Не удалось занять сессию. Проверьте соединение и войдите снова.');
      return;
    }
    appEntered = true;
    pendingUser = null;
    currentUser = user;
    banKickActive = false;
    ui.hideBanOverlay();
    startBanWatch(user.uid);
    document.getElementById('user-display').textContent = user.displayName || 'Игрок';
    startSessionHeartbeat(user.uid);
    ui.startIdleMonitor();
    if (profileSnap && profileSnap.exists()) ui.renderMyStatsFromData(profileSnap.data());
    const savedActiveId = getSavedActiveGameId();
    const savedCreatedId = getSavedCreatedGameId();
    const batch = await Promise.all([
      savedActiveId ? getDoc(doc(db, 'games', savedActiveId)).catch(() => null) : Promise.resolve(null),
      savedCreatedId ? getDoc(doc(db, 'games', savedCreatedId)).catch(() => null) : Promise.resolve(null),
      loadRemoteConfig()
    ]);
    markConnectionOk(false);
    const restoredActive = restoreActiveFromSnap(savedActiveId, batch[0]);
    if (!restoredActive) {
      const createdResult = await restoreCreatedFromSnap(savedCreatedId, batch[1]);
      if (createdResult === 'none') await restorePersistentCreated();
      if (!currentGame) ui.showScreen('lobby-screen');
    }
  } finally {
    enterAppInFlight = false;
  }
}
function startBlockedState(user) {
  pendingUser = user;
  currentUser = null;
  ui.showScreen('auth-screen');
  ui.showMessage('auth-error', '\u26A0\uFE0F Аккаунт уже активен в другом окне или браузере.');
  if (blockCheckInterval) clearInterval(blockCheckInterval);
  blockCheckInterval = setInterval(async () => {
    if (!pendingUser) { stopBlockedState(); return; }
    try {
      const still = await checkSessionActive(pendingUser.uid);
      if (!still) {
        const u = pendingUser;
        stopBlockedState();
        enterApp(u);
      }
    } catch (e) {}
  }, BLOCKED_RETRY_INTERVAL);
}
export function stopBlockedState() {
  if (blockCheckInterval) { clearInterval(blockCheckInterval); blockCheckInterval = null; }
}

// ---------- бан ----------
function startBanWatch(uid) {
  stopBanWatch();
  banListener = onSnapshot(doc(db, 'users', uid), async (snap) => {
    if (!snap.exists()) return;
    if (snap.data().banned === true) {
      console.warn('[BAN] Живой кик: у профиля появилось banned=true');
      banKickActive = true;
      if (currentGame && currentGame.id && currentGame.status === STATUS_PLAYING) {
        try {
          await updateDoc(doc(db, 'games', currentGame.id), {
            status: STATUS_CANCELLED, endReason: 'account_banned', endedAt: Date.now()
          });
          upsertCatalogFromGame(currentGame.id, { ...currentGame, status: STATUS_CANCELLED, endReason: 'account_banned', endedAt: Date.now() });
        } catch (e) {
          console.warn('[BAN] Не удалось завершить игру при бане:', e);
        }
      }
      ui.showBanOverlay();
      stopBanWatch();
      signOut(auth).catch(() => {});
    }
  }, (err) => {
    console.warn('[BAN] Наблюдение за профилем недоступно:', err && err.code ? err.code : err);
  });
}
export function stopBanWatch() {
  if (banListener) { try { banListener(); } catch (e) {} banListener = null; }
}

// ---------- регистрация / вход / выход ----------
window.register = async function(btn) {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const consentBox = document.getElementById('consent-check');
  if (!consentBox || !consentBox.checked) {
    return ui.showMessage('auth-error', '\u26A0\uFE0F Для регистрации нужно согласие с политикой конфиденциальности.');
  }
  const nameErr = ui.validateUsername(username, NAME_MAX_REGISTER);
  if (nameErr) return ui.showMessage('auth-error', nameErr + NAME_RULE_HINT);
  const passErr = ui.validatePassword(password);
  if (passErr) return ui.showMessage('auth-error', passErr);
  ui.setBusy(btn, true);
  try {
    const email = `${username.toLowerCase()}${EMAIL_DOMAIN}`;
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: username });
    await setDoc(doc(db, 'users', cred.user.uid), {
      username: username, createdAt: Date.now(), lastLoginAt: Date.now(),
      activeSessionId: SESSION_ID, sessionLeaseUntil: Date.now() + SESSION_LEASE_MS, sessionLastActivity: Date.now(),
      wins: 0, losses: 0, noResult: 0, gamesAsX: 0, gamesAsO: 0
    });
    markConnectionOk(false);
    document.getElementById('user-display').textContent = username;
    ui.showMessage('auth-success', 'Регистрация успешна!');
  } catch (error) {
    markConnectionError();
    ui.showMessage('auth-error', error.code === 'auth/email-already-in-use' ? 'Это имя уже занято. Выберите другое.' : error.message);
  } finally {
    ui.setBusy(btn, false);
  }
};

window.login = async function() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const nameErr = ui.validateUsername(username, NAME_MAX_LOGIN);
  if (nameErr) return ui.showMessage('auth-error', nameErr);
  const passErr = ui.validatePassword(password);
  if (passErr) return ui.showMessage('auth-error', passErr);
  const btn = document.querySelector('#auth-form button[type="submit"]');
  ui.setBusy(btn, true);
  try {
    const email = `${username.toLowerCase()}${EMAIL_DOMAIN}`;
    await signInWithEmailAndPassword(auth, email, password);
    if (auth.currentUser) enterApp(auth.currentUser, true);
  } catch (error) {
    ui.showMessage('auth-error', 'Неверное имя или пароль');
  } finally {
    ui.setBusy(btn, false);
  }
};

const authForm = document.getElementById('auth-form');
if (authForm) {
  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    window.login();
  });
}

window.logout = async function(btn) {
  ui.setBusy(btn, true);
  try {
    if (myCreatedGameId) await window.closeMyGame();
    stopWaitingTimer();
    stopCreatorHeartbeat();
    ui.stopIdleMonitor();
    stopBanWatch();
    clearSavedActiveGameId();
    myActiveGameId = null;
    if (currentUser) { await releaseSession(currentUser.uid); stopSessionHeartbeat(); }
    appEntered = false;
    await signOut(auth);
  } finally {
    ui.setBusy(btn, false);
  }
};
onAuthStateChanged(auth, async (user) => {
  if (user) {
    enterApp(user);
  } else {
    appEntered = false;
    pendingUser = null;
    stopBlockedState();
    stopBanWatch();
    if (!banKickActive) ui.hideBanOverlay();
    currentUser = null;
    stopSessionHeartbeat();
    ui.stopIdleMonitor();
    ui.showScreen('auth-screen');
  }
});

// ---------- активные игры и комнаты ----------
export async function countMyActiveGames() {
  if (!currentUser) return 0;
  const activeStatuses = [STATUS_WAITING, STATUS_PLAYING, STATUS_PAUSED];
  try {
    const [s1, s2] = await Promise.all([
      getDocs(query(collection(db, 'games'), where('playerX', '==', currentUser.uid), where('status', 'in', activeStatuses))),
      getDocs(query(collection(db, 'games'), where('playerO', '==', currentUser.uid), where('status', 'in', activeStatuses)))
    ]);
    markConnectionOk(false);
    const ids = new Set();
    s1.forEach(d => { const g = d.data(); if (activeStatuses.includes(g.status)) ids.add(d.id); });
    s2.forEach(d => { const g = d.data(); if (activeStatuses.includes(g.status)) ids.add(d.id); });
    return ids.size;
  } catch (e) {
    markConnectionError();
    console.warn('countMyActiveGames: ошибка запроса:', e && e.code);
    return 0;
  }
}
async function createGameDocWithKey(baseWord, buildGameData) {
  const wordLower = baseWord.toLowerCase();
  const wordDisplay = baseWord;
  for (let n = 1; n <= ROOM_NUMBER_MAX; n++) {
    const key = `${wordLower}-${n}`;
    const ref = doc(db, 'games', key);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) throw new Error('ROOM_KEY_OCCUPIED');
        tx.set(ref, buildGameData(key, wordDisplay, n));
      });
      return key;
    } catch (e) {
      if (e && e.message === 'ROOM_KEY_OCCUPIED') continue;
      throw e;
    }
  }
  throw new Error('NO_FREE_ROOM_NUMBER');
}
window.createGame = async function() {
  if (ui.getCreateInProgress()) return;
  ui.setCreateInProgress(true);
  const btn = document.getElementById('create-game-btn');
  ui.setBusy(btn, true);
  try {
    const activeCount = await countMyActiveGames();
    if (activeCount >= MAX_ACTIVE_GAMES) {
      ui.showMessage('lobby-error', '\u26A0\uFE0F У вас 3 неочищенные игры. Закройте старые игры.');
      return;
    }
    const baseWord = ((currentUser.displayName || '').replace(/[^a-zA-Z0-9]/g, '') || 'player');
    const firstPlayerIsX = Math.random() < 0.5;
    const now = Date.now();
    let createdData = null;
    const key = await createGameDocWithKey(baseWord, (roomKey, wordDisplay, num) => {
      createdData = {
        roomName: `${wordDisplay}-${num}`, roomKey: roomKey, roomNumber: num,
        createdBy: currentUser.uid, createdByName: currentUser.displayName,
        playerX: firstPlayerIsX ? currentUser.uid : null,
        playerO: firstPlayerIsX ? null : currentUser.uid,
        playerXName: firstPlayerIsX ? currentUser.displayName : null,
        playerOName: firstPlayerIsX ? null : currentUser.displayName,
        currentTurn: 'X', moves: {},
        revealed: ui.generateInitialRevealed(),
        lastMove: null, status: STATUS_WAITING,
        gameStartTime: null, turnStartTime: null,
        winningCells: null, winTime: null, endedAt: null,
        pausedAt: null, turnRemainingFrozen: null, pausedTotalMs: 0,
        pauseRequestedBy: null, pauseRequestedByName: null,
        pauseResumeX: false, pauseResumeO: false, pauseCount: 0,
        nudgeBy: null, nudgeByName: null, nudgeCount: 0, nudgeAt: null, nudgePongAt: null,
        statsAppliedX: false, statsAppliedO: false, moveVersion: 0, createdAt: now
      };
      return createdData;
    });
    markConnectionOk(false);
    myCreatedGameId = key;
    myCreatedSlot = firstPlayerIsX ? 'X' : 'O';
    if (createdData) upsertCatalogFromGame(key, createdData);
    try {
      const actData = firstPlayerIsX
        ? { playerXLastActivity: now, playerOLastActivity: null }
        : { playerXLastActivity: null, playerOLastActivity: now };
      await setDoc(activityRef(key), actData);
    } catch (e) {
      console.warn('Не удалось создать документ активности:', e);
    }
    saveCreatedGameId(key);
    ui.updateCreateButton();
    listenToMyCreatedGame(key);
    startCreatorHeartbeat();
    startWaitingTimer(WAITING_TIMEOUT);
  } catch (error) {
    markConnectionError();
    ui.showMessage('lobby-error', 'Ошибка: ' + error.message);
  } finally {
    ui.setCreateInProgress(false);
    ui.setBusy(btn, false);
  }
};
window.closeMyGame = async function() {
  if (!myCreatedGameId) return;
  const btn = document.getElementById('create-game-btn');
  ui.setBusy(btn, true);
  const closedId = myCreatedGameId;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'games', closedId);
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      if (snap.data().status !== STATUS_WAITING) throw new Error('GAME_STARTED');
      tx.delete(ref);
    });
  } catch (e) {
    if (e && e.message === 'GAME_STARTED') return;
    console.warn('Не удалось закрыть игру:', e && e.code ? e.code : e);
    return;
  } finally {
    ui.setBusy(btn, false);
  }
  stopWaitingTimer();
  stopCreatorHeartbeat();
  updateCatalog(rooms => removeRoom(rooms, closedId));
  deleteDoc(activityRef(closedId)).catch(() => {});
  if (myCreatedGameListener) { myCreatedGameListener(); myCreatedGameListener = null; }
  myCreatedGameId = null;
  myCreatedSlot = null;
  clearSavedCreatedGameId();
  ui.updateCreateButton();
};
// Проблема 3: принудительное закрытие созданной комнаты при входе в чужую игру.
// Если комната в 'waiting' — удаляем. Если в 'playing' (соперник уже зашёл) —
// отменяем без результата с endReason 'creator_left'.
async function forceCloseMyCreatedGame() {
  if (!myCreatedGameId) return;
  const closedId = myCreatedGameId;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'games', closedId);
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const g = snap.data();
      if (g.status === STATUS_WAITING) {
        tx.delete(ref);
      } else if (g.status === STATUS_PLAYING || g.status === STATUS_PAUSED) {
        tx.update(ref, {
          status: STATUS_CANCELLED,
          endReason: 'creator_left',
          endedAt: Date.now()
        });
      }
    });
  } catch (e) {
    console.warn('Принудительное закрытие комнаты не выполнено:', e && e.code ? e.code : e);
    return;
  }
  stopWaitingTimer();
  stopCreatorHeartbeat();
  updateCatalog(rooms => removeRoom(rooms, closedId));
  deleteDoc(activityRef(closedId)).catch(() => {});
  if (myCreatedGameListener) { myCreatedGameListener(); myCreatedGameListener = null; }
  myCreatedGameId = null;
  myCreatedSlot = null;
  clearSavedCreatedGameId();
  ui.updateCreateButton();
}
function startCreatorHeartbeat() {
  stopCreatorHeartbeat();
  creatorHeartbeatInterval = setInterval(async () => {
    if (!myCreatedGameId || !currentUser || !myCreatedSlot) return;
    try {
      const field = myCreatedSlot === 'X' ? 'playerXLastActivity' : 'playerOLastActivity';
      await setDoc(activityRef(myCreatedGameId), { [field]: Date.now() }, { merge: true });
      markConnectionOk(true);
    } catch (e) { markConnectionError(); }
  }, CREATOR_HEARTBEAT_INTERVAL);
}
export function stopCreatorHeartbeat() {
  if (creatorHeartbeatInterval) { clearInterval(creatorHeartbeatInterval); creatorHeartbeatInterval = null; }
}
function listenToMyCreatedGame(gameId) {
  if (myCreatedGameListener) myCreatedGameListener();
  myCreatedGameListener = onSnapshot(doc(db, 'games', gameId), (docSnap) => {
    markConnectionOk(true);
    if (!docSnap.exists()) {
      myCreatedGameId = null; myCreatedSlot = null;
      clearSavedCreatedGameId(); stopWaitingTimer(); stopCreatorHeartbeat();
      if (myCreatedGameListener) { myCreatedGameListener(); myCreatedGameListener = null; }
      ui.updateCreateButton();
      return;
    }
    const game = docSnap.data();
    if (game.status === STATUS_COMPLETED || game.status === STATUS_CANCELLED) {
      myCreatedGameId = null; myCreatedSlot = null;
      clearSavedCreatedGameId(); stopWaitingTimer(); stopCreatorHeartbeat();
      if (myCreatedGameListener) { myCreatedGameListener(); myCreatedGameListener = null; }
      ui.updateCreateButton();
      return;
    }
    if (game.status === STATUS_PLAYING) {
      stopWaitingTimer(); stopCreatorHeartbeat();
      myCreatedGameId = null; myCreatedSlot = null;
      clearSavedCreatedGameId();
      if (myCreatedGameListener) { myCreatedGameListener(); myCreatedGameListener = null; }
      ui.updateCreateButton();
      currentGame = { id: gameId, ...game };
      myActiveGameId = gameId;
      if (bot.isBotMode()) {
        const opponentName = (currentUser.uid === game.playerX) ? game.playerOName : game.playerXName || 'Соперник';
        ui.showOpponentJoinedTransition(opponentName, () => {
          bot.stopBotGame();
          startGame(true);
        });
      } else {
        ui.notifyOpponentJoined((currentUser.uid === game.playerX) ? game.playerOName : game.playerXName || 'Соперник');
        startGame(true);
      }
    }
  }, (err) => { markConnectionError(); });
}

// ---------- ожидание и восстановление ----------
export function startWaitingTimer(ms) {
  stopWaitingTimer();
  waitingStartTime = Date.now();
  const statusEl = document.getElementById('lobby-status');
  const timerEl = document.getElementById('lobby-timer');
  if (statusEl) statusEl.textContent = LOBBY_WAITING;
  if (timerEl) timerEl.style.display = 'block';
  waitingTimerInterval = setInterval(() => {
    const elapsed = Date.now() - waitingStartTime;
    const remaining = ms - elapsed;
    if (remaining <= 0) { autoCloseMyGame(); return; }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    if (timerEl) timerEl.textContent = `\u23F3 Ожидание соперника: ${mins}:${String(secs).padStart(2, '0')}`;
  }, WAITING_CHECK_INTERVAL);
}
export function stopWaitingTimer() {
  if (waitingTimerInterval) { clearInterval(waitingTimerInterval); waitingTimerInterval = null; }
  waitingStartTime = null;
  const statusEl = document.getElementById('lobby-status');
  const timerEl = document.getElementById('lobby-timer');
  if (statusEl) statusEl.textContent = LOBBY_MAIN;
  if (timerEl) timerEl.style.display = 'none';
}
async function autoCloseMyGame() {
  if (!myCreatedGameId) return;
  stopWaitingTimer();
  stopCreatorHeartbeat();
  const closedId = myCreatedGameId;
  let deleted = false;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'games', closedId);
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const g = snap.data();
      if (g.status !== STATUS_WAITING) return;
      tx.delete(ref);
      deleted = true;
    });
  } catch (e) {
    console.warn('Автозакрытие комнаты не выполнено:', e && e.message ? e.message : e);
  }
  if (deleted) {
    updateCatalog(rooms => removeRoom(rooms, closedId));
    deleteDoc(activityRef(closedId)).catch(() => {});
  }
  if (myCreatedGameListener) { myCreatedGameListener(); myCreatedGameListener = null; }
  myCreatedGameId = null; myCreatedSlot = null;
  clearSavedCreatedGameId();
  ui.updateCreateButton();
  if (deleted) ui.showMessage('lobby-error', '\u23F0 Время ожидания истекло. Игра удалена.');
}
function restoreActiveFromSnap(savedGameId, gameSnap) {
  if (!gameSnap || !gameSnap.exists()) {
    if (savedGameId) clearSavedActiveGameId();
    return false;
  }
  const game = gameSnap.data();
  const isMyGame = game.playerX === currentUser.uid || game.playerO === currentUser.uid;
  if (!isMyGame) { clearSavedActiveGameId(); return false; }
  if (game.status === STATUS_PLAYING || game.status === STATUS_PAUSED) {
    currentGame = { id: savedGameId, ...game };
    myActiveGameId = savedGameId;
    startGame(false);
    return true;
  }
  clearSavedActiveGameId();
  return false;
}
async function restoreCreatedFromSnap(sessionGameId, gameSnap) {
  if (!gameSnap || !gameSnap.exists()) {
    if (sessionGameId) clearSavedCreatedGameId();
    return 'none';
  }
  const game = gameSnap.data();
  const isMyGame = game.playerX === currentUser.uid || game.playerO === currentUser.uid;
  if (!isMyGame) { clearSavedCreatedGameId(); return 'none'; }
  if (game.status === STATUS_PLAYING) {
    ui.notifyOpponentJoined((currentUser.uid === game.playerX) ? game.playerOName : game.playerXName || 'Соперник');
    currentGame = { id: sessionGameId, ...game };
    myActiveGameId = sessionGameId;
    clearSavedCreatedGameId();
    myCreatedGameId = null;
    stopWaitingTimer();
    startGame(false);
    return 'started';
  }
  if (game.status === STATUS_WAITING) {
    const age = game.createdAt ? (Date.now() - game.createdAt) : 0;
    if (age > WAITING_TIMEOUT) {
      await deleteDoc(doc(db, 'games', sessionGameId)).catch(() => {});
      clearSavedCreatedGameId();
      return 'none';
    }
    myCreatedGameId = sessionGameId;
    myCreatedSlot = (game.playerX === currentUser.uid) ? 'X' : 'O';
    ui.updateCreateButton();
    listenToMyCreatedGame(sessionGameId);
    startCreatorHeartbeat();
    startWaitingTimer(WAITING_TIMEOUT - age);
    return 'waiting';
  }
  clearSavedCreatedGameId();
  return 'none';
}
async function restorePersistentCreated() {
  const persistentGameId = getPersistentCreatedGameId();
  if (!persistentGameId) return false;
  try {
    const gameSnap = await getDoc(doc(db, 'games', persistentGameId));
    markConnectionOk(false);
    if (!gameSnap.exists()) { clearSavedCreatedGameId(); return false; }
    const game = gameSnap.data();
    const isMyGame = game.playerX === currentUser.uid || game.playerO === currentUser.uid;
    if (!isMyGame) { clearSavedCreatedGameId(); return false; }
    if (game.status === STATUS_PLAYING || game.status === STATUS_PAUSED) {
      currentGame = { id: persistentGameId, ...game };
      myActiveGameId = persistentGameId;
      clearSavedCreatedGameId();
      myCreatedGameId = null;
      stopWaitingTimer();
      startGame(false);
      return true;
    }
    if (game.status === STATUS_WAITING) {
      await deleteDoc(doc(db, 'games', persistentGameId)).catch(() => {});
      clearSavedCreatedGameId();
      return false;
    }
    clearSavedCreatedGameId();
    return false;
  } catch (e) {
    markConnectionError();
    clearSavedCreatedGameId();
    return false;
  }
}

// ---------- лобби: подписка каталога ----------
export function listenToAvailableGames() {
  if (gamesListener) gamesListener();
  gamesListener = onSnapshot(catalogRef(), (snap) => {
    markConnectionOk(true);
    if (!snap.exists()) {
      lastLobbySnapshot = [];
      ui.setLobbyListDirty(true);
      const listEl = document.getElementById('games-list');
      if (listEl) listEl.innerHTML = '<div class="lobby-empty">Загрузка...</div>';
      rebuildCatalog();
      return;
    }
    const data = snap.data();
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    lastLobbySnapshot = rooms.map(r => ({ id: r.id, game: r }));
    ui.setLobbyListDirty(true);
    ui.processLobbyList(true);
  }, (err) => {
    markConnectionError();
    if (err && err.code === 'permission-denied') ui.showMessage('lobby-error', '\u26A0\uFE0F Нет доступа к каталогу лобби.');
  });
}
export function pauseLobbySubscriptions() {
  if (gamesListener) { gamesListener(); gamesListener = null; }
  stopLobbyCleanup();
  stopLobbyCountdowns();
  stopOrphanCheck();
}
export function stopLobbyCleanup() { ui.stopLobbyCleanup(); }
export function stopLobbyCountdowns() { ui.stopLobbyCountdowns(); }

// ---------- вход в игру / подключение ----------
window.enterMyGame = async function(gameId, btn) {
  ui.setBusy(btn, true);
  try {
    const snap = await getDoc(doc(db, 'games', gameId));
    markConnectionOk(false);
    if (!snap.exists()) {
      updateCatalog(rooms => removeRoom(rooms, gameId));
      ui.showMessage('lobby-error', 'Игра не найдена и удалена из списка');
      return;
    }
    const game = snap.data();
    if (game.status !== STATUS_PLAYING && game.status !== STATUS_PAUSED) {
      upsertCatalogFromGame(gameId, game);
      ui.showMessage('lobby-error', 'Игра недоступна');
      return;
    }
    currentGame = { id: gameId, ...game };
    myActiveGameId = gameId;
    startGame(false);
  } catch (error) {
    markConnectionError();
    ui.showMessage('lobby-error', 'Ошибка: ' + error.message);
  } finally {
    ui.setBusy(btn, false);
  }
};
window.joinGame = async function(gameId, btn) {
  ui.setBusy(btn, true);
  try {
    // Проблема 3: принудительно закрываем созданную комнату при входе в чужую игру
    if (myCreatedGameId) await forceCloseMyCreatedGame();
    const activeCount = await countMyActiveGames();
    if (activeCount >= MAX_ACTIVE_GAMES) {
      ui.showMessage('lobby-error', '\u26A0\uFE0F У вас 3 неочищенные игры.');
      return;
    }
    let joinResult = null;
    try {
      joinResult = await runTransaction(db, async (tx) => {
        const snap = await tx.get(doc(db, 'games', gameId));
        if (!snap.exists()) throw new Error('GAME_NOT_FOUND');
        const g = snap.data();
        if (g.status !== STATUS_WAITING) throw new Error('ALREADY_STARTED');
        let slot;
        if (!g.playerX) slot = 'playerX';
        else if (!g.playerO) slot = 'playerO';
        else throw new Error('GAME_FULL');
        const now = Date.now();
        const updateData = {
          status: STATUS_PLAYING,
          [slot]: currentUser.uid,
          [slot + 'Name']: currentUser.displayName,
          gameStartTime: now, turnStartTime: now
        };
        tx.update(doc(db, 'games', gameId), updateData);
        return { updateData, merged: { ...g, ...updateData } };
      });
    } catch (txErr) {
      if (txErr.message === 'ALREADY_STARTED') { ui.showMessage('lobby-error', 'Игра уже началась'); return; }
      if (txErr.message === 'GAME_FULL') { ui.showMessage('lobby-error', 'В игре уже два игрока'); return; }
      if (txErr.message === 'GAME_NOT_FOUND') {
        updateCatalog(rooms => removeRoom(rooms, gameId));
        ui.showMessage('lobby-error', 'Игра не найдена и удалена из списка');
        return;
      }
      throw txErr;
    }
    markConnectionOk(false);
    upsertCatalogFromGame(gameId, joinResult.merged);
    try {
      const slot = joinResult.updateData.playerX ? 'playerXLastActivity' : 'playerOLastActivity';
      await setDoc(activityRef(gameId), { [slot]: Date.now() }, { merge: true });
    } catch (e) {
      console.warn('Не удалось обновить документ активности при входе:', e);
    }
    currentGame = { id: gameId, ...joinResult.merged };
    myActiveGameId = gameId;
    startGame(true);
  } catch (error) {
    markConnectionError();
    ui.showMessage('lobby-error', 'Ошибка: ' + error.message);
  } finally {
    ui.setBusy(btn, false);
  }
};

// ---------- поток партии ----------
export function startGame(withLottery) {
  if (bot.isBotMode()) {
    ui.showScreen('game-screen');
    initBotGame();
    return;
  }
  gameEndHandled = false;
  stopCreatorHeartbeat();
  if (currentGame && currentGame.id) {
    saveActiveGameId(currentGame.id);
    myActiveGameId = currentGame.id;
  }
  ui.showScreen('game-screen');
  initGame(withLottery);
  listenToGame(currentGame.id);
  listenToActivity(currentGame.id);
}
function initGame(withLottery) {
  const el = document.getElementById('gameCanvas');
  core.bindCanvas(el);
  core.attachCanvasListeners(el);
  core.resizeCanvas(ui.isFullscreen());
  lastKnownMoveCount = Object.keys(currentGame.moves || {}).length;
  core.syncFromServer(currentGame);
  if (document.getElementById('dbg-reveal').checked) core.addDebugRevealCells();
  core.setMySymbol(currentUser.uid === currentGame.playerX ? 'X' : 'O');
  core.setGameStatus(currentGame.status);
  undoInfo = null;
  undoUsedThisCycle = false;
  clearNudgeProbe();
  nudgeCooldownUntil = 0;
  lastNudgeSeenAt = currentGame.nudgeAt || 0;
  lastPongedAt = 0;
  optimisticMove = null;
  moveInFlightPromise = null;
  ui.resetGameDom();
  updateRoomHeader();
  if (withLottery) {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    core.beginLottery(core.getMySymbol(), reduced);
  } else {
    core.dropLottery();
  }
  core.resetCamera();
  ui.loadGameHeaderStats();
  core.startRenderLoop();
  ui.startTimerUpdate();
  startActivityUpdate();
  ui.startOpponentCheck();
  ui.updateGameUI();
  ui.updatePauseUI();
  ui.updateNudgeButton();
  core.refreshCanvasCursor();
}
function initBotGame() {
  const el = document.getElementById('gameCanvas');
  core.bindCanvas(el);
  core.attachCanvasListeners(el);
  core.resizeCanvas(ui.isFullscreen());
  core.setMySymbol(bot.getPlayerSymbol());
  core.setGameStatus(STATUS_PLAYING);
  core.resetCamera();
  ui.resetGameDom();
  ui.hideOnlineElementsInBotMode();
  ui.showBotThinking(false);
  core.startRenderLoop();
  ui.startTimerUpdate();
  ui.updateGameUI();
  ui.beginUndoCountdown();
}
function updateRoomHeader() {
  const roomNameEl = document.getElementById('room-name-text');
  if (!roomNameEl) return;
  roomNameEl.textContent = (currentGame && currentGame.roomName) || 'Неизвестная комната';
}
function listenToActivity(gameId) {
  if (activityListener) activityListener();
  activityListener = onSnapshot(activityRef(gameId), (docSnap) => {
    if (!docSnap.exists()) return;
    const act = docSnap.data();
    const gs = core.gameState;
    if (act.playerXLastActivity && (!gs.playerXLastActivity || act.playerXLastActivity > gs.playerXLastActivity)) gs.playerXLastActivity = act.playerXLastActivity;
    if (act.playerOLastActivity && (!gs.playerOLastActivity || act.playerOLastActivity > gs.playerOLastActivity)) gs.playerOLastActivity = act.playerOLastActivity;
  }, (err) => {
    console.warn('Ошибка подписки на активность:', err);
  });
}
function listenToGame(gameId) {
  if (gameListener) gameListener();
  gameListener = onSnapshot(doc(db, 'games', gameId), async (docSnap) => {
    markConnectionOk(true);
    if (!docSnap.exists()) {
      gameEndHandled = false;
      ui.showResultModal('\u26A0\uFE0F Игра была удалена.');
      if (gameListener) { gameListener(); gameListener = null; }
      return;
    }
    const game = docSnap.data();
    currentGame = { id: gameId, ...game };
    core.setGameStatus(game.status);
    if (game.status === STATUS_PLAYING && !core.getCanvasEl()) startGame(false);
    if (game.status !== STATUS_PLAYING && undoInfo) expireUndoWindow();
    if (game.status !== STATUS_PLAYING && core.isLotteryActive()) {
      core.cancelLotteryPlain(currentUser.uid === game.playerX ? 'X' : 'O');
    }
    if (game.nudgeAt && game.nudgeAt !== lastNudgeSeenAt) {
      lastNudgeSeenAt = game.nudgeAt;
      if (game.nudgeBy && game.nudgeBy !== currentUser.uid) {
        ui.showTopNotification(ui.nudgeTextFor(game.nudgeCount || 0, game.nudgeByName || 'соперник'), true);
        ui.playBellSound();
        if (game.nudgeAt !== lastPongedAt) {
          lastPongedAt = game.nudgeAt;
          updateDoc(doc(db, 'games', gameId), { nudgePongAt: Date.now() }).catch(() => {});
        }
      }
    }
    if (nudgeProbe && game.nudgePongAt && game.nudgePongAt >= nudgeProbe.at) clearNudgeProbe();
    if (game.status === STATUS_PAUSED) {
      const myS = currentUser.uid === game.playerX ? 'X' : 'O';
      const oppFlag = myS === 'X' ? !!game.pauseResumeO : !!game.pauseResumeX;
      if (oppFlag && !ui.getLastOppResumeFlag()) ui.playBellSound();
      ui.setLastOppResumeFlag(oppFlag);
    } else {
      ui.setLastOppResumeFlag(false);
    }
    if (game.status === STATUS_PAUSED && game.pauseResumeX && game.pauseResumeO) doResumeGame(Date.now());
    if (game.status === STATUS_PLAYING || game.status === STATUS_PAUSED || game.status === STATUS_COMPLETED) {
      core.syncFromServer(game);
      if (document.getElementById('dbg-reveal').checked) core.addDebugRevealCells();
      if (optimisticMove && !core.gameState.moves[optimisticMove.cellKey]) {
        core.applyOptimisticSync(optimisticMove.cellKey, optimisticMove.mySymbol, optimisticMove.revealedAdded);
      }
      const currentMoveCount = Object.keys(core.gameState.moves).length;
      if (currentMoveCount > lastKnownMoveCount && game.lastMove) {
        const mySymbol = currentUser.uid === game.playerX ? 'X' : 'O';
        if (core.gameState.moves[game.lastMove] !== mySymbol) {
          const [mx, my] = game.lastMove.split(',').map(Number);
          // v2.0.7: centerOnCell вместо smoothCenterOn — на ПК прицел
          // перемещается на клетку хода соперника (как на телефоне)
          core.centerOnCell(mx, my);
          core.highlightMove(game.lastMove);
          undoUsedThisCycle = false;
        }
      }
      lastKnownMoveCount = currentMoveCount;
      if (undoInfo && currentMoveCount !== undoInfo.countAfter) expireUndoWindow();
      ui.updateGameUI();
      ui.updatePauseUI();
    }
    if (game.status === STATUS_COMPLETED && game.winner && !gameEndHandled) {
      upsertCatalogFromGame(gameId, game);
      await applyMyStatsForGame(gameId, cardFromGame(gameId, game));
      await ui.loadMyStats();
      await ui.loadGameHeaderStats();
      endGame(game.winner, game.endReason);
    } else if (game.status === STATUS_CANCELLED && !gameEndHandled) {
      upsertCatalogFromGame(gameId, game);
      await applyMyStatsForGame(gameId, cardFromGame(gameId, game));
      await ui.loadMyStats();
      await ui.loadGameHeaderStats();
      endGame(null, game.endReason);
    }
  }, (err) => { markConnectionError(); });
}

// ---------- статистика ----------
export async function applyMyStatsForGame(gameId, card) {
  if (!currentUser) return false;
  if (card.status !== STATUS_COMPLETED && card.status !== STATUS_CANCELLED) return false;
  const isX = card.playerX === currentUser.uid;
  const isO = card.playerO === currentUser.uid;
  if (!isX && !isO) return false;
  const flag = isX ? 'statsAppliedX' : 'statsAppliedO';
  if (card[flag]) return false;
  try {
    const result = await runTransaction(db, async (tx) => {
      const gameSnap = await tx.get(doc(db, 'games', gameId));
      if (!gameSnap.exists()) return { applied: false, reason: 'GAME_NOT_FOUND' };
      const g = gameSnap.data();
      if (g[flag]) return { applied: false, reason: 'ALREADY_APPLIED' };
      if (g.status !== STATUS_COMPLETED && g.status !== STATUS_CANCELLED) return { applied: false, reason: 'NOT_FINISHED' };
      let field;
      if (g.status === STATUS_COMPLETED && g.winner) {
        const iWon = (g.winner === 'X' && isX) || (g.winner === 'O' && isO);
        field = iWon ? 'wins' : 'losses';
      } else {
        field = 'noResult';
      }
      const userUpdates = { [field]: increment(1) };
      if (isX) userUpdates.gamesAsX = increment(1);
      else userUpdates.gamesAsO = increment(1);
      tx.update(doc(db, 'users', currentUser.uid), userUpdates);
      tx.update(doc(db, 'games', gameId), { [flag]: true });
      return { applied: true, field };
    });
    return result.applied;
  } catch (e) {
    console.warn('Начисление статистики не выполнено:', e && e.message ? e.message : e);
    return false;
  }
}

// ---------- ход и отмена ----------
core.setMoveRequestHook((x, y) => tryMakeMove(x, y));
function startUndoWindow(cellKey, prevRevealed, prevLastMove, countAfter, version) {
  expireUndoWindow();
  if (undoUsedThisCycle) return;
  undoInfo = { cellKey, prevRevealed, prevLastMove, countAfter, version, deadline: Date.now() + UNDO_WINDOW_MS };
  undoHideTimer = setTimeout(() => expireUndoWindow(), UNDO_WINDOW_MS);
  ui.beginUndoCountdown();
}
function expireUndoWindow() {
  if (undoHideTimer) { clearTimeout(undoHideTimer); undoHideTimer = null; }
  undoInfo = null;
  ui.endUndoCountdown();
}
export async function tryMakeMove(cellX, cellY) {
  if (bot.isBotMode()) {
    bot.onPlayerMove(cellX, cellY);
    return;
  }
  if (!currentGame || currentGame.status !== STATUS_PLAYING) return;
  const gs = core.gameState;
  const mySymbol = currentUser.uid === gs.playerX ? 'X' : 'O';
  if (gs.currentTurn !== mySymbol) return;
  const cellKey = `${cellX},${cellY}`;
  if (!gs.revealed.has(cellKey) || gs.moves[cellKey]) return;
  const revealedAdded = [];
  for (let dx = -5; dx <= 5; dx++) {
    for (let dy = -5; dy <= 5; dy++) {
      if (Math.sqrt(dx * dx + dy * dy) <= 5) {
        const nk = `${cellX + dx},${cellY + dy}`;
        if (!gs.revealed.has(nk)) revealedAdded.push(nk);
      }
    }
  }
  const previewMoves = { ...gs.moves, [cellKey]: mySymbol };
  const localWin = core.checkWinnerInMap(previewMoves, cellX, cellY, mySymbol);
  const snapH = core.snapshotHighlight();
  const prev = {
    currentTurn: gs.currentTurn, turnStartTime: gs.turnStartTime, lastMove: gs.lastMove,
    lastKnownMoveCount: lastKnownMoveCount,
    lastHighlightedMove: snapH.lastHighlightedMove, highlightStartTime: snapH.highlightStartTime,
    winningCells: gs.winningCells, winTime: gs.winTime
  };
  const preRevealed = Array.from(gs.revealed);
  const preLastMove = gs.lastMove;
  const preMoveCount = Object.keys(gs.moves).length;
  core.applyMoveLocally(cellKey, mySymbol, revealedAdded, localWin);
  optimisticMove = { cellKey, mySymbol, revealedAdded };
  startUndoWindow(cellKey, preRevealed, preLastMove, preMoveCount + 1, (currentGame.moveVersion || 0) + 1);
  ui.updateGameUI();
  let result = null;
  moveInFlightPromise = runTransaction(db, async (tx) => {
    const snap = await tx.get(doc(db, 'games', currentGame.id));
    if (!snap.exists()) throw new Error('GAME_NOT_FOUND');
    const g = snap.data();
    if (g.status !== STATUS_PLAYING) throw new Error('NOT_PLAYING');
    if (g.currentTurn !== mySymbol) throw new Error('NOT_YOUR_TURN');
    if (g.moves && g.moves[cellKey]) throw new Error('CELL_TAKEN');
    const prevRevealed = Array.from(g.revealed || []);
    const moves = { ...(g.moves || {}) };
    moves[cellKey] = mySymbol;
    const revealedSet = new Set(prevRevealed);
    for (let dx = -5; dx <= 5; dx++) {
      for (let dy = -5; dy <= 5; dy++) {
        if (Math.sqrt(dx * dx + dy * dy) <= 5) revealedSet.add(`${cellX + dx},${cellY + dy}`);
      }
    }
    const winningCells = core.checkWinnerInMap(moves, cellX, cellY, mySymbol);
    const now = Date.now();
    const update = {
      moves: moves, revealed: Array.from(revealedSet),
      currentTurn: OTHER[mySymbol], lastMove: cellKey, turnStartTime: now,
      moveVersion: (g.moveVersion || 0) + 1
    };
    if (winningCells) {
      update.winner = mySymbol; update.winningCells = winningCells; update.winTime = now;
      update.status = STATUS_COMPLETED; update.endedAt = now; update.endReason = 'win';
    }
    tx.update(doc(db, 'games', currentGame.id), update);
    return {
      winningCells: winningCells, prevRevealed: prevRevealed, prevLastMove: g.lastMove || null,
      version: (g.moveVersion || 0) + 1, moveCount: Object.keys(moves).length,
      endedAt: winningCells ? now : null
    };
  });
  try {
    result = await moveInFlightPromise;
  } catch (e) {
    console.warn('Ход отклонён сервером, откат:', e && e.message ? e.message : e);
    core.rollbackMoveLocally(cellKey, revealedAdded, prev);
    core.restoreHighlight(prev);
    lastKnownMoveCount = prev.lastKnownMoveCount;
    optimisticMove = null;
    expireUndoWindow();
    ui.updateGameUI();
    return;
  } finally {
    moveInFlightPromise = null;
  }
  optimisticMove = null;
  if (result.winningCells) {
    core.gameState.winningCells = result.winningCells;
    if (!core.gameState.winTime) core.gameState.winTime = Date.now();
    expireUndoWindow();
    upsertCatalogFromGame(currentGame.id, { ...currentGame, status: STATUS_COMPLETED, winner: mySymbol, endReason: 'win', endedAt: result.endedAt });
  } else {
    if (undoInfo && undoInfo.cellKey === cellKey) {
      undoInfo.prevRevealed = result.prevRevealed;
      undoInfo.prevLastMove = result.prevLastMove;
      undoInfo.countAfter = result.moveCount;
      undoInfo.version = result.version;
    }
  }
}
window.undoMove = async function(btn) {
  if (bot.isBotMode()) {
    if (bot.undoBotMove()) {
      ui.beginUndoCountdown();
    }
    return;
  }
  if (!undoInfo || !currentGame || currentGame.status !== STATUS_PLAYING) return;
  if (moveInFlightPromise) { try { await moveInFlightPromise; } catch (e) {} }
  if (!undoInfo || !currentGame || currentGame.status !== STATUS_PLAYING) return;
  ui.setBusy(btn, true);
  const myS = currentUser.uid === core.gameState.playerX ? 'X' : 'O';
  const info = undoInfo;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'games', currentGame.id));
      if (!snap.exists()) throw new Error('GAME_NOT_FOUND');
      const g = snap.data();
      if (g.status !== STATUS_PLAYING) throw new Error('NOT_PLAYING');
      if ((g.moveVersion || 0) !== info.version) throw new Error('VERSION_MISMATCH');
      if (!g.moves || !g.moves[info.cellKey]) throw new Error('MOVE_NOT_FOUND');
      const moves = { ...g.moves };
      delete moves[info.cellKey];
      tx.update(doc(db, 'games', currentGame.id), {
        moves: moves, revealed: info.prevRevealed, currentTurn: myS,
        lastMove: info.prevLastMove, moveVersion: (g.moveVersion || 0) + 1, turnStartTime: Date.now()
      });
    });
  } catch (e) {
    console.warn('Отмена хода отклонена:', e && e.message ? e.message : e);
    expireUndoWindow();
    return;
  } finally {
    ui.setBusy(btn, false);
  }
  expireUndoWindow();
  undoUsedThisCycle = true;
  delete core.gameState.moves[info.cellKey];
  core.setRevealedBase(info.prevRevealed);
  core.gameState.currentTurn = myS;
  core.gameState.lastMove = info.prevLastMove;
  lastKnownMoveCount = Object.keys(core.gameState.moves).length;
  core.highlightMove(info.prevLastMove || '');
};

// ---------- активность ----------
async function updateMyActivity() {
  if (!currentGame || !currentGame.id || !currentUser) return;
  if (currentGame.status === STATUS_PAUSED) return;
  const myS = currentUser.uid === core.gameState.playerX ? 'X' : 'O';
  try {
    await setDoc(activityRef(currentGame.id), {
      [myS === 'X' ? 'playerXLastActivity' : 'playerOLastActivity']: Date.now()
    }, { merge: true });
    markConnectionOk(true);
  } catch (e) { markConnectionError(); }
}
function startActivityUpdate() {
  if (activityInterval) clearInterval(activityInterval);
  updateMyActivity();
  activityInterval = setInterval(updateMyActivity, ACTIVITY_UPDATE_INTERVAL);
}
export function stopActivityUpdate() {
  if (activityInterval) { clearInterval(activityInterval); activityInterval = null; }
}

// ---------- пинки ----------
function clearNudgeProbe() {
  if (nudgeProbeTimer) { clearTimeout(nudgeProbeTimer); nudgeProbeTimer = null; }
  nudgeProbe = null;
}
export function forceReconnectMode() {
  ui.setForcedDisconnect(true);
  ui.checkOpponentStatus();
}
window.nudgeOpponent = async function(btn) {
  if (!currentGame || currentGame.status !== STATUS_PLAYING) return;
  const myS = currentUser.uid === core.gameState.playerX ? 'X' : 'O';
  if (core.gameState.currentTurn === myS) return;
  const now = Date.now();
  if (now < nudgeCooldownUntil) return;
  nudgeCooldownUntil = now + NUDGE_COOLDOWN_MS;
  ui.setBusy(btn, true);
  const count = (currentGame.nudgeCount || 0) + 1;
  try {
    await updateDoc(doc(db, 'games', currentGame.id), {
      nudgeBy: currentUser.uid, nudgeByName: currentUser.displayName,
      nudgeCount: count, nudgeAt: now, nudgePongAt: null
    });
  } catch (e) {
    console.warn('Пинок не отправлен:', e);
    return;
  } finally {
    ui.setBusy(btn, false);
  }
  const oppAct = myS === 'X' ? core.gameState.playerOLastActivity : core.gameState.playerXLastActivity;
  const stale = !oppAct || (now - oppAct) > NUDGE_STALE_NOW_MS;
  if (stale) { forceReconnectMode(); return; }
  clearNudgeProbe();
  nudgeProbe = { at: now };
  nudgeProbeTimer = setTimeout(() => {
    if (!nudgeProbe) return;
    const pong = currentGame && currentGame.nudgePongAt;
    if (!pong || pong < nudgeProbe.at) { clearNudgeProbe(); forceReconnectMode(); }
    else clearNudgeProbe();
  }, NUDGE_PONG_TIMEOUT);
};

// ---------- паузы ----------
window.requestPause = async function(btn) {
  if (!currentGame || !currentGame.id) return;
  ui.setBusy(btn, true);
  try {
    if (currentGame.status === STATUS_PLAYING) {
      try {
        await updateDoc(doc(db, 'games', currentGame.id), {
          pauseRequestedBy: currentUser.uid, pauseRequestedByName: currentUser.displayName
        });
      } catch (e) { console.warn('Не удалось запросить паузу:', e); }
      return;
    }
    if (currentGame.status === STATUS_PAUSED) {
      const myS = currentUser.uid === currentGame.playerX ? 'X' : 'O';
      const myFlag = myS === 'X' ? currentGame.pauseResumeX : currentGame.pauseResumeO;
      if (!myFlag) return;
      try {
        await updateDoc(doc(db, 'games', currentGame.id), { [myS === 'X' ? 'pauseResumeX' : 'pauseResumeO']: false });
      } catch (e) { console.warn('Не удалось вернуть готовность паузы:', e); }
    }
  } finally {
    ui.setBusy(btn, false);
  }
};
window.cancelPauseRequest = async function(btn) {
  if (!currentGame || !currentGame.id) return;
  ui.setBusy(btn, true);
  try {
    await updateDoc(doc(db, 'games', currentGame.id), { pauseRequestedBy: null, pauseRequestedByName: null });
  } catch (e) { console.warn('Не удалось отменить запрос паузы:', e); }
  finally { ui.setBusy(btn, false); }
};
window.acceptPause = async function(btn) {
  if (!currentGame || !currentGame.id || currentGame.status !== STATUS_PLAYING) return;
  ui.setBusy(btn, true);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'games', currentGame.id));
      if (!snap.exists()) throw new Error('GAME_NOT_FOUND');
      const g = snap.data();
      if (g.status !== STATUS_PLAYING) throw new Error('NOT_PLAYING');
      const now = Date.now();
      const remaining = Math.max(0, TURN_AUTO_END_TIME - (now - (g.turnStartTime || now)));
      tx.update(doc(db, 'games', currentGame.id), {
        status: STATUS_PAUSED, pausedAt: now, turnRemainingFrozen: remaining,
        pauseRequestedBy: null, pauseRequestedByName: null,
        pauseResumeX: false, pauseResumeO: false, pauseCount: (g.pauseCount || 0) + 1
      });
    });
    upsertCatalogFromGame(currentGame.id, { ...currentGame, status: STATUS_PAUSED, pausedAt: Date.now() });
  } catch (e) {
    console.warn('Пауза не принята:', e && e.message ? e.message : e);
  } finally {
    ui.setBusy(btn, false);
  }
};
window.declinePause = async function(btn) {
  if (!currentGame || !currentGame.id) return;
  ui.setBusy(btn, true);
  try {
    await updateDoc(doc(db, 'games', currentGame.id), { pauseRequestedBy: null, pauseRequestedByName: null });
  } catch (e) { console.warn('Не удалось отклонить паузу:', e); }
  finally { ui.setBusy(btn, false); }
};
window.pressResume = async function(btn) {
  if (!currentGame || !currentGame.id || currentGame.status !== STATUS_PAUSED) return;
  ui.setBusy(btn, true);
  const myS = currentUser.uid === currentGame.playerX ? 'X' : 'O';
  try {
    await updateDoc(doc(db, 'games', currentGame.id), { [myS === 'X' ? 'pauseResumeX' : 'pauseResumeO']: true });
  } catch (e) { console.warn('Не удалось отметить готовность к продолжению:', e); }
  finally { ui.setBusy(btn, false); }
};
async function doResumeGame(now) {
  const frozen = currentGame.turnRemainingFrozen != null ? currentGame.turnRemainingFrozen : TURN_AUTO_END_TIME;
  const newTurnStart = now - (TURN_AUTO_END_TIME - frozen);
  const newPausedTotal = (currentGame.pausedTotalMs || 0) + (now - (currentGame.pausedAt || now));
  try {
    await updateDoc(doc(db, 'games', currentGame.id), {
      status: STATUS_PLAYING, turnStartTime: newTurnStart, pausedTotalMs: newPausedTotal,
      pausedAt: null, turnRemainingFrozen: null, pauseResumeX: false, pauseResumeO: false
    });
    upsertCatalogFromGame(currentGame.id, { ...currentGame, status: STATUS_PLAYING, pausedAt: null });
  } catch (e) { console.warn('Не удалось возобновить игру:', e); }
}
window.cancelPausedGame = async function(btn) {
  if (!currentGame || !currentGame.id || currentGame.status !== STATUS_PAUSED) return;
  ui.setBusy(btn, true);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'games', currentGame.id));
      if (!snap.exists()) throw new Error('GAME_NOT_FOUND');
      const g = snap.data();
      if (g.status !== STATUS_PAUSED) throw new Error('NOT_PAUSED');
      tx.update(doc(db, 'games', currentGame.id), {
        status: STATUS_CANCELLED, endReason: 'cancelled_by_player', endedAt: Date.now()
      });
    });
    upsertCatalogFromGame(currentGame.id, { ...currentGame, status: STATUS_CANCELLED, endReason: 'cancelled_by_player', endedAt: Date.now() });
    deleteDoc(activityRef(currentGame.id)).catch(() => {});
  } catch (e) {
    console.warn('Отмена игры не выполнена:', e && e.message ? e.message : e);
  } finally {
    ui.setBusy(btn, false);
  }
};
async function endGameDuePauseExpired() {
  if (!currentGame || !currentGame.id) return;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'games', currentGame.id));
      if (!snap.exists()) throw new Error('GAME_NOT_FOUND');
      const g = snap.data();
      if (g.status !== STATUS_PAUSED) throw new Error('NOT_PAUSED');
      if (Date.now() - (g.pausedAt || 0) < PAUSE_MAX_MS) throw new Error('NOT_EXPIRED');
      tx.update(doc(db, 'games', currentGame.id), {
        status: STATUS_CANCELLED, endReason: 'pause_expired', endedAt: Date.now()
      });
    });
    upsertCatalogFromGame(currentGame.id, { ...currentGame, status: STATUS_CANCELLED, endReason: 'pause_expired', endedAt: Date.now() });
    deleteDoc(activityRef(currentGame.id)).catch(() => {});
  } catch (e) {
    console.warn('Завершение по лимиту паузы не выполнено:', e && e.message ? e.message : e);
  }
}
export function endGameDuePauseExpiredIfOver() {
  if (!currentGame || currentGame.status !== STATUS_PAUSED) return false;
  const pauseRemaining = PAUSE_MAX_MS - (Date.now() - (currentGame.pausedAt || Date.now()));
  if (pauseRemaining <= 0) { endGameDuePauseExpired(); return true; }
  return false;
}
export function getPauseWarnMs() { return PAUSE_WARN_MS; }
export function getIdleSleepTimeoutMs() { return IDLE_SLEEP_TIMEOUT; }
export function getWaitingTimeoutMs() { return WAITING_TIMEOUT; }
export function getPauseRemainingMs() {
  if (!currentGame || !currentGame.pausedAt) return PAUSE_MAX_MS;
  return PAUSE_MAX_MS - (Date.now() - currentGame.pausedAt);
}
export function setBanKickInactive() { banKickActive = false; }

// ---------- завершения ----------
window.endGameDueDisconnect = async function(btn) {
  if (!currentGame || !currentGame.id) return;
  ui.setBusy(btn, true);
  const now = Date.now();
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'games', currentGame.id));
      if (!snap.exists()) throw new Error('GAME_NOT_FOUND');
      const g = snap.data();
      if (g.status !== STATUS_PLAYING) throw new Error('NOT_PLAYING');
      tx.update(doc(db, 'games', currentGame.id), {
        status: STATUS_CANCELLED, endReason: 'opponent_disconnected', endedAt: now
      });
    });
    upsertCatalogFromGame(currentGame.id, { ...currentGame, status: STATUS_CANCELLED, endReason: 'opponent_disconnected', endedAt: now });
    deleteDoc(activityRef(currentGame.id)).catch(() => {});
  } catch (e) {
    console.warn('Завершение по дисконнекту не выполнено:', e && e.message ? e.message : e);
  } finally {
    ui.setBusy(btn, false);
  }
};
export async function autoEndGame(reason) {
  if (!currentGame || !currentGame.id) return;
  const myS = currentUser.uid === core.gameState.playerX ? 'X' : 'O';
  const now = Date.now();
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'games', currentGame.id));
      if (!snap.exists()) throw new Error('GAME_NOT_FOUND');
      const g = snap.data();
      if (g.status !== STATUS_PLAYING) throw new Error('NOT_PLAYING');
      tx.update(doc(db, 'games', currentGame.id), {
        status: STATUS_COMPLETED, winner: OTHER[myS], endReason: reason, endedAt: now
      });
    });
    upsertCatalogFromGame(currentGame.id, { ...currentGame, status: STATUS_COMPLETED, winner: OTHER[myS], endReason: reason, endedAt: now });
    deleteDoc(activityRef(currentGame.id)).catch(() => {});
  } catch (e) {
    console.warn('Авто-завершение не выполнено:', e && e.message ? e.message : e);
  }
}
window.confirmSurrender = async function(btn) {
  ui.closeConfirmModal();
  if (!currentGame || !currentGame.id) return;
  ui.setBusy(btn, true);
  const myS = currentUser.uid === core.gameState.playerX ? 'X' : 'O';
  const now = Date.now();
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'games', currentGame.id));
      if (!snap.exists()) throw new Error('GAME_NOT_FOUND');
      const g = snap.data();
      if (g.status !== STATUS_PLAYING) throw new Error('NOT_PLAYING');
      tx.update(doc(db, 'games', currentGame.id), {
        status: STATUS_COMPLETED, winner: OTHER[myS], endReason: 'surrender', endedAt: now
      });
    });
    upsertCatalogFromGame(currentGame.id, { ...currentGame, status: STATUS_COMPLETED, winner: OTHER[myS], endReason: 'surrender', endedAt: now });
    deleteDoc(activityRef(currentGame.id)).catch(() => {});
  } catch (e) {
    console.warn('Сдача не выполнена:', e && e.message ? e.message : e);
  } finally {
    ui.setBusy(btn, false);
  }
};
function buildGameSummary() {
  if (!core.gameState.gameStartTime) return '';
  const endAt = (currentGame && currentGame.endedAt) || Date.now();
  const dur = Math.max(0, endAt - core.gameState.gameStartTime - (core.gameState.pausedTotalMs || 0));
  const movesArr = Object.values(core.gameState.moves);
  const total = movesArr.length;
  const myS = currentUser.uid === core.gameState.playerX ? 'X' : 'O';
  const mine = movesArr.filter((s) => s === myS).length;
  return `\n\u23F1 Длительность: ${ui.formatTime(dur)} • Ходов: ${total} (ваших: ${mine})`;
}
function endGame(winner, reason) {
  const gs = core.gameState;
  const myS = currentUser.uid === gs.playerX ? 'X' : 'O';
  let message;
  let iWon = false;
  if (winner === null) {
    if (reason === 'opponent_disconnected') message = '\u26AA Игра завершена.\nСоперник не переподключился.\nРезультат не засчитан.';
    else if (reason === 'pause_expired') message = '\u26AA Игра завершена.\nИстёк лимит паузы (72 часа).\nРезультат не засчитан.';
    else if (reason === 'cancelled_by_player') message = '\u26AA Игра отменена одним из игроков.\nРезультат не засчитан.';
    else if (reason === 'creator_left') message = '\u26AA Игра отменена: создатель вошёл в другую игру.\nРезультат не засчитан.';
    else if (reason === 'account_deleted') message = '\u{1F5D1}\uFE0F Игра отменена: аккаунт удалён.\nРезультат не засчитан.';
    else if (reason === 'account_banned') {
      if (banKickActive) message = '\u{1F6AB} Игра завершена: ваш аккаунт заблокирован.\nРезультат не засчитан.';
      else {
        const bannedName = (myS === 'X' ? currentGame.playerOName : currentGame.playerXName) || 'соперник';
        message = `\u{1F6AB} Игра завершена: ${bannedName} заблокирован.\nРезультат не засчитан.`;
      }
    }
    else if (reason === 'creator_dormant') message = '\u{1F4A4} Игра отменена: создатель не заходил 30+ дней.\nРезультат не засчитан.';
    else message = '\u26AA Игра завершена.\nРезультат не засчитан.';
    message += '\n\u{1F91D} ' + ui.randomPhrase(CANCEL_PHRASES);
  } else {
    iWon = (winner === myS);
    if (reason === 'timeout') message = iWon ? '\u{1F389} Вы победили!\nВремя соперника истекло.' : '\u{1F614} Время хода истекло.';
    else if (reason === 'surrender') message = iWon ? '\u{1F389} Соперник сдался!' : '\u{1F614} Вы сдались.';
    else message = iWon ? '\u{1F389} Вы победили!' : '\u{1F614} Вы проиграли';
    if (!iWon) message += '\n\u{1F4AA} ' + ui.randomPhrase(LOOSER_PHRASES);
  }
  message += buildGameSummary();
  const delay = gs.winningCells ? WIN_MODAL_DELAY : 100;
  setTimeout(() => {
    if (iWon) ui.spawnConfetti();
    ui.showResultModal(message);
  }, delay);
}

// ---------- удаление аккаунта ----------
export async function deleteAccountTransactions() {
  let activeGames = [];
  try {
    const [gamesAsX, gamesAsO] = await Promise.all([
      getDocs(query(collection(db, 'games'), where('playerX', '==', currentUser.uid))),
      getDocs(query(collection(db, 'games'), where('playerO', '==', currentUser.uid)))
    ]);
    const seenIds = new Set();
    gamesAsX.forEach(d => {
      const g = d.data();
      if ((g.status === STATUS_WAITING || g.status === STATUS_PLAYING || g.status === STATUS_PAUSED) && !seenIds.has(d.id)) { activeGames.push({ id: d.id, game: g }); seenIds.add(d.id); }
    });
    gamesAsO.forEach(d => {
      const g = d.data();
      if ((g.status === STATUS_WAITING || g.status === STATUS_PLAYING || g.status === STATUS_PAUSED) && !seenIds.has(d.id)) { activeGames.push({ id: d.id, game: g }); seenIds.add(d.id); }
    });
  } catch (e) {
    console.warn('Не удалось получить список игр:', e);
  }
  const now = Date.now();
  for (const { id, game } of activeGames) {
    try {
      await updateDoc(doc(db, 'games', id), { status: STATUS_CANCELLED, endReason: 'account_deleted', endedAt: now });
      upsertCatalogFromGame(id, { ...game, status: STATUS_CANCELLED, endReason: 'account_deleted', endedAt: now });
      deleteDoc(activityRef(id)).catch(() => {});
    } catch (e) {
      console.warn(`Не удалось отменить игру ${id}:`, e);
    }
  }
  try {
    await deleteDoc(doc(db, 'users', currentUser.uid));
    console.log('[DELETE] Документ пользователя удалён из Firestore');
  } catch (e) {
    console.warn('Не удалось удалить документ пользователя:', e);
  }
  try {
    localStorage.removeItem('myActiveGameId');
    localStorage.removeItem('myCreatedGameId_persistent');
    sessionStorage.removeItem('myCreatedGameId');
  } catch (e) {}
  let authDeleted = false;
  try {
    await deleteUser(auth.currentUser);
    authDeleted = true;
    console.log('[DELETE] Аккаунт удалён из Authentication');
  } catch (delErr) {
    console.warn('Ошибка удаления из Authentication:', delErr.code, delErr.message);
    try { await signOut(auth); } catch (e) {}
  }
  return authDeleted;
}
export async function reauthForDelete(password) {
  const credential = EmailAuthProvider.credential(currentUser.email, password);
  await reauthenticateWithCredential(currentUser, credential);
}
export function getAuthObj() { return auth; }
export function getDbObj() { return db; }

// ---------- выход из партии ----------
export function cleanupGame() {
  bot.stopBotGame();
  ui.showOnlineElements();
  core.stopRenderLoop();
  ui.stopTimerUpdate();
  stopActivityUpdate();
  ui.stopOpponentCheck();
  stopCreatorHeartbeat();
  if (activityListener) { try { activityListener(); } catch (e) {} activityListener = null; }
  expireUndoWindow();
  clearNudgeProbe();
  undoUsedThisCycle = false;
  optimisticMove = null;
  moveInFlightPromise = null;
  core.resetCoreState();
  gameEndHandled = false;
  if (gameListener) { gameListener(); gameListener = null; }
  clearSavedActiveGameId();
  myActiveGameId = null;
  currentGame = null;
}

// ---------- видимость вкладки ----------
document.addEventListener('visibilitychange', () => {
  const lobbyActive = document.getElementById('lobby-screen').classList.contains('active');
  const gameActive = document.getElementById('game-screen').classList.contains('active');
  if (document.hidden) {
    if (lobbyActive && !ui.getLobbyPausedByVisibility()) {
      pauseLobbySubscriptions();
      ui.setLobbyPausedByVisibility(true);
    }
  } else {
    if (ui.getSleepMode()) return;
    if (lobbyActive && ui.getLobbyPausedByVisibility()) {
      ui.setLobbyPausedByVisibility(false);
      listenToAvailableGames();
      ui.startLobbyCleanup();
      ui.startLobbyCountdowns();
      startOrphanCheck();
    }
    if (gameActive) ui.timerTick();
  }
});

startConnectionMonitor();
console.log(`%c[ONLINE] модуль онлайн загружен (online ${MODULE_VERSION})`, 'color: #4caf50; font-weight: bold;');