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
  /** Learned from the roster at sync time; null for a town we have no station in. */
  county: string | null;
  /** Whether any station in the roster sits in this town. */
  onRoster: boolean;
  acres: number;
  sqmi: number;
  /** Bounding-box centre, where a label sits. */
  centre: number[];
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
 * A town drawn inside its county, which is the context a town outline on its
 * own cannot give: who the neighbours are, where the next station is, and how
 * far away it sits. Equirectangular with a cos(lat) correction on x — at the
 * width of a Vermont county that is indistinguishable from a real projection
 * and needs no dependency.
 */
export function countyMap(subject: Town, width = 680, maxHeight = 620, pad = 14) {
  const all = Object.values(townsData) as Boundary[];
  // Fall back to the town alone when we have no county for it, so a page still
  // renders rather than disappearing.
  const inCounty = subject.county
    ? all.filter((t) => t.county === subject.county)
    : subject.boundary
      ? [subject.boundary]
      : [];
  if (!inCounty.length) return null;

  const pts = inCounty.flatMap((t) => t.rings.flat());
  const lat0 = (Math.min(...pts.map((p) => p[1])) + Math.max(...pts.map((p) => p[1]))) / 2;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p[0] * k);
  const ys = pts.map((p) => p[1]);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  // Fit the width, then let the height follow the county's real shape rather
  // than padding a fixed box — a tall county like Chittenden otherwise renders
  // as a small shape stranded in white space.
  const wSpan = maxX - minX || 1;
  const hSpan = maxY - minY || 1;
  const scale = Math.min((width - pad * 2) / wSpan, (maxHeight - pad * 2) / hSpan);
  const height = Math.round(hSpan * scale + pad * 2);
  const offX = pad + (width - pad * 2 - wSpan * scale) / 2;
  const offY = pad;
  const project = (lng: number, lat: number): [number, number] => [
    offX + (lng * k - minX) * scale,
    offY + (maxY - lat) * scale,
  ];
  const pathFor = (rings: number[][][]) =>
    rings
      .map((r) => r.map(([lng, lat], i) => {
        const [x, y] = project(lng, lat);
        return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join('') + 'Z')
      .join('');

  const subjectKey = normTown(subject.name);
  const shapes = inCounty.map((t) => {
    const [cx, cy] = project(t.centre[0], t.centre[1]);
    const xsT = t.rings.flat().map((p) => p[0] * k);
    const widthPx = (Math.max(...xsT) - Math.min(...xsT)) * scale;
    return {
      name: t.name,
      isSubject: normTown(t.name) === subjectKey,
      onRoster: t.onRoster,
      d: pathFor(t.rings),
      cx,
      cy,
      // Around Burlington the towns are small and the labels collide. Only
      // label a town wide enough to hold its own name at 8px.
      labelled: widthPx > t.name.length * 4.6,
      slug: slugify(t.name),
    };
  });

  // Every station in the county, so mutual aid has a shape on the page.
  const points = stations
    .filter((s) => !subject.county || s.county === subject.county)
    .map((s) => {
      const [x, y] = project(s.lng, s.lat);
      return {
        x, y,
        mine: normTown(s.town) === subjectKey,
        photo: !!s.photo,
        label: `${s.name} — ${s.address}, ${s.town}`,
        slug: s.slug,
      };
    });

  // A scale bar in whole miles: one degree of latitude is 69.0 miles, and y is
  // projected from raw latitude, so pixels-per-mile falls straight out.
  const pxPerMile = scale / 69.0;
  const miles = [1, 2, 5, 10, 20, 50].find((m) => m * pxPerMile > width * 0.15) ?? 50;

  return {
    width, height, shapes, points,
    scale: { miles, px: miles * pxPerMile },
    county: subject.county,
  };
}

export { titleCase };
