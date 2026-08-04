import { useEffect, useState } from 'react';
import type { SeriesScope } from '../lib/recurrence';

interface Props {
  title: string;
  /** Label for the confirming button, e.g. "Save" or "Delete". */
  action: string;
  /** Which scopes make sense here; the first is preselected. */
  options: SeriesScope[];
  destructive?: boolean;
  /** Shown under the choices when one of them is unavailable. */
  note?: string;
  onConfirm: (scope: SeriesScope) => void;
  onCancel: () => void;
}

const LABELS: Record<SeriesScope, string> = {
  this: 'This event',
  following: 'This and following events',
  all: 'All events',
};

/**
 * The question every calendar has to ask about a repeating event, because there
 * is no answer that is right often enough to assume.
 */
export default function ScopeDialog({
  title,
  action,
  options,
  destructive = false,
  note,
  onConfirm,
  onCancel,
}: Props) {
  const [scope, setScope] = useState<SeriesScope>(options[0]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // This sits on top of the editor, which also closes on Escape.
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/25 dark:bg-black/55" onClick={onCancel} />
      <div
        role="dialog"
        aria-label={title}
        className="fixed left-1/2 top-1/2 z-[70] w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-4 shadow-2xl"
      >
        <div className="text-sm font-medium text-ink">{title}</div>

        <div className="mt-3 space-y-1">
          {options.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-black/5 dark:hover:bg-white/5"
            >
              <input
                type="radio"
                name="scope"
                checked={scope === option}
                onChange={() => setScope(option)}
                className="accent-accent"
              />
              {LABELS[option]}
            </label>
          ))}
        </div>

        {note && <p className="mt-2 px-2 text-xs text-ink-faint">{note}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs text-ink-soft hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(scope)}
            className={
              'rounded-md px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 ' +
              (destructive ? 'bg-red-600' : 'bg-accent')
            }
          >
            {action}
          </button>
        </div>
      </div>
    </>
  );
}
