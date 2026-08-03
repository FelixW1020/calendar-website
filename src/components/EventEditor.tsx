import { useEffect, useRef, useState } from 'react';
import { calendarColor, useStore } from '../store';
import { format, parse, toLocalISO } from '../lib/dates';
import { Close, Trash } from './Icons';

/** ISO-with-offset → the value shape <input type="datetime-local"> expects. */
function toInput(iso: string, dateOnly = false): string {
  const d = parse(iso);
  return dateOnly ? format(d, 'yyyy-MM-dd') : format(d, "yyyy-MM-dd'T'HH:mm");
}

/** A meeting link should offer "Join", not a map lookup. */
function isLink(value: string): boolean {
  return /^(https?:\/\/|www\.)|\.(zoom\.us|meet\.google\.com|teams\.microsoft\.com)/i.test(value.trim());
}

function fromInput(value: string, endOfDay = false): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return toLocalISO(new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0));
  }
  return toLocalISO(new Date(value));
}

export default function EventEditor() {
  const id = useStore((s) => s.selectedEventId);
  const event = useStore((s) => s.events.find((e) => e.id === s.selectedEventId));
  const calendars = useStore((s) => s.calendars);
  const updateEvent = useStore((s) => s.updateEvent);
  const deleteEvent = useStore((s) => s.deleteEvent);
  const select = useStore((s) => s.select);

  const titleRef = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setConfirmDelete(false);
    if (event?.title === 'New event') {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [id, event?.title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select]);

  if (!event) return null;

  const color = calendarColor(calendars, event.calendarId);
  const set = (patch: Parameters<typeof updateEvent>[1]) => updateEvent(event.id, patch);

  const field =
    'w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm ' +
    'text-ink outline-none focus:border-line-strong focus:ring-1 focus:ring-line-strong';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 dark:bg-black/50" onClick={() => select(null)} />
      <div
        role="dialog"
        aria-label="Edit event"
        className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel shadow-2xl"
      >
        <div className="flex items-start gap-2 border-b border-line p-3">
          <span className="event-chip mt-2 h-3 w-3 shrink-0 rounded-full" style={{ background: color }} />
          <input
            ref={titleRef}
            value={event.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Add a title"
            className="min-w-0 flex-1 bg-transparent text-base font-medium text-ink outline-none placeholder:text-ink-faint"
          />
          <button
            onClick={() => select(null)}
            aria-label="Close"
            className="rounded p-1 text-ink-faint hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
          >
            <Close />
          </button>
        </div>

        <div className="space-y-3 p-3">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={event.allDay}
              onChange={(e) => set({ allDay: e.target.checked })}
              className="accent-accent"
            />
            All day
          </label>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Starts</div>
              <input
                type={event.allDay ? 'date' : 'datetime-local'}
                value={toInput(event.start, event.allDay)}
                onChange={(e) => e.target.value && set({ start: fromInput(e.target.value) })}
                className={field}
              />
            </div>
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Ends</div>
              <input
                type={event.allDay ? 'date' : 'datetime-local'}
                value={toInput(event.end, event.allDay)}
                onChange={(e) => e.target.value && set({ end: fromInput(e.target.value, event.allDay) })}
                className={field}
              />
            </div>
          </div>

          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Calendar</div>
            <select
              value={event.calendarId}
              onChange={(e) => set({ calendarId: e.target.value })}
              className={field}
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[11px] uppercase tracking-wider text-ink-faint">Location</span>
              {event.location?.trim() && !isLink(event.location) && (
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-ink-faint underline underline-offset-2 hover:text-ink"
                >
                  Open in Maps
                </a>
              )}
              {event.location && isLink(event.location) && (
                <a
                  href={event.location.startsWith('http') ? event.location : `https://${event.location}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-ink-faint underline underline-offset-2 hover:text-ink"
                >
                  Join
                </a>
              )}
            </div>
            <input
              value={event.location ?? ''}
              onChange={(e) => set({ location: e.target.value })}
              placeholder="Place, address, or meeting link"
              className={field}
            />
          </div>

          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Notes</div>
            <textarea
              value={event.description ?? ''}
              onChange={(e) => set({ description: e.target.value })}
              rows={3}
              placeholder="Optional"
              className={field + ' resize-y'}
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-line p-3">
          {confirmDelete ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ink-soft">Delete this event?</span>
              <button
                onClick={() => {
                  deleteEvent(event.id);
                  select(null);
                }}
                className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-md px-2 py-1 text-xs text-ink-soft hover:text-ink"
              >
                Keep
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-black/5 hover:text-red-600 dark:hover:bg-white/5"
            >
              <Trash className="h-3.5 w-3.5" />
              Delete
            </button>
          )}
          <button
            onClick={() => select(null)}
            className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-panel hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </>
  );
}
