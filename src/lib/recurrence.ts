import { addDays, addMonths, getDaysInMonth, startOfDay, startOfWeek } from 'date-fns';
import type { CalendarEvent } from '../types';
import { WEEK_STARTS_ON, parse, toLocalISO } from './dates';

/**
 * Recurring events, stored as one master event carrying an RFC 5545 RRULE and
 * expanded into occurrences at read time. Nothing is written to the calendar per
 * occurrence, so "every weekday forever" costs one row.
 *
 * Two things break the pure expansion, and both live on the master:
 *   - `exdates` — occurrences the user deleted.
 *   - override events — a real event with `recurrenceId` pointing back at the
 *     master and `originalStart` naming the occurrence it stands in for.
 *
 * Supported rule grammar is the useful subset: FREQ (DAILY/WEEKLY/MONTHLY/
 * YEARLY), INTERVAL, BYDAY (plain for weekly, ordinal for "the 2nd Tuesday"),
 * BYMONTHDAY, COUNT, UNTIL. UNTIL is written as a plain YYYYMMDD date and read
 * as "through the end of that day, local time" — this calendar keeps local wall
 * time everywhere else too, and a UTC instant would land on the wrong day for
 * anyone far enough east or west.
 */

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export type Weekday = 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';

export const WEEKDAYS: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const WEEKDAY_NAMES: Record<Weekday, string> = {
  SU: 'Sunday',
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
};

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

const FREQS: Freq[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

export interface Rule {
  freq: Freq;
  /** Every N days/weeks/months/years. Always ≥ 1. */
  interval: number;
  /** WEEKLY: which days of the week. Empty means "the day the series starts on". */
  byDay?: Weekday[];
  /** MONTHLY: the nth weekday of the month; nth of -1 means the last one. */
  byNthDay?: { nth: number; day: Weekday };
  /** MONTHLY: a fixed day of the month. Months without that day are skipped. */
  byMonthDay?: number;
  /** Ends after this many occurrences, counted from the first. */
  count?: number;
  /** Ends after this local date (inclusive), as YYYY-MM-DD. */
  until?: string;
}

/** How far an edit to one occurrence reaches. */
export type SeriesScope = 'this' | 'following' | 'all';

/** Guard rail: no single expansion may produce more than this many occurrences. */
const MAX_OCCURRENCES = 750;

/** Guard rail for rules that skip most of their candidate slots (Feb 30th). */
const MAX_STEPS = 5_000;

/* -------------------------------------------------------------------------- */
/* Rule text                                                                  */
/* -------------------------------------------------------------------------- */

export function parseRule(text?: string | null): Rule | null {
  if (!text) return null;
  const body = text.trim().replace(/^RRULE:/i, '');
  if (!body) return null;

  const parts = new Map<string, string>();
  for (const chunk of body.split(';')) {
    const eq = chunk.indexOf('=');
    if (eq > 0) parts.set(chunk.slice(0, eq).trim().toUpperCase(), chunk.slice(eq + 1).trim().toUpperCase());
  }

  const freq = parts.get('FREQ') as Freq | undefined;
  if (!freq || !FREQS.includes(freq)) return null;

  const interval = Number(parts.get('INTERVAL') ?? '1');
  const rule: Rule = { freq, interval: Number.isFinite(interval) ? Math.max(1, Math.floor(interval)) : 1 };

  const byDay = parts.get('BYDAY');
  if (byDay) {
    const plain: Weekday[] = [];
    for (const token of byDay.split(',')) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token.trim());
      if (!m) continue;
      if (m[1]) rule.byNthDay = { nth: Number(m[1]), day: m[2] as Weekday };
      else plain.push(m[2] as Weekday);
    }
    if (plain.length > 0) rule.byDay = dedupeDays(plain);
  }

  const byMonthDay = Number(parts.get('BYMONTHDAY')?.split(',')[0]);
  if (Number.isInteger(byMonthDay) && byMonthDay >= 1 && byMonthDay <= 31) rule.byMonthDay = byMonthDay;

  const count = Number(parts.get('COUNT'));
  if (Number.isFinite(count) && count >= 1) rule.count = Math.floor(count);

  const until = /^(\d{4})(\d{2})(\d{2})/.exec(parts.get('UNTIL') ?? '');
  if (until) rule.until = `${until[1]}-${until[2]}-${until[3]}`;

  return rule;
}

