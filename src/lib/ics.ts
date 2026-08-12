import type { CalendarEvent } from '../types';
import { toLocalISO } from './dates';
import { parseRule } from './recurrence';

/**
 * Reading a calendar someone else publishes: iCalendar (RFC 5545) text in, this
 * app's events out.
 *
 * The awkward part is not the grammar, it is that the format carries timezones
 * and this calendar does not. A feed says either "13:05 UTC", "13:05 in
 * America/New_York", or "13:05, wherever you are"; all three have to become one
 * instant, which is then stored as local wall time like everything else. `Intl`
 * already ships the tz database, so the zoned case is a matter of asking it what
 * the offset was on that date rather than bundling a second copy of it.
 *
 * What a feed asks for and what this app can draw are not the same set, so
 * anything unsupported is dropped rather than approximated — see `readRule`.
 * Events arrive read-only; nothing here produces something the user can edit.
 */

/** Feeds are fetched into memory and parsed on the main thread. */
const MAX_FEED_CHARS = 4_000_000;

/** A feed with more events than this is being used as a database, not a calendar. */
const MAX_FEED_EVENTS = 2_000;

/* -------------------------------------------------------------------------- */
/* Content lines                                                              */
/* -------------------------------------------------------------------------- */

interface Prop {
  name: string;
  params: Map<string, string>;
  value: string;
}

/**
 * Undo the 75-octet line folding. A continuation is any line starting with a
 * space or tab, and the single leading whitespace character is the marker rather
 * than content.
 */
function contentLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (out.length > 0 && (raw.startsWith(' ') || raw.startsWith('\t'))) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/** Split on a delimiter that is only a delimiter outside double quotes. */
function splitUnquoted(text: string, delimiter: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === delimiter && !quoted) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/**
 * `NAME;PARAM=VALUE;PARAM="quoted:value":the value`. The colon that ends the
 * header is the first one outside quotes — a TZID is allowed to contain one.
 */
function parseLine(line: string): Prop | null {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;

  const segments = splitUnquoted(line.slice(0, colon), ';');
  const name = segments[0].trim().toUpperCase();
  if (!name) return null;

  const params = new Map<string, string>();
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    params.set(
      segment.slice(0, eq).trim().toUpperCase(),
      segment.slice(eq + 1).trim().replace(/^"|"$/g, ''),
    );
  }
  return { name, params, value: line.slice(colon + 1) };
}

/** TEXT values escape exactly four things. */
function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, ch: string) =>
    ch === 'n' || ch === 'N' ? '\n' : ch,
  );
}

/* -------------------------------------------------------------------------- */
/* Timezones                                                                  */
/* -------------------------------------------------------------------------- */

/** Built once per zone: constructing a DateTimeFormat is not cheap. */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tzid: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(tzid);
  if (cached !== undefined) return cached;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    // Not an IANA name. Outlook writes Windows zone names ("Eastern Standard
    // Time"), which nothing in the browser can resolve.
    fmt = null;
  }
  formatters.set(tzid, fmt);
  return fmt;
}

/** Minutes the zone is ahead of UTC at a given instant. */
function offsetAt(instant: number, fmt: Intl.DateTimeFormat): number {
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) parts[part.type] = part.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUTC - instant) / 60_000;
}

/**
 * A wall-clock reading in a named zone → the instant it refers to.
 *
 * The offset depends on the instant, and the instant is what we are solving
 * for, so this guesses with the offset in force at the same clock reading in
 * UTC and then corrects once. The second pass is what gets the hours either
 * side of a DST transition right; a third would only matter for a wall time
 * that does not exist, where any answer is a choice.
 */
function fromZonedWallTime(
  y: number,
  month: number,
  d: number,
  h: number,
  min: number,
  s: number,
  tzid: string,
): Date {
  const fmt = formatterFor(tzid);
  if (!fmt) return new Date(y, month, d, h, min, s);
  const wall = Date.UTC(y, month, d, h, min, s);
  const first = wall - offsetAt(wall, fmt) * 60_000;
  return new Date(wall - offsetAt(first, fmt) * 60_000);
}

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

interface IcsDate {
  date: Date;
  /** A DATE rather than a DATE-TIME — the event is all-day. */
  dateOnly: boolean;
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

export function parseIcsDate(value: string, params?: Map<string, string>): IcsDate | null {
  const m = DATE_TIME.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, min, s, zulu] = m;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(d);

