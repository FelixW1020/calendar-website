import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Calendar, CalendarEvent, ChatMessage, PendingConfirmation, ViewMode } from './types';
import { toLocalISO } from './lib/dates';

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
  | { kind: 'calendar.delete'; id: string };

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

  addCalendar: (name: string, color: string) => Calendar;
  toggleCalendar: (id: string) => void;
  removeCalendar: (id: string) => void;

  // Applied from the server; deliberately do not emit back to the sync layer.
  setSync: (patch: Partial<SyncState>) => void;
  replaceAll: (events: CalendarEvent[], calendars: Calendar[]) => void;
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
        set((s) => ({
          calendars: s.calendars.filter((c) => c.id !== id),
          events: s.events.filter((e) => e.calendarId !== id),
        }));
        for (const ev of orphaned) emit({ kind: 'event.delete', id: ev.id });
        emit({ kind: 'calendar.delete', id });
      },

      setSync: (patch) => set((s) => ({ sync: { ...s.sync, ...patch } })),

      replaceAll: (events, calendars) => set({ events, calendars }),

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
            case 'calendar.delete':
              return {
                calendars: s.calendars.filter((c) => c.id !== change.id),
                events: s.events.filter((e) => e.calendarId !== change.id),
              };
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
      partialize: (s) => ({
        events: s.events,
        calendars: s.calendars,
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

export function calendarColor(calendars: Calendar[], id: string): string {
  return calendars.find((c) => c.id === id)?.color ?? PALETTE[7];
}

export { uid };
