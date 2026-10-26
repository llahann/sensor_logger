// Smartstake live data page.
// Fetches rows from the Apps Script web app (see google_apps_script/Code.gs),
// or generates simulated rows in demo mode, and plots the average nitrate of
// the selected electrode pairs as one SVG line chart.
"use strict";

(() => {
  const CONFIG = Object.assign(
    { dataUrl: "", refreshSeconds: 20, title: "Smartstake live data" },
    window.SMARTSTAKE_CONFIG
  );
  const CAL_CONFIG = Object.assign({ analyte: "Nitrate", unit: "ppm N", pairs: {} }, CONFIG.calibration);

  const WINDOW_HOURS = 6;
  const MIN_SPAN_MS = 15 * 60 * 1000;      // x-axis width right after a reset
  const CYCLE_SECONDS = 20;                // approximate logger cycle, used to size requests
  const OFFLINE_AFTER_MS = 5 * 60 * 1000;  // no new row for this long = offline
  const PAIR_COLUMN = /^s(\d+)_re(\d+)_ise(\d+)$/;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const HOUR = 3600 * 1000;

  // Reset calibration: every pair reads AUTO_PPM_N ppm NO3-N at its latest
  // reading, with this slope.
  const AUTO_SLOPE = 60;      // mV/decade
  const AUTO_PPM_N = 20;

  // Concentration units, converted from mM
  const UNITS = {
    "ppm N": { label: "ppm NO₃⁻-N", factor: 14.007, decimals: 1 },
    "ppm NO3": { label: "ppm NO₃⁻", factor: 62.004, decimals: 1 },
    "mM": { label: "mM", factor: 1, decimals: 2 },
  };

  const params = new URLSearchParams(location.search);
  const DEMO = params.has("demo") || !CONFIG.dataUrl || CONFIG.dataUrl.includes("XXXXXXXX");
  const KEY = (name) => `smartstake-${name}${DEMO ? "-demo" : ""}`;

  const state = {
    unitKey: readStored("smartstake-unit", Object.keys(UNITS), UNITS[CAL_CONFIG.unit] ? CAL_CONFIG.unit : "ppm N"),
    cal: loadCalibration(),                        // { pairName: { e0, slope } } in mV
    excluded: new Set(readJson(KEY("excluded"), [])),
    resetAt: Number(readJson(KEY("reset"), 0)) || 0,
    data: null,      // full fetched table
    view: null,      // table sliced to the plotted window
    domain: null,    // [start, end] ms
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

  // Declarations (not const arrows) because state is initialized above with them
  function readStored(key, allowed, fallback) {
    try {
      const value = localStorage.getItem(key);
      if (allowed.includes(value)) return value;
    } catch (e) { /* storage unavailable */ }
    return fallback;
  }

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value === null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function store(key, value) {
    try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)); } catch (e) { /* ignore */ }
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

    const n = Math.ceil((hours * 3600 / CYCLE_SECONDS) * 1.3);
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
      names.forEach((name, j) => (values[name][i] = cleanValue(row[j + 1])));
    });
    return { names, times, values };
  }

  function cleanValue(raw) {
    if (raw === "" || raw === null || raw === undefined) return NaN;
    const v = Number(raw);
    return Number.isFinite(v) ? v : NaN;
  }

  function sliceFrom(data, start) {
    const i = lowerBound(data.times, start);
    const values = {};
    data.names.forEach((name) => (values[name] = data.values[name].subarray(i)));
    return { names: data.names, times: data.times.subarray(i), values };
  }

  // Simulated rows with the logger's column layout: nitrate on every pair,
  // slow uptake with dosing every 2 days, a small diurnal swing, slow electrode
  // drift and noise. Values are volts like the sheet.
  function makeDemoData(hours) {
    const stepMs = CYCLE_SECONDS * 1000;
    const end = Math.floor(Date.now() / stepMs) * stepMs;
    const count = Math.floor((hours * HOUR) / stepMs);
    const epoch = end - 7 * 24 * HOUR;
    const pairs = [];
    [1, 2].forEach((re, ri) => [1, 2, 3].forEach((ise, ii) => pairs.push({
      name: `s1_re${re}_ise${ise}`,
      e0: 210 + 22 * ii + 9 * ri,
      slope: -(54 + 2 * ii),              // mV/decade
      drift: (ii - 1) * 1.2 + 0.6 * ri,   // mV/day
      seed: 100 + re * 10 + ise,
    })));

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

      times[i] = t;
      values.vbat[i] = 3.82 + 0.22 * sun + 0.004 * noise(k, 3);

      const nitrate = 6 - 2.2 * dosePhase;   // mM
      pairs.forEach((p) => {
        const mv = p.e0 + p.slope * Math.log10(nitrate) + diurnal + p.drift * days + 0.35 * noise(k, p.seed);
        values[p.name][i] = mv / 1000;
      });
    }
    return { names, times, values };
  }

  // -------------------------------------------------------------------------
  // Calibration
  // -------------------------------------------------------------------------

  function toNumber(v) {
    return v === null || v === undefined || v === "" ? NaN : Number(v);
  }

  function isCalibrated(c) {
    return !!c && Number.isFinite(c.e0) && Number.isFinite(c.slope) && c.slope !== 0;
  }

  // config.js values, then this browser's edits and resets
  function loadCalibration() {
    const cal = {};
    const add = (pairs) => Object.entries(pairs || {}).forEach(([name, c]) => {
      cal[name] = { e0: toNumber(c && c.e0), slope: toNumber(c && c.slope) };
    });
    add(CAL_CONFIG.pairs);
    add(readJson(KEY("calibration"), {}));
    return cal;
  }

  const saveCalibration = () => store(KEY("calibration"), state.cal);

  // Sets E0 so the pair's latest reading maps to AUTO_PPM_N ppm NO3-N
  function autoCalibrate(data, names) {
    const mM = AUTO_PPM_N / UNITS["ppm N"].factor;
    names.forEach((name) => {
      const { value } = latestValue(data, name);
      if (!Number.isFinite(value)) return;
      state.cal[name] = { e0: +(value * 1000 - AUTO_SLOPE * Math.log10(mM)).toFixed(2), slope: AUTO_SLOPE };
    });
    saveCalibration();
    $("cal-table").querySelector("tbody").dataset.sig = "";   // reload the inputs
  }

  // Raw reading in volts -> concentration in the selected unit, NaN if uncalibrated
  function concentrationOf(name, volts) {
    const c = state.cal[name];
    if (!isCalibrated(c) || !Number.isFinite(volts)) return NaN;
    return 10 ** ((volts * 1000 - c.e0) / c.slope) * UNITS[state.unitKey].factor;
  }

  const pairNames = (names) => names.filter((n) => PAIR_COLUMN.test(n)).sort();
  const activePairs = (names) => pairNames(names).filter((n) => !state.excluded.has(n) && isCalibrated(state.cal[n]));

  function pairLabel(name, names) {
    const [stake, re, ise] = PAIR_COLUMN.exec(name).slice(1);
    const multiStake = new Set(pairNames(names).map((n) => PAIR_COLUMN.exec(n)[1])).size > 1;
    return `${multiStake ? `Stake ${stake} · ` : ""}RE ${re} · ISE ${ise}`;
  }

  // Mean concentration of the active pairs at every row
  function averageColumn(view) {
    const pairs = activePairs(view.names);
    const out = new Float64Array(view.times.length);
    for (let i = 0; i < out.length; i++) {
      let sum = 0, count = 0;
      pairs.forEach((name) => {
        const c = concentrationOf(name, view.values[name][i]);
        if (Number.isFinite(c)) { sum += c; count++; }
      });
      out[i] = count ? sum / count : NaN;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Line chart
  // -------------------------------------------------------------------------

  const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360].map((min) => min * 60000);

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

  function timeLabel(t) {
    return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
      "aria-label": `${spec.title}, line chart. Use arrow keys to read values.`,
    });
    const tooltip = el("div", "tooltip");
    tooltip.hidden = true;
    const empty = el("p", "empty");
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

    const height = 360;
    const m = { top: 10, right: 12, bottom: 26, left: 56 };
    const iw = Math.max(10, width - m.left - m.right);
    const ih = height - m.top - m.bottom;
    const [x0, x1] = domain;

    const idx = decimate(data.times.length, iw * 2);
    const t = idx.map((i) => data.times[i]);
    const ys = spec.series.map((s, k) => {
      const col = data.columns[k];
      return idx.map((i) => (col ? col[i] : NaN));
    });

    let lo = Infinity, hi = -Infinity;
    ys.forEach((arr) => arr.forEach((v) => {
      if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }));
    const hasData = Number.isFinite(lo);
    chart.empty.hidden = hasData;
    chart.empty.textContent = spec.emptyText;
    if (!hasData) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }

    const { ticks: yTicks, decimals: yDecimals } = niceTicks(lo, hi, Math.max(3, Math.floor(ih / 50)));
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

    const { ticks: xTicks } = timeTicks(x0, x1, Math.max(2, Math.floor(iw / 90)));
    xTicks.forEach((v) => {
      const label = svgEl("text", { class: "tick", x: sx(v), y: height - 6, "text-anchor": "middle" });
      label.textContent = timeLabel(v);
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
    // Mark the latest point, which is also the only one right after a reset
    ys.forEach((y, k) => {
      let i = y.length - 1;
      while (i >= 0 && !Number.isFinite(y[i])) i--;
      if (i >= 0) lines.append(svgEl("circle", { class: "dot", r: 4, cx: sx(t[i]), cy: sy(y[i]), style: `fill: var(--series-${spec.series[k].slot})` }));
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

  function lastTime(data) {
    return data && data.times.length ? data.times[data.times.length - 1] : NaN;
  }

  function renderStatus() {
    const status = $("status");
    const icon = $("status-icon");
    const text = $("status-text");
    const last = lastTime(state.data);

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

  function renderTiles(view, average) {
    const tiles = $("tiles");
    tiles.replaceChildren();
    const unit = UNITS[state.unitKey];
    const last = lastTime(state.data);

    const tile = (label, value, unitLabel, sub) => {
      const card = el("div", "card");
      const val = el("div", "tile-value", value);
      if (unitLabel) val.append(el("span", "tile-unit", unitLabel));
      card.append(el("div", "tile-label", label), val);
      if (sub) card.append(el("div", "tile-sub", sub));
      tiles.append(card);
    };

    const latest = average.length ? average[average.length - 1] : NaN;
    const n = activePairs(view.names).length;
    tile(CAL_CONFIG.analyte, Number.isFinite(latest) ? latest.toFixed(unit.decimals) : "—",
      Number.isFinite(latest) ? unit.label : "", `average of ${n} ${n === 1 ? "channel" : "channels"}`);
    tile("Last reading", Number.isFinite(last) ? ago(Date.now() - last) : "—", "",
      Number.isFinite(last) ? fullTime(last) : "No data yet");
    if (state.data.values.vbat) {
      const { value } = latestValue(state.data, "vbat");
      tile("Battery", Number.isFinite(value) ? value.toFixed(2) : "—", Number.isFinite(value) ? "V" : "");
    }
  }

  // Rows are rebuilt only when the set of pairs changes or after a reset, so
  // refreshes don't wipe a value being typed.
  function renderCalibration(data) {
    const body = $("cal-table").querySelector("tbody");
    const unit = UNITS[state.unitKey];
    const pairs = pairNames(data.names);

    $("cal-conc-head").textContent = `${CAL_CONFIG.analyte}, ${unit.label}`;

    const sig = pairs.join(",");
    if (body.dataset.sig !== sig) {
      body.dataset.sig = sig;
      body.replaceChildren();
      body.cells = {};
      pairs.forEach((name) => {
        const label = pairLabel(name, data.names);
        const tr = el("tr");

        const use = el("td");
        const box = el("input");
        box.type = "checkbox";
        box.checked = !state.excluded.has(name);
        box.setAttribute("aria-label", `Include ${label} in the average`);
        box.addEventListener("change", () => {
          if (box.checked) state.excluded.delete(name); else state.excluded.add(name);
          store(KEY("excluded"), [...state.excluded]);
          renderAll();
        });
        use.append(box);

        const inputs = [["e0", "E0, mV"], ["slope", "slope, mV per decade"]].map(([field, fieldName]) => {
          const td = el("td", "num");
          const input = el("input");
          input.type = "number";
          input.step = "any";
          input.inputMode = "decimal";
          input.setAttribute("aria-label", `${label} ${fieldName}`);
          const c = state.cal[name];
          if (c && Number.isFinite(c[field])) input.value = c[field];
          input.addEventListener("change", () => setCalibration(name, field, input.value));
          td.append(input);
          return td;
        });
        const mv = el("td", "num");
        const conc = el("td", "num");
        tr.append(use, el("td", null, label), ...inputs, mv, conc);
        body.append(tr);
        body.cells[name] = { mv, conc };
      });
    }

    pairs.forEach((name) => {
      const { value } = latestValue(data, name);
      const cells = body.cells[name];
      cells.mv.textContent = Number.isFinite(value) ? `${(value * 1000).toFixed(1)} mV` : "—";
      const c = concentrationOf(name, value);
      cells.conc.textContent = Number.isFinite(c) ? c.toFixed(unit.decimals) : "—";
    });
  }

  function setCalibration(name, field, raw) {
    state.cal[name] = Object.assign({ e0: NaN, slope: NaN }, state.cal[name], { [field]: toNumber(raw.trim()) });
    saveCalibration();
    renderAll();
  }

  // Clears the plot and recalibrates every pair to AUTO_PPM_N at its latest reading
  function resetPlot() {
    if (!state.data) return;
    const last = lastTime(state.data);
    state.resetAt = Number.isFinite(last) ? last : Date.now();
    store(KEY("reset"), state.resetAt);
    autoCalibrate(state.data, pairNames(state.data.names));
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
    a.download = `smartstake_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function renderAll() {
    renderStatus();
    if (!state.data) return;

    // Pairs never calibrated get the reset calibration from their latest reading
    const missing = pairNames(state.data.names).filter((n) => !isCalibrated(state.cal[n]));
    if (missing.length) autoCalibrate(state.data, missing);

    const now = Date.now();
    const start = Math.max(now - WINDOW_HOURS * HOUR, state.resetAt);
    state.domain = [start, Math.max(now, start + MIN_SPAN_MS)];
    state.view = sliceFrom(state.data, start);
    const average = averageColumn(state.view);
    const unit = UNITS[state.unitKey];
    const n = activePairs(state.view.names).length;

    renderTiles(state.view, average);
    renderCalibration(state.data);

    state.charts = syncCharts($("charts"), [{
      id: "average",
      title: `Average ${CAL_CONFIG.analyte.toLowerCase()}`,
      subtitle: `${unit.label} · ${n} ${n === 1 ? "channel" : "channels"}`,
      unit: unit.label,
      decimals: unit.decimals,
      emptyText: n ? "Waiting for readings" : "No channels selected",
      series: [{ key: "average", label: "Average", slot: 1 }],
    }]);
    state.charts.forEach((chart) => {
      chart.data = { times: state.view.times, columns: [average] };
      chart.domain = state.domain;
      renderChart(chart);
    });
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    document.body.classList.add("is-loading");
    try {
      state.data = await fetchData(WINDOW_HOURS);
      state.error = null;
    } catch (err) {
      state.error = err;
    }
    state.loading = false;
    document.body.classList.remove("is-loading");
    renderAll();
  }

  function init() {
    $("title").textContent = CONFIG.title;
    $("reset").addEventListener("click", resetPlot);
    $("download").addEventListener("click", downloadCsv);

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
    setInterval(() => { if (!document.hidden) refresh(); }, Math.max(10, CONFIG.refreshSeconds) * 1000);
  }

  init();
})();
