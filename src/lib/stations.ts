// One place that turns the two data files into the station records the
// per-station pages are built from. Kept out of the pages themselves so the
// index and the detail pages cannot drift apart.
import stationsData from '../data/stations.json';
import photosData from '../data/photos.json';

export type Photo = (typeof photosData)[number];

export interface Station {
  slug: string;
  esiteid: number;
  address: string;      // title-cased
  town: string;         // title-cased
  county: string;       // title-cased, no "County" suffix
  zip: string;
  lat: number;
  lng: number;
  mapped: string;
  updated: string;
  /** Department name from Airtable when we have a photo linked to it. */
  department: string | null;
  photo: Photo | null;
  /** What to call the station in a heading. */
  name: string;
}

export const titleCase = (s: string | null | undefined) =>
  (s ?? '').toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bVt\b/g, 'VT')
    .replace(/\bUs\b/g, 'US');

// Address normaliser shared with LocationMap — E911 and Airtable spell
// streets differently ("Avenue"/"AVE", "VT-12"/"VT ROUTE 12").
const ADDR_TOKENS: Record<string, string> = {
  SOUTH: 'S', NORTH: 'N', EAST: 'E', WEST: 'W',
  AVENUE: 'AVE', STREET: 'ST', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN',
  TURNPIKE: 'TPKE', PARKWAY: 'PKWY', HIGHWAY: 'HWY', ROUTE: '', RTE: '', RT: '',
};
const normAddr = (s: string | null | undefined) =>
  (s ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/).map((w) => (w in ADDR_TOKENS ? ADDR_TOKENS[w] : w))
    .filter(Boolean).join(' ');

// Photos carry E911's uppercase town ("SOUTH BURLINGTON"); Airtable's roster is
// title-case ("South Burlington"). Compare on a normalised form, and treat
// Saint/St alike — that difference silently dropped both St. Albans photos once.
export const normTown = (s: string | null | undefined) =>
  (s ?? '').toUpperCase().replace(/\b(SAINT|ST\.?)\b/g, 'ST')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The roster comes from Airtable's Fire Stations table (synced to
// src/data/stations.json); a station is retired by setting Status there, not
// by editing code.
const features = stationsData;

// photos indexed by normalised street address, the same join the map uses
const photoByAddr = new Map<string, Photo>();
const townPhotos = new Map<string, Photo[]>();
const stationsPerTown = new Map<string, number>();
for (const f of features) {
  const t = normTown(f.town);
  if (t) stationsPerTown.set(t, (stationsPerTown.get(t) ?? 0) + 1);
}
for (const p of photosData) {
  const a = normAddr(p.stationAddress);
  if (a && !photoByAddr.has(a)) photoByAddr.set(a, p);
  const t = normTown(p.town);
  if (t) {
    if (!townPhotos.has(t)) townPhotos.set(t, []);
    townPhotos.get(t)!.push(p);
  }
}

function photoFor(townRaw: string, addrRaw: string): Photo | null {
  const exact = photoByAddr.get(normAddr(addrRaw));
  if (exact) return exact;
  // town-wide only where it cannot be ambiguous
  if ((stationsPerTown.get(townRaw) ?? 0) > 1) return null;
  return townPhotos.get(townRaw)?.[0] ?? null;
}

const seen = new Set<string>();
export const stations: Station[] = features.map((f) => {
  const town = titleCase(f.town);
  const address = titleCase(f.address);
  const photo = photoFor(normTown(f.town), f.address);

  let slug = slugify(`${town} ${address}`);
  if (seen.has(slug)) slug = `${slug}-${f.esiteid ?? f.id}`; // guarantees uniqueness
  seen.add(slug);

  const department = photo?.department?.name ?? null;
  // A station's name used to come from its department record, which worked only
  // while departments were really stations ("Burlington Fire Department #3").
  // Consolidating those left five Burlington pages all called "Burlington Fire
  // Station". Prefer the photograph's caption, which names the building, and
  // fall back to the town. Airtable's Fire Stations table has no name column
  // yet — that is where this belongs.
  const name = f.name?.trim() || photo?.caption?.trim() || department || `${town} Fire Station`;
  return {
    slug,
    esiteid: f.esiteid as number,
    address,
    town,
    county: titleCase((f.county ?? '').replace(/ County$/i, '')),
    zip: f.zip ?? '',
    lat: f.lat as number,
    lng: f.lng as number,
    mapped: f.mapped ?? '',
    updated: f.updated ?? '',
    department,
    photo,
    name,
  };
}).sort((a, b) => a.town.localeCompare(b.town) || a.address.localeCompare(b.address));

export const photographedCount = stations.filter((s) => s.photo).length;

/** Photo id → the station page showing it, for linking a thumbnail anywhere. */
export const slugByPhotoId = new Map(
  stations.filter((s) => s.photo).map((s) => [s.photo!.id, s.slug]),
);

/**
 * Where a thumbnail of this photo should lead. Falls back to the station index
 * for photos whose department has no station page — never to the bare image,
 * which strands people outside the archive.
 */
export const photoHref = (photoId: string) => {
  const slug = slugByPhotoId.get(photoId);
  return slug ? `/stations/${slug}` : '/stations';
};