export function formatRule(rule: Rule): string {
  const out = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) out.push(`INTERVAL=${rule.interval}`);
  if (rule.freq === 'WEEKLY' && rule.byDay?.length) out.push(`BYDAY=${dedupeDays(rule.byDay).join(',')}`);
  if (rule.freq === 'MONTHLY') {
    if (rule.byNthDay) out.push(`BYDAY=${rule.byNthDay.nth}${rule.byNthDay.day}`);
    else if (rule.byMonthDay) out.push(`BYMONTHDAY=${rule.byMonthDay}`);
  }
  // COUNT and UNTIL are mutually exclusive in RFC 5545; COUNT wins here because
  // it is what the editor writes when the user picks "after N times".
  if (rule.count) out.push(`COUNT=${rule.count}`);
  else if (rule.until) out.push(`UNTIL=${rule.until.replace(/-/g, '')}`);
  return out.join(';');
}

function dedupeDays(days: Weekday[]): Weekday[] {
  return WEEKDAYS.filter((d) => days.includes(d));
}

/* -------------------------------------------------------------------------- */
/* Describing a rule                                                          */
/* -------------------------------------------------------------------------- */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function nthLabel(nth: number): string {
  return nth < 0 ? 'last' : ORDINALS[nth] ?? `${nth}th`;
}

/** Which occurrence of its weekday a date is within its month (1-5). */
export function weekOfMonth(d: Date): number {
  return Math.floor((d.getDate() - 1) / 7) + 1;
}

/** True when a date is the last of its weekday in the month. */
export function isLastWeekdayOfMonth(d: Date): boolean {
  return d.getDate() + 7 > getDaysInMonth(d);
}

/** Plain-English summary, e.g. "Every 2 weeks on Mon, Wed, until Sep 1, 2026". */
export function describeRule(rule: Rule, seed: Date): string {
  const every = rule.interval > 1 ? `Every ${rule.interval} ` : '';
  let base: string;

  switch (rule.freq) {
    case 'DAILY':
      base = rule.interval > 1 ? `${every}days` : 'Daily';
      break;
    case 'WEEKLY': {
      const days = rule.byDay?.length ? dedupeDays(rule.byDay) : [WEEKDAYS[seed.getDay()]];
      if (!rule.byDay?.length || days.length === 1) {
        base = `${rule.interval > 1 ? `${every}weeks` : 'Weekly'} on ${WEEKDAY_NAMES[days[0]]}`;
      } else if (isWeekdays(days)) {
        base = rule.interval > 1 ? `${every}weeks, Monday to Friday` : 'Every weekday';
      } else {
        const names = days.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(', ');
        base = `${rule.interval > 1 ? `${every}weeks` : 'Weekly'} on ${names}`;
      }
      break;
    }
    case 'MONTHLY': {
      const lead = rule.interval > 1 ? `${every}months` : 'Monthly';
      if (rule.byNthDay) {
        base = `${lead} on the ${nthLabel(rule.byNthDay.nth)} ${WEEKDAY_NAMES[rule.byNthDay.day]}`;
      } else {
        base = `${lead} on day ${rule.byMonthDay ?? seed.getDate()}`;
      }
      break;
    }
    case 'YEARLY':
      base = `${rule.interval > 1 ? `${every}years` : 'Annually'} on ${MONTH_NAMES[seed.getMonth()]} ${seed.getDate()}`;
      break;
  }

  if (rule.count) return `${base}, ${rule.count} time${rule.count === 1 ? '' : 's'}`;
  if (rule.until) {
    const [y, m, d] = rule.until.split('-').map(Number);
    return `${base}, until ${MONTH_NAMES[m - 1].slice(0, 3)} ${d}, ${y}`;
  }
  return base;
}

function isWeekdays(days: Weekday[]): boolean {
  return days.length === 5 && !days.includes('SA') && !days.includes('SU');
}

