import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarEvent } from '../types';
import { calendarColor, useAllEvents, useStore, type NewEvent } from '../store';
import { format, formatEventTime, parse, toLocalISO } from '../lib/dates';
import { describeEvent, isSeriesEvent, masterOf, resolveEvent, type SeriesScope } from '../lib/recurrence';
import { Close, Link, Trash } from './Icons';
import LocationField from './LocationField';
import RecurrenceField from './RecurrenceField';
import ScopeDialog from './ScopeDialog';

/** ISO-with-offset → the value shape <input type="datetime-local"> expects. */
function toInput(iso: string, dateOnly = false): string {
  const d = parse(iso);
  return dateOnly ? format(d, 'yyyy-MM-dd') : format(d, "yyyy-MM-dd'T'HH:mm");
}

function fromInput(value: string, endOfDay = false): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return toLocalISO(new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0));
  }
  return toLocalISO(new Date(value));
}

/**
 * Everything the editor can change. Held locally while the dialog is open so a
 * keystroke costs one small re-render — writing to the store on every letter
 * re-laid-out the whole grid, rewrote localStorage and fired a Supabase upsert,
 * which is what made typing feel heavy.
 */
type Draft = Pick<
  CalendarEvent,
  'title' | 'start' | 'end' | 'allDay' | 'calendarId' | 'location' | 'place' | 'description' | 'recurrence'
>;

/** Long enough to coalesce a burst of typing, short enough to feel immediate. */
const COMMIT_MS = 300;

