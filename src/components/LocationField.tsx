import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Place } from '../types';
import { useStore } from '../store';
import {
  cached,
  directionsUrl,
  isMeetingLink,
  mapEmbedUrl,
  mapsUrl,
  meetingUrl,
  rememberBias,
  resolvePlace,
  searchPlaces,
  type Suggestion,
} from '../lib/geocode';
import { Pin, Spinner } from './Icons';

interface Props {
  value: string;
  place?: Place;
  /** Fires on every keystroke; the parent decides when to persist. */
  onChange: (value: string, place?: Place) => void;
  className: string;
}

const DEBOUNCE_MS = 220;
const MIN_QUERY = 3;

/**
 * Places already used in this calendar, as instant offline suggestions —
 * "Office" or "Mom's" are things you type again and again, and they should not
 * need a round-trip.
 */
function useRecentPlaces(query: string, exclude: string): Suggestion[] {
  const events = useStore((s) => s.events);

  return useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const seen = new Map<string, Suggestion>();
    // Newest first, so the version of a place you last used wins.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const loc = ev.location?.trim();
      if (!loc || loc.toLowerCase() === exclude.trim().toLowerCase()) continue;
      if (!loc.toLowerCase().includes(q)) continue;
      const key = loc.toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, {
        lat: ev.place?.lat ?? NaN,
        lon: ev.place?.lon ?? NaN,
        label: ev.place?.label ?? loc,
        name: loc,
        detail: ev.place && ev.place.label !== loc ? ev.place.label : 'Used before',
        source: 'recent',
      });
      if (seen.size === 3) break;
    }
    return [...seen.values()];
  }, [events, query, exclude]);
}

export default function LocationField({ value, place, onChange, className }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  // The last query a search actually finished for, so "no matches" is only ever
  // shown about the text currently in the box.
  const [searched, setSearched] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  // A pick writes the label straight into the field; without this the effect
  // below would immediately search for the text it just filled in.
  const skipNextSearch = useRef(false);

  const link = isMeetingLink(value);
  const recents = useRecentPlaces(value, place?.label ?? '');
  const suggestions = useMemo(() => [...recents, ...results], [recents, results]);

  /* --------------------------------------------------------------- search -- */

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    const q = value.trim();
    // Nothing to look up until the field has focus, and nothing to look up for
    // a location that is already pinned to exactly this text.
    const settled = place != null && place.label === q;
    if (!open || link || settled || q.length < MIN_QUERY) {
      setResults([]);
      setBusy(false);
      return;
    }

    // A cache hit renders on this tick — no debounce, no flicker while you
    // backspace through a query you already ran.
    const hit = cached(q);
    if (hit) {
      setResults(hit);
      setSearched(q);
      setBusy(false);
      return;
    }

    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      searchPlaces(q, controller.signal)
        .then((found) => {
          setResults(found);
          setSearched(q);
          setActive(0);
        })
        .catch(() => {
          /* aborted by the next keystroke */
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, link, open, place]);

  /**
   * Locations that predate coordinates — typed by hand, or set by the
   * assistant — get resolved once when the editor opens, so they end up with
   * the same pin and map card as a location picked from the list. Mount-only:
   * it must never chase what you are in the middle of typing, and
   * `resolvePlace` only accepts an unambiguous match.
   */
  useEffect(() => {
    if (place || !value.trim() || isMeetingLink(value)) return;
    const controller = new AbortController();
    resolvePlace(value, controller.signal)
      .then((found) => {
        if (controller.signal.aborted || !found) return;
        skipNextSearch.current = true;
        onChange(value, found);
      })
      .catch(() => {
        /* offline, or the editor closed */
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------- handlers -- */

  const pick = (s: Suggestion) => {
    const hasCoords = Number.isFinite(s.lat) && Number.isFinite(s.lon);
    const picked: Place | undefined = hasCoords
      ? { lat: s.lat, lon: s.lon, label: s.label }
      : undefined;

    skipNextSearch.current = true;
    onChange(s.source === 'recent' ? s.name : s.label, picked);
    if (picked) rememberBias(picked);
    setOpen(false);
    setResults([]);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && open) {
      // The editor closes on Escape; while the list is open, Escape belongs
      // to the list.
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (!suggestions.length) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => {
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        return (next + suggestions.length) % suggestions.length;
      });
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      pick(suggestions[active]);
    } else if (e.key === 'Tab' && open) {
      pick(suggestions[active]);
    }
  };

  // Silence after typing an address reads as a broken field. Say so instead.
  const noMatch = !busy && searched === value.trim() && suggestions.length === 0;
  const showList = open && (suggestions.length > 0 || busy || noMatch);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">Location</span>
        <div className="flex items-center gap-2">
          {link && (
            <a
              href={meetingUrl(value)}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-ink-faint underline underline-offset-2 hover:text-ink"
            >
              Join
            </a>
          )}
          {!link && value.trim() && (
            <>
              <a
                href={mapsUrl(value, place)}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-ink-faint underline underline-offset-2 hover:text-ink"
              >
                Open in Maps
              </a>
              <a
                href={directionsUrl(value, place)}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-ink-faint underline underline-offset-2 hover:text-ink"
              >
                Directions
              </a>
            </>
          )}
        </div>
      </div>

      <div className="relative">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            // Editing the text detaches it from the pin it came from.
            onChange(e.target.value, undefined);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          // A click lands after blur, so closing has to wait for it.
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder="Place, address, or meeting link"
          className={className + (place ? ' pl-7' : '')}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && suggestions.length ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />

        {place && (
          <Pin className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-accent" />
        )}
        {busy && !place && (
          <Spinner className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
        )}

        {showList && (
          <ul
            id={listId}
            role="listbox"
            className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-line bg-panel py-1 shadow-lg"
          >
            {suggestions.map((s, i) => (
              <li key={`${s.source}-${s.label}-${i}`}>
                <button
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  type="button"
                  // Keeps focus in the input, so blur never races the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(s)}
                  className={
                    'flex w-full items-start gap-2 px-2 py-1.5 text-left ' +
                    (i === active ? 'bg-black/5 dark:bg-white/10' : '')
                  }
                >
                  <Pin
                    className={
                      'mt-0.5 h-3.5 w-3.5 shrink-0 ' +
                      (s.source === 'recent' ? 'text-ink-faint' : 'text-accent')
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">
                      {s.name}
                      {s.approximate && (
                        <span className="ml-1.5 text-[10px] uppercase tracking-wider text-ink-faint">
                          approx.
                        </span>
                      )}
                    </span>
                    {s.detail && (
                      <span className="block truncate text-[11px] text-ink-faint">{s.detail}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
            {busy && suggestions.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-ink-faint">Searching…</li>
            )}
            {noMatch && (
              <li className="px-2 py-1.5 text-sm text-ink-faint">
                No matching places — the text is saved as you typed it.
              </li>
            )}
          </ul>
        )}
      </div>

      {place && !link && (
        <a
          href={mapsUrl(value, place)}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block overflow-hidden rounded-md border border-line"
          title={place.label}
        >
          <iframe
            key={`${place.lat},${place.lon}`}
            src={mapEmbedUrl(place)}
            title={`Map of ${place.label}`}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="pointer-events-none block h-28 w-full border-0"
          />
        </a>
      )}
    </div>
  );
}
