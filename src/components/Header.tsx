import { useMemo, useRef, useState } from 'react';
import type { ViewMode } from '../types';
import { calendarColor, useAllEvents, useStore, visibleEvents } from '../store';
import { format, parse, rangeLabel, step } from '../lib/dates';
import { isSeriesEvent, nextOccurrence } from '../lib/recurrence';
import { ChevronLeft, ChevronRight, Cloud, Menu, Moon, Repeat, Search, Sun } from './Icons';

const VIEWS: { id: ViewMode; label: string; short: string }[] = [
  { id: 'day', label: 'Day', short: 'D' },
  { id: 'week', label: 'Week', short: 'W' },
  { id: 'month', label: 'Month', short: 'M' },
];

interface Props {
  searchRef: React.RefObject<HTMLInputElement | null>;
  onOpenMenu: () => void;
  onOpenAccount: () => void;
}

const SYNC_LABEL: Record<string, string> = {
  off: 'Saved on this device only',
  'signed-out': 'Not syncing — sign in to use this calendar on other devices',
  syncing: 'Syncing…',
  live: 'Synced',
  error: 'Sync problem — click for details',
};

export default function Header({ searchRef, onOpenMenu, onOpenAccount }: Props) {
  const sync = useStore((s) => s.sync);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const anchorISO = useStore((s) => s.anchor);
  const setAnchor = useStore((s) => s.setAnchor);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);

  const anchor = new Date(anchorISO);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const blurTimer = useRef<number | null>(null);

  const openResults = () => setResultsOpen(true);
  const deferClose = () => {
    blurTimer.current = window.setTimeout(() => setResultsOpen(false), 120);
  };

  const iconBtn =
    'rounded-md p-1.5 text-ink-soft hover:bg-black/5 hover:text-ink dark:hover:bg-white/5';

  const Today = () => (
    <button
      onClick={() => setAnchor(new Date())}
      className="shrink-0 rounded-md border border-line px-2.5 py-1.5 text-sm text-ink hover:bg-black/5 dark:hover:bg-white/5"
    >
      Today
    </button>
  );

  const Arrows = () => (
    <div className="flex shrink-0">
      <button onClick={() => setAnchor(step(anchor, view, -1))} aria-label="Previous" className={iconBtn}>
        <ChevronLeft />
      </button>
      <button onClick={() => setAnchor(step(anchor, view, 1))} aria-label="Next" className={iconBtn}>
        <ChevronRight />
      </button>
    </div>
  );

  const Views = () => (
    <div className="flex shrink-0 rounded-md border border-line p-0.5">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          onClick={() => setView(v.id)}
          title={v.label}
          className={
            'rounded px-2 py-1 text-sm transition sm:px-2.5 ' +
            (view === v.id ? 'bg-ink text-panel' : 'text-ink-soft hover:text-ink')
          }
        >
          <span className="hidden sm:inline">{v.label}</span>
          <span className="sm:hidden">{v.short}</span>
        </button>
      ))}
    </div>
  );

  const searchInput = (autoFocus: boolean, ref?: React.RefObject<HTMLInputElement | null>) => (
    <input
      ref={ref}
      autoFocus={autoFocus}
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      onFocus={openResults}
      onBlur={deferClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setSearch('');
          setMobileSearch(false);
          e.currentTarget.blur();
        }
      }}
      placeholder="Search events"
      className="w-full rounded-md border border-line bg-canvas py-1.5 pl-7 pr-2 text-sm text-ink outline-none focus:border-line-strong"
    />
  );

  return (
    <header className="relative shrink-0 border-b border-line">
      {/* Mobile search takes over the top row while it is open. */}
      {mobileSearch && (
        <div className="flex items-center gap-2 px-2 py-2 sm:hidden">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            {searchInput(true)}
          </div>
          <button
            onClick={() => {
              setSearch('');
              setMobileSearch(false);
            }}
            className="shrink-0 px-1 text-sm text-ink-soft"
          >
            Cancel
          </button>
        </div>
      )}

      <div
        className={
          'items-center gap-2 px-2 py-2 sm:px-3 ' + (mobileSearch ? 'hidden sm:flex' : 'flex')
        }
      >
        <button onClick={onOpenMenu} aria-label="Calendars" className={iconBtn + ' lg:hidden'}>
          <Menu />
        </button>

        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <Today />
          <Arrows />
        </div>

        <h1 className="min-w-0 flex-1 truncate font-display text-lg text-ink sm:text-xl">
          {rangeLabel(anchor, view)}
        </h1>

        {/* Inline search from sm up; an icon below that. */}
        <div className="relative hidden sm:block">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <div className="w-36 transition-[width] focus-within:w-52">{searchInput(false, searchRef)}</div>
        </div>
        <button
          onClick={() => setMobileSearch(true)}
          aria-label="Search"
          className={iconBtn + ' sm:hidden'}
        >
          <Search />
        </button>

        <div className="hidden sm:block">
          <Views />
        </div>

        <button
          onClick={onOpenAccount}
          aria-label={SYNC_LABEL[sync.status] ?? 'Sync'}
          title={SYNC_LABEL[sync.status] ?? 'Sync'}
          className={iconBtn + ' relative'}
        >
          <Cloud />
          <span
            className={
              'absolute right-1 top-1 h-1.5 w-1.5 rounded-full ring-2 ring-canvas ' +
              (sync.status === 'live'
                ? 'bg-emerald-500'
                : sync.status === 'syncing'
                  ? 'bg-amber-500'
                  : sync.status === 'error'
                    ? 'bg-red-500'
                    : 'bg-ink-faint')
            }
          />
        </button>

        <button onClick={toggleTheme} aria-label="Toggle theme" className={iconBtn}>
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>
      </div>

      {/* Second row on narrow screens, where the top row has no space left. */}
      {!mobileSearch && (
        <div className="flex items-center gap-2 px-2 pb-2 sm:hidden">
          <Today />
          <Arrows />
          <div className="ml-auto">
            <Views />
          </div>
        </div>
      )}

      {resultsOpen && search.trim() !== '' && (
        <SearchResults
          onPick={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            setResultsOpen(false);
            setMobileSearch(false);
          }}
        />
      )}
    </header>
  );
}