/** Empty and absent are the same thing for every field the editor writes. */
function equal(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === '' || v === undefined ? null : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function changesOf(baseline: Draft, draft: Draft): Partial<NewEvent> {
  const out: Partial<NewEvent> = {};
  for (const key of Object.keys(draft) as Array<keyof Draft>) {
    if (!equal(draft[key], baseline[key])) Object.assign(out, { [key]: draft[key] });
  }
  return out;
}

function initialDraft(
  event: CalendarEvent | null,
  master: CalendarEvent | null,
  fallbackCalendar: string,
): Draft {
  return {
    title: event?.title ?? '',
    start: event?.start ?? toLocalISO(new Date()),
    end: event?.end ?? toLocalISO(new Date()),
    allDay: event?.allDay ?? false,
    calendarId: event?.calendarId ?? fallbackCalendar,
    location: event?.location ?? '',
    place: event?.place,
    description: event?.description ?? '',
    // An edited occurrence carries no rule of its own; it still belongs to one.
    recurrence: event?.recurrence ?? master?.recurrence,
  };
}

export default function EventEditor() {
  // Subscribed feeds are included so their events can be opened and read; the
  // dialog switches to a read-only card for them rather than an editor.
  const events = useAllEvents();
  const selectedId = useStore((s) => s.selectedEventId);
  const calendars = useStore((s) => s.calendars);
  const updateEvent = useStore((s) => s.updateEvent);
  const updateEventScoped = useStore((s) => s.updateEventScoped);
  const deleteEvent = useStore((s) => s.deleteEvent);
  const deleteEventScoped = useStore((s) => s.deleteEventScoped);
  const select = useStore((s) => s.select);

  // The id may name an occurrence that has no row of its own.
  const event = useMemo(() => resolveEvent(events, selectedId), [events, selectedId]);
  const master = useMemo(() => (event ? masterOf(events, event) : null), [events, event]);

  const titleRef = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);

  /**
   * Whether this was already part of a series when the dialog opened. That is
   * what decides how edits are committed, so it is captured once: turning
   * repeat *on* mid-edit must not switch the dialog into series mode under the
   * user's hands.
   */
  const [series] = useState(() => Boolean(event && isSeriesEvent(event)));

  // Mounted with key={selectedEventId}, so these initialisers run once per event
  // and never have to be re-seeded. The baseline is what "changed" is measured
  // against when a series edit has to be committed all at once.
  const [baseline] = useState<Draft>(() =>
    initialDraft(event, master, calendars[0]?.id ?? 'personal'),
  );
  const [draft, setDraft] = useState<Draft>(baseline);

  const eventId = event?.id ?? null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<NewEvent>>({});

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    pending.current = {};
    if (eventId && Object.keys(patch).length > 0) updateEvent(eventId, patch);
  }, [eventId, updateEvent]);

  /**
   * Update what is on screen now. A one-off event writes through on a trailing
   * debounce, as it always has; an occurrence of a series cannot, because there
   * is no way to know yet whether the user means this one or all of them — so
   * it stays local until Save asks.
   */
  const set = useCallback(
    (patch: Partial<Draft>, immediate = false) => {
      setDraft((d) => ({ ...d, ...patch }));
      if (series) return;
      pending.current = { ...pending.current, ...patch };
      if (immediate) {
        flush();
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, COMMIT_MS);
    },
    [flush, series],
  );

  // Closing, switching events or navigating away must not drop the last few
  // characters typed.
  useEffect(() => {
    const onHide = () => flush();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flush();
    };
  }, [flush]);

  useEffect(() => {
    if (titleRef.current?.value === 'New event') {
      titleRef.current.focus();
      titleRef.current.select();
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select]);

  if (!event) return null;
  if (event.readOnly) return <SubscribedEvent event={event} onClose={() => select(null)} />;

  const changes = series ? changesOf(baseline, draft) : {};
  const ruleChanged = Object.prototype.hasOwnProperty.call(changes, 'recurrence');
  const dirty = Object.keys(changes).length > 0;

  const save = () => {
    if (!dirty) {
      select(null);
      return;
    }
    setConfirmSave(true);
  };

  const commit = (scope: SeriesScope) => {
    updateEventScoped(event.id, changes, scope);
    setConfirmSave(false);
    select(null);
  };

  const remove = (scope: SeriesScope) => {
    // Drop anything queued — it would resurrect the row.
    pending.current = {};
    if (timer.current) clearTimeout(timer.current);
    if (series) deleteEventScoped(event.id, scope);
    else deleteEvent(event.id);
    select(null);
  };

  const color = calendarColor(calendars, draft.calendarId);

  const field =
    'w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm ' +
    'text-ink outline-none focus:border-line-strong focus:ring-1 focus:ring-line-strong';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 dark:bg-black/50" onClick={() => select(null)} />
      <div
        role="dialog"
        aria-label="Edit event"
        className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-panel shadow-2xl"
      >
        <div className="flex items-start gap-2 border-b border-line p-3">
          <span className="event-chip mt-2 h-3 w-3 shrink-0 rounded-full" style={{ background: color }} />
          <input
            ref={titleRef}
            value={draft.title}
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
              checked={draft.allDay}
              onChange={(e) => set({ allDay: e.target.checked }, true)}
              className="accent-accent"
            />
            All day
          </label>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Starts</div>
              <input
                type={draft.allDay ? 'date' : 'datetime-local'}
                value={toInput(draft.start, draft.allDay)}
                onChange={(e) => e.target.value && set({ start: fromInput(e.target.value) })}
                className={field}
              />
            </div>
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Ends</div>
              <input
                type={draft.allDay ? 'date' : 'datetime-local'}
                value={toInput(draft.end, draft.allDay)}
                onChange={(e) => e.target.value && set({ end: fromInput(e.target.value, draft.allDay) })}
                className={field}
              />
            </div>
          </div>

          <RecurrenceField
            value={draft.recurrence}
            start={draft.start}
            onChange={(recurrence) => set({ recurrence }, true)}
            className={field}
          />

          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Calendar</div>
            <select
              value={draft.calendarId}
              onChange={(e) => set({ calendarId: e.target.value }, true)}
              className={field}
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <LocationField
            value={draft.location ?? ''}
            place={draft.place}
            onChange={(location, place) => set({ location, place })}
            className={field}
          />

          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Notes</div>
            <textarea
              value={draft.description ?? ''}
              onChange={(e) => set({ description: e.target.value })}
              rows={3}
              placeholder="Optional"
              className={field + ' resize-y'}
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-line p-3">
          {confirmDelete && !series ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ink-soft">Delete this event?</span>
              <button
                onClick={() => remove('all')}
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
            onClick={series ? save : () => select(null)}
            className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-panel hover:opacity-90"
          >
            {series ? (dirty ? 'Save' : 'Done') : 'Done'}
          </button>
        </div>
      </div>

      {series && confirmSave && (
        <ScopeDialog
          title="Save repeating event"
          action="Save"
          // Changing the rule itself is a statement about the whole series, so
          // there is no single-occurrence version of it.
          options={ruleChanged ? ['all', 'following'] : ['this', 'following', 'all']}
          note={ruleChanged ? 'Changing how often it repeats applies from a whole series.' : undefined}
          onConfirm={commit}
          onCancel={() => setConfirmSave(false)}
        />
      )}

      {series && confirmDelete && (
        <ScopeDialog
          title={`Delete "${event.title}"`}
          action="Delete"
          destructive
          options={['this', 'following', 'all']}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

/**
 * An event from a subscribed calendar. There is nothing to edit and nothing to
 * save, so this shows what the publisher said and says where it came from —
 * which is also the answer to "why can't I change this?".
 */
function SubscribedEvent({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  const calendars = useStore((s) => s.calendars);
  const calendar = calendars.find((c) => c.id === event.calendarId);
  const repeats = describeEvent(event);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 dark:bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-label={event.title}
        className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-panel shadow-2xl"
      >
        <div className="flex items-start gap-2 border-b border-line p-3">
          <span
            className="event-chip mt-1.5 h-3 w-3 shrink-0 rounded-full"
            style={{ background: calendarColor(calendars, event.calendarId) }}
          />
          <h2 className="min-w-0 flex-1 text-base font-medium text-ink">{event.title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-ink-faint hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
          >
            <Close />
          </button>
        </div>

        <div className="space-y-3 p-3 text-sm">
          <div className="text-ink">
            {format(parse(event.start), 'EEEE, MMMM d, yyyy')}
            <div className="text-ink-soft">{formatEventTime(event)}</div>
            {repeats && <div className="text-ink-faint">{repeats}</div>}
          </div>

          {event.location && (
            <div>
              <div className="mb-0.5 text-[11px] uppercase tracking-wider text-ink-faint">Where</div>
              <div className="text-ink-soft">{event.location}</div>
            </div>
          )}

          {event.description && (
            <div>
              <div className="mb-0.5 text-[11px] uppercase tracking-wider text-ink-faint">Notes</div>
              <div className="whitespace-pre-wrap break-words text-ink-soft">{event.description}</div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line p-3 text-[12px] text-ink-faint">
          <Link className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            From <span className="text-ink-soft">{calendar?.name ?? 'a subscribed calendar'}</span>,
            which is read here by link. Changes have to be made where it is published.
          </span>
        </div>
      </div>
    </>
  );
}
