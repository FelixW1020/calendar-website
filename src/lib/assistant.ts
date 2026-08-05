import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta';
import { addMinutes, format } from 'date-fns';
import type { Calendar, CalendarEvent, ChatImage } from '../types';
import type { NewEvent } from '../store';
import { localTimeZone, parse, toLocalISO } from './dates';
import {
  describeEvent,
  expandEvents,
  nextOccurrence,
  parseRule,
  resolveEvent,
  type SeriesScope,
} from './recurrence';

export const MODEL = 'claude-opus-5';

/**
 * Interactive chat, so latency matters more than depth here. Opus 5 performs
 * well at lower effort; raise this if date reasoning starts slipping.
 */
const EFFORT = 'medium' as const;

/** Kept short deliberately — the calendar is the state, not the transcript. */
const HISTORY_TURNS = 12;

/**
 * Ceilings on what one tool call may return. Expanding a repeating event makes a
 * date range unbounded — a single daily event is 365 entries a year — and a
 * result that large is slow, expensive, and crowds out the rest of the turn.
 * Both tools say when they have held something back, which matters more than
 * the numbers: a silent truncation reads as "that is everything".
 */
const LIST_LIMIT = 200;
const FIND_LIMIT = 25;
const FIND_MAX = 100;

/**
 * Photos are re-sent with every later turn, so they are the expensive part of
 * the history. Keeping them for the last few messages covers the follow-up
 * ("the second one on that flyer too") without paying for them all session.
 */
const IMAGE_HISTORY_MESSAGES = 4;

export interface AssistantDeps {
  getEvents: () => CalendarEvent[];
  getCalendars: () => Calendar[];
  createEvent: (e: NewEvent) => CalendarEvent;
  /** `id` may name a single occurrence; `scope` says how far the edit reaches. */
  updateEvent: (id: string, patch: Partial<NewEvent>, scope: SeriesScope) => CalendarEvent | null;
  deleteEvent: (id: string, scope: SeriesScope) => CalendarEvent | null;
  /** Resolves true if the user approved a destructive action. */
  confirm: (prompt: string) => Promise<boolean>;
  /** Called with a human-readable line for each tool the model runs. */
  onAction: (line: string) => void;
  /** Offers the user a way back from a change, as the two snapshots around it. */
  onUndoable: (before: CalendarEvent[], after: CalendarEvent[], label: string) => void;
  /** Called when an event is created or changed, so the view can follow it. */
  onEventTouched: (event: CalendarEvent) => void;
}

/* -------------------------------------------------------------------------- */
/* Conversation history                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Only plain user/assistant text is retained. Storing tool_use blocks would
 * risk orphaning a tool_result when the history is trimmed, which the API
 * rejects; the model can always re-read the calendar with list_events.
 */
let history: BetaMessageParam[] = [];

export function resetConversation(): void {
  history = [];
}

