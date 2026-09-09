/**
 * Town boundaries and acreage, from VCGI's open FeatureServer.
 *
 * Every town that has at least one station in the roster gets its polygon and
 * its area written to src/data/towns.json. The polygon is what draws the
 * outline on a town page; the area is the only honest source for "how much
 * ground does this department cover" that does not require asking someone.
 *
 * Fire district boundaries are NOT the same as town boundaries — mutual aid,
 * village districts and contracted coverage all cut across them. The town line
 * is a stated approximation, and the page says so.
 *
 *   node scripts/sync-town-boundaries.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE =
  'https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services' +
  '/FS_VCGI_OPENDATA_Boundary_BNDHASH_poly_towns_SP_v1/FeatureServer/0/query';

const SQM_PER_ACRE = 4046.8564224;
const SQM_PER_SQMI = 2589988.110336;

// VCGI spells towns in caps and without the "Saint"/"St." variance the roster
// carries; normalise both sides the way src/lib/stations.ts does.
const norm = (s) =>
  (s ?? '')
    .toUpperCase()
    .replace(/\b(SAINT|ST\.?)\b/g, 'ST')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Round coordinates to ~1m. A town outline drawn at map scale does not need
// seven decimal places, and this roughly halves the committed file.
const round = (n) => Math.round(n * 1e5) / 1e5;

const stations = JSON.parse(readFileSync(`${ROOT}/src/data/stations.json`, 'utf8'));
const wanted = new Map();
for (const s of stations) if (s.town) wanted.set(norm(s.town), s.town);

// VCGI files a county as a number. We hold the names on the roster, so learn
// the mapping from the towns that appear in both rather than hard-coding a
// table that could silently go wrong.
const countyName = new Map();
const rosterCounty = new Map();
for (const s of stations) if (s.town && s.county) rosterCounty.set(norm(s.town), s.county);

const url = new URL(SERVICE);
url.searchParams.set('where', '1=1');
url.searchParams.set("outFields", "TOWNNAMEMC,CNTY,FIPS6,Shape__Area");
url.searchParams.set('returnGeometry', 'true');
url.searchParams.set('outSR', '4326');
url.searchParams.set('f', 'json');

const res = await fetch(url);
if (!res.ok) throw new Error(`VCGI ${res.status} ${res.statusText}`);
const data = await res.json();
if (data.error) throw new Error(`VCGI: ${JSON.stringify(data.error)}`);

const features = data.features ?? [];
for (const f of features) {
  const county = rosterCounty.get(norm(f.attributes.TOWNNAMEMC));
  if (county && !countyName.has(f.attributes.CNTY)) countyName.set(f.attributes.CNTY, county);
}

// Every Vermont town, not only the ones with a station — a town page draws its
// whole county for context, and the neighbours without stations are exactly the
// gaps worth seeing.
const towns = {};
let matched = 0;
for (const f of features) {
  const a = f.attributes;
  const key = norm(a.TOWNNAMEMC);
  const onRoster = wanted.has(key);
  if (onRoster) matched++;
  const m2 = a.Shape__Area;
  const rings = f.geometry.rings.map((r) => r.map(([x, y]) => [round(x), round(y)]));
  const pts = rings.flat();
  towns[onRoster ? wanted.get(key) : a.TOWNNAMEMC] = {
    name: a.TOWNNAMEMC,
    fips: a.FIPS6,
    county: countyName.get(a.CNTY) ?? null,
    onRoster,
    acres: Math.round(m2 / SQM_PER_ACRE),
    sqmi: Math.round((m2 / SQM_PER_SQMI) * 100) / 100,
    // Bounding-box centre, which is where a town label wants to sit. A true
    // centroid is not worth the arithmetic at this scale.
    centre: [
      round((Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2),
      round((Math.min(...pts.map((p) => p[1])) + Math.max(...pts.map((p) => p[1]))) / 2),
    ],
    // Outer rings only. Vermont towns are simple polygons; keeping holes would
    // complicate the SVG for no visible gain at the scale these are drawn.
    rings,
  };
}

writeFileSync(`${ROOT}/src/data/towns.json`, JSON.stringify(towns, null, 0) + '\n');

const missing = [...wanted.values()].filter((t) => !towns[t]);
const bytes = JSON.stringify(towns).length;
console.log(
  `Towns: ${features.length} from VCGI (${matched} of ${wanted.size} on the roster)` +
    ` -> src/data/towns.json (${(bytes / 1024).toFixed(0)} KB)`,
);
console.log(`Counties named: ${countyName.size} of 14`);
if (missing.length) {
  console.warn(`\n  !! no VCGI boundary for ${missing.length} town(s): ${missing.join(', ')}`);
  console.warn('     Usually a village name where VCGI carries the parent town.');
}
