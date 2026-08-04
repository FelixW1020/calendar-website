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
import {
  directionsUrl,
  expandQuery,
  isMeetingLink,
  mapEmbedUrl,
  mapsUrl,
  matchQuery,
  significantTokens,
  tokenize,
} from './geocode';
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

console.log('\ngeocode');
{
  assert.equal(isMeetingLink('https://zoom.us/j/123'), true);
  assert.equal(isMeetingLink('meet.google.com/abc-defg'), true);
  assert.equal(isMeetingLink('1364 Campus Dr, Durham'), false);
  assert.equal(isMeetingLink('Room 302'), false);
  ok('meeting links are told apart from addresses');
}
{
  const place = { lat: 36.0018682, lon: -78.9402861, label: 'Duke Chapel, Durham, NC' };
  // A pinned location must open at the pin, not at whatever the text re-matches.
  assert.match(mapsUrl('Duke Chapel', place), /query=36\.0018682%2C-78\.9402861/);
  assert.match(mapsUrl('Room 302'), /query=Room%20302/);
  assert.match(directionsUrl('Duke Chapel', place), /destination=36\.0018682/);
  ok('map links prefer coordinates over text');
}
{
  const place = { lat: 36, lon: -78.9, label: 'x' };
  const url = new URL(mapEmbedUrl(place));
  assert.equal(url.searchParams.get('marker'), '36,-78.9');
  const [west, south, east, north] = url.searchParams.get('bbox')!.split(',').map(Number);
  assert.ok(west < place.lon && east > place.lon, 'marker sits inside the box horizontally');
  assert.ok(south < place.lat && north > place.lat, 'marker sits inside the box vertically');
  ok('the map embed frames its marker');
}

console.log('\nplace matching');
{
  // Photon indexes "Road", not "Rd" — sending the abbreviation is what made
  // "6 hotz rd" come back as 3rd Avenue, New York.
  assert.equal(expandQuery('6 hotz rd, lin'), '6 hotz road, lin');
  assert.equal(expandQuery('1364 Campus Dr'), '1364 Campus drive');
  // Ambiguous ones are left alone: "st" is as often Saint as Street, and "ne"
  // is Nebraska as well as northeast.
  assert.equal(expandQuery('st louis'), 'st louis');
  assert.equal(expandQuery('Omaha NE'), 'Omaha NE');
  // A word that merely starts with an abbreviation is left alone.
  assert.equal(expandQuery('Stockholm'), 'Stockholm');
  // The unit is about the inside of the building; map data has no idea.
  assert.equal(expandQuery('1364 Campus Dr, Suite 200, Durham'), '1364 Campus drive, Durham');
  ok('street types are spelled out before searching, ambiguous ones are not');
}
{
  // "Trader Joe's", "Trader Joes" and the curly-quoted form are one name.
  assert.deepEqual(tokenize("Trader Joe's"), ['trader', 'joes']);
  assert.deepEqual(tokenize('Trader Joe’s'), tokenize('trader joes'));
  // The unit, and the filler, carry no location.
  assert.deepEqual(significantTokens(tokenize('1364 Campus Dr, Suite 200, Durham')), [
    'campus',
    'dr',
    'durham',
  ]);
  assert.deepEqual(significantTokens(tokenize('The Cheesecake Factory')), [
    'cheesecake',
    'factory',
  ]);
  // A room number is not a place, and nothing is left to search for.
  assert.deepEqual(significantTokens(tokenize('Room 302')), []);
  ok('names, units and filler are read the way a person writes them');
}
{
  const m = (q: string, label: string) => matchQuery(tokenize(q), label);

  // The results that started this: neither is on a road called Hotz.
  assert.equal(m('6 hotz rd', '3rd Avenue, New York, United States'), null);
  assert.equal(m('6 hotz rd, lin', 'LN6 7RD, Lincoln, England, United Kingdom'), null);
  ok('results that do not contain what was typed are rejected');
}
{
  const m = (q: string, label: string, houseNumber?: string) =>
    matchQuery(tokenize(q), label, houseNumber);

  // The street is mapped, the building is not: usable, but street-level.
  assert.deepEqual(m('6 hotz rd, lin', 'North Hotz Road, Lincolnshire, Illinois, 60069'), {
    approximate: true,
  });
  // The building itself is mapped.
  assert.deepEqual(
    m('1364 campus dr, dur', 'West Duke Building, 1364 Campus Drive, Durham, NC', '1364'),
    { approximate: false },
  );
  // The neighbour's door is the right block, but it is not the address typed,
  // so it is offered as approximate rather than as an exact answer.
  assert.deepEqual(m('302 main st', '3025 Main Street, Springfield', '3025'), {
    approximate: true,
  });
  ok('a mapped building is told apart from its street, and from its neighbours');
}
{
  const m = (q: string, label: string) => matchQuery(tokenize(q), label);

  // Half-typed words match by prefix; numbers never do.
  assert.ok(m('duke chap', 'Duke Chapel, 401 Chapel Drive, Durham, NC'));
  assert.equal(m('durham 27705', 'Durham, NC, 27701'), null);
  ok('words match by prefix, numbers exactly');
}
{
  const m = (q: string, label: string) => matchQuery(tokenize(q), label);

  // Abbreviations are alternatives, not rewrites: "st" is Saint here and
  // Street there, and a lone "s" is neither.
  assert.ok(m('st louis', 'Saint Louis, Missouri'));
  assert.ok(m('saint clair il', 'St. Clair, Illinois'));
  assert.ok(m("trader joes durham", "Trader Joe's, 1800 Main Street, Durham, NC"));
  // A state code may stand in for the state's name…
  assert.ok(m('duke chapel durham nc', 'Duke Chapel, Chapel Drive, Durham, North Carolina'));
  // …but writing the words means the place, not merely the state: this is
  // Hanover Square in Horseheads, NY, and it is not what was asked for.
  assert.equal(m('2 hanover square, new york, ny', 'Simon’s, 2 Hanover Square, Horseheads, NY'), null);
  ok('abbreviations expand both ways, state names only one way');
}
{
  const m = (q: string, label: string) => matchQuery(tokenize(q), label);

  // A word the map data does not carry should not sink an otherwise perfect
  // result — but the name and the place must still both be there.
  assert.ok(m('apple store fifth avenue', 'Apple Fifth Avenue, 767 5th Avenue, New York, NY'));
  assert.equal(m('duke chapel durham', 'Duke Chapel, Mt Ararat Road, Henderson, Tennessee'), null);
  ok('an extra descriptive word is tolerated, a wrong city is not');
}

console.log(`\n${n} checks passed\n`);
