import { isAuthApiError, type RealtimeChannel, type Session } from '@supabase/supabase-js';
import type { Calendar, CalendarEvent, Subscription } from '../types';
import { onLocalChange, useStore, type LocalChange, type SyncState } from '../store';
import {
  supabase,
  syncConfigured,
  type CalendarRow,
  type EventRow,
  type SubscriptionRow,
} from './supabase';
import { parse, toLocalISO } from './dates';

/* -------------------------------------------------------------------------- */
/* Row <-> model                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Stored as timestamptz (an instant), rendered back in whatever timezone the
 * device is in. That is the right call for syncing across devices, and it is
 * why the client keeps local-offset ISO rather than bare wall time.
 */
function rowToEvent(r: EventRow): CalendarEvent {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    location: r.location ?? undefined,
    place:
      r.place_lat != null && r.place_lon != null
        ? { lat: r.place_lat, lon: r.place_lon, label: r.place_label ?? r.location ?? '' }
        : undefined,
    start: toLocalISO(new Date(r.starts_at)),
    end: toLocalISO(new Date(r.ends_at)),
    allDay: r.all_day,
    calendarId: r.calendar_id,
    recurrence: r.recurrence ?? undefined,
    // Occurrence keys are wall-time strings rather than instants: they identify
    // a slot in the rule, not a point on the timeline, so they travel verbatim.
    exdates: r.exdates?.length ? r.exdates : undefined,
    recurrenceId: r.recurrence_id ?? undefined,
    originalStart: r.original_start ?? undefined,
    createdAt: toLocalISO(new Date(r.created_at)),
    updatedAt: toLocalISO(new Date(r.updated_at)),
  };
}

function eventToRow(e: CalendarEvent, userId: string) {
  return {
    id: e.id,
    user_id: userId,
    calendar_id: e.calendarId,
    title: e.title,
    description: e.description ?? null,
    location: e.location ?? null,
    place_lat: e.place?.lat ?? null,
    place_lon: e.place?.lon ?? null,
    place_label: e.place?.label ?? null,
    starts_at: parse(e.start).toISOString(),
    ends_at: parse(e.end).toISOString(),
    all_day: e.allDay,
    recurrence: e.recurrence ?? null,
    exdates: e.exdates?.length ? e.exdates : null,
    recurrence_id: e.recurrenceId ?? null,
    original_start: e.originalStart ?? null,
    created_at: parse(e.createdAt).toISOString(),
    updated_at: parse(e.updatedAt).toISOString(),
    deleted_at: null,
  };
}

function rowToCalendar(r: CalendarRow): Calendar {
  return { id: r.id, name: r.name, color: r.color, visible: r.visible };
}

