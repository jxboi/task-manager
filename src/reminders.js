// Pure reminder rules for one todo or one instant. Callers pass `now`; the only Date use is
// building a Date from a given instant to do local wall-clock math.

export const REPEATS = ['none', 'daily', 'weekly'];

// The range a Date can hold, in ms either side of the epoch.
const MAX_TIME = 8.64e15;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = { daily: 1, weekly: 7 };

function isInstant(value) {
  return Number.isInteger(value) && Math.abs(value) <= MAX_TIME;
}

// Migration rules for stored data. Idempotent: normalizing the result gives it back.
export function normalizeReminder(raw) {
  const due = isInstant(raw?.due) ? raw.due : null;
  const repeat = due !== null && REPEATS.includes(raw.repeat) ? raw.repeat : 'none';
  const notified = due !== null && raw.notified === due ? due : null;
  return { due, repeat, notified };
}

// A repeating completion expires at the start of the next occurrence's local day.
// Rows without a cutoff keep their ordinary completion state.
export function isCompleted(todo, now) {
  return todo.completed && (todo.completedUntil == null || now < todo.completedUntil);
}

// Derived, never stored.
export function isOverdue(todo, now) {
  return !isCompleted(todo, now) && typeof todo.due === 'number' && todo.due <= now;
}

export function nextReminderAfterToday(due, repeat, now) {
  if (!Object.hasOwn(PERIOD_DAYS, repeat) || !isInstant(due)) return null;
  const tomorrow = new Date(now).setHours(24, 0, 0, 0);
  const endOfToday = Number.isNaN(tomorrow) ? now : tomorrow - 1;
  // After undoing a completion, the next occurrence is already scheduled.
  return due > endOfToday ? due : nextOccurrence(due, repeat, endOfToday);
}

// First occurrence strictly after both `due` and `now`, stepping whole local days from `due` so the
// wall-clock time survives DST. Skipped occurrences are not replayed. null for 'none' (or anything
// that isn't a repeat) and when the next occurrence is outside the Date range.
export function nextOccurrence(due, repeat, now) {
  if (!Object.hasOwn(PERIOD_DAYS, repeat) || !isInstant(due)) return null;
  const days = PERIOD_DAYS[repeat];
  const after = Math.max(due, now);
  // Each candidate is counted from `due` itself, so a skipped occurrence that fell in a DST gap
  // doesn't drag later ones off their wall-clock time.
  const occurrence = (index) => {
    const date = new Date(due);
    date.setDate(date.getDate() + index * days);
    return date.getTime();
  };
  // Jump close first (a local day is 23 to 25 hours, so this never overshoots), then step.
  let index = Math.floor((after - due) / (days * DAY_MS));
  while (occurrence(index) <= after) index++;
  const next = occurrence(index);
  return isInstant(next) ? next : null;
}

const LOCAL_INPUT = /^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

function daysInMonth(year, month) {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

// The value of an <input type="datetime-local"> ("2026-03-08T09:30"), read as local time.
// A time inside a spring-forward gap resolves the way Date does (02:30 -> 03:30).
export function parseLocalInput(str) {
  const match = typeof str === 'string' ? LOCAL_INPUT.exec(str) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0));
  const ms = Number((match[7] ?? '0').padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const date = new Date(2000, 0, 1, hour, minute, second, ms);
  date.setFullYear(year, month - 1, day); // setFullYear, so years below 100 aren't read as 19xx
  const time = date.getTime();
  return isInstant(time) ? time : null;
}

const pad = (value, length = 2) => String(value).padStart(length, '0');

// Same format as parseLocalInput, in local time, to minute precision. '' for a non-instant.
export function toLocalInput(ms) {
  if (!isInstant(ms)) return '';
  const date = new Date(ms);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
