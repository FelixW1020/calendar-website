import { useEffect, useMemo, useRef, useState } from 'react';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import TimeGrid from './components/TimeGrid';
import MonthView from './components/MonthView';
import EventEditor from './components/EventEditor';
import ChatPanel from './components/ChatPanel';
import ApiKeyDialog from './components/ApiKeyDialog';
import { useStore } from './store';
import { daysIn, step, visibleRange } from './lib/dates';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

export default function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const anchorISO = useStore((s) => s.anchor);
  const setAnchor = useStore((s) => s.setAnchor);
  const theme = useStore((s) => s.theme);
  const apiKey = useStore((s) => s.apiKey);
  const selectedEventId = useStore((s) => s.selectedEventId);

  const anchor = useMemo(() => new Date(anchorISO), [anchorISO]);
  const days = useMemo(() => daysIn(visibleRange(anchor, view)), [anchor, view]);

  const searchRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLTextAreaElement>(null);
  const [keyDialog, setKeyDialog] = useState(false);

  // Keep the DOM class in sync with the persisted theme (the inline script in
  // index.html handles the very first paint).
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // Offer the key prompt once on a cold start, then stay out of the way.
  useEffect(() => {
    if (apiKey === null && !sessionStorage.getItem('calendar.keyPrompted')) {
      sessionStorage.setItem('calendar.keyPrompted', '1');
      setKeyDialog(true);
    }
  }, [apiKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;

      switch (e.key) {
        case 'd':
          setView('day');
          break;
        case 'w':
          setView('week');
          break;
        case 'm':
          setView('month');
          break;
        case 't':
          setAnchor(new Date());
          break;
        case 'j':
        case 'ArrowLeft':
          setAnchor(step(new Date(useStore.getState().anchor), useStore.getState().view, -1));
          break;
        case 'k':
        case 'ArrowRight':
          setAnchor(step(new Date(useStore.getState().anchor), useStore.getState().view, 1));
          break;
        case 'c':
          e.preventDefault();
          chatRef.current?.focus();
          break;
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, setAnchor]);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <Header searchRef={searchRef} />

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="min-w-0 flex-1 overflow-hidden">
          {view === 'month' ? (
            <MonthView days={days} anchorMonth={anchor.getMonth()} />
          ) : (
            <TimeGrid days={days} />
          )}
        </main>

        <ChatPanel inputRef={chatRef} onOpenSettings={() => setKeyDialog(true)} />
      </div>

      {selectedEventId && <EventEditor />}
      {keyDialog && <ApiKeyDialog onClose={() => setKeyDialog(false)} />}
    </div>
  );
}
