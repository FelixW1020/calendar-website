import { useMemo, useState } from 'react';
import type { CalendarEvent } from '../types';
import { calendarColor, useAllEvents, useStore, visibleEvents } from '../store';
import { addDays, eventsOn, format, isSameDay, parse, startOfDay } from '../lib/dates';
import { expandEvents, isSeriesEvent } from '../lib/recurrence';
import { Repeat } from './Icons';

interface Props {
  days: Date[];
  anchorMonth: number;
}

const MAX_CHIPS = 3;

export default function MonthView({ days, anchorMonth }: Props) {
  const events = useAllEvents();
  const calendars = useStore((s) => s.calendars);
  const select = useStore((s) => s.select);
  const setAnchor = useStore((s) => s.setAnchor);
  const setView = useStore((s) => s.setView);

  // Repeating events are stored once and expanded over the grid on screen.
  const shown = useMemo(
    () =>
      expandEvents(
        visibleEvents(events, calendars),
        startOfDay(days[0]),
        addDays(startOfDay(days[days.length - 1]), 1),
      ),
    [events, calendars, days],
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const today = new Date();

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b border-line">
        {days.slice(0, 7).map((d) => (
          <div
            key={d.toISOString()}
            className="flex-1 py-2 text-center text-[11px] font-medium uppercase tracking-wider text-ink-faint"
          >
            {format(d, 'EEE')}
          </div>
        ))}
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex min-h-20 flex-1 sm:min-h-28 border-b border-line last:border-b-0">
            {week.map((day) => {
              const key = day.toDateString();
              const dayEvents = eventsOn(shown, day).sort((a, b) => {
                if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
                return a.start.localeCompare(b.start);
              });
              const outside = day.getMonth() !== anchorMonth;
              const isToday = isSameDay(day, today);
              const isOpen = expanded === key;
              const visible = isOpen ? dayEvents : dayEvents.slice(0, MAX_CHIPS);
              const overflow = dayEvents.length - visible.length;

              return (
                <div
                  key={key}
                  className={
                    'flex-1 border-l border-line p-1 first:border-l-0 ' +
                    (outside ? 'bg-black/[0.015] dark:bg-white/[0.015]' : '')
                  }
                >
                  <button
                    onClick={() => {
                      setAnchor(day);
                      setView('day');
                    }}
                    className={
                      'mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs ' +
                      (isToday
                        ? 'bg-accent font-semibold text-white'
                        : outside
                          ? 'text-ink-faint hover:bg-black/5 dark:hover:bg-white/5'
                          : 'text-ink-soft hover:bg-black/5 dark:hover:bg-white/5')
                    }
                  >
                    {format(day, 'd')}
                  </button>

                  <div className="space-y-0.5">
                    {visible.map((ev) => (
                      <Chip key={ev.id} event={ev} onSelect={() => select(ev.id)} />
                    ))}
                    {overflow > 0 && (
                      <button
                        onClick={() => setExpanded(key)}
                        className="w-full px-1 text-left text-[11px] text-ink-soft hover:text-ink"
                      >
                        +{overflow} more
                      </button>
                    )}
                    {isOpen && dayEvents.length > MAX_CHIPS && (
                      <button
                        onClick={() => setExpanded(null)}
                        className="w-full px-1 text-left text-[11px] text-ink-faint hover:text-ink"
                      >
                        show less
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Chip({ event, onSelect }: { event: CalendarEvent; onSelect: () => void }) {
  const calendars = useStore((s) => s.calendars);
  const color = calendarColor(calendars, event.calendarId);

  const repeats = isSeriesEvent(event);

  if (event.allDay) {
    return (
      <button
        onClick={onSelect}
        style={{ background: color }}
        className="event-chip flex w-full items-center gap-1 rounded px-1.5 py-[3px] text-left text-[11px] text-white"
      >
        {repeats && <Repeat className="h-2.5 w-2.5 shrink-0" />}
        <span className="truncate">{event.title}</span>
      </button>
    );
  }

  return (
    <button
      onClick={onSelect}
      className="flex w-full items-center gap-1.5 truncate rounded px-1 py-[2px] text-left text-[11px] hover:bg-black/5 dark:hover:bg-white/5"
    >
      <span className="event-chip h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="hidden shrink-0 tabular-nums text-ink-faint sm:inline">
        {format(parse(event.start), 'h:mm')}
      </span>
      <span className="truncate text-ink">{event.title}</span>
      {repeats && <Repeat className="ml-auto h-2.5 w-2.5 shrink-0 text-ink-faint" />}
    </button>
  );
}
