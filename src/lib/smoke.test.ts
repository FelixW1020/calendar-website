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
  format,
  parse,
} from './dates';
import {
  describeRule,
  expandEvents,
  formatRule,
  nextOccurrence,
  occurrenceId,
  parseRule,
  resolveEvent,
  ruleEndingBefore,
} from './recurrence';
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

console.log('\nrecurrence');
{
  // The rule text round-trips through the model, ignoring how it was written.
  assert.deepEqual(parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'), {
    freq: 'WEEKLY',
    interval: 2,
    byDay: ['MO', 'WE'],
  });
  assert.equal(formatRule(parseRule('rrule:freq=daily;interval=1')!), 'FREQ=DAILY');
  assert.equal(formatRule(parseRule('FREQ=MONTHLY;BYDAY=2TU')!), 'FREQ=MONTHLY;BYDAY=2TU');
  assert.equal(formatRule(parseRule('FREQ=DAILY;UNTIL=20260901')!), 'FREQ=DAILY;UNTIL=20260901');
  assert.equal(parseRule('every tuesday'), null);
  assert.equal(parseRule(undefined), null);
  ok('rules parse and re-serialise');
}
{
  assert.equal(describeRule(parseRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')!, day), 'Every weekday');
  assert.equal(describeRule(parseRule('FREQ=WEEKLY')!, day), 'Weekly on Wednesday');
  assert.equal(
    describeRule(parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=5')!, day),
    'Every 2 weeks on Friday, 5 times',
  );
  assert.equal(describeRule(parseRule('FREQ=MONTHLY;BYDAY=-1TH')!, day), 'Monthly on the last Thursday');
  ok('rules describe themselves in English');
}

/** A repeating event and the range one week of the grid would ask for. */
const repeating = (rrule: string, start = at(9), end = at(10)): CalendarEvent => ({
  ...ev('series', start, end),
  recurrence: rrule,
});
const august = (from: number, to: number) => ({
  from: new Date(2026, 7, from),
  to: new Date(2026, 7, to),
});

{
  // Aug 5 2026 is a Wednesday; the week runs Sun Aug 2 – Sat Aug 8.
  const { from, to } = august(2, 9);
  const week = expandEvents([repeating('FREQ=WEEKLY;BYDAY=MO,WE')], from, to);
  assert.deepEqual(
    week.map((e) => format(parse(e.start), 'EEE d')).sort(),
    ['Wed 5'],
    'the series starts on the 5th, so Monday the 3rd is before it',
  );
  const next = expandEvents([repeating('FREQ=WEEKLY;BYDAY=MO,WE')], new Date(2026, 7, 9), new Date(2026, 7, 16));
  assert.deepEqual(next.map((e) => format(parse(e.start), 'EEE d')), ['Mon 10', 'Wed 12']);
  assert.ok(next.every((e) => format(parse(e.start), 'HH:mm') === '09:00'), 'time of day is carried');
  ok('a weekly rule lands on every day it names, and never before it starts');
}
{
  // Every other week, so the 12th is skipped and the 19th is not.
  const rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE';
  const out = expandEvents([repeating(rule)], new Date(2026, 7, 1), new Date(2026, 8, 1));
  assert.deepEqual(out.map((e) => format(parse(e.start), 'd')), ['5', '19']);
  ok('INTERVAL skips the weeks in between');
}
{
  const capped = expandEvents([repeating('FREQ=DAILY;COUNT=3')], new Date(2026, 7, 1), new Date(2026, 8, 1));
  assert.deepEqual(capped.map((e) => format(parse(e.start), 'd')), ['5', '6', '7']);
  // COUNT is counted from the first occurrence, not from the window on screen.
  const later = expandEvents([repeating('FREQ=DAILY;COUNT=3')], new Date(2026, 7, 7), new Date(2026, 8, 1));
  assert.deepEqual(later.map((e) => format(parse(e.start), 'd')), ['7']);
  const until = expandEvents([repeating('FREQ=DAILY;UNTIL=20260807')], new Date(2026, 7, 1), new Date(2026, 8, 1));
  assert.deepEqual(until.map((e) => format(parse(e.start), 'd')), ['5', '6', '7'], 'UNTIL includes its day');
  ok('COUNT and UNTIL end a series in the right place');
}
{
  // Jan 31 monthly: February has no 31st, so it is skipped rather than moved.
  const jan31 = ev('m', toLocalISO(new Date(2026, 0, 31, 9)), toLocalISO(new Date(2026, 0, 31, 10)));
  const out = expandEvents(
    [{ ...jan31, recurrence: 'FREQ=MONTHLY' }],
    new Date(2026, 0, 1),
    new Date(2026, 4, 1),
  );
  assert.deepEqual(out.map((e) => format(parse(e.start), 'MMM d')), ['Jan 31', 'Mar 31']);
  ok('a monthly rule skips months that have no such day');
}
{
  // "The second Tuesday", across a month boundary that shifts the date.
  const aug11 = ev('n', toLocalISO(new Date(2026, 7, 11, 9)), toLocalISO(new Date(2026, 7, 11, 10)));
  const out = expandEvents(
    [{ ...aug11, recurrence: 'FREQ=MONTHLY;BYDAY=2TU' }],
    new Date(2026, 7, 1),
    new Date(2026, 10, 1),
  );
  assert.deepEqual(out.map((e) => format(parse(e.start), 'MMM d')), ['Aug 11', 'Sep 8', 'Oct 13']);
  ok('the nth weekday of the month tracks the calendar');
}
{
  // A deleted occurrence and an edited one both come out of the rule.
  const master = repeating('FREQ=DAILY');
  const skipped = toLocalISO(new Date(2026, 7, 6, 9));
  const moved: CalendarEvent = {
    ...ev('edited', toLocalISO(new Date(2026, 7, 7, 15)), toLocalISO(new Date(2026, 7, 7, 16))),
    recurrenceId: 'series',
    originalStart: toLocalISO(new Date(2026, 7, 7, 9)),
  };
  const out = expandEvents(
    [{ ...master, exdates: [skipped] }, moved],
    new Date(2026, 7, 5),
    new Date(2026, 7, 9),
  );
  assert.deepEqual(
    out.map((e) => format(parse(e.start), 'd HH:mm')).sort(),
    ['5 09:00', '7 15:00', '8 09:00'],
    'the 6th is gone and the 7th shows only its edited copy',
  );
  ok('exceptions replace the occurrences they stand for');
}
{
  // An occurrence has no row of its own, so the editor rebuilds it from its id.
  const master = repeating('FREQ=WEEKLY');
  const wanted = toLocalISO(new Date(2026, 7, 19, 9));
  const found = resolveEvent([master], occurrenceId('series', wanted));
  assert.equal(found?.start, wanted);
  assert.equal(found?.recurrenceId, 'series');
  assert.equal(format(parse(found!.end), 'HH:mm'), '10:00', 'the occurrence keeps the length');
  assert.equal(resolveEvent([{ ...master, exdates: [wanted] }], occurrenceId('series', wanted)), null);
  ok('an occurrence id round-trips back into an event');
}
{
  const master = repeating('FREQ=WEEKLY');
  const next = nextOccurrence(master, new Date(2026, 7, 20));
  assert.equal(format(parse(next!.start), 'MMM d'), 'Aug 26', 'the next one after the 20th');
  ok('search can find the occurrence that is coming up');
}
{
  // Splitting for "this and following": the first half keeps what it had.
  const master = repeating('FREQ=DAILY;COUNT=5');
  const head = ruleEndingBefore(master, parseRule(master.recurrence)!, new Date(2026, 7, 8));
  assert.equal(head?.kept, 3, 'the 5th, 6th and 7th stay behind');
  assert.equal(formatRule(head!.rule), 'FREQ=DAILY;COUNT=3');
  const openEnded = repeating('FREQ=DAILY');
  const cut = ruleEndingBefore(openEnded, parseRule(openEnded.recurrence)!, new Date(2026, 7, 8));
  assert.equal(formatRule(cut!.rule), 'FREQ=DAILY;UNTIL=20260807');
  ok('a series splits into two rules that do not overlap');
}
{
  // An open-ended daily rule drawn far in the future must not walk every day
  // between here and there.
  const started = performance.now();
  const out = expandEvents([repeating('FREQ=DAILY')], new Date(2126, 0, 1), new Date(2126, 0, 8));
  assert.equal(out.length, 7);
  assert.ok(performance.now() - started < 50, 'expansion should skip ahead, not iterate');
  ok('a century-long series expands in constant time');
}

console.log('\nediting a series');
{
  // The store persists through localStorage, which node has no notion of. The
  // import has to come after the shim, so it is a dynamic one.
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  const { useStore, diffEvents, isEmptyRestore } = await import('../store');

  const week = { from: new Date(2026, 7, 1), to: new Date(2026, 8, 1) };
  /** 7am on a day in August 2026, the wall time the series is anchored on. */
  const morning = (dayOfMonth: number, hour = 7) => toLocalISO(new Date(2026, 7, dayOfMonth, hour));
  const startAugust = (rrule: string) => {
    useStore.setState({ events: [] });
    return useStore.getState().createEvent({
      title: 'Gym',
      start: at(7),
      end: at(8),
      allDay: false,
      calendarId: 'personal',
      recurrence: rrule,
    });
  };
  const dates = () =>
    expandEvents(useStore.getState().events, week.from, week.to)
      .map((e) => format(parse(e.start), 'd HH:mm'))
      .sort((a, b) => Number(a.split(' ')[0]) - Number(b.split(' ')[0]));

  {
    const master = startAugust('FREQ=WEEKLY;BYDAY=WE');
    assert.deepEqual(dates(), ['5 07:00', '12 07:00', '19 07:00', '26 07:00']);

    // "This event" only: the 12th goes, the rest of the series does not.
    useStore.getState().deleteEventScoped(occurrenceId(master.id, morning(12)), 'this');
    assert.deepEqual(dates(), ['5 07:00', '19 07:00', '26 07:00']);
    assert.equal(useStore.getState().events.length, 1, 'still one stored row');
    ok('deleting one occurrence leaves the series standing');
  }
  {
    const master = startAugust('FREQ=WEEKLY;BYDAY=WE');
    const twelfth = occurrenceId(master.id, morning(12));
    useStore.getState().updateEventScoped(
      twelfth,
      { start: toLocalISO(new Date(2026, 7, 12, 18)), end: toLocalISO(new Date(2026, 7, 12, 19)) },
      'this',
    );
    assert.deepEqual(dates(), ['5 07:00', '12 18:00', '19 07:00', '26 07:00']);
    assert.equal(useStore.getState().events.length, 2, 'the edit is a second row');
    ok('moving one occurrence does not move the others');
  }
  {
    const master = startAugust('FREQ=WEEKLY;BYDAY=WE');
    // "All events" moves the whole series, including the master's own day.
    useStore.getState().updateEventScoped(
      occurrenceId(master.id, morning(19)),
      { start: toLocalISO(new Date(2026, 7, 19, 8)), end: toLocalISO(new Date(2026, 7, 19, 9)) },
      'all',
    );
    assert.deepEqual(dates(), ['5 08:00', '12 08:00', '19 08:00', '26 08:00']);
    ok('an all-events change reaches back to the ones already past');
  }
  {
    const master = startAugust('FREQ=WEEKLY;BYDAY=WE');
    // Dragged to Thursday for good: the rule has to follow the event.
    useStore.getState().updateEventScoped(
      occurrenceId(master.id, morning(19)),
      { start: toLocalISO(new Date(2026, 7, 20, 7)), end: toLocalISO(new Date(2026, 7, 20, 8)) },
      'following',
    );
    assert.deepEqual(dates(), ['5 07:00', '12 07:00', '20 07:00', '27 07:00']);
    assert.equal(useStore.getState().events.length, 2, 'the series split in two');
    const [head, tail] = useStore.getState().events;
    assert.equal(head.recurrence, 'FREQ=WEEKLY;BYDAY=WE;UNTIL=20260818');
    assert.equal(tail.recurrence, 'FREQ=WEEKLY;BYDAY=TH', 'the new half repeats on its new day');
    ok('"this and following" splits the series and carries the weekday over');
  }
  {
    const master = startAugust('FREQ=WEEKLY;BYDAY=WE');
    useStore.getState().updateEventScoped(occurrenceId(master.id, morning(5)), { title: 'Swim' }, 'all');
    assert.equal(useStore.getState().events[0].title, 'Swim');
    assert.equal(dates().length, 4, 'editing the title does not disturb the dates');

    useStore.getState().deleteEventScoped(occurrenceId(master.id, morning(19)), 'all');
    assert.deepEqual(useStore.getState().events, [], 'the whole series is gone');
    ok('the series can still be edited and deleted as a whole');
  }
  {
    const master = startAugust('FREQ=WEEKLY;BYDAY=WE');
    // Turning repetition off collapses the series back to a single event.
    useStore.getState().updateEventScoped(occurrenceId(master.id, morning(5)), { recurrence: undefined }, 'all');
    assert.deepEqual(dates(), ['5 07:00']);
    ok('clearing the rule leaves one ordinary event behind');
  }

  console.log('\nundoing a delete');
  /** Run a change and hand back what it would take to reverse it. */
  const undoable = (change: () => void) => {
    const before = useStore.getState().events;
    change();
    return diffEvents(before, useStore.getState().events);
  };

  {
    useStore.setState({ events: [] });
    const one = useStore.getState().createEvent({
      title: 'Dentist',
      start: morning(5, 14),
      end: morning(5, 15),
      allDay: false,
      calendarId: 'personal',
    });
    const back = undoable(() => useStore.getState().deleteEventScoped(one.id, 'all'));
    assert.deepEqual(useStore.getState().events, []);

    useStore.getState().restoreEvents(back);
    const [again] = useStore.getState().events;
    assert.equal(again.id, one.id, 'the same row comes back, not a copy of it');
    assert.equal(again.title, 'Dentist');
    assert.equal(again.start, one.start);
    // The server is holding a tombstone stamped after the original row; coming
    // back with the old timestamp would lose to it on the next merge.
    assert.ok(parse(again.updatedAt) >= parse(one.updatedAt), 'a restore counts as a write');
    ok('a deleted event comes back with its own id');
  }
  {
    // Deleting one occurrence edits the master rather than removing a row, so
    // undo has to put a *changed* row back, not a missing one.
    const master = startAugust('FREQ=WEEKLY;BYDAY=WE');
    const back = undoable(() =>
      useStore.getState().deleteEventScoped(occurrenceId(master.id, morning(12)), 'this'),
    );
    assert.deepEqual(dates(), ['5 07:00', '19 07:00', '26 07:00']);
    assert.equal(back.restore.length, 1, 'the master is what changed');
    assert.deepEqual(back.remove, []);

    useStore.getState().restoreEvents(back);
    assert.deepEqual(dates(), ['5 07:00', '12 07:00', '19 07:00', '26 07:00']);
    assert.equal(useStore.getState().events[0].exdates, undefined, 'the hole is filled in again');
    ok('undoing one skipped occurrence restores the series');
  }
  {
    // "This and following" rewrites the rule and drops the edited occurrences
    // after it. Both have to come back.
    const master = startAugust('FREQ=WEEKLY;BYDAY=WE');
    useStore.getState().updateEventScoped(
      occurrenceId(master.id, morning(26)),
      { title: 'Long run' },
      'this',
    );
    assert.equal(useStore.getState().events.length, 2);

    const back = undoable(() =>
      useStore.getState().deleteEventScoped(occurrenceId(master.id, morning(19)), 'following'),
    );
    assert.deepEqual(dates(), ['5 07:00', '12 07:00']);

    useStore.getState().restoreEvents(back);
    assert.deepEqual(dates(), ['5 07:00', '12 07:00', '19 07:00', '26 07:00']);
    assert.equal(useStore.getState().events.length, 2, 'the hand-edited occurrence is back too');
    ok('undoing a split puts the rule and its exceptions back');
  }
  {
    // Undo must reverse the deletion and nothing else.
    useStore.setState({ events: [] });
    const doomed = useStore.getState().createEvent({
      title: 'Standup',
      start: morning(5),
      end: morning(5, 8),
      allDay: false,
      calendarId: 'personal',
    });
    const back = undoable(() => useStore.getState().deleteEventScoped(doomed.id, 'all'));
    const later = useStore.getState().createEvent({
      title: 'Booked afterwards',
      start: morning(6),
      end: morning(6, 8),
      allDay: false,
      calendarId: 'personal',
    });

    useStore.getState().restoreEvents(back);
    const titles = useStore.getState().events.map((e) => e.title).sort();
    assert.deepEqual(titles, ['Booked afterwards', 'Standup']);
    assert.ok(useStore.getState().events.some((e) => e.id === later.id));
    ok('undo leaves everything booked since then alone');
  }
  {
    const before = useStore.getState().events;
    assert.equal(isEmptyRestore(diffEvents(before, before)), true);
    ok('a change that changed nothing offers no undo');
  }
}

console.log('\nassistant tools');
{
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  const { useStore } = await import('../store');
  const { buildTools } = await import('./assistant');

  const s = () => useStore.getState();
  const log: string[] = [];
  const tools = buildTools({
    getEvents: () => s().events,
    getCalendars: () => s().calendars,
    createEvent: (e) => s().createEvent(e),
    updateEvent: (id, patch, scope) => s().updateEventScoped(id, patch, scope),
    deleteEvent: (id, scope) => s().deleteEventScoped(id, scope),
    confirm: async () => true,
    onAction: (line) => log.push(line),
    onUndoable: () => {},
    onEventTouched: () => {},
  });
  // The tools are a union of differently-typed runnables; for the test they are
  // just things with a name and a run.
  const runnable = tools as unknown as { name: string; run: (i: unknown) => Promise<string> }[];
  const call = async (name: string, input: unknown) =>
    JSON.parse(String(await runnable.find((t) => t.name === name)!.run(input)));

  const on = (dayOfMonth: number, hour: number) => toLocalISO(new Date(2026, 7, dayOfMonth, hour));
  const add = (title: string, dayOfMonth: number, hour: number, rrule?: string) =>
    s().createEvent({
      title,
      start: on(dayOfMonth, hour),
      end: on(dayOfMonth, hour + 1),
      allDay: false,
      calendarId: 'personal',
      ...(rrule ? { recurrence: rrule } : {}),
    });

  {
    // The mess the old assistant left behind: it could not repeat an event, so
    // "gym every Monday" became a run of concrete copies — twice over, here.
    useStore.setState({ events: [] });
    for (let i = 0; i < 16; i++) add('Gym', 3 + i, 7);

    const partial = await call('find_events', { query: 'gym', limit: 10 });
    assert.equal(partial.matches.length, 10);
    assert.equal(partial.total, 16, 'the total is reported even when the page is short');
    assert.ok(partial.advice, 'a short page says so rather than reading as the whole answer');

    const full = await call('find_events', { query: 'gym' });
    assert.equal(full.matches.length, 16, 'the default page holds an ordinary pile of duplicates');
    assert.equal(full.shown, full.total);
    assert.equal(full.advice, undefined);
    ok('a partial search says how much it is holding back');
  }
  {
    // All of them go in one call, and the calendar is actually clean after it.
    const ids = (await call('find_events', { query: 'gym' })).matches.map((m: { id: string }) => m.id);
    const out = await call('delete_events', { ids });
    assert.equal(out.deleted.length, 16);
    assert.deepEqual(s().events, [], 'nothing is left behind for a second round');
    ok('every duplicate goes in a single delete');
  }
  {
    // Five occurrence ids of one weekly series are five things on the grid and
    // one thing to delete. Reporting five would be a lie.
    useStore.setState({ events: [] });
    add('Standup', 3, 9, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    const week = await call('list_events', { start_date: '2026-08-03', end_date: '2026-08-07' });
    assert.equal(week.events.length, 5);

    const out = await call('delete_events', {
      ids: week.events.map((e: { id: string }) => e.id),
    });
    assert.equal(out.deleted.length, 1, 'one series, however many ids named it');
    assert.equal(out.deleted[0].removed, 'the whole repeating event');
    assert.ok(log.at(-1)?.includes('every repeat of it'), `said "${log.at(-1)}"`);
    assert.deepEqual(s().events, []);
    ok('occurrence ids of one series delete it once, and say so');
  }
  {
    // Expanding a repeat makes a wide range unbounded, so it has to be capped —
    // and a cap the model cannot see reads as "that is everything".
    useStore.setState({ events: [] });
    add('Daily thing', 1, 8, 'FREQ=DAILY');
    const wide = await call('list_events', { start_date: '2026-01-01', end_date: '2029-12-31' });
    assert.ok(wide.events.length <= 200, `capped, got ${wide.events.length}`);
    assert.ok(wide.truncated.matching > wide.truncated.shown);
    assert.ok(wide.truncated.advice.includes('partial'));

    const narrow = await call('list_events', { start_date: '2026-08-03', end_date: '2026-08-07' });
    assert.equal(narrow.events.length, 5);
    assert.equal(narrow.truncated, undefined, 'an ordinary week is never truncated');
    ok('a range too wide to answer whole says it is partial');
  }
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
