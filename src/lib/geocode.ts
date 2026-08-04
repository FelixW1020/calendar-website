import type { Place } from '../types';

/**
 * Address lookup for the location field.
 *
 * Both providers are OpenStreetMap-based, keyless and CORS-open, so the app
 * keeps its "clone it and it runs" property — no billing account, nothing to
 * put in .env.
 *
 * Photon answers everything typed into the field: it is built and hosted for
 * type-ahead, and the OSM Foundation's policy is explicit that Nominatim is
 * not to be used that way. Nominatim appears once, as a second opinion for the
 * single background lookup that runs when an event is opened.
 *
 * Two things do the real work of keeping results honest. Queries go out with
 * street types spelled out, because Photon indexes "Road" and cannot see
 * through "Rd" — that alone is the difference between finding Hotz Road and
 * being offered 3rd Avenue in New York. And every result is checked against
 * the typed text before it is shown, because a geocoder would always rather
 * return something than nothing.
 */

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/* -------------------------------------------------------------------------- */
/* Country                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Suggestions are United States only. Without this, "Durham" is as likely to
 * mean England as North Carolina and "6 hotz" surfaces four Swiss addresses
 * before the first American one — every foreign hit is a slot a real
 * suggestion could have used.
 *
 * Change these three constants together to point somewhere else.
 */
const COUNTRY_CODE = 'US';
const COUNTRY_NAME = 'United States';

/**
 * The 50 states, Puerto Rico and the US Virgin Islands. The box is the coarse
 * filter — it keeps the provider from spending its results on other continents
 * — and the country code is the exact one, since this rectangle also covers
 * chunks of Canada, Mexico and the Caribbean.
 *
 * The far Aleutians cross the antimeridian into positive longitude and fall
 * outside; so do Guam and American Samoa, which no single box can include.
 */
const COUNTRY_BBOX = '-172,17.5,-64.5,72';

