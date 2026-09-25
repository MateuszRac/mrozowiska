/* Mrozowiska w Polsce - interaktywna mapa.
 *
 * Kafle warstw zawierają WARTOŚCI (nie kolory): v = offset + scale * (R*256 + G), A = 0 to brak
 * danych. Kolory nakładane są tutaj, więc skalę barwną można zmieniać bez ponownego pobierania:
 * stała (domyślna z manifestu), dynamiczna (percentyle 2-98 widocznego fragmentu) albo ręczna.
 * Dane buduje `zastoiska web-build`, serwuje `zastoiska web-serve`.
 */
"use strict";

// ---- palety ------------------------------------------------------------------------------------

const HYPSO_BREAKS = [-150, 0, 50, 100, 150, 200, 300, 400, 500, 700, 1000, 1500, 2000, 2600];
const HYPSO_COLORS = ["#1d6b48", "#2f8a4c", "#58a557", "#86bf66", "#b5d57c", "#e2e39a", "#f1d88b",
  "#e7bf76", "#d7a063", "#bf7f4f", "#9c603d", "#7e4b32", "#cfc9c2"];

const PALETTES = {
  RdBu_r: { name: "czerwono-niebieska (RdBu)", colors: ["#053061", "#2166ac", "#4393c3", "#92c5de",
    "#d1e5f0", "#f7f7f7", "#fddbc7", "#f4a582", "#d6604d", "#b2182b", "#67001f"] },
  RdYlBu_r: { name: "czerwono-żółto-niebieska", colors: ["#313695", "#4575b4", "#74add1", "#abd9e9",
    "#e0f3f8", "#ffffbf", "#fee090", "#fdae61", "#f46d43", "#d73027", "#a50026"] },
  Blues: { name: "niebieska", colors: ["#deebf7", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6",
    "#2171b5", "#08519c", "#08306b"] },
  YlGnBu: { name: "żółto-zielono-niebieska", colors: ["#ffffd9", "#edf8b1", "#c7e9b4", "#7fcdbb",
    "#41b6c4", "#1d91c0", "#225ea8", "#253494", "#081d58"] },
  viridis: { name: "viridis", colors: ["#440154", "#46327e", "#365c8d", "#277f8e", "#1fa187",
    "#4ac16d", "#a0da39", "#fde725"] },
  magma: { name: "magma", colors: ["#000004", "#1c1044", "#4f127b", "#812581", "#b5367a", "#e55064",
    "#fb8761", "#fec287", "#fcfdbf"] },
  hipsometria: { name: "hipsometria (atlasowa)", colors: HYPSO_COLORS, breaks: HYPSO_BREAKS },
  klasy: { name: "klasy mrozowisk", colors: [] },
};

const BACKGROUND_RGB = [236, 236, 236]; // tło: brak klasy / zero dla warstw "zero jako tło"

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function makeLUT(colors, reverse) {
  const stops = (reverse ? [...colors].reverse() : colors).map(hexToRgb);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(Math.floor(t), stops.length - 2);
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f;
  }
  return lut;
}

// ---- stan --------------------------------------------------------------------------------------

const state = {
  manifest: null,
  layers: new Map(), // id -> definicja z manifestu
  active: null, // id aktywnej warstwy
  styles: new Map(), // id -> {palette, reverse, mode, min, max, symmetric, dynMin, dynMax, dynN}
  hillshade: { on: true, strength: 0.7 },
  opacity: 1,
  gridLayer: null,
};

const fmt = (v, digits = 2) =>
  Number.isFinite(v) ? v.toLocaleString("pl-PL", { maximumFractionDigits: digits }) : "–";

// ---- pobieranie i dekodowanie kafli ------------------------------------------------------------

const tileCache = new Map(); // klucz -> Promise<Float32Array|null>
const resolved = new Map(); // klucz -> Float32Array|null (dostęp synchroniczny)
const CACHE_LIMIT = 1500;

// Adresy danych z wersją = data budowania (web-build): po przebudowie przeglądarka nie użyje
// starych kafli z pamięci podręcznej, a między przebudowami korzysta z niej normalnie.
function versioned(url) {
  const v = state.manifest ? encodeURIComponent(state.manifest.created) : "";
  return v ? `${url}${url.includes("?") ? "&" : "?"}v=${v}` : url;
}

async function fetchWithRetry(url, attempts = 3) {
  for (let k = 1; ; k++) {
    try {
      return await fetch(url);
    } catch (err) { // błąd sieci (np. przeciążony serwer) - ponów, nie zapamiętuj jako brak danych
      if (k >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 300 * k));
    }
  }
}

