'use strict';

// ---------- Config ----------
const SOCRATA = 'https://data.calgary.ca/resource/';
const DATASETS = {
  cameras: 'k7p9-kppz',   // Traffic Cameras (222 still-image cameras)
  live: '4jah-h97u',      // Current Traffic Incidents
  archive: '35ra-9556',   // Traffic Incidents archive (Dec 2016 → now)
  streets: '4dx8-rtm5',   // Street Centreline (road segments with class and geometry)
};
const ROAD_RADIUS_M = 120;        // road segments this close to a hotspot count as "its" roads
const ROAD_BATCH = 25;            // hotspots per spatial query
const SAMPLE_M = 20;              // elevation sample spacing along a road
const WINDOW_M = 100;             // grade is the steepest rise over this distance
const MIN_SEGMENT_M = 40;         // shorter segments are too noisy to grade
const MAX_PLAUSIBLE_GRADE = 15;   // % — steeper than any Calgary through-road; treat as a data artifact
const BRIDGE_DIP_M = 4;           // a segment that dips this far below both ends is likely a bridge
const EXCLUDED_CLASSES = ['Lanes (Alleys)', 'PedestrianBridge'];
const CENTER = [51.045, -114.07];
const BOUNDS = { latMin: 50.8, latMax: 51.25, lonMin: -114.4, lonMax: -113.8 };
const WINTER_MONTHS = [11, 12, 1, 2, 3];
const CELL_LAT = 0.002;           // ~220 m
const CELL_LON = 0.003;           // ~210 m at Calgary's latitude
const MIN_WINTER_INCIDENTS = 8;   // a cell needs this many winter incidents to count as a hotspot
const MAX_HOTSPOTS = 400;
const TERRAIN_ZOOM = 12;          // ~24 m pixels at Calgary's latitude
const LIVE_RADIUS_M = 300;
const CAMERA_RADIUS_M = 800;
const LIVE_REFRESH_MS = 2 * 60 * 1000;

// Score weights (sum of maxima is 1.1, clamped to 1).
const WEIGHTS = { history: 0.40, winter: 0.15, slope: 0.15, weather: 0.30, live: 0.10 };
const LEVELS = { red: 0.65, amber: 0.40 };

const SCENARIOS = {
  snow: { score: 0.85, headline: 'Heavy snow', reasons: ['Demo: 10 cm of snow falling, −8 °C'] },
  freezing: { score: 1.0, headline: 'Freezing rain', reasons: ['Demo: freezing rain, roads glazing over'] },
  clear: { score: 0.0, headline: 'Clear and dry', reasons: ['Demo: dry roads, no precipitation'] },
};

const state = {
  hotspots: [],
  cameras: [],
  live: [],
  weatherLive: null,
  scenario: 'live',
  stats: {},
  errors: [],
};

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inCalgary = (lat, lon) => lat > BOUNDS.latMin && lat < BOUNDS.latMax && lon > BOUNDS.lonMin && lon < BOUNDS.lonMax;
const cellKey = (lat, lon) => `${Math.floor(lat / CELL_LAT)}_${Math.floor(lon / CELL_LON)}`;
const fmtTime = (d) => d.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });

