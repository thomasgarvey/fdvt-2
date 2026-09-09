import { useEffect, useRef, useState } from 'preact/hooks';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';
import photosData from '../../data/photos.json';
import { stations as stationRecords } from '../../lib/stations';

// Slugs come from the same module that generates /stations/[slug], so a popup
// link can never point at a page that was not built.
const SLUG_BY_ESITEID = new Map(stationRecords.map((s) => [s.esiteid, s.slug]));

// Fix broken default marker icons — reference PNGs from public/ to avoid Vite resolution issues
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: '/marker-icon.png',
  iconRetinaUrl: '/marker-icon-2x.png',
  shadowUrl: '/marker-shadow.png',
});

const OSM_TILE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

// Photo-to-station matching lives in lib/stations.ts; this component reads the
// resolved result so the map, the station pages and the search cannot disagree.

type Photo = (typeof photosData)[number];

/**
 * @param href Where the thumbnail should lead. Pass the station's page so a tap
 *   keeps the visitor on the site; omitted (supplemental pins, which have no
 *   page) the image is shown but not linked — opening a bare JPEG in a new tab
 *   just strands people outside the archive.
 */
function photoBlockHtml(p: Photo, href?: string): string {
  const credit = p.photographer ? `<div style="color:var(--fdvt-faint,#888);font-size:11px;margin-top:2px">📷 ${p.photographer}</div>` : '';
  const caption = p.caption && p.caption !== p.department?.name
    ? `<div style="color:var(--fdvt-muted,#555);font-size:12px;margin-top:2px">${p.caption}</div>` : '';
  const img = `<img src="${p.thumb}" alt="${p.caption || 'Station photo'}" style="width:100%;max-width:340px;border-radius:8px;display:block" />`;
  // Without a cue the thumbnail does not look tappable, and the station page is
  // where the photograph is shown full size.
  const cue = href
    ? `<div style="color:var(--fdvt-link,#8B211E);font-size:11px;font-weight:600;margin-top:3px">Tap for the full record →</div>`
    : '';
  const block = href
    ? `<a href="${href}" style="display:block;margin-top:6px;text-decoration:none">${img}${cue}</a>`
    : `<div style="margin-top:6px">${img}</div>`;
  return `${block}${caption}${credit}`;
}


type StationRecord = (typeof stationRecords)[number];

function buildPopup(st: StationRecord): string {
  const p = st.photo;
  const page = `/stations/${st.slug}`;
  const rows: [string, string][] = [
    ['Address', st.address],
    ['Town', st.town],
    ['County', st.county ? `${st.county} County` : ''],
    ['ZIP', st.zip],
  ].filter(([, v]) => v) as [string, string][];
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:2px 8px 2px 0;color:var(--fdvt-muted,#555)">${k}</td><td style="padding:2px 0">${v}</td></tr>`)
    .join('');
  const more = `<a href="${page}" style="display:inline-block;margin-top:6px;font-weight:600;color:var(--fdvt-link,#8B211E)">Station record →</a>`;
  return `<strong>${st.name}</strong>${p ? photoBlockHtml(p, page) : ''}<table style="margin-top:4px;border-collapse:collapse">${table}</table>${more}`;
}

const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bVt\b/g, 'VT');

// Firehouse red = we have a photograph of this station, slate = still needs one.
// Kept in step with the map key on the homepage.
const PHOTO_GREEN = '#8B211E';
const NEEDS_BLUE = '#5C6469';
const pinIcon = (color: string) =>
  L.divIcon({
    html: `<svg width="26" height="38" viewBox="0 0 26 38" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 0.6C6.1 0.6 0.6 6.1 0.6 13c0 8.9 12.4 24.4 12.4 24.4S25.4 21.9 25.4 13C25.4 6.1 19.9 0.6 13 0.6z"
        fill="${color}" stroke="#fff" stroke-width="1.2"/>
      <circle cx="13" cy="13" r="4.6" fill="#fff"/>
    </svg>`,
    className: '',
    iconSize: [26, 38],
    iconAnchor: [13, 38],
    popupAnchor: [0, -34],
  });