/** The summary for an event, or null when it does not repeat. */
export function describeEvent(ev: CalendarEvent): string | null {
  const rule = parseRule(ev.recurrence);
  return rule ? describeRule(rule, parse(ev.start)) : null;
}

/* -------------------------------------------------------------------------- */
/* Occurrence ids                                                             */
/* -------------------------------------------------------------------------- */

/**
 * An expanded occurrence is not a stored row, so it needs an id the rest of the
 * app can pass around — selecting it, dragging it, editing it. `~` never appears
 * in a uuid or in an ISO timestamp, so the two halves always come back apart.
 */
const SEP = '~';

export function occurrenceId(masterId: string, startISO: string): string {
  return `${masterId}${SEP}${startISO}`;
}

export function splitOccurrenceId(id: string): { masterId: string; startISO: string } | null {
  const at = id.indexOf(SEP);
  if (at < 0) return null;
  return { masterId: id.slice(0, at), startISO: id.slice(at + 1) };
}

export function isOccurrenceId(id: string): boolean {
  return id.includes(SEP);
}

/** True for a master, an expanded occurrence, or an edited single occurrence. */
export function isSeriesEvent(ev: CalendarEvent): boolean {
  return Boolean(ev.recurrence || ev.recurrenceId);
}

/* -------------------------------------------------------------------------- */
/* Expansion                                                                  */
/* -------------------------------------------------------------------------- */

function withTimeOf(day: Date, seed: Date): Date {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    seed.getHours(),
    seed.getMinutes(),
    seed.getSeconds(),
    0,
  );
}

function nthWeekdayOf(month: Date, nth: number, day: Weekday): Date | null {
  const wanted = WEEKDAYS.indexOf(day);
  const total = getDaysInMonth(month);
  if (nth < 0) {
    const last = new Date(month.getFullYear(), month.getMonth(), total);
    const back = (last.getDay() - wanted + 7) % 7;
    const date = total - back - (-nth - 1) * 7;
    return date >= 1 ? new Date(month.getFullYear(), month.getMonth(), date) : null;
  }
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const forward = (wanted - first.getDay() + 7) % 7;
  const date = 1 + forward + (nth - 1) * 7;
  return date <= total ? new Date(month.getFullYear(), month.getMonth(), date) : null;
}

/**
 * The candidate start(s) for step `n` of the rule. Weekly rules can produce
 * several (one per selected weekday); monthly and yearly ones can produce none
 * when the month has no such day — a rule on the 31st simply skips February,
 * which is what RFC 5545 asks for.
 */
function candidatesAt(seed: Date, rule: Rule, n: number): Date[] {
  switch (rule.freq) {
    case 'DAILY':
      return [addDays(seed, n * rule.interval)];

    case 'WEEKLY': {
      const days = rule.byDay?.length ? rule.byDay : [WEEKDAYS[seed.getDay()]];
      const week = addDays(startOfWeek(seed, { weekStartsOn: WEEK_STARTS_ON }), n * 7 * rule.interval);
      return dedupeDays(days)
        .map((d) => {
          const offset = (WEEKDAYS.indexOf(d) - WEEK_STARTS_ON + 7) % 7;
          return withTimeOf(addDays(week, offset), seed);
        })
        // A rule that starts mid-week does not reach backwards into it.
        .filter((d) => d >= seed);
    }

    case 'MONTHLY': {
      const month = addMonths(new Date(seed.getFullYear(), seed.getMonth(), 1), n * rule.interval);
      if (rule.byNthDay) {
        const hit = nthWeekdayOf(month, rule.byNthDay.nth, rule.byNthDay.day);
        return hit && hit >= startOfDay(seed) ? [withTimeOf(hit, seed)] : [];
      }
      const wanted = rule.byMonthDay ?? seed.getDate();
      if (wanted > getDaysInMonth(month)) return [];
      return [withTimeOf(new Date(month.getFullYear(), month.getMonth(), wanted), seed)];
    }

    case 'YEARLY': {
      const year = seed.getFullYear() + n * rule.interval;
      const candidate = new Date(year, seed.getMonth(), seed.getDate());
      // Feb 29 in a common year rolls into March; skip it rather than move it.
      if (candidate.getMonth() !== seed.getMonth()) return [];
      return [withTimeOf(candidate, seed)];
    }
  }
}

