// Sync photo content from Airtable into the repo.
//
// Airtable attachment URLs expire after ~2 hours, so images must be
// downloaded and served from the site itself. Run this locally, review the
// diff, and commit the result — the deployed build never needs the token.
//
// Usage:  node scripts/sync-airtable.mjs        (requires .env)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency needed)
if (existsSync(`${ROOT}/.env`)) {
  for (const line of readFileSync(`${ROOT}/.env`, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE = process.env.AIRTABLE_BASE_ID;
if (!TOKEN || !BASE) {
  console.error('Missing AIRTABLE_TOKEN / AIRTABLE_BASE_ID (set them in .env)');
  process.exit(1);
}

async function fetchAll(table) {
  let recs = [], offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    u.searchParams.set('pageSize', '100');
    if (offset) u.searchParams.set('offset', offset);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const d = await res.json();
    if (d.error) throw new Error(`Airtable ${table}: ${JSON.stringify(d.error)}`);
    recs.push(...d.records);
    offset = d.offset;
  } while (offset);
  return recs;
}

const HIDDEN_STATUSES = new Set(['Draft', 'Archived']);

// Town-key derivation — mirrors the coordinate-matching logic so photos can
// be joined to E911 map markers by TOWNNAME.
const norm = (s) => (s ?? '')
  .toUpperCase()
  .replace(/\b(SAINT|ST\.?)\b/g, 'ST')
  .replace(/[^A-Z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const SUFFIX = /\b(VOLUNTEER|VOL|FIRE|DEPARTMENT|DEPT|DISTRICT|DIST|RESCUE|EMS|AND|COMPANY|CO|SERVICES?|VILLAGE|TOWN|CITY|OF|VFD|STATION|CENTRAL|TECHNICAL|TEAM|SQUAD|#?\d+)\b/g;
const VILLAGE_TO_TOWN = {
  ASCUTNEY: 'WEATHERSFIELD',
  MORRISVILLE: 'MORRISTOWN',
  'NEWPORT CENTER': 'NEWPORT TOWN',
  'BEECHER FALLS': 'CANAAN',
};
// E911 towns are the join target — validate keys against the real list.
// Compare on the normalized form but return the raw TOWNNAME, since that is
// what the map keys pins by. (E911 spells out "SAINT ALBANS TOWN" while norm()
// rewrites SAINT -> ST, so comparing normalized-to-raw silently missed those.)
const E911_TOWNS = [...new Set(
  JSON.parse(readFileSync(`${ROOT}/src/data/locations.geojson`, 'utf8'))
    .features.map((f) => f.properties.TOWNNAME),
)];
const TOWN_BY_NORM = new Map(E911_TOWNS.map((t) => [norm(t), t]));
function townKey(dept) {
  const fromName = norm(dept['Department Name']).replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  const city = norm(dept.City);
  const cands = [];
  for (const c of [fromName, city]) {
    if (!c) continue;
    cands.push(VILLAGE_TO_TOWN[c] ?? c);
    cands.push(...c.split(' ')); // two-town depts, e.g. "Underhill Jericho"
  }
  for (const c of cands) {
    const hit = TOWN_BY_NORM.get(norm(c));
    if (hit) return hit;
  }
  // Prefix fallback: "ESSEX" -> "ESSEX TOWN", "ESSEX JUNCTION" -> "ESSEX JUNCTION CITY"
  for (const c of cands) {
    const n = norm(c);
    const pref = [...TOWN_BY_NORM.keys()].filter((t) => t.startsWith(n + ' ') || n.startsWith(t + ' '));
    if (pref.length) return TOWN_BY_NORM.get(pref.sort((a, b) => a.length - b.length)[0]);
  }
  return null;
}
const ext = (type, filename) =>
  ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type]
    ?? filename?.split('.').pop()?.toLowerCase() ?? 'jpg');

// --- Placing photos that have no fire-station pin -------------------------
// Mirrors the map's findPhoto() test: a photo lands on a station when the
// department's street address matches one, or the town has exactly one.
const ADDR_TOKENS = {
  SOUTH: 'S', NORTH: 'N', EAST: 'E', WEST: 'W',
  AVENUE: 'AVE', STREET: 'ST', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN',
  TURNPIKE: 'TPKE', PARKWAY: 'PKWY', HIGHWAY: 'HWY', ROUTE: '', RTE: '', RT: '',
};
const normAddr = (s) => (s ?? '')
  .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/)
  .map((w) => (w in ADDR_TOKENS ? ADDR_TOKENS[w] : w)).filter(Boolean).join(' ');

const STATION_ADDRS = {};
for (const f of JSON.parse(readFileSync(`${ROOT}/src/data/locations.geojson`, 'utf8')).features) {
  (STATION_ADDRS[f.properties.TOWNNAME] ??= []).push(normAddr(f.properties.PRIMARYADD));
}
function hasStationPin(town, address) {
  const list = town ? STATION_ADDRS[town] : null;
  if (!list?.length) return false;
  return list.includes(normAddr(address)) || list.length === 1;
}

// Vermont's official E911 address-point geocoder. Departments in towns with
// no FIRE STATION point (or at buildings filed under another site type, e.g.
// AMBULANCE SERVICE) get coordinates from their Airtable street address, so
// nobody has to look up and paste lat/lng by hand.
const GEOCODER = 'https://maps.vcgi.vermont.gov/arcgis/rest/services/EGC_services/GCS_E911_COMPOSITE_SP_v2/GeocodeServer/findAddressCandidates';
const geocodeCache = new Map();
async function geocode(address, city) {
  const single = [address, city, 'VT'].filter(Boolean).join(', ');
  if (geocodeCache.has(single)) return geocodeCache.get(single);
  const u = new URL(GEOCODER);
  u.searchParams.set('SingleLine', single);
  u.searchParams.set('outSR', '4326');
  u.searchParams.set('maxLocations', '1');
  u.searchParams.set('f', 'json');
  let hit = null;
  try {
    const d = await (await fetch(u)).json();
    const c = d.candidates?.[0];
    // Only trust a confident match; a vague one would drop a pin in the wrong place.
    if (c && c.score >= 90) hit = { lat: c.location.y, lng: c.location.x, matched: c.address };
  } catch {
    hit = null;
  }
  geocodeCache.set(single, hit);
  return hit;
}

const [photos, depts, stationRows] = await Promise.all([
  fetchAll('Photos'), fetchAll('Fire Departments'), fetchAll('Fire Stations'),
]);
const deptById = new Map(depts.map((r) => [r.id, r.fields]));
// Airtable's Fire Stations table, keyed by record id so a photo's Station link
// resolves straight to a building — no address guessing.
const stationById = new Map(stationRows.map((r) => [r.id, r.fields]));

mkdirSync(`${ROOT}/public/photos`, { recursive: true });
const out = [];
for (const r of photos) {
  const f = r.fields;
  const att = f.Photo?.[0];
  if (!att) continue;
  if (HIDDEN_STATUSES.has(f['Publication Status'])) continue;

  const e = ext(att.type, att.filename);
  const fullPath = `photos/${r.id}.${e}`;
  const thumbPath = `photos/${r.id}.thumb.${e}`;
  const thumb = att.thumbnails?.large ?? att;

  for (const [url, path] of [[att.url, fullPath], [thumb.url, thumbPath]]) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status}): ${path}`);
    writeFileSync(`${ROOT}/public/${path}`, Buffer.from(await res.arrayBuffer()));
  }

  const dept = deptById.get(f['Fire Department']?.[0]);
  // The Station link is the authority once set (migration step 2); the address
  // join below stays as a fallback for photos not yet linked.
  const linkedStation = stationById.get(f.Station?.[0]);
  const station = linkedStation && linkedStation.Status !== 'Retired' ? linkedStation : undefined;
  out.push({
    id: r.id,
    src: `/${fullPath}`,
    thumb: `/${thumbPath}`,
    width: att.width ?? null,
    height: att.height ?? null,
    thumbWidth: thumb.width ?? null,
    thumbHeight: thumb.height ?? null,
    caption: f.Caption ?? '',
    photographer: f.Photographer ?? '',
    dateTaken: f['Date Taken'] ?? null,
    featured: !!f.Featured,
    department: dept
      ? { name: dept['Department Name'] ?? '', city: dept.City ?? '', county: dept.County ?? '' }
      : null,
    town: station ? townKey({ City: station.Town, 'Department Name': station.Town }) : (dept ? townKey(dept) : null),
    // Department's own coordinates, when set in Airtable. Used only as a
    // fallback: some departments (rescue squads, say) occupy buildings the
    // state's FIRE STATION layer doesn't include, so there is no pin to
    // attach to. Given a lat/lng the map draws its own pin for them.
    lat: typeof dept?.Latitude === 'number' ? dept.Latitude : null,
    lng: typeof dept?.Longitude === 'number' ? dept.Longitude : null,
    // Pins the photo to one building in multi-station towns. Per-photo
    // "Station Address" (Photos table) wins if present; otherwise the linked
    // department's Street Address (per-station dept records carry these).
    stationAddress: station?.['Street Address'] ?? f['Station Address'] ?? dept?.['Street Address'] ?? null,
    // Which route placed this photo, so the parity check can show its working.
    placedBy: station ? 'station-link' : (dept ? 'address-join' : 'unplaced'),
    esiteid: station?.ESITEID ?? null,
  });
}

// Fill coordinates for photos with no station pin to land on. Airtable's own
// Latitude/Longitude wins if set; otherwise geocode the department address.
let geocoded = 0;
for (const p of out) {
  if (p.lat != null && p.lng != null) continue;
  if (!p.department || hasStationPin(p.town, p.stationAddress)) continue;
  if (!p.stationAddress) continue;
  const hit = await geocode(p.stationAddress, p.department.city);
  if (hit) {
    p.lat = hit.lat;
    p.lng = hit.lng;
    geocoded++;
    console.log(`  geocoded "${p.caption || p.department.name}" -> ${hit.matched}`);
  }
}

// Featured first, then newest
out.sort((a, b) => (b.featured - a.featured) || String(b.dateTaken).localeCompare(String(a.dateTaken)));
writeFileSync(`${ROOT}/src/data/photos.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`Synced ${out.length} photos (${photos.length} records total), ${geocoded} geocoded -> src/data/photos.json + public/photos/`);

