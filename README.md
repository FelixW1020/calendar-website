# Calendar

A personal calendar with Google Calendar's viewing experience and a chat box
instead of an event form. Type "lunch with Priya Thursday at 1" and it lands on
the calendar.

```bash
npm install
npm run dev      # http://localhost:5173
```

The calendar works immediately. The assistant needs a Claude API key — paste one
into the dialog on first load, or click **Key** in the assistant panel.

---

## Using it

**Views** — day, week, month. Click an empty slot to create an event, drag to
move it, drag its bottom edge to resize. Click an event to edit or delete it.

**Shortcuts**

| Key | Does |
|---|---|
| `D` `W` `M` | Day / week / month view |
| `T` | Jump to today |
| `J` `K` or `←` `→` | Previous / next period |
| `C` | Focus the chat box |
| `/` | Focus search |
| `Esc` | Close the open dialog |

**The assistant** understands things like:

- `lunch with Priya Thursday at 1` → 1:00–2:00pm Thursday
- `block 9-11 tomorrow for deep work`
- `flight to Boston Mar 4, 6:45am, confirmation XR4B9 in the notes`
- `move my dentist appointment to Friday`
- `what do I have on Tuesday?` — reads back, creates nothing
- `cancel the 3pm` — asks you to confirm first

It runs on tool use, not text parsing: the model is given `create_event`,
`update_event`, `delete_event`, `list_events`, and `find_events`, and calls them
with schema-validated arguments. That's what makes "move my dentist appointment"
work — it can search the calendar before it writes to it.

Ambiguous requests get a clarifying question rather than a guess. Deletions, and
moves to a different day, pause for a yes/no in the chat panel before they
happen.

---

## Where the key lives

The key is stored in this browser's `localStorage` and requests go straight from
the page to Anthropic (`dangerouslyAllowBrowser` in `src/lib/assistant.ts`).

**Any script running on the page can read it.** That is fine for a calendar only
you open. It is not fine for a site with third-party scripts, other users, or
anything public.

To publish this, move the Claude call behind a proxy that holds the key
server-side. Every Anthropic call is isolated in `src/lib/assistant.ts`, so it is
a one-file change: replace `makeClient()` with a `fetch` to your own endpoint and
drop `dangerouslyAllowBrowser`. A serverless function is enough — add rate
limiting or a shared password, since anyone who finds the URL spends your
tokens.

Anthropic blocks browser requests by default, which is what
`dangerouslyAllowBrowser` opts out of. If you see a connection error rather than
an auth error, that's usually what's happening.

---

## Layout

```
src/
  lib/
    assistant.ts     Claude integration — tools, prompt, tool runner, errors
    dates.ts         Range math, local-ISO serialization, formatting
    layout.ts        Overlapping-event column packing
    smoke.test.ts    Checks for the two files above
  components/
    TimeGrid.tsx     Day + week grid, drag/resize, current-time line
    MonthView.tsx    Month grid with "+N more"
    ChatPanel.tsx    Assistant UI and confirmation gate
    EventEditor.tsx  Event detail / edit dialog
    Header.tsx       Navigation, search, view switcher, theme
    Sidebar.tsx      Mini month, calendar list, shortcuts
  store.ts           Zustand state, persisted to localStorage
```

`npm run smoke` runs the date and layout checks; `npm run typecheck` and
`npm run build` cover the rest. There is no backend and nothing at build time
needs a secret.

Events are stored as ISO 8601 with a local offset (`2026-08-05T13:05:00-05:00`)
rather than UTC, so wall time survives a round-trip and reads correctly to the
model, which reasons in local time.

---

## Cost notes

The tool definitions and system prompt are identical every turn and carry a
cache breakpoint; the current date/time is deliberately placed *after* it so the
cached prefix stays byte-identical. Chat history is capped at 12 turns — the
calendar is the state, so the model re-reads it rather than remembering it.

Model and effort are constants at the top of `src/lib/assistant.ts`. It ships on
`claude-opus-5` at `medium` effort; drop to `low` for faster replies, raise it if
date arithmetic starts slipping.

---

## Not built yet

Recurring events (asking for one creates the next few concrete occurrences
instead — the `recurrence` field is reserved on the event model), Google/CalDAV
sync, ICS import/export, reminders, and sharing. Single timezone only.