function distanceM(aLat, aLon, bLat, bLon) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad, dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function soql(id, params) {
  const res = await fetch(`${SOCRATA}${id}.json?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`Calgary dataset ${id} returned ${res.status}`);
  return res.json();
}

// ---------- Incident history → hotspots ----------
async function loadArchive() {
  const rows = [];
  const page = 50000;
  for (let offset = 0; ; offset += page) {
    const batch = await soql(DATASETS.archive, {
      $select: 'latitude,longitude,date_extract_m(start_dt_utc) as m',
      $where: 'latitude IS NOT NULL AND longitude IS NOT NULL',
      $order: ':id',
      $limit: page,
      $offset: offset,
    });
    for (const r of batch) rows.push(r);
    if (batch.length < page) break;
  }
  return rows;
}

function loadLabels() {
  // Most common location description per place, used to name hotspots.
  return soql(DATASETS.archive, {
    $select: 'incident_info, count(*) as n, avg(latitude) as lat, avg(longitude) as lon',
    $where: 'latitude IS NOT NULL',
    $group: 'incident_info',
    $order: 'n desc',
    $limit: 8000,
  });
}

function buildHotspots(rows, labels) {
  const cells = new Map();
  let winterTotal = 0, total = 0;
  for (const r of rows) {
    const lat = +r.latitude, lon = +r.longitude;
    if (!inCalgary(lat, lon)) continue;
    const key = cellKey(lat, lon);
    let c = cells.get(key);
    if (!c) { c = { key, n: 0, winter: 0, sLat: 0, sLon: 0 }; cells.set(key, c); }
    const isWinter = WINTER_MONTHS.includes(+r.m);
    c.n++; c.sLat += lat; c.sLon += lon;
    total++;
    if (isWinter) { c.winter++; winterTotal++; }
  }
  const baseShare = total ? winterTotal / total : 0.42;

  const labelByCell = new Map();
  for (const l of labels) {
    const lat = +l.lat, lon = +l.lon, n = +l.n;
    if (!l.incident_info || !inCalgary(lat, lon)) continue;
    const k = cellKey(lat, lon);
    const cur = labelByCell.get(k);
    if (!cur || cur.n < n) labelByCell.set(k, { name: l.incident_info, n });
  }
  const labelFor = (key) => {
    if (labelByCell.has(key)) return labelByCell.get(key).name;
    const [i, j] = key.split('_').map(Number);
    let best = null;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const l = labelByCell.get(`${i + di}_${j + dj}`);
      if (l && (!best || l.n > best.n)) best = l;
    }
    return best ? `Near ${best.name}` : 'Unnamed location';
  };

  const list = [...cells.values()]
    .filter((c) => c.winter >= MIN_WINTER_INCIDENTS)
    .sort((a, b) => b.winter - a.winter)
    .slice(0, MAX_HOTSPOTS);
  const maxWinter = list.length ? list[0].winter : 1;

  state.stats.incidents = total;
  state.stats.baseShare = baseShare;

  return list.map((c, idx) => {
    const share = c.winter / c.n;
    return {
      id: idx,
      lat: c.sLat / c.n,
      lon: c.sLon / c.n,
      label: labelFor(c.key),
      total: c.n,
      winter: c.winter,
      winterShare: share,
      history: Math.log1p(c.winter) / Math.log1p(maxWinter),
      winterBias: clamp((share - baseShare) / 0.25),
      slope: null,
      grade: null,
      gradeRoad: null,
      gradeBridge: false,
      liveNearby: null,
      camera: null,
    };
  });
}

// ---------- Terrain (Mapzen Terrarium tiles) ----------
const tileCache = new Map();   // key → Promise<pixel data>
const tileData = new Map();    // key → pixel data, once loaded

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z, latR = lat * Math.PI / 180;
  return {
    x: (lon + 180) / 360 * n,
    y: (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n,
  };
}

function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    tileCache.set(key, new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, 256, 256).data;
        tileData.set(key, data);
        resolve(data);
      };
      img.onerror = () => reject(new Error(`terrain tile ${key}`));
      img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`;
    }));
  }
  return tileCache.get(key);
}

function elevation(data, px, py) {
  const i = (py * 256 + px) * 4;
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
}

async function slopePercent(lat, lon) {
  const t = lonLatToTile(lon, lat, TERRAIN_ZOOM);
  const tx = Math.floor(t.x), ty = Math.floor(t.y);
  const data = await loadTile(TERRAIN_ZOOM, tx, ty);
  const px = Math.floor((t.x - tx) * 256), py = Math.floor((t.y - ty) * 256);
  const mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * 2 ** TERRAIN_ZOOM);
  const x0 = Math.max(0, px - 1), x1 = Math.min(255, px + 1);
  const y0 = Math.max(0, py - 1), y1 = Math.min(255, py + 1);
  const dzdx = (elevation(data, x1, py) - elevation(data, x0, py)) / ((x1 - x0) * mpp);
  const dzdy = (elevation(data, px, y1) - elevation(data, px, y0)) / ((y1 - y0) * mpp);
  return Math.hypot(dzdx, dzdy) * 100;
}

