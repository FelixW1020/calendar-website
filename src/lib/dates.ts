import {
  addDays,
  addMinutes,
  differenceInMinutes,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import type { CalendarEvent, ViewMode } from '../types';

/** Sunday-first, matching Google Calendar's US default. */
export const WEEK_STARTS_ON = 0 as const;

export const HOUR_HEIGHT = 48;
export const DAY_HEIGHT = HOUR_HEIGHT * 24;

/** Snap granularity for drag/resize and for click-to-create. */
export const SNAP_MINUTES = 15;

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Serialize to ISO 8601 *with the local offset* rather than UTC. Keeping wall
 * time in the string means a stored event reads correctly in the file and
 * survives a round-trip through the model, which reasons about local time.
 */
export function toLocalISO(d: Date): string {
  const pad = (n: number, len = 2) => String(Math.abs(n)).padStart(len, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

export function parse(iso: string): Date {
  return new Date(iso);
}

/** The inclusive-start / exclusive-end range a view covers. */
export function visibleRange(anchor: Date, view: ViewMode): { start: Date; end: Date } {
  if (view === 'day') {
    return { start: startOfDay(anchor), end: addDays(startOfDay(anchor), 1) };
  }
  if (view === 'week') {
    const start = startOfWeek(anchor, { weekStartsOn: WEEK_STARTS_ON });
    return { start, end: addDays(start, 7) };
  }
  const start = startOfWeek(startOfMonth(anchor), { weekStartsOn: WEEK_STARTS_ON });
  // endOfWeek lands on 23:59:59.999, so normalise to midnight before stepping
  // past it — otherwise the exclusive end is a day late and the grid grows an
  // extra cell.
  const end = addDays(startOfDay(endOfWeek(endOfMonth(anchor), { weekStartsOn: WEEK_STARTS_ON })), 1);
  return { start, end };
}

export function daysIn(range: { start: Date; end: Date }): Date[] {
  const out: Date[] = [];
  for (let d = range.start; d < range.end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function rangeLabel(anchor: Date, view: ViewMode): string {
  if (view === 'day') return format(anchor, 'EEEE, MMMM d, yyyy');
  if (view === 'month') return format(anchor, 'MMMM yyyy');
  const { start, end } = visibleRange(anchor, 'week');
  const last = addDays(end, -1);
  if (start.getMonth() === last.getMonth()) {
    return `${format(start, 'MMMM d')} – ${format(last, 'd, yyyy')}`;
  }
  if (start.getFullYear() === last.getFullYear()) {
    return `${format(start, 'MMM d')} – ${format(last, 'MMM d, yyyy')}`;
  }
  return `${format(start, 'MMM d, yyyy')} – ${format(last, 'MMM d, yyyy')}`;
}

export function step(anchor: Date, view: ViewMode, dir: 1 | -1): Date {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  const d = new Date(anchor);
  d.setDate(1);
  d.setMonth(d.getMonth() + dir);
  return d;
}

/** Minutes from midnight, clamped into the day the event is being drawn on. */
export function minutesFromMidnight(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function occursOn(ev: CalendarEvent, day: Date): boolean {
  const s = parse(ev.start);
  const e = parse(ev.end);
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return s < dayEnd && e > dayStart;
}

export function eventsOn(events: CalendarEvent[], day: Date): CalendarEvent[] {
  return events.filter((ev) => occursOn(ev, day));
}

export function durationMinutes(ev: CalendarEvent): number {
  return Math.max(1, differenceInMinutes(parse(ev.end), parse(ev.start)));
}

export function snap(minutes: number): number {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

/** Pixel offset within a day column → a Date on that day. */
export function yToDate(day: Date, y: number): Date {
  const minutes = snap((y / HOUR_HEIGHT) * 60);
  return addMinutes(startOfDay(day), Math.max(0, Math.min(24 * 60 - SNAP_MINUTES, minutes)));
}

export function formatEventTime(ev: CalendarEvent): string {
  if (ev.allDay) return 'All day';
  const s = parse(ev.start);
  const e = parse(ev.end);
  const fmt = (d: Date) => (d.getMinutes() === 0 ? format(d, 'h a') : format(d, 'h:mm a'));
  return isSameDay(s, e) ? `${fmt(s)} – ${fmt(e)}` : `${format(s, 'MMM d, h:mm a')} – ${format(e, 'MMM d, h:mm a')}`;
}

export { addDays, addMinutes, format, isSameDay, startOfDay, startOfWeek };
