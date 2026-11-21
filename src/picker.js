// The task sheet's reminder picker (grouped list: Reminder switch, Date with an inline month
// calendar, Time, Repeat). Pure helpers: callers pass `now`; dates are local 'YYYY-MM-DD' strings,
// times 'HH:MM', the values of native <input type="date"> and <input type="time">.
import { parseLocalInput, toLocalInput } from './reminders.js';

// The time a newly chosen day starts at.
export const DEFAULT_TIME = '09:00';

const pad = (value, length = 2) => String(value).padStart(length, '0');
const DATE = /^(\d{4,6})-(\d{2})-(\d{2})$/;

// 'YYYY-MM-DD' for the local day of a Date (or an instant).
export function localDate(value) {
  const date = new Date(value);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// { year, month (0-11), day } of a date string, or null when it isn't a real day.
export function parseDate(str) {
  const match = typeof str === 'string' ? DATE.exec(str) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month: month - 1, day };
}

function toDate({ year, month, day }) {
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month, day);
  return date;
}

// The picker's fields for a saved reminder: { on, date, time }. No reminder: off and empty.
export function splitDue(due) {
  if (due === null || due === undefined) return { on: false, date: '', time: '' };
  const [date, time] = toLocalInput(due).split('T');
  return { on: true, date, time };
}

// The instant the picker describes. null: no reminder (switch off). undefined: invalid (a missing
// or unreadable date or time). An unchanged date and time keep the saved instant, so a time in the
// repeated hour when clocks go back isn't read back as the other one.
export function pickerDue({ on, date, time, badInput = false }, savedDue = null) {
  if (!on) return null;
  if (badInput || !date || !time || parseDate(date) === null) return undefined;
  if (savedDue !== null) {
    const saved = splitDue(savedDue);
    if (saved.date === date && saved.time === time) return savedDue;
  }
  const due = parseLocalInput(`${date}T${time}`);
  return due === null ? undefined : due;
}

// Where the switch starts when turned on with no date: today at 9:00 AM, or tomorrow when that
// has passed.
export function defaultReminder(now) {
  const nine = new Date(now);
  nine.setHours(9, 0, 0, 0);
  if (nine.getTime() <= now) nine.setDate(nine.getDate() + 1);
  return { date: localDate(nine), time: DEFAULT_TIME };
}

// The date `days` away from a date string (calendar days, so DST doesn't matter).
export function addDays(str, days) {
  const parts = parseDate(str);
  if (!parts) return str;
  return localDate(toDate({ ...parts, day: parts.day + days }));
}

// { year, month } `delta` months away.
export function addMonths(year, month, delta) {
  const index = year * 12 + month + delta;
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
}

// The month view: weeks start on Sunday; days outside the month are null.
export function monthGrid(year, month) {
  const first = toDate({ year, month, day: 1 });
  const length = toDate({ year, month: month + 1, day: 0 }).getDate();
  const cells = Array(first.getDay()).fill(null);
  for (let day = 1; day <= length; day++) cells.push({ date: localDate(toDate({ year, month, day })), day });
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// Any day can be picked, past ones included (an overdue reminder, or one saved to alert at once).
// Paging back stops at the first month there is a reminder time for: January 1970.
export const EARLIEST_DAY = '1970-01-01';

export function canGoBack(year, month) {
  return year * 12 + month > 1970 * 12;
}

const RELATIVE = new Map([[-1, 'Yesterday'], [0, 'Today'], [1, 'Tomorrow']]);

function dayNumber(date) {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

// The Date row's value: "Today", "Tomorrow", "Mon, Nov 23", "Jan 8, 2027".
export function dayLabel(str, now, locale) {
  const parts = parseDate(str);
  if (!parts) return '';
  const date = toDate(parts);
  const today = new Date(now);
  const days = dayNumber(date) - dayNumber(today);
  if (RELATIVE.has(days)) return RELATIVE.get(days);
  const options = date.getFullYear() === today.getFullYear()
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

// A calendar day's accessible name: "Sunday, November 22, 2026".
export function dayName(str, locale) {
  const parts = parseDate(str);
  if (!parts) return '';
  return new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(toDate(parts));
}

// The calendar heading: "November 2026".
export function monthLabel(year, month, locale) {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(toDate({ year, month, day: 1 }));
}

// Arrow keys in the calendar: a day either side, a week up or down.
export const CALENDAR_KEYS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