async function fetchRGBA(url) {
  const resp = await fetchWithRetry(versioned(url));
  if (!resp.ok) return null; // brak kafla = brak danych (poza Polską)
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
}

function cached(key, loader) {
  if (!tileCache.has(key)) {
    if (tileCache.size > CACHE_LIMIT) {
      const oldest = tileCache.keys().next().value;
      tileCache.delete(oldest);
      resolved.delete(oldest);
    }
    const p = loader().then((v) => { resolved.set(key, v); return v; }).catch(() => {
      tileCache.delete(key); // błąd sieci: kolejne żądanie spróbuje ponownie
      return null;
    });
    tileCache.set(key, p);
  }
  return tileCache.get(key);
}

function valueKey(def, z, x, y) { return `${def.tiles}/${z}/${x}/${y}`; }

// Indeksy istniejących kafli (index.json z web-build): nie pytamy serwera o puste kafle.
const tileIndex = new Map(); // katalog -> Set("z/x/y")
async function loadTileIndex(dir) {
  try {
    const resp = await fetch(versioned(`${dir}/index.json`));
    tileIndex.set(dir, resp.ok ? new Set(await resp.json()) : null);
  } catch { tileIndex.set(dir, null); }
}
function hasTile(dir, z, x, y) {
  const idx = tileIndex.get(dir);
  return !idx || idx.has(`${z}/${x}/${y}`);
}

function getValues(def, z, x, y) {
  if (!hasTile(`${state.manifest.tilesRoot}/${def.tiles}`, z, x, y)) return Promise.resolve(null);
  return cached(valueKey(def, z, x, y), async () => {
    const rgba = await fetchRGBA(`${state.manifest.tilesRoot}/${def.tiles}/${z}/${x}/${y}.png`);
    if (!rgba) return null;
    const out = new Float32Array(rgba.length / 4);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = rgba[j + 3] ? def.offset + def.scale * (rgba[j] * 256 + rgba[j + 1]) : NaN;
    }
    return out;
  });
}

function getShade(z, x, y) {
  const hs = state.manifest.hillshade;
  if (z > hs.maxZoom || !hasTile(hs.tiles, z, x, y)) return Promise.resolve(null);
  return cached(`hillshade/${z}/${x}/${y}`, async () => {
    const rgba = await fetchRGBA(`${hs.tiles}/${z}/${x}/${y}.png`);
    if (!rgba) return null;
    const out = new Float32Array(rgba.length / 4);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = rgba[j] ? rgba[j] * hs.scale : 1;
    return out;
  });
}

// ---- skala barwna ------------------------------------------------------------------------------

function styleOf(id) { return state.styles.get(id); }

function effectiveRange(def, st) {
  let lo = def.range[0], hi = def.range[1];
  if (st.mode === "manual" && Number.isFinite(st.min) && Number.isFinite(st.max)) [lo, hi] = [st.min, st.max];
  if (st.mode === "dynamic" && Number.isFinite(st.dynMin)) [lo, hi] = [st.dynMin, st.dynMax];
  if (st.symmetric && st.mode !== "fixed") {
    const m = Math.max(Math.abs(lo), Math.abs(hi));
    [lo, hi] = [-m, m];
  }
  if (def.scale_type === "log") lo = Math.max(lo, 1e-3);
  if (!(hi > lo)) hi = lo + 1e-6;
  return [lo, hi];
}

/** Funkcja wartość -> [r, g, b] (albo null = przezroczysty) dla bieżącego stylu warstwy. */
function colorizer(def) {
  const st = styleOf(def.id);
  if (def.scale_type === "classes") {
    const cls = def.classes.map((c) => ({ ...c, rgb: hexToRgb(c.color) }));
    return (v) => {
      for (const c of cls) if (v <= c.max && (c.min === null || v > c.min)) return c.rgb;
      return BACKGROUND_RGB;
    };
  }
  const [lo, hi] = effectiveRange(def, st);
  const pal = PALETTES[st.palette];
  if (pal.breaks && st.mode === "fixed") {
    const rgbs = (st.reverse ? [...pal.colors].reverse() : pal.colors).map(hexToRgb);
    const b = pal.breaks;
    return (v) => {
      let k = 0;
      while (k < b.length - 2 && v >= b[k + 1]) k++;
      return rgbs[k];
    };
  }
  const lut = makeLUT(pal.colors, st.reverse);
  const isLog = def.scale_type === "log";
  const a = isLog ? Math.log(lo) : lo;
  const span = (isLog ? Math.log(hi) : hi) - a;
  const out = [0, 0, 0];
  return (v) => {
    if (def.zero_as_background && v < (isLog ? lo : 1e-9)) return BACKGROUND_RGB;
    let t = ((isLog ? Math.log(Math.max(v, 1e-9)) : v) - a) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const i = Math.round(t * 255) * 3;
    out[0] = lut[i]; out[1] = lut[i + 1]; out[2] = lut[i + 2];
    return out;
  };
}

