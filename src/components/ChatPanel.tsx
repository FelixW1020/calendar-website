import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { useStore, uid } from '../store';
import { parse } from '../lib/dates';
import { AssistantError, resetConversation, sendToAssistant } from '../lib/assistant';
import { Close, Send, Sparkle } from './Icons';

const SUGGESTIONS = [
  'Lunch with Priya Thursday at 1',
  'Block 9–11 tomorrow for deep work',
  'Gym Monday and Wednesday at 7am',
  'What do I have on Friday?',
];

interface Props {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onOpenSettings: () => void;
  /** Sheet state, used below the md breakpoint where the panel is an overlay. */
  open: boolean;
  onClose: () => void;
}

export default function ChatPanel({ inputRef, onOpenSettings, open, onClose }: Props) {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.chatBusy);
  const confirmation = useStore((s) => s.confirmation);
  const resolveConfirmation = useStore((s) => s.resolveConfirmation);
  const apiKey = useStore((s) => s.apiKey);
  const setApiKey = useStore((s) => s.setApiKey);

  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat, busy, confirmation]);

  const send = async (raw: string) => {
    const content = raw.trim();
    if (!content || busy) return;
    const store = useStore.getState();
    if (!store.apiKey) return;

    setText('');
    store.pushChat({ id: uid(), role: 'user', text: content });

    const replyId = uid();
    store.pushChat({ id: replyId, role: 'assistant', text: '', actions: [], pending: true });
    store.setChatBusy(true);

    const actions: string[] = [];

    try {
      const reply = await sendToAssistant(
        content,
        {
          getEvents: () => useStore.getState().events,
          getCalendars: () => useStore.getState().calendars,
          createEvent: (e) => useStore.getState().createEvent(e),
          updateEvent: (id, patch) => useStore.getState().updateEvent(id, patch),
          deleteEvent: (id) => useStore.getState().deleteEvent(id),
          confirm: (prompt) => useStore.getState().askConfirmation(prompt),
          onAction: (line) => {
            actions.push(line);
            useStore.getState().patchChat(replyId, { actions: [...actions] });
          },
          onEventTouched: (ev) => {
            // Follow the change so the user sees what just happened.
            useStore.getState().setAnchor(parse(ev.start));
          },
        },
        store.apiKey,
      );
      useStore.getState().patchChat(replyId, { text: reply, pending: false, actions: [...actions] });
    } catch (err) {
      const message =
        err instanceof AssistantError ? err.message : err instanceof Error ? err.message : String(err);
      useStore.getState().patchChat(replyId, { text: message, pending: false, error: true, actions: [...actions] });
      if (err instanceof AssistantError && err.kind === 'auth') {
        setApiKey(null);
      }
    } finally {
      useStore.getState().setChatBusy(false);
    }
  };

  return (
    <section
      className={
        'flex shrink-0 flex-col border-line bg-panel ' +
        // Full-screen sheet below md (the header is two rows tall there, so a
        // partial sheet would cover the nav); a static column at md and up.
        'fixed inset-0 z-50 shadow-2xl transition-transform duration-200 ' +
        (open ? 'translate-y-0' : 'translate-y-full') +
        ' md:static md:z-auto md:w-80 md:translate-y-0 md:border-l md:shadow-none xl:w-96'
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <Sparkle className="h-4 w-4 text-accent" />
        <span className="font-display text-base text-ink">Assistant</span>
        <div className="ml-auto flex items-center gap-3">
          {chat.length > 0 && (
            <button
              onClick={() => {
                useStore.getState().clearChat();
                resetConversation();
              }}
              className="text-xs text-ink-faint hover:text-ink"
            >
              Clear
            </button>
          )}
          <button
            onClick={onOpenSettings}
            title={apiKey ? 'API key connected' : 'No API key'}
            className="flex items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
          >
            <span
              className={
                'h-1.5 w-1.5 rounded-full ' + (apiKey ? 'bg-emerald-500' : 'bg-ink-faint')
              }
            />
            Key
          </button>
          <button
            onClick={onClose}
            aria-label="Close assistant"
            className="rounded p-1 text-ink-faint hover:text-ink md:hidden"
          >
            <Close />
          </button>
        </div>
      </div>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {chat.length === 0 && (
          <div className="space-y-3 pt-2">
            <p className="text-sm leading-relaxed text-ink-soft">
              Describe what you want on the calendar and it gets added. You can also ask what&apos;s
              coming up, move things, or cancel them.
            </p>
            {!apiKey && (
              <button
                onClick={onOpenSettings}
                className="w-full rounded-lg border border-accent/50 bg-accent/[0.07] px-3 py-2 text-sm font-medium text-ink hover:bg-accent/[0.12]"
              >
                Connect a Claude API key
              </button>
            )}
            <div className="space-y-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  disabled={!apiKey}
                  className="block w-full rounded-lg border border-line px-2.5 py-1.5 text-left text-[13px] text-ink-soft transition hover:border-line-strong hover:text-ink disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {chat.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}

        {confirmation && (
          <div className="rounded-lg border border-accent/40 bg-accent/[0.07] p-3">
            <p className="text-sm text-ink">{confirmation.prompt}</p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => resolveConfirmation(true)}
                className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90"
              >
                Yes
              </button>
              <button
                onClick={() => resolveConfirmation(false)}
                className="rounded-md border border-line px-3 py-1 text-xs text-ink-soft hover:text-ink"
              >
                No
              </button>
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
        className="shrink-0 border-t border-line p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:pb-2"
      >
        <div className="flex items-end gap-2 rounded-lg border border-line bg-canvas p-1.5 focus-within:border-line-strong">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(text);
              }
            }}
            rows={1}
            placeholder={apiKey ? 'Lunch with Sam Friday at noon…' : 'Add an API key to enable the assistant'}
            disabled={!apiKey}
            className="max-h-32 min-h-[1.5rem] flex-1 resize-none bg-transparent px-1 text-sm text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed"
          />
          <button
            type="submit"
            disabled={!apiKey || busy || text.trim() === ''}
            aria-label="Send"
            className="rounded-md bg-accent p-1.5 text-white transition disabled:opacity-30"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </form>
    </section>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-ink px-3 py-1.5 text-sm text-panel">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {message.actions && message.actions.length > 0 && (
        <ul className="space-y-1">
          {message.actions.map((a, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[12px] text-ink-faint">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
              <span>{a}</span>
            </li>
          ))}
        </ul>
      )}
      {message.pending && !message.text ? (
        <Thinking />
      ) : (
        <p
          className={
            'whitespace-pre-wrap text-sm leading-relaxed ' +
            (message.error ? 'text-red-600 dark:text-red-400' : 'text-ink')
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

function Thinking() {
  return (
    <div className="flex items-center gap-1 py-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-faint"
          style={{ animationDelay: `${i * 140}ms`, animationDuration: '900ms' }}
        />
      ))}
    </div>
  );
}
