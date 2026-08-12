import { useMemo } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type {
  Calendar,
  CalendarEvent,
  ChatMessage,
  EventRestore,
  PendingConfirmation,
  Subscription,
  ViewMode,
} from './types';
import { parse, toLocalISO } from './lib/dates';
import {
  WEEKDAYS,
  formatRule,
  masterOf,
  parseRule,
  resolveEvent,
  ruleEndingBefore,
  ruleStartingAt,
  type Rule,
  type SeriesScope,
} from './lib/recurrence';

export const PALETTE = [
  '#2b6cb0', // steel blue
  '#b05c34', // terracotta
  '#3f7a55', // moss
  '#8a4f7d', // plum
  '#a8842c', // ochre
  '#2c7a7b', // teal
  '#9c3d3d', // brick
  '#4a5568', // slate
] as const;

const DEFAULT_CALENDARS: Calendar[] = [
  { id: 'personal', name: 'Personal', color: PALETTE[0], visible: true },
  { id: 'work', name: 'Work', color: PALETTE[1], visible: true },
  { id: 'health', name: 'Health', color: PALETTE[2], visible: true },
];

export type NewEvent = Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'>;

function uid(): string {
  return crypto.randomUUID();
}

/* -------------------------------------------------------------------------- */
/* Local-change bus                                                           */
/* -------------------------------------------------------------------------- */

export type LocalChange =
  | { kind: 'event.upsert'; event: CalendarEvent }
  | { kind: 'event.delete'; id: string }
  | { kind: 'calendar.upsert'; calendar: Calendar }
  | { kind: 'calendar.delete'; id: string }
  // The address of a subscribed feed, not its contents: every device fetches
  // those for itself.
  | { kind: 'subscription.upsert'; subscription: Subscription }
  | { kind: 'subscription.delete'; id: string };

let changeHandler: ((c: LocalChange) => void) | null = null;

/**
 * The sync layer registers here. Kept as a callback rather than an import so
 * the store has no dependency on Supabase — without a handler the app is
 * exactly the local-only version.
 */
export function onLocalChange(handler: ((c: LocalChange) => void) | null): void {
  changeHandler = handler;
}

function emit(change: LocalChange): void {
  changeHandler?.(change);
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * localStorage.setItem is synchronous and serialises every event in the
 * calendar. Doing that inside the keystroke that triggered it is a main-thread
 * stall you can feel while typing, so writes are coalesced onto the next idle
 * moment instead. Reads stay synchronous — rehydration happens once, before
 * anything is queued.
 */
const WRITE_DELAY_MS = 400;

const writeQueue = new Map<string, string>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function flushWrites(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  for (const [key, value] of writeQueue) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      console.warn('[store] could not persist state', err);
    }
  }
  writeQueue.clear();
}

if (typeof window !== 'undefined') {
  // A queued write must survive the tab being closed or backgrounded —
  // pagehide is the one event iOS Safari reliably delivers.
  window.addEventListener('pagehide', flushWrites);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushWrites();
  });
}

const deferredStorage = {
  getItem: (name: string) => writeQueue.get(name) ?? localStorage.getItem(name),
  setItem: (name: string, value: string) => {
    writeQueue.set(name, value);
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flushWrites, WRITE_DELAY_MS);
  },
  removeItem: (name: string) => {
    writeQueue.delete(name);
    localStorage.removeItem(name);
  },
};

/* -------------------------------------------------------------------------- */
/* Series helpers                                                             */
/* -------------------------------------------------------------------------- */

/** The stored events that stand in for one occurrence of a series. */
function overridesOf(events: CalendarEvent[], masterId: string): CalendarEvent[] {
  return events.filter((e) => e.recurrenceId === masterId && e.originalStart);
}

/** Move an ISO timestamp by a number of milliseconds, keeping local wall time. */
function shift(iso: string, ms: number): string {
  return ms === 0 ? iso : toLocalISO(new Date(parse(iso).getTime() + ms));
}

/**
 * What a patch does to the occurrence it was applied to. Moving an event keeps
 * its length; resizing it keeps its start — the same two gestures the grid
 * offers.
 */