function renderTile(def, entry, colorOf) {
  const ctx = entry.canvas.getContext("2d");
  const img = ctx.createImageData(256, 256);
  const d = img.data;
  const values = entry.values;
  const shade = state.hillshade.on ? entry.shade : null;
  const s = state.hillshade.strength;
  for (let i = 0, j = 0; i < 65536; i++, j += 4) {
    const v = values[i];
    if (v !== v) { d[j + 3] = 0; continue; } // NaN
    const rgb = colorOf(v);
    const f = shade ? 1 - s + s * shade[i] : 1;
    d[j] = rgb[0] * f; d[j + 1] = rgb[1] * f; d[j + 2] = rgb[2] * f; d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// ---- warstwa kafli -----------------------------------------------------------------------------

const DataLayer = L.GridLayer.extend({
  initialize(def, options) {
    L.GridLayer.prototype.initialize.call(this, options);
    this.def = def;
    this.entries = new Map();
    this.on("tileunload", (e) => this.entries.delete(this._tileCoordsToKey(e.coords)));
  },
  createTile(coords, done) {
    const canvas = L.DomUtil.create("canvas", "data-tile");
    canvas.width = canvas.height = 256;
    const entry = { canvas, coords, values: null, shade: null };
    this.entries.set(this._tileCoordsToKey(coords), entry);
    Promise.all([getValues(this.def, coords.z, coords.x, coords.y), getShade(coords.z, coords.x, coords.y)])
      .then(([values, shade]) => {
        entry.values = values;
        entry.shade = shade;
        if (values) renderTile(this.def, entry, colorizer(this.def));
        done(null, canvas);
        scheduleDynamicRange();
      })
      .catch((err) => done(err, canvas));
    return canvas;
  },
  redrawAll() {
    const colorOf = colorizer(this.def);
    for (const e of this.entries.values()) if (e.values) renderTile(this.def, e, colorOf);
  },
});

// ---- mapa --------------------------------------------------------------------------------------

const map = L.map("map", { zoomControl: true, preferCanvas: true, minZoom: 5, maxZoom: 15 });
map.createPane("data").style.zIndex = 300;
map.createPane("bounds").style.zIndex = 420;
map.getPane("bounds").style.pointerEvents = "none";

const BASEMAPS = {
  osm: () => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© współtwórcy OpenStreetMap" }),
};
let basemap = null;
function setBasemap(key) {
  if (basemap) map.removeLayer(basemap);
  basemap = BASEMAPS[key] ? BASEMAPS[key]().addTo(map) : null;
}

function setActiveLayer(id) {
  state.active = id;
  const def = state.layers.get(id);
  if (state.gridLayer) map.removeLayer(state.gridLayer);
  state.gridLayer = new DataLayer(def, {
    pane: "data",
    maxNativeZoom: def.max_zoom,
    minNativeZoom: state.manifest.minNativeZoom,
    bounds: L.latLngBounds(state.manifest.bounds),
    opacity: state.opacity,
    keepBuffer: 2,
    attribution: "NMT: GUGiK · LST: NASA LP DAAC (VIIRS) · granice: PRG",
  }).addTo(map);
  document.getElementById("layer-desc").textContent = def.description;
  syncScaleControls();
  updateLegend();
  updateValueBox(null);
}

function restyle() {
  if (state.gridLayer) state.gridLayer.redrawAll();
  updateLegend();
}

// ---- dynamiczny zakres (percentyle 2-98 widoku) ------------------------------------------------

let dynTimer = null;
function scheduleDynamicRange() {
  const st = state.active && styleOf(state.active);
  if (!st || st.mode !== "dynamic") return;
  clearTimeout(dynTimer);
  dynTimer = setTimeout(computeDynamicRange, 250);
}

function visibleTileZoom(def) {
  return Math.max(state.manifest.minNativeZoom, Math.min(def.max_zoom, Math.round(map.getZoom())));
}

function computeDynamicRange() {
  const def = state.layers.get(state.active);
  const st = styleOf(state.active);
  if (st.mode !== "dynamic") return;
  const z = visibleTileZoom(def);
  const b = map.getBounds();
  const nw = map.project(b.getNorthWest(), z);
  const se = map.project(b.getSouthEast(), z);
  const area = (se.x - nw.x) * (se.y - nw.y);
  const stride = Math.max(1, Math.round(Math.sqrt(area / 250000)));
  const sample = [];
  const tx0 = Math.floor(nw.x / 256), tx1 = Math.floor((se.x - 1) / 256);
  const ty0 = Math.floor(nw.y / 256), ty1 = Math.floor((se.y - 1) / 256);
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const vals = resolved.get(valueKey(def, z, tx, ty));
      if (!vals) continue;
      const px0 = Math.max(0, Math.floor(nw.x - tx * 256)), px1 = Math.min(256, Math.ceil(se.x - tx * 256));
      const py0 = Math.max(0, Math.floor(nw.y - ty * 256)), py1 = Math.min(256, Math.ceil(se.y - ty * 256));
      for (let py = py0; py < py1; py += stride) {
        for (let px = px0; px < px1; px += stride) {
          const v = vals[py * 256 + px];
          if (v === v && (!def.zero_as_background || v > 0)) sample.push(v);
        }
      }
    }
  }
  if (sample.length < 50) return;
  const arr = Float32Array.from(sample).sort();
  const q = (p) => arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))];
  st.dynMin = q(0.02);
  st.dynMax = q(0.98);
  st.dynN = arr.length;
  restyle();
}

