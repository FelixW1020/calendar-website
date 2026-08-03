import { useState } from 'react';
import { PALETTE, useStore } from '../store';
import {
  addDays,
  format,
  isSameDay,
  startOfWeek,
  visibleRange,
  WEEK_STARTS_ON,
} from '../lib/dates';
import { ChevronLeft, ChevronRight } from './Icons';

interface Props {
  /** Drawer state, used below the lg breakpoint where the sidebar is off-canvas. */
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: Props) {
  const anchor = new Date(useStore((s) => s.anchor));
  const view = useStore((s) => s.view);
  const setAnchor = useStore((s) => s.setAnchor);
  const calendars = useStore((s) => s.calendars);
  const toggleCalendar = useStore((s) => s.toggleCalendar);
  const addCalendar = useStore((s) => s.addCalendar);
  const removeCalendar = useStore((s) => s.removeCalendar);

  const [miniMonth, setMiniMonth] = useState(() => new Date(anchor));
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  const range = visibleRange(anchor, view);
  const gridStart = startOfWeek(new Date(miniMonth.getFullYear(), miniMonth.getMonth(), 1), {
    weekStartsOn: WEEK_STARTS_ON,
  });
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = new Date();

  const shiftMonth = (dir: 1 | -1) => {
    const d = new Date(miniMonth);
    d.setDate(1);
    d.setMonth(d.getMonth() + dir);
    setMiniMonth(d);
  };

  return (
    <>
      {/* Scrim, drawer mode only. */}
      {open && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/30 lg:hidden dark:bg-black/60"
        />
      )}
      <aside
        className={
          'flex w-56 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-panel p-3 ' +
          // Off-canvas drawer below lg, static column at lg and up.
          'fixed inset-y-0 left-0 z-50 transition-transform duration-200 ' +
          (open ? 'translate-x-0' : '-translate-x-full') +
          ' lg:static lg:z-auto lg:translate-x-0 lg:bg-transparent'
        }
      >
      {/* Mini month */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium text-ink">{format(miniMonth, 'MMMM yyyy')}</span>
          <div className="flex">
            <button
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
              className="rounded p-1 text-ink-faint hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
              className="rounded p-1 text-ink-faint hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-y-0.5 text-center">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <div key={i} className="text-[10px] font-medium text-ink-faint">
              {d}
            </div>
          ))}
          {cells.map((d) => {
            const inMonth = d.getMonth() === miniMonth.getMonth();
            const inRange = d >= range.start && d < range.end;
            const isToday = isSameDay(d, today);
            return (
              <button
                key={d.toISOString()}
                onClick={() => setAnchor(d)}
                className={
                  'mx-auto flex h-6 w-6 items-center justify-center rounded-full text-[11px] tabular-nums ' +
                  (isToday
                    ? 'bg-accent font-semibold text-white'
                    : inRange
                      ? 'bg-black/[0.07] text-ink dark:bg-white/10'
                      : inMonth
                        ? 'text-ink-soft hover:bg-black/5 dark:hover:bg-white/5'
                        : 'text-ink-faint hover:bg-black/5 dark:hover:bg-white/5')
                }
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
      </div>

      {/* Calendars */}
      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          Calendars
        </div>
        <ul className="space-y-0.5">
          {calendars.map((c) => (
            <li key={c.id} className="group flex items-center gap-2 rounded px-1 py-1">
              <input
                type="checkbox"
                checked={c.visible}
                onChange={() => toggleCalendar(c.id)}
                aria-label={c.name}
                style={{ accentColor: c.color }}
                className="h-3.5 w-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{c.name}</span>
              {calendars.length > 1 && (
                <button
                  onClick={() => {
                    if (confirm(`Delete "${c.name}" and all of its events?`)) removeCalendar(c.id);
                  }}
                  aria-label={`Delete ${c.name}`}
                  className="opacity-0 transition group-hover:opacity-100 text-ink-faint hover:text-red-600"
                >
                  <span className="text-xs">×</span>
                </button>
              )}
            </li>
          ))}
        </ul>

        {adding ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              if (name) addCalendar(name, PALETTE[calendars.length % PALETTE.length]);
              setNewName('');
              setAdding(false);
            }}
            className="mt-2"
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => setAdding(false)}
              placeholder="Calendar name"
              className="w-full rounded border border-line bg-canvas px-2 py-1 text-sm outline-none focus:border-line-strong"
            />
          </form>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="mt-2 px-1 text-xs text-ink-faint hover:text-ink"
          >
            + Add calendar
          </button>
        )}
      </div>

      {/* Keyboard hints are noise on a touch device. */}
      <div className="mt-auto hidden space-y-1 pt-4 text-[11px] leading-relaxed text-ink-faint lg:block">
        <div className="font-medium uppercase tracking-wider">Shortcuts</div>
        <div><kbd>D</kbd> <kbd>W</kbd> <kbd>M</kbd> switch view</div>
        <div><kbd>T</kbd> today · <kbd>J</kbd>/<kbd>K</kbd> prev/next</div>
        <div><kbd>C</kbd> chat · <kbd>/</kbd> search</div>
      </div>
      </aside>
    </>
  );
}
