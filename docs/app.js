// Smartstake live data page.
// Fetches rows from the Apps Script web app (see google_apps_script/Code.gs),
// or generates simulated rows in demo mode, and draws them as SVG line charts.
"use strict";

(() => {
  const CONFIG = Object.assign(
    { dataUrl: "", refreshSeconds: 60, title: "Smartstake live data", defaultView: "potential" },
    window.SMARTSTAKE_CONFIG
  );
  const CAL_CONFIG = Object.assign({ analyte: "Nitrate", unit: "mM", pairs: {} }, CONFIG.calibration);

  const RANGES = [
    { key: "6h", label: "6 h", hours: 6 },
    { key: "24h", label: "24 h", hours: 24 },
    { key: "3d", label: "3 d", hours: 72 },
    { key: "7d", label: "7 d", hours: 168 },
  ];
  const CYCLE_SECONDS = 40;                // approximate logger cycle, used to size requests
  const MAX_ROWS = 20000;                  // matches MAX_ROWS_PER_GET in Code.gs
  const OFFLINE_AFTER_MS = 5 * 60 * 1000;  // no new row for this long = offline
  const PAIR_COLUMN = /^s(\d+)_re(\d+)_ise(\d+)$/;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const HOUR = 3600 * 1000;

  // Concentration units, converted from mM
  const UNITS = {
    "mM": { label: "mM", factor: 1, decimals: 2 },
    "mg/L NO3": { label: "mg/L NO₃⁻", factor: 62.004, decimals: 1 },
    "mg/L N": { label: "mg/L NO₃⁻-N", factor: 14.007, decimals: 1 },
  };

  const params = new URLSearchParams(location.search);
  const DEMO = params.has("demo") || !CONFIG.dataUrl || CONFIG.dataUrl.includes("XXXXXXXX");
  const CAL_KEY = DEMO ? "smartstake-calibration-demo" : "smartstake-calibration";

  const state = {
    rangeKey: readStored("smartstake-range", RANGES.map((r) => r.key), "24h"),
    // ?view=potential or ?view=concentration (or the analyte name) overrides the stored choice
    mode: params.has("view")
      ? (params.get("view") === "potential" ? "potential" : "concentration")
      : readStored("smartstake-mode", ["potential", "concentration"],
        CONFIG.defaultView === "concentration" ? "concentration" : "potential"),
    unitKey: readStored("smartstake-unit", Object.keys(UNITS), UNITS[CAL_CONFIG.unit] ? CAL_CONFIG.unit : "mM"),
    cal: loadCalibration(),   // { pairName: { e0, slope } } in mV
    data: null,      // full fetched table
    view: null,      // table sliced to the selected range
    domain: null,    // [start, end] ms shared by every chart
    error: null,
    loading: false,
    charts: [],
  };

  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const currentRange = () => RANGES.find((r) => r.key === state.rangeKey);

  function readStored(key, allowed, fallback) {
    try {
      const value = localStorage.getItem(key);
      if (allowed.includes(value)) return value;
    } catch (e) { /* storage unavailable */ }
    return fallback;
  }

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  // First index with times[i] >= t
  function lowerBound(times, t) {
    let lo = 0, hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function nearestIndex(times, t) {
    const i = lowerBound(times, t);
    if (i <= 0) return 0;
    if (i >= times.length) return times.length - 1;
    return t - times[i - 1] < times[i] - t ? i - 1 : i;
  }

  function fullTime(t) {
    return new Date(t).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 48 * 3600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  async function fetchData(hours) {
    if (DEMO) return makeDemoData(hours);

    const n = Math.min(MAX_ROWS, Math.ceil((hours * 3600 / CYCLE_SECONDS) * 1.3));
    const res = await fetch(`${CONFIG.dataUrl}?n=${n}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.ok === false) throw new Error(json.error || "bad response");
    return parseTable(json.columns || [], json.rows || []);
  }

  // Sheet rows -> { names, times: Float64Array, values: { name: Float64Array } }
  function parseTable(columns, rows) {
    const names = columns.slice(1).map(String);
    const kept = rows
      .filter((row) => Number.isFinite(Date.parse(row[0])))
      .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));

    const times = new Float64Array(kept.length);
    const values = {};
    names.forEach((name) => (values[name] = new Float64Array(kept.length)));
    kept.forEach((row, i) => {
      times[i] = Date.parse(row[0]);
      names.forEach((name, j) => (values[name][i] = cleanValue(name, row[j + 1])));
    });
    return { names, times, values };
  }

  function cleanValue(name, raw) {
    if (raw === "" || raw === null || raw === undefined) return NaN;
    const v = Number(raw);
    if (!Number.isFinite(v)) return NaN;
    return v;
  }

  function sliceFrom(data, start) {
    const i = lowerBound(data.times, start);
    const values = {};
    data.names.forEach((name) => (values[name] = data.values[name].subarray(i)));
    return { names: data.names, times: data.times.subarray(i), values };
  }

  // Nitrate electrode pairs used by the simulated data
  function demoPairs() {
    const pairs = [];
    const stakes = [
      { stake: 1, res: [1, 2], ises: [1, 2, 3], base: 210 },
      { stake: 2, res: [3, 4], ises: [4, 5, 6], base: 260 },
    ];
    stakes.forEach(({ stake, res, ises, base }) => {
      res.forEach((re, ri) => {
        ises.forEach((ise, ii) => {
          pairs.push({
            name: `s${stake}_re${re}_ise${ise}`,
            e0: base + 22 * ii + 9 * ri,
            slope: -(54 + 2 * ii),              // mV/decade
            drift: (ii - 1) * 1.2 + 0.6 * ri,   // mV/day
            seed: stake * 100 + re * 10 + ise,
          });
        });
      });
    });
    return pairs;
  }

  // Calibration of the simulated pairs as if taken half a day ago, so drift shows
  function demoCalibration() {
    const cal = {};
    demoPairs().forEach((p) => (cal[p.name] = { e0: +(p.e0 + p.drift * 6.5).toFixed(1), slope: p.slope }));
    return cal;
  }

  // Simulated rows with the logger's column layout: nitrate on every pair,
  // slow uptake with dosing every 2 days, a small diurnal swing, slow electrode
  // drift and noise. Values are volts like the sheet.
  function makeDemoData(hours) {
    const stepMs = CYCLE_SECONDS * 1000;
    const end = Math.floor(Date.now() / stepMs) * stepMs;
    const count = Math.floor((hours * HOUR) / stepMs);
    const epoch = end - 7 * 24 * HOUR;
    const pairs = demoPairs();

    const names = ["vbat", ...pairs.map((p) => p.name)];
    const times = new Float64Array(count);
    const values = {};
    names.forEach((name) => (values[name] = new Float64Array(count)));

    // Deterministic noise keyed to the cycle number, so refreshes don't reshuffle history
    const noise = (k, seed) => {
      const x = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453;
      return (x - Math.floor(x) - 0.5) * 2;
    };

    for (let i = 0; i < count; i++) {
      const t = end - (count - 1 - i) * stepMs;
      const k = Math.round(t / stepMs);
      const d = new Date(t);
      const hod = d.getHours() + d.getMinutes() / 60;
      const days = (t - epoch) / (24 * HOUR);
      const dosePhase = (days / 2) % 1;

      const diurnal = 0.7 * Math.sin((2 * Math.PI * (hod - 9)) / 24);   // mV
      const sun = Math.max(0, Math.sin((2 * Math.PI * (hod - 6)) / 24));
      const vbat = 3.82 + 0.22 * sun + 0.004 * noise(k, 3);

      times[i] = t;
      values.vbat[i] = vbat;

      const nitrate = 6 - 2.2 * dosePhase;   // mM
      pairs.forEach((p) => {
        const mv = p.e0 + p.slope * Math.log10(nitrate) + diurnal
          + p.drift * days + 0.35 * noise(k, p.seed);
        values[p.name][i] = mv / 1000;
      });
    }
    return { names, times, values };
  }

  // -------------------------------------------------------------------------
  // Calibration
  // -------------------------------------------------------------------------

  // Declarations (not const arrows) because state is initialized above with loadCalibration()
  function toNumber(v) {
    return v === null || v === undefined || v === "" ? NaN : Number(v);
  }

  function isCalibrated(c) {
    return !!c && Number.isFinite(c.e0) && Number.isFinite(c.slope) && c.slope !== 0;
  }

  // config.js values, simulated-data defaults in demo mode, then this browser's edits
  function loadCalibration() {
    const cal = {};
    const add = (pairs) => Object.entries(pairs || {}).forEach(([name, c]) => {
      cal[name] = { e0: toNumber(c && c.e0), slope: toNumber(c && c.slope) };
    });
    if (DEMO) add(demoCalibration());
    add(CAL_CONFIG.pairs);
    try { add(JSON.parse(localStorage.getItem(CAL_KEY) || "{}")); } catch (e) { /* ignore */ }
    return cal;
  }

  function saveCalibration() {
    try { localStorage.setItem(CAL_KEY, JSON.stringify(state.cal)); } catch (e) { /* ignore */ }
  }

  // Raw reading in volts -> concentration in the selected unit, NaN if uncalibrated
  function concentrationOf(name, volts) {
    const c = state.cal[name];
    if (!isCalibrated(c) || !Number.isFinite(volts)) return NaN;
    return 10 ** ((volts * 1000 - c.e0) / c.slope) * UNITS[state.unitKey].factor;
  }

  function pairTransform(name) {
    if (state.mode === "concentration") return (v) => concentrationOf(name, v);
    return (v) => v * 1000;
  }

  function calibrationSnippet() {
    const pairs = Object.keys(state.cal).sort()
      .filter((name) => isCalibrated(state.cal[name]))
      .map((name) => `      ${name}: { e0: ${state.cal[name].e0}, slope: ${state.cal[name].slope} },`);
    return [
      "  calibration: {",
      `    analyte: ${JSON.stringify(CAL_CONFIG.analyte)},`,
      `    unit: ${JSON.stringify(state.unitKey)},`,
      "    pairs: {",
      ...pairs,
      "    },",
      "  },",
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // Chart specs
  // -------------------------------------------------------------------------

  // One panel per (stake, RE). ISE colors are fixed per stake so the same
  // electrode keeps its color across that stake's panels.
  function pairSpecs(names) {
    const concentration = state.mode === "concentration";
    const unit = UNITS[state.unitKey];
    const stakes = new Map();
    names.forEach((name) => {
      const m = PAIR_COLUMN.exec(name);
      if (!m) return;
      const [stake, re, ise] = m.slice(1).map(Number);
      if (!stakes.has(stake)) stakes.set(stake, { ises: new Set(), panels: new Map() });
      const s = stakes.get(stake);
      s.ises.add(ise);
      if (!s.panels.has(re)) s.panels.set(re, []);
      s.panels.get(re).push({ ise, name });
    });

    const specs = [];
    [...stakes.keys()].sort((a, b) => a - b).forEach((stake) => {
      const s = stakes.get(stake);
      const iseOrder = [...s.ises].sort((a, b) => a - b);
      [...s.panels.keys()].sort((a, b) => a - b).forEach((re) => {
        const series = s.panels.get(re)
          .sort((a, b) => a.ise - b.ise)
          .map((p) => {
            const uncalibrated = concentration && !isCalibrated(state.cal[p.name]);
            return {
              key: p.name,
              label: uncalibrated ? `ISE ${p.ise} · uncalibrated` : `ISE ${p.ise}`,
              slot: Math.min(iseOrder.indexOf(p.ise), 7) + 1,
              transform: pairTransform(p.name),
            };
          });
        specs.push({
          id: `s${stake}_re${re}`,
          title: `Smartstake ${stake} · RE ${re}`,
          subtitle: concentration ? `${CAL_CONFIG.analyte}, ${unit.label}` : "Potential vs. RE, mV",
          unit: concentration ? unit.label : "mV",
          decimals: concentration ? unit.decimals : 1,
          emptyText: concentration && series.every((x) => x.label.endsWith("uncalibrated"))
            ? "Not calibrated"
            : "",
          series,
        });
      });
    });
    return specs;
  }

  // -------------------------------------------------------------------------
  // Line chart
  // -------------------------------------------------------------------------

  const TIME_STEPS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880].map((min) => min * 60000);

  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = +([1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw)).toPrecision(6);
    const ticks = [];
    for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step * 1e-9; v += step) {
      ticks.push(+v.toPrecision(10));
    }
    const decimals = (String(step).split(".")[1] || "").length;
    return { ticks, decimals };
  }

  function timeTicks(x0, x1, maxTicks) {
    const step = TIME_STEPS.find((s) => (x1 - x0) / s <= maxTicks) || TIME_STEPS[TIME_STEPS.length - 1];
    const offset = -new Date(x0).getTimezoneOffset() * 60000;   // align ticks to local midnight
    const ticks = [];
    for (let t = Math.ceil((x0 + offset) / step) * step - offset; t <= x1; t += step) ticks.push(t);
    return { ticks, step };
  }

  function timeLabel(t, step) {
    const d = new Date(t);
    if (step >= 24 * HOUR || (d.getHours() === 0 && d.getMinutes() === 0)) {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  // Indices to draw: every k-th point so a path has at most ~maxPoints vertices
  function decimate(n, maxPoints) {
    const step = Math.max(1, Math.ceil(n / maxPoints));
    const idx = [];
    for (let i = 0; i < n; i += step) idx.push(i);
    if (n && idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    return idx;
  }

  // Breaks the line at missing values and at gaps longer than gapMs
  function linePath(t, y, sx, sy, gapMs) {
    let d = "";
    let pen = false;
    for (let i = 0; i < t.length; i++) {
      if (!Number.isFinite(y[i])) { pen = false; continue; }
      if (pen && t[i] - t[i - 1] > gapMs) pen = false;
      d += `${pen ? "L" : "M"}${sx(t[i]).toFixed(1)},${sy(y[i]).toFixed(1)}`;
      pen = true;
    }
    return d;
  }

  function createChart(spec) {
    const card = el("article", "card");
    const head = el("div", "card-head");
    const titles = el("div");
    titles.append(el("h3", null, spec.title), el("div", "card-sub", spec.subtitle));
    head.append(titles);

    // A single series is named by the title; two or more get a legend
    if (spec.series.length > 1) {
      const legend = el("div", "legend");
      spec.series.forEach((s) => {
        const item = el("span", "legend-item");
        const key = el("span", "key");
        key.style.background = `var(--series-${s.slot})`;
        item.append(key, document.createTextNode(s.label));
        legend.append(item);
      });
      head.append(legend);
    }

    const plot = el("div", "plot");
    const svg = svgEl("svg", {
      role: "img",
      tabindex: "0",
      "aria-label": `${spec.title}, line chart of ${spec.series.map((s) => s.label).join(", ")}. Use arrow keys to read values.`,
    });
    const tooltip = el("div", "tooltip");
    tooltip.hidden = true;
    const empty = el("p", "empty", "No readings in this time range");
    empty.hidden = true;
    plot.append(svg, tooltip, empty);
    card.append(head, plot);

    const chart = { spec, card, plot, svg, tooltip, empty, data: null, domain: null, view: null, hoverIndex: -1 };
    attachHover(chart);
    return chart;
  }

  function renderChart(chart) {
    const { spec, svg, plot, data, domain } = chart;
    const width = Math.floor(plot.clientWidth);
    if (!width || !data) return;

    const height = 200;
    const m = { top: 10, right: 12, bottom: 26, left: 56 };
    const iw = Math.max(10, width - m.left - m.right);
    const ih = height - m.top - m.bottom;
    const [x0, x1] = domain;

    const idx = decimate(data.times.length, iw * 2);
    const t = idx.map((i) => data.times[i]);
    const ys = spec.series.map((s, k) => {
      const col = data.columns[k];
      return idx.map((i) => (col ? s.transform(col[i]) : NaN));
    });

    let lo = Infinity, hi = -Infinity;
    ys.forEach((arr) => arr.forEach((v) => {
      if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }));
    const hasData = Number.isFinite(lo);
    chart.empty.hidden = hasData;
    chart.empty.textContent = spec.emptyText || "No readings in this time range";
    if (!hasData) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }

    const { ticks: yTicks, decimals: yDecimals } = niceTicks(lo, hi, Math.max(3, Math.floor(ih / 40)));
    const yLo = yTicks[0], yHi = yTicks[yTicks.length - 1];
    const sx = (v) => m.left + ((v - x0) / (x1 - x0)) * iw;
    const sy = (v) => m.top + (1 - (v - yLo) / (yHi - yLo)) * ih;

    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.replaceChildren();

    const axes = svgEl("g");
    yTicks.forEach((v) => {
      const y = Math.round(sy(v)) + 0.5;
      axes.append(svgEl("line", { class: "grid-line", x1: m.left, x2: m.left + iw, y1: y, y2: y }));
      const label = svgEl("text", { class: "tick", x: m.left - 8, y: y + 4, "text-anchor": "end" });
      label.textContent = v.toFixed(yDecimals);
      axes.append(label);
    });
    const baseY = m.top + ih + 0.5;
    axes.append(svgEl("line", { class: "axis-line", x1: m.left, x2: m.left + iw, y1: baseY, y2: baseY }));

    const { ticks: xTicks, step: xStep } = timeTicks(x0, x1, Math.max(2, Math.floor(iw / 90)));
    xTicks.forEach((v) => {
      const label = svgEl("text", { class: "tick", x: sx(v), y: height - 6, "text-anchor": "middle" });
      label.textContent = timeLabel(v, xStep);
      axes.append(label);
    });
    svg.append(axes);

    // Break lines across logger outages
    const dts = [];
    for (let i = 1; i < t.length; i++) dts.push(t[i] - t[i - 1]);
    dts.sort((a, b) => a - b);
    const gapMs = Math.max(5 * 60000, 6 * (dts[dts.length >> 1] || 0));

    const lines = svgEl("g");
    ys.forEach((y, k) => {
      lines.append(svgEl("path", {
        class: "series-line",
        d: linePath(t, y, sx, sy, gapMs),
        style: `stroke: var(--series-${spec.series[k].slot})`,
      }));
    });
    svg.append(lines);

    const hover = svgEl("g", { visibility: "hidden" });
    const cross = svgEl("line", { class: "crosshair", y1: m.top, y2: m.top + ih });
    const dots = spec.series.map((s) => svgEl("circle", { class: "dot", r: 4, style: `fill: var(--series-${s.slot})` }));
    hover.append(cross, ...dots);
    svg.append(hover);

    chart.view = { t, ys, sx, sy, m, iw, width, x0, x1, hover, cross, dots };
    if (chart.hoverIndex >= t.length) chart.hoverIndex = -1;
    chart.tooltip.hidden = true;
  }

  function attachHover(chart) {
    const { svg } = chart;
    svg.addEventListener("pointermove", (e) => {
      const v = chart.view;
      if (!v || !v.t.length) return;
      const x = e.clientX - svg.getBoundingClientRect().left;
      if (x < v.m.left - 12 || x > v.m.left + v.iw + 12) return hideHover(chart);
      const time = v.x0 + ((x - v.m.left) / v.iw) * (v.x1 - v.x0);
      showHover(chart, nearestIndex(v.t, time));
    });
    svg.addEventListener("pointerleave", () => hideHover(chart));
    svg.addEventListener("focus", () => {
      const v = chart.view;
      if (v && v.t.length) showHover(chart, chart.hoverIndex >= 0 ? chart.hoverIndex : v.t.length - 1);
    });
    svg.addEventListener("blur", () => hideHover(chart));
    svg.addEventListener("keydown", (e) => {
      const v = chart.view;
      const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (!v || !v.t.length || !dir) return;
      e.preventDefault();
      const jump = Math.max(1, Math.round(v.t.length / 60));
      showHover(chart, clamp(chart.hoverIndex + dir * jump, 0, v.t.length - 1));
    });
  }

  function showHover(chart, i) {
    const v = chart.view;
    const { spec, tooltip } = chart;
    chart.hoverIndex = i;

    const x = v.sx(v.t[i]);
    v.cross.setAttribute("x1", x);
    v.cross.setAttribute("x2", x);
    v.dots.forEach((dot, k) => {
      const y = v.ys[k][i];
      dot.setAttribute("visibility", Number.isFinite(y) ? "visible" : "hidden");
      if (Number.isFinite(y)) {
        dot.setAttribute("cx", x);
        dot.setAttribute("cy", v.sy(y));
      }
    });
    v.hover.setAttribute("visibility", "visible");

    tooltip.replaceChildren(el("div", "tip-time", fullTime(v.t[i])));
    spec.series.forEach((s, k) => {
      const y = v.ys[k][i];
      const row = el("div", "tip-row");
      const key = el("span", "key");
      key.style.background = `var(--series-${s.slot})`;
      row.append(
        key,
        el("strong", null, Number.isFinite(y) ? `${y.toFixed(spec.decimals)} ${spec.unit}` : "—"),
        el("span", "tip-label", s.label)
      );
      tooltip.append(row);
    });
    tooltip.hidden = false;

    const tw = tooltip.offsetWidth;
    const left = x + 14 + tw > v.width ? x - 14 - tw : x + 14;
    tooltip.style.left = `${Math.max(0, left)}px`;
    tooltip.style.top = `${v.m.top}px`;
  }

  function hideHover(chart) {
    if (chart.view) chart.view.hover.setAttribute("visibility", "hidden");
    chart.tooltip.hidden = true;
  }

  // Rebuilds a container's cards only when its set of charts changes, so
  // periodic refreshes redraw in place.
  function syncCharts(container, specs) {
    const sig = specs.map((s) => `${s.id}:${s.subtitle}:${s.series.map((x) => `${x.key}=${x.label}`).join(",")}`).join("|");
    if (container.dataset.sig !== sig) {
      container.dataset.sig = sig;
      container.replaceChildren();
      container.charts = specs.map((spec) => {
        const chart = createChart(spec);
        container.append(chart.card);
        return chart;
      });
    }
    return container.charts;
  }

  // -------------------------------------------------------------------------
  // Page sections
  // -------------------------------------------------------------------------

  function latestValue(view, name) {
    const col = view.values[name];
    if (!col) return { value: NaN, time: NaN };
    for (let i = col.length - 1; i >= 0; i--) {
      if (Number.isFinite(col[i])) return { value: col[i], time: view.times[i] };
    }
    return { value: NaN, time: NaN };
  }

  function renderStatus() {
    const status = $("status");
    const icon = $("status-icon");
    const text = $("status-text");
    const times = state.data ? state.data.times : [];
    const last = times.length ? times[times.length - 1] : NaN;

    let kind, label, glyph;
    if (state.error && !state.data) {
      kind = "error"; glyph = "×"; label = "Can't reach data";
    } else if (DEMO) {
      kind = "demo"; glyph = "i"; label = "Demo data";
    } else if (Number.isFinite(last) && Date.now() - last < OFFLINE_AFTER_MS) {
      kind = "live"; glyph = "✓"; label = "Live";
    } else {
      kind = "offline"; glyph = "!"; label = Number.isFinite(last) ? `Offline · last reading ${ago(Date.now() - last)}` : "No readings yet";
    }
    status.dataset.state = kind;
    icon.textContent = glyph;
    text.textContent = label;

    const banner = $("banner");
    if (state.error) {
      banner.hidden = false;
      banner.dataset.kind = "error";
      banner.textContent = `Couldn't load new data (${state.error.message}).`;
    } else if (DEMO) {
      banner.hidden = false;
      banner.dataset.kind = "info";
      banner.textContent = "Showing simulated data.";
    } else {
      banner.hidden = true;
    }

    $("updated").textContent = Number.isFinite(last) ? `Last reading ${fullTime(last)}` : "";
  }

  function renderTiles(view) {
    const tiles = $("tiles");
    tiles.replaceChildren();
    const lastTime = view.times.length ? view.times[view.times.length - 1] : NaN;

    const tile = (label, value, unit, sub) => {
      const card = el("div", "card");
      const val = el("div", "tile-value", value);
      if (unit) val.append(el("span", "tile-unit", unit));
      card.append(el("div", "tile-label", label), val);
      if (sub) card.append(el("div", "tile-sub", sub));
      tiles.append(card);
    };

    tile(
      "Last reading",
      Number.isFinite(lastTime) ? ago(Date.now() - lastTime) : "—",
      "",
      Number.isFinite(lastTime) ? fullTime(lastTime) : "No data in range"
    );
    const unit = UNITS[state.unitKey];
    const latest = view.names.filter((n) => PAIR_COLUMN.test(n))
      .map((n) => concentrationOf(n, latestValue(view, n).value))
      .filter(Number.isFinite);
    const mean = latest.reduce((a, b) => a + b, 0) / latest.length;
    tile(CAL_CONFIG.analyte, latest.length ? mean.toFixed(unit.decimals) : "—", latest.length ? unit.label : "",
      latest.length ? `mean of ${latest.length} pairs` : "Not calibrated");

    if (view.values.vbat) {
      const { value } = latestValue(view, "vbat");
      tile("Battery", Number.isFinite(value) ? value.toFixed(2) : "—", Number.isFinite(value) ? "V" : "");
    }
  }

  // Rows are rebuilt only when the set of pairs changes, so refreshes don't
  // wipe a value being typed.
  function renderCalibration(view) {
    const table = $("cal-table");
    const body = table.querySelector("tbody");
    const unit = UNITS[state.unitKey];
    const pairs = pairSpecs(view.names).flatMap((spec) =>
      spec.series.map((s) => ({ key: s.key, label: `${spec.title} · ISE ${PAIR_COLUMN.exec(s.key)[3]}` })));

    $("cal-conc-head").textContent = CAL_CONFIG.analyte;

    const sig = pairs.map((p) => p.key).join(",");
    if (body.dataset.sig !== sig) {
      body.dataset.sig = sig;
      body.replaceChildren();
      body.cells = {};
      pairs.forEach((p) => {
        const tr = el("tr");
        const inputs = [["e0", "E0, mV"], ["slope", "slope, mV per decade"]].map(([field, name]) => {
          const td = el("td", "num");
          const input = el("input");
          input.type = "number";
          input.step = "any";
          input.inputMode = "decimal";
          input.setAttribute("aria-label", `${p.label} ${name}`);
          const c = state.cal[p.key];
          if (c && Number.isFinite(c[field])) input.value = c[field];
          input.addEventListener("change", () => setCalibration(p.key, field, input.value));
          td.append(input);
          return td;
        });
        const mv = el("td", "num");
        const conc = el("td", "num");
        tr.append(el("td", null, p.label), ...inputs, mv, conc);
        body.append(tr);
        body.cells[p.key] = { mv, conc };
      });
    }

    pairs.forEach((p) => {
      const { value } = latestValue(view, p.key);
      const cells = body.cells[p.key];
      cells.mv.textContent = Number.isFinite(value) ? `${(value * 1000).toFixed(1)} mV` : "—";
      const c = concentrationOf(p.key, value);
      cells.conc.textContent = Number.isFinite(c) ? `${c.toFixed(unit.decimals)} ${unit.label}` : "—";
    });
  }

  function setCalibration(name, field, raw) {
    state.cal[name] = Object.assign({ e0: NaN, slope: NaN }, state.cal[name], { [field]: toNumber(raw.trim()) });
    saveCalibration();
    renderAll();
  }

  async function copyCalibration() {
    const snippet = calibrationSnippet();
    const pre = $("cal-snippet");
    pre.textContent = snippet;
    pre.hidden = false;
    try {
      await navigator.clipboard.writeText(snippet);
      $("cal-msg").textContent = "Copied. Paste into docs/config.js to publish.";
    } catch (e) {
      $("cal-msg").textContent = "Copy the block below into docs/config.js.";
    }
  }

  function resetCalibration() {
    try { localStorage.removeItem(CAL_KEY); } catch (e) { /* ignore */ }
    state.cal = loadCalibration();
    $("cal-table").querySelector("tbody").dataset.sig = "";   // reload the inputs
    $("cal-msg").textContent = "Reset to config.js values.";
    renderAll();
  }

  function downloadCsv() {
    const view = state.view;
    if (!view) return;
    const lines = [["timestamp", ...view.names].join(",")];
    for (let i = 0; i < view.times.length; i++) {
      const cells = view.names.map((n) => (Number.isFinite(view.values[n][i]) ? view.values[n][i] : ""));
      lines.push([new Date(view.times[i]).toISOString(), ...cells].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = `smartstake_${state.rangeKey}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function renderAll() {
    renderStatus();
    if (!state.data) return;

    const now = Date.now();
    state.domain = [now - currentRange().hours * HOUR, now];
    state.view = sliceFrom(state.data, state.domain[0]);

    const concentration = state.mode === "concentration";
    $("pair-heading").textContent = concentration ? CAL_CONFIG.analyte : "Potential";

    renderTiles(state.view);
    renderCalibration(state.view);

    state.charts = syncCharts($("pair-charts"), pairSpecs(state.view.names));
    state.charts.forEach((chart) => {
      chart.data = { times: state.view.times, columns: chart.spec.series.map((s) => state.view.values[s.key]) };
      chart.domain = state.domain;
      renderChart(chart);
    });
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    document.body.classList.add("is-loading");
    try {
      state.data = await fetchData(currentRange().hours);
      state.error = null;
    } catch (err) {
      state.error = err;
    }
    state.loading = false;
    document.body.classList.remove("is-loading");
    renderAll();
  }

  function renderRangeButtons() {
    const group = $("range-buttons");
    group.replaceChildren();
    RANGES.forEach((r) => {
      const b = el("button", null, r.label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(r.key === state.rangeKey));
      b.addEventListener("click", () => {
        if (r.key === state.rangeKey) return;
        state.rangeKey = r.key;
        store("smartstake-range", r.key);
        renderRangeButtons();
        refresh();
      });
      group.append(b);
    });
  }

  function renderModeControls() {
    const group = $("mode-buttons");
    group.replaceChildren();
    [["potential", "Potential"], ["concentration", CAL_CONFIG.analyte]].forEach(([mode, label]) => {
      const b = el("button", null, label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(mode === state.mode));
      b.addEventListener("click", () => {
        if (mode === state.mode) return;
        state.mode = mode;
        store("smartstake-mode", mode);
        renderModeControls();
        renderAll();
      });
      group.append(b);
    });
    $("unit-picker").hidden = state.mode !== "concentration";
  }

  function init() {
    $("title").textContent = CONFIG.title;
    renderRangeButtons();
    renderModeControls();
    $("download").addEventListener("click", downloadCsv);
    $("cal-copy").addEventListener("click", copyCalibration);
    $("cal-reset").addEventListener("click", resetCalibration);

    const select = $("unit-select");
    Object.entries(UNITS).forEach(([key, unit]) => {
      const option = el("option", null, unit.label);
      option.value = key;
      select.append(option);
    });
    select.value = state.unitKey;
    select.addEventListener("change", () => {
      state.unitKey = select.value;
      store("smartstake-unit", select.value);
      renderAll();
    });

    let frame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => state.charts.forEach(renderChart));
    }).observe(document.querySelector(".wrap"));

    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, Math.max(15, CONFIG.refreshSeconds) * 1000);
  }

  init();
})();
