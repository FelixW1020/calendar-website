import { useState } from 'react';
import { useStore } from '../store';
import { syncConfigured } from '../lib/supabase';
import {
  BadCredentialsError,
  MIN_PASSWORD_LENGTH,
  SyncNotOfferedError,
  WeakPasswordError,
  setPassword,
  signIn,
  signInWithPassword,
  signOut,
} from '../lib/sync';
import { Close } from './Icons';

const field =
  'w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink ' +
  'outline-none focus:border-line-strong';

export default function AccountDialog({ onClose }: { onClose: () => void }) {
  const sync = useStore((s) => s.sync);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The address has no account here — an explanation, not an error. */
  const [notOffered, setNotOffered] = useState(false);
  /**
   * A link goes to an inbox and a password does not, which is the whole point
   * of offering both. The link stays the default because it is what works on a
   * device that has never signed in.
   */
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPasswordValue] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    setNotOffered(false);
    try {
      if (usePassword) {
        await signInWithPassword(address, password);
        onClose();
        return;
      }
      await signIn(address);
      setSent(true);
    } catch (err) {
      if (err instanceof SyncNotOfferedError) setNotOffered(true);
      else if (err instanceof BadCredentialsError) {
        setError(
          'That email and password do not match. If you have not set a password yet, ' +
            'sign in with a link and set one from this dialog.',
        );
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 dark:bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Sync"
        className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-5 shadow-2xl"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded p-1 text-ink-faint hover:text-ink"
        >
          <Close />
        </button>

        <h2 className="mb-3 font-display text-xl text-ink">Sync across devices</h2>

        {!syncConfigured ? (
          <p className="text-sm leading-relaxed text-ink-soft">
            Sync isn&apos;t configured for this build, so your calendar is saved in this browser
            only — it won&apos;t appear on your other devices, and clearing site data erases it. See{' '}
            <code className="text-ink">supabase/schema.sql</code> and the README to switch it on.
          </p>
        ) : notOffered ? (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-ink-soft">
              There&apos;s no account for <span className="text-ink">{email}</span> here. This site
              is published for anyone to use, but the database behind it belongs to one person, so
              signing in is limited to them.
            </p>
            <p className="text-sm leading-relaxed text-ink-soft">
              Nothing else is held back. The calendar, the assistant and subscribed calendars all
              work exactly as they do for the owner — your events are saved in this browser, and the
              assistant runs on your own API key. What you don&apos;t get is the same calendar on
              your phone and your laptop.
            </p>
            <p className="text-sm leading-relaxed text-ink-soft">
              For that, run your own copy: it&apos;s a free Supabase project and two environment
              variables. The README has the steps.
            </p>
            <button
              onClick={() => setNotOffered(false)}
              className="text-xs text-ink-faint hover:text-ink"
            >
              Use a different address
            </button>
          </div>
        ) : sync.status === 'signed-out' || !sync.email ? (
          sent ? (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-ink-soft">
                Check <span className="text-ink">{email}</span> for a sign-in link. Opening it on any
                device signs that device in and pulls your calendar down.
              </p>
              <button
                onClick={() => setSent(false)}
                className="text-xs text-ink-faint hover:text-ink"
              >
                Use a different address
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <p className="text-sm leading-relaxed text-ink-soft">
                {usePassword
                  ? 'Sign in with the password you set on this account. Nothing to open in your inbox.'
                  : 'Sign in and this calendar follows you between your phone and computer. We email a link — no password needed.'}
              </p>
              <input
                autoFocus
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className={field}
              />
              {usePassword && (
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPasswordValue(e.target.value)}
                  placeholder="Password"
                  autoComplete="current-password"
                  className={field}
                />
              )}
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-accent py-2 text-sm font-medium text-white transition disabled:opacity-40"
              >
                {busy
                  ? usePassword
                    ? 'Signing in…'
                    : 'Sending…'
                  : usePassword
                    ? 'Sign in'
                    : 'Email me a link'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUsePassword((v) => !v);
                  setError(null);
                }}
                className="text-xs text-ink-faint hover:text-ink"
              >
                {usePassword ? 'Email me a link instead' : 'Use a password instead'}
              </button>
            </form>
          )
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-line px-3 py-2">
              <div className="text-[11px] uppercase tracking-wider text-ink-faint">Signed in as</div>
              <div className="text-sm text-ink">{sync.email}</div>
            </div>
            <p className="text-sm leading-relaxed text-ink-soft">
              {sync.status === 'live'
                ? 'Changes save automatically and appear on your other signed-in devices.'
                : sync.status === 'syncing'
                  ? 'Syncing…'
                  : sync.message ?? 'Sync error.'}
            </p>
            <PasswordSetter />

            <button
              onClick={async () => {
                await signOut();
                onClose();
              }}
              className="w-full rounded-md border border-line py-2 text-sm text-ink-soft hover:text-ink"
            >
              Sign out
            </button>
            <p className="text-[12px] leading-relaxed text-ink-faint">
              Signing out leaves the calendar on this device but stops syncing it.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Setting a password on the account you are already signed in to. This is the
 * only way one gets set, which is deliberate: an emailed link proves the
 * address, and the password is a shortcut granted afterwards rather than a
 * second way in from cold.
 */
function PasswordSetter() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (value.length < MIN_PASSWORD_LENGTH) {
      setError(`At least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setPassword(value);
      setValue('');
      setDone(true);
      setOpen(false);
    } catch (err) {
      // The project keeps its own minimum, which this dialog cannot talk it out
      // of — so say where it is set rather than leaving a bare refusal.
      setError(
        err instanceof WeakPasswordError
          ? `${err.message} That rule belongs to the Supabase project, not this ` +
            'page: Authentication → Providers → Email → Minimum password length.'
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <p className="rounded-lg border border-line px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
        Password saved. On your phone, choose <span className="text-ink">Use a password instead</span>{' '}
        and you can sign in without opening your inbox.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-line py-2 text-sm text-ink-soft hover:text-ink"
      >
        Set a password for quicker sign-in
      </button>
    );
  }

  return (
    <form onSubmit={save} className="space-y-2 rounded-lg border border-line p-3">
      <p className="text-[12px] leading-relaxed text-ink-faint">
        A password lets you sign in on a new device without waiting for an email. You type it once
        per device — the session refreshes itself after that — so a longer one costs you almost
        nothing, and a short one is the only thing standing between this calendar and anyone who
        knows your address.
      </p>
      <input
        autoFocus
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
        autoComplete="new-password"
        className={field}
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save password'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
            setValue('');
          }}
          className="rounded-md px-2 py-1.5 text-xs text-ink-soft hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
