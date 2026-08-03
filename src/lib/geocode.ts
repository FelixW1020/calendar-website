import type { Place } from '../types';

/**
 * Address lookup for the location field.
 *
 * Both providers are OpenStreetMap-based, keyless and CORS-open, so the app
 * keeps its "clone it and it runs" property — no billing account, nothing to
 * put in .env. Photon is built for type-ahead and answers partial words;
 * Nominatim is the fallback because it is the more literal address matcher
 * (and stays up when Photon does not).
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

async function searchNominatim(query: string, signal: AbortSignal): Promise<Suggestion[]> {
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
  }[];

  const out: Suggestion[] = [];
  for (const r of rows) {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const parts = r.display_name.split(',').map((s) => s.trim());
    const name = r.name?.trim() || parts[0];
    const detail = joinParts(parts.filter((p) => p.toLowerCase() !== name.toLowerCase()));
    out.push({ lat, lon, name, detail, label: joinParts([name, detail]), source: 'search' });
  }
  return out;
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
 * Returns [] rather than throwing when both providers fail: a location field
 * that quietly stops suggesting is a far better outcome than one that breaks
 * the editor because the network is down.
 */
export async function searchPlaces(query: string, signal: AbortSignal): Promise<Suggestion[]> {
  const key = query.trim().toLowerCase();
  if (key.length < 3) return [];

  const hit = cache.get(key);
  if (hit) return hit;

  let results: Suggestion[] = [];
  try {
    results = await searchPhoton(query, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    try {
      results = await searchNominatim(query, signal);
    } catch (fallbackErr) {
      if (signal.aborted) throw fallbackErr;
      console.warn('[geocode] both providers failed', fallbackErr);
      return [];
    }
  }

  remember(key, results);
  return results;
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
 * is worse than no pin: the top hit is accepted only when it accounts for every
 * meaningful word of the query. That rejects "Room 302" while accepting
 * "1364 Campus Dr Durham". Anything turned down here is still one click away
 * in the suggestion list.
 */
export async function resolvePlace(query: string, signal: AbortSignal): Promise<Place | null> {
  const q = query.trim();
  if (q.length < MIN_RESOLVE_LENGTH || isMeetingLink(q) || !looksLikePlace(q)) return null;

  const [top] = await searchPlaces(q, signal);
  if (!top) return null;

  const haystack = top.label.toLowerCase();
  const words = q
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length > 2 || /^\d+$/.test(w));
  if (words.length === 0 || !words.every((w) => haystack.includes(w))) return null;

  return { lat: top.lat, lon: top.lon, label: top.label };
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
