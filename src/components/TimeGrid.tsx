import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CalendarEvent } from '../types';
import { calendarColor, useStore, visibleEvents } from '../store';
import {
  DAY_HEIGHT,
  HOUR_HEIGHT,
  SNAP_MINUTES,
  addMinutes,
  durationMinutes,
  eventsOn,
  format,
  isSameDay,
  minutesFromMidnight,
  parse,
  snap,
  startOfDay,
  toLocalISO,
} from '../lib/dates';
import { layoutDay, type PositionedEvent } from '../lib/layout';

interface Props {
  days: Date[];
}

type Draft = { id: string; start: Date; end: Date } | null;

type DragState =
  | null
  | {
      kind: 'move';
      id: string;
      grabOffsetMin: number;
      lengthMin: number;
      originX: number;
      originY: number;
    }
  | { kind: 'resize'; id: string; startMin: number; day: Date; originX: number; originY: number };

const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Pointer travel before a press turns into a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;

const MIN_BLOCK_HEIGHT = 18;

function hourLabel(h: number): string {
  if (h === 0) return '';
  const ampm = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display} ${ampm}`;
}

export default function TimeGrid({ days }: Props) {
  const events = useStore((s) => s.events);
  const calendars = useStore((s) => s.calendars);
  const selectedId = useStore((s) => s.selectedEventId);
  const select = useStore((s) => s.select);
  const createEvent = useStore((s) => s.createEvent);
  const updateEvent = useStore((s) => s.updateEvent);

  const shown = useMemo(() => visibleEvents(events, calendars), [events, calendars]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [now, setNow] = useState(() => new Date());

  // Set once a press crosses the drag threshold, so pointerup can tell a drag
  // from a click and avoid opening the editor on top of the drag.
  const movedRef = useRef(false);

  // Current-time line ticks once a minute; no need for anything finer.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Open on the working day rather than at midnight.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop === 0) el.scrollTop = 7.5 * HOUR_HEIGHT;
  }, []);

  const pointerToSlot = (e: { clientX: number; clientY: number }) => {
    const el = gridRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const width = rect.width / days.length;
    const idx = Math.max(0, Math.min(days.length - 1, Math.floor((e.clientX - rect.left) / width)));
    const y = Math.max(0, Math.min(DAY_HEIGHT, e.clientY - rect.top));
    return { dayIndex: idx, minutes: (y / HOUR_HEIGHT) * 60 };
  };

  /* ---------------------------------------------------------------- drag -- */

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent) => {
      if (!movedRef.current) {
        const far =
          Math.abs(e.clientX - drag.originX) > DRAG_THRESHOLD_PX ||
          Math.abs(e.clientY - drag.originY) > DRAG_THRESHOLD_PX;
        if (!far) return;
        movedRef.current = true;
      }

      const slot = pointerToSlot(e);
      if (!slot) return;

      if (drag.kind === 'move') {
        const startMin = Math.max(
          0,
          Math.min(24 * 60 - drag.lengthMin, snap(slot.minutes - drag.grabOffsetMin)),
        );
        const start = addMinutes(startOfDay(days[slot.dayIndex]), startMin);
        setDraft({ id: drag.id, start, end: addMinutes(start, drag.lengthMin) });
      } else {
        const endMin = Math.max(drag.startMin + SNAP_MINUTES, Math.min(24 * 60, snap(slot.minutes)));
        const base = startOfDay(drag.day);
        setDraft({ id: drag.id, start: addMinutes(base, drag.startMin), end: addMinutes(base, endMin) });
      }
    };

    const onUp = () => {
      setDraft((d) => {
        if (d && movedRef.current) {
          updateEvent(d.id, { start: toLocalISO(d.start), end: toLocalISO(d.end) });
        }
        return null;
      });
      setDrag(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // pointerToSlot is derived from days, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, days, updateEvent]);

  const beginMove = (e: React.PointerEvent, ev: CalendarEvent) => {
    if (ev.allDay || e.button !== 0) return;
    // On touch, a press on an event has to stay available for scrolling the
    // grid. Tap opens the editor instead; drag is a pointer-device gesture.
    if (e.pointerType === 'touch') return;
    e.stopPropagation();
    const slot = pointerToSlot(e);
    if (!slot) return;
    movedRef.current = false;
    setDrag({
      kind: 'move',
      id: ev.id,
      grabOffsetMin: slot.minutes - minutesFromMidnight(parse(ev.start)),
      lengthMin: durationMinutes(ev),
      originX: e.clientX,
      originY: e.clientY,
    });
  };

  const beginResize = (e: React.PointerEvent, ev: CalendarEvent, day: Date) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    e.stopPropagation();
    movedRef.current = false;
    setDrag({
      kind: 'resize',
      id: ev.id,
      startMin: minutesFromMidnight(parse(ev.start)),
      day,
      originX: e.clientX,
      originY: e.clientY,
    });
  };

  /* -------------------------------------------------------------- create -- */

  // Fired on click rather than pointerdown: a touch that turns into a scroll
  // never produces a click, so scrolling no longer creates stray events.
  const createAt = (e: React.MouseEvent, day: Date) => {
    if (e.button !== 0) return;
    const slot = pointerToSlot(e);
    if (!slot) return;
    const start = addMinutes(
      startOfDay(day),
      Math.max(0, Math.min(24 * 60 - 60, snap(slot.minutes))),
    );
    const ev = createEvent({
      title: 'New event',
      start: toLocalISO(start),
      end: toLocalISO(addMinutes(start, 60)),
      allDay: false,
      calendarId: calendars[0]?.id ?? 'personal',
    });
    select(ev.id);
  };

  /* -------------------------------------------------------------- render -- */

  // Laying out every column is the most expensive thing this component does;
  // a drag or a clock tick must not redo it.
  const columns = useMemo(
    () =>
      days.map((day) => {
        const onDay = eventsOn(shown, day);
        return {
          day,
          positioned: layoutDay(onDay, day),
          allDay: onDay.filter((e) => e.allDay),
        };
      }),
    [days, shown],
  );
  const hasAllDay = columns.some((c) => c.allDay.length > 0);
  const draggingEvent = draft ? shown.find((e) => e.id === draft.id) ?? null : null;

  const renderBlock = (p: PositionedEvent, isDraft: boolean) => {
    const ev = p.event;
    const color = calendarColor(calendars, ev.calendarId);
    const selected = selectedId === ev.id;
    const short = p.height < 34;
    const shownStart = isDraft && draft ? draft.start : parse(ev.start);

    return (
      <div
        key={ev.id + (isDraft ? '-draft' : '')}
        role="button"
        tabIndex={0}
        onPointerDown={(e) => beginMove(e, ev)}
        onClick={(e) => {
          e.stopPropagation();
          // Suppress the click that ends a drag.
          if (!movedRef.current) select(ev.id);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select(ev.id);
          }
        }}
        style={{
          top: p.top,
          height: p.height,
          left: `calc(${p.left * 100}% + 2px)`,
          width: `calc(${p.width * 100}% - 4px)`,
          background: color,
          boxShadow: selected
            ? '0 0 0 2px var(--color-canvas), 0 0 0 4px var(--color-ink-soft)'
            : undefined,
        }}
        className={
          'event-chip absolute cursor-grab overflow-hidden rounded-md px-1.5 py-0.5 text-white ' +
          'select-none transition-shadow active:cursor-grabbing ' +
          (isDraft ? 'z-20 opacity-90 shadow-lg' : 'z-10')
        }
      >
        <div className={'truncate text-xs font-medium' + (short ? ' leading-tight' : '')}>
          {ev.title}
        </div>
        {!short && (
          <div className="truncate text-[11px] opacity-85">
            {format(shownStart, 'h:mm a')}
            {ev.location ? ` · ${ev.location}` : ''}
          </div>
        )}
        <div
          onPointerDown={(e) => beginResize(e, ev, startOfDay(shownStart))}
          className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize"
        />
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Day headers */}
      <div className="flex shrink-0 border-b border-line pr-[10px]">
        <div className="w-11 shrink-0 sm:w-14" />
        {days.map((d) => {
          const today = isSameDay(d, now);
          return (
            <div key={d.toISOString()} className="flex-1 border-l border-line px-1 py-2 text-center">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                {format(d, 'EEE')}
              </div>
              <div
                className={
                  'mx-auto mt-1 flex h-9 w-9 items-center justify-center rounded-full text-xl ' +
                  (today ? 'bg-accent font-semibold text-white' : 'text-ink')
                }
              >
                {format(d, 'd')}
              </div>
            </div>
          );
        })}
      </div>

      {/* All-day strip */}
      {hasAllDay && (
        <div className="flex shrink-0 border-b border-line pr-[10px]">
          <div className="w-11 shrink-0 py-1 pr-2 text-right sm:w-14 text-[10px] uppercase tracking-wider text-ink-faint">
            All day
          </div>
          {columns.map(({ day: d, allDay }) => (
            <div key={d.toISOString()} className="min-h-8 flex-1 space-y-0.5 border-l border-line p-0.5">
              {allDay.map((ev) => (
                <button
                  key={ev.id}
                  onClick={() => select(ev.id)}
                  style={{ background: calendarColor(calendars, ev.calendarId) }}
                  className="event-chip block w-full truncate rounded px-1.5 py-0.5 text-left text-xs text-white"
                >
                  {ev.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Scrolling time grid */}
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
        <div className="flex">
          {/* Hour gutter */}
          <div className="w-11 shrink-0 sm:w-14">
            {HOURS.map((h) => (
              <div key={h} style={{ height: HOUR_HEIGHT }} className="relative">
                <span className="absolute -top-2 right-2 text-[11px] tabular-nums text-ink-faint">
                  {hourLabel(h)}
                </span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          <div ref={gridRef} className="relative flex flex-1" style={{ height: DAY_HEIGHT }}>
            {/* Hour lines, drawn once behind every column */}
            <div className="pointer-events-none absolute inset-0">
              {HOURS.map((h) => (
                <div
                  key={h}
                  style={{ top: h * HOUR_HEIGHT }}
                  className="absolute inset-x-0 border-t border-line"
                />
              ))}
            </div>

            {columns.map(({ day, positioned }) => {
              const today = isSameDay(day, now);

              // While dragging, the store still holds the original times, so
              // draw the dragged block from the draft and hide the stored one.
              const draftHere = draft && draggingEvent && isSameDay(draft.start, day);
              const draftBlock: PositionedEvent | null =
                draftHere && draft && draggingEvent
                  ? {
                      event: draggingEvent,
                      top: (minutesFromMidnight(draft.start) / 60) * HOUR_HEIGHT,
                      height: Math.max(
                        MIN_BLOCK_HEIGHT,
                        ((draft.end.getTime() - draft.start.getTime()) / 3_600_000) * HOUR_HEIGHT,
                      ),
                      left: 0,
                      width: 1,
                      continuesBefore: false,
                      continuesAfter: false,
                    }
                  : null;

              return (
                <div
                  key={day.toISOString()}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) createAt(e, day);
                  }}
                  className="relative flex-1 border-l border-line"
                >
                  {positioned
                    .filter((p) => !draft || p.event.id !== draft.id)
                    .map((p) => renderBlock(p, false))}

                  {draftBlock && renderBlock(draftBlock, true)}

                  {today && <NowLine now={now} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function NowLine({ now }: { now: Date }) {
  const top = (minutesFromMidnight(now) / 60) * HOUR_HEIGHT;
  return (
    <div className="pointer-events-none absolute inset-x-0 z-30" style={{ top }}>
      <div className="relative h-px bg-accent">
        <span className="absolute -left-1 -top-[3px] h-[7px] w-[7px] rounded-full bg-accent" />
      </div>
    </div>
  );
}
