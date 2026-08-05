export type ViewMode = 'day' | 'week' | 'month';

/**
 * A geocoded location. `label` is what the user sees and what `location`
 * carries; the coordinates are what make maps, distance and directions
 * possible. A location typed by hand (or a meeting link) has no place.
 */
export interface Place {
  lat: number;
  lon: number;
  /** The full one-line address, for the map card and directions. */
  label: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  location?: string;
  /** Set when the location was picked from a search result. */
  place?: Place;
  /** ISO 8601, local wall time with offset. */
  start: string;
  end: string;
  allDay: boolean;
  calendarId: string;
  /**
   * RFC 5545 RRULE on the series master, e.g. `FREQ=WEEKLY;BYDAY=MO,WE`. The
   * master is the first occurrence; the rest are expanded at read time. See
   * lib/recurrence.ts for the supported grammar.
   */
  recurrence?: string;
  /** Occurrence starts (ISO) removed from this series. Master only. */
  exdates?: string[];
  /** On an event that replaces one occurrence: the id of the series master. */
  recurrenceId?: string;
  /** On such an event: the occurrence start it stands in for. */
  originalStart?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Calendar {
  id: string;
  name: string;
  color: string;
  visible: boolean;
}

/**
 * Everything needed to put the calendar back exactly as it was before a change.
 * Deleting is the one action a person cannot walk back on their own, so instead
 * of asking first, the assistant does it and hands back one of these.
 */
export interface EventRestore {
  /** Rows as they were, to be put back verbatim. */
  restore: CalendarEvent[];
  /** Ids the change created, which have to go again. */
  remove: string[];
}

export type ChatRole = 'user' | 'assistant';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** A photo attached to a message, held as the base64 payload the API takes. */
export interface ChatImage {
  id: string;
  /** Original file name, kept for the tooltip and for what we tell the model. */
  name: string;
  mediaType: ImageMediaType;
  /** Base64 bytes with no `data:` prefix. */
  data: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Photos the user sent with this message. */
  images?: ChatImage[];
  /** Human-readable log of tool calls made during this turn. */
  actions?: string[];
  /** One-click undo for whatever this turn removed. */
  undo?: { label: string; events: EventRestore; done?: boolean };
  error?: boolean;
  pending?: boolean;
}

export interface PendingConfirmation {
  id: string;
  prompt: string;
  resolve: (ok: boolean) => void;
}
