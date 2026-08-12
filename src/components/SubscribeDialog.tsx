import { useEffect, useRef, useState } from 'react';
import { PALETTE, uid, useStore } from '../store';
import { RELAY_HOST, fetchFeed, normalizeFeedUrl } from '../lib/ics';
import { toLocalISO } from '../lib/dates';
import { Close, Spinner } from './Icons';

/**
 * Subscribing to a calendar someone else publishes.
 *
 * The link is checked before anything is added, because the failure worth
 * handling well is the common one: most publishers send no CORS header, so the
 * browser refuses the response and there is no server here to ask instead. That
 * is not a mistake the user made and not something they can fix, so the dialog
 * names it and offers the one way through — a public relay — rather than
 * reporting "could not load" and leaving it there.
 */

type Stage =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** Direct access failed; the relay is the remaining option. */
  | { kind: 'blocked' }
  | { kind: 'error'; message: string };

export default function SubscribeDialog({ onClose }: { onClose: () => void }) {
  const calendars = useStore((s) => s.calendars);
  const addSubscription = useStore((s) => s.addSubscription);
  const setFeedEvents = useStore((s) => s.setFeedEvents);

  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const aborter = useRef<AbortController | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      aborter.current?.abort();
    };
  }, [onClose]);

  const busy = stage.kind === 'checking';

  /**
   * Fetch once to prove the link works, then keep what came back — subscribing
   * and then immediately refetching would double every first request.
   */
  const subscribe = async (useProxy: boolean) => {
    const normalized = normalizeFeedUrl(url);
    if (!normalized) {
      setStage({ kind: 'error', message: 'That is not a calendar address.' });
      return;
    }

    setStage({ kind: 'checking' });
    aborter.current?.abort();
    const controller = new AbortController();
    aborter.current = controller;

    // The events are keyed by the calendar they will belong to, so the id is
    // settled here and handed to the store only if the link turns out to work.
    const id = uid();
    const result = await fetchFeed(normalized, {
      useProxy,
      signal: controller.signal,
      calendarId: id,
    }).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      throw err;
    });
    if (!result || controller.signal.aborted) return;

    if (!result.ok) {
      setStage(
        result.kind === 'blocked' && !useProxy
          ? { kind: 'blocked' }
          : { kind: 'error', message: result.message },
      );
      return;
    }

    // Events first: the subscription is what the refresh scheduler watches, so
    // by the time it exists its copy of the feed should already be in place.
    setFeedEvents(id, result.feed.events);
    addSubscription({
      id,
      url: normalized,
      name: name.trim() || result.feed.name || hostOf(normalized),
      color: PALETTE[calendars.length % PALETTE.length],
      useProxy,
      fetchedAt: toLocalISO(new Date()),
    });
    onClose();
  };

  const field =
    'w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink ' +
    'outline-none focus:border-line-strong placeholder:text-ink-faint';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 dark:bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Add calendar by link"
        className="fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-panel p-5 shadow-2xl"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded p-1 text-ink-faint hover:text-ink"
        >
          <Close />
        </button>

        <h2 className="mb-1 font-display text-xl text-ink">Add a calendar by link</h2>
        <p className="mb-4 text-sm leading-relaxed text-ink-soft">
          Paste the iCal or <code className="text-ink">webcal</code> address of a calendar published
          elsewhere — a Google Calendar, a team schedule, a holiday list. Its events appear here
          alongside yours and stay read-only.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void subscribe(false);
          }}
          className="space-y-3"
        >
          <div>
            <label
              htmlFor="feed-url"
              className="mb-1 block text-[11px] uppercase tracking-wider text-ink-faint"
            >
              Address
            </label>
            <input
              id="feed-url"
              autoFocus
              required
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (stage.kind !== 'checking') setStage({ kind: 'idle' });
              }}
              placeholder="https://example.com/calendar.ics"
              spellCheck={false}
              autoComplete="off"
              className={field}
            />
          </div>

          <div>
            <label
              htmlFor="feed-name"
              className="mb-1 block text-[11px] uppercase tracking-wider text-ink-faint"
            >
              Name <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="feed-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Taken from the calendar itself"
              className={field}
            />
          </div>

          {stage.kind === 'error' && (
            <p className="text-sm text-red-600 dark:text-red-400">{stage.message}</p>
          )}

          {stage.kind === 'blocked' ? (
            <div className="space-y-3 rounded-lg border border-line bg-canvas p-3">
              <p className="text-sm leading-relaxed text-ink-soft">
                This calendar won&apos;t let a browser read it directly, and this app has no server
                of its own to fetch it for you. It can be read through{' '}
                <span className="text-ink">{RELAY_HOST}</span>, a public relay — which means{' '}
                <span className="text-ink">that address, and everything in the calendar, passes
                through someone else&apos;s server</span>. A private subscription link is a password
                in itself, so this is worth a moment&apos;s thought.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void subscribe(true)}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
                >
                  Use the relay
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="submit"
              disabled={busy || url.trim() === ''}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-accent py-2 text-sm font-medium text-white transition disabled:opacity-40"
            >
              {busy && <Spinner className="h-4 w-4" />}
              {busy ? 'Checking the link…' : 'Add calendar'}
            </button>
          )}
        </form>

        <p className="mt-4 text-[12px] leading-relaxed text-ink-faint">
          In Google Calendar the address is under Settings → your calendar → Integrate calendar →
          Secret address in iCal format. Subscribed calendars refresh in the background and can be
          removed from the sidebar.
        </p>
      </div>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Subscribed calendar';
  }
}
