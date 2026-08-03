import type { CalendarEvent } from '../types';
import { HOUR_HEIGHT, minutesFromMidnight, parse, startOfDay, addDays } from './dates';

export interface PositionedEvent {
  event: CalendarEvent;
  top: number;
  height: number;
  /** Fractions of the column width, 0–1. */
  left: number;
  width: number;
  /** True when the event began before this day or ends after it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

const MIN_HEIGHT = 18;

/**
 * Google's column-packing behaviour: events that overlap in time form a
 * cluster, the cluster is split into as many columns as it needs, and each
 * event takes one column's width. Events that merely touch (one ends exactly
 * when the next begins) do not overlap and stay full width.
 */
export function layoutDay(events: CalendarEvent[], day: Date): PositionedEvent[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);

  const spans = events
    .filter((ev) => !ev.allDay)
    .map((ev) => {
      const s = parse(ev.start);
      const e = parse(ev.end);
      const clampedStart = s < dayStart ? dayStart : s;
      const clampedEnd = e > dayEnd ? dayEnd : e;
      return {
        event: ev,
        startMin: minutesFromMidnight(clampedStart),
        endMin: clampedEnd >= dayEnd ? 24 * 60 : minutesFromMidnight(clampedEnd),
        continuesBefore: s < dayStart,
        continuesAfter: e > dayEnd,
      };
    })
    .filter((s) => s.endMin > s.startMin)
    // Earliest first; on a tie the longer event takes the leftmost column,
    // which reads better than the reverse.
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  const out: PositionedEvent[] = [];

  let cluster: typeof spans = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    // Greedy column assignment: reuse the first column whose last event has
    // already finished.
    const columnEnds: number[] = [];
    const columnOf = new Map<string, number>();
    for (const span of cluster) {
      let col = columnEnds.findIndex((end) => end <= span.startMin);
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(span.endMin);
      } else {
        columnEnds[col] = span.endMin;
      }
      columnOf.set(span.event.id, col);
    }
    const cols = columnEnds.length;
    for (const span of cluster) {
      const col = columnOf.get(span.event.id) ?? 0;
      out.push({
        event: span.event,
        top: (span.startMin / 60) * HOUR_HEIGHT,
        height: Math.max(MIN_HEIGHT, ((span.endMin - span.startMin) / 60) * HOUR_HEIGHT),
        left: col / cols,
        width: 1 / cols,
        continuesBefore: span.continuesBefore,
        continuesAfter: span.continuesAfter,
      });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const span of spans) {
    if (cluster.length > 0 && span.startMin >= clusterEnd) flush();
    cluster.push(span);
    clusterEnd = Math.max(clusterEnd, span.endMin);
  }
  flush();

  return out;
}