function retimed(
  occurrence: CalendarEvent,
  patch: Partial<NewEvent>,
): { start: Date; end: Date; delta: number } | null {
  if (patch.start === undefined && patch.end === undefined) return null;
  const oldStart = parse(occurrence.start);
  const length = parse(occurrence.end).getTime() - oldStart.getTime();
  const start = patch.start ? parse(patch.start) : oldStart;
  const end = patch.end ? parse(patch.end) : new Date(start.getTime() + length);
  return { start, end, delta: start.getTime() - oldStart.getTime() };
}

/**
 * A weekly rule names the days it lands on, so dragging an occurrence to
 * another weekday has to carry the rule with it — otherwise "every Monday"
 * would keep booking Mondays around an event that now happens on Tuesday.
 */
function retargetWeekday(rule: Rule, fromDay: number, toDay: number): Rule {
  if (rule.freq !== 'WEEKLY' || !rule.byDay?.length || fromDay === toDay) return rule;
  const from = WEEKDAYS[fromDay];
  const to = WEEKDAYS[toDay];
  if (!rule.byDay.includes(from) || rule.byDay.includes(to)) return rule;
  return { ...rule, byDay: rule.byDay.map((d) => (d === from ? to : d)) };
}

/**
 * What it would take to reverse a change, as the difference between two
 * snapshots of the calendar. Deleting one occurrence of a series *edits* the
 * master rather than removing a row, and "this and following" rewrites its
 * rule — so undo cannot simply put back what disappeared. Comparing before and
 * after catches every shape of it without knowing which one happened.
 */
export function diffEvents(before: CalendarEvent[], after: CalendarEvent[]): EventRestore {
  const now = new Map(after.map((e) => [e.id, e]));
  const had = new Set(before.map((e) => e.id));
  return {
    restore: before.filter((e) => {
      const current = now.get(e.id);
      return !current || JSON.stringify(current) !== JSON.stringify(e);
    }),
    remove: after.filter((e) => !had.has(e.id)).map((e) => e.id),
  };
}

/** Whether a diff would actually change anything. */
export function isEmptyRestore(r: EventRestore): boolean {
  return r.restore.length === 0 && r.remove.length === 0;
}

/** An event's own fields, ready to be re-created as a standalone row. */
function detach(ev: CalendarEvent): NewEvent {
  const { id: _id, createdAt: _c, updatedAt: _u, recurrence: _r, exdates: _x, ...rest } = ev;
  return rest;
}

export type SyncStatus = 'off' | 'signed-out' | 'syncing' | 'live' | 'error';

export interface SyncState {
  status: SyncStatus;
  email: string | null;
  message: string | null;
}

interface State {
  // Persisted
  events: CalendarEvent[];
  calendars: Calendar[];
  subscriptions: Subscription[];
  /**
   * The last copy fetched of each subscribed feed, by subscription id. Kept so
   * a cold start draws them before the network answers, and deliberately local:
   * these rows belong to the publisher, and every device can fetch its own.
   */
  feed: Record<string, CalendarEvent[]>;
  apiKey: string | null;
  theme: 'light' | 'dark';

  // Ephemeral
  view: ViewMode;
  anchor: string; // ISO date of the day the view is anchored on
  selectedEventId: string | null;
  chat: ChatMessage[];
  chatBusy: boolean;
  confirmation: PendingConfirmation | null;
  search: string;
  sync: SyncState;

  // Data actions
  createEvent: (e: NewEvent) => CalendarEvent;
  updateEvent: (id: string, patch: Partial<NewEvent>) => CalendarEvent | null;
  deleteEvent: (id: string) => CalendarEvent | null;

  // Series-aware. `id` may name an expanded occurrence, and `scope` says how
  // far the change reaches. Both fall back to the plain action off a series.
  updateEventScoped: (
    id: string,
    patch: Partial<NewEvent>,
    scope?: SeriesScope,
  ) => CalendarEvent | null;
  deleteEventScoped: (id: string, scope?: SeriesScope) => CalendarEvent | null;

  /** Reverse a change, from the diff of the two snapshots around it. */
  restoreEvents: (r: EventRestore) => void;

  addCalendar: (name: string, color: string) => Calendar;
  toggleCalendar: (id: string) => void;
  removeCalendar: (id: string) => void;

