# Calendar Website — Project Spec

A personal calendar that looks and feels like Google Calendar, but where adding
events is a conversation instead of a form. You paste in a Claude API key once,
then type "lunch with Priya Thursday at 1" and the event appears.

---

## 1. Goals

1. **Match Google Calendar's core viewing experience** — day, week, and month
   views with fast navigation between them.
2. **Fix the part that's annoying** — adding events. Google's flow is a modal
   with a dozen fields. Ours is a chat box.
3. **Bring your own key** — the user supplies a Claude API key. No accounts, no
   backend auth, no subscription.

Non-goals for v1: multi-user sharing, invitations/RSVPs, Google Calendar sync,
mobile apps. See §9.

---

## 2. Feature Breakdown

### 2.1 Calendar views

**Week view (default)**
- 7 day columns, hour rows (12am–11pm), vertical scroll with the current
  business-hours range in view on load.
- Current-time indicator: a red horizontal line across today's column, updating
  every minute.
- Events render as positioned blocks proportional to duration.
- Overlapping events split the column width side by side (Google's algorithm:
  group overlapping events into clusters, divide width by cluster size).
- All-day events pinned in a separate row above the scrolling grid.

**Day view**
- Same grid, single column, more horizontal room for event titles/locations.

**Month view**
- 6×7 cell grid. Each cell shows the date number and up to ~3 event chips.
- Overflow shows "+N more" which expands the day (popover or jump to day view).
- Days outside the current month are dimmed but still rendered.

**Shared across views**
- Header: `< >` arrows, "Today" button, current range label, view switcher
  (D / W / M).
- Keyboard shortcuts, matching Google's: `d` `w` `m` to switch views,
  `t` for today, `j`/`k` or arrow keys for prev/next period, `c` to focus the
  chat input, `/` to focus search.
- Click an empty slot → create event at that time (pre-fills the chat with a
  drafted event rather than opening a form).
- Click an existing event → detail popover with edit and delete.
- Drag to move an event; drag its bottom edge to resize duration.

### 2.2 Event model

```ts
type CalendarEvent = {
  id: string;              // uuid
  title: string;
  description?: string;
  location?: string;
  start: string;           // ISO 8601 with offset
  end: string;             // ISO 8601 with offset
  allDay: boolean;
  calendarId: string;      // which local calendar it belongs to
  recurrence?: RRuleString; // RFC 5545 RRULE on the series master (v1.5)
  exdates?: string[];       // occurrences deleted out of the series
  recurrenceId?: string;    // set on an event replacing one occurrence
  originalStart?: string;   //   ...of this moment in the series
  createdAt: string;
  updatedAt: string;
};

type Calendar = {
  id: string;
  name: string;            // "Personal", "Work", "Classes"
  color: string;           // hex; drives event chip color
  visible: boolean;        // toggled from the sidebar
};
```

Multiple local calendars with color coding and visibility checkboxes in a left
sidebar, same as Google.

### 2.3 The chat assistant — the centerpiece

A persistent panel (right side on desktop, bottom sheet on mobile) with a
message thread and an input box.

**What it must handle**

| User types | Expected result |
|---|---|
| "lunch with Priya Thursday at 1" | Event Thu 1:00–2:00pm (default 1h duration) |
| "gym every Monday and Wednesday 7am" | One repeating event, FREQ=WEEKLY;BYDAY=MO,WE |
| "block 9-11 tomorrow for deep work" | Event tomorrow 9:00–11:00am |
| "move my dentist appointment to Friday" | Finds the event, updates its date |
| "what do I have on Tuesday?" | Reads back the day's schedule, creates nothing |
| "cancel the 3pm" | Deletes, **after a confirmation step** |
| "flight to Boston Mar 4, 6:45am, gate info in description" | Event with description populated |

**How it works — tool use, not text parsing**

The assistant is defined with Claude tools and the model calls them. Do not ask
Claude to emit JSON in prose and parse it; use the tool-use API so inputs are
schema-validated.

Tools to expose:

- `create_event(title, start, end, allDay, description?, location?, calendarId?)`
- `update_event(id, ...partial fields)`
- `delete_event(id)`
- `list_events(rangeStart, rangeEnd)` — lets the model answer questions and
  resolve references like "my dentist appointment"
- `find_events(query, rangeStart?, rangeEnd?)` — fuzzy title search for
  resolving "the 3pm" or "lunch with Priya"

Implementation notes:
- Use the official Anthropic SDK (`@anthropic-ai/sdk`), not raw `fetch`.
- Use the **tool runner** (`client.beta.messages.toolRunner` with
  `betaZodTool`) so the request → execute → loop cycle is handled for you, with
  per-turn hooks available for the confirmation gate below.
- Model: `claude-opus-5`. Adaptive thinking (`thinking: { type: "adaptive" }`)
  is on by default on this model.
- `max_tokens: 16000` non-streaming, or stream and use `.finalMessage()`.
- **System prompt must inject the current date, time, and IANA timezone** on
  every request — the model cannot resolve "Thursday" or "tomorrow" without it.
  Put the volatile date/time *after* any cached prefix (see §5).
- Every tool call gets an optimistic UI update; the assistant's text response
  confirms what it did in one short sentence.

**Destructive-action gate**

`delete_event` and any `update_event` that moves an event more than a trivial
amount must not execute silently. Gate inside the tool's `run` function: render
a confirm/cancel chip in the chat, and return a "user declined" tool result if
the user rejects. This keeps the model in the loop rather than erroring out.

**Failure handling**

- Ambiguous input ("lunch sometime next week") → the model should ask a
  clarifying question rather than guessing. State this in the system prompt.