// ---- odczyt wartości ---------------------------------------------------------------------------

function tilePixel(latlng, z) {
  const p = map.project(latlng, z);
  const x = Math.floor(p.x / 256), y = Math.floor(p.y / 256);
  return { x, y, i: Math.floor(p.y - y * 256) * 256 + Math.floor(p.x - x * 256) };
}

function describe(def, v) {
  if (!Number.isFinite(v)) return "brak danych";
  if (def.scale_type === "classes") {
    const c = def.classes.find((k) => v <= k.max && (k.min === null || v > k.min));
    return `${c ? c.label : "brak (> −0,5 K)"} · ${fmt(v)} K`;
  }
  return `${fmt(v)} ${def.unit === "–" ? "" : def.unit}`.trim();
}

async function sampleLayer(def, latlng) {
  const z = def.max_zoom;
  const { x, y, i } = tilePixel(latlng, z);
  const vals = await getValues(def, z, x, y);
  return vals ? vals[i] : NaN;
}

async function sampleAll(latlng) {
  const rows = [];
  for (const def of state.layers.values()) rows.push([def, await sampleLayer(def, latlng)]);
  return rows;
}

function samplesTable(rows) {
  let group = null;
  return rows.map(([def, v]) => {
    const head = def.group !== group ? `<tr class="sep"><td colspan="2">${def.group}</td></tr>` : "";
    group = def.group;
    return `${head}<tr><td>${def.name}</td><td>${describe(def, v)}</td></tr>`;
  }).join("");
}

const ValueBox = L.Control.extend({
  options: { position: "bottomright" },
  onAdd() { this.div = L.DomUtil.create("div", "value-box"); return this.div; },
});
const valueBox = new ValueBox();

function updateValueBox(latlng) {
  if (!valueBox.div) return;
  const def = state.layers.get(state.active);
  if (!latlng || !def) { valueBox.div.textContent = "Najedź na mapę, aby odczytać wartość"; return; }
  const z = visibleTileZoom(def);
  const { x, y, i } = tilePixel(latlng, z);
  const vals = resolved.get(valueKey(def, z, x, y));
  const v = vals ? vals[i] : NaN;
  valueBox.div.innerHTML = `<b>${def.name}</b>: ${describe(def, v)}<br>` +
    `<span class="note">${latlng.lat.toFixed(4)}° N, ${latlng.lng.toFixed(4)}° E</span>`;
}

map.on("mousemove", (e) => updateValueBox(e.latlng));
map.on("click", async (e) => {
  const popup = L.popup({ maxWidth: 360 }).setLatLng(e.latlng).setContent("…").openOn(map);
  const rows = await sampleAll(e.latlng);
  popup.setContent(`<div class="popup"><h3>${e.latlng.lat.toFixed(4)}° N, ${e.latlng.lng.toFixed(4)}° E</h3>` +
    `<table>${samplesTable(rows)}</table></div>`);
});
map.on("moveend", scheduleDynamicRange);