  /**
   * Subscribe to a published feed, and give it a calendar to live on. The id is
   * the caller's so it can parse the feed's events against it before committing
   * to a subscription that might not work — and `fetchedAt` says the copy it
   * already holds counts, so adding one does not immediately fetch it again.
   */
  addSubscription: (input: {
    id: string;
    url: string;
    name: string;
    color: string;
    useProxy: boolean;
    fetchedAt?: string;
  }) => Subscription;
  setSubscriptionProxy: (id: string, useProxy: boolean) => void;
  /** Refresh bookkeeping. Local to this device, so it never reaches the server. */
  setFeedStatus: (id: string, patch: { lastFetchedAt?: string; error: string | null }) => void;
  setFeedEvents: (id: string, events: CalendarEvent[]) => void;

  // Applied from the server; deliberately do not emit back to the sync layer.
  setSync: (patch: Partial<SyncState>) => void;
  replaceAll: (
    events: CalendarEvent[],
    calendars: Calendar[],
    subscriptions?: Subscription[],
  ) => void;
  applyRemote: (change: LocalChange) => void;

  // UI actions
  setView: (v: ViewMode) => void;
  setAnchor: (d: Date) => void;
  select: (id: string | null) => void;
  setApiKey: (k: string | null) => void;
  toggleTheme: () => void;
  setSearch: (q: string) => void;

  // Chat actions
  pushChat: (m: ChatMessage) => void;
  patchChat: (id: string, patch: Partial<ChatMessage>) => void;
  setChatBusy: (b: boolean) => void;
  clearChat: () => void;
  askConfirmation: (prompt: string) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      events: [],
      calendars: DEFAULT_CALENDARS,
      subscriptions: [],
      feed: {},
      apiKey: null,
      theme: 'light',

      // A 7-column week is unreadable on a phone; start those users on day view.
      view: typeof window !== 'undefined' && window.innerWidth < 640 ? 'day' : 'week',
      anchor: toLocalISO(new Date()),
      selectedEventId: null,
      chat: [],
      chatBusy: false,
      confirmation: null,
      search: '',
      sync: { status: 'off', email: null, message: null },

      createEvent: (e) => {
        const now = toLocalISO(new Date());
        const ev: CalendarEvent = { ...e, id: uid(), createdAt: now, updatedAt: now };
        set((s) => ({ events: [...s.events, ev] }));
        emit({ kind: 'event.upsert', event: ev });
        return ev;
      },

      updateEvent: (id, patch) => {
        let updated: CalendarEvent | null = null;
        set((s) => ({
          events: s.events.map((ev) => {
            if (ev.id !== id) return ev;
            updated = { ...ev, ...patch, updatedAt: toLocalISO(new Date()) };
            return updated;
          }),
        }));
        if (updated) emit({ kind: 'event.upsert', event: updated });
        return updated;
      },

      deleteEvent: (id) => {
        const found = get().events.find((e) => e.id === id) ?? null;
        if (found) {
          set((s) => ({ events: s.events.filter((e) => e.id !== id) }));
          emit({ kind: 'event.delete', id });
        }
        return found;
      },