// --- The station roster the site draws ------------------------------------
// Airtable's Fire Stations table is the source of truth for which stations
// exist and where. Retiring one is a Status change here, not a code edit —
// which is what src/data/excluded-stations.json used to do.
const roster = stationRows
  .filter((r) => r.fields.Status !== 'Retired')
  .map((r) => {
    const f = r.fields;
    return {
      id: r.id,
      esiteid: f.ESITEID ?? null,
      // What the building is called, when anyone has said. Beats guessing from
      // a photograph caption, and is the only way two stations in one town get
      // distinct names when neither has been photographed.
      name: (f['Station Name'] ?? '').trim() || null,
      address: f['Street Address'] ?? '',
      town: f.Town ?? '',
      county: f.County ?? '',
      zip: f.Zip != null ? String(f.Zip).padStart(5, '0') : '',
      lat: typeof f.Latitude === 'number' ? f.Latitude : null,
      lng: typeof f.Longitude === 'number' ? f.Longitude : null,
      mapped: f['E911 Mapped'] ?? '',
      updated: f['E911 Updated'] ?? '',
    };
  })
  .filter((s) => s.lat != null && s.lng != null && s.address && s.town)
  .sort((a, b) => a.town.localeCompare(b.town) || a.address.localeCompare(b.address));