// ---- panel: warstwy i skala --------------------------------------------------------------------

function buildLayerList() {
  const box = document.getElementById("layer-list");
  let group = null;
  for (const def of state.layers.values()) {
    if (def.group !== group) {
      group = def.group;
      box.insertAdjacentHTML("beforeend", `<div class="group">${group}</div>`);
    }
    const label = document.createElement("label");
    label.innerHTML = `<input type="radio" name="layer" value="${def.id}"><span>${def.name}</span>`;
    label.querySelector("input").addEventListener("change", () => setActiveLayer(def.id));
    box.appendChild(label);
  }
}

function syncScaleControls() {
  const def = state.layers.get(state.active);
  const st = styleOf(state.active);
  document.querySelector(`input[name="layer"][value="${def.id}"]`).checked = true;
  document.getElementById("scale-controls").classList.toggle("disabled", !def.dynamic);
  const pal = document.getElementById("palette");
  pal.innerHTML = "";
  const choices = def.scale_type === "classes" ? ["klasy"]
    : Object.keys(PALETTES).filter((k) => k !== "klasy" && (k !== "hipsometria" || def.id === "elevation"));
  for (const k of choices) pal.add(new Option(PALETTES[k].name, k, false, k === st.palette));
  document.getElementById("reverse").checked = st.reverse;
  document.querySelector(`input[name="mode"][value="${st.mode}"]`).checked = true;
  document.getElementById("symmetric").checked = st.symmetric;
  document.getElementById("manual-range").style.display = st.mode === "manual" ? "flex" : "none";
  const [lo, hi] = effectiveRange(def, st);
  document.getElementById("range-min").value = +lo.toFixed(3);
  document.getElementById("range-max").value = +hi.toFixed(3);
  document.querySelector("#manual-range .unit").textContent = def.unit === "–" ? "" : def.unit;
}

function updateLegend() {
  const def = state.layers.get(state.active);
  const st = styleOf(state.active);
  const box = document.getElementById("legend");
  const note = document.getElementById("scale-note");
  const unit = def.unit === "–" ? "" : ` ${def.unit}`;
  if (def.scale_type === "classes") {
    box.innerHTML = `<div class="classes">${def.classes.map((c) =>
      `<div><span class="sw" style="background:${c.color}"></span>${c.label}</div>`).join("")}
      <div><span class="sw" style="background:rgb(${BACKGROUND_RGB})"></span>brak mrozowiska (> −0,5 K)</div></div>`;
    note.textContent = "Klasy mają stałe progi (jak na mapach statycznych).";
    return;
  }
  const pal = PALETTES[st.palette];
  if (pal.breaks && st.mode === "fixed") {
    const colors = st.reverse ? [...pal.colors].reverse() : pal.colors;
    box.innerHTML = `<div class="classes">${colors.map((c, k) =>
      `<div><span class="sw" style="background:${c}"></span>${pal.breaks[k]} – ${pal.breaks[k + 1]}${unit}</div>`)
      .reverse().join("")}</div>`;
  } else {
    const [lo, hi] = effectiveRange(def, st);
    const lut = makeLUT(pal.colors, st.reverse);
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 1;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(256, 1);
    for (let i = 0; i < 256; i++) img.data.set([lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2], 255], i * 4);
    ctx.putImageData(img, 0, 0);
    const mid = def.scale_type === "log" ? Math.sqrt(lo * hi) : (lo + hi) / 2;
    box.innerHTML = "";
    box.appendChild(canvas);
    box.insertAdjacentHTML("beforeend",
      `<div class="ticks"><span>${fmt(lo)}</span><span>${fmt(mid)}</span><span>${fmt(hi)}${unit}</span></div>`);
  }
  const modeText = {
    fixed: "stała (domyślna dla warstwy)",
    dynamic: Number.isFinite(st.dynMin)
      ? `dynamiczna: percentyle 2–98 widoku (${st.dynN.toLocaleString("pl-PL")} pikseli)`
      : "dynamiczna: czekam na kafle widoku…",
    manual: "ręczna",
  }[st.mode];
  note.textContent = `Zakres ${modeText}.${def.scale_type === "log" ? " Skala logarytmiczna." : ""}`;
}