      updateEventScoped: (id, patch, scope = 'all') => {
        const state = get();
        const target = resolveEvent(state.events, id);
        if (!target) return null;

        const master = masterOf(state.events, target);
        const rule = master ? parseRule(master.recurrence) : null;
        if (!master || !rule) return state.updateEvent(target.id, patch);

        const occStart = target.originalStart ?? target.start;
        const times = retimed(target, patch);
        const rulePatched = Object.prototype.hasOwnProperty.call(patch, 'recurrence');
        const overrides = overridesOf(state.events, master.id);
        const isStored = state.events.some((e) => e.id === target.id);

        // A rule change is a statement about the series, so it cannot land on a
        // single occurrence; the editor only offers the other two scopes, and
        // anything else asking for one gets the whole series instead.
        const reach: SeriesScope = scope === 'this' && rulePatched ? 'all' : scope;

        /* ------------------------------------------------------ this event -- */
        if (reach === 'this') {
          if (isStored && target.recurrenceId) return state.updateEvent(target.id, patch);
          return state.createEvent({
            ...detach(target),
            ...patch,
            recurrenceId: master.id,
            originalStart: occStart,
          });
        }

        /* ------------------------------- this and everything following it -- */
        const boundary = parse(occStart);
        const head = occStart === master.start ? null : ruleEndingBefore(master, rule, boundary);

        if (reach === 'following' && head) {
          const start = times?.start ?? parse(target.start);
          const end = times?.end ?? parse(target.end);
          const delta = times?.delta ?? 0;
          const exdates = master.exdates ?? [];

          state.updateEvent(master.id, {
            recurrence: formatRule(head.rule),
            exdates: exdates.filter((d) => parse(d) < boundary),
          });

          const tail = ruleStartingAt(rule, head.kept);
          const created = state.createEvent({
            ...detach(target),
            ...patch,
            start: toLocalISO(start),
            end: toLocalISO(end),
            recurrence: rulePatched
              ? patch.recurrence
              : formatRule(retargetWeekday(tail, boundary.getDay(), start.getDay())),
            exdates: exdates.filter((d) => parse(d) >= boundary).map((d) => shift(d, delta)),
            recurrenceId: undefined,
            originalStart: undefined,
          });

          // Occurrences the user had already edited by hand move across too.
          for (const o of overrides) {
            if (parse(o.originalStart!) < boundary) continue;
            state.updateEvent(o.id, {
              recurrenceId: created.id,
              start: shift(o.start, delta),
              end: shift(o.end, delta),
              originalStart: shift(o.originalStart!, delta),
            });
          }
          return created;
        }

        /* ------------------------------------------------------ all events -- */
        // Also the path for "following" from the first occurrence, where there
        // is nothing to split off.
        const masterPatch: Partial<NewEvent> = { ...patch };
        const delta = times?.delta ?? 0;

        if (times) {
          const start = new Date(parse(master.start).getTime() + delta);
          masterPatch.start = toLocalISO(start);
          masterPatch.end = toLocalISO(
            new Date(start.getTime() + (times.end.getTime() - times.start.getTime())),
          );
        }
        if (!rulePatched && delta !== 0) {
          const moved = retargetWeekday(rule, boundary.getDay(), times!.start.getDay());
          if (moved !== rule) masterPatch.recurrence = formatRule(moved);
        }
        if (delta !== 0 && master.exdates?.length) {
          masterPatch.exdates = master.exdates.map((d) => shift(d, delta));
        }
        if (rulePatched && !parseRule(patch.recurrence)) {
          // The series collapses to one ordinary event; its exceptions have
          // nothing left to be exceptions to.
          masterPatch.exdates = undefined;
          for (const o of overrides) state.deleteEvent(o.id);
        } else if (delta !== 0) {
          for (const o of overrides) {
            state.updateEvent(o.id, {
              start: shift(o.start, delta),
              end: shift(o.end, delta),
              originalStart: shift(o.originalStart!, delta),
            });
          }
        }
        return state.updateEvent(master.id, masterPatch);
      },

      deleteEventScoped: (id, scope = 'all') => {
        const state = get();
        const target = resolveEvent(state.events, id);
        if (!target) return null;

        const master = masterOf(state.events, target);
        const rule = master ? parseRule(master.recurrence) : null;
        if (!master || !rule) return state.deleteEvent(target.id);

        const occStart = target.originalStart ?? target.start;
        const overrides = overridesOf(state.events, master.id);

        if (scope === 'this') {
          // A hand-edited occurrence has a row of its own to remove, and the
          // slot it was standing in for still has to be blocked out.
          if (state.events.some((e) => e.id === target.id) && target.recurrenceId) {
            state.deleteEvent(target.id);
          }
          state.updateEvent(master.id, {
            exdates: [...new Set([...(master.exdates ?? []), occStart])],
          });
          return target;
        }

        const boundary = parse(occStart);
        const head = occStart === master.start ? null : ruleEndingBefore(master, rule, boundary);

        if (scope === 'following' && head) {
          state.updateEvent(master.id, {
            recurrence: formatRule(head.rule),
            exdates: (master.exdates ?? []).filter((d) => parse(d) < boundary),
          });
          for (const o of overrides) {
            if (parse(o.originalStart!) >= boundary) state.deleteEvent(o.id);
          }
          return target;
        }

        for (const o of overrides) state.deleteEvent(o.id);
        state.deleteEvent(master.id);
        return target;
      },

