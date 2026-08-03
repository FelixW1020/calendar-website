import { useMemo, useRef, useState } from 'react';
import type { ViewMode } from '../types';
import { calendarColor, useStore, visibleEvents } from '../store';
import { format, parse, rangeLabel, step } from '../lib/dates';
import { ChevronLeft, ChevronRight, Moon, Search, Sun } from './Icons';

const VIEWS: { id: ViewMode; label: string; key: string }[] = [
  { id: 'day', label: 'Day', key: 'D' },
  { id: 'week', label: 'Week', key: 'W' },
  { id: 'month', label: 'Month', key: 'M' },
];

export default function Header({ searchRef }: { searchRef: React.RefObject<HTMLInputElement | null> }) {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const anchorISO = useStore((s) => s.anchor);
  const setAnchor = useStore((s) => s.setAnchor);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const events = useStore((s) => s.events);
  const calendars = useStore((s) => s.calendars);
  const select = useStore((s) => s.select);

  const anchor = new Date(anchorISO);
  const [searchOpen, setSearchOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);

  const results = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return [];
    return visibleEvents(events, calendars)
      .filter((e) =>
        `${e.title} ${e.location ?? ''} ${e.description ?? ''}`.toLowerCase().includes(q),
      )
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, 12);
  }, [search, events, calendars]);

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2">
      <button
        onClick={() => setAnchor(new Date())}
        className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-black/5 dark:hover:bg-white/5"
      >
        Today
      </button>

      <div className="flex">
        <button
          onClick={() => setAnchor(step(anchor, view, -1))}
          aria-label="Previous"
          className="rounded-md p-1.5 text-ink-soft hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
        >
          <ChevronLeft />
        </button>
        <button
          onClick={() => setAnchor(step(anchor, view, 1))}
          aria-label="Next"
          className="rounded-md p-1.5 text-ink-soft hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
        >
          <ChevronRight />
        </button>
      </div>

      <h1 className="truncate font-display text-xl text-ink">
        {rangeLabel(anchor, view)}
      </h1>

      <div className="ml-auto flex items-center gap-2">
        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => {
              blurTimer.current = window.setTimeout(() => setSearchOpen(false), 120);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearch('');
                e.currentTarget.blur();
              }
            }}
            placeholder="Search"
            className="w-36 rounded-md border border-line bg-canvas py-1.5 pl-7 pr-2 text-sm text-ink outline-none transition-[width] focus:w-52 focus:border-line-strong"
          />
          {searchOpen && search.trim() !== '' && (
            <div className="absolute right-0 top-full z-50 mt-1 max-h-80 w-80 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-xl">
              {results.length === 0 ? (
                <div className="px-2 py-3 text-sm text-ink-faint">No matching events.</div>
              ) : (
                results.map((ev) => (
                  <button
                    key={ev.id}
                    onMouseDown={() => {
                      if (blurTimer.current) clearTimeout(blurTimer.current);
                      setAnchor(parse(ev.start));
                      select(ev.id);
                      setSearchOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <span
                      className="event-chip h-2 w-2 shrink-0 rounded-full"
                      style={{ background: calendarColor(calendars, ev.calendarId) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{ev.title}</span>
                    <span className="shrink-0 text-xs text-ink-faint">
                      {format(parse(ev.start), 'MMM d')}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* View switcher */}
        <div className="flex rounded-md border border-line p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              title={`${v.label} (${v.key})`}
              className={
                'rounded px-2.5 py-1 text-sm transition ' +
                (view === v.id
                  ? 'bg-ink text-panel'
                  : 'text-ink-soft hover:text-ink')
              }
            >
              {v.label}
            </button>
          ))}
        </div>

        <button
          onClick={toggleTheme}
          aria-label="Toggle theme"
          className="rounded-md p-1.5 text-ink-soft hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>
      </div>
    </header>
  );
}
