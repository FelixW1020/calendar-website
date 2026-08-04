import { useMemo, useState } from 'react';
import {
  WEEKDAYS,
  describeRule,
  formatRule,
  isLastWeekdayOfMonth,
  parseRule,
  weekOfMonth,
  type Freq,
  type Rule,
  type Weekday,
} from '../lib/recurrence';
import { format, parse } from '../lib/dates';

interface Props {
  /** The current RRULE, or undefined when the event does not repeat. */
  value?: string;
  /** The event's start — every preset is phrased relative to it. */
  start: string;
  onChange: (recurrence: string | undefined) => void;
  className: string;
}

const CUSTOM = '__custom__';

const DAY_INITIALS: Record<Weekday, string> = {
  SU: 'S', MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S',
};

const UNITS: Array<{ freq: Freq; one: string; many: string }> = [
  { freq: 'DAILY', one: 'day', many: 'days' },
  { freq: 'WEEKLY', one: 'week', many: 'weeks' },
  { freq: 'MONTHLY', one: 'month', many: 'months' },
  { freq: 'YEARLY', one: 'year', many: 'years' },
];

/** The handful of rules worth one click, phrased for the day the event is on. */
function presets(seed: Date): Array<{ label: string; rrule: string }> {
  const day = WEEKDAYS[seed.getDay()];
  const nth = isLastWeekdayOfMonth(seed) && weekOfMonth(seed) >= 4 ? -1 : weekOfMonth(seed);
  const ordinal = nth === -1 ? 'last' : ['', 'first', 'second', 'third', 'fourth', 'fifth'][nth];
  return [
    { label: 'Daily', rrule: 'FREQ=DAILY' },
    { label: `Weekly on ${format(seed, 'EEEE')}`, rrule: `FREQ=WEEKLY;BYDAY=${day}` },
    { label: 'Every weekday (Mon–Fri)', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    {
      label: `Monthly on the ${ordinal} ${format(seed, 'EEEE')}`,
      rrule: `FREQ=MONTHLY;BYDAY=${nth}${day}`,
    },
    { label: `Annually on ${format(seed, 'MMMM d')}`, rrule: 'FREQ=YEARLY' },
  ];
}

/** Compare rules by meaning rather than by how they happen to be written. */
function sameRule(a: string | undefined, b: string): boolean {
  const parsedA = parseRule(a);
  const parsedB = parseRule(b);
  return Boolean(parsedA && parsedB && formatRule(parsedA) === formatRule(parsedB));
}

export default function RecurrenceField({ value, start, onChange, className }: Props) {
  const seed = useMemo(() => parse(start), [start]);
  const options = useMemo(() => presets(seed), [seed]);
  const rule = useMemo(() => parseRule(value), [value]);

  const matched = rule ? options.find((o) => sameRule(value, o.rrule)) : null;
  const [open, setOpen] = useState(false);
  const custom = Boolean(rule) && !matched;

  const edit = (patch: Partial<Rule>) => {
    const next: Rule = { ...(rule ?? { freq: 'WEEKLY', interval: 1 }), ...patch };
    if (next.freq !== 'WEEKLY') delete next.byDay;
    if (next.freq !== 'MONTHLY') {
      delete next.byMonthDay;
      delete next.byNthDay;
    }
    onChange(formatRule(next));
  };

  const pick = (selected: string) => {
    if (selected === '') {
      setOpen(false);
      onChange(undefined);
      return;
    }
    if (selected === CUSTOM) {
      setOpen(true);
      // Seeding from whatever is already set keeps the change small.
      if (!rule) onChange(`FREQ=WEEKLY;BYDAY=${WEEKDAYS[seed.getDay()]}`);
      return;
    }
    setOpen(false);
    onChange(selected);
  };

  const showCustom = open || custom;

  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">Repeat</div>
      <select
        value={custom ? CUSTOM : matched?.rrule ?? ''}
        onChange={(e) => pick(e.target.value)}
        className={className}
      >
        <option value="">Does not repeat</option>
        {options.map((o) => (
          <option key={o.rrule} value={o.rrule}>
            {o.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>

      {showCustom && rule && <CustomPanel rule={rule} seed={seed} onEdit={edit} />}

      {rule && !showCustom && (
        <p className="mt-1 text-[11px] text-ink-faint">{describeRule(rule, seed)}</p>
      )}
    </div>
  );
}

function CustomPanel({
  rule,
  seed,
  onEdit,
}: {
  rule: Rule;
  seed: Date;
  onEdit: (patch: Partial<Rule>) => void;
}) {
  const days = rule.byDay?.length ? rule.byDay : [WEEKDAYS[seed.getDay()]];
  const nth = isLastWeekdayOfMonth(seed) && weekOfMonth(seed) >= 4 ? -1 : weekOfMonth(seed);
  const ends: 'never' | 'on' | 'after' = rule.count ? 'after' : rule.until ? 'on' : 'never';

  const small = 'rounded-md border border-line bg-canvas px-2 py-1 text-sm text-ink outline-none focus:border-line-strong';

  const toggleDay = (day: Weekday) => {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    // A weekly rule with no days left has nowhere to land; keep the last one.
    onEdit({ byDay: next.length > 0 ? next : days });
  };

  const setEnds = (mode: 'never' | 'on' | 'after') => {
    if (mode === 'never') return onEdit({ count: undefined, until: undefined });
    if (mode === 'after') return onEdit({ count: rule.count ?? 10, until: undefined });
    const inThreeMonths = new Date(seed.getFullYear(), seed.getMonth() + 3, seed.getDate());
    onEdit({ until: rule.until ?? format(inThreeMonths, 'yyyy-MM-dd'), count: undefined });
  };

  return (
    <div className="mt-2 space-y-2 rounded-md border border-line bg-canvas/60 p-2">
      <div className="flex items-center gap-2 text-sm text-ink-soft">
        <span>Every</span>
        <input
          type="number"
          min={1}
          max={99}
          value={rule.interval}
          onChange={(e) => onEdit({ interval: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })}
          className={small + ' w-14 tabular-nums'}
        />
        <select
          value={rule.freq}
          onChange={(e) => onEdit({ freq: e.target.value as Freq })}
          className={small + ' flex-1'}
        >
          {UNITS.map((u) => (
            <option key={u.freq} value={u.freq}>
              {rule.interval === 1 ? u.one : u.many}
            </option>
          ))}
        </select>
      </div>

      {rule.freq === 'WEEKLY' && (
        <div className="flex gap-1">
          {WEEKDAYS.map((day) => {
            const on = days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-label={day}
                aria-pressed={on}
                onClick={() => toggleDay(day)}
                className={
                  'h-7 flex-1 rounded-full text-xs font-medium transition ' +
                  (on
                    ? 'bg-accent text-white'
                    : 'border border-line text-ink-soft hover:bg-black/5 dark:hover:bg-white/5')
                }
              >
                {DAY_INITIALS[day]}
              </button>
            );
          })}
        </div>
      )}

      {rule.freq === 'MONTHLY' && (
        <select
          value={rule.byNthDay ? 'nth' : 'day'}
          onChange={(e) =>
            e.target.value === 'nth'
              ? onEdit({ byNthDay: { nth, day: WEEKDAYS[seed.getDay()] }, byMonthDay: undefined })
              : onEdit({ byMonthDay: seed.getDate(), byNthDay: undefined })
          }
          className={small + ' w-full'}
        >
          <option value="day">On day {seed.getDate()}</option>
          <option value="nth">
            On the {nth === -1 ? 'last' : ['', 'first', 'second', 'third', 'fourth', 'fifth'][nth]}{' '}
            {format(seed, 'EEEE')}
          </option>
        </select>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        <span>Ends</span>
        <select value={ends} onChange={(e) => setEnds(e.target.value as typeof ends)} className={small}>
          <option value="never">Never</option>
          <option value="on">On date</option>
          <option value="after">After</option>
        </select>
        {ends === 'on' && (
          <input
            type="date"
            value={rule.until ?? ''}
            onChange={(e) => e.target.value && onEdit({ until: e.target.value })}
            className={small}
          />
        )}
        {ends === 'after' && (
          <>
            <input
              type="number"
              min={1}
              max={999}
              value={rule.count ?? 10}
              onChange={(e) => onEdit({ count: Math.max(1, Math.min(999, Number(e.target.value) || 1)) })}
              className={small + ' w-16 tabular-nums'}
            />
            <span>times</span>
          </>
        )}
      </div>

      <p className="text-[11px] text-ink-faint">{describeRule(rule, seed)}</p>
    </div>
  );
}
