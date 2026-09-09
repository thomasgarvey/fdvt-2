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

const url = new URL(SERVICE);
url.searchParams.set('where', '1=1');
url.searchParams.set('outFields', 'TOWNNAMEMC,CNTY,FIPS6,Shape__Area');
url.searchParams.set('returnGeometry', 'true');
url.searchParams.set('outSR', '4326');
url.searchParams.set('f', 'json');

const res = await fetch(url);
if (!res.ok) throw new Error(`VCGI ${res.status} ${res.statusText}`);
const data = await res.json();
if (data.error) throw new Error(`VCGI: ${JSON.stringify(data.error)}`);

const towns = {};
let matched = 0;
for (const f of data.features ?? []) {
  const a = f.attributes;
  const key = norm(a.TOWNNAMEMC);
  if (!wanted.has(key)) continue;
  matched++;
  const m2 = a.Shape__Area;
  towns[wanted.get(key)] = {
    name: a.TOWNNAMEMC,
    fips: a.FIPS6,
    acres: Math.round(m2 / SQM_PER_ACRE),
    sqmi: Math.round((m2 / SQM_PER_SQMI) * 100) / 100,
    // Outer rings only. Vermont towns are simple polygons; keeping holes would
    // complicate the SVG for no visible gain at the scale these are drawn.
    rings: f.geometry.rings.map((r) => r.map(([x, y]) => [round(x), round(y)])),
  };
}

writeFileSync(`${ROOT}/src/data/towns.json`, JSON.stringify(towns, null, 0) + '\n');

const missing = [...wanted.values()].filter((t) => !towns[t]);
const bytes = JSON.stringify(towns).length;
console.log(
  `Towns: ${matched} of ${wanted.size} matched -> src/data/towns.json (${(bytes / 1024).toFixed(0)} KB)`,
);
if (missing.length) {
  console.warn(`\n  !! no VCGI boundary for ${missing.length} town(s): ${missing.join(', ')}`);
  console.warn('     Usually a village name where VCGI carries the parent town.');
}