async function addSlopes(hotspots) {
  let failed = 0;
  await Promise.all(hotspots.map(async (h) => {
    try { h.slope = await slopePercent(h.lat, h.lon); }
    catch { h.slope = null; failed++; }
  }));
  if (failed) state.errors.push(`Terrain unavailable for ${failed} hotspots`);
}

// Bilinear elevation at a point. Tiles must already be loaded (see ensureTiles); returns null otherwise.
function elevationAt(lat, lon) {
  const t = lonLatToTile(lon, lat, TERRAIN_ZOOM);
  const gx = t.x * 256 - 0.5, gy = t.y * 256 - 0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const px = (x, y) => {
    const tx = Math.floor(x / 256), ty = Math.floor(y / 256);
    const data = tileData.get(`${TERRAIN_ZOOM}/${tx}/${ty}`);
    return data ? elevation(data, x - tx * 256, y - ty * 256) : null;
  };
  const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
  if ([a, b, c, d].includes(null)) return null;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

async function ensureTiles(points) {
  const keys = new Set();
  for (const [lat, lon] of points) {
    const t = lonLatToTile(lon, lat, TERRAIN_ZOOM);
    // Include neighbours so bilinear sampling at tile edges has data.
    const gx = t.x * 256 - 0.5, gy = t.y * 256 - 0.5;
    for (const x of [Math.floor(gx), Math.floor(gx) + 1]) for (const y of [Math.floor(gy), Math.floor(gy) + 1]) {
      keys.add(`${Math.floor(x / 256)}/${Math.floor(y / 256)}`);
    }
  }
  await Promise.all([...keys].map((k) => {
    const [x, y] = k.split('/').map(Number);
    return loadTile(TERRAIN_ZOOM, x, y).catch(() => null);
  }));
}

// ---------- Road grade (Street Centreline + terrain) ----------
async function loadRoadsNear(hotspots) {
  const segments = new Map();
  const batches = [];
  for (let i = 0; i < hotspots.length; i += ROAD_BATCH) batches.push(hotspots.slice(i, i + ROAD_BATCH));
  const excluded = EXCLUDED_CLASSES.map((c) => `'${c}'`).join(',');
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      // within_circle only returns lines fully inside the circle, which misses long highway
      // segments, so use a box around each hotspot with intersects() instead.
      const circles = batch.map((h) => {
        const dLat = ROAD_RADIUS_M / 110540, dLon = ROAD_RADIUS_M / (111320 * Math.cos(h.lat * Math.PI / 180));
        const [w, e, s, n] = [h.lon - dLon, h.lon + dLon, h.lat - dLat, h.lat + dLat].map((v) => v.toFixed(6));
        return `intersects(line, 'POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))')`;
      }).join(' OR ');
      const rows = await soql(DATASETS.streets, {
        $select: 'segment_id, full_name, ctp_class, line',
        $where: `(ctp_class IS NULL OR ctp_class NOT IN (${excluded})) AND (${circles})`,
        $limit: 10000,
      });
      for (const r of rows) if (r.line && r.segment_id) segments.set(r.segment_id, r);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return [...segments.values()].map((r) => ({
    id: r.segment_id,
    name: r.full_name || 'Unnamed road',
    roadClass: r.ctp_class || '',
    lines: r.line.type === 'MultiLineString' ? r.line.coordinates : [r.line.coordinates],
  }));
}

// Points every SAMPLE_M along a line of [lon, lat] coordinates, with distance along the line.
function densify(coords) {
  if (coords.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + distanceM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  const length = cum[cum.length - 1];
  const stops = [];
  for (let s = 0; s < length; s += SAMPLE_M) stops.push(s);
  stops.push(length);
  const out = [];
  let k = 0;
  for (const s of stops) {
    while (k < cum.length - 2 && cum[k + 1] < s) k++;
    const span = cum[k + 1] - cum[k] || 1;
    const f = clamp((s - cum[k]) / span);
    out.push({
      lon: coords[k][0] + (coords[k + 1][0] - coords[k][0]) * f,
      lat: coords[k][1] + (coords[k + 1][1] - coords[k][1]) * f,
      s,
    });
  }
  return out;
}

// Each window: grade between a sample and the first sample at least `window` metres further on.
function windows(pts, window) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const run = pts[j].s - pts[i].s;
      if (run + 1e-6 < window) continue;
      out.push({ a: pts[i], b: pts[j], grade: Math.abs(pts[j].z - pts[i].z) / run * 100 });
      break;
    }
  }
  return out;
}