writeFileSync(`${ROOT}/src/data/stations.json`, JSON.stringify(roster, null, 2) + '\n');
const dropped = stationRows.filter((r) => r.fields.Status !== 'Retired').length - roster.length;
console.log(`Roster: ${roster.length} active stations -> src/data/stations.json${dropped ? `  (${dropped} skipped: missing coordinates or address)` : ''}`);

// Retired stations, kept in the repo so the reasons survive in git history —
// each one is a building somebody drove to and checked.
const retired = stationRows
  .filter((r) => r.fields.Status === 'Retired')
  .map((r) => ({
    esiteid: r.fields.ESITEID ?? null,
    address: r.fields['Street Address'] ?? '',
    town: r.fields.Town ?? '',
    reason: r.fields['Retired Reason'] ?? '',
  }))
  .sort((a, b) => a.town.localeCompare(b.town) || a.address.localeCompare(b.address));
writeFileSync(`${ROOT}/src/data/retired-stations.json`, JSON.stringify(retired, null, 2) + '\n');
// A photograph whose station has been retired has nowhere to land and simply
// vanishes from the map. Retiring is a one-click action in Airtable, so say so
// loudly rather than letting the picture disappear quietly.
const rosterIds = new Set(roster.map((s) => s.esiteid));
const orphaned = out.filter(
  (p) => !(p.esiteid != null && rosterIds.has(p.esiteid)) && p.lat == null,
);
if (orphaned.length) {
  console.warn(`\n  !! ${orphaned.length} photograph(s) have nowhere to land and will NOT appear:`);
  for (const p of orphaned) {
    console.warn(`     - ${p.caption || p.department?.name || p.id}`);
  }
  console.warn('     Usually this means the station was retired in Airtable, or its');
  console.warn('     department has no address to match. Check before deploying.\n');
}

