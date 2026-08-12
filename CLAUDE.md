# CLAUDE.md

Orientation for Claude Code. Read this first; it should save you the exploration
pass. `README.md` is the user-facing manual and `PROJECT_SPEC.md` is the original
design brief — consult them for *why*, this file for *where* and *what not to
break*.

## What this is

A personal calendar (Google Calendar's viewing experience) where events are
created by chatting with Claude instead of filling in a form. React 19 +
TypeScript + Vite + Tailwind v4, Zustand for state, `localStorage` for
persistence, optional Supabase for cross-device sync. **No backend of our own**
and no build-time secrets. Deployed to GitHub Pages from `main` by
`.github/workflows/deploy.yml`.

The user brings their own Anthropic API key; it lives in `localStorage` and calls
go straight from the browser (`dangerouslyAllowBrowser`). That is a deliberate,
documented trade-off for a single-user site — don't "fix" it without being asked.

## Commands

```bash
npm run dev        # vite, http://localhost:5173
npm run typecheck  # tsc -b --noEmit
npm run smoke      # bundles src/lib/smoke.test.ts with esbuild and runs it in node
npm run build      # tsc -b && vite build
```

`npm run typecheck && npm run smoke` is the verification loop for almost any
change, and it is exactly what CI runs before deploying. There is no test
framework — `smoke.test.ts` is a plain `node:assert` script covering `dates`,
`layout`, `recurrence`, and `geocode`. Add checks there rather than introducing
Vitest/Jest.

`tsconfig.json` is strict, including `noUnusedLocals`, `noUnusedParameters`, and
`verbatimModuleSyntax` — type-only imports need `import type`.

## Layout

```
src/
  App.tsx          Shell, global keyboard shortcuts, sync bootstrap, dialogs
  store.ts         Zustand store, series-aware mutations, localStorage persistence
  types.ts         CalendarEvent, Calendar, Place, chat types
  lib/
    dates.ts       Range math, local-ISO serialization, grid geometry constants
    layout.ts      Overlapping-event column packing
    recurrence.ts  RRULE subset: parse, format, expand, split, describe
    assistant.ts   All Anthropic calls: tools, system prompt, tool runner, errors
    geocode.ts     Photon/Nominatim place search, match scoring, maps links
    ics.ts         iCalendar parsing and feed fetching for subscribed calendars
    feeds.ts       Refresh scheduling for those subscriptions
    sync.ts        Supabase merge, write queue, realtime subscription
    supabase.ts    Client construction + row shapes mirroring the SQL schema
    images.ts      Photo attachments for the chat
    smoke.test.ts  The whole test suite
  components/      TimeGrid, MonthView, EventEditor, RecurrenceField, ScopeDialog,
                   LocationField, ChatPanel, Header, Sidebar, SubscribeDialog,
                   dialogs, Icons
supabase/schema.sql   Tables, RLS policies, realtime publication (safe to re-run)
```

## Invariants worth knowing before you edit

**Time is local wall time, everywhere.** Events are stored as ISO 8601 with a
local offset (`2026-08-05T13:05:00-05:00`), never UTC. Use `toLocalISO()` and
`parse()` from `lib/dates.ts` rather than `Date#toISOString()`. Single timezone
is an accepted limitation.

**A repeating event is one row.** The master carries an RRULE string; occurrences
are expanded at read time by `expandEvents()`. Exceptions live on the master as
`exdates`, and a hand-edited occurrence is a separate row with `recurrenceId` +
`originalStart` pointing back. Expanded occurrences have synthetic ids of the
form `<masterId>~<startISO>` — anything taking an event id should tolerate one,
which is what `resolveEvent()`, `masterOf()`, and `isOccurrenceId()` are for.

**Mutations on a series go through `updateEventScoped` / `deleteEventScoped`**
with a `SeriesScope` of `'this' | 'following' | 'all'`. The plain
`createEvent`/`updateEvent`/`deleteEvent` are the raw row operations; calling
them directly on a series is how you corrupt one. `ScopeDialog` collects the
scope in the UI; the assistant infers it from the wording.

**Sign-in is closed, and the client is only half of that.** The build is public
but the project behind it is one person's, so `signIn` passes
`shouldCreateUser: false` and maps Supabase's refusal codes to
`SyncNotOfferedError`, which the account dialog renders as an explanation rather
than an error. Enforcement is the project's sign-up switch in the dashboard —
the flag in the bundle is editable by anyone who downloads it. Don't "fix" the
client half into creating users.

**The store emits changes, it doesn't import Supabase.** `onLocalChange()` is a
callback the sync layer registers, so with no credentials the app is exactly the
local-only version. Server-applied changes go through `applyRemote()` /
`replaceAll()`, which deliberately do **not** emit back.

**Writes are debounced in three places** and each has a reason: `localStorage`
(400ms, flushed on `pagehide`/`visibilitychange`), Supabase upserts (500ms quiet,
2.5s ceiling), and the event editor's local draft (300ms trailing). Typing in the
editor must not re-layout the grid. Deletes are tombstones (`deleted_at`), never
row removals.

**The Anthropic prefix must stay byte-identical.** Tool definitions and the
system prompt carry a cache breakpoint and the volatile current-date line goes
*after* it. Anything you add to the prompt that varies per request belongs after
the breakpoint too, or caching silently stops working — check
`usage.cache_read_input_tokens`. History is capped at 12 turns and only plain
text is retained (storing `tool_use` blocks risks orphaning a `tool_result` when
trimmed). Model and effort are constants at the top of `lib/assistant.ts`.

**The assistant works by tool use, not text parsing.** `create_event`,
`update_event`, `delete_event`, `list_events`, `find_events`, run through the
SDK's tool runner. Destructive actions gate on a confirmation resolved in the
chat panel. Catch the SDK's typed exceptions; never string-match error messages.

**Subscribed calendars are a separate, read-only layer.** A feed added by link
gets a `Calendar` row (so colour, visibility and the sidebar entry are the
ordinary ones) plus a `Subscription` holding the URL. Its events live in
`store.feed`, keyed by subscription id — never in `events`, never synced, thrown
away and replaced whole on each refresh. Read paths go through `useAllEvents()`
(or `allEvents()` outside React); mutation paths keep using `s.events`, which is
what makes them refuse a feed event without needing to check. Events carry
`readOnly: true`; the grid, the editor and the assistant's tools each turn them
away explicitly, because silently ignoring a delete is worse than refusing it.

**A feed almost always needs the relay.** Google, iCloud and Outlook publish
iCalendar without an `Access-Control-Allow-Origin` header, so the browser cannot
read them and there is no server here to ask instead. `fetchFeed` tries direct
first and reports `kind: 'blocked'`; only then does the dialog offer
`api.allorigins.win`, per feed, spelling out that the URL passes through a third
party. The relay goes down in bursts and its gateway errors carry no CORS header
either — which is why a proxied attempt retries once before believing the
failure. Do not make the relay automatic or default-on.

**The ICS parser drops what it cannot draw.** `readRule` rejects BYSETPOS,
BYWEEKNO and friends rather than approximating them, so an unsupported series
shows one occurrence instead of a plausible-looking wrong one. Feed ids are
`<calendarId>:<uid>` with `~` stripped, since `~` is the occurrence-id separator.

**Place search is United States only**, enforced twice (bounding box on the
request, exact country check on the response). `COUNTRY_CODE`, `COUNTRY_NAME`,
and `COUNTRY_BBOX` at the top of `lib/geocode.ts` must change together. Photon is
used for autocomplete; Nominatim is used **only** for the single background
resolve when an event is opened, because its usage policy forbids autocomplete.

## Conventions

- Comments explain *why* — a constraint, a trade-off, a browser quirk. The
  codebase has a distinct voice: full sentences, no narration of what the next
  line does. Match it, and don't add comments that explain your change to a
  reviewer.
- Section banners (`/* --- Name --- */`) separate concerns inside the longer
  library files.
- Tailwind utilities only; semantic color tokens (`bg-canvas`, `text-ink`,
  `border-line`, `bg-accent`) are defined in `src/index.css` for both themes.
  Dark mode is required, so never hardcode a color that only reads in one.
- Design direction: dense and quiet, thin grid lines, saturated color only on
  event chips. Explicitly not the generic AI-app look.
- Mobile matters — drag-to-move is pointer-only so touch keeps scrolling, and
  form controls stay 16px to stop iOS focus-zoom.
- Commit messages are a lowercase-ish sentence describing the user-visible
  change ("Let the assistant read a photo you send it"), not a conventional
  commits prefix.

## Configuration

`.env.local` (gitignored) holds `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`; see `.env.example`. Both are safe to publish — RLS is
what protects the data, and the `service_role` key must never appear here. In CI
they come from repo variables. Absent both, sync is simply off.

## Not built

Google/CalDAV sync, ICS export, reminders, sharing, multi-user. Multiple
timezones. The rest of RFC 5545 (BYSETPOS, BYWEEKNO, several rules on one event).
Offline edits are not queued — a delete made offline can be resurrected by
another device.

Subscribing to a calendar by link reads iCalendar in but does not write it out,
and it is one-way: nothing you do here reaches the publisher. There is no
file/paste import either — a feed has to be reachable at a URL.