/** How many steps to skip before `from` can possibly be reached. */
function stepsBefore(seed: Date, rule: Rule, from: Date): number {
  if (from <= seed) return 0;
  const ms = from.getTime() - seed.getTime();
  const day = 86_400_000;
  let steps: number;
  switch (rule.freq) {
    case 'DAILY':
      steps = ms / day;
      break;
    case 'WEEKLY':
      steps = ms / (7 * day);
      break;
    case 'MONTHLY':
      steps = (from.getFullYear() - seed.getFullYear()) * 12 + (from.getMonth() - seed.getMonth());
      break;
    case 'YEARLY':
      steps = from.getFullYear() - seed.getFullYear();
      break;
  }
  // One step of slack, so a partially-elapsed period is never skipped.
  return Math.max(0, Math.floor(steps / rule.interval) - 1);
}

/**
 * Occurrence start times in `[from, to)`. `from` may be before the series
 * starts; occurrences never are.
 */
export function occurrenceStarts(seed: Date, rule: Rule, from: Date, to: Date): Date[] {
  const untilEnd = rule.until ? endOfLocalDay(rule.until) : null;
  const out: Date[] = [];

  // COUNT is counted from the first occurrence, so a capped series has to be
  // walked from the beginning. It is bounded by the count itself, so that is
  // cheap; an open-ended one skips straight to the range being drawn.
  let n = rule.count ? 0 : stepsBefore(seed, rule, from);
  let produced = rule.count ? 0 : -1;

  for (let steps = 0; steps < MAX_STEPS; steps++, n++) {
    const candidates = candidatesAt(seed, rule, n);
    let allPast = candidates.length > 0;

    for (const start of candidates) {
      if (start < seed) continue;
      if (untilEnd && start > untilEnd) return out;
      if (produced >= 0) {
        if (produced >= rule.count!) return out;
        produced++;
      }
      if (start >= to) {
        // Later weekdays in the same week may still be in range, so only a rule
        // that produces one candidate per step can stop here.
        if (candidates.length === 1) return out;
        continue;
      }
      allPast = false;
      if (start >= from) {
        out.push(start);
        if (out.length >= MAX_OCCURRENCES) return out;
      }
    }

    if (allPast && candidates.every((c) => c >= to)) return out;
  }
  return out;
}

