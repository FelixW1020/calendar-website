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

**Repeating events** — the **Repeat** field in the editor offers daily, weekly
on this day, every weekday, monthly on the nth weekday, annually, and a custom
rule: every N days/weeks/months/years, which weekdays, and an end (never, on a
date, or after N times). A repeating event is stored once, as a rule, and drawn
wherever the rule lands — "every weekday, forever" is one row, not a thousand.

Editing or deleting one of them asks what you meant, the way a calendar has to:
**this event**, **this and following events**, or **all events**. Changing one
occurrence leaves a stand-in behind that the rule no longer covers; changing all
of them moves the series, stand-ins included; changing this and the following
ones splits the series in two at that point. Dragging an occurrence in the grid
asks the same question on drop. Deleting one occurrence punches a hole and
leaves the rest alone.

Occurrences have no rows of their own, so they are identified by the series they
came from plus the moment they land on — which is what makes "just this one"
possible without writing out the rest.

**Locations** — every event has a location field, separate from the title. The
assistant fills it in on its own: "lunch at Blue Bottle" becomes *Lunch* located
at *Blue Bottle*, "standup in room 302" becomes *Standup* at *Room 302*. It
keeps addresses verbatim rather than expanding one, and never invents one.
Locations show on the event chip and are searchable.

Start typing a place or address and the field suggests real ones, with places
already in your calendar offered first and instantly. Pick one and the event
keeps its coordinates: a map of the spot appears under the field, and **Open in
Maps** and **Directions** go to the exact pin rather than re-guessing from the
text. Locations set by the assistant, or typed before this existed, get looked
up once when you open the event — but only when the match is unambiguous, since
a wrong pin is worse than none, and "Room 302" is not a place. A meeting link is
recognised as a link and offers **Join** instead.