const noReason = retired.filter((r) => !r.reason).length;
console.log(`Retired: ${retired.length} -> src/data/retired-stations.json${noReason ? `  (${noReason} with no reason recorded)` : ''}`);

// --- Departments, for the town pages ---------------------------------------
// The station roster answers "what buildings are there"; this answers "who
// works out of them, and on what terms". Everything below the headcounts is
// prose typed into Airtable with its source named in the text — the site
// renders it, it does not invent it, and a blank field renders as nothing
// rather than as a guess.
const num = (v) => (typeof v === 'number' ? v : null);
const str = (v) => {
  const s = (v ?? '').toString().trim();
  return s || null;
};

const departments = depts
  .filter((r) => r.fields.Status !== 'Retired')
  .map((r) => {
    const f = r.fields;
    return {
      id: r.id,
      name: f['Department Name'] ?? '',
      town: f.City ?? '',
      county: f.County ?? '',
      fdid: str(f.FDID),
      type: str(f['Department Type']),
      stations: num(f['Number of Stations']),
      founded: num(f['Year Founded']),
      chief: str(f['Chief Name']),
      phone: str(f['Phone Number']),
      email: str(f.Email),
      website: str(f.Website),
      joinUrl: str(f['Join URL']),
      // Airtable's column names carry a leading space; keep the lookup literal
      // rather than trimming keys, so a rename fails loudly instead of quietly.
      members: {
        volunteer: num(f[' Active Firefighters - Volunteer']),
        paidPerCall: num(f[' Active Firefighters - Paid per Call']),
        career: num(f[' Active Firefighters - Career']),
      },
      joining: str(f.Joining),
      burnPermits: str(f['Burn Permits']),
      history: str(f.History),
      callsNote: str(f['Calls Note']),
      budgetNote: str(f['Budget Note']),
    };
  })
  .sort((a, b) => a.town.localeCompare(b.town) || a.name.localeCompare(b.name));

writeFileSync(`${ROOT}/src/data/departments.json`, JSON.stringify(departments, null, 2) + '\n');
const PROSE = ['joining', 'burnPermits', 'history', 'callsNote', 'budgetNote'];
const detailed = departments.filter((d) => PROSE.some((k) => d[k])).length;
console.log(
  `Departments: ${departments.length} -> src/data/departments.json  (${detailed} with written detail)`,
);
