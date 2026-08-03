import { useEffect, useMemo, useRef, useState } from 'react';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import TimeGrid from './components/TimeGrid';
import MonthView from './components/MonthView';
import EventEditor from './components/EventEditor';
import ChatPanel from './components/ChatPanel';
import ApiKeyDialog from './components/ApiKeyDialog';
import AccountDialog from './components/AccountDialog';
import { Sparkle } from './components/Icons';
import { useStore } from './store';
import { initSync } from './lib/sync';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // Restores the session, merges with the server, and starts realtime.
  // A no-op build without Supabase credentials stays local-only.
  useEffect(() => initSync(), []);

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

  // Close the drawer when the viewport grows past the breakpoint that hides it,
  // otherwise it lingers as an invisible focus trap.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => mq.matches && setMenuOpen(false);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setChatOpen(false);
      }
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
          setChatOpen(true);
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
      <Header
        searchRef={searchRef}
        onOpenMenu={() => setMenuOpen(true)}
        onOpenAccount={() => setAccountOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />

        <main className="min-w-0 flex-1 overflow-hidden">
          {view === 'month' ? (
            <MonthView days={days} anchorMonth={anchor.getMonth()} />
          ) : (
            <TimeGrid days={days} />
          )}
        </main>

        <ChatPanel
          inputRef={chatRef}
          onOpenSettings={() => setKeyDialog(true)}
          open={chatOpen}
          onClose={() => setChatOpen(false)}
        />
      </div>

      {/* Opens the assistant sheet on phones, where the panel is off-screen. */}
      {!chatOpen && (
        <button
          onClick={() => {
            setChatOpen(true);
            setTimeout(() => chatRef.current?.focus(), 220);
          }}
          aria-label="Open assistant"
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg transition active:scale-95 md:hidden"
        >
          <Sparkle className="h-5 w-5" />
        </button>
      )}

      {selectedEventId && <EventEditor />}
      {keyDialog && <ApiKeyDialog onClose={() => setKeyDialog(false)} />}
      {accountOpen && <AccountDialog onClose={() => setAccountOpen(false)} />}
    </div>
  );
}