  if (!h || params?.get('VALUE') === 'DATE') {
    return { date: new Date(year, month, day), dateOnly: true };
  }
  const hour = Number(h);
  const minute = Number(min);
  const second = Number(s);

  if (zulu) return { date: new Date(Date.UTC(year, month, day, hour, minute, second)), dateOnly: false };

  const tzid = params?.get('TZID');
  return {
    date: tzid
      ? fromZonedWallTime(year, month, day, hour, minute, second, tzid)
      : // No zone at all: a "floating" time, which RFC 5545 defines as the same
        // clock reading wherever it is read. That is this app's native format.
        new Date(year, month, day, hour, minute, second),
    dateOnly: false,
  };
}

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** An ISO 8601 duration as milliseconds. */
export function parseIcsDuration(value: string): number | null {
  const m = DURATION.exec(value.trim().toUpperCase());
  if (!m) return null;
  const [, sign, w, d, h, min, s] = m;
  if (!w && !d && !h && !min && !s) return null;
  const seconds =
    Number(w ?? 0) * 604_800 +
    Number(d ?? 0) * 86_400 +
    Number(h ?? 0) * 3_600 +
    Number(min ?? 0) * 60 +
    Number(s ?? 0);
  return (sign === '-' ? -seconds : seconds) * 1_000;
}

/* -------------------------------------------------------------------------- */
/* Recurrence                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Rule parts this calendar cannot expand. A rule carrying one of them describes
 * a series we would draw in the wrong places — "the last working day of the
 * month" becoming "the 31st" — so the event keeps its first occurrence and
 * loses the repeat. One event missing its siblings is a visibly incomplete
 * feed; a series landing on invented dates looks correct and is not.
 */
const UNSUPPORTED_PARTS = ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND'];

/**
 * An RRULE from a feed, in the form `lib/recurrence` understands, or undefined
 * when it cannot be honoured faithfully.
 */