function SearchResults({ onPick }: { onPick: () => void }) {
  const search = useStore((s) => s.search);
  const events = useAllEvents();
  const calendars = useStore((s) => s.calendars);
  const setAnchor = useStore((s) => s.setAnchor);
  const select = useStore((s) => s.select);

  const results = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return [];
    const now = new Date();
    return visibleEvents(events, calendars)
      .filter((e) => `${e.title} ${e.location ?? ''} ${e.description ?? ''}`.toLowerCase().includes(q))
      // A repeating event is one row. Offer the occurrence the user would
      // actually want to jump to — the next one — rather than the first ever.
      .map((e) => (e.recurrence ? nextOccurrence(e, now) ?? e : e))
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, 12);
  }, [search, events, calendars]);

  return (
    <div className="absolute inset-x-2 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-xl sm:inset-x-auto sm:right-3 sm:w-80">
      {results.length === 0 ? (
        <div className="px-2 py-3 text-sm text-ink-faint">No matching events.</div>
      ) : (
        results.map((ev) => (
          <button
            key={ev.id}
            onMouseDown={() => {
              setAnchor(parse(ev.start));
              select(ev.id);
              onPick();
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/5"
          >
            <span
              className="event-chip h-2 w-2 shrink-0 rounded-full"
              style={{ background: calendarColor(calendars, ev.calendarId) }}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-ink">
              {ev.title}
              {ev.location ? <span className="text-ink-faint"> · {ev.location}</span> : null}
            </span>
            {isSeriesEvent(ev) && <Repeat className="h-3 w-3 shrink-0 text-ink-faint" />}
            <span className="shrink-0 text-xs text-ink-faint">{format(parse(ev.start), 'MMM d')}</span>
          </button>
        ))
      )}
    </div>
  );
}