function calendarToRow(c: Calendar, userId: string) {
  return {
    id: c.id,
    user_id: userId,
    name: c.name,
    color: c.color,
    visible: c.visible,
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
}

/**
 * Only the address crosses the wire. When and whether this device last managed
 * to read the feed is its own business — a laptop that has been shut for a week
 * has to refetch whatever the phone did this morning.
 */
function rowToSubscription(r: SubscriptionRow): Subscription {
  return { id: r.id, url: r.url, useProxy: r.use_proxy, lastFetchedAt: null, error: null };
}

function subscriptionToRow(s: Subscription, userId: string) {
  return {
    id: s.id,
    user_id: userId,
    url: s.url,
    use_proxy: s.useProxy,
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                     */
/* -------------------------------------------------------------------------- */

let channel: RealtimeChannel | null = null;
let userId: string | null = null;

const setSync = (patch: Partial<SyncState>) => useStore.getState().setSync(patch);

function fail(where: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sync] ${where}:`, error);
  setSync({ status: 'error', message: `${where}: ${message}` });
}

/**
 * Pull everything, reconcile against what is on this device, then push back
 * whatever the server is missing or has an older copy of.
 *
 * Reconciliation is last-write-wins on `updated_at`, with tombstones counted as
 * writes — so a delete on one device beats an older edit on another.
 */
async function mergeOnSignIn(uid: string): Promise<void> {
  if (!supabase) return;
  setSync({ status: 'syncing', message: null });

  const [
    { data: eventRows, error: eErr },
    { data: calRows, error: cErr },
    { data: subRows, error: sErr },
  ] = await Promise.all([
    supabase.from('events').select('*').eq('user_id', uid),
    supabase.from('calendars').select('*').eq('user_id', uid),
    supabase.from('subscriptions').select('*').eq('user_id', uid),
  ]);
  if (eErr) return fail('loading events', eErr);
  if (cErr) return fail('loading calendars', cErr);
  // An older database has no subscriptions table. Everything else still syncs;
  // subscribed calendars simply stay on the device that added them.
  if (sErr) console.warn('[sync] subscriptions are not set up on the server:', sErr.message);

  const local = useStore.getState();
  const localEvents = new Map(local.events.map((e) => [e.id, e]));
  const localCals = new Map(local.calendars.map((c) => [c.id, c]));

  const mergedEvents = new Map(localEvents);
  const toPushEvents: CalendarEvent[] = [];

  for (const row of (eventRows ?? []) as EventRow[]) {
    const mine = localEvents.get(row.id);
    if (row.deleted_at) {
      // Server says deleted. Keep it only if this device edited it afterwards.
      if (mine && parse(mine.updatedAt) > new Date(row.deleted_at)) {
        toPushEvents.push(mine);
      } else {
        mergedEvents.delete(row.id);
      }
      continue;
    }
    const theirs = rowToEvent(row);
    if (!mine || parse(theirs.updatedAt) >= parse(mine.updatedAt)) {
      mergedEvents.set(row.id, theirs);
    } else {
      toPushEvents.push(mine);
    }
  }
  // Anything this device has that the server has never seen.
  const seen = new Set((eventRows ?? []).map((r) => (r as EventRow).id));
  for (const e of local.events) if (!seen.has(e.id)) toPushEvents.push(e);

  const mergedCals = new Map(localCals);
  const toPushCals: Calendar[] = [];
  for (const row of (calRows ?? []) as CalendarRow[]) {
    if (row.deleted_at) {
      mergedCals.delete(row.id);
      continue;
    }
    mergedCals.set(row.id, rowToCalendar(row));
  }
  const seenCals = new Set((calRows ?? []).map((r) => (r as CalendarRow).id));
  for (const c of local.calendars) if (!seenCals.has(c.id)) toPushCals.push(c);

  // Subscriptions carry no per-device state worth reconciling, so the server's
  // copy simply wins and anything it has never seen goes up.
  const mergedSubs = new Map(local.subscriptions.map((s) => [s.id, s]));
  const toPushSubs: Subscription[] = [];
  for (const row of (subRows ?? []) as SubscriptionRow[]) {
    if (row.deleted_at) {
      mergedSubs.delete(row.id);
      continue;
    }
    const mine = mergedSubs.get(row.id);
    const theirs = rowToSubscription(row);
    // Nothing changed for this device unless the address itself did, so the
    // cached copy stays valid and does not need refetching.
    mergedSubs.set(
      row.id,
      mine && mine.url === theirs.url
        ? { ...theirs, lastFetchedAt: mine.lastFetchedAt, error: mine.error }
        : theirs,
    );
  }
  const seenSubs = new Set((subRows ?? []).map((r) => (r as SubscriptionRow).id));
  for (const s of local.subscriptions) if (!seenSubs.has(s.id)) toPushSubs.push(s);

  // A calendar must exist before events can reference it.
  if (toPushCals.length > 0) {
    const { error } = await supabase
      .from('calendars')
      .upsert(toPushCals.map((c) => calendarToRow(c, uid)));
    if (error) return fail('uploading calendars', error);
  }
  if (toPushEvents.length > 0) {
    const { error } = await supabase
      .from('events')
      .upsert(toPushEvents.map((e) => eventToRow(e, uid)));
    if (error) return fail('uploading events', error);
  }
  if (toPushSubs.length > 0 && !sErr) {
    const { error } = await supabase
      .from('subscriptions')
      .upsert(toPushSubs.map((s) => subscriptionToRow(s, uid)));
    if (error) return fail('uploading subscribed calendars', error);
  }

  useStore
    .getState()
    .replaceAll([...mergedEvents.values()], [...mergedCals.values()], [...mergedSubs.values()]);
  setSync({ status: 'live', message: null });
}

/* -------------------------------------------------------------------------- */
/* Outbound queue                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Edits arrive faster than the network should be asked to keep up with — a
 * dragged event fires on every pointer move. Changes are therefore coalesced
 * per row (the last one wins; a delete beats the edit before it) and sent after
 * a short quiet period.
 */
const QUIET_MS = 500;
/** Never sit on a change longer than this, however busy the user is. */
const MAX_WAIT_MS = 2_500;

const outbox = new Map<string, LocalChange>();
let queueTimer: ReturnType<typeof setTimeout> | null = null;
let oldestQueuedAt = 0;

function keyOf(change: LocalChange): string {
  switch (change.kind) {
    case 'event.upsert':
      return `event:${change.event.id}`;
    case 'event.delete':
      return `event:${change.id}`;
    case 'calendar.upsert':
      return `calendar:${change.calendar.id}`;
    case 'calendar.delete':
      return `calendar:${change.id}`;
    case 'subscription.upsert':
      return `subscription:${change.subscription.id}`;
    case 'subscription.delete':
      return `subscription:${change.id}`;
  }
}

function flushOutbox(): void {
  if (queueTimer) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }
  oldestQueuedAt = 0;
  // Calendars first: an event that names a calendar created in the same batch
  // should not reach the server ahead of it.
  const batch = [...outbox.values()].sort(
    (a, b) => Number(a.kind.startsWith('event')) - Number(b.kind.startsWith('event')),
  );
  outbox.clear();
  for (const change of batch) void push(change);
}

function enqueue(change: LocalChange): void {
  outbox.set(keyOf(change), change);
  const now = Date.now();
  if (oldestQueuedAt === 0) oldestQueuedAt = now;
  if (now - oldestQueuedAt >= MAX_WAIT_MS) {
    flushOutbox();
    return;
  }
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = setTimeout(flushOutbox, QUIET_MS);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushOutbox);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOutbox();
  });
}

/**
 * Our own writes come back over the realtime channel. Replacing the row we just
 * sent with an identical copy only costs a re-render, so each push records what
 * it wrote and the subscription skips the echo.
 *
 * Keyed by table as well as id: a subscribed calendar has a row in `calendars`
 * and a row in `subscriptions` under the same id, and one would otherwise
 * swallow the other's echo.
 */
const echoes = new Map<string, string>();

function isEcho(table: string, id: string, updatedAt: string | null): boolean {
  const key = `${table}:${id}`;
  if (!updatedAt || echoes.get(key) !== updatedAt) return false;
  echoes.delete(key);
  return true;
}

/** Write a single local change straight through to the server. */
async function push(change: LocalChange): Promise<void> {
  if (!supabase || !userId) return;
  const uid = userId;
  try {
    switch (change.kind) {
      case 'event.upsert': {
        const row = eventToRow(change.event, uid);
        echoes.set(`events:${row.id}`, row.updated_at);
        const { error } = await supabase.from('events').upsert(row);
        if (error) throw error;
        break;
      }
      case 'event.delete': {
        // Tombstone rather than delete, so other devices learn about it.
        const stamp = new Date().toISOString();
        echoes.set(`events:${change.id}`, stamp);
        const { error } = await supabase
          .from('events')
          .update({ deleted_at: stamp, updated_at: stamp })
          .eq('user_id', uid)
          .eq('id', change.id);
        if (error) throw error;
        break;
      }
      case 'calendar.upsert': {
        const row = calendarToRow(change.calendar, uid);
        echoes.set(`calendars:${row.id}`, row.updated_at);
        const { error } = await supabase.from('calendars').upsert(row);
        if (error) throw error;
        break;
      }
      case 'calendar.delete': {
        const stamp = new Date().toISOString();
        echoes.set(`calendars:${change.id}`, stamp);
        const { error } = await supabase
          .from('calendars')
          .update({ deleted_at: stamp, updated_at: stamp })
          .eq('user_id', uid)
          .eq('id', change.id);
        if (error) throw error;
        break;
      }
      case 'subscription.upsert': {
        const row = subscriptionToRow(change.subscription, uid);
        echoes.set(`subscriptions:${row.id}`, row.updated_at);
        const { error } = await supabase.from('subscriptions').upsert(row);
        if (error) throw error;
        break;
      }
      case 'subscription.delete': {
        const stamp = new Date().toISOString();
        echoes.set(`subscriptions:${change.id}`, stamp);
        const { error } = await supabase
          .from('subscriptions')
          .update({ deleted_at: stamp, updated_at: stamp })
          .eq('user_id', uid)
          .eq('id', change.id);
        if (error) throw error;
        break;
      }
    }
    const { status } = useStore.getState().sync;
    if (status === 'error') setSync({ status: 'live', message: null });
  } catch (err) {
    fail('saving', err);
  }
}

/** Live updates from this user's other devices. */
function subscribe(uid: string): void {
  if (!supabase) return;
  channel?.unsubscribe();
  channel = supabase
    .channel('calendar-sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'events', filter: `user_id=eq.${uid}` },
      (payload) => {
        const row = payload.new as EventRow | null;
        if (!row?.id || isEcho('events', row.id, row.updated_at)) return;
        useStore
          .getState()
          .applyRemote(
            row.deleted_at
              ? { kind: 'event.delete', id: row.id }
              : { kind: 'event.upsert', event: rowToEvent(row) },
          );
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'calendars', filter: `user_id=eq.${uid}` },
      (payload) => {
        const row = payload.new as CalendarRow | null;
        if (!row?.id || isEcho('calendars', row.id, row.updated_at)) return;
        useStore
          .getState()
          .applyRemote(
            row.deleted_at
              ? { kind: 'calendar.delete', id: row.id }
              : { kind: 'calendar.upsert', calendar: rowToCalendar(row) },
          );
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'subscriptions', filter: `user_id=eq.${uid}` },
      (payload) => {
        const row = payload.new as SubscriptionRow | null;
        if (!row?.id || isEcho('subscriptions', row.id, row.updated_at)) return;
        useStore
          .getState()
          .applyRemote(
            row.deleted_at
              ? { kind: 'subscription.delete', id: row.id }
              : { kind: 'subscription.upsert', subscription: rowToSubscription(row) },
          );
      },
    )
    .subscribe();
}

/**
 * Runs on every auth event. The access token is refreshed roughly hourly, and
 * `INITIAL_SESSION` races the explicit `getSession()` below, so this has to be
 * idempotent: only a genuine change of user re-merges and re-subscribes.
 * `userId` is assigned before the first await so a concurrent call bails.
 */
async function onSession(session: Session | null): Promise<void> {
  const nextId = session?.user?.id ?? null;

  if (nextId === userId) {
    // Same user — a token refresh or a duplicate event. Nothing to redo.
    if (session?.user) setSync({ email: session.user.email ?? null });
    return;
  }

  userId = nextId;

  if (session?.user) {
    setSync({ email: session.user.email ?? null });
    onLocalChange(enqueue);
    await mergeOnSignIn(session.user.id);
    subscribe(session.user.id);
  } else {
    onLocalChange(null);
    // Anything still queued belongs to the account that just left.
    outbox.clear();
    echoes.clear();
    channel?.unsubscribe();
    channel = null;
    setSync({ status: 'signed-out', email: null, message: null });
  }
}

/** Called once at startup. No-op when Supabase is not configured. */
export function initSync(): () => void {
  if (!syncConfigured || !supabase) {
    useStore.getState().setSync({ status: 'off', email: null, message: null });
    return () => {};
  }

  const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
    // A refresh that cannot be completed is the one case where a signed-in
    // user silently drops to local-only. Say so instead of failing quietly.
    if (event === 'TOKEN_REFRESHED' && !session) {
      setSync({ status: 'error', message: 'Session expired — sign in again to resume syncing.' });
      return;
    }
    void onSession(session);
  });

  // Belt and braces: if the stored session is restored before the listener is
  // attached, this picks it up. onSession dedupes the overlap.
  void supabase.auth.getSession().then(({ data }) => onSession(data.session));

  return () => {
    sub.subscription.unsubscribe();
    channel?.unsubscribe();
  };
}

/**
 * Raised when an address has no account on this deployment.
 *
 * Its own type because it is not a failure: the site is published for anyone to
 * use, but the database behind it belongs to one person. The dialog explains
 * that, where Supabase's own wording ("Signups not allowed for otp") reads like
 * something is broken.
 */
export class SyncNotOfferedError extends Error {
  constructor() {
    super('This deployment syncs one account.');
    this.name = 'SyncNotOfferedError';
  }
}

/**
 * How Supabase says "no account here, and I am not creating one". Which of the
 * three comes back depends on whether the refusal is the request's doing
 * (`shouldCreateUser` below) or the project's sign-up switch.
 */
const NO_ACCOUNT_CODES = new Set(['otp_disabled', 'signup_disabled', 'user_not_found']);

export async function signIn(email: string): Promise<void> {
  if (!supabase) throw new Error('Sync is not configured.');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.href,
      /**
       * The build is public; the Supabase project behind it is not shared. Left
       * to itself, `signInWithOtp` creates an account for whoever asks, so
       * anyone who found the URL could put their calendar in someone else's
       * database. Turning sign-ups off in the dashboard is the half that
       * actually enforces this — anyone can edit the flag out of the bundle —
       * and this half is what lets the UI say so honestly instead of promising
       * an email that will never arrive.
       */
      shouldCreateUser: false,
    },
  });
  if (!error) return;
  if (isAuthApiError(error) && NO_ACCOUNT_CODES.has(error.code ?? '')) {
    throw new SyncNotOfferedError();
  }
  throw error;
}

/** Supabase's minimum is 6; a password typed roughly once per device can afford more. */
export const MIN_PASSWORD_LENGTH = 8;

/** The address and password together match no account here. */
export class BadCredentialsError extends Error {
  constructor() {
    super('That email and password do not match an account.');
    this.name = 'BadCredentialsError';
  }
}

/**
 * Sign in with a password instead of an emailed link.
 *
 * The same account and the same session — what it saves is leaving the app to
 * read an inbox, which is most of the friction of signing in on a phone. The
 * check happens on Supabase's side, which is what makes it a lock rather than a
 * suggestion: a code compared in the browser is readable by anyone who opens
 * the page, and a limit on attempts kept in the browser resets on reload.
 */
export async function signInWithPassword(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error('Sync is not configured.');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error) return;
  if (isAuthApiError(error) && error.code === 'invalid_credentials') {
    throw new BadCredentialsError();
  }
  throw error;
}

/**
 * Give the signed-in account a password, or replace the one it has. Only
 * reachable while signed in, so an emailed link is always what bootstraps a
 * password rather than the other way round.
 */
export async function setPassword(password: string): Promise<void> {
  if (!supabase) throw new Error('Sync is not configured.');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  // Local scope: signing out on this device leaves your other devices signed
  // in. The default ('global') would revoke every session everywhere, which is
  // rarely what you want on your own devices.
  await supabase?.auth.signOut({ scope: 'local' });
}