export function readRule(raw: string, seed: Date): string | undefined {
  const parts = new Map<string, string>();
  for (const chunk of raw.trim().replace(/^RRULE:/i, '').split(';')) {
    const eq = chunk.indexOf('=');
    if (eq > 0) parts.set(chunk.slice(0, eq).trim().toUpperCase(), chunk.slice(eq + 1).trim());
  }
  if (UNSUPPORTED_PARTS.some((p) => parts.has(p))) return undefined;

  // BYMONTH is only ever redundant here: a yearly rule already repeats in the
  // month its first occurrence falls in. Anything else it could mean is a
  // series we would place wrongly.
  const byMonth = parts.get('BYMONTH');
  if (byMonth && !(parts.get('FREQ')?.toUpperCase() === 'YEARLY' && Number(byMonth) === seed.getMonth() + 1)) {
    return undefined;
  }
  parts.delete('BYMONTH');

  // UNTIL is usually a UTC instant, and this app reads it as a local date. Late
  // evening in UTC is the next day for half the world, so convert rather than
  // truncate — otherwise a series ends a day late every time.
  const until = parts.get('UNTIL');
  if (until) {
    const parsed = parseIcsDate(until);
    if (!parsed) return undefined;
    const d = parsed.date;
    const pad = (n: number) => String(n).padStart(2, '0');
    parts.set('UNTIL', `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`);
  }

  const text = [...parts].map(([k, v]) => `${k}=${v}`).join(';');
  // The final word on whether we can draw it belongs to the expander itself.
  return parseRule(text) ? text : undefined;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export interface ParsedFeed {
  /** The publisher's name for the calendar, when it gives one. */
  name?: string;
  events: CalendarEvent[];
  /** Events the feed contained but this calendar cannot draw. */
  skipped: number;
}

/**
 * `~` separates a series master from an occurrence everywhere else in the app,
 * so an id built from a feed's UID must not contain one.
 */
function safeId(text: string): string {
  return text.replace(/~/g, '-');
}

function first(props: Prop[], name: string): Prop | undefined {
  return props.find((p) => p.name === name);
}

function text(props: Prop[], name: string): string | undefined {
  const prop = first(props, name);
  if (!prop) return undefined;
  const value = unescapeText(prop.value).trim();
  return value || undefined;
}

function toEvent(
  props: Prop[],
  calendarId: string,
  fallbackUid: string,
  fetchedAt: string,
): CalendarEvent | null {
  // A cancelled occurrence is published as a tombstone, not as something to draw.
  if (text(props, 'STATUS')?.toUpperCase() === 'CANCELLED') return null;

  const dtstart = first(props, 'DTSTART');
  const start = dtstart && parseIcsDate(dtstart.value, dtstart.params);
  if (!start) return null;

  const dtend = first(props, 'DTEND');
  const parsedEnd = dtend && parseIcsDate(dtend.value, dtend.params);
  const duration = text(props, 'DURATION');
  const durationMs = duration ? parseIcsDuration(duration) : null;

  let end: Date;
  if (parsedEnd) {
    end = parsedEnd.date;
  } else if (durationMs !== null) {
    end = new Date(start.date.getTime() + durationMs);
  } else if (start.dateOnly) {
    end = new Date(start.date.getTime() + 86_400_000);
  } else {
    // RFC 5545: a DATE-TIME start with neither DTEND nor DURATION is an event
    // of no duration.
    end = start.date;
  }

  // An all-day DTEND is exclusive — Aug 6th means "through the 5th" — while
  // this app stores the last day it covers, at the end of that day.
  if (start.dateOnly) {
    const last = new Date(end.getTime() - 86_400_000);
    const day = last < start.date ? start.date : last;
    end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 0, 0);
  } else if (end < start.date) {
    end = start.date;
  }

  const uid = safeId(text(props, 'UID') ?? fallbackUid);
  const recurrenceIdProp = first(props, 'RECURRENCE-ID');
  const recurrenceId = recurrenceIdProp
    ? parseIcsDate(recurrenceIdProp.value, recurrenceIdProp.params)
    : null;

  const rrule = text(props, 'RRULE');
  const rule = rrule && !recurrenceId ? readRule(rrule, start.date) : undefined;

  const exdates: string[] = [];
  for (const prop of props) {
    if (prop.name !== 'EXDATE') continue;
    for (const one of prop.value.split(',')) {
      const parsed = parseIcsDate(one, prop.params);
      if (parsed) exdates.push(toLocalISO(parsed.date));
    }
  }

  const stamp = text(props, 'LAST-MODIFIED') ?? text(props, 'DTSTAMP');
  const modified = stamp ? parseIcsDate(stamp)?.date : undefined;

  return {
    // An overridden occurrence needs an id of its own, distinct from the series
    // it belongs to.
    id: recurrenceId ? `${calendarId}:${uid}:${toLocalISO(recurrenceId.date)}` : `${calendarId}:${uid}`,
    title: text(props, 'SUMMARY') ?? '(untitled)',
    description: text(props, 'DESCRIPTION'),
    location: text(props, 'LOCATION'),
    start: toLocalISO(start.date),
    end: toLocalISO(end),
    allDay: start.dateOnly,
    calendarId,
    recurrence: rule,
    exdates: exdates.length > 0 ? exdates : undefined,
    recurrenceId: recurrenceId ? `${calendarId}:${uid}` : undefined,
    originalStart: recurrenceId ? toLocalISO(recurrenceId.date) : undefined,
    readOnly: true,
    createdAt: modified ? toLocalISO(modified) : fetchedAt,
    updatedAt: modified ? toLocalISO(modified) : fetchedAt,
  };
}

/**
 * Parse a whole feed. `calendarId` is the calendar its events will belong to and
 * doubles as the prefix that keeps ids from two feeds apart.
 */