export interface Suggestion extends Place {
  /** The bold first line — a venue name, or the street address. */
  name: string;
  /** The rest of the address, shown under the name. */
  detail: string;
  /** Distinguishes a place already used in your calendar from a search hit. */
  source: 'recent' | 'search';
  /**
   * The building number the provider actually has, when it has one. Kept
   * structured rather than read back out of the label, so "302" is not
   * mistaken for a match against "3025 Main Street".
   */
  houseNumber?: string;
  /** The pin is the street, not the building — the number is not mapped. */
  approximate?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Search bias                                                                */
/* -------------------------------------------------------------------------- */

const BIAS_KEY = 'calendar.geoBias';

/**
 * "Whole Foods" should mean the one near you. Both providers accept a bias
 * point, and the last place you picked is a far better guess than the centre
 * of the earth — so results improve as you use the app, with no permission
 * prompt for real geolocation.
 */
function readBias(): { lat: number; lon: number } | null {
  try {
    const raw = localStorage.getItem(BIAS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { lat: number; lon: number };
    return Number.isFinite(v?.lat) && Number.isFinite(v?.lon) ? v : null;
  } catch {
    return null;
  }
}

export function rememberBias(place: Place): void {
  try {
    localStorage.setItem(BIAS_KEY, JSON.stringify({ lat: place.lat, lon: place.lon }));
  } catch {
    /* private mode — bias is an optimisation, not a requirement */
  }
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

interface PhotonProps {
  name?: string;
  housenumber?: string;
  street?: string;
  city?: string;
  district?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  countrycode?: string;
}

/** Drop repeats and empties, so "Durham, Durham, NC" reads as "Durham, NC". */
function joinParts(parts: (string | undefined | null)[]): string {
  const out: string[] = [];
  for (const p of parts) {
    const v = p?.trim();
    if (!v) continue;
    if (out.some((existing) => existing.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
  }
  return out.join(', ');
}

function fromPhoton(feature: {
  properties: PhotonProps;
  geometry: { coordinates: [number, number] };
}): Suggestion | null {
  const p = feature.properties;
  const [lon, lat] = feature.geometry?.coordinates ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (p.countrycode !== COUNTRY_CODE) return null;

  const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street;
  const name = p.name || street || p.city || p.state;
  if (!name) return null;

  // No country on the end: every row says the same thing, so it is only noise.
  const detail = joinParts([
    name === street ? null : street,
    p.city || p.district || p.county,
    p.state,
    p.postcode,
  ]);

  return {
    lat,
    lon,
    name,
    detail,
    label: joinParts([name, detail]),
    source: 'search',
    houseNumber: p.housenumber,
  };
}

async function searchPhoton(query: string, signal: AbortSignal): Promise<Suggestion[]> {
  const url = new URL(PHOTON);
  url.searchParams.set('q', query);
  url.searchParams.set('bbox', COUNTRY_BBOX);
  // Asked for more than are shown, because the country check below and the
  // relevance filter after it both discard rows.
  url.searchParams.set('limit', '15');
  const bias = readBias();
  if (bias) {
    url.searchParams.set('lat', String(bias.lat));
    url.searchParams.set('lon', String(bias.lon));
  }

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`photon ${res.status}`);
  const body = (await res.json()) as { features?: Parameters<typeof fromPhoton>[0][] };
  return (body.features ?? []).map(fromPhoton).filter((s): s is Suggestion => s !== null);
}

// Nominatim's usage policy allows one request a second. The debounce and the
// cache already collapse most typing, but a fast typist can still outrun it.
let nominatimFreeAt = 0;

async function searchNominatim(query: string, signal: AbortSignal): Promise<Suggestion[]> {
  const wait = nominatimFreeAt - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  }
  nominatimFreeAt = Date.now() + 1_100;

  const url = new URL(NOMINATIM);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '6');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', COUNTRY_CODE.toLowerCase());

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const rows = (await res.json()) as {
    lat: string;
    lon: string;
    name?: string;
    display_name: string;
    address?: { house_number?: string };
  }[];

  const out: Suggestion[] = [];
  for (const r of rows) {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const parts = r.display_name
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== COUNTRY_NAME);
    const name = r.name?.trim() || parts[0];
    const detail = joinParts(parts.filter((p) => p.toLowerCase() !== name.toLowerCase()));
    out.push({
      lat,
      lon,
      name,
      detail,
      label: joinParts([name, detail]),
      source: 'search',
      houseNumber: r.address?.house_number,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Abbreviations are alternatives, not replacements — the distinction matters.
 * Rewriting "st" to "street" turns St. Louis into Louis Street, and rewriting a
 * lone "s" turns "Trader Joe's" into "Trader Joe'south". So a word matches if
 * *any* of its forms does, and "st" simply carries three.
 */
const SYNONYMS: [string, string][] = [
  ['street', 'st'],
  ['saint', 'st'],
  ['road', 'rd'],
  ['avenue', 'ave'],
  ['avenue', 'av'],
  ['drive', 'dr'],
  ['lane', 'ln'],
  ['boulevard', 'blvd'],
  ['court', 'ct'],
  ['place', 'pl'],
  ['terrace', 'ter'],
  ['circle', 'cir'],
  ['highway', 'hwy'],
  ['parkway', 'pkwy'],
  ['square', 'sq'],
  ['mount', 'mt'],
  ['fort', 'ft'],
  ['north', 'n'],
  ['south', 's'],
  ['east', 'e'],
  ['west', 'w'],
  ['northeast', 'ne'],
  ['northwest', 'nw'],
  ['southeast', 'se'],
  ['southwest', 'sw'],
  // Street names are written both ways: Fifth Avenue is signed 5th Ave.
  ['first', '1st'],
  ['second', '2nd'],
  ['third', '3rd'],
  ['fourth', '4th'],
  ['fifth', '5th'],
  ['sixth', '6th'],
  ['seventh', '7th'],
  ['eighth', '8th'],
  ['ninth', '9th'],
  ['tenth', '10th'],
];

/**
 * States are one-directional: typing "nc" may match "North Carolina", but
 * typing "New York" must find New York, not settle for anything in NY. Someone
 * writing the words means the city; someone writing the code means the state.
 *
 * The list is needed at all because Photon returns "NC" for one result and
 * "North Carolina" for the next.
 */
const STATE_CODES: [string, string][] = [
  ['alabama', 'al'],
  ['alaska', 'ak'],
  ['arizona', 'az'],
  ['arkansas', 'ar'],
  ['california', 'ca'],
  ['colorado', 'co'],
  ['connecticut', 'ct'],
  ['delaware', 'de'],
  ['florida', 'fl'],
  ['georgia', 'ga'],
  ['hawaii', 'hi'],
  ['idaho', 'id'],
  ['illinois', 'il'],
  ['indiana', 'in'],
  ['iowa', 'ia'],
  ['kansas', 'ks'],
  ['kentucky', 'ky'],
  ['louisiana', 'la'],
  ['maine', 'me'],
  ['maryland', 'md'],
  ['massachusetts', 'ma'],
  ['michigan', 'mi'],
  ['minnesota', 'mn'],
  ['mississippi', 'ms'],
  ['missouri', 'mo'],
  ['montana', 'mt'],
  ['nebraska', 'ne'],
  ['nevada', 'nv'],
  ['new hampshire', 'nh'],
  ['new jersey', 'nj'],
  ['new mexico', 'nm'],
  ['new york', 'ny'],
  ['north carolina', 'nc'],
  ['north dakota', 'nd'],
  ['ohio', 'oh'],
  ['oklahoma', 'ok'],
  ['oregon', 'or'],
  ['pennsylvania', 'pa'],
  ['rhode island', 'ri'],
  ['south carolina', 'sc'],
  ['south dakota', 'sd'],
  ['tennessee', 'tn'],
  ['texas', 'tx'],
  ['utah', 'ut'],
  ['vermont', 'vt'],
  ['virginia', 'va'],
  ['washington', 'wa'],
  ['west virginia', 'wv'],
  ['wisconsin', 'wi'],
  ['wyoming', 'wy'],
  ['puerto rico', 'pr'],
];

const FORMS = new Map<string, string[]>();
const addForm = (token: string, alternative: string) =>
  FORMS.set(token, [...(FORMS.get(token) ?? [token]), alternative]);

for (const [long, short] of SYNONYMS) {
  addForm(long, short);
  addForm(short, long);
}
for (const [name, code] of STATE_CODES) addForm(code, name);

/** Every spelling a typed word is allowed to match. */
function formsOf(token: string): string[] {
  return FORMS.get(token) ?? [token];
}

/** Two-word state names, so "new york" can be recognised as one thing. */
const TWO_WORD_STATES = new Set(
  STATE_CODES.filter(([name]) => name.includes(' ')).map(([name]) => name),
);

/**
 * Words that carry no location: filler, and the unit part of an address, which
 * map data does not record. "Suite 200" is about the inside of the building.
 */
const IGNORED = new Set(['the', 'of', 'and', 'a', 'at', 'in', 'on']);
// "fl" is missing on purpose: it is Florida far more often than it is a floor.
const UNIT_WORDS = new Set([
  'suite',
  'ste',
  'apt',
  'apartment',
  'unit',
  'floor',
  'rm',
  'room',
  '#',
]);

export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Apostrophes are dropped rather than split on, so that "Trader Joe's",
      // "Trader Joes" and the curly-quoted version all become the same words.
      .replace(/['’`]/g, '')
      .split(/[^a-z0-9#]+/)
      .filter(Boolean)
  );
}

/**
 * The words a result has to account for: what was typed, less the filler, the
 * unit ("suite 200"), and the leading house number, which is handled on its own
 * because map data so often lacks it.
 */
export function significantTokens(queryTokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < queryTokens.length; i++) {
    const t = queryTokens[i];
    if (i === 0 && /^\d+$/.test(t)) continue; // house number
    if (IGNORED.has(t)) continue;
    if (UNIT_WORDS.has(t)) {
      // Skip the number that belongs to it, too.
      if (/^\d+[a-z]?$/.test(queryTokens[i + 1] ?? '')) i++;
      continue;
    }
    // "new york" is one place, not two words, and counting it twice would let a
    // result get away with matching neither of them.
    const pair = `${t} ${queryTokens[i + 1] ?? ''}`;
    if (TWO_WORD_STATES.has(pair)) {
      out.push(pair);
      i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Send the long form to the geocoder, since Photon indexes "Road" and cannot
 * see through "Rd" — that is the difference between finding Hotz Road and being
 * offered 3rd Avenue in New York. Only unambiguous street types are expanded:
 * "st" is left alone precisely because it is as likely to mean Saint.
 */
const EXPANDABLE = new Set([
  'rd',
  'ave',
  'av',
  'blvd',
  'ln',
  'ct',
  'ter',
  'cir',
  'hwy',
  'pkwy',
  'sq',
  'dr',
]);

/**
 * The unit goes too. Map data records buildings, not the offices inside them,
 * so "suite 200" in the query is a word the provider can only be confused by —
 * it is what turned a findable address into no results at all.
 */
const UNIT_PHRASE = /[,\s]*\b(suite|ste|apt|apartment|unit|floor|rm|room)\b\.?\s*#?\s*[\w-]*/gi;

export function expandQuery(query: string): string {
  return query
    .replace(UNIT_PHRASE, '')
    .split(/([^A-Za-z0-9]+)/)
    .map((part) => {
      const lower = part.toLowerCase();
      return EXPANDABLE.has(lower) ? (FORMS.get(lower)?.[1] ?? part) : part;
    })
    .join('')
    .replace(/\s*,\s*,/g, ',')
    .trim();
}

/**
 * Does this result answer what was typed?
 *
 * Geocoders would always rather return something than nothing — "6 hotz rd,
 * lin" came back with Lincolnshire postcodes, none of them on a road called
 * Hotz — so a result has to earn its place in the list.
 *
 * Not every word, though. That was too strict in the other direction: an
 * address carries words map data does not ("Apple *Store* Fifth Avenue"), and
 * one unmatched word was killing an otherwise perfect result. What is required
 * is that most of the words match, and specifically the two that carry the
 * meaning — the longest one, which is the name or the street, and the last one,
 * which is where it is. That keeps "duke chapel durham" from matching the Duke
 * Chapel in Tennessee.
 */
const MIN_MATCH_RATIO = 0.7;

interface Match {
  /** The street matched but this exact building is not in the map data. */
  approximate: boolean;
}

export function matchQuery(
  queryTokens: string[],
  label: string,
  /** The result's own building number, if the provider had one. */
  houseNumber?: string,
): Match | null {
  const labelTokens = tokenize(label);
  const joined = labelTokens.join(' ');
  const has = (token: string) =>
    formsOf(token).some((form) =>
      // Words match by prefix, since the user is mid-type and "chap" is a fair
      // match for "Chapel". Bare numbers must match exactly: 6 is not 6032.
      // A form with a space in it is a phrase, and has to be found as one.
      form.includes(' ')
        ? joined.includes(form)
        : labelTokens.some((l) => (/^\d+$/.test(form) ? l === form : l.startsWith(form))),
    );

  const required = significantTokens(queryTokens);
  if (required.length === 0) return null;

  const longest = required.reduce((a, b) => (b.length > a.length ? b : a));
  const last = required[required.length - 1];
  if (!has(longest) || !has(last)) return null;

  const matched = required.filter(has).length;
  if (matched / required.length < MIN_MATCH_RATIO) return null;

  const typedNumber = /^\d+$/.test(queryTokens[0] ?? '') ? queryTokens[0] : null;
  if (!typedNumber) return { approximate: false };

  // The building itself is mapped, and it is the one that was asked for.
  if (houseNumber === typedNumber || (!houseNumber && has(typedNumber))) {
    return { approximate: false };
  }

  // Right street, different door — or a street with no numbers mapped at all.
  // Still the block that was asked for, so it is offered as approximate.
  return { approximate: true };
}

/**
 * Show the number that was typed, not the neighbour's. The result's own number
 * comes off the front of the name first, so "2 Hanover Square" does not become
 * "2 6 Hanover Square".
 */
function withHouseNumber(s: Suggestion, houseNumber: string): Suggestion {
  const name = s.name.replace(/^\d+[a-z]?\s+/i, '');
  const detail = s.detail.replace(/^\d+[a-z]?\s+/i, '');
  return {
    ...s,
    name: `${houseNumber} ${name}`,
    detail,
    label: joinParts([`${houseNumber} ${name}`, detail]),
    approximate: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

// Typing "durham" walks through "d", "du", "dur"… and backspacing revisits
// every one of them. A tiny cache makes the retreat free.
const cache = new Map<string, Suggestion[]>();
const CACHE_LIMIT = 60;

function remember(key: string, results: Suggestion[]): void {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, results);
}

export function cached(query: string): Suggestion[] | undefined {
  return cache.get(query.trim().toLowerCase());
}

/**
 * The last word of "6 hotz rd, lin" is a town half-typed. Nominatim matches
 * literally and returns nothing at all for it, so the query is also tried
 * without that fragment — the results are still filtered against the full text,
 * so a town starting with "lin" is what comes back, if one exists.
 */
function withoutTrailingFragment(query: string): string | null {
  const trimmed = query.trim();
  if (/[,\s]$/.test(query)) return null;
  const cut = trimmed.replace(/[\s,]*[^\s,]+$/, '').trim();
  return cut.length >= 3 ? cut.replace(/,$/, '') : null;
}

function dedupe(results: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return results.filter((s) => {
    // Coordinates, because two providers describing the same doorway agree to
    // about a metre; and the label, because several buildings on one street all
    // relabel to the same typed address once the house number is applied.
    const keys = [`${s.lat.toFixed(4)},${s.lon.toFixed(4)}`, s.label.toLowerCase()];
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
}

/** Keep only the results that answer the query, tagging approximate ones. */
function relevant(raw: Suggestion[], query: string): Suggestion[] {
  const queryTokens = tokenize(query);
  const houseNumber = /^\d+$/.test(queryTokens[0] ?? '') ? queryTokens[0] : null;

  const kept: Suggestion[] = [];
  for (const s of raw) {
    const match = matchQuery(queryTokens, s.label, s.houseNumber);
    if (!match) continue;
    kept.push(match.approximate && houseNumber ? withHouseNumber(s, houseNumber) : s);
  }
  // An exact building beats the street it stands on. Beyond half a dozen, the
  // list is a scroll rather than a choice — the provider ranks by relevance,
  // so the tail is the part worth dropping.
  const ranked = kept.sort(
    (a, b) => Number(a.approximate ?? false) - Number(b.approximate ?? false),
  );
  return dedupe(ranked).slice(0, MAX_SUGGESTIONS);
}

const MAX_SUGGESTIONS = 6;

/**
 * Suggestions while typing come from Photon alone. Nominatim is the better
 * address matcher, but the OSM Foundation's policy is explicit that it must not
 * be used for autocomplete, and Photon exists precisely for type-ahead — so it
 * is asked properly (expanded street types) rather than swapped out.
 *
 * Returns [] rather than throwing when the lookup fails: a location field that
 * quietly stops suggesting is a far better outcome than one that breaks the
 * editor because the network is down.
 */
export async function searchPlaces(query: string, signal: AbortSignal): Promise<Suggestion[]> {
  const key = query.trim().toLowerCase();
  if (key.length < 3) return [];

  const hit = cache.get(key);
  if (hit) return hit;

  // "Room 302" is entirely unit and number: nothing is left to search for, and
  // asking anyway is how the provider gets sent an empty query.
  if (significantTokens(tokenize(query)).length === 0) return [];

  // The last word may be a town half-typed. If the full string finds nothing,
  // try again without it — results are still filtered against the full text, so
  // a town starting with "lin" is what comes back, if one exists.
  const attempts = [query.trim(), withoutTrailingFragment(query)].filter(
    (a): a is string => a !== null,
  );

  for (const attempt of attempts) {
    const sent = expandQuery(attempt);
    if (sent.length < 3) continue;
    let raw: Suggestion[];
    try {
      raw = await searchPhoton(sent, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      console.warn('[geocode] place search failed', err);
      return [];
    }
    const matched = relevant(raw, query);
    if (matched.length > 0) {
      remember(key, matched);
      return matched;
    }
  }

  // Nothing matched — worth caching, so backspacing does not re-ask.
  remember(key, []);
  return [];
}

const MIN_RESOLVE_LENGTH = 4;

/**
 * Does this read like somewhere you could stand, rather than a note to self?
 * A single bare word is the dangerous case — a geocoder will happily match
 * "standup" to a café in Kyiv — so it takes a street number, a comma, or at
 * least two words before an unattended lookup is allowed.
 */
function looksLikePlace(query: string): boolean {
  return /\d/.test(query) || query.includes(',') || query.trim().split(/\s+/).length >= 2;
}

/**
 * Geocode text that was typed rather than picked — an event from the assistant,
 * or one created before locations carried coordinates.
 *
 * Deliberately strict, because this runs without anyone asking and a wrong pin
 * is worse than no pin. `searchPlaces` has already discarded anything that does
 * not match the text; what is added here is that the text must be specific
 * enough to be worth matching at all, and that the answer must be unambiguous —
 * three Hotz Roads and no way to tell which is meant is a decision for the
 * person, not for a background lookup.
 */
export async function resolvePlace(query: string, signal: AbortSignal): Promise<Place | null> {
  const q = query.trim();
  if (q.length < MIN_RESOLVE_LENGTH || isMeetingLink(q) || !looksLikePlace(q)) return null;

  // One lookup when an event is opened is not autocomplete, so Nominatim — the
  // stronger address matcher — is fair game here as a second opinion.
  let found = await searchPlaces(q, signal);
  if (found.length === 0) {
    try {
      found = relevant(await searchNominatim(expandQuery(q), signal), q);
    } catch (err) {
      if (signal.aborted) throw err;
      return null;
    }
  }

  const [top, next] = found;
  if (!top) return null;

  // Several hits are fine when they are all the same corner of the world — two
  // providers describing one building, or a campus listed twice. Hits that
  // disagree about which state they are in mean the text was not specific
  // enough to pin unattended: "Duke Chapel" exists in NC and in Tennessee.
  if (next && !roughlyTheSameArea(top, next)) return null;

  return { lat: top.lat, lon: top.lon, label: top.label };
}

/** Within about half a degree — same town, or near enough for a map card. */
function roughlyTheSameArea(a: Place, b: Place): boolean {
  return Math.abs(a.lat - b.lat) < 0.5 && Math.abs(a.lon - b.lon) < 0.5;
}

/* -------------------------------------------------------------------------- */
/* Links                                                                      */
/* -------------------------------------------------------------------------- */

// Hosts recognised without a scheme, because that is how they get pasted:
// "meet.google.com/abc-defg" is a link, not a place to drive to.
const MEETING_HOST =
  /(^|\/\/|\.)(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|meet\.jit\.si|whereby\.com|[a-z0-9-]+\.webex\.com)(\/|$)/i;

/** A meeting link should offer "Join", not a map lookup. */
export function isMeetingLink(value: string): boolean {
  const v = value.trim();
  return /^(https?:\/\/|www\.)/i.test(v) || MEETING_HOST.test(v);
}

export function meetingUrl(value: string): string {
  const v = value.trim();
  return v.startsWith('http') ? v : `https://${v}`;
}

/**
 * Coordinates when we have them — a pin lands exactly where the search result
 * did, whereas re-searching the text can drift to a different branch.
 */
export function mapsUrl(location: string, place?: Place): string {
  const query = place ? `${place.lat},${place.lon}` : location;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function directionsUrl(location: string, place?: Place): string {
  const dest = place ? `${place.lat},${place.lon}` : location;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}

/**
 * An OpenStreetMap embed, which needs no key and no SDK. The box is about
 * 600m across — close enough to recognise the block, wide enough to orient.
 */
export function mapEmbedUrl(place: Place): string {
  const pad = 0.004;
  const bbox = [place.lon - pad, place.lat - pad / 2, place.lon + pad, place.lat + pad / 2].join(',');
  return (
    `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}` +
    `&layer=mapnik&marker=${place.lat},${place.lon}`
  );
}
