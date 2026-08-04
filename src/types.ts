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
  /** Reserved for v1.5 recurrence (RFC 5545 RRULE). Not expanded yet. */
  recurrence?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Calendar {
  id: string;
  name: string;
  color: string;
  visible: boolean;
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
  error?: boolean;
  pending?: boolean;
}

export interface PendingConfirmation {
  id: string;
  prompt: string;
  resolve: (ok: boolean) => void;
}
