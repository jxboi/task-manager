// The task sheet's reminder picker (option A, grouped list): pure date/time helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALENDAR_KEYS, DEFAULT_TIME, addDays, addMonths, canGoBack, dayLabel, dayName, defaultReminder,
  localDate, monthGrid, monthLabel, parseDate, pickerDue, splitDue,
} from '../src/picker.js';

const at = (text) => new Date(text).getTime(); // local time
const now = at('2026-11-21T09:41:00'); // the mockups' Sat Nov 21, 9:41 AM

test('localDate and parseDate round-trip local days and refuse impossible ones', () => {
  assert.equal(localDate(now), '2026-11-21');
  assert.equal(localDate(new Date(2027, 0, 5)), '2027-01-05');
  assert.deepEqual(parseDate('2026-11-21'), { year: 2026, month: 10, day: 21 });
  assert.deepEqual(parseDate('2028-02-29'), { year: 2028, month: 1, day: 29 });
  for (const bad of ['2026-02-29', '2026-13-01', '2026-11-31', '2026-1-5', '', 'tomorrow', null, undefined]) {
    assert.equal(parseDate(bad), null, String(bad));
  }
});

test('splitDue prefills the switch, Date and Time from a saved reminder', () => {
  assert.deepEqual(splitDue(null), { on: false, date: '', time: '' });
  assert.deepEqual(splitDue(at('2026-11-22T08:00:00')), { on: true, date: '2026-11-22', time: '08:00' });
});

test('pickerDue: off is no reminder, missing or unreadable parts are invalid', () => {
  assert.equal(pickerDue({ on: false, date: '2026-11-22', time: '08:00' }), null, 'off wins over leftover fields');
  assert.equal(pickerDue({ on: true, date: '2026-11-22', time: '08:00' }), at('2026-11-22T08:00:00'));
  assert.equal(pickerDue({ on: true, date: '', time: '08:00' }), undefined);
  assert.equal(pickerDue({ on: true, date: '2026-11-22', time: '' }), undefined);
  assert.equal(pickerDue({ on: true, date: '2026-02-30', time: '08:00' }), undefined);
  assert.equal(pickerDue({ on: true, date: '2026-11-22', time: '25:00' }), undefined);
  assert.equal(pickerDue({ on: true, date: '2026-11-22', time: '08:00', badInput: true }), undefined);
});

test('pickerDue keeps the saved instant when Date and Time are unchanged', () => {
  // A saved instant with seconds: unchanged fields give it back exactly, not the rounded minute.
  const saved = at('2026-11-22T08:00:30');
  assert.equal(pickerDue({ on: true, date: '2026-11-22', time: '08:00' }, saved), saved);
  assert.equal(pickerDue({ on: true, date: '2026-11-22', time: '08:01' }, saved), at('2026-11-22T08:01:00'));
  assert.equal(pickerDue({ on: true, date: '2026-11-23', time: '08:00' }, saved), at('2026-11-23T08:00:00'));
});

test('defaultReminder starts at 9:00 AM today, or tomorrow once that has passed', () => {
  assert.equal(DEFAULT_TIME, '09:00');
  assert.deepEqual(defaultReminder(at('2026-11-21T07:30:00')), { date: '2026-11-21', time: '09:00' });
  assert.deepEqual(defaultReminder(now), { date: '2026-11-22', time: '09:00' });
  assert.deepEqual(defaultReminder(at('2026-11-21T09:00:00')), { date: '2026-11-22', time: '09:00' }, '9:00 itself has passed');
  assert.deepEqual(defaultReminder(at('2026-12-31T23:00:00')), { date: '2027-01-01', time: '09:00' });
});

test('addDays and addMonths cross month and year edges', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('not a date', 1), 'not a date');
  assert.deepEqual(addMonths(2026, 10, 1), { year: 2026, month: 11 });
  assert.deepEqual(addMonths(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(addMonths(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(addMonths(2026, 10, -23), { year: 2024, month: 11 });
});

test('monthGrid lays out whole Sunday-first weeks with blanks outside the month', () => {
  const november = monthGrid(2026, 10); // Nov 1, 2026 is a Sunday
  assert.equal(november.length % 7, 0);
  assert.deepEqual(november[0], { date: '2026-11-01', day: 1 });
  assert.equal(november.filter(Boolean).length, 30);
  assert.deepEqual(november.filter(Boolean).at(-1), { date: '2026-11-30', day: 30 });
  assert.deepEqual(november.slice(30), [null, null, null, null, null]);

  const february = monthGrid(2027, 1); // Feb 1, 2027 is a Monday
  assert.equal(february[0], null);
  assert.deepEqual(february[1], { date: '2027-02-01', day: 1 });
  assert.equal(february.filter(Boolean).length, 28);
  assert.equal(monthGrid(2028, 1).filter(Boolean).length, 29, 'leap year');
  // Every cell sits under its weekday.
  for (const [index, cell] of monthGrid(2026, 11).entries()) {
    if (cell) assert.equal(new Date(`${cell.date}T12:00`).getDay(), index % 7, cell.date);
  }
});

test('paging back stops at January 1970; any later month can be paged to', () => {
  assert.equal(canGoBack(1970, 0), false);
  assert.equal(canGoBack(1970, 1), true);
  assert.equal(canGoBack(2000, 0), true);
  assert.equal(canGoBack(2026, 10), true, 'this month is not a floor: past days can be picked');
});

test('dayLabel reads Today / Tomorrow / a short date, and names are full', () => {
  assert.equal(dayLabel('2026-11-21', now), 'Today');
  assert.equal(dayLabel('2026-11-22', now), 'Tomorrow');
  assert.equal(dayLabel('2026-11-20', now), 'Yesterday');
  const format = (date, options) => new Intl.DateTimeFormat(undefined, options).format(new Date(`${date}T12:00`));
  assert.equal(dayLabel('2026-11-23', now), format('2026-11-23', { weekday: 'short', month: 'short', day: 'numeric' }));
  assert.equal(dayLabel('2027-01-08', now), format('2027-01-08', { month: 'short', day: 'numeric', year: 'numeric' }));
  assert.equal(dayLabel('', now), '');
  assert.equal(dayLabel('2026-11-22', now, 'en-US'), 'Tomorrow');
  assert.equal(dayLabel('2026-11-23', now, 'en-US'), 'Mon, Nov 23');
  assert.equal(dayName('2026-11-22', 'en-US'), 'Sunday, November 22, 2026');
  assert.equal(monthLabel(2026, 10, 'en-US'), 'November 2026');
});

test('calendar arrow keys move a day or a week', () => {
  assert.deepEqual(CALENDAR_KEYS, { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 });
  assert.equal(addDays('2026-11-28', CALENDAR_KEYS.ArrowDown), '2026-12-05');
});
