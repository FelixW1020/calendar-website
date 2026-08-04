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

  const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street;
  const name = p.name || street || p.city || p.state || p.country;
  if (!name) return null;

  const detail = joinParts([
    name === street ? null : street,
    p.city || p.district || p.county,
    p.state,
    p.postcode,
    p.country,
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
  url.searchParams.set('limit', '6');
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
    const parts = r.display_name.split(',').map((s) => s.trim());
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
 * Nobody types "Road" or "Northwest". Both sides of a comparison are expanded
 * to the long form so "rd" matches "Road" and "n" matches "North".
 */
const ABBREVIATIONS: Record<string, string> = {
  rd: 'road',
  st: 'street',
  str: 'street',
  ave: 'avenue',
  av: 'avenue',
  dr: 'drive',
  ln: 'lane',
  blvd: 'boulevard',
  ct: 'court',
  pl: 'place',
  ter: 'terrace',
  cir: 'circle',
  hwy: 'highway',
  pkwy: 'parkway',
  sq: 'square',
  mt: 'mount',
  ft: 'fort',
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
  ne: 'northeast',
  nw: 'northwest',
  se: 'southeast',
  sw: 'southwest',
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t);
}

/**
 * Send the long form to the geocoder, not what was typed. This single change
 * is most of the accuracy: asked for "6 hotz rd" Photon offers 3rd Avenue in
 * New York, while "6 hotz road" finds the Hotz Roads — it indexes the spelled
 * out street type and cannot see through the abbreviation.
 */
export function expandQuery(query: string): string {
  return query
    .split(/([^A-Za-z0-9]+)/)
    .map((part) => ABBREVIATIONS[part.toLowerCase()] ?? part)
    .join('');
}

/**
 * Does this result actually answer what was typed?
 *
 * This is the guard that matters. Geocoders would rather return something than
 * nothing — a search for "6 hotz rd, lin" came back with Lincolnshire
 * postcodes, none of them on any road called Hotz. Showing those is worse than
 * showing nothing, so every word of the query has to appear in the result.
 *
 * Words match by prefix, since the user is mid-type and "chap" is a fair match
 * for "Chapel". Numbers must match exactly — house number 6 is not 6032 — with
 * one exception: OpenStreetMap knows most streets but only some of the
 * buildings on them, so a leading house number is allowed to be missing. That
 * is reported back, because it makes the pin street-level rather than exact.
 */
interface Match {
  /** The street matched but the building is not in the map data. */
  approximate: boolean;
}

export function matchQuery(
  queryTokens: string[],
  label: string,
  /** The result's own building number, if the provider had one. */
  houseNumber?: string,
): Match | null {
  const labelTokens = tokenize(label);
  const has = (q: string) =>
    labelTokens.some((l) => (/^\d+$/.test(q) ? l === q : l.startsWith(q)));

  const typedNumber = /^\d+$/.test(queryTokens[0] ?? '') ? queryTokens[0] : null;
  const rest = typedNumber ? queryTokens.slice(1) : queryTokens;

  // The street, town and anything else typed must all be there.
  if (rest.length === 0 || !rest.every(has)) return null;
  if (!typedNumber) return { approximate: false };

  // A result that knows its own number must be the number that was asked for:
  // 3025 Main Street is not 302 Main Street.
  if (houseNumber) return houseNumber === typedNumber ? { approximate: false } : null;

  // No number on the result — the street matched and the building is simply
  // not in the map data, which is the common case outside dense cities.
  return { approximate: !has(typedNumber) };
}

/** Re-attach the number the map data is missing, so the text reads as typed. */
function withHouseNumber(s: Suggestion, houseNumber: string): Suggestion {
  return {
    ...s,
    name: `${houseNumber} ${s.name}`,
    label: `${houseNumber} ${s.label}`,
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
    // Two providers describing the same doorway agree to about a metre.
    const key = `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
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
  // An exact building beats the street it stands on.
  return dedupe(kept.sort((a, b) => Number(a.approximate ?? false) - Number(b.approximate ?? false)));
}

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

  // The last word may be a town half-typed. If the full string finds nothing,
  // try again without it — results are still filtered against the full text, so
  // a town starting with "lin" is what comes back, if one exists.
  const attempts = [query.trim(), withoutTrailingFragment(query)].filter(
    (a): a is string => a !== null,
  );

  for (const attempt of attempts) {
    let raw: Suggestion[];
    try {
      raw = await searchPhoton(expandQuery(attempt), signal);
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