/** Trim to the recent window, and drop photos that have fallen out of the recent one. */
function trimHistory(): void {
  if (history.length > HISTORY_TURNS) history = history.slice(-HISTORY_TURNS);

  const stale = history.length - IMAGE_HISTORY_MESSAGES;
  history = history.map((message, i) => {
    if (i >= stale || !Array.isArray(message.content)) return message;
    const kept = message.content.filter((block) => block.type !== 'image');
    if (kept.length === message.content.length) return message;
    return {
      ...message,
      // A message that was nothing but photos still needs content to be valid.
      content: kept.length > 0 ? kept : [{ type: 'text', text: '[photo, no longer attached]' }],
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

function stableSystemPrompt(calendars: Calendar[]): string {
  const names = calendars.map((c) => `"${c.name}"`).join(', ') || '"Personal"';
  return [
    'You manage the user\'s personal calendar through the provided tools. You are',
    'the fast path for scheduling: the user types something in plain language and',
    'you turn it into the right calendar change.',
    '',
    '## Resolving what the user means',
    '- Relative dates ("tomorrow", "next Thursday", "the 3rd") resolve against the',
    '  current date and timezone given below. Always compute from that, never from',
    '  memory of when "now" might be.',
    '- Bare times assume the next occurrence: "7am" said in the afternoon means',
    '  tomorrow morning. "Monday" means the upcoming Monday, not one in the past.',
    '- If a request refers to an existing event ("move my dentist appointment",',
    '  "cancel the 3pm"), call find_events or list_events first to get its id.',
    '  Never guess an id.',
    '- If the request is genuinely ambiguous in a way that changes what lands on',
    '  the calendar — an unstated day, two events that both match "lunch" — ask one',
    '  short clarifying question instead of picking for them. Do not ask about',
    '  things with a sensible default.',
    '',
    '## Defaults',
    '- Untimed meetings and appointments are 1 hour. Meals are 1 hour. "Coffee" or',
    '  a "quick call" is 30 minutes. A named span ("9-11", "for two hours") wins',
    '  over any default.',
    `- Available calendars: ${names}. Pick by obvious topic; when nothing fits,`,
    '  use the first one. Do not invent calendars.',
    '- Put genuinely useful extra detail in the description (a confirmation number,',
    '  a gate, an agenda). Do not pad it with restated title or time.',
    '',
    '## Locations',
    'Pull a place out of the request into the location field rather than leaving it',
    'buried in the title: "lunch at Blue Bottle" is title "Lunch" + location "Blue',
    'Bottle"; "standup in room 302" is location "Room 302"; "dentist at 500 Main St"',
    'is location "500 Main St". Keep an address as written — do not expand, correct,',
    'or geocode it, and never invent one you were not given. A video call link or',
    'meeting room ("Zoom", "Meet", "Conference Room B") is a location too. When the',
    'place *is* the point ("Costco run"), leave it in the title and set no location.',
    '',
    '## Photos',
    'The user can attach photos — a flyer, a screenshot of another calendar or a',
    'confirmation email, a whiteboard, a handwritten note. Read the details',
    'straight off the image and make the changes it implies; a photo sent with no',
    'message at all means "put what is in here on my calendar". Take the title,',
    'day, time and place from what is actually written, and resolve anything',
    'relative ("this Friday") against the current date below. A date with no year',
    'means the next time it comes around. If part of it is unreadable or missing,',
    'say so rather than filling it in.',
    '',
    '## Repeating events',
    'A repeating event is one event with a rule, never a pile of copies. Set',
    '`recurrence` to an RFC 5545 RRULE body — no "RRULE:" prefix, no DTSTART:',
    '  "gym every Monday and Wednesday at 7am" → FREQ=WEEKLY;BYDAY=MO,WE',
    '  "standup every weekday"                 → FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    '  "rent on the 1st"                       → FREQ=MONTHLY;BYMONTHDAY=1',
    '  "team lunch the 2nd Tuesday"            → FREQ=MONTHLY;BYDAY=2TU',
    '  "every other Friday for 10 weeks"       → FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=5',
    '  "daily until Sep 1"                     → FREQ=DAILY;UNTIL=20260901',
    'The supported parts are FREQ (DAILY/WEEKLY/MONTHLY/YEARLY), INTERVAL, BYDAY,',
    'BYMONTHDAY, COUNT and UNTIL (a plain YYYYMMDD date, inclusive). `start` is',
    'the first occurrence, so it must fall on a day the rule allows.',
    '',
    'Editing or deleting a repeating event needs a `scope`, and picking the wrong',
    'one is destructive, so read the request: "cancel gym tomorrow" is "this",',
    '"gym is at 8 from now on" is "following", "gym is always at 8" or "stop going',
    'to gym" is "all". When it is genuinely unclear, ask. Ids from list_events',
    'name one occurrence, which is what makes "this" possible — use them as given.',
    '',
    '## Cancelling things',
    'Deleting is immediate and the user has a one-click Undo for anything you',
    'remove, so do not ask "are you sure" and do not talk them through it — cancel',
    'what they asked to cancel and tell them in one line. Everything going in the',
    'same breath goes in one delete_events call: "clear my Friday" is one call with',
    'every id, not one call per event.',
    '',
    'The one thing worth a question first is *which* event: if "cancel lunch" could',
    'mean either of two lunches, ask which, and name them by day and time. Being',
    'wrong about which one is the mistake Undo is least likely to catch, because it',
    'looks like it worked.',
    '',
    'Deleting nothing is also an answer. If they ask you to cancel something that is',
    'not there, say so rather than removing the nearest thing.',
    '',
    '### Clearing out duplicates',
    'Older versions of this assistant could not repeat an event, so they wrote out',
    'a run of identical copies instead. Cleaning those up is a common request, and',
    'the way to get it wrong is to stop early:',
    '- find_events reports `shown` and `total`. If `shown` is smaller, you have not',
    '  seen them all — call it again with a higher limit. Never report "all of',
    '  them" off a partial list, and never count from a page.',
    '- Send every id in one delete_events call.',
    '- Several occurrence ids of one repeating event are ONE thing. Pass a single',
    '  id with scope "all" instead of one id per occurrence, and describe what',
    '  actually went rather than how many ids you sent.',
    '- Say which copy survived. "Removed 15 duplicate gyms, kept the Monday 7am',
    '  one" is the answer; "deleted the duplicates" is not.',
    '',
    '## Answering',
    'When the user asks what is on their schedule, read it back and create nothing.',
    '',
    '## Style',
    'Reply in one or two short sentences confirming what changed, in the same',
    'plain language the user used. No preamble, no bulleted summary of a single',
    'action, no restating the whole event back when a short confirmation will do.',
    'The change is already visible on the calendar next to you.',
    'Moves to a different day are confirmed with the user by the tools themselves —',
    'do not ask for permission separately, just call the tool.',
  ].join('\n');
}

function volatileContext(calendars: Calendar[]): string {
  const now = new Date();
  return [
    `Current date and time: ${format(now, "EEEE, MMMM d, yyyy 'at' h:mm a")}`,
    `Timezone: ${localTimeZone()}`,
    `Today in ISO form: ${format(now, 'yyyy-MM-dd')}`,
    '',
    'Calendars (id — name):',
    ...calendars.map((c) => `- ${c.id} — ${c.name}`),
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Tool helpers                                                               */
/* -------------------------------------------------------------------------- */

function summarize(ev: CalendarEvent, calendars: Calendar[]) {
  const cal = calendars.find((c) => c.id === ev.calendarId);
  const repeats = describeEvent(ev);
  return {
    id: ev.id,
    title: ev.title,
    start: ev.start,
    end: ev.end,
    all_day: ev.allDay,
    calendar: cal?.name ?? ev.calendarId,
    ...(ev.location ? { location: ev.location } : {}),
    ...(ev.description ? { description: ev.description } : {}),
    // Present on every occurrence of a series, so the model can see that an id
    // it is about to change belongs to one.
    ...(repeats ? { repeats, recurrence: ev.recurrence } : {}),
  };
}

function scopeOf(value: string | undefined): SeriesScope {
  return value === 'this' || value === 'following' ? value : 'all';
}

function resolveCalendarId(calendars: Calendar[], wanted?: string): string {
  if (!wanted) return calendars[0]?.id ?? 'personal';
  const lower = wanted.toLowerCase();
  const hit =
    calendars.find((c) => c.id.toLowerCase() === lower) ??
    calendars.find((c) => c.name.toLowerCase() === lower) ??
    calendars.find((c) => c.name.toLowerCase().includes(lower));
  return hit?.id ?? calendars[0]?.id ?? 'personal';
}

/** Accepts "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm[:ss][offset]". */
function parseModelDate(value: string, endOfDay = false): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (dateOnly) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not read "${value}" as a date. Use YYYY-MM-DD or YYYY-MM-DDTHH:mm.`);
  }
  return parsed;
}

function prettyWhen(ev: CalendarEvent): string {
  const s = parse(ev.start);
  if (ev.allDay) return format(s, 'EEE MMM d');
  return format(s, "EEE MMM d 'at' h:mm a");
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

export function buildTools(deps: AssistantDeps) {
  const cals = () => deps.getCalendars();

  const listEvents = betaTool({
    name: 'list_events',
    description:
      'List every event between two dates, inclusive. Use this to answer questions ' +
      'about the schedule and to check for conflicts before creating something. ' +
      'Returns { events, truncated? } — when `truncated` is present you are NOT ' +
      'seeing everything in that range.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'First day to include, YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'Last day to include, YYYY-MM-DD.' },
      },
      required: ['start_date', 'end_date'],
      additionalProperties: false,
    },
    run: async ({ start_date, end_date }) => {
      const from = parseModelDate(start_date);
      const to = parseModelDate(end_date, true);
      // Repeating events are expanded here, so what the model sees over a range
      // is what the user sees on the grid — one entry per occurrence, each with
      // an id that can be edited on its own. That also means a wide range is
      // unbounded: one daily event covers a year in 365 entries, which is why
      // this is capped rather than returned whole.
      const hits = expandEvents(deps.getEvents(), from, to)
        .filter((ev) => parse(ev.start) <= to && parse(ev.end) >= from)
        .sort((a, b) => a.start.localeCompare(b.start));
      const shown = hits.slice(0, LIST_LIMIT);

      deps.onAction(`Read ${start_date} → ${end_date} (${hits.length} event${hits.length === 1 ? '' : 's'})`);
      return JSON.stringify({
        events: shown.map((ev) => summarize(ev, cals())),
        ...(hits.length > shown.length
          ? {
              truncated: {
                shown: shown.length,
                matching: hits.length,
                advice:
                  'This is a partial answer. Ask for a shorter range rather than ' +
                  'acting as though this were the whole calendar.',
              },
            }
          : {}),
      });
    },
  });

  const findEvents = betaTool({
    name: 'find_events',
    description:
      'Search events by title, location, or description text. Use this to resolve a ' +
      'reference like "my dentist appointment" into an event id before updating or ' +
      'deleting it, and to gather up every copy of something. Returns ' +
      '{ matches, shown, total } — when `shown` is less than `total` there are ' +
      'more than you can see, so raise `limit` before concluding anything about ' +
      '"all" of them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for. Case-insensitive.' },
        limit: {
          type: 'integer',
          description: `Maximum results. Defaults to ${FIND_LIMIT}, up to ${FIND_MAX}.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: async ({ query, limit }) => {
      const q = query.toLowerCase().trim();
      const terms = q.split(/\s+/).filter(Boolean);
      const now = new Date();
      const scored = deps
        .getEvents()
        // A series is one row; answer with the occurrence coming up, which is
        // what "my dentist appointment" almost always means.
        .map((ev) => (ev.recurrence ? nextOccurrence(ev, now) ?? ev : ev))
        .map((ev) => {
          const hay = `${ev.title} ${ev.location ?? ''} ${ev.description ?? ''}`.toLowerCase();
          const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
          return { ev, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.ev.start.localeCompare(b.ev.start));

      const cap = Math.max(1, Math.min(FIND_MAX, limit ?? FIND_LIMIT));
      const shown = scored.slice(0, cap);

      deps.onAction(
        `Searched for "${query}" (${scored.length} match${scored.length === 1 ? '' : 'es'}` +
          `${shown.length < scored.length ? `, showing ${shown.length}` : ''})`,
      );
      // Reporting the total alongside the page is what stops "delete the
      // duplicates" from quietly finishing after the first ten of them.
      return JSON.stringify({
        matches: shown.map((r) => summarize(r.ev, cals())),
        shown: shown.length,
        total: scored.length,
        ...(shown.length < scored.length
          ? {
              advice:
                `Only ${shown.length} of ${scored.length} matches are listed. Call ` +
                'again with a higher limit before telling the user you have them all.',
            }
          : {}),
      });
    },
  });

  const createEvent = betaTool({
    name: 'create_event',
    description:
      'Add a new event to the calendar. Give start and end as local wall time in ' +
      'YYYY-MM-DDTHH:mm form; for an all-day event give plain YYYY-MM-DD dates instead.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, in the user\'s own words.' },
        start: { type: 'string', description: 'YYYY-MM-DDTHH:mm, or YYYY-MM-DD if all_day.' },
        end: { type: 'string', description: 'Same format as start. Omit to use the default duration.' },
        all_day: { type: 'boolean' },
        description: { type: 'string' },
        location: { type: 'string' },
        calendar: { type: 'string', description: 'Calendar name or id.' },
        duration_minutes: {
          type: 'integer',
          description: 'Alternative to end. Ignored when end is given.',
        },
        recurrence: {
          type: 'string',
          description:
            'Makes this a repeating event. An RRULE body such as ' +
            '"FREQ=WEEKLY;BYDAY=MO,WE" or "FREQ=MONTHLY;BYMONTHDAY=1;COUNT=12". ' +
            'start is the first occurrence. Omit for a one-off.',
        },
      },
      required: ['title', 'start'],
      additionalProperties: false,
    },
    run: async (args) => {
      const allDay = args.all_day ?? false;
      const start = parseModelDate(args.start);
      let end: Date;
      if (args.end) {
        end = parseModelDate(args.end, allDay);
      } else if (args.duration_minutes) {
        end = addMinutes(start, args.duration_minutes);
      } else if (allDay) {
        end = parseModelDate(args.start, true);
      } else {
        end = addMinutes(start, 60);
      }
      if (end <= start) end = addMinutes(start, allDay ? 24 * 60 : 60);

      if (args.recurrence && !parseRule(args.recurrence)) {
        return JSON.stringify({
          error:
            `"${args.recurrence}" is not a rule I can read. Use FREQ with ` +
            'DAILY, WEEKLY, MONTHLY or YEARLY, optionally with INTERVAL, BYDAY, ' +
            'BYMONTHDAY, COUNT or UNTIL=YYYYMMDD.',
        });
      }

      const ev = deps.createEvent({
        title: args.title,
        start: toLocalISO(start),
        end: toLocalISO(end),
        allDay,
        description: args.description,
        location: args.location,
        calendarId: resolveCalendarId(cals(), args.calendar),
        recurrence: args.recurrence || undefined,
      });
      const repeats = describeEvent(ev);
      deps.onAction(
        `Added "${ev.title}" — ${prettyWhen(ev)}${repeats ? `, ${repeats.toLowerCase()}` : ''}`,
      );
      deps.onEventTouched(ev);
      return JSON.stringify({ created: summarize(ev, cals()) });
    },
  });

  const updateEvent = betaTool({
    name: 'update_event',
    description:
      'Change an existing event. Pass only the fields that change. Get the id from ' +
      'find_events or list_events first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        start: { type: 'string', description: 'YYYY-MM-DDTHH:mm, or YYYY-MM-DD if all-day.' },
        end: { type: 'string' },
        all_day: { type: 'boolean' },
        description: { type: 'string' },
        location: { type: 'string' },
        calendar: { type: 'string' },
        recurrence: {
          type: 'string',
          description:
            'A new repeat rule (RRULE body), or an empty string to stop it ' +
            'repeating. Changing this always applies to the whole series.',
        },
        scope: {
          type: 'string',
          enum: ['this', 'following', 'all'],
          description:
            'Required for a repeating event: whether the change is to this one ' +
            'occurrence, this and every later one, or the entire series.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (args) => {
      const existing = resolveEvent(deps.getEvents(), args.id);
      if (!existing) {
        return JSON.stringify({
          error: `No event with id ${args.id}. Call find_events to get a current id.`,
        });
      }
      const scope = scopeOf(args.scope);
      const repeats = Boolean(describeEvent(existing));

      const patch: Partial<NewEvent> = {};
      if (args.recurrence !== undefined) {
        if (args.recurrence && !parseRule(args.recurrence)) {
          return JSON.stringify({ error: `"${args.recurrence}" is not a rule I can read.` });
        }
        patch.recurrence = args.recurrence || undefined;
      }
      if (args.title !== undefined) patch.title = args.title;
      if (args.description !== undefined) patch.description = args.description;
      if (args.location !== undefined) {
        patch.location = args.location;
        // The old coordinates belong to the old address; the editor re-resolves
        // the new one when it is next opened.
        patch.place = undefined;
      }
      if (args.all_day !== undefined) patch.allDay = args.all_day;
      if (args.calendar !== undefined) patch.calendarId = resolveCalendarId(cals(), args.calendar);

      const allDay = patch.allDay ?? existing.allDay;
      let newStart = parse(existing.start);
      let newEnd = parse(existing.end);
      if (args.start !== undefined) newStart = parseModelDate(args.start);
      if (args.end !== undefined) newEnd = parseModelDate(args.end, allDay);
      if (args.start !== undefined && args.end === undefined) {
        // Moving an event keeps its length unless a new end is given.
        const len = parse(existing.end).getTime() - parse(existing.start).getTime();
        newEnd = new Date(newStart.getTime() + len);
      }
      if (newEnd <= newStart) newEnd = addMinutes(newStart, 60);
      if (args.start !== undefined || args.end !== undefined) {
        patch.start = toLocalISO(newStart);
        patch.end = toLocalISO(newEnd);
      }

      // Confirmation gate: silent edits are fine, but moving an event to a
      // different day is the kind of thing the user wants to see first — and so
      // is any edit that reaches past the one occurrence that was asked about.
      const movesDay =
        patch.start !== undefined && format(newStart, 'yyyy-MM-dd') !== format(parse(existing.start), 'yyyy-MM-dd');
      const reachesOthers = repeats && scope !== 'this';
      if (movesDay || reachesOthers) {
        const what = movesDay
          ? `Move "${existing.title}" from ${prettyWhen(existing)} to ${format(newStart, "EEE MMM d 'at' h:mm a")}`
          : `Change "${existing.title}"`;
        const which = reachesOthers
          ? scope === 'all'
            ? ' — every occurrence of this repeating event'
            : ' — this and every later occurrence'
          : '';
        const ok = await deps.confirm(`${what}${which}?`);
        if (!ok) {
          deps.onAction(`Change to "${existing.title}" declined`);
          return JSON.stringify({
            cancelled: true,
            reason: 'The user declined this change. Do not retry it; ask what they want instead.',
          });
        }
      }

      const updated = deps.updateEvent(args.id, patch, scope);
      if (!updated) return JSON.stringify({ error: 'Update failed; the event no longer exists.' });
      deps.onAction(`Updated "${updated.title}" — ${prettyWhen(updated)}`);
      deps.onEventTouched(updated);
      return JSON.stringify({ updated: summarize(updated, cals()) });
    },
  });

  const deleteEvents = betaTool({
    name: 'delete_events',
    description:
      'Remove events. Pass every event being removed in ONE call — never one call ' +
      'per event. Deleting takes effect immediately and the user gets a one-click ' +
      'Undo, so do not ask for permission first; just do it and say what you did. ' +
      'Do ask first when you cannot tell which event they meant. Get ids from ' +
      'find_events or list_events.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Every event to remove, together.',
        },
        scope: {
          type: 'string',
          enum: ['this', 'following', 'all'],
          description:
            'For repeating events only: remove just the occurrence named by the ' +
            'id, that one and every later one, or the whole series. Defaults to ' +
            'the whole series, so pass "this" when they mean one day.',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    run: async ({ ids, scope: wanted }) => {
      const scope = scopeOf(wanted);
      const before = deps.getEvents();

      // Several ids can name the same thing. Five occurrence ids of one weekly
      // series are five events on the grid, but deleting the series is one act —
      // and doing it five times would report five deletions that never happened.
      const seen = new Set<string>();
      const found: { id: string; event: CalendarEvent }[] = [];
      for (const id of ids) {
        const event = resolveEvent(before, id);
        if (!event) continue;
        const unit = scope === 'this' ? id : event.recurrenceId ?? event.id;
        if (seen.has(unit)) continue;
        seen.add(unit);
        found.push({ id, event });
      }
      const missing = ids.filter((id) => !resolveEvent(before, id));

      if (found.length === 0) {
        return JSON.stringify({
          error:
            'None of those ids are on the calendar. Call find_events or list_events ' +
            'for current ids rather than guessing.',
        });
      }

      for (const { id } of found) deps.deleteEvent(id, scope);

      const gone = found.map((t) => t.event);
      // A repeating event only counts as a series when the scope reaches past
      // the one occurrence named.
      const series = scope === 'this' ? [] : gone.filter((e) => describeEvent(e));
      const singles = gone.length - series.length;
      const reach = scope === 'following' ? 'and every later occurrence' : 'and every repeat of it';

      let label: string;
      if (gone.length === 1) {
        label = series.length
          ? `Deleted "${gone[0].title}" ${reach}`
          : `Deleted "${gone[0].title}" — ${prettyWhen(gone[0])}`;
      } else {
        const parts = [];
        if (singles > 0) parts.push(`${singles} event${singles === 1 ? '' : 's'}`);
        if (series.length > 0) {
          parts.push(`${series.length} repeating event${series.length === 1 ? '' : 's'} ${reach}`);
        }
        label = `Deleted ${parts.join(' and ')}`;
      }

      deps.onAction(label);
      // Handing back both snapshots lets one Undo reverse the whole call, which
      // matters most when it removed more than the user expected.
      deps.onUndoable(before, deps.getEvents(), label);

      return JSON.stringify({
        deleted: gone.map((e) => ({
          id: e.id,
          title: e.title,
          when: prettyWhen(e),
          ...(series.includes(e) ? { removed: 'the whole repeating event' } : {}),
        })),
        scope,
        undo_offered: true,
        ...(seen.size < ids.length - missing.length
          ? {
              note:
                'Some of those ids were occurrences of the same repeating event, so ' +
                'they were removed once rather than one per id. Say what actually ' +
                'went, not how many ids you sent.',
            }
          : {}),
        ...(missing.length > 0
          ? { not_found: missing, note_missing: 'These were already gone; mention only if it matters.' }
          : {}),
      });
    },
  });

  return [listEvents, findEvents, createEvent, updateEvent, deleteEvents];
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export class AssistantError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate_limit' | 'network' | 'refusal' | 'unknown',
  ) {
    super(message);
  }
}

export function makeClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    // The key lives in this browser. Acceptable for a personal, single-user
    // site; see README "Where the key lives" before deploying anywhere public.
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
}