      restoreEvents: (r) => {
        // Sync resolves conflicts by last write, and the server is holding a
        // tombstone stamped after the row being put back. Restoring it with its
        // original timestamp would lose the race and delete it all over again
        // on the next merge, so a restore counts as a write of its own.
        const stamp = toLocalISO(new Date());
        // Snapshots are taken over the merged view, so a feed that refreshed
        // mid-turn could show up here. Putting one back would turn a borrowed
        // event into an owned one and sync it.
        const restored = r.restore
          .filter((e) => !e.readOnly)
          .map((e) => ({ ...e, updatedAt: stamp }));
        const gone = new Set(r.remove);
        const replaced = new Set(restored.map((e) => e.id));

        set((s) => ({
          events: [...s.events.filter((e) => !gone.has(e.id) && !replaced.has(e.id)), ...restored],
        }));

        for (const e of restored) emit({ kind: 'event.upsert', event: e });
        for (const id of r.remove) emit({ kind: 'event.delete', id });
      },

      addCalendar: (name, color) => {
        const cal: Calendar = { id: uid(), name, color, visible: true };
        set((s) => ({ calendars: [...s.calendars, cal] }));
        emit({ kind: 'calendar.upsert', calendar: cal });
        return cal;
      },

      toggleCalendar: (id) => {
        set((s) => ({
          calendars: s.calendars.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c)),
        }));
        const cal = get().calendars.find((c) => c.id === id);
        if (cal) emit({ kind: 'calendar.upsert', calendar: cal });
      },

      removeCalendar: (id) => {
        // Its events go too, and each needs its own tombstone so other devices
        // do not resurrect them.
        const orphaned = get().events.filter((e) => e.calendarId === id);
        const subscribed = get().subscriptions.some((s) => s.id === id);
        set((s) => {
          const { [id]: _dropped, ...feed } = s.feed;
          return {
            calendars: s.calendars.filter((c) => c.id !== id),
            events: s.events.filter((e) => e.calendarId !== id),
            subscriptions: s.subscriptions.filter((sub) => sub.id !== id),
            feed,
          };
        });
        for (const ev of orphaned) emit({ kind: 'event.delete', id: ev.id });
        // Cached feed events were never on the server, so there is nothing to
        // tombstone for them — only the subscription itself.
        if (subscribed) emit({ kind: 'subscription.delete', id });
        emit({ kind: 'calendar.delete', id });
      },

      addSubscription: ({ id, url, name, color, useProxy, fetchedAt }) => {
        const calendar: Calendar = { id, name, color, visible: true };
        const subscription: Subscription = {
          id,
          url,
          useProxy,
          lastFetchedAt: fetchedAt ?? null,
          error: null,
        };
        set((s) => ({
          calendars: [...s.calendars, calendar],
          subscriptions: [...s.subscriptions, subscription],
        }));
        emit({ kind: 'calendar.upsert', calendar });
        emit({ kind: 'subscription.upsert', subscription });
        return subscription;
      },

      setSubscriptionProxy: (id, useProxy) => {
        set((s) => ({
          subscriptions: s.subscriptions.map((sub) =>
            sub.id === id ? { ...sub, useProxy } : sub,
          ),
        }));
        const sub = get().subscriptions.find((s) => s.id === id);
        if (sub) emit({ kind: 'subscription.upsert', subscription: sub });
      },

      setFeedStatus: (id, patch) =>
        set((s) => ({
          subscriptions: s.subscriptions.map((sub) =>
            sub.id === id ? { ...sub, ...patch } : sub,
          ),
        })),

      setFeedEvents: (id, events) => set((s) => ({ feed: { ...s.feed, [id]: events } })),

      setSync: (patch) => set((s) => ({ sync: { ...s.sync, ...patch } })),

      replaceAll: (events, calendars, subscriptions) =>
        set(subscriptions ? { events, calendars, subscriptions } : { events, calendars }),

      applyRemote: (change) =>
        set((s) => {
          switch (change.kind) {
            case 'event.upsert': {
              const rest = s.events.filter((e) => e.id !== change.event.id);
              return { events: [...rest, change.event] };
            }
            case 'event.delete':
              return { events: s.events.filter((e) => e.id !== change.id) };
            case 'calendar.upsert': {
              const rest = s.calendars.filter((c) => c.id !== change.calendar.id);
              return { calendars: [...rest, change.calendar] };
            }
            case 'calendar.delete': {
              const { [change.id]: _dropped, ...feed } = s.feed;
              return {
                calendars: s.calendars.filter((c) => c.id !== change.id),
                events: s.events.filter((e) => e.calendarId !== change.id),
                subscriptions: s.subscriptions.filter((sub) => sub.id !== change.id),
                feed,
              };
            }
            case 'subscription.upsert': {
              const incoming = change.subscription;
              const mine = s.subscriptions.find((sub) => sub.id === incoming.id);
              // Refresh state is this device's own — a feed the other device
              // just fetched still has to be fetched here — but it belongs to
              // the address, so a repointed subscription starts over.
              const keepsCache = mine && mine.url === incoming.url;
              const merged: Subscription = keepsCache
                ? { ...incoming, lastFetchedAt: mine.lastFetchedAt, error: mine.error }
                : incoming;
              return {
                subscriptions: [...s.subscriptions.filter((sub) => sub.id !== merged.id), merged],
              };
            }
            case 'subscription.delete': {
              const { [change.id]: _dropped, ...feed } = s.feed;
              return { subscriptions: s.subscriptions.filter((sub) => sub.id !== change.id), feed };
            }
          }
        }),

      setView: (view) => set({ view }),
      setAnchor: (d) => set({ anchor: toLocalISO(d) }),
      select: (selectedEventId) => set({ selectedEventId }),
      setApiKey: (apiKey) => set({ apiKey }),
      toggleTheme: () => {
        const theme = get().theme === 'dark' ? 'light' : 'dark';
        document.documentElement.classList.toggle('dark', theme === 'dark');
        set({ theme });
      },
      setSearch: (search) => set({ search }),

      pushChat: (m) => set((s) => ({ chat: [...s.chat, m] })),
      patchChat: (id, patch) =>
        set((s) => ({ chat: s.chat.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
      setChatBusy: (chatBusy) => set({ chatBusy }),
      clearChat: () => set({ chat: [] }),

      askConfirmation: (prompt) =>
        new Promise<boolean>((resolve) => {
          set({ confirmation: { id: uid(), prompt, resolve } });
        }),

      resolveConfirmation: (ok) => {
        const c = get().confirmation;
        if (c) {
          c.resolve(ok);
          set({ confirmation: null });
        }
      },
    }),
    {
      name: 'calendar.state',
      version: 1,
      storage: createJSONStorage(() => deferredStorage),
      partialize: (s) => ({
        events: s.events,
        calendars: s.calendars,
        subscriptions: s.subscriptions,
        feed: s.feed,
        apiKey: s.apiKey,
        theme: s.theme,
      }),
    },
  ),
);