function bindScaleControls() {
  const st = () => styleOf(state.active);
  document.getElementById("palette").addEventListener("change", (e) => { st().palette = e.target.value; restyle(); });
  document.getElementById("reverse").addEventListener("change", (e) => { st().reverse = e.target.checked; restyle(); });
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", (e) => {
    const s = st();
    const def = state.layers.get(state.active);
    if (e.target.value === "manual") [s.min, s.max] = effectiveRange(def, s);
    s.mode = e.target.value; // hipsometria poza trybem stałym rysowana jest jako paleta ciągła
    syncScaleControls();
    restyle();
    if (s.mode === "dynamic") computeDynamicRange();
  }));
  for (const id of ["range-min", "range-max"]) {
    document.getElementById(id).addEventListener("change", () => {
      const s = st();
      s.min = parseFloat(document.getElementById("range-min").value);
      s.max = parseFloat(document.getElementById("range-max").value);
      s.mode = "manual";
      syncScaleControls();
      restyle();
    });
  }
  document.getElementById("symmetric").addEventListener("change", (e) => {
    st().symmetric = e.target.checked;
    syncScaleControls();
    restyle();
  });
}

// ---- panel: wyświetlanie i granice -------------------------------------------------------------

function bindDisplayControls() {
  document.getElementById("hillshade-on").addEventListener("change", (e) => { state.hillshade.on = e.target.checked; restyle(); });
  document.getElementById("hillshade-strength").addEventListener("input", (e) => {
    state.hillshade.strength = parseFloat(e.target.value);
    restyle();
  });
  document.getElementById("opacity").addEventListener("input", (e) => {
    state.opacity = parseFloat(e.target.value);
    if (state.gridLayer) state.gridLayer.setOpacity(state.opacity);
  });
  document.getElementById("basemap").addEventListener("change", (e) => setBasemap(e.target.value));
  document.getElementById("panel-toggle").addEventListener("click", () => {
    const hidden = document.body.classList.toggle("panel-hidden");
    document.getElementById("panel-toggle").setAttribute("aria-expanded", String(!hidden));
    setTimeout(() => map.invalidateSize(), 250);
  });
}

const BOUNDARY_STYLE = {
  wojewodztwa: { color: "#111", weight: 1.8, fill: false },
  powiaty: { color: "#333", weight: 0.9, fill: false },
  gminy: { color: "#555", weight: 0.45, fill: false, opacity: 0.8 },
};
const boundaryLayers = {};

async function toggleBoundary(key, on) {
  if (on && !boundaryLayers[key]) {
    const data = await (await fetch(versioned(state.manifest.boundaries[key]))).json();
    boundaryLayers[key] = L.geoJSON(data, { style: BOUNDARY_STYLE[key], pane: "bounds", interactive: false });
  }
  if (!boundaryLayers[key]) return;
  if (on) boundaryLayers[key].addTo(map); else map.removeLayer(boundaryLayers[key]);
}

function bindBoundaryControls() {
  document.querySelectorAll("input[data-boundary]").forEach((cb) => {
    cb.addEventListener("change", () => toggleBoundary(cb.dataset.boundary, cb.checked));
    if (cb.checked) toggleBoundary(cb.dataset.boundary, true);
  });
}

// ---- stacje ------------------------------------------------------------------------------------

const SHAPES = { circle: "koło", triangle: "trójkąt", square: "kwadrat", diamond: "romb", star: "gwiazda" };
const DEFAULT_CATEGORY_STYLES = {
  "IMGW - stacja synoptyczna": { color: "#e31a1c", shape: "star" },
  "IMGW - stacja klimatologiczna": { color: "#ffd92f", shape: "triangle" },
  // domyślnie ukryte (można włączyć w panelu; wyszukanie stacji też je pokazuje)
  "IMGW - posterunek opadowy": { color: "#1f78b4", shape: "circle", visible: false },
  "IMGW - brak bieżących danych": { color: "#9e9e9e", shape: "circle", visible: false },
};
const EXTRA_COLORS = ["#33a02c", "#ff7f00", "#6a3d9a", "#b15928", "#fb9a99", "#a6cee3", "#cab2d6", "#000000"];

const stations = { all: [], categories: new Map(), group: L.layerGroup(), labels: false };