export function parseICS(source: string, calendarId: string): ParsedFeed {
  const fetchedAt = toLocalISO(new Date());
  const events: CalendarEvent[] = [];
  let name: string | undefined;
  let skipped = 0;

  // Components nest — VALARM inside VEVENT, and VTIMEZONE has its own DTSTARTs
  // — so properties are only collected while VEVENT is the innermost one.
  const stack: string[] = [];
  let current: Prop[] | null = null;

  for (const line of contentLines(source)) {
    const prop = parseLine(line);
    if (!prop) continue;

    if (prop.name === 'BEGIN') {
      const component = prop.value.trim().toUpperCase();
      stack.push(component);
      if (component === 'VEVENT') current = [];
      continue;
    }

    if (prop.name === 'END') {
      const closed = stack.pop();
      if (closed === 'VEVENT' && current) {
        const event = toEvent(current, calendarId, `no-uid-${events.length + skipped}`, fetchedAt);
        if (event) events.push(event);
        else skipped++;
        current = null;
        if (events.length >= MAX_FEED_EVENTS) break;
      }
      continue;
    }

    const inside = stack[stack.length - 1];
    if (inside === 'VEVENT' && current) current.push(prop);
    else if (inside === 'VCALENDAR' && prop.name === 'X-WR-CALNAME') name = unescapeText(prop.value).trim();
  }

  // A feed that republishes the same UID keeps its last word on it.
  const byId = new Map(events.map((e) => [e.id, e]));
  return { name: name || undefined, events: [...byId.values()], skipped };
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Most publishers serve iCalendar without an `Access-Control-Allow-Origin`
 * header — Google, iCloud and Outlook all do — which a browser refuses to read
 * across origins. With no server of our own to fetch on the user's behalf, the
 * only way through is a public relay, and that means handing the feed URL to a
 * third party. A subscription link is often a capability in itself, so this is
 * never automatic: `useProxy` is a per-feed decision the user makes after being
 * told what it costs.
 */
export const RELAY_HOST = 'api.allorigins.win';

const RELAY = `https://${RELAY_HOST}/raw?url=`;

export type FeedFailure = 'bad-url' | 'blocked' | 'http' | 'not-ics' | 'too-big';

export type FetchResult =
  | { ok: true; feed: ParsedFeed }
  | { ok: false; kind: FeedFailure; message: string };

/**
 * `webcal:` is the conventional scheme for a subscription link and is plain
 * HTTPS underneath; clicking one is what hands it to a desktop calendar app.
 */
export function normalizeFeedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^webcal:\/\//i.test(trimmed)
    ? `https://${trimmed.replace(/^webcal:\/\//i, '')}`
    : /^[a-z]+:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

export async function fetchFeed(
  rawUrl: string,
  options: { useProxy?: boolean; signal?: AbortSignal; calendarId: string },
): Promise<FetchResult> {
  const url = normalizeFeedUrl(rawUrl);
  if (!url) return { ok: false, kind: 'bad-url', message: 'That is not a calendar address.' };

  const target = options.useProxy ? RELAY + encodeURIComponent(url) : url;

  // No custom headers: adding one turns this into a preflighted request, and a
  // feed that will not answer a preflight is a feed we cannot read at all.
  const attempt = () => fetch(target, { signal: options.signal, redirect: 'follow' });

  let response: Response | null;
  try {
    response = await attempt();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    response = null;
  }

  /**
   * The relay goes down in bursts, and its gateway errors carry no CORS header
   * of their own — so from here they are indistinguishable from the block that
   * sent us to the relay in the first place, arriving as a thrown fetch rather
   * than a status. Neither says anything about the address the user typed, so
   * one retry is worth more than a confident wrong diagnosis.
   */
  if (options.useProxy && (!response || response.status >= 500)) {
    await delay(900, options.signal);
    try {
      response = await attempt();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      response = null;
    }
  }

  if (!response) {
    return {
      ok: false,
      kind: 'blocked',
      message: options.useProxy
        ? `The relay (${RELAY_HOST}) is not answering. This is usually temporary — ` +
          'the calendar itself is probably fine. Try again in a few minutes.'
        : "This calendar doesn't allow browsers to read it directly.",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: 'http',
      message:
        response.status === 404
          ? 'No calendar at that address (404).'
          : response.status >= 500
            ? `Could not fetch the calendar right now (${response.status}). Try again shortly.`
            : `The server answered ${response.status}.`,
    };
  }

  const body = await response.text();
  if (body.length > MAX_FEED_CHARS) {
    return { ok: false, kind: 'too-big', message: 'That calendar is too large to load in a browser.' };
  }
  if (!body.includes('BEGIN:VCALENDAR')) {
    return {
      ok: false,
      kind: 'not-ics',
      message: 'That address returned a web page rather than a calendar file.',
    };
  }

  return { ok: true, feed: parseICS(body, options.calendarId) };
}
