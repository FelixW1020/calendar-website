import type { Subscription } from '../types';
import { useStore } from '../store';
import { fetchFeed } from './ics';
import { parse, toLocalISO } from './dates';

/**
 * Keeping subscribed calendars current.
 *
 * A feed is a cache, not a source of truth: every refresh throws away the last
 * copy and replaces it wholesale, which is the whole reason feed events are held
 * apart from the user's own. There is nothing to reconcile and nothing to lose.
 *
 * Refreshes are cheap but not free — each one is a cross-origin request the user
 * did not ask for — so they happen on a schedule a published calendar can
 * actually change on, and the cached copy carries the app until then.
 */

/** How stale a feed may be before it is fetched again. */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

/** How often to look for feeds that have gone stale while the tab stayed open. */
const TICK_MS = 30 * 60 * 1000;

/**
 * A feed that is failing has no `lastFetchedAt` to age out of, so nothing in the
 * staleness check holds it back — and the triggers below include switching to
 * the tab. This is the floor that keeps a calendar whose publisher is down from
 * being retried on every glance at the window.
 */
const MIN_RETRY_MS = 5 * 60 * 1000;

/**
 * Feeds are refreshed one at a time. Several at once would be faster and would
 * also mean several simultaneous requests to the same relay, which is a good way
 * to be rate-limited.
 */
const inFlight = new Set<string>();

/** When each feed was last *attempted*, successfully or not. */
const attempted = new Map<string, number>();

function isStale(sub: Subscription): boolean {
  const last = attempted.get(sub.id);
  if (last !== undefined && Date.now() - last < MIN_RETRY_MS) return false;
  if (!sub.lastFetchedAt) return true;
  return Date.now() - parse(sub.lastFetchedAt).getTime() > REFRESH_AFTER_MS;
}

/**
 * Fetch one feed and replace its cached events. Never throws: a feed that is
 * down is a message on the sidebar, not a broken calendar.
 */
export async function refreshFeed(id: string, options: { force?: boolean } = {}): Promise<void> {
  const sub = useStore.getState().subscriptions.find((s) => s.id === id);
  if (!sub || inFlight.has(id)) return;
  if (!options.force && !isStale(sub)) return;

  attempted.set(id, Date.now());
  inFlight.add(id);
  try {
    const result = await fetchFeed(sub.url, { useProxy: sub.useProxy, calendarId: sub.id });
    const store = useStore.getState();
    // The subscription can be deleted while its own refresh is in the air.
    if (!store.subscriptions.some((s) => s.id === id)) return;

    if (!result.ok) {
      // A browser cannot tell a CORS refusal from a host that is simply down —
      // both arrive as an opaque failed fetch. On a feed that has worked before,
      // "it doesn't allow browsers to read it" is the one explanation already
      // ruled out, so say the thing that is actually likely.
      const message =
        result.kind === 'blocked' && sub.lastFetchedAt
          ? 'Could not reach this calendar just now — showing the last copy.'
          : result.message;
      store.setFeedStatus(id, { error: message });
      return;
    }
    store.setFeedEvents(id, result.feed.events);
    store.setFeedStatus(id, { lastFetchedAt: toLocalISO(new Date()), error: null });
  } catch (err) {
    useStore.getState().setFeedStatus(id, {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inFlight.delete(id);
  }
}

/** Refresh every subscription that has gone stale, in turn. */
export async function refreshAll(options: { force?: boolean } = {}): Promise<void> {
  for (const sub of useStore.getState().subscriptions) {
    await refreshFeed(sub.id, options);
  }
}

/**
 * Called once at startup. Fetches what is stale now, watches for subscriptions
 * arriving from another device, and checks again on a timer for a tab that is
 * left open for days.
 */
export function initFeeds(): () => void {
  void refreshAll();

  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.subscriptions === previous.subscriptions) return;
    const before = new Map(previous.subscriptions.map((s) => [s.id, s]));
    for (const sub of state.subscriptions) {
      const was = before.get(sub.id);
      // Only a subscription that is new here or now points somewhere else. This
      // list is also rewritten every time a refresh records its own outcome, so
      // anything keyed off that outcome would re-trigger itself forever.
      if (!was || was.url !== sub.url) void refreshFeed(sub.id);
    }
  });

  const timer = setInterval(() => void refreshAll(), TICK_MS);

  // Coming back to a tab left open overnight should not show yesterday.
  const onVisible = () => {
    if (document.visibilityState === 'visible') void refreshAll();
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    unsubscribe();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