function shapeSVG(shape, color, size) {
  const s = size, h = s / 2, st = 'stroke="#000" stroke-width="1"';
  const body = {
    circle: `<circle cx="${h}" cy="${h}" r="${h - 1}" fill="${color}" ${st}/>`,
    square: `<rect x="1" y="1" width="${s - 2}" height="${s - 2}" fill="${color}" ${st}/>`,
    triangle: `<polygon points="${h},1 ${s - 1},${s - 1} 1,${s - 1}" fill="${color}" ${st}/>`,
    diamond: `<polygon points="${h},0.5 ${s - 0.5},${h} ${h},${s - 0.5} 0.5,${h}" fill="${color}" ${st}/>`,
    star: `<polygon points="${starPoints(h, h - 0.5, h * 0.45)}" fill="${color}" ${st}/>`,
  }[shape];
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${body}</svg>`;
}

function starPoints(c, r1, r2) {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? r2 : r1, a = -Math.PI / 2 + (k * Math.PI) / 5;
    pts.push(`${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

function stationIcon(cat) {
  const size = cat.shape === "star" ? 16 : 12;
  return L.divIcon({ html: shapeSVG(cat.shape, cat.color, size), className: "station-icon",
    iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function num(v) {
  if (v === undefined || v === null || v === "") return NaN;
  return parseFloat(String(v).replace(",", "."));
}

const KNOWN_FIELDS = new Set(["nazwa", "name", "lon", "lat", "kategoria", "category"]);
const FIELD_LABELS = { kod_stacji: "kod", zrodlo: "źródło", wysokosc_npm: "wysokość n.p.m. [m]", rok_zalozenia: "rok założenia" };

function addStations(rows, sourceName) {
  let added = 0;
  for (const r of rows) {
    const lat = num(r.lat), lon = num(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = r.nazwa || r.name || "(bez nazwy)";
    const catName = r.kategoria || r.category || `bez kategorii (${sourceName})`;
    if (!stations.categories.has(catName)) {
      const k = stations.categories.size;
      const def = DEFAULT_CATEGORY_STYLES[catName] || { color: EXTRA_COLORS[k % EXTRA_COLORS.length], shape: "square" };
      stations.categories.set(catName, { name: catName, visible: true, ...def, markers: [] });
    }
    const cat = stations.categories.get(catName);
    const marker = L.marker([lat, lon], { icon: stationIcon(cat), title: name, keyboard: false });
    const st = { name, lat, lon, row: r, cat, marker };
    marker.on("click", () => openStationPopup(st));
    cat.markers.push(marker);
    stations.all.push(st);
    added++;
  }
  renderCategoryList();
  refreshStations();
  updateStationSearch();
  return added;
}

async function openStationPopup(st) {
  const extra = Object.entries(st.row)
    .filter(([k, v]) => !KNOWN_FIELDS.has(k) && v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `<tr><td>${FIELD_LABELS[k] || k}</td><td>${v}</td></tr>`).join("");
  const head = `<div class="popup"><h3>${st.name}</h3><table>` +
    `<tr><td>kategoria</td><td>${st.cat.name}</td></tr>${extra}` +
    `<tr><td>położenie</td><td>${st.lat.toFixed(4)}° N, ${st.lon.toFixed(4)}° E</td></tr>`;
  st.marker.bindPopup(`${head}</table></div>`, { maxWidth: 380 }).openPopup();
  const rows = await sampleAll(L.latLng(st.lat, st.lon));
  st.marker.setPopupContent(`${head}${samplesTable(rows)}</table></div>`);
}

function refreshStations() {
  stations.group.clearLayers();
  const showLabels = stations.labels && map.getZoom() >= 9;
  for (const cat of stations.categories.values()) {
    if (!cat.visible) continue;
    for (const m of cat.markers) {
      stations.group.addLayer(m);
      if (showLabels && !m.getTooltip()) {
        m.bindTooltip(m.options.title, { permanent: true, direction: "right", offset: [6, 0], className: "station-label" });
      } else if (!showLabels && m.getTooltip()) {
        m.unbindTooltip();
      }
    }
  }
}

function renderCategoryList() {
  const box = document.getElementById("category-list");
  box.innerHTML = "";
  for (const cat of stations.categories.values()) {
    const row = document.createElement("div");
    row.className = "cat";
    const shapeOpts = Object.entries(SHAPES).map(([k, v]) => `<option value="${k}" ${k === cat.shape ? "selected" : ""}>${v}</option>`).join("");
    row.innerHTML = `<input type="checkbox" ${cat.visible ? "checked" : ""} aria-label="pokaż ${cat.name}">
      <span class="preview">${shapeSVG(cat.shape, cat.color, 14)}</span>
      <input type="color" value="${cat.color}" aria-label="kolor ${cat.name}">
      <span>${cat.name}</span><span class="count">${cat.markers.length}</span>
      <select aria-label="kształt ${cat.name}" style="grid-column: 3 / 6">${shapeOpts}</select>`;
    const [cb, color] = row.querySelectorAll("input");
    const shape = row.querySelector("select");
    cb.addEventListener("change", () => { cat.visible = cb.checked; refreshStations(); });
    const restyleCat = () => {
      cat.color = color.value;
      cat.shape = shape.value;
      row.querySelector(".preview").innerHTML = shapeSVG(cat.shape, cat.color, 14);
      const icon = stationIcon(cat);
      cat.markers.forEach((m) => m.setIcon(icon));
    };
    color.addEventListener("input", restyleCat);
    shape.addEventListener("change", restyleCat);
    box.appendChild(row);
  }
}

function updateStationSearch() {
  const list = document.getElementById("station-names");
  list.innerHTML = "";
  const names = [...new Set(stations.all.map((s) => s.name))].sort((a, b) => a.localeCompare(b, "pl"));
  for (const n of names) list.appendChild(new Option(n));
}

function bindStationControls() {
  document.getElementById("stations-on").addEventListener("change", (e) => {
    if (e.target.checked) stations.group.addTo(map); else map.removeLayer(stations.group);
  });
  document.getElementById("station-labels").addEventListener("change", (e) => { stations.labels = e.target.checked; refreshStations(); });
  map.on("zoomend", () => { if (stations.labels) refreshStations(); });
  const setAll = (v) => { for (const c of stations.categories.values()) c.visible = v; renderCategoryList(); refreshStations(); };
  document.getElementById("cats-all").addEventListener("click", () => setAll(true));
  document.getElementById("cats-none").addEventListener("click", () => setAll(false));
  document.getElementById("station-search").addEventListener("change", (e) => {
    const q = e.target.value.trim().toLowerCase();
    const st = stations.all.find((s) => s.name.toLowerCase() === q) || stations.all.find((s) => s.name.toLowerCase().includes(q));
    if (!st) return;
    st.cat.visible = true;
    renderCategoryList();
    refreshStations();
    map.setView([st.lat, st.lon], Math.max(map.getZoom(), 11));
    openStationPopup(st);
  });
  document.getElementById("csv-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (res) => {
        const n = addStations(res.data, file.name);
        alert(`Wczytano ${n} stacji z pliku ${file.name}` + (n < res.data.length ? ` (pominięto ${res.data.length - n} bez współrzędnych).` : "."));
      },
    });
    e.target.value = "";
  });
}

// ---- start -------------------------------------------------------------------------------------

async function main() {
  const resp = await fetch("data/layers.json", { cache: "no-store" }); // zawsze świeży manifest
  if (!resp.ok) {
    document.getElementById("layer-desc").textContent = "Brak data/layers.json - uruchom `zastoiska web-build`.";
    return;
  }
  state.manifest = await resp.json();
  const dirs = new Set(state.manifest.layers.map((l) => `${state.manifest.tilesRoot}/${l.tiles}`));
  dirs.add(state.manifest.hillshade.tiles);
  await Promise.all([...dirs].map(loadTileIndex));
  for (const def of state.manifest.layers) {
    state.layers.set(def.id, def);
    state.styles.set(def.id, { palette: def.palette, reverse: false, mode: "fixed", symmetric: def.symmetric,
      min: def.range[0], max: def.range[1], dynMin: NaN, dynMax: NaN, dynN: 0 });
  }
  map.fitBounds(state.manifest.bounds);
  setBasemap(document.getElementById("basemap").value);
  valueBox.addTo(map);
  buildLayerList();
  bindScaleControls();
  bindDisplayControls();
  bindBoundaryControls();
  bindStationControls();
  setActiveLayer("anomaly_model");
  stations.group.addTo(map);
  Papa.parse(versioned(state.manifest.stations), {
    download: true, header: true, skipEmptyLines: true,
    complete: (res) => addStations(res.data, "IMGW"),
  });
  document.getElementById("credits").innerHTML =
    `Dane: NMT GUGiK 100 m; nocne LST VIIRS (NASA LP DAAC, 2023–2026, 00–05 UTC); granice PRG; stacje IMGW-PIB. ` +
    `Cieniowanie: ${state.manifest.hillshade.description}. ` +
    `Model: ${state.manifest.modelLabel}. Dane zbudowane ${state.manifest.created.slice(0, 10)}.`;
}

main();