// Elevation profile of one line, sampled once and reused for every nearby hotspot.
function profileOfLine(coords) {
  const pts = densify(coords);
  if (pts.length < 2) return null;
  const length = pts[pts.length - 1].s;
  if (length < MIN_SEGMENT_M) return null;
  for (const p of pts) p.z = elevationAt(p.lat, p.lon);
  if (pts.some((p) => p.z == null)) return null;

  const window = Math.min(WINDOW_M, length);
  const wins = windows(pts, window);
  const z0 = pts[0].z, zEnd = pts[pts.length - 1].z;
  const zMin = Math.min(...pts.map((p) => p.z));
  // A bridge or overpass: the ground under the middle drops well below both ends, with sides
  // steeper than a real road. The deck runs roughly straight between the ends, so use that grade.
  // (A real road through a valley also dips, but its sides stay at road-like grades.)
  const dips = z0 - zMin > BRIDGE_DIP_M && zEnd - zMin > BRIDGE_DIP_M;
  const steepest = Math.max(0, ...wins.map((w) => w.grade));
  const bridge = dips && steepest > MAX_PLAUSIBLE_GRADE * 0.8;
  return { pts, wins, bridge, endToEnd: Math.abs(zEnd - z0) / length * 100 };
}

const GRADE_REACH_M = 200;  // only the stretch of road this close to the hotspot counts

// Steepest plausible grade on this line near a hotspot.
function gradeNear(profile, h) {
  const near = (p) => distanceM(h.lat, h.lon, p.lat, p.lon) <= GRADE_REACH_M;
  if (profile.bridge) {
    return profile.pts.some(near) ? { grade: profile.endToEnd, bridge: true } : null;
  }
  let best = null;
  for (const w of profile.wins) {
    if (w.grade > MAX_PLAUSIBLE_GRADE || !near(w.a) || !near(w.b)) continue;
    if (!best || w.grade > best.grade) best = { grade: w.grade, bridge: false };
  }
  return best;
}