/** One cheap round-trip to check a pasted key before we store it. */
export async function validateKey(apiKey: string): Promise<void> {
  const client = makeClient(apiKey);
  try {
    await client.messages.create({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (err) {
    throw toAssistantError(err);
  }
}

function toAssistantError(err: unknown): AssistantError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new AssistantError('That API key was rejected. Check it and paste it again.', 'auth');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AssistantError('That key does not have access to this model.', 'auth');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AssistantError('Rate limited by the API. Give it a moment and try again.', 'rate_limit');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AssistantError(
      'Could not reach the Anthropic API. Check your connection — and if this is a ' +
        'fresh deploy, check the browser-access note in the README.',
      'network',
    );
  }
  if (err instanceof Anthropic.APIError) {
    return new AssistantError(`API error ${err.status ?? ''}: ${err.message}`, 'unknown');
  }
  return new AssistantError(err instanceof Error ? err.message : String(err), 'unknown');
}

export async function sendToAssistant(
  userText: string,
  deps: AssistantDeps,
  apiKey: string,
  images: ChatImage[] = [],
): Promise<string> {
  const client = makeClient(apiKey);
  const calendars = deps.getCalendars();

  if (images.length === 0) {
    history.push({ role: 'user', content: userText });
  } else {
    history.push({
      role: 'user',
      content: [
        ...images.map((img) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
        })),
        // An empty text block is rejected, so a photo-only message sends no text
        // at all and leans on the Photos section of the prompt.
        ...(userText ? [{ type: 'text' as const, text: userText }] : []),
      ],
    });
  }
  trimHistory();

  try {
    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      system: [
        {
          type: 'text',
          text: stableSystemPrompt(calendars),
          // Everything above this point is byte-identical between requests, so
          // tools + system cache together. The clock below must stay *after*
          // the breakpoint or the prefix changes every turn and nothing caches.
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: volatileContext(calendars) },
      ],
      tools: buildTools(deps),
      messages: history,
      max_iterations: 12,
    });

    const final = await runner;

    if (final.stop_reason === 'refusal') {
      throw new AssistantError('The model declined to answer that one.', 'refusal');
    }

    const text = final.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const reply = text || 'Done.';
    history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (err) {
    // Drop the failed turn so a retry does not stack duplicate user messages.
    history = history.filter((m, i) => !(i === history.length - 1 && m.role === 'user'));
    throw err instanceof AssistantError ? err : toAssistantError(err);
  }
}