Lookups use [Photon](https://photon.komoot.io), which is OpenStreetMap-based and
keyless — there is nothing to configure and no billing account to attach.
Results are biased toward the last place you picked, so "Whole Foods" means the
one near you. Nothing is sent anywhere until you type at least three characters.

**Suggestions are United States only** — the 50 states, Puerto Rico and the US
Virgin Islands. Otherwise "Durham" is as likely to be England as North Carolina,
and every foreign hit costs a slot a real suggestion could have used. Now
`london` finds Kentucky and `paris` finds Texas. It is enforced twice: a
bounding box on the request, so the provider does not spend its results on other
continents, and an exact country check on the way back, since that rectangle
also covers parts of Canada, Mexico and the Caribbean. To point it somewhere
else, change `COUNTRY_CODE`, `COUNTRY_NAME` and `COUNTRY_BBOX` at the top of
`src/lib/geocode.ts` together.

What matters more than the choice of provider is how the query is asked and how
the answers are judged:

- **Unambiguous street types are spelled out before searching.** Photon indexes
  "Road" and cannot see through "Rd" — asked for `6 hotz rd` it offers 3rd
  Avenue in New York, and asked for `6 hotz road` it finds the Hotz Roads. `St`
  is deliberately left alone, since it is as often Saint as Street, and so is
  `NE`, which is Nebraska as often as northeast.
- **The unit is dropped.** Map data records buildings, not the offices inside
  them, so `Suite 200` in the middle of an address only confuses the search.
- **Every result is judged against what you typed.** Words match by prefix,
  since you are mid-type; abbreviations match either way round, so `st louis`
  finds Saint Louis and `durham nc` matches Durham, North Carolina; and
  `Trader Joe's`, `Trader Joes` and the curly-quoted version are one name.
- **Not every word has to match, but the right ones do.** An address carries
  words the map does not — `Apple *Store* Fifth Avenue` — and one such word
  should not sink a perfect result. So most words must match, and specifically
  the longest one and the last one: the thing and where it is. That is what
  stops `duke chapel durham` matching the Duke Chapel in Tennessee.

When nothing matches, the field says so rather than showing something
irrelevant, and your text is still saved as typed.

A suggestion tagged **approx.** is the right street but not the exact door —
either the building is not in the map data, which is common outside dense
cities, or only its neighbours are. The pin lands on the block.

[Nominatim](https://nominatim.openstreetmap.org) is used in exactly one place —
the single background lookup when an event is opened — because the OSM
Foundation's usage policy is explicit that it must not be used for autocomplete.

**On phones and tablets** — the layout adapts rather than shrinking: the
calendar list becomes a slide-in drawer, the assistant a full-screen sheet
behind a button in the corner, and the header splits into two rows. Phones open
on day view, since a 7-column week is unreadable at that width. Tap an empty
slot to create, tap an event to edit. Drag-to-move is pointer-only — on touch a
press has to stay available for scrolling.

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
- `gym every Monday and Wednesday at 7am` — one repeating event, not a pile of copies
- `move my dentist appointment to Friday`
- `skip gym tomorrow` / `gym is at 8 from now on` — the same three scopes, chosen from what you said
- `what do I have on Tuesday?` — reads back, creates nothing
- `cancel the 3pm` / `clear my Friday` — done at once, with an Undo

It runs on tool use, not text parsing: the model is given `create_event`,
`update_event`, `delete_events`, `list_events`, and `find_events`, and calls them
with schema-validated arguments. That's what makes "move my dentist appointment"
work — it can search the calendar before it writes to it.

Ambiguous requests get a clarifying question rather than a guess. Moves to a
different day, and changes that reach past the one occurrence you asked about,
pause for a yes/no in the chat panel before they happen.

**Cancelling doesn't stop to ask.** It used to: every deletion waited on a
yes/no, so clearing one afternoon meant answering the same question five times,
and each one cost a round trip. Now a deletion happens immediately and the reply
carries an **Undo** — one click, and everything that call removed comes back
with the same ids, repeat rules and all. Undo is better than a prompt on both
counts: it is out of the way when the assistant was right, and it still saves
you when it was wrong, which a prompt agreeing with itself does not.

The button stays for as long as the message does, so nothing depends on being
quick. It goes when the chat is cleared or the page is reloaded — the transcript
is not persisted — so the safety net is the session, not forever.

Everything cancelled in one breath is one tool call, so "clear my Friday" is a
single deletion and a single Undo rather than five of each.

---

## Sync across devices

Without setup, the calendar is saved in `localStorage`: it survives reloads on
that one browser, but your phone and your laptop keep **separate** calendars,
and clearing site data erases it.

Turning on sync gives you one calendar everywhere, with live updates between
open devices. It needs a Supabase project (free tier is plenty):

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**, paste [`supabase/schema.sql`](supabase/schema.sql),
   and run it. That creates the two tables, the row-level security policies, and
   the realtime publication. It is safe to re-run, and you need to re-run it if
   you set sync up before location pins existed — that is what adds the
   coordinate columns.
3. **Project Settings → Data API**: copy the Project URL and the `anon` key.
4. Local dev: `cp .env.example .env.local` and fill both in.
5. Deployed: add them as repo variables so the build can see them —
   ```bash
   gh variable set SUPABASE_URL      --body "https://your-project.supabase.co"
   gh variable set SUPABASE_ANON_KEY --body "your-anon-key"
   ```
   then re-run the deploy (`gh workflow run "Deploy to GitHub Pages"`).
6. Open the site, click the cloud icon in the header, and sign in with your
   email. Supabase sends a link — no password.

The `anon` key is meant to be public; row-level security is what stops one
account reading another's calendar. Never publish the `service_role` key.

**How it reconciles.** On sign-in, local and server state are merged by id, with
the newer `updated_at` winning. Deletes are tombstones (`deleted_at`) rather
than row removals, so a deletion on one device isn't undone by another device
re-uploading its stale copy. After that, changes write through continuously and
a realtime subscription keeps other open devices current.

Writes are coalesced per row over a half-second of quiet (and never held longer
than 2.5s), so dragging an event across the grid sends one upsert instead of
one per pointer move, and a queued write is flushed if the tab is hidden or
closed. Your own writes come back over the realtime channel and are recognised
and dropped, rather than re-applied on top of what you are editing.

**Staying signed in.** Sign in once per device and stay signed in: the session
is written to `localStorage` and the access token renews in the background
before it expires, so there is no repeated login. Signing out is scoped to the
device you do it on, leaving your other devices alone.

Two things end a session anyway, both outside the app's control — clearing site
data for the origin, and Safari/iOS evicting script-written storage for a site
you have not opened in about a week. Also leave **Authentication → Sessions**
in the Supabase dashboard at its defaults; enabling a time-box or inactivity
timeout there will log you out on a schedule no matter what the client does.

**Known limit:** edits made while offline stay local until the next successful
write or sign-in, and a delete made offline can be resurrected by another
device, because the tombstone never reached the server. Fine for one person on
a few devices; it is not a full offline-first CRDT.

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
    recurrence.ts    Repeat rules: parsing, expansion, exceptions, splitting
    geocode.ts       Place search, confident-match resolve, map + maps links
    sync.ts          Supabase merge, write queue, realtime subscription
    smoke.test.ts    Checks for dates, layout, recurrence, and geocode links
  components/
    TimeGrid.tsx        Day + week grid, drag/resize, current-time line
    MonthView.tsx       Month grid with "+N more"
    ChatPanel.tsx       Assistant UI and confirmation gate
    EventEditor.tsx     Event detail / edit dialog
    RecurrenceField.tsx Repeat picker, presets and custom rule
    ScopeDialog.tsx     "This event / following / all" for a series
    LocationField.tsx   Location combobox, suggestions, map card
    Header.tsx          Navigation, search, view switcher, theme
    Sidebar.tsx         Mini month, calendar list, shortcuts
  store.ts           Zustand state, persisted to localStorage
```

`npm run smoke` runs the date, layout, recurrence and link checks; `npm run typecheck` and
`npm run build` cover the rest. There is no backend and nothing at build time
needs a secret.

**Typing stays local.** The editor holds an event in local state while it is
open and writes through on a 300ms trailing debounce, so a keystroke costs one
small re-render instead of a grid re-layout, a full `localStorage` rewrite and a
network upsert. An occurrence of a repeating event cannot write through at all
until the scope question is answered, so that dialog holds its edits until Save. `localStorage` writes are batched behind the same idea, and are
flushed when the tab is hidden or closed so nothing typed is lost.

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

Google/CalDAV sync, ICS import/export, reminders, and sharing. Single timezone
only. Repeat rules cover the common shapes (see **Repeating events** above) but
not the whole of RFC 5545 — no BYSETPOS, BYWEEKNO, or several rules on one
event.
