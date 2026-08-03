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
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  recurrence: string | null;
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
