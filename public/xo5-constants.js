// ============================================================
// XO5 · 5 в ряд · Модуль 2/8: константы и конфигурация
// v2.0.9 (глобальная версия игры — точка истины)
// Чистый модуль: без DOM, без Firebase, без состояния партии.
// v2.0.9: релиз «контраст кнопок бот-модалки + переименование
// прогрессии бота» — повышение VERSION; новых констант нет.
// ============================================================
// ---------- Версия и авторство ----------
export const VERSION = '2.0.9';
export const AUTHORS = 'Ni.Coder & Qwen';
// ---------- Версия модуля и регистрация в реестре ----------
export const MODULE_VERSION = '1.0.4';
if (typeof window !== 'undefined') {
 window.XO5_VERSIONS = window.XO5_VERSIONS || {};
 window.XO5_VERSIONS.constants = MODULE_VERSION;
}
// ---------- Таймауты партии и ходов (изменяются applyGameConfig) ----------
export let TURN_WARNING_TIME = 15 * 60 * 1000;
export let TURN_AUTO_END_TIME = 20 * 60 * 1000;
export let WAITING_TIMEOUT = 5 * 60 * 1000;
export let PLAYING_INACTIVE_TIMEOUT = 30 * 60 * 1000;
export let PAUSE_MAX_MS = 72 * 60 * 60 * 1000;
export let RECONNECT_TIMEOUT = 20 * 60 * 1000;
export let IDLE_SLEEP_TIMEOUT = 5 * 60 * 1000;
export const PAUSE_WARN_MS = 24 * 60 * 60 * 1000;
export const MOVE_REMINDER_MS = 60000;
// ---------- Геометрия и рендер ----------
export const CAMERA_BOUNDARY_PADDING = 3;
export const WIN_LINE_ANIMATION_DURATION = 1.0;
export const WIN_MODAL_DELAY = (WIN_LINE_ANIMATION_DURATION + 1) * 1000;
export const AIM_FADE_MS = 120;
export const CELL_SIZE = 14;
export const INITIAL_GRID_SIZE = 10;
export const REVEAL_RADIUS = 5;
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 4;
export const DEBUG_REVEAL_RANGE = 50;
// ---------- Интервалы фоновых проверок ----------
export const ACTIVITY_UPDATE_INTERVAL = 45000;
export const OPPONENT_CHECK_INTERVAL = 5000;
export const OPPONENT_OFFLINE_THRESHOLD = 135000;
export const WAITING_CHECK_INTERVAL = 1000;
export const FINISHED_GAME_TIMEOUT = 5 * 60 * 1000;
export const JOIN_NOTIFICATION_DURATION = 3000;
export const CREATOR_HEARTBEAT_INTERVAL = 30000;
export const LOBBY_CLEANUP_INTERVAL = 15000;
export const LOBBY_COUNTDOWN_INTERVAL = 1000;
export const ORPHAN_CHECK_INTERVAL = 60000;
export const ORPHAN_HEAL_THRESHOLD = 120000;
export const IDLE_WARN_BEFORE = 30 * 1000;
export const IDLE_CHECK_INTERVAL = 5000;
export const CONNECTION_CHECK_INTERVAL = 5000;
export const CONNECTION_PING_INTERVAL = 45000;
export const CONNECTION_TIMEOUT = 180000;
// ---------- Сессии и лимиты аккаунтов ----------
export const SESSION_HEARTBEAT_INTERVAL = 60000;
export const SESSION_LEASE_MS = 240000;
export const SESSION_RELEASE_GRACE_MS = 20000;
export const BLOCKED_RETRY_INTERVAL = 10000;
export const MAX_ACTIVE_GAMES = 3;
export const NAME_MAX_REGISTER = 8;
export const NAME_MAX_LOGIN = 20;
export const EMAIL_DOMAIN = '@xo5line.local';
export const NAME_RULE_HINT = ' Новые имена: 3–8 символов, только латиница и цифры, пример: Abcd1234.';
// ---------- Ввод: мышь, тач, отмена ----------
export const LONG_PRESS_MS = 300;
export const DRAG_THRESHOLD_PX = 5;
export const UNDO_WINDOW_MS = 3000;
// ---------- Лобби и комнаты ----------
export const ROOM_NUMBER_MAX = 9999;
export const MAX_CATALOG_ROOMS = 60;
// ---------- Пинки (nudge) ----------
export const NUDGE_COOLDOWN_MS = 30000;
export const NUDGE_PONG_TIMEOUT = 10000;
export const NUDGE_STALE_NOW_MS = 100000;
export const FORCE_CLEAR_FRESH_MS = 90000;
export const NUDGE_BIG_EVERY = 3;
export const NUDGE_MEGA_EVERY = 20;
// ---------- Конфетти ----------
export const CONFETTI_COUNT = 90;
export const CONFETTI_LIFETIME_MS = 5000;
export const CONFETTI_COLORS = ['#667eea', '#764ba2', '#4caf50', '#ff9800', '#ff5252', '#2196f3', '#ffd700'];
// ---------- Лотерея символа (тайминги анимации) ----------
export const LOTTERY_SLOW_END = 500;
export const LOTTERY_FAST_END = 2000;
export const LOTTERY_BRAKE_END = 3000;
export const LOTTERY_REVEAL_END = 4200;
export const LOTTERY_FADE_END = 4700;
export const LOTTERY_OMEGA_SLOW = 0.25 * 2 * Math.PI / 1000;
export const LOTTERY_OMEGA_FAST = 3 * 2 * Math.PI / 1000;
// ---------- Маяк версий и адреса ----------
export const VERSION_URL = 'https://xo5line.web.app/version.js';
export const UPDATE_CHECK_TIMEOUT_MS = 5000;
export const SITE_HOME_URL = 'https://xo5line.web.app/';
// ---------- Словари и строковые константы ----------
export const OTHER = { X: 'O', O: 'X' };
export const LOBBY_MAIN = 'Главное лобби';
export const LOBBY_WAITING = 'Лобби ожидания';
export const STATUS_WAITING = 'waiting';
export const STATUS_PLAYING = 'playing';
export const STATUS_PAUSED = 'paused';
export const STATUS_COMPLETED = 'completed';
export const STATUS_CANCELLED = 'cancelled';
export const LOOSER_PHRASES = [
'Хорошая борьба! В следующий раз повезёт.',
'Соперник сегодня чуть точнее. Ты всё равно молодец!',
'Не сдавайся — твоя победа уже близко.',
'Отличная партия! Реванш будет за тобой.',
'Каждая партия делает тебя сильнее.'
];
export const CANCEL_PHRASES = [
'Без результата — но всё впереди!',
'Ничего страшного, начнём новую партию.',
'Игра не засчитана. Следующая будет результативной!'
];
// ---------- Удалённая конфигурация (config/app в Firestore) ----------
export const GAME_CONFIG_DEFAULTS = {
turnAutoEndMin: 20,
turnWarningMin: 15,
waitingTimeoutMin: 5,
playingInactiveMin: 30,
pauseMaxHours: 72,
reconnectMin: 20,
idleSleepMin: 5
};
export let lobbyConfig = { staleGameDays: 5 };
export function numMin(v, dflt, min, max) {
const n = Number(v);
if (!Number.isFinite(n)) return dflt;
if (n < min) return min;
if (n > max) return max;
return Math.round(n);
}
// Применяет пороги из удалённого конфига; мутирует export let-значения,
// импортёры видят обновления через живые связи ES-модулей.
export function applyGameConfig(g) {
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