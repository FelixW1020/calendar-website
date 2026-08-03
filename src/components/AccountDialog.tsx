import { useState } from 'react';
import { useStore } from '../store';
import { syncConfigured } from '../lib/supabase';
import { signIn, signOut } from '../lib/sync';
import { Close } from './Icons';

export default function AccountDialog({ onClose }: { onClose: () => void }) {
  const sync = useStore((s) => s.sync);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(address);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
                Sign in and this calendar follows you between your phone and computer. We email a
                link — there&apos;s no password to set.
              </p>
              <input
                autoFocus
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className="w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-line-strong"
              />
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-accent py-2 text-sm font-medium text-white transition disabled:opacity-40"
              >
                {busy ? 'Sending…' : 'Email me a link'}
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
