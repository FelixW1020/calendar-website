import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Sync is optional. With no credentials configured the app runs exactly as it
 * did before — localStorage only — so a fresh clone still works.
 */
export const syncConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = syncConfigured
  ? createClient(url!, anonKey!, {
      auth: {
        // Sign in once per device and stay signed in: the session is written to
        // localStorage and the access token is renewed in the background before
        // it expires, so there is nothing to log back into.
        persistSession: true,
        autoRefreshToken: true,
        storage: window.localStorage,
        storageKey: 'calendar.auth',
        // The magic link comes back with the session in the URL.
        detectSessionInUrl: true,
      },
    })
  : null;

/** Row shapes, mirroring supabase/schema.sql. */
export interface EventRow {
  id: string;
  user_id: string;
  calendar_id: string;
  title: string;
  description: string | null;
  location: string | null;
  /** Null until the location is picked from search rather than typed. */
  place_lat: number | null;
  place_lon: number | null;
  place_label: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  /** RRULE on a series master; null on everything else. */
  recurrence: string | null;
  /** Occurrence starts removed from the series, as local-offset ISO strings. */
  exdates: string[] | null;
  /** Set on an event that replaces a single occurrence of `recurrence_id`. */
  recurrence_id: string | null;
  original_start: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CalendarRow {
  id: string;
  user_id: string;
  name: string;
  color: string;
  visible: boolean;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * A subscribed feed's address. Its events are not here — they are refetched per
 * device from the publisher, so what syncs is the subscription, not the copy.
 * `id` is shared with the calendar row that carries its name and colour.
 */
export interface SubscriptionRow {
  id: string;
  user_id: string;
  url: string;
  use_proxy: boolean;
  updated_at: string;
  deleted_at: string | null;
}
