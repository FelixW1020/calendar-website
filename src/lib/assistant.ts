import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta';
import { addMinutes, format } from 'date-fns';
import type { Calendar, CalendarEvent, ChatImage } from '../types';
import type { NewEvent } from '../store';
import { localTimeZone, parse, toLocalISO } from './dates';

export const MODEL = 'claude-opus-5';

/**
 * Interactive chat, so latency matters more than depth here. Opus 5 performs
 * well at lower effort; raise this if date reasoning starts slipping.
 */
const EFFORT = 'medium' as const;

/** Kept short deliberately — the calendar is the state, not the transcript. */
const HISTORY_TURNS = 12;

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
  updateEvent: (id: string, patch: Partial<NewEvent>) => CalendarEvent | null;
  deleteEvent: (id: string) => CalendarEvent | null;
  /** Resolves true if the user approved a destructive action. */
  confirm: (prompt: string) => Promise<boolean>;
  /** Called with a human-readable line for each tool the model runs. */
  onAction: (line: string) => void;
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
    '## Recurrence',
    'Recurring events are not supported yet. If asked for one, create the next few',
    'concrete occurrences (at most 8, and say how many you made) rather than',
    'refusing outright.',
    '',
    '## Answering',
    'When the user asks what is on their schedule, read it back and create nothing.',
    '',
    '## Style',
    'Reply in one or two short sentences confirming what changed, in the same',
    'plain language the user used. No preamble, no bulleted summary of a single',
    'action, no restating the whole event back when a short confirmation will do.',
    'The change is already visible on the calendar next to you.',
    'Deletions and moves to a different day are confirmed with the user by the',
    'tools themselves — do not ask for permission separately, just call the tool.',
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
  return {
    id: ev.id,
    title: ev.title,
    start: ev.start,
    end: ev.end,
    all_day: ev.allDay,
    calendar: cal?.name ?? ev.calendarId,
    ...(ev.location ? { location: ev.location } : {}),
    ...(ev.description ? { description: ev.description } : {}),
  };
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

function buildTools(deps: AssistantDeps) {
  const cals = () => deps.getCalendars();

  const listEvents = betaTool({
    name: 'list_events',
    description:
      'List every event between two dates, inclusive. Use this to answer questions ' +
      'about the schedule and to check for conflicts before creating something.',
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
      const hits = deps
        .getEvents()
        .filter((ev) => parse(ev.start) <= to && parse(ev.end) >= from)
        .sort((a, b) => a.start.localeCompare(b.start));
      deps.onAction(`Read ${start_date} → ${end_date} (${hits.length} event${hits.length === 1 ? '' : 's'})`);
      return JSON.stringify(hits.map((ev) => summarize(ev, cals())));
    },
  });

  const findEvents = betaTool({
    name: 'find_events',
    description:
      'Search events by title, location, or description text. Use this to resolve a ' +
      'reference like "my dentist appointment" into an event id before updating or ' +
      'deleting it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for. Case-insensitive.' },
        limit: { type: 'integer', description: 'Maximum results. Defaults to 10.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: async ({ query, limit }) => {
      const q = query.toLowerCase().trim();
      const terms = q.split(/\s+/).filter(Boolean);
      const scored = deps
        .getEvents()
        .map((ev) => {
          const hay = `${ev.title} ${ev.location ?? ''} ${ev.description ?? ''}`.toLowerCase();
          const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
          return { ev, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.ev.start.localeCompare(b.ev.start))
        .slice(0, limit ?? 10);
      deps.onAction(`Searched for "${query}" (${scored.length} match${scored.length === 1 ? '' : 'es'})`);
      return JSON.stringify(scored.map((r) => summarize(r.ev, cals())));
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

      const ev = deps.createEvent({
        title: args.title,
        start: toLocalISO(start),
        end: toLocalISO(end),
        allDay,
        description: args.description,
        location: args.location,
        calendarId: resolveCalendarId(cals(), args.calendar),
      });
      deps.onAction(`Added "${ev.title}" — ${prettyWhen(ev)}`);
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
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (args) => {
      const existing = deps.getEvents().find((e) => e.id === args.id);
      if (!existing) {
        return JSON.stringify({
          error: `No event with id ${args.id}. Call find_events to get a current id.`,
        });
      }

      const patch: Partial<NewEvent> = {};
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
      // different day is the kind of thing the user wants to see first.
      const movesDay =
        patch.start !== undefined && format(newStart, 'yyyy-MM-dd') !== format(parse(existing.start), 'yyyy-MM-dd');
      if (movesDay) {
        const ok = await deps.confirm(
          `Move "${existing.title}" from ${prettyWhen(existing)} to ${format(newStart, "EEE MMM d 'at' h:mm a")}?`,
        );
        if (!ok) {
          deps.onAction(`Move of "${existing.title}" declined`);
          return JSON.stringify({
            cancelled: true,
            reason: 'The user declined this move. Do not retry it; ask what they want instead.',
          });
        }
      }

      const updated = deps.updateEvent(args.id, patch);
      if (!updated) return JSON.stringify({ error: 'Update failed; the event no longer exists.' });
      deps.onAction(`Updated "${updated.title}" — ${prettyWhen(updated)}`);
      deps.onEventTouched(updated);
      return JSON.stringify({ updated: summarize(updated, cals()) });
    },
  });

  const deleteEvent = betaTool({
    name: 'delete_event',
    description:
      'Remove an event permanently. The user is asked to confirm before this takes ' +
      'effect. Get the id from find_events or list_events first.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: async ({ id }) => {
      const existing = deps.getEvents().find((e) => e.id === id);
      if (!existing) {
        return JSON.stringify({
          error: `No event with id ${id}. Call find_events to get a current id.`,
        });
      }
      const ok = await deps.confirm(`Delete "${existing.title}" on ${prettyWhen(existing)}?`);
      if (!ok) {
        deps.onAction(`Deletion of "${existing.title}" declined`);
        return JSON.stringify({
          cancelled: true,
          reason: 'The user declined this deletion. Do not retry it; the event still exists.',
        });
      }
      deps.deleteEvent(id);
      deps.onAction(`Deleted "${existing.title}"`);
      return JSON.stringify({ deleted: { id, title: existing.title } });
    },
  });

  return [listEvents, findEvents, createEvent, updateEvent, deleteEvent];
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