- API errors → catch the SDK's typed exceptions (`Anthropic.AuthenticationError`
  → "that key looks invalid"; `Anthropic.RateLimitError` → "slow down, retrying";
  `Anthropic.APIConnectionError` → "can't reach the API"). Never string-match on
  error messages.
- A failed tool call returns `is_error: true` in the tool result so the model can
  recover and try a different approach.

### 2.4 API key handling

- First-run screen: paste your key, with a link to
  `console.anthropic.com` and a one-line explanation of what it's used for.
- Stored in `localStorage` (not `sessionStorage` — the user shouldn't re-paste
  every tab). Settings page shows it masked (`sk-ant-…4f2a`) with a "Replace" and
  a "Remove key" button.
- Validate on entry with a cheap one-token call before saving.
- **Be honest in the UI**: a key in `localStorage` is readable by any script that
  ends up on the page. Say so on the entry screen. This is acceptable for a
  personal site you control; it would not be for a product with third-party
  scripts or user-generated content.

---

## 3. The CORS problem — read this before choosing an architecture

The Anthropic API does not allow browser requests by default. Two paths:

**Option A — direct from the browser** (simplest, personal use)
Set `dangerouslyAllowBrowser: true` on the SDK client, which sends the
`anthropic-dangerous-direct-browser-access` header. The name is the warning: the
key lives in the browser and is visible in devtools. Fine for a site only you
use. **This is the recommended v1 path** given the "personal website" framing.

**Option B — thin proxy** (needed if the site is ever public)
A single serverless function (Vercel/Cloudflare/Netlify) that holds *your* key
server-side and forwards chat requests. The browser never sees a key. Costs you
money per request from anyone who finds the URL, so it needs rate limiting or a
shared password.

Decide this before writing the chat layer — it changes where the SDK client
lives. If unsure, build A and keep the Claude calls behind a single module
(`src/lib/assistant.ts`) so swapping to B is a one-file change.

---

## 4. Tech Stack (proposed — override as you like)

- **React + TypeScript + Vite** — fast dev loop, no framework ceremony.
- **Tailwind CSS** — the calendar grid is a lot of precise spacing; utility
  classes keep it manageable.
- **date-fns** or **Temporal** (via polyfill) for date math. Avoid rolling your
  own week/month boundary logic; DST transitions will bite you.
- **`@anthropic-ai/sdk`** for the assistant, with **Zod** for tool schemas.
- **State**: Zustand or plain React context — the data model is small.
- **Persistence**: `localStorage` for v1 (JSON blob of events + calendars +
  settings). IndexedDB if the event count grows past a few thousand.

No backend in v1. No build-time secrets.

---

## 5. Cost and Latency Notes

- The tool definitions and system prompt are identical on every request. Put
  `cache_control: { type: "ephemeral" }` on the last stable system block so
  tools + system are cached — this is a prefix match, so the **volatile
  current-date line must come after the breakpoint**, or nothing ever caches.
- Verify with `response.usage.cache_read_input_tokens` — if it's zero across
  repeated messages, something in the prefix is changing per request.
- Recent conversation history should be trimmed to the last ~10 turns; the
  assistant doesn't need long-term memory of the chat, since the calendar itself
  is the state.

---

## 6. Build Order

1. **Static week view** — grid, hour rows, day columns, hardcoded events. Get
   the layout right before anything is dynamic.
2. **Event model + localStorage** — create/edit/delete through a temporary
   plain form. Proves the data layer.
3. **Day and month views** — reuse the event data, new layouts.
4. **Navigation, current-time line, keyboard shortcuts.**
5. **Drag to move / resize.**
6. **API key entry + storage + validation.**
7. **Chat panel UI** — message thread, input, loading states. Wire to a stub
   that returns canned responses first.
8. **Claude integration** — tool definitions, tool runner, system prompt with
   date injection.
9. **Confirmation gate for destructive actions.**
10. **Error handling pass** — every typed SDK exception gets a user-facing
    message.
11. **Polish** — multiple calendars, colors, sidebar, search.

Steps 1–5 are a working calendar with no AI. That's a good checkpoint: if the
chat layer is a dead end for any reason, you still have the thing you wanted.

---

## 7. Design Direction

Google Calendar's visual language works because it's dense and quiet — the
events are the content, the chrome recedes. Follow that: thin grid lines, muted
borders, saturated color only on event chips.

Do not default to the generic AI-app look (purple gradients, Inter everywhere,
oversized rounded cards). Pick a typeface with some character for the header,
keep the grid itself in a clean neutral sans, and choose an event color palette
that stays legible in both light and dark mode.

Dark mode is required — a calendar is something you leave open all day.

---

## 8. Open Questions

- [ ] **Direct browser calls or proxy?** (§3) Blocks the chat implementation.
- [x] **Recurring events in v1, or defer?** Deferred, then built (v1.5). The
      useful subset of RRULE — FREQ, INTERVAL, BYDAY, BYMONTHDAY, COUNT, UNTIL —
      with expansion at read time, exceptions on the master (`exdates` plus
      override events), and "this / this and following / all" on every edit and
      delete. Keeping the `recurrence` field in the v1 model meant no migration.
      See `src/lib/recurrence.ts`.
- [ ] **Should the chat be able to read the calendar, or only write?**
      Recommendation: read too (`list_events` / `find_events`) — it's what makes
      "move my dentist appointment" work, and it's how you'd ask a person.
- [ ] Timezone handling: single local timezone, or per-event timezones for
      travel? Recommendation: single local timezone in v1.

---

## 9. Explicitly Out of Scope for v1

- Multi-user, sharing, invitations, RSVPs
- Google/Outlook/CalDAV sync or ICS import-export
- The rest of RFC 5545: BYSETPOS, BYWEEKNO, multiple rules on one event
  (recurrence itself shipped in v1.5)
- Notifications and reminders
- Native mobile apps (responsive web only)