/** Events on visible calendars only. */
export function visibleEvents(events: CalendarEvent[], calendars: Calendar[]): CalendarEvent[] {
  const hidden = new Set(calendars.filter((c) => !c.visible).map((c) => c.id));
  return events.filter((e) => !hidden.has(e.calendarId));
}

/**
 * The user's own events plus the cached copy of every subscribed feed — what
 * the views draw and what the assistant reads. Feed events are read-only, and
 * only ever reach the store's mutations by way of a guard that turns them away.
 */
export function mergeFeeds(
  events: CalendarEvent[],
  feed: Record<string, CalendarEvent[]>,
): CalendarEvent[] {
  const feeds = Object.values(feed);
  if (feeds.length === 0) return events;
  return [...events, ...feeds.flat()];
}

/**
 * Selecting a freshly built array out of the store on every render would defeat
 * zustand's equality check, so the two halves are selected separately and joined
 * only when one of them actually changes.
 */
export function useAllEvents(): CalendarEvent[] {
  const events = useStore((s) => s.events);
  const feed = useStore((s) => s.feed);
  return useMemo(() => mergeFeeds(events, feed), [events, feed]);
}

/** Everything the app currently knows about, for callers outside React. */
export function allEvents(): CalendarEvent[] {
  const { events, feed } = useStore.getState();
  return mergeFeeds(events, feed);
}

/** The subscription a calendar is fed by, when it is fed by one. */
export function subscriptionFor(
  subscriptions: Subscription[],
  calendarId: string,
): Subscription | undefined {
  return subscriptions.find((s) => s.id === calendarId);
}

export function calendarColor(calendars: Calendar[], id: string): string {
  return calendars.find((c) => c.id === id)?.color ?? PALETTE[7];
}

export { uid };