// Leaflet caps popups at 300px and otherwise shrinks to fit its content, so an
// image set to width:100% cannot widen it — on a phone that left the photograph
// at ~208px though the thumbnail we ship is 512px. Where there is a photograph,
// pin min and max together to force the width; plain popups still shrink.
const POPUP_W = Math.min(340, Math.max(240, Math.round(window.innerWidth * 0.86)));
const POPUP_OPTS_PHOTO: L.PopupOptions = { maxWidth: POPUP_W, minWidth: POPUP_W };
const POPUP_OPTS_PLAIN: L.PopupOptions = { maxWidth: POPUP_W };

const ICON_WITH_PHOTO = pinIcon(PHOTO_GREEN);
const ICON_NO_PHOTO = pinIcon(NEEDS_BLUE);

interface SearchEntry {
  town: string;      // raw TOWNNAME
  address: string;   // raw PRIMARYADD
  haystack: string;  // uppercase text to match against
  hasPhoto: boolean;
  marker: L.Marker;
}

interface Props {
  height?: string;
  zoom?: number;
  tileUrl?: string;
  attribution?: string;
}

export default function LocationMap({
  height = '500px',
  zoom = 13,
  tileUrl = OSM_TILE,
  attribution = OSM_ATTR,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const clusterRef = useRef<any>(null);
  const indexRef = useRef<SearchEntry[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchEntry[]>([]);

  // Returns the results it just rendered, so callers outside the input (the
  // homepage hero search) can act on the top hit without waiting for state.
  const runSearch = (q: string): SearchEntry[] => {
    setQuery(q);
    const needle = q.toUpperCase().trim();
    if (needle.length < 2) { setResults([]); return []; }
    const scored = indexRef.current
      .filter((e) => e.haystack.includes(needle))
      .sort((a, b) => {
        const aTown = a.town.startsWith(needle) ? 0 : 1;
        const bTown = b.town.startsWith(needle) ? 0 : 1;
        return aTown - bTown || a.town.localeCompare(b.town);
      });
    const top = scored.slice(0, 8);
    setResults(top);
    return top;
  };

  const goTo = (e: SearchEntry) => {
    setQuery('');
    setResults([]);
    clusterRef.current?.zoomToShowLayer(e.marker, () => e.marker.openPopup());
  };

  // The homepage hero search is the page's primary entry point; it hands the
  // query here rather than keeping a second copy of the station index.
  // detail.go means "jump to the best match", not just list the results.
  useEffect(() => {
    const onExternalSearch = (e: Event) => {
      const { q = '', go = false } = (e as CustomEvent).detail ?? {};
      const top = runSearch(q);
      if (go && top[0]) goTo(top[0]);
    };
    window.addEventListener('fdvt:search', onExternalSearch);
    return () => window.removeEventListener('fdvt:search', onExternalSearch);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // Leaflet snaps to whole zoom levels, so fitting Vermont into a phone-sized
    // box lands on 7 when it wants about 7.6 — and 7 frames Montreal and
    // Massachusetts around a small Vermont. Fractional zoom lets the fit be
    // exact; zoomDelta keeps the +/- buttons stepping a whole level at a time.
    const map = L.map(containerRef.current, {
      zoomControl: false,
      zoomSnap: 0,
      zoomDelta: 1,
    });
    // The search pill sits bottom-centre and spans nearly the full width on a
    // phone, which puts it straight over a bottom-left zoom control.
    L.control
      .zoom({ position: window.innerWidth < 700 ? 'topleft' : 'bottomleft' })
      .addTo(map);

    // A photo popup runs ~460px tall: thumbnail, caption, credit, the six-row
    // table and two links. The homepage panel is only clamp(380px, 58vh, 560px),
    // so on a phone the popup is as tall as the map that has to hold it. Leaflet
    // then auto-pans to fit a popup that can never fit, panning hard against the
    // container edge — and every pan re-clusters the markers, which takes the
    // popup's own marker out from under it and closes it. Capping the popup to
    // part of the map's height makes Leaflet scroll the content instead, so the
    // pan settles and the popup stays put. Measured on open, because the panel
    // is a flex child whose height only resolves after mount.
    map.on('popupopen', (e: any) => {
      const max = Math.max(160, Math.round(map.getSize().y * 0.62));
      if (e.popup.options.maxHeight !== max) {
        e.popup.options.maxHeight = max;
        e.popup.update();
      }
    });
    L.tileLayer(tileUrl, { attribution }).addTo(map);

    const cluster = (L as any).markerClusterGroup({
      chunkedLoading: true,
      // Ring shows the share of stations in this cluster that have a photo,
      // so photo coverage is legible before you zoom in to individual pins.
      iconCreateFunction(c: any) {
        const children = c.getAllChildMarkers();
        const count = children.length;
        const withPhoto = children.filter(
          (m: any) => m.options.icon === ICON_WITH_PHOTO,
        ).length;
        const pct = count ? (withPhoto / count) * 100 : 0;
        const size = count < 10 ? 36 : count < 40 ? 44 : 52;
        const inner = size - 9;
        return L.divIcon({
          html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:conic-gradient(${PHOTO_GREEN} 0 ${pct}%, ${NEEDS_BLUE} ${pct}% 100%);display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.35)"><div style="width:${inner}px;height:${inner}px;border-radius:50%;background:#242526;color:#F3EBDD;display:flex;align-items:center;justify-content:center;font-family:'Source Serif 4',Georgia,serif;font-weight:600;font-size:${size < 44 ? 13 : 15}px">${count}</div></div>`,
          className: '',
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });
      },
    });

    const nonPointLayers: L.Layer[] = [];

    const placed = new Set<string>();

    // One pin per active station in Airtable's Fire Stations table. lib/stations
    // has already resolved which photograph belongs to each, so the map does not
    // repeat that matching and cannot disagree with the station pages.
    for (const st of stationRecords) {
      const photo = st.photo;
      if (photo) placed.add(photo.id);
      const marker = L.marker([st.lat, st.lng], {
        icon: photo ? ICON_WITH_PHOTO : ICON_NO_PHOTO,
      }).bindPopup(buildPopup(st), photo ? POPUP_OPTS_PHOTO : POPUP_OPTS_PLAIN);
      cluster.addLayer(marker);
      indexRef.current.push({
        town: st.town.toUpperCase(),
        address: st.address,
        haystack: `${st.town} ${st.address} ${st.zip} ${st.name}`.toUpperCase(),
        hasPhoto: !!photo,
        marker,
      });
    }

    // Photos whose department has no row in Fire Stations (rescue squads, and
    // towns the E911 import missed) get their own pin from the department's
    // coordinates, so a photograph is never stranded off the map.
    for (const p of photosData as Photo[]) {
      if (placed.has(p.id) || p.lat == null || p.lng == null) continue;
      const name = p.department?.name || p.caption || 'Station';
      const addr = p.stationAddress ? `<div style="color:var(--fdvt-muted,#555);margin-top:2px">${p.stationAddress}</div>` : '';
      const marker = L.marker([p.lat, p.lng], { icon: ICON_WITH_PHOTO })
        .bindPopup(`<strong>${name}</strong>${photoBlockHtml(p)}${addr}`, POPUP_OPTS_PHOTO);
      cluster.addLayer(marker);
      // These pins sit outside the E911 town list, so fall back to the
      // department's city for the label the search results show.
      const label = p.town ?? p.department?.city ?? '';
      indexRef.current.push({
        town: label.toUpperCase(),
        address: p.stationAddress ?? '',
        haystack: `${label} ${p.stationAddress ?? ''} ${name}`.toUpperCase(),
        hasPhoto: true,
        marker,
      });
    }

    map.addLayer(cluster);
    clusterRef.current = cluster;
    nonPointLayers.forEach((l) => l.addTo(map));

    // The map lives in a flex row between the header and footer, so its final
    // height can resolve after mount. Re-measure before fitting, and again on
    // the next frame, or the initial fitBounds lands on a world view.
    const fitToStations = () => {
      map.invalidateSize();
      if (cluster.getLayers().length === 1 && stationRecords[0]) {
        map.setView([stationRecords[0].lat, stationRecords[0].lng], zoom);
        return;
      }
      const bounds = cluster.getBounds();
      // Markers are pins anchored at their tip, so they need headroom above;
      // and the search pill covers the bottom ~60px of the map.
      if (bounds.isValid()) {
        // Keep this modest: on a phone the map is only ~470px tall, so every
        // 40px of padding costs most of a zoom level and pushes Vermont back
        // into a view of the whole north-east.
        // fitBounds pads marker *positions*, but a pin is drawn 38px above its
        // anchor and a cluster circle straddles its centre, so both overflow
        // the padded box. Top clears a pin; bottom clears the search pill.
        map.fitBounds(bounds, {
          paddingTopLeft: [10, 44],
          paddingBottomRight: [10, 72],
        });
      }
    };

    fitToStations();
    const raf = requestAnimationFrame(fitToStations);

    // Two frames is not enough: the panel is a flex child whose height settles
    // after fonts and the hero image land. Fitting early against a shorter box
    // yields a lower zoom — the whole north-east instead of Vermont — and
    // nothing corrected it. Refit whenever the container resizes, until the
    // visitor takes control of the view themselves.
    let userHasMoved = false;
    const release = () => { userHasMoved = true; ro.disconnect(); };
    map.once('zoomstart dragstart', release);
    const ro = new ResizeObserver(() => { if (!userHasMoved) fitToStations(); });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      map.remove();
      indexRef.current = [];
      clusterRef.current = null;
    };
  }, []);

  return (
    <div style={{ position: 'relative', height, width: '100%' }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
      <div
        style={{
          position: 'absolute', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 1000, width: 'min(340px, calc(100% - 24px))',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {results.length > 0 && (
          <ul
            style={{
              listStyle: 'none', margin: '0 0 -1px', padding: '4px 0',
              background: 'var(--fdvt-panel, #fff)', color: 'var(--fdvt-panel-ink, #2b2b2b)',
              borderRadius: '12px 12px 0 0', boxShadow: '0 -2px 8px rgba(0,0,0,.2)',
              maxHeight: '300px', overflowY: 'auto',
            }}
          >
            {results.map((r) => (
              <li key={`${r.town}-${r.address}`}>
                <button
                  onClick={() => goTo(r)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', border: 'none',
                    background: 'none', color: 'inherit', padding: '8px 14px', fontSize: '14px', cursor: 'pointer',
                  }}
                  onMouseOver={(e) => ((e.target as HTMLElement).style.background = 'var(--fdvt-panel-hover, #f6efe7)')}
                  onMouseOut={(e) => ((e.target as HTMLElement).style.background = 'none')}
                >
                  <strong>{titleCase(r.town)}</strong>
                  {r.hasPhoto ? ' 📸' : ''}
                  <span style={{ color: 'var(--fdvt-muted, #777)' }}> — {titleCase(r.address)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          action=""
          onSubmit={(e) => {
            e.preventDefault();
            if (results[0]) goTo(results[0]);
          }}
        >
        <input
          type="search"
          placeholder="🔍 Search a town or address…"
          value={query}
          onInput={(e) => runSearch((e.target as HTMLInputElement).value)}
          style={{
            width: '100%', padding: '10px 14px', fontSize: '15px', border: 'none',
            borderRadius: results.length ? '0 0 12px 12px' : '999px',
            boxShadow: '0 2px 8px rgba(0,0,0,.25)', outline: 'none', boxSizing: 'border-box',
          }}
        />
        </form>
      </div>
    </div>
  );
}
