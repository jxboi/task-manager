// Fixed zone before any Date use, so the DST cases are the same on every machine.
process.env.TZ = 'America/New_York';

const { test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { REPEATS, normalizeReminder, isOverdue, nextOccurrence, parseLocalInput, toLocalInput } = await import(
  '../src/reminders.js'
);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// January is EST (UTC-5): 09:00 local is 14:00Z.
const jan = (day, hour, minute = 0) => Date.UTC(2026, 0, day, hour + 5, minute);

test('the zone is pinned to America/New_York for these tests', () => {
  assert.equal(new Date(Date.UTC(2026, 0, 1, 14)).getHours(), 9);
  assert.equal(new Date(Date.UTC(2026, 6, 1, 13)).getHours(), 9);
});

test('REPEATS lists the three repeat kinds', () => {
  assert.deepEqual(REPEATS, ['none', 'daily', 'weekly']);
});

test('normalizeReminder gives the defaults for a todo saved before reminders', () => {
  assert.deepEqual(normalizeReminder({}), { due: null, repeat: 'none', notified: null });
  assert.deepEqual(normalizeReminder({ id: 'a', text: 'Keep', completed: false, createdAt: 1, tags: [] }), {
    due: null,
    repeat: 'none',
    notified: null,
  });
});

test('normalizeReminder keeps a valid reminder and is idempotent', () => {
  const valid = { due: 1000, repeat: 'daily', notified: 1000 };
  const once = normalizeReminder(valid);
  assert.deepEqual(once, valid);
  assert.deepEqual(normalizeReminder(once), once);
  assert.deepEqual(normalizeReminder({ due: -1000, repeat: 'weekly', notified: null }), {
    due: -1000,
    repeat: 'weekly',
    notified: null,
  });
  assert.deepEqual(normalizeReminder({ due: 8.64e15, repeat: 'none', notified: 8.64e15 }), {
    due: 8.64e15,
    repeat: 'none',
    notified: 8.64e15,
  });
});

test('normalizeReminder drops a due that is not a whole instant in the Date range, and its repeat', () => {
  for (const due of ['abc', NaN, 1.5, Infinity, -Infinity, 9e15, -9e15, '1000', null, true, {}, [1000]]) {
    assert.deepEqual(
      normalizeReminder({ due, repeat: 'weekly', notified: due }),
      { due: null, repeat: 'none', notified: null },
      String(due),
    );
  }
});

test('normalizeReminder turns an unknown repeat into none and a stale notified into null', () => {
  assert.equal(normalizeReminder({ due: 1000, repeat: 'monthly' }).repeat, 'none');
  for (const repeat of ['Daily', '', null, 7, 'toString', '__proto__']) {
    assert.equal(normalizeReminder({ due: 1000, repeat }).repeat, 'none', String(repeat));
  }
  assert.equal(normalizeReminder({ due: 1000, notified: 5 }).notified, null);
  assert.equal(normalizeReminder({ due: 1000, notified: '1000' }).notified, null);
});

test('normalizeReminder is idempotent on junk too', () => {
  const samples = [
    {},
    { due: 'abc', repeat: 'weekly', notified: 3 },
    { due: 1000, repeat: 'monthly', notified: 5 },
    { due: 1.5, repeat: 'daily' },
    { due: 0, repeat: 'daily', notified: 0 },
  ];
  for (const raw of samples) {
    const once = normalizeReminder(raw);
    assert.deepEqual(normalizeReminder(once), once, JSON.stringify(raw));
  }
});

test('normalizeReminder accepts null and non-objects as no reminder', () => {
  for (const raw of [null, undefined, 42, 'x']) {
    assert.deepEqual(normalizeReminder(raw), { due: null, repeat: 'none', notified: null });
  }
});

test('nextOccurrence is null for none and for anything that is not a repeat', () => {
  assert.equal(nextOccurrence(jan(1, 9), 'none', jan(4, 12)), null);
  for (const repeat of [undefined, 'monthly', 'toString', '']) {
    assert.equal(nextOccurrence(jan(1, 9), repeat, jan(4, 12)), null, String(repeat));
  }
  assert.equal(nextOccurrence(null, 'daily', jan(4, 12)), null);
});

test('nextOccurrence daily skips missed occurrences and rolls from due, not from now', () => {
  assert.equal(nextOccurrence(jan(1, 9), 'daily', jan(4, 12)), jan(5, 9));
  assert.equal(nextOccurrence(jan(1, 9), 'daily', jan(4, 9, 14)), jan(5, 9));
});

test('nextOccurrence is strictly after now', () => {
  assert.equal(nextOccurrence(jan(1, 9), 'daily', jan(4, 9)), jan(5, 9));
  assert.equal(nextOccurrence(jan(1, 9), 'daily', jan(4, 9) - 1), jan(4, 9));
});

test('nextOccurrence is strictly after due: completing early moves to the following occurrence', () => {
  assert.equal(nextOccurrence(jan(5, 9), 'daily', jan(4, 8)), jan(6, 9));
  assert.equal(nextOccurrence(jan(5, 9), 'weekly', jan(4, 8)), jan(12, 9));
});

test('nextOccurrence weekly lands on the same weekday and time', () => {
  // Mon Jan 5 09:00, now Wed Jan 28 -> Mon Feb 2 09:00.
  const next = nextOccurrence(jan(5, 9), 'weekly', jan(28, 12));
  assert.equal(next, Date.UTC(2026, 1, 2, 14));
  assert.equal(new Date(next).getDay(), 1);
});

test('nextOccurrence across DST spring forward keeps 09:00 local (23 hours later)', () => {
  const due = Date.UTC(2026, 2, 7, 14); // Sat Mar 7 09:00 EST
  const next = nextOccurrence(due, 'daily', Date.UTC(2026, 2, 7, 15)); // Mar 7 10:00 EST
  assert.equal(next, Date.UTC(2026, 2, 8, 13)); // Sun Mar 8 09:00 EDT
  assert.equal(next - due, 23 * HOUR);
  assert.equal(new Date(next).getHours(), 9);
});

test('nextOccurrence across DST fall back keeps 09:00 local (25 hours later)', () => {
  const due = Date.UTC(2026, 9, 31, 13); // Sat Oct 31 09:00 EDT
  const next = nextOccurrence(due, 'daily', due + 1);
  assert.equal(next, Date.UTC(2026, 10, 1, 14)); // Sun Nov 1 09:00 EST
  assert.equal(next - due, 25 * HOUR);
  assert.equal(new Date(next).getHours(), 9);
});

test('nextOccurrence weekly across DST spring forward keeps 09:00 local', () => {
  const due = Date.UTC(2026, 2, 1, 14); // Sun Mar 1 09:00 EST
  const next = nextOccurrence(due, 'weekly', Date.UTC(2026, 2, 2, 17));
  assert.equal(next, Date.UTC(2026, 2, 8, 13)); // Sun Mar 8 09:00 EDT
  assert.equal(new Date(next).getHours(), 9);
});

test('nextOccurrence skipping many days across DST still lands on 09:00 local', () => {
  const due = Date.UTC(2026, 1, 20, 14); // Feb 20 09:00 EST
  const now = Date.UTC(2026, 3, 10, 18); // Apr 10 14:00 EDT
  assert.equal(nextOccurrence(due, 'daily', now), Date.UTC(2026, 3, 11, 13)); // Apr 11 09:00 EDT
  assert.equal(nextOccurrence(due, 'daily', Date.UTC(2026, 3, 10, 12)), Date.UTC(2026, 3, 10, 13));
});

test('nextOccurrence in the DST gap: daily 02:30 lands at 03:30 (documented limitation)', () => {
  const due = Date.UTC(2026, 2, 7, 7, 30); // Sat Mar 7 02:30 EST
  const next = nextOccurrence(due, 'daily', due + 1);
  assert.equal(next, Date.UTC(2026, 2, 8, 7, 30)); // Sun Mar 8 03:30 EDT: 02:30 doesn't exist
  assert.equal(new Date(next).getHours(), 3);
  // The stored instant then keeps reading 03:30 on later days.
  assert.equal(new Date(nextOccurrence(next, 'daily', next + 1)).getHours(), 3);
});

test('nextOccurrence after years asleep returns quickly and is in the future', () => {
  const now = Date.UTC(2026, 10, 20, 17);
  const due = now - 5 * 365 * DAY;
  for (const repeat of ['daily', 'weekly']) {
    const start = performance.now();
    const next = nextOccurrence(due, repeat, now);
    const elapsed = performance.now() - start;
    assert.ok(next > now, repeat);
    assert.ok(next - now <= (repeat === 'daily' ? 1 : 7) * DAY + HOUR, repeat);
    assert.equal(new Date(next).getHours(), new Date(due).getHours(), repeat);
    assert.ok(elapsed < 1, `${repeat} took ${elapsed}ms`);
  }
});

test('nextOccurrence returns null rather than an invalid instant at the end of the Date range', () => {
  assert.equal(nextOccurrence(8.64e15, 'daily', 8.64e15), null);
});

test('isOverdue: due at or before now, not completed, with a reminder', () => {
  const now = jan(4, 12);
  assert.equal(isOverdue({ completed: false, due: now }, now), true);
  assert.equal(isOverdue({ completed: false, due: now - 1 }, now), true);
  assert.equal(isOverdue({ completed: false, due: now + 1 }, now), false);
  assert.equal(isOverdue({ completed: true, due: now - 1 }, now), false);
  assert.equal(isOverdue({ completed: false, due: null }, now), false);
  assert.equal(isOverdue({ completed: false }, now), false);
});

test('parseLocalInput reads a datetime-local value as local time', () => {
  assert.equal(parseLocalInput('2026-03-08T09:30'), Date.UTC(2026, 2, 8, 13, 30)); // EDT
  assert.equal(parseLocalInput('2026-01-05T09:00'), jan(5, 9)); // EST
  assert.equal(parseLocalInput('2026-03-08T09:30:15'), Date.UTC(2026, 2, 8, 13, 30, 15));
  assert.equal(parseLocalInput('2026-03-08T09:30:15.5'), Date.UTC(2026, 2, 8, 13, 30, 15, 500));
  assert.equal(parseLocalInput('2028-02-29T00:00'), Date.UTC(2028, 1, 29, 5));
  assert.equal(parseLocalInput('0050-06-01T12:00'), new Date('0050-06-01T12:00').getTime());
});

test('parseLocalInput rejects empty, junk and impossible values', () => {
  const bad = [
    '', 'junk', '2026-13-40T99:00', '2026-02-30T09:00', '2027-02-29T09:00', '2026-03-08', '2026-03-08T24:00',
    '2026-03-08T09:60', '2026-3-8T9:30', ' 2026-03-08T09:30', '2026-03-08 09:30', '2026-00-10T09:00',
    '275761-01-01T00:00', null, undefined, 42,
  ];
  for (const value of bad) assert.equal(parseLocalInput(value), null, String(value));
});

test('parseLocalInput resolves a time in the DST gap like Date does', () => {
  assert.equal(parseLocalInput('2026-03-08T02:30'), Date.UTC(2026, 2, 8, 7, 30)); // 03:30 EDT
});

test('toLocalInput formats an instant as local datetime-local text', () => {
  assert.equal(toLocalInput(Date.UTC(2026, 2, 8, 13, 30)), '2026-03-08T09:30');
  assert.equal(toLocalInput(jan(5, 9, 7)), '2026-01-05T09:07');
  assert.equal(toLocalInput(Date.UTC(2026, 2, 8, 13, 30, 59)), '2026-03-08T09:30');
  assert.equal(toLocalInput(NaN), '');
  assert.equal(toLocalInput(null), '');
});

test('toLocalInput and parseLocalInput round-trip', () => {
  for (const value of [
    '2026-03-08T09:30', '2026-11-01T01:30', '2026-01-01T00:00', '2026-12-31T23:59', '2028-02-29T12:00',
    '0050-06-01T12:00',
  ]) {
    assert.equal(toLocalInput(parseLocalInput(value)), value);
  }
});
