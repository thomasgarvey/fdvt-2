// Towns: the unit a fire department is organised around, and the only place
// where the boundary, the department and the buildings meet. Kept beside
// lib/stations.ts and built from the same roster so the two cannot disagree
// about which towns exist.
import townsData from '../data/towns.json';
import departmentsData from '../data/departments.json';
import { normTown, stations, titleCase, type Station } from './stations';

export type Department = (typeof departmentsData)[number];

export interface Boundary {
  name: string;
  fips: number;
  acres: number;
  sqmi: number;
  rings: number[][][];
}

export interface Town {
  slug: string;
  name: string;
  county: string;
  boundary: Boundary | null;
  departments: Department[];
  stations: Station[];
  photographed: number;
}

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const boundaryByTown = new Map<string, Boundary>();
for (const [town, b] of Object.entries(townsData as Record<string, Boundary>)) {
  boundaryByTown.set(normTown(town), b);
}

// A department's City is sometimes the village it sits in ("Highgate Center")
// rather than the town the roster files it under. Match on the normalised name
// and fall back to the leading word, which is what village names share with
// their parent town.
const deptsByTown = new Map<string, Department[]>();
for (const d of departmentsData as Department[]) {
  const key = normTown(d.town);
  if (!key) continue;
  if (!deptsByTown.has(key)) deptsByTown.set(key, []);
  deptsByTown.get(key)!.push(d);
}

const townNames = [...new Set(stations.map((s) => s.town).filter(Boolean))].sort();

export const towns: Town[] = townNames.map((name) => {
  const key = normTown(name);
  const inTown = stations.filter((s) => s.town === name);
  return {
    slug: slugify(name),
    name,
    county: inTown.find((s) => s.county)?.county ?? '',
    boundary: boundaryByTown.get(key) ?? null,
    departments: deptsByTown.get(key) ?? [],
    stations: inTown,
    photographed: inTown.filter((s) => s.photo).length,
  };
});

export const townBySlug = new Map(towns.map((t) => [t.slug, t]));

/** The town page a station belongs to, for linking from the building. */
export const townSlugForStation = (station: Station) => slugify(station.town);

/** Members across every department in the town, or null when none are recorded. */
export const memberCount = (t: Town) => {
  const each = t.departments.flatMap((d) =>
    [d.members.volunteer, d.members.paidPerCall, d.members.career].filter(
      (n): n is number => typeof n === 'number',
    ),
  );
  return each.length ? each.reduce((a, b) => a + b, 0) : null;
};

/**
 * The burn rule is set by state law, not by the town, so every town page can
 * state it truthfully. Only the local contact varies, and that is the part
 * that has to be typed in per department.
 */
export const BURN_RULE =
  'Vermont requires a Permit to Kindle Fire from the town’s Forest Fire Warden for ' +
  'anything larger than a campfire — except where snow covers the ground at the burn ' +
  'site, or the fire is at least 200 feet from anything that will carry flame. Wardens ' +
  'can suspend burning outright when fire danger is high. Who to ask locally is recorded ' +
  'department by department; where it is blank below, the fire department itself is the ' +
  'place to start.';

/**
 * Projects a town outline into an SVG path. Equirectangular with a cos(lat)
 * correction on x, which at the width of a Vermont town is indistinguishable
 * from a proper projection and needs no dependency.
 */
export function outlinePath(rings: number[][][], size = 300, pad = 6) {
  const pts = rings.flat();
  const lat0 = (Math.min(...pts.map((p) => p[1])) + Math.max(...pts.map((p) => p[1]))) / 2;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p[0] * k);
  const ys = pts.map((p) => p[1]);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = (size - pad * 2) / span;
  // Centre the shorter axis; y flips because SVG counts downward.
  const offX = pad + ((size - pad * 2) - (maxX - minX) * scale) / 2;
  const offY = pad + ((size - pad * 2) - (maxY - minY) * scale) / 2;
  const project = (lng: number, lat: number): [number, number] => [
    offX + (lng * k - minX) * scale,
    offY + (maxY - lat) * scale,
  ];
  const d = rings
    .map((r) => r.map(([lng, lat], i) => {
      const [x, y] = project(lng, lat);
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join('') + 'Z')
    .join('');
  return { d, project, size };
}

export { titleCase };
