export type ViewMode = 'day' | 'week' | 'month';

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  location?: string;
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

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
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