// Distance in metres from a point to a polyline of [lon, lat] coordinates (local flat approximation).
function distanceToLineM(lat, lon, coords) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][0] - lon) * kx, ay = (coords[i][1] - lat) * ky;
    const bx = (coords[i + 1][0] - lon) * kx, by = (coords[i + 1][1] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const t = clamp(-(ax * dx + ay * dy) / (dx * dx + dy * dy || 1));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

const MINOR_CLASSES = ['Residential Street', 'Lanes (Alleys)', 'Industrial Street', ''];
const ROAD_WORDS = { AVENUE: 'AV', STREET: 'ST', TRAIL: 'TR', ROAD: 'RD', DRIVE: 'DR', BOULEVARD: 'BV', CRESCENT: 'CR', WAY: 'WY', GATE: 'GA', LINK: 'LI', LI: 'LI', PLACE: 'PL', MACLEOD: 'MACLEOD' };

function normalizeRoadText(s) {
  return ` ${String(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).map((w) => ROAD_WORDS[w] || w).join(' ')} `;
}

// Is this street centreline name (e.g. "17 AV SW") one of the roads in the incident location text?
function roadNamed(label, segName) {
  const base = normalizeRoadText(segName).replace(/ (NW|NE|SW|SE|N|S|E|W) $/, ' ').trim();
  if (!base) return false;
  return normalizeRoadText(label).includes(` ${base} `);
}

async function addRoadGrades(hotspots) {
  const segments = await loadRoadsNear(hotspots);
  state.stats.segments = segments.length;
  const allPoints = [];
  for (const seg of segments) for (const line of seg.lines) for (const [lon, lat] of line) allPoints.push([lat, lon]);
  await ensureTiles(allPoints);
  for (const seg of segments) seg.profiles = seg.lines.map((line) => ({ line, profile: profileOfLine(line) }));

  let graded = 0;
  for (const h of hotspots) {
    // Candidates in three tiers: roads named in the incident location, then major roads, then any road.
    const tiers = [null, null, null];
    for (const seg of segments) {
      const tier = roadNamed(h.label, seg.name) ? 0 : MINOR_CLASSES.includes(seg.roadClass) ? 2 : 1;
      for (const { line, profile } of seg.profiles) {
        if (!profile || distanceToLineM(h.lat, h.lon, line) > ROAD_RADIUS_M) continue;
        const g = gradeNear(profile, h);
        if (g && (!tiers[tier] || g.grade > tiers[tier].g.grade)) tiers[tier] = { seg, g };
      }
    }
    const best = tiers.find(Boolean);
    if (best) {
      h.grade = best.g.grade;
      h.gradeBridge = best.g.bridge;
      h.gradeRoad = `${best.seg.name}${best.seg.roadClass ? ` (${best.seg.roadClass})` : ''}`;
      graded++;
    }
  }
  if (graded < hotspots.length) state.errors.push(`No road grade for ${hotspots.length - graded} hotspots; scored as flat`);
}

// ---------- Weather (Open-Meteo) ----------
async function loadWeather() {
  const params = new URLSearchParams({
    latitude: CENTER[0], longitude: CENTER[1],
    hourly: 'temperature_2m,snowfall,precipitation,weather_code',
    past_hours: 12, forecast_hours: 12, timezone: 'GMT',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Weather returned ${res.status}`);
  return summarizeWeather((await res.json()).hourly);
}

function summarizeWeather(h) {
  const now = Date.now();
  let snowPast = 0, snowNext = 0, minT = Infinity, maxT = -Infinity, tempNow = null, freezingRain = false, bestGap = Infinity;
  h.time.forEach((t, i) => {
    // Requested in GMT; the API omits the offset, so add it before parsing.
    const ts = new Date(`${t}Z`).getTime();
    const snow = h.snowfall[i] || 0;
    if (ts <= now) snowPast += snow; else snowNext += snow;
    const temp = h.temperature_2m[i];
    if (temp != null) { minT = Math.min(minT, temp); maxT = Math.max(maxT, temp); }
    if (Math.abs(ts - now) < bestGap) { bestGap = Math.abs(ts - now); tempNow = temp; }
    if ([56, 57, 66, 67].includes(h.weather_code[i])) freezingRain = true;
  });
  return { snowPast, snowNext, minT, maxT, tempNow, freezingRain, freezeThaw: minT < 0 && maxT > 0 };
}

function liveWeatherScore(w) {
  const reasons = [];
  let s = 0;
  const month = new Date().getMonth() + 1;
  if (WINTER_MONTHS.includes(month)) { s += 0.1; reasons.push('Winter season'); }
  const snow = w.snowPast + w.snowNext;
  if (snow >= 0.5) {
    s += Math.min(snow / 5, 1) * 0.6;
    reasons.push(`${snow.toFixed(1)} cm of snow (past 12 h + next 12 h)`);
  }
  if (w.freezeThaw) { s += 0.25; reasons.push(`Temperature crossing 0 °C (${w.minT.toFixed(0)} to ${w.maxT.toFixed(0)} °C): black ice likely`); }
  if (w.freezingRain) { s = Math.max(s, 0.9); reasons.push('Freezing rain or drizzle forecast'); }
  if (w.tempNow != null && w.tempNow <= -15) { s += 0.1; reasons.push('Extreme cold: packed snow and ice stay on roads'); }
  if (reasons.length === 0) reasons.push('No snow, ice or freezing rain expected');
  const headline = w.tempNow != null ? `${w.tempNow.toFixed(0)} °C` : '—';
  return { score: clamp(s), headline, reasons };
}

function currentWeather() {
  if (state.scenario !== 'live') return SCENARIOS[state.scenario];
  if (!state.weatherLive) return { score: 0.1, headline: 'Unavailable', reasons: ['Weather feed unavailable; assuming normal winter conditions'] };
  return liveWeatherScore(state.weatherLive);
}

// ---------- Live incidents and cameras ----------
async function loadLive() {
  const rows = await soql(DATASETS.live, { $limit: 1000 });
  return rows
    .map((r) => ({ lat: +r.latitude, lon: +r.longitude, info: r.incident_info, description: r.description, start: r.start_dt_utc }))
    .filter((r) => inCalgary(r.lat, r.lon));
}

async function loadCameras() {
  const rows = await soql(DATASETS.cameras, { $limit: 1000 });
  return rows
    .filter((r) => r.point && r.camera_url && r.camera_url.url)
    .map((r) => ({ lat: r.point.coordinates[1], lon: r.point.coordinates[0], name: r.camera_location, url: r.camera_url.url }));
}

function linkNearby() {
  for (const h of state.hotspots) {
    h.liveNearby = state.live.find((l) => distanceM(h.lat, h.lon, l.lat, l.lon) <= LIVE_RADIUS_M) || null;
    let best = null, bestD = Infinity;
    for (const c of state.cameras) {
      const d = distanceM(h.lat, h.lon, c.lat, c.lon);
      if (d < bestD) { bestD = d; best = c; }
    }
    h.camera = bestD <= CAMERA_RADIUS_M ? { ...best, distance: bestD } : null;
  }
}

// ---------- Scoring ----------
function score(h, wx) {
  // Road grade along the centreline; 8% or steeper is treated as a steep hill.
  const slopeF = clamp((h.grade ?? 0) / 8);
  const parts = {
    history: WEIGHTS.history * h.history,
    winter: WEIGHTS.winter * h.winterBias,
    slope: WEIGHTS.slope * slopeF,
    weather: WEIGHTS.weather * wx.score * (0.6 + 0.4 * slopeF),
    live: h.liveNearby ? WEIGHTS.live : 0,
  };
  const total = clamp(Object.values(parts).reduce((a, b) => a + b, 0));
  const level = total >= LEVELS.red ? 'red' : total >= LEVELS.amber ? 'amber' : 'green';
  return { parts, total, level };
}

const ACTIONS = {
  red: 'Red zone: plow and sand first. Consider a public advisory and check the camera.',
  amber: 'Pre-treat with brine or sand and watch the camera.',
  green: 'Routine maintenance.',
};
const LEVEL_NAMES = { red: 'Red zone', amber: 'Elevated', green: 'Normal' };
const COLORS = { red: '#d7263d', amber: '#e88a1a', green: '#2e9e4f' };

function reasonsFor(h, s) {
  const out = [];
  if (h.liveNearby) out.push('live incident');
  out.push(`${h.winter} winter incidents`);
  if ((h.grade ?? 0) >= 4) out.push(`${h.grade.toFixed(1)}% grade`);
  if (h.winterBias >= 0.3) out.push('worse in winter');
  return out.join(' · ');
}

// ---------- Map ----------
const map = L.map('map', { zoomControl: true }).setView(CENTER, 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const layers = {
  hot: L.layerGroup().addTo(map),
  live: L.layerGroup().addTo(map),
  cam: L.layerGroup(),
};
const hotMarkers = new Map();

const legend = L.control({ position: 'bottomleft' });
legend.onAdd = () => {
  const div = L.DomUtil.create('div', 'legend');
  div.innerHTML = `
    <div><i style="background:${COLORS.red}"></i>Red zone (≥ ${Math.round(LEVELS.red * 100)})</div>
    <div><i style="background:${COLORS.amber}"></i>Elevated (≥ ${Math.round(LEVELS.amber * 100)})</div>
    <div><i style="background:${COLORS.green}"></i>Normal</div>
    <div><i style="background:#7b2cbf"></i>Live incident</div>
    <div><i style="background:#0b5cad"></i>Traffic camera</div>`;
  return div;
};
legend.addTo(map);

function cameraImg(cam) {
  return `<img src="${esc(cam.url)}?t=${Date.now()}" alt="Live traffic camera at ${esc(cam.name)}" loading="lazy">
    <div class="caption">${esc(cam.name)} · refreshes every minute</div>`;
}

function hotspotPopup(h) {
  const wx = currentWeather();
  const s = score(h, wx);
  const bar = (label, value, max) => `<tr><td>${label}</td><td>${Math.round(value * 100)} / ${Math.round(max * 100)}</td></tr>`;
  return `<div class="pop">
    <h3>${esc(h.label)}</h3>
    <div class="lvl ${s.level}">${LEVEL_NAMES[s.level]} · score ${Math.round(s.total * 100)}</div>
    <table>
      ${bar('Incident history', s.parts.history, WEIGHTS.history)}
      ${bar('Worse in winter', s.parts.winter, WEIGHTS.winter)}
      ${bar('Road grade', s.parts.slope, WEIGHTS.slope)}
      ${bar('Weather', s.parts.weather, WEIGHTS.weather)}
      ${bar('Live incident nearby', s.parts.live, WEIGHTS.live)}
      <tr><td colspan="2"><hr style="border:0;border-top:1px solid #e2e7ec;margin:4px 0"></td></tr>
      <tr><td>Winter incidents since Dec 2016</td><td>${h.winter}</td></tr>
      <tr><td>Share in winter months</td><td>${Math.round(h.winterShare * 100)}% (city ${Math.round(state.stats.baseShare * 100)}%)</td></tr>
      <tr><td>Steepest nearby road</td><td>${h.grade == null ? 'n/a' : `${h.grade.toFixed(1)}%${h.gradeBridge ? ' (bridge, end to end)' : ''}`}</td></tr>
      ${h.gradeRoad ? `<tr><td colspan="2" class="caption">${esc(h.gradeRoad)}</td></tr>` : ''}
      <tr><td>Ground slope at the spot</td><td>${h.slope == null ? 'n/a' : h.slope.toFixed(1) + '%'}</td></tr>
      ${h.liveNearby ? `<tr><td>Live now</td><td>${esc(h.liveNearby.description || 'Incident')}</td></tr>` : ''}
    </table>
    <div class="action">${ACTIONS[s.level]}</div>
    ${h.camera ? cameraImg(h.camera) : '<div class="caption" style="margin-top:6px">No City camera within 800 m.</div>'}
  </div>`;
}

function drawHotspots() {
  layers.hot.clearLayers();
  hotMarkers.clear();
  const wx = currentWeather();
  // Draw lowest first so red sits on top.
  const sorted = [...state.hotspots].sort((a, b) => score(a, wx).total - score(b, wx).total);
  for (const h of sorted) {
    const s = score(h, wx);
    const m = L.circleMarker([h.lat, h.lon], {
      radius: 4 + 8 * h.history,
      color: '#fff', weight: 1,
      fillColor: COLORS[s.level], fillOpacity: s.level === 'green' ? 0.55 : 0.85,
    }).bindPopup(() => hotspotPopup(h), { maxWidth: 300 });
    m.addTo(layers.hot);
    hotMarkers.set(h.id, m);
  }
}

function drawLive() {
  layers.live.clearLayers();
  for (const l of state.live) {
    const started = l.start ? new Date(l.start.replace(' ', 'T').replace('+00:00', 'Z')) : null;
    L.circleMarker([l.lat, l.lon], { radius: 9, color: '#7b2cbf', weight: 3, fillColor: '#7b2cbf', fillOpacity: 0.35 })
      .bindPopup(`<div class="pop"><h3>${esc(l.info)}</h3>
        <div>${esc(l.description)}</div>
        ${started && !isNaN(started) ? `<div class="caption">Started ${fmtTime(started)}</div>` : ''}</div>`)
      .addTo(layers.live);
  }
}

function drawCameras() {
  layers.cam.clearLayers();
  for (const c of state.cameras) {
    L.circleMarker([c.lat, c.lon], { radius: 5, color: '#fff', weight: 1, fillColor: '#0b5cad', fillOpacity: 0.9 })
      .bindPopup(() => `<div class="pop"><h3>${esc(c.name)}</h3>${cameraImg(c)}</div>`, { maxWidth: 300 })
      .addTo(layers.cam);
  }
}

// ---------- Panel ----------
function renderWeather() {
  const wx = currentWeather();
  const level = wx.score >= 0.6 ? 'red' : wx.score >= 0.3 ? 'amber' : 'green';
  $('weather').innerHTML = `
    <div class="big">${esc(wx.headline)}</div>
    <div class="meter"><span style="width:${Math.round(wx.score * 100)}%;background:${COLORS[level]}"></span></div>
    <div class="hint" style="margin:0">Weather risk ${Math.round(wx.score * 100)} / 100</div>
    <ul>${wx.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
}

function renderPriority() {
  const wx = currentWeather();
  const ranked = state.hotspots
    .map((h) => ({ h, s: score(h, wx) }))
    .sort((a, b) => b.s.total - a.s.total)
    .slice(0, 12);
  $('priority').innerHTML = ranked.map(({ h, s }) => `
    <li data-id="${h.id}">
      <span class="badge ${s.level}">${Math.round(s.total * 100)}</span>
      <span><div class="name">${esc(h.label)}</div><div class="why">${esc(reasonsFor(h, s))}</div></span>
    </li>`).join('');
}

function renderStatus() {
  const el = $('status');
  const wx = currentWeather();
  const counts = { red: 0, amber: 0, green: 0 };
  for (const h of state.hotspots) counts[score(h, wx).level]++;
  el.classList.toggle('error', state.errors.length > 0 && !state.hotspots.length);
  el.innerHTML = `
    <strong>${counts.red}</strong> red zones · <strong>${counts.amber}</strong> elevated · ${counts.green} normal<br>
    ${state.stats.incidents?.toLocaleString() ?? '—'} past incidents · ${state.hotspots.length} hotspots ·
    ${state.cameras.length} cameras · ${state.live.length} live incidents<br>
    Updated ${fmtTime(new Date())}
    ${state.errors.length ? `<br><span style="color:var(--red)">${state.errors.map(esc).join('<br>')}</span>` : ''}`;
}

function renderAll() {
  drawHotspots();
  renderWeather();
  renderPriority();
  renderStatus();
}

$('priority').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const h = state.hotspots[+li.dataset.id];
  if (!map.hasLayer(layers.hot)) { map.addLayer(layers.hot); $('lyr-hot').checked = true; }
  map.flyTo([h.lat, h.lon], 16, { duration: 0.8 });
  map.once('moveend', () => hotMarkers.get(h.id)?.openPopup());
});

$('scenario').addEventListener('change', (e) => { state.scenario = e.target.value; renderAll(); });
for (const [id, key] of [['lyr-hot', 'hot'], ['lyr-live', 'live'], ['lyr-cam', 'cam']]) {
  $(id).addEventListener('change', (e) => (e.target.checked ? map.addLayer(layers[key]) : map.removeLayer(layers[key])));
}

// ---------- Boot ----------
async function settle(promise, label) {
  try { return await promise; }
  catch (err) { console.error(err); state.errors.push(`${label}: ${err.message}`); return null; }
}

async function refreshLive() {
  state.errors = state.errors.filter((e) => !e.startsWith('Live incidents'));
  const live = await settle(loadLive(), 'Live incidents');
  if (live) state.live = live;
  linkNearby();
  drawLive();
  renderAll();
}

async function boot() {
  $('status').textContent = 'Loading incident history, cameras, live incidents and weather…';
  const [rows, labels, cameras, live, weather] = await Promise.all([
    settle(loadArchive(), 'Incident history'),
    settle(loadLabels(), 'Location names'),
    settle(loadCameras(), 'Cameras'),
    settle(loadLive(), 'Live incidents'),
    settle(loadWeather(), 'Weather'),
  ]);
  state.cameras = cameras || [];
  state.live = live || [];
  state.weatherLive = weather;
  if (rows) {
    state.hotspots = buildHotspots(rows, labels || []);
    $('status').textContent = `Measuring road grade around ${state.hotspots.length} hotspots…`;
    await Promise.all([
      addSlopes(state.hotspots),
      settle(addRoadGrades(state.hotspots), 'Road grade'),
    ]);
  }
  linkNearby();
  drawLive();
  drawCameras();
  renderAll();
  setInterval(refreshLive, LIVE_REFRESH_MS);
}

boot();