function endOfLocalDay(dateOnly: string): Date {
  const [y, m, d] = dateOnly.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

function occurrenceOf(master: CalendarEvent, start: Date): CalendarEvent {
  const startISO = toLocalISO(start);
  const length = parse(master.end).getTime() - parse(master.start).getTime();
  return {
    ...master,
    id: occurrenceId(master.id, startISO),
    start: startISO,
    end: toLocalISO(new Date(start.getTime() + length)),
    // The occurrence knows which series it came from; only the master carries
    // the exception list.
    recurrenceId: master.id,
    originalStart: startISO,
    exdates: undefined,
  };
}

interface Series {
  masters: CalendarEvent[];
  /** `masterId|originalStart` → the event that replaces that occurrence. */
  overrides: Map<string, CalendarEvent>;
  plain: CalendarEvent[];
}

function split(events: CalendarEvent[]): Series {
  const masters: CalendarEvent[] = [];
  const overrides = new Map<string, CalendarEvent>();
  const plain: CalendarEvent[] = [];
  for (const ev of events) {
    if (ev.recurrenceId && ev.originalStart) overrides.set(`${ev.recurrenceId}|${ev.originalStart}`, ev);
    else if (parseRule(ev.recurrence)) masters.push(ev);
    else plain.push(ev);
  }
  return { masters, overrides, plain };
}

/**
 * Every event that touches `[from, to)`, with series expanded into occurrences.
 * The result is what the views draw; ids of expanded occurrences are synthetic,
 * so writes go back through the store's series-aware actions.
 */
export function expandEvents(events: CalendarEvent[], from: Date, to: Date): CalendarEvent[] {
  const { masters, overrides, plain } = split(events);
  const out = [...plain, ...overrides.values()];

  for (const master of masters) {
    const rule = parseRule(master.recurrence);
    if (!rule) continue;
    const length = Math.max(0, parse(master.end).getTime() - parse(master.start).getTime());
    // An event that started before the window can still run into it.
    const reach = new Date(from.getTime() - length);
    const skip = new Set(master.exdates ?? []);

    for (const start of occurrenceStarts(parse(master.start), rule, reach, to)) {
      const startISO = toLocalISO(start);
      if (skip.has(startISO)) continue;
      // An edited occurrence is already in `out` under its own id.
      if (overrides.has(`${master.id}|${startISO}`)) continue;
      out.push(occurrenceOf(master, start));
    }
  }
  return out;
}

/**
 * Rebuild a single event from an id that may name an expanded occurrence. The
 * editor and the search results both hold ids rather than events, and an
 * occurrence has no row of its own to look up.
 */
export function resolveEvent(events: CalendarEvent[], id: string | null): CalendarEvent | null {
  if (!id) return null;
  const direct = events.find((e) => e.id === id);
  if (direct) return direct;

  const split = splitOccurrenceId(id);
  if (!split) return null;
  const master = events.find((e) => e.id === split.masterId);
  if (!master || !parseRule(master.recurrence)) return null;

  const override = events.find(
    (e) => e.recurrenceId === master.id && e.originalStart === split.startISO,
  );
  if (override) return override;
  if ((master.exdates ?? []).includes(split.startISO)) return null;
  return occurrenceOf(master, parse(split.startISO));
}

/** The master a series event belongs to (itself, for a master). */
export function masterOf(events: CalendarEvent[], ev: CalendarEvent): CalendarEvent | null {
  if (ev.recurrenceId) return events.find((e) => e.id === ev.recurrenceId) ?? null;
  return parseRule(ev.recurrence) ? ev : null;
}

/**
 * The first occurrence at or after `after`, for showing a series in a list with
 * no date range of its own — search results, mainly. Falls back to the last
 * occurrence of a series that has already finished.
 */
export function nextOccurrence(master: CalendarEvent, after: Date): CalendarEvent | null {
  const rule = parseRule(master.recurrence);
  if (!rule) return null;
  const skip = new Set(master.exdates ?? []);
  const seed = parse(master.start);

  const ahead = occurrenceStarts(seed, rule, after, addYearsTo(after, 2)).filter(
    (d) => !skip.has(toLocalISO(d)),
  );
  if (ahead.length > 0) return occurrenceOf(master, ahead[0]);

  const behind = occurrenceStarts(seed, rule, seed, after).filter((d) => !skip.has(toLocalISO(d)));
  return behind.length > 0 ? occurrenceOf(master, behind[behind.length - 1]) : null;
}

function addYearsTo(d: Date, years: number): Date {
  return new Date(d.getFullYear() + years, d.getMonth(), d.getDate());
}

/* -------------------------------------------------------------------------- */
/* Splitting a series                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The rule for the part of a series before `boundary`, for "this and following"
 * edits. A COUNT is converted to the number of occurrences actually kept —
 * cheaper to be exact here than to reason about it later — and a rule with
 * nothing left before the boundary comes back as null.
 */
export function ruleEndingBefore(
  master: CalendarEvent,
  rule: Rule,
  boundary: Date,
): { rule: Rule; kept: number } | null {
  const seed = parse(master.start);
  const kept = occurrenceStarts(seed, rule, seed, boundary).length;
  if (kept === 0) return null;
  const truncated: Rule = { ...rule };
  delete truncated.until;
  delete truncated.count;
  if (rule.count) truncated.count = kept;
  else truncated.until = localDateKey(addDays(startOfDay(boundary), -1));
  return { rule: truncated, kept };
}

/** The rule for the part of a series from `boundary` on. */
export function ruleStartingAt(rule: Rule, keptBefore: number): Rule {
  const rest: Rule = { ...rule };
  if (rule.count) rest.count = Math.max(1, rule.count - keptBefore);
  return rest;
}

export function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
