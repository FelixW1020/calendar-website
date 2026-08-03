import assert from 'node:assert/strict';
import { layoutDay } from './layout';
import {
  rangeLabel,
  step,
  toLocalISO,
  visibleRange,
  daysIn,
  formatEventTime,
  eventsOn,
} from './dates';
import type { CalendarEvent } from '../types';

let n = 0;
const ok = (label: string) => console.log(`  ok ${++n} — ${label}`);

const ev = (id: string, start: string, end: string, allDay = false): CalendarEvent => ({
  id,
  title: id,
  start,
  end,
  allDay,
  calendarId: 'personal',
  createdAt: start,
  updatedAt: start,
});

const D = '2026-08-05'; // a Wednesday
const day = new Date(2026, 7, 5);
const at = (h: number, m = 0) => toLocalISO(new Date(2026, 7, 5, h, m));

console.log('\nlayout');
{
  // Two events that merely touch do not overlap → both full width.
  const out = layoutDay([ev('a', at(9), at(10)), ev('b', at(10), at(11))], day);
  assert.equal(out.length, 2);
  assert.ok(out.every((p) => p.width === 1), 'touching events should be full width');
  ok('touching events stay full width');
}
{
  // Two genuine overlaps → half width each, side by side.
  const out = layoutDay([ev('a', at(9), at(11)), ev('b', at(10), at(12))], day);
  const a = out.find((p) => p.event.id === 'a')!;
  const b = out.find((p) => p.event.id === 'b')!;
  assert.equal(a.width, 0.5);
  assert.equal(b.width, 0.5);
  assert.equal(a.left, 0);
  assert.equal(b.left, 0.5);
  ok('two overlapping events split the column');
}
{
  // Three mutually overlapping → thirds.
  const out = layoutDay([ev('a', at(9), at(12)), ev('b', at(9, 30), at(12)), ev('c', at(10), at(12))], day);
  assert.ok(out.every((p) => Math.abs(p.width - 1 / 3) < 1e-9), 'three-way overlap should be thirds');
  assert.deepEqual(
    out.map((p) => p.left).sort(),
    [0, 1 / 3, 2 / 3].sort(),
  );
  ok('three-way overlap splits into thirds');
}
{
  // A column is reused once its previous event has ended.
  const out = layoutDay([ev('a', at(9), at(10)), ev('b', at(9, 30), at(11)), ev('c', at(10, 15), at(11))], day);
  const a = out.find((p) => p.event.id === 'a')!;
  const c = out.find((p) => p.event.id === 'c')!;
  assert.equal(a.left, 0);
  assert.equal(c.left, 0, 'c should reuse the column a vacated');
  ok('columns are reused after an event ends');
}
{
  // Geometry: 9:00–10:30 at 48px/hour.
  const out = layoutDay([ev('a', at(9), at(10, 30))], day);
  assert.equal(out[0].top, 9 * 48);
  assert.equal(out[0].height, 1.5 * 48);
  ok('pixel geometry matches 48px/hour');
}
{
  // An event crossing midnight is clipped to the day and flagged.
  const overnight = ev('n', toLocalISO(new Date(2026, 7, 4, 22)), toLocalISO(new Date(2026, 7, 5, 2)));
  const out = layoutDay([overnight], day);
  assert.equal(out.length, 1);
  assert.equal(out[0].top, 0);
  assert.equal(out[0].height, 2 * 48);
  assert.equal(out[0].continuesBefore, true);
  ok('overnight events clip to the day boundary');
}
{
  // All-day events never enter the timed grid.
  const out = layoutDay([ev('x', `${D}T00:00`, `${D}T23:59`, true)], day);
  assert.equal(out.length, 0);
  ok('all-day events are excluded from the time grid');
}

console.log('\ndates');
{
  const r = visibleRange(day, 'week');
  const ds = daysIn(r);
  assert.equal(ds.length, 7);
  assert.equal(ds[0].getDay(), 0, 'week should start on Sunday');
  ok('week range is 7 days starting Sunday');
}
{
  const ds = daysIn(visibleRange(day, 'month'));
  assert.equal(ds.length % 7, 0);
  assert.ok(ds.length === 35 || ds.length === 42);
  assert.equal(ds[0].getDay(), 0);
  ok('month grid is whole weeks');
}
{
  assert.equal(rangeLabel(day, 'month'), 'August 2026');
  assert.equal(rangeLabel(day, 'day'), 'Wednesday, August 5, 2026');
  ok(`range labels read correctly ("${rangeLabel(day, 'week')}")`);
}
{
  // Month stepping must not roll Jan 31 into March.
  const jan31 = new Date(2026, 0, 31);
  const next = step(jan31, 'month', 1);
  assert.equal(next.getMonth(), 1, 'Jan 31 + 1 month should land in February');
  ok('month stepping does not skip February');
}
{
  const iso = toLocalISO(new Date(2026, 7, 5, 13, 5));
  assert.match(iso, /^2026-08-05T13:05:00[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(iso).getHours(), 13, 'round-trip preserves wall time');
  ok(`local ISO keeps wall time (${iso})`);
}
{
  assert.equal(formatEventTime(ev('a', at(13), at(14))), '1 PM – 2 PM');
  assert.equal(formatEventTime(ev('a', at(13, 30), at(14, 15))), '1:30 PM – 2:15 PM');
  ok('event times format like Google');
}
{
  const overnight = ev('n', toLocalISO(new Date(2026, 7, 4, 22)), toLocalISO(new Date(2026, 7, 5, 2)));
  assert.equal(eventsOn([overnight], new Date(2026, 7, 4)).length, 1);
  assert.equal(eventsOn([overnight], new Date(2026, 7, 5)).length, 1);
  assert.equal(eventsOn([overnight], new Date(2026, 7, 6)).length, 0);
  ok('an overnight event appears on both days it touches');
}

console.log(`\n${n} checks passed\n`);
