import { useState } from 'react';
import { useStore } from '../store';
import { AssistantError, resetConversation, validateKey } from '../lib/assistant';
import { Close, Sparkle } from './Icons';

export default function ApiKeyDialog({ onClose }: { onClose: () => void }) {
  const apiKey = useStore((s) => s.apiKey);
  const setApiKey = useStore((s) => s.setApiKey);

  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const masked = apiKey ? `${apiKey.slice(0, 11)}…${apiKey.slice(-4)}` : null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (!key) return;
    setChecking(true);
    setError(null);
    try {
      await validateKey(key);
      setApiKey(key);
      resetConversation();
      setValue('');
      onClose();
    } catch (err) {
      setError(err instanceof AssistantError ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 dark:bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-label="API key"
        className="fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-5 shadow-2xl"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded p-1 text-ink-faint hover:text-ink"
        >
          <Close />
        </button>

        <div className="mb-3 flex items-center gap-2">
          <Sparkle className="h-5 w-5 text-accent" />
          <h2 className="font-display text-xl text-ink">
            Connect the assistant
          </h2>
        </div>

        <p className="mb-4 text-sm leading-relaxed text-ink-soft">
          Paste a Claude API key to turn on natural-language scheduling. Get one from{' '}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            className="underline decoration-line-strong underline-offset-2 hover:text-ink"
          >
            console.anthropic.com
          </a>
          . The calendar itself works fine without one.
        </p>

        {masked && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-line px-3 py-2">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-faint">Current key</div>
              <code className="text-sm text-ink">{masked}</code>
            </div>
            <button
              onClick={() => {
                setApiKey(null);
                resetConversation();
              }}
              className="text-xs text-ink-soft hover:text-red-600"
            >
              Remove
            </button>
          </div>
        )}

        <form onSubmit={save} className="space-y-3">
          <input
            autoFocus
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk-ant-…"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm text-ink outline-none focus:border-line-strong"
          />

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={checking || value.trim() === ''}
            className="w-full rounded-md bg-accent py-2 text-sm font-medium text-white transition disabled:opacity-40"
          >
            {checking ? 'Checking…' : masked ? 'Replace key' : 'Save key'}
          </button>
        </form>

        <p className="mt-4 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-faint">
          The key is stored in this browser&apos;s localStorage and sent straight from this page to
          Anthropic. That means any script running on this page could read it — fine for a personal
          site you control, not fine for one with third-party scripts or other users. See the README
          for the proxy setup if you plan to publish this.
        </p>
      </div>
    </>
  );
}
