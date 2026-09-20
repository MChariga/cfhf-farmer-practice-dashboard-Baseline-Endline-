// ============================================================================
// app.js - Farmer Practice Adoption Dashboard
// Reads DASHBOARD_DATA (from dashboard_data.js) and renders an Overview tab
// plus one filterable tab per day.
// ============================================================================

const DOWNLOAD_PASSWORD = "Kenya_AE_Hub@2026";

const STATE = {
  activeTab: "background",
  filters: {}, // keyed by day number -> {organization, county, farmerSearch, practice, baselineStatus, endlineStatus}
  sort: {},    // keyed by day number -> {col, dir}
  charts: {},  // keyed by canvas id -> Chart.js instance, so we can destroy before redraw
  selectedReason: {}, // keyed by day number -> the reasonCategory currently drilled into on the treemap, or null
  namesUnlocked: false, // whether farmer names are shown in the clear or blurred; resets on page reload
  notFoundTableOpen: {}, // keyed by day number -> whether the Farmers Not Found detail table is expanded
  transitionFlowOpen: {}, // keyed by day number -> whether the Transition Category Breakdown's flow-diagram view is revealed
  openMultiSelect: null, // which multi-select filter dropdown (if any) is currently open, e.g. "organization"
  chartFocus: {}, // keyed by canvas id -> the category index currently focused (others dimmed), or null/undefined
};

const COLORS = {
  green: "#3F7D4B",
  greenSoft: "#E4EFE1",
  rust: "#A64B2A",
  rustSoft: "#F5E4DC",
  ochre: "#C98A2B",
  ochreSoft: "#F6E9D2",
  navy: "#2E3B52",
  ink: "#1E2A1F",
  inkMuted: "#5B6B5C",
  line: "#DAD6C2",
  // "Not doing" fills for the tenure comparison chart: New and Old each get
  // their own muted tone (a desaturated tint of that group's "doing" color)
  // so a New-not-doing segment and an Old-not-doing segment never look the
  // same, while still reading as visibly "less saturated" than "doing".
  notDoingNew: "#B7C9AE",
  notDoingOld: "#DDBFA0",
};

function defaultFilters() {
  return {
    organization: ["All"],
    county: ["All"],
    farmerSearch: "",
    practice: ["All"],
    tenure: ["All"],
    baselineStatus: ["All"],
    endlineStatus: ["All"],
  };
}

// Multi-select filters store an array of chosen values, or ["All"] for no
// filtering. "All" and specific values are mutually exclusive in the array
// by construction (see toggleMultiSelectValue) - this just tests either
// form against one record's value for that field.
function matchesMulti(selected, value) {
  return selected.includes("All") || selected.includes(value);
}

// Same idea for the baseline/endline status filters, whose options are
// "Doing"/"Not doing" rather than arbitrary category values.
function matchesStatusMulti(selected, val01) {
  if (selected.includes("All")) return true;
  return (val01 === 1 && selected.includes("Doing")) || (val01 === 0 && selected.includes("Not doing"));
}

// `options` can be a flat array of strings (value === label, used for
// Organization/County/Tenure/status) or an array of [value, label] pairs
// (used for Practice, where the stored value is the question code but the
// display should be the short label).
function optValue(o) { return Array.isArray(o) ? o[0] : o; }
function optLabel(o) { return Array.isArray(o) ? o[1] : o; }

function multiSelectSummary(selected, options) {
  if (selected.includes("All")) return "All";
  const labelFor = (v) => {
    const match = options && options.find((o) => optValue(o) === v);
    return match ? optLabel(match) : v;
  };
  if (selected.length <= 2) return selected.map(labelFor).join(", ");
  return `${selected.length} selected`;
}

// Toggles one value in/out of a multi-select filter array, keeping "All"
// and specific values mutually exclusive: picking "All" clears everything
// else; picking a specific value drops "All"; emptying the array (every
// specific value unchecked) or ending up with every option checked both
// collapse back to ["All"] so the state never gets stuck or redundant.
function toggleMultiSelectValue(f, key, value, allOptions) {
  let sel = f[key];
  if (value === "All") {
    sel = ["All"];
  } else {
    sel = sel.filter((v) => v !== "All");
    sel = sel.includes(value) ? sel.filter((v) => v !== value) : [...sel, value];
    if (sel.length === 0 || sel.length === allOptions.length) sel = ["All"];
  }
  f[key] = sel;
}

// Renders one toolbar field as a checkbox dropdown instead of a native
// <select>, so more than one value can be picked at once (e.g. Organization
// = KALRO + DIG together, or several practices side by side). `disabled`
// mirrors the old baseline/endline status selects only making sense once a
// single practice is chosen.
function multiSelectFieldHTML(day, key, label, options, selected, disabled = false) {
  const fieldId = `ms-${key}-${day}`;
  const isOpen = STATE.openMultiSelect === fieldId && !disabled;
  return `
    <div class="field multiselect${disabled ? " is-disabled" : ""}">
      <label>${label}</label>
      <button type="button" class="multiselect-trigger" id="${fieldId}-btn" ${disabled ? "disabled" : ""}>
        <span>${multiSelectSummary(selected, options)}</span><span class="ms-caret">&#9662;</span>
      </button>
      <div class="multiselect-panel" id="${fieldId}-panel" ${isOpen ? "" : "hidden"}>
        <label class="multiselect-option"><input type="checkbox" data-value="All" ${selected.includes("All") ? "checked" : ""}> All</label>
        ${options.map((o) => `<label class="multiselect-option"><input type="checkbox" data-value="${optValue(o)}" ${selected.includes(optValue(o)) ? "checked" : ""}> ${optLabel(o)}</label>`).join("")}
      </div>
    </div>
  `;
}

function wireMultiSelectField(container, day, key, options, f, onChange) {
  const fieldId = `ms-${key}-${day}`;
  const btn = container.querySelector(`#${fieldId}-btn`);
  const panel = container.querySelector(`#${fieldId}-panel`);
  if (!btn || !panel) return;
  const allValues = options.map(optValue);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    STATE.openMultiSelect = STATE.openMultiSelect === fieldId ? null : fieldId;
    onChange();
  });
  panel.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      toggleMultiSelectValue(f, key, e.target.getAttribute("data-value"), allValues);
      onChange();
    });
  });
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
function recordsForDay(day) {
  return DASHBOARD_DATA.records.filter((r) => r.day === day);
}

function dayMeta(day) {
  return DASHBOARD_DATA.days.find((d) => d.day === day);
}

function farmerKey(r) {
  return `${r.farmerName}|${r.organization}|${r.county}`;
}

function uniqueFarmerCount(records) {
  return new Set(records.map(farmerKey)).size;
}

function distinctSorted(records, field) {
  return Array.from(new Set(records.map((r) => r[field]).filter(Boolean))).sort();
}

// --- Farmer identity list (every farmer who appears in this day's raw
// sheet at all, baseline and/or endline - not just the ones with complete
// data used in the adoption charts). This is what lets the organization/
// county/name/tenure filters apply correctly to every KPI card, including
// "not found at endline", instead of only to farmers who made it into the
// per-question `records`. ---
function farmersForDay(day) {
  const meta = dayMeta(day);
  return (meta && meta.farmers) || [];
}

function applyIdentityFilters(farmers, f) {
  return farmers.filter((p) => {
    if (!matchesMulti(f.organization, p.organization)) return false;
    if (!matchesMulti(f.county, p.county)) return false;
    if (f.farmerSearch && !p.farmerName.toLowerCase().includes(f.farmerSearch.toLowerCase())) return false;
    if (!matchesMulti(f.tenure, p.tenure)) return false;
    return true;
  });
}

function distinctQuestions(records) {
  const map = new Map();
  records.forEach((r) => {
    if (!map.has(r.question)) map.set(r.question, r.shortLabel);
  });
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}

function applyFilters(records, f) {
  return records.filter((r) => {
    if (!matchesMulti(f.organization, r.organization)) return false;
    if (!matchesMulti(f.county, r.county)) return false;
    if (f.farmerSearch && !r.farmerName.toLowerCase().includes(f.farmerSearch.toLowerCase())) return false;
    if (!matchesMulti(f.practice, r.question)) return false;
    if (!matchesMulti(f.tenure, r.tenure)) return false;
    if (!matchesStatusMulti(f.baselineStatus, r.baseline)) return false;
    if (!matchesStatusMulti(f.endlineStatus, r.endline)) return false;
    return true;
  });
}

function pct(n, d) {
  return d === 0 ? 0 : (n / d) * 100;
}

// Aggregate baseline/endline % per question from a (possibly org/county/name
// filtered, but NOT baseline/endline-status filtered) record set.
function summarizeByPractice(records) {
  const byQ = new Map();
  records.forEach((r) => {
    if (!byQ.has(r.question)) byQ.set(r.question, { label: r.shortLabel, base: [], end: [], started: 0 });
    const bucket = byQ.get(r.question);
    bucket.base.push(r.baseline);
    bucket.end.push(r.endline);
    if (r.baseline === 0 && r.endline === 1) bucket.started++;
  });
  const out = [];
  byQ.forEach((v, q) => {
    const baseCount = v.base.reduce((a, b) => a + b, 0);
    const endCount = v.end.reduce((a, b) => a + b, 0);
    const n = v.base.length;
    const baseAvg = pct(baseCount, n);
    const endAvg = pct(endCount, n);
    // started = newly adopted (baseline 0 -> endline 1); endCount is always
    // started + continued-doing, so it doubles as "overall uptake" (doing
    // at endline, whether they continued or just started) for the lollipop
    // section further down.
    out.push({ question: q, label: v.label, baseCount, endCount, basePct: baseAvg, endPct: endAvg, change: endAvg - baseAvg, n, started: v.started });
  });
  out.sort((a, b) => b.change - a.change);
  return out;
}

// Box size = unique farmers who gave that reason for not doing at least one
// practice - a farmer citing the same reason across several practices only
// counts once, so a single reason's count can never exceed the number of
// farmers. (A farmer who gives *different* reasons for different practices
// can still show up in more than one reason's count - see the panel note.)
function reasonCounts(records) {
  const notDoing = records.filter((r) => r.endline === 0 && r.reasonCategory);
  const farmersByReason = new Map();
  notDoing.forEach((r) => {
    if (!farmersByReason.has(r.reasonCategory)) farmersByReason.set(r.reasonCategory, new Set());
    farmersByReason.get(r.reasonCategory).add(farmerKey(r));
  });
  return Array.from(farmersByReason.entries())
    .map(([reason, farmerSet]) => ({ reason, n: farmerSet.size }))
    .sort((a, b) => b.n - a.n);
}

function csvEscape(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCSV(rows, columns, filename) {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const lines = rows.map((r) => columns.map((c) => csvEscape(c.get(r))).join(","));
  const csv = [header, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Same access password as the CSV exports and the Overview tab's bulk
// downloads. Wrap a farmer name with this wherever a table renders one -
// it prints blurred until the person unlocks names for this session (the
// header control at the top right of the page).
function farmerNameCell(name) {
  return `<span class="${STATE.namesUnlocked ? "" : "name-blurred"}">${name}</span>`;
}

function renderNameLockControl() {
  const el = document.getElementById("nameLockControl");
  if (!el) return;
  el.innerHTML = STATE.namesUnlocked
    ? `<span>&#128275; Farmer names visible</span><button class="btn" id="lock-names-btn">Hide names</button>`
    : `<span>&#128274; Farmer names hidden</span><button class="btn" id="unlock-names-btn">Unlock</button>`;

  if (STATE.namesUnlocked) {
    el.querySelector("#lock-names-btn").addEventListener("click", () => {
      STATE.namesUnlocked = false;
      renderNameLockControl();
      renderMain();
    });
  } else {
    el.querySelector("#unlock-names-btn").addEventListener("click", () => {
      const entered = window.prompt("Enter the access password to view farmer names:");
      if (entered === null) return;
      if (entered !== DOWNLOAD_PASSWORD) {
        alert("Incorrect password.");
        return;
      }
      STATE.namesUnlocked = true;
      renderNameLockControl();
      renderMain();
    });
  }
}

// Same access password as the CSV exports above. Clicking Export prompts
// for the password before the CSV is generated; a blank/incorrect entry
// cancels.
function passwordGatedDownload(rows, columns, filename) {
  const entered = window.prompt("Enter the access password to export this farmer list:");
  if (entered === null) return;
  if (entered !== DOWNLOAD_PASSWORD) {
    alert("Incorrect password. Export cancelled.");
    return;
  }
  downloadCSV(rows, columns, filename);
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function farmerSummaryRows() {
  const map = new Map();
  DASHBOARD_DATA.records.forEach((r) => {
    const key = farmerKey(r);
    if (!map.has(key)) {
      map.set(key, {
        farmerName: r.farmerName, organization: r.organization, county: r.county,
        tenure: r.tenure, days: new Set(),
      });
    }
    map.get(key).days.add(r.day);
  });
  return Array.from(map.values()).map((v) => ({ ...v, days: Array.from(v.days).sort((a, b) => a - b).join("; ") }));
}

function destroyChart(id) {
  if (STATE.charts[id]) {
    STATE.charts[id].destroy();
    delete STATE.charts[id];
  }
}

// Turns a "#RRGGBB" color into "rgba(r,g,b,alpha)" - used to dim
// non-focused bars on click without needing a second, pre-computed muted
// color for every series.
function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.length === 3 ? h[0] + h[0] : h.substring(0, 2), 16);
  const g = parseInt(h.length === 3 ? h[1] + h[1] : h.substring(2, 4), 16);
  const b = parseInt(h.length === 3 ? h[2] + h[2] : h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Same idea, but tolerant of a color already given as rgb()/rgba() (as the
// dumbbell chart's per-bar colors are) rather than assuming "#RRGGBB".
function dimColor(color, alpha) {
  if (color.startsWith("#")) return hexToRgba(color, alpha);
  if (color.startsWith("rgba(")) return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, (m, r, g, b) => `rgba(${r.trim()},${g.trim()},${b.trim()},${alpha})`);
  if (color.startsWith("rgb(")) return color.replace("rgb(", "rgba(").replace(")", `,${alpha})`);
  return color;
}

// Click-to-focus for bar charts: clicking any bar in a given category
// brings that category to full color and dims every other category to
// ~15% opacity across every dataset, so a crowded chart can be read one
// category at a time. Clicking the same category again (or the empty area)
// clears the focus. Persisted per canvasId in STATE.chartFocus so the
// highlight survives the chart being torn down and rebuilt on every
// renderMain().
function applyBarFocus(chart, canvasId) {
  const focusIdx = STATE.chartFocus[canvasId];
  chart.data.datasets.forEach((ds) => {
    if (!ds._baseColors) {
      ds._baseColors = Array.isArray(ds.backgroundColor) ? [...ds.backgroundColor] : ds.data.map(() => ds.backgroundColor);
    }
    ds.backgroundColor = ds._baseColors.map((c, i) => {
      if (focusIdx === null || focusIdx === undefined) return c;
      return i === focusIdx ? c : dimColor(c, 0.15);
    });
    if (ds.borderColor && Array.isArray(ds.borderColor)) {
      if (!ds._baseBorderColors) ds._baseBorderColors = [...ds.borderColor];
      ds.borderColor = ds._baseBorderColors.map((c, i) => {
        if (focusIdx === null || focusIdx === undefined) return c;
        return i === focusIdx ? c : dimColor(c, 0.2);
      });
    }
  });
  chart.update();
}

function wireBarFocusClick(chart, canvasId) {
  chart.options.onClick = (evt, elements) => {
    const clicked = elements.length ? elements[0].index : null;
    const current = STATE.chartFocus[canvasId];
    STATE.chartFocus[canvasId] = (clicked === null || current === clicked) ? null : clicked;
    applyBarFocus(chart, canvasId);
  };
  applyBarFocus(chart, canvasId);
}

// Adds a small "Download" button into a panel's header row (next to the
// <h2>) and wires it to export a Chart.js canvas as a PNG.
function addChartDownloadButton(panel, canvasId, filename) {
  const h2 = panel.querySelector("h2");
  if (!h2) return;
  const header = document.createElement("div");
  header.className = "panel-header";
  const btn = document.createElement("button");
  btn.className = "btn dl-btn";
  btn.textContent = "Download";
  btn.addEventListener("click", () => {
    const chart = STATE.charts[canvasId];
    if (!chart) return;
    const a = document.createElement("a");
    a.href = chart.toBase64Image("image/png", 1);
    a.download = filename;
    a.click();
  });
  h2.replaceWith(header);
  header.appendChild(h2);
  header.appendChild(btn);
}

// Same idea for a raw SVG element (the alluvial and the treemap aren't
// Chart.js canvases) - downloads the given SVG markup as a .svg file.
function addSVGDownloadButton(panel, getSvgString, filename) {
  const h2 = panel.querySelector("h2");
  if (!h2) return;
  const header = document.createElement("div");
  header.className = "panel-header";
  const btn = document.createElement("button");
  btn.className = "btn dl-btn";
  btn.textContent = "Download";
  btn.addEventListener("click", () => {
    const svgString = getSvgString();
    if (!svgString) return;
    const blob = new Blob([svgString], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });
  h2.replaceWith(header);
  header.appendChild(h2);
  header.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function renderTabs() {
  const nav = document.getElementById("tabNav");
  nav.innerHTML = "";
  const tabs = [{ id: "background", label: "Project Background" }, { id: "overview", label: "Overview" }, ...DASHBOARD_DATA.days.map((d) => ({ id: `day${d.day}`, label: d.title }))];
  tabs.forEach((t) => {
    const btn = document.createElement("button");
    btn.textContent = t.label;
    btn.className = t.id === STATE.activeTab ? "active" : "";
    btn.addEventListener("click", () => {
      STATE.activeTab = t.id;
      renderTabs();
      renderMain();
    });
    nav.appendChild(btn);
  });
}

function renderMain() {
  const main = document.getElementById("mainContent");
  main.innerHTML = "";
  if (STATE.activeTab === "background") {
    main.appendChild(buildBackgroundView());
  } else if (STATE.activeTab === "overview") {
    main.appendChild(buildOverviewView());
  } else {
    const day = parseInt(STATE.activeTab.replace("day", ""), 10);
    main.appendChild(buildDayView(day));
  }
}

// ---------------------------------------------------------------------------
// Project Background tab
// ---------------------------------------------------------------------------
function buildBackgroundView() {
  const wrap = document.createElement("section");
  wrap.className = "view active";

  const dust = [
    bgDust(6, 55, 0),   bgDust(14, 65, 2.2), bgDust(22, 50, 4.1),
    bgDust(30, 70, 1.1), bgDust(10, 60, 3.4), bgDust(26, 46, 0.7),
  ].join("");

  const rain = [
    bgRain(48, 0),   bgRain(58, 0.6), bgRain(68, 1.3),
    bgRain(52, 0.3), bgRain(62, 1.0), bgRain(72, 1.8),
  ].join("");

  wrap.innerHTML = `
    <div class="bg-hero">
      <div class="bg-hero-scene" aria-hidden="true">
        ${rain}
        ${dust}
      </div>
      <div class="bg-hero-content">
        <div class="eyebrow">Kenya Agroecology Hub &middot; CFHF Project Evaluation</div>
        <h1>Improving Farmer Training on AE Practices Through Collaboration and Follow-up</h1>
        <p class="lead">
          An endline evaluation of what farmers actually put into practice after Manor House
          Agricultural Centre's one-week agroecology trainings and an honest look  at
          what got in the way when they didn't.
        </p>
        <div class="cta-row">
          <button class="btn primary" id="bgGoOverview">Explore the Dashboard &rarr;</button>
          <button class="btn ghost" id="bgGoDay1">Jump to Day 1: Soil Health</button>
        </div>
      </div>
    </div>

    
    <div class="bg-section-grid">
      <div class="panel bg-body">
        <h2>Programme Context</h2>
        <div class="panel-sub">Why this evaluation exists</div>
        <p>
          The Kenya Agroecology Hub, anchored at Manor House Agricultural Centre (MHAC),
          received funding from the Conservation, Food and Health Foundation (CFHF) to
          implement <em>"Improving Farmer Training on AE Practices Through Collaboration
          and Follow-up."</em>
        </p>
        <p>
          The project aimed to improve the impact of the one-week agroecology (AE) training
          for farmers through joint assessment of the AE concepts and practices farmers were
          putting into practice on their farms after training and those they were not.
        </p>
        <p>
          It was implemented with ten partner organizations across nine counties, covering
          42 sub-counties and involving 215 farmers from the western part of the country.
          Workshops ran in five cohorts of roughly 40 farmers each, five from every partner
          organization, who were then expected to form their own farmer groups to sustain
          learning and sharing after the workshop.
        </p>
        <p>
          A baseline assessment during each workshop captured where farmers already stood
          on AE practices. Farmers were then given one and a half seasons to put what they
          learned into practice, before a joint endline follow-up was carried out by partner
          organization staff together with MHAC staff.
        </p>
      </div>

      <div class="panel bg-body">
        <h2>Evaluation Purpose &amp; Objectives</h2>
        <div class="panel-sub">What we set out to learn</div>
        <p>
          The purpose of this endline evaluation was to reveal which new AE concepts and
          practices farmers were implementing or not embracing after MHAC's
          one-week workshop, and to explore, qualitatively, the barriers behind non-adoption.
        </p>
        <p>
          MHAC has long relied on internal learning systems such as end-of-workshop surveys
          and informal daily reflections. This assessment tested whether there is a
          disconnect between MHAC's assumptions about what is working and the actual
          situation on farmers' farms.
        </p>
        <div class="quote-block">
          Is low adoption a communication gap on the trainers' side, a mismatch between
          what MHAC assumed was relevant, or a mismatch with what farmers themselves saw
          as relevant and achievable in their own context?
        </div>
        <p>
          Answering that question is what every chart in this dashboard is ultimately
          built to inform.
        </p>
      </div>
    </div>

    <div class="panel">
      <h2>Methodology</h2>
      <div class="panel-sub">How the baseline and endline data behind this dashboard were collected</div>
      <div class="process-steps">
        ${bgStep("1", "Structured, practice-by-practice questionnaire", "Built around the practices taught in the one-week workshop, with a simple yes/no for whether a farmer was doing each one, adapted to also capture in-depth reasons behind every \u201cno.\u201d")}
        ${bgStep("2", "Full census, not a fixed sample", "Every farmer who attended was targeted for assessment, rather than working from a pre-set sample size, since some farmers were expected to be unavailable during the visit window.")}
        ${bgStep("3", "Piloted before rollout", "The data tool was piloted with 20 farmers in Trans Nzoia County, and revised based on what that pilot surfaced.")}
        ${bgStep("4", "Two-phase farm visits", "Farmers first walked the evaluation team through their farm to show what had been implemented since training, then sat down for the structured questionnaire, including reasons for practices not seen.")}
        ${bgStep("5", "Joint MHAC &amp; partner teams", "Two evaluation teams, each pairing MHAC staff with personnel from the local partner organization that had supported entry to farmers, carried out the visits and met daily to reflect and share learning.")}
      </div>
    </div>

    <div class="limitation-box">
      <h2>Limitations of the Evaluation</h2>
      <p>
        The tool captured rich qualitative depth on what farmers were and were not
        implementing, but it cannot show the extent to which a farmer is implementing a
        given practice.
      </p>
      <p>
        Visit timing also did not always align with the prime period for farmers to have
        something to show: many had already harvested short-maturity crops, or their farms
        had been disrupted by weather. Some practices farmers reported doing therefore had
        no visible evidence on the day, and the evaluation team relied on farmers'
        good faith in those cases.
      </p>
    </div>
  `;

  wrap.querySelector("#bgGoOverview").addEventListener("click", () => {
    STATE.activeTab = "overview";
    renderTabs();
    renderMain();
  });
  wrap.querySelector("#bgGoDay1").addEventListener("click", () => {
    STATE.activeTab = "day1";
    renderTabs();
    renderMain();
  });

  return wrap;
}

function bgStat(n, label) {
  return `<div class="bg-stat-card"><div class="n">${n}</div><div class="l">${label}</div></div>`;
}

function bgStep(num, title, body) {
  return `
    <div class="process-step">
      <div class="step-num">${num}</div>
      <div class="step-text">
        <h4>${title}</h4>
        <p>${body}</p>
      </div>
    </div>
  `;
}

// Decorative animated overlay for the hero banner (see .bg-hero-scene CSS):
// a few drifting dust/pollen specks and light rain streaks over the photo,
// confined to the right side so the text on the left stays clean and readable.
function bgDust(top, right, delay) {
  return `<span class="bg-dust" style="top:${top}%; right:${right}%; animation-delay:${delay}s;"></span>`;
}

function bgRain(right, delay) {
  return `<span class="bg-rain" style="right:${right}%; animation-delay:${delay}s;"></span>`;
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------
// One row per partner organization, aggregated across all 5 training days -
// complements the existing per-day summary without replacing it.
// "Surveyed at both" dedupes by Farmer_ID and uses the same "found at
// endline on any day" definition as the overall/day-level KPI cards, not a
// per-day retention rate.
// ---------------------------------------------------------------------------
function computeOrgSummary() {
  const identity = {};
  function ensureIdentity(org) {
    if (!identity[org]) identity[org] = { baselineIds: new Set(), bothIds: new Set(), counties: new Set() };
    return identity[org];
  }
  DASHBOARD_DATA.days.forEach((day) => {
    day.farmers.forEach((p) => {
      const bucket = ensureIdentity(p.organization);
      bucket.counties.add(p.county);
      if (p.atBaseline) {
        bucket.baselineIds.add(p.farmerId);
        if (p.foundAtEndlineAnyDay) bucket.bothIds.add(p.farmerId);
      }
    });
  });

  const reasonByOrg = {};
  DASHBOARD_DATA.records.forEach((r) => {
    if (r.endline === 0 && r.reasonCategory) {
      if (!reasonByOrg[r.organization]) reasonByOrg[r.organization] = {};
      reasonByOrg[r.organization][r.reasonCategory] = (reasonByOrg[r.organization][r.reasonCategory] || 0) + 1;
    }
  });

  return Object.keys(identity)
    .sort((a, b) => identity[b].baselineIds.size - identity[a].baselineIds.size)
    .map((org) => {
      const d = identity[org];
      const baseline = d.baselineIds.size;
      const both = d.bothIds.size;
      const reasons = reasonByOrg[org] || {};
      const topReasonEntry = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
      return {
        organization: org,
        baseline,
        both,
        bothPct: baseline ? (100 * both / baseline) : 0,
        notFound: baseline - both,
        topReason: topReasonEntry ? topReasonEntry[0] : "-",
        topReasonCount: topReasonEntry ? topReasonEntry[1] : 0,
        counties: Array.from(d.counties).sort(),
      };
    });
}

function buildOverviewView() {
  const wrap = document.createElement("section");
  wrap.className = "view active";

  const overall = DASHBOARD_DATA.overall || {};
  const allOrgs = distinctSorted(DASHBOARD_DATA.records, "organization");
  const allCounties = distinctSorted(DASHBOARD_DATA.records, "county");

  const kpis = document.createElement("div");
  kpis.className = "kpi-row";
  kpis.innerHTML = `
    ${kpiCard("Training Days Covered", DASHBOARD_DATA.days.length, "Day 1 - Day 5", "navy")}
    ${kpiCard("Total Number of Farmers Trained", overall.nUniqueFarmersTotal, "Attended at least one workshop day", "green")}
    ${kpiCard("Found at Endline", overall.nUniqueFoundEndlineAny, "Number reached during follow-up", "green")}
    ${kpiCard("Never Found at Endline", overall.nUniqueNotFoundEndlineAny, "Number not reached during follow-up", "rust")}
    ${kpiCard("Organizations", allOrgs.length, allOrgs.slice(0, 3).join(", ") + (allOrgs.length > 3 ? "..." : ""), "ochre")}
    ${kpiCard("Counties", allCounties.length, allCounties.slice(0, 3).join(", ") + (allCounties.length > 3 ? "..." : ""), "ochre")}
  `;
  wrap.appendChild(kpis);

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <h2>Per-Day Summary</h2>
    <div class="panel-sub">Baseline / endline survey counts and the matched sample used in every adoption chart.</div>
    <div class="day-summary-grid" id="daySummaryGrid"></div>
  `;
  wrap.appendChild(panel);

  const grid = panel.querySelector("#daySummaryGrid");
  DASHBOARD_DATA.days.forEach((d) => {
    const card = document.createElement("div");
    card.className = "day-summary-card";
    card.innerHTML = `
      <h3>${d.title}</h3>
      <dl>
        <dt>Baseline surveyed</dt><dd>${d.nBaselineSurveyed}</dd>
        <dt>Endline surveyed</dt><dd>${d.nEndlineSurveyed}</dd>
        <dt>Not found at endline</dt><dd>${d.nNotFoundEndline}</dd>
        <dt>Used in adoption charts</dt><dd>${d.nMatched}</dd>
        <dt>Practices tracked</dt><dd>${d.questions.length}</dd>
      </dl>
    `;
    grid.appendChild(card);
  });

  const chartPanel = document.createElement("div");
  chartPanel.className = "panel";
  chartPanel.innerHTML = `
    <h2>Matched Sample Size by Day</h2>
    <div class="panel-sub">Farmers with complete baseline and endline data, used in every adoption-rate chart for that day.</div>
    <div class="chart-wrap" style="height:280px;"><canvas id="overviewSampleChart"></canvas></div>
  `;
  wrap.appendChild(chartPanel);

  setTimeout(() => renderOverviewSampleChart(), 0);

  wrap.appendChild(buildOrgSummaryPanel());
  wrap.appendChild(buildDownloadPanel());
  return wrap;
}

// ---------------------------------------------------------------------------
// Organization Summary (Overview tab) - complements the per-day summary
// above with a single cross-day view per partner organization.
// ---------------------------------------------------------------------------
function buildOrgSummaryPanel() {
  const panel = document.createElement("div");
  panel.className = "panel";
  const orgSummary = computeOrgSummary();
  panel.innerHTML = `
    <h2>Organization Summary</h2>
    <div class="panel-sub">One row per partner organization, aggregated across all 5 training days. "Surveyed at both" is a farmer found at baseline and at endline (on any day), deduped by Farmer_ID.</div>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          <th>Organization</th><th>Baseline Surveyed</th><th>Surveyed at Both</th><th>Not Found at Endline</th><th>Top Reason for Non-Adoption</th><th>Counties</th>
        </tr></thead>
        <tbody>
          ${orgSummary.map((o) => `
            <tr>
              <td>${o.organization}</td>
              <td>${o.baseline}</td>
              <td>${o.both} (${o.bothPct.toFixed(1)}%)</td>
              <td>${o.notFound}</td>
              <td>${o.topReason}${o.topReasonCount ? ` (${o.topReasonCount})` : ""}</td>
              <td>${o.counties.join(", ")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="table-footer">
      <span>${orgSummary.length} organization(s)</span>
      <button class="btn" id="export-org-summary">Export (CSV)</button>
    </div>
  `;
  panel.querySelector("#export-org-summary").addEventListener("click", () => {
    downloadCSV(orgSummary, [
      { label: "Organization", get: (o) => o.organization },
      { label: "Baseline Surveyed", get: (o) => o.baseline },
      { label: "Surveyed at Both Baseline and Endline", get: (o) => o.both },
      { label: "Surveyed at Both (%)", get: (o) => o.bothPct.toFixed(1) },
      { label: "Not Found at Endline", get: (o) => o.notFound },
      { label: "Uptake Rate (%)", get: (o) => o.uptakeRate.toFixed(1) },
      { label: "Top Reason for Non-Adoption", get: (o) => o.topReason },
      { label: "Counties", get: (o) => o.counties.join("; ") },
    ], "organization_summary.csv");
  });
  return panel;
}

// ---------------------------------------------------------------------------
// Password-gated dataset downloads (Overview tab)
// ---------------------------------------------------------------------------
function buildDownloadPanel() {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <h2>Download Data</h2>
    <div class="panel-sub">Enter the access password to download the full datasets behind this dashboard.</div>
    <div class="toolbar" style="margin-bottom:0;">
      <div class="field">
        <label for="download-password">Password</label>
        <input id="download-password" type="password" placeholder="Enter password">
      </div>
      <button class="btn primary" id="unlock-download">Unlock</button>
    </div>
    <div id="download-error" style="color:var(--rust); font-size:12.5px; margin-top:8px; display:none;">Incorrect password.</div>
    <div id="download-buttons" style="margin-top:14px; flex-wrap:wrap; gap:10px; display:none;"></div>
  `;

  setTimeout(() => {
    const input = panel.querySelector("#download-password");
    const err = panel.querySelector("#download-error");
    const btnsWrap = panel.querySelector("#download-buttons");

    const unlock = () => {
      if (input.value !== DOWNLOAD_PASSWORD) {
        err.style.display = "block";
        return;
      }
      err.style.display = "none";
      btnsWrap.style.display = "flex";
      btnsWrap.innerHTML = `
        <button class="btn" id="dl-all-records">All farmer-practice records (CSV)</button>
        <button class="btn" id="dl-farmer-summary">Farmer summary - one row per farmer (CSV)</button>
        ${DASHBOARD_DATA.days.map((d) => `<button class="btn" id="dl-day-${d.day}">${d.title} (CSV)</button>`).join("")}
        <button class="btn" id="dl-json">Full dataset (JSON)</button>
      `;

      btnsWrap.querySelector("#dl-all-records").addEventListener("click", () => {
        downloadCSV(DASHBOARD_DATA.records, [
          { label: "Day", get: (r) => r.day },
          { label: "Question", get: (r) => r.question },
          { label: "Practice", get: (r) => r.shortLabel },
          { label: "Farmer", get: (r) => r.farmerName },
          { label: "Organization", get: (r) => r.organization },
          { label: "County", get: (r) => r.county },
          { label: "Tenure", get: (r) => r.tenure },
          { label: "Baseline", get: (r) => (r.baseline === 1 ? "Doing" : "Not doing") },
          { label: "Endline", get: (r) => (r.endline === 1 ? "Doing" : "Not doing") },
          { label: "Reason", get: (r) => r.reasonCategory || "" },
        ], "all_records.csv");
      });

      btnsWrap.querySelector("#dl-farmer-summary").addEventListener("click", () => {
        downloadCSV(farmerSummaryRows(), [
          { label: "Farmer", get: (r) => r.farmerName },
          { label: "Organization", get: (r) => r.organization },
          { label: "County", get: (r) => r.county },
          { label: "Tenure", get: (r) => r.tenure },
          { label: "Days Participated", get: (r) => r.days },
        ], "farmer_summary.csv");
      });

      DASHBOARD_DATA.days.forEach((d) => {
        btnsWrap.querySelector(`#dl-day-${d.day}`).addEventListener("click", () => {
          downloadCSV(recordsForDay(d.day), [
            { label: "Question", get: (r) => r.question },
            { label: "Practice", get: (r) => r.shortLabel },
            { label: "Farmer", get: (r) => r.farmerName },
            { label: "Organization", get: (r) => r.organization },
            { label: "County", get: (r) => r.county },
            { label: "Tenure", get: (r) => r.tenure },
            { label: "Baseline", get: (r) => (r.baseline === 1 ? "Doing" : "Not doing") },
            { label: "Endline", get: (r) => (r.endline === 1 ? "Doing" : "Not doing") },
            { label: "Reason", get: (r) => r.reasonCategory || "" },
          ], `day${d.day}_records.csv`);
        });
      });

      btnsWrap.querySelector("#dl-json").addEventListener("click", () => {
        downloadJSON(DASHBOARD_DATA, "dashboard_data_full.json");
      });
    };

    panel.querySelector("#unlock-download").addEventListener("click", unlock);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
  }, 0);

  return panel;
}

function renderOverviewSampleChart() {
  destroyChart("overviewSampleChart");
  const ctx = document.getElementById("overviewSampleChart");
  if (!ctx) return;
  STATE.charts["overviewSampleChart"] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: DASHBOARD_DATA.days.map((d) => d.title),
      datasets: [
        { label: "Baseline surveyed", data: DASHBOARD_DATA.days.map((d) => d.nBaselineSurveyed), backgroundColor: COLORS.ochre },
        { label: "Endline surveyed", data: DASHBOARD_DATA.days.map((d) => d.nEndlineSurveyed), backgroundColor: COLORS.navy },
        { label: "Used in adoption charts", data: DASHBOARD_DATA.days.map((d) => d.nMatched), backgroundColor: COLORS.green },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" } },
      scales: { y: { beginAtZero: true, title: { display: true, text: "Number of farmers" } } },
    },
  });
}

function kpiCard(label, value, sub, accent) {
  return `
    <div class="kpi-card accent-${accent}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Day tab
// ---------------------------------------------------------------------------
function buildDayView(day) {
  if (!STATE.filters[day]) STATE.filters[day] = defaultFilters();
  if (!STATE.sort[day]) STATE.sort[day] = { col: "farmerName", dir: 1 };

  const meta = dayMeta(day);
  const allRecords = recordsForDay(day);
  const allFarmers = farmersForDay(day);
  const f = STATE.filters[day];

  const wrap = document.createElement("section");
  wrap.className = "view active";

  // --- Toolbar ---
  // Organization/County/Tenure options come from the full farmer identity
  // list (every farmer who appears in this day's raw sheet at all), not
  // just `allRecords` (which only holds farmers with complete matched
  // data) - otherwise an organization with baseline-only farmers and zero
  // matched records would silently disappear from the dropdown. Options
  // are narrowed by whichever of the other identity filters are already
  // set, so picking a County only offers Organizations that actually
  // appear there, and vice versa.
  function optionsFor(field) {
    const scoped = allFarmers.filter((p) => {
      if (field !== "organization" && !matchesMulti(f.organization, p.organization)) return false;
      if (field !== "county" && !matchesMulti(f.county, p.county)) return false;
      if (field !== "tenure" && !matchesMulti(f.tenure, p.tenure)) return false;
      if (f.farmerSearch && !p.farmerName.toLowerCase().includes(f.farmerSearch.toLowerCase())) return false;
      return true;
    });
    return distinctSorted(scoped, field);
  }
  // If previously-selected specific values are no longer valid given the
  // other filters (e.g. County narrowed Organization down to a list that no
  // longer includes a chosen org), drop just those values rather than
  // showing a dead-end selection; drop back to ["All"] if that empties it.
  function pruneMultiSelect(key, choices) {
    if (f[key].includes("All")) return;
    f[key] = f[key].filter((v) => choices.includes(v));
    if (f[key].length === 0) f[key] = ["All"];
  }
  let orgChoices = optionsFor("organization");
  pruneMultiSelect("organization", orgChoices);
  let countyChoices = optionsFor("county");
  pruneMultiSelect("county", countyChoices);
  let tenureChoices = optionsFor("tenure");
  pruneMultiSelect("tenure", tenureChoices);

  const practiceOptions = distinctQuestions(allRecords); // [ [code, label], ... ]
  const practiceValues = practiceOptions.map(optValue);
  if (!f.practice.includes("All")) {
    f.practice = f.practice.filter((v) => practiceValues.includes(v));
    if (f.practice.length === 0) f.practice = ["All"];
  }
  const isSinglePractice = f.practice.length === 1 && !f.practice.includes("All");
  const statusChoices = ["Doing", "Not doing"];

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.innerHTML = `
    ${multiSelectFieldHTML(day, "organization", "Organization", orgChoices, f.organization)}
    ${multiSelectFieldHTML(day, "county", "County", countyChoices, f.county)}
    <div class="field">
      <label for="f-name-${day}">Farmer name</label>
      <input id="f-name-${day}" type="text" placeholder="Search name..." value="${f.farmerSearch}">
    </div>
    ${multiSelectFieldHTML(day, "tenure", "Tenure", tenureChoices, f.tenure)}
    ${multiSelectFieldHTML(day, "practice", "Practice", practiceOptions, f.practice)}
    ${multiSelectFieldHTML(day, "baselineStatus", "Baseline status", statusChoices, f.baselineStatus, !isSinglePractice)}
    ${multiSelectFieldHTML(day, "endlineStatus", "Endline status", statusChoices, f.endlineStatus, !isSinglePractice)}
    <button class="btn reset-btn" id="reset-${day}">Reset filters</button>
  `;
  wrap.appendChild(toolbar);

  wireMultiSelectField(toolbar, day, "organization", orgChoices, f, renderMain);
  wireMultiSelectField(toolbar, day, "county", countyChoices, f, renderMain);
  wireMultiSelectField(toolbar, day, "tenure", tenureChoices, f, renderMain);
  wireMultiSelectField(toolbar, day, "practice", practiceOptions, f, renderMain);
  wireMultiSelectField(toolbar, day, "baselineStatus", statusChoices, f, renderMain);
  wireMultiSelectField(toolbar, day, "endlineStatus", statusChoices, f, renderMain);
  toolbar.querySelector(`#f-name-${day}`).addEventListener("input", (e) => { f.farmerSearch = e.target.value; renderMain(); });
  toolbar.querySelector(`#reset-${day}`).addEventListener("click", () => { STATE.filters[day] = defaultFilters(); STATE.openMultiSelect = null; renderMain(); });

  // --- KPIs ---
  // Org/county/name/tenure filters narrow the farmer pool; baseline/endline
  // status filters only make sense once a single practice is selected.
  const coreFiltered = allRecords.filter((r) => {
    if (!matchesMulti(f.organization, r.organization)) return false;
    if (!matchesMulti(f.county, r.county)) return false;
    if (f.farmerSearch && !r.farmerName.toLowerCase().includes(f.farmerSearch.toLowerCase())) return false;
    if (!matchesMulti(f.tenure, r.tenure)) return false;
    return true;
  });
  // Same as coreFiltered but ignoring the Tenure dropdown - used only by the
  // New-vs-Old comparison chart, which always needs both groups present.
  const orgCountyNameFiltered = allRecords.filter((r) => {
    if (!matchesMulti(f.organization, r.organization)) return false;
    if (!matchesMulti(f.county, r.county)) return false;
    if (f.farmerSearch && !r.farmerName.toLowerCase().includes(f.farmerSearch.toLowerCase())) return false;
    return true;
  });
  const fullyFiltered = applyFilters(allRecords, f);

  // Every KPI card below is driven by the farmer identity list, filtered by
  // organization/county/name/tenure - so picking an organization correctly
  // narrows baseline/endline/not-found/matched counts, not just the
  // "Currently Filtered" card.
  const filteredFarmers = applyIdentityFilters(allFarmers, f);
  const nBaselineFiltered = filteredFarmers.filter((p) => p.atBaseline).length;
  const nEndlineFiltered = filteredFarmers.filter((p) => p.atEndlineThisDay).length;
  const notFoundFarmers = filteredFarmers.filter((p) => p.atBaseline && !p.atEndlineThisDay);
  const nMatchedFiltered = filteredFarmers.filter((p) => p.matched).length;

  const kpiRow = document.createElement("div");
  kpiRow.className = "kpi-row";
  kpiRow.innerHTML = `
    ${kpiCard("Complete Baseline Data", nBaselineFiltered, "Answered all questions at baseline", "navy")}
    ${kpiCard("Farmers at Endline", nEndlineFiltered, "Followed-up at Endline", "navy")}
    ${kpiCard("Not Found at Endline", notFoundFarmers.length, "Surveyed at baseline only", "rust")}
    ${kpiCard("Matched in Charts", nMatchedFiltered, "Complete baseline + endline data", "green")}
    ${kpiCard("Total Surveyed at Baseline", filteredFarmers.length, "Number of farmers with full/partial data", "ochre")}
  `;
  wrap.appendChild(kpiRow);
  wrap.appendChild(buildNotFoundPanel(day, notFoundFarmers));

  // coreFiltered narrowed down to whichever practices are currently
  // selected (or left as-is when "All" is selected) - this is what every
  // "across every practice" panel below (uptake overview, transition
  // breakdown, the All-Practices dumbbell/quadrant, the reasons treemap)
  // actually renders, so picking two or more specific practices compares
  // just those instead of every practice on the day.
  const practiceScopedFiltered = f.practice.includes("All") ? coreFiltered : coreFiltered.filter((r) => f.practice.includes(r.question));
  const practiceScopeLabel = isSinglePractice
    ? ((coreFiltered.find((r) => r.question === f.practice[0]) || {}).shortLabel || f.practice[0])
    : (f.practice.includes("All") ? "All Practices" : `${f.practice.length} selected practices`);

  wrap.appendChild(buildUptakeOverviewPanel(day, practiceScopedFiltered));

  // --- Main content: All Practices vs single-practice drill-down. Only
  // exactly one specific practice gets the deep single-practice view
  // (KPIs, reasons chart, farmer table) - "All" or several practices at
  // once both get the comparison charts, scoped to whichever practices
  // are selected. ---
  if (isSinglePractice) {
    wrap.appendChild(buildPracticeDrilldownPanel(day, f, coreFiltered, fullyFiltered));
  } else {
    wrap.appendChild(buildAllPracticesPanel(day, practiceScopedFiltered));
  }

  // --- Advanced views: live alluvial + treemap (respect filters above) and
  // the New-vs-Old tenure comparison (ignores the Tenure dropdown itself) ---
  wrap.appendChild(buildAdvancedViewsPanel(day, practiceScopedFiltered, orgCountyNameFiltered, f, nEndlineFiltered, isSinglePractice, practiceScopeLabel));

  return wrap;
}

// ---------------------------------------------------------------------------
// Farmer detail: who was surveyed at baseline but not found at endline
// (reflects the organization/county/name/tenure filters above).
// ---------------------------------------------------------------------------
// Buckets the free-text "Reason Not Assessed" values from MissingFarmers
// into a handful of readable groups for the summary chart - the raw sheet
// has ~50 near-duplicate phrasings (typos, minor wording differences) for
// what are really a dozen or so underlying situations. Keyword match, first
// bucket that matches wins; anything unmatched falls into "Other".
function categorizeNotFoundReason(text) {
  if (!text) return "No reason recorded";
  const t = text.toLowerCase();
  const buckets = [
    ["Not documented", ["not documented"]],
    ["Tracked via group record only", ["smart point", "cbo", "work in group"]],
    ["Not visited", ["not visited"]],
    ["Not at home / unreachable", ["not at home", "unreachable", "unrechable", "no phone", "hardly be found", "hardly"]],
    ["Unavailable for follow-up", ["not available", "no time", "other engagements"]],
    ["Returned to school/college", ["school", "college", "collage", "university", "polytechnic", "student"]],
    ["Health / bereavement", ["sick", "hospital", "surgery", "burial"]],
    ["Family issue", ["family conflic", "family conflit", "separated"]],
    ["Record/identity mix-up", ["same homestead"]],
    ["Moved / working elsewhere", ["job", "work", "nairobi", "moved", "mining", "extension officer", "workshop", "training", "meeting", "sugar company"]],
  ];
  for (const [label, keywords] of buckets) {
    if (keywords.some((kw) => t.includes(kw))) return label;
  }
  return "Other / uncategorized";
}

function countNotFoundCategories(sorted) {
  const set = new Set(sorted.map((p) => categorizeNotFoundReason(p.reasonNotAssessed)));
  return set.size;
}

function renderNotFoundReasonChart(canvasId, sorted, day) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const counts = new Map();
  sorted.forEach((p) => {
    const label = categorizeNotFoundReason(p.reasonNotAssessed);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);

  STATE.charts[canvasId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: entries.map(([label]) => label),
      datasets: [{
        label: "Farmers",
        data: entries.map(([, n]) => n),
        backgroundColor: entries.map(([label]) => (label === "No reason recorded" ? COLORS.line : COLORS.rust)),
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      onClick: () => {
        STATE.notFoundTableOpen[day] = true;
        renderMain();
      },
      onHover: (evt, elements) => {
        evt.native.target.style.cursor = elements.length ? "pointer" : "default";
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const pct = sorted.length ? ((c.raw / sorted.length) * 100).toFixed(1) : "0.0";
              return `${c.raw} farmer(s) - this is ${pct}% of farmers not reached - click to view the full list below`;
            },
          },
        },
      },
      scales: {
        x: { min: 0, title: { display: true, text: "Number of farmers" } },
      },
    },
  });
}

function buildNotFoundPanel(day, notFoundFarmers) {
  const panel = document.createElement("div");
  panel.className = "panel";
  const sorted = [...notFoundFarmers].sort((a, b) => a.farmerName.localeCompare(b.farmerName));
  const tableOpen = !!STATE.notFoundTableOpen[day];
  const chartHeight = Math.max(160, countNotFoundCategories(sorted) * 34);

  panel.innerHTML = `
    <h2>Farmers Not Found at Endline</h2>
    <div class="panel-sub">Surveyed at baseline but not reached at endline for this day. Reflects the organization/county/name/tenure filters above. Reason not assessed comes from the MissingFarmers tracking sheet and is grouped into broad categories below for readability (a handful of farmers have no reason recorded there).</div>
    ${sorted.length ? `
      <div class="chart-wrap" style="height:${chartHeight}px;"><canvas id="notfound-reason-chart-${day}"></canvas></div>
      <div class="panel-sub" style="margin-top:8px; display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <span>Click a bar to view the full farmer-level list (with their exact, un-grouped reason).</span>
        <button class="btn" id="toggle-notfound-table-${day}">${tableOpen ? "Hide" : "Show"} farmer list</button>
      </div>
      ${tableOpen ? `
        <div class="table-scroll" style="margin-top:10px;">
          <table class="data-table">
            <thead><tr><th>Farmer</th><th>Organization</th><th>County</th><th>Tenure</th><th>Reason not assessed</th></tr></thead>
            <tbody>
              ${sorted.map((p) => `
                <tr><td>${farmerNameCell(p.farmerName)}</td><td>${p.organization}</td><td>${p.county}</td><td>${p.tenure}</td><td>${p.reasonNotAssessed || "-"}</td></tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        <div class="table-footer">
          <span>${sorted.length} farmer(s)</span>
          <button class="btn" id="export-notfound-${day}">Export list (CSV)</button>
        </div>
      ` : ""}
    ` : `<div class="empty-note">No farmers match the current filters, or every filtered farmer was found at endline.</div>`}
  `;

  if (sorted.length) {
    setTimeout(() => {
      renderNotFoundReasonChart(`notfound-reason-chart-${day}`, sorted, day);
      addChartDownloadButton(panel, `notfound-reason-chart-${day}`, `day${day}_not_found_reasons.png`);
    }, 0);
    panel.querySelector(`#toggle-notfound-table-${day}`).addEventListener("click", () => {
      STATE.notFoundTableOpen[day] = !tableOpen;
      renderMain();
    });
    if (tableOpen) {
      panel.querySelector(`#export-notfound-${day}`).addEventListener("click", () => {
        passwordGatedDownload(sorted, [
          { label: "Farmer", get: (p) => p.farmerName },
          { label: "Organization", get: (p) => p.organization },
          { label: "County", get: (p) => p.county },
          { label: "Tenure", get: (p) => p.tenure },
          { label: "Reason not assessed", get: (p) => p.reasonNotAssessed || "" },
        ], `day${day}_not_found_at_endline.csv`);
      });
    }
  }
  return panel;
}

function buildAllPracticesPanel(day, records) {
  const panel = document.createElement("div");
  panel.className = "panel";
  const summary = summarizeByPractice(records);

  panel.innerHTML = `
    <h2>All Practices: Baseline vs Endline</h2>
    <div class="panel-sub">Filtered by organization/county/name above. Select a specific practice in the toolbar to drill into farmer-level detail and reasons for non-adoption. Click a bar/dot to focus on just that practice and dim the rest; click again to clear.</div>
    <div class="two-col">
      <div>
        <div style="display:flex; justify-content:flex-end; margin-bottom:4px;"><button class="btn dl-btn" id="dl-dumbbell-${day}">Download</button></div>
        <div class="chart-wrap" style="height:${Math.max(320, summary.length * 34)}px;"><canvas id="dumbbell-${day}"></canvas></div>
      </div>
      <div>
        <div style="display:flex; justify-content:flex-end; margin-bottom:4px;"><button class="btn dl-btn" id="dl-quadrant-${day}">Download</button></div>
        <div class="chart-wrap" style="height:${Math.max(320, summary.length * 34)}px;"><canvas id="quadrant-${day}"></canvas></div>
      </div>
    </div>
  `;
  setTimeout(() => {
    renderDumbbellChart(`dumbbell-${day}`, summary);
    renderQuadrantChart(`quadrant-${day}`, summary);
    panel.querySelector(`#dl-dumbbell-${day}`).addEventListener("click", () => {
      const chart = STATE.charts[`dumbbell-${day}`];
      if (!chart) return;
      const a = document.createElement("a");
      a.href = chart.toBase64Image("image/png", 1);
      a.download = `day${day}_baseline_vs_endline_dumbbell.png`;
      a.click();
    });
    panel.querySelector(`#dl-quadrant-${day}`).addEventListener("click", () => {
      const chart = STATE.charts[`quadrant-${day}`];
      if (!chart) return;
      const a = document.createElement("a");
      a.href = chart.toBase64Image("image/png", 1);
      a.download = `day${day}_baseline_vs_endline_quadrant.png`;
      a.click();
    });
  }, 0);
  return panel;
}

// Adds a minimal, always-present margin above the highest data value so a
// bar/dot at the max never sits flush against the plot edge, without
// inflating the scale into "nice round number" territory (e.g. 115 -> 116).
function axisMaxWithMargin(maxVal) {
  return Math.ceil(maxVal) + 1;
}

function renderDumbbellChart(canvasId, summary) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const sorted = [...summary].sort((a, b) => a.change - b.change);
  const maxN = axisMaxWithMargin(Math.max(1, ...sorted.map((s) => Math.max(s.baseCount, s.endCount))));
  const chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: sorted.map((s) => s.label),
      datasets: [
        {
          label: "Baseline to Endline range",
          data: sorted.map((s) => [Math.min(s.baseCount, s.endCount), Math.max(s.baseCount, s.endCount)]),
          backgroundColor: sorted.map((s) => (s.change >= 0 ? "rgba(63,125,75,0.25)" : "rgba(166,75,42,0.25)")),
          borderColor: sorted.map((s) => (s.change >= 0 ? COLORS.green : COLORS.rust)),
          borderWidth: 1,
          borderSkipped: false,
          barThickness: 14,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: "Baseline vs Endline (number of farmers)", font: { size: 13 } },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const s = sorted[ctx.dataIndex];
              const diff = s.endCount - s.baseCount;
              return `Baseline ${s.baseCount} -> Endline ${s.endCount} farmers (n=${s.n})  |  Change: ${diff >= 0 ? "+" : ""}${diff} farmers (${s.change >= 0 ? "+" : ""}${s.change.toFixed(1)}pp)`;
            },
          },
        },
      },
      scales: { x: { min: 0, max: maxN, title: { display: true, text: "Number of farmers" } } },
    },
  });
  STATE.charts[canvasId] = chart;
  wireBarFocusClick(chart, canvasId);
}

function renderQuadrantChart(canvasId, summary) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const maxN = axisMaxWithMargin(Math.max(1, ...summary.map((s) => Math.max(s.baseCount, s.endCount))));
  STATE.charts[canvasId] = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Practices",
          data: summary.map((s) => ({ x: s.baseCount, y: s.endCount, label: s.label, change: s.change, n: s.n })),
          backgroundColor: summary.map((s) => (s.change >= 0 ? COLORS.green : COLORS.rust)),
          pointRadius: 7,
          pointHoverRadius: 9,
        },
        {
          label: "No change",
          data: [{ x: 0, y: 0 }, { x: maxN, y: maxN }],
          type: "line",
          borderColor: COLORS.line,
          borderDash: [5, 4],
          pointRadius: 0,
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: "Baseline vs Endline, number of farmers (above line = improved)", font: { size: 13 } },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const d = ctx.raw;
              if (!d.label) return "";
              const diff = d.y - d.x;
              return `${d.label}: ${d.x} -> ${d.y} farmers (n=${d.n})  |  Change: ${diff >= 0 ? "+" : ""}${diff} (${d.change >= 0 ? "+" : ""}${d.change.toFixed(1)}pp)`;
            },
          },
        },
      },
      scales: {
        x: { min: 0, max: maxN, title: { display: true, text: "Baseline (number of farmers)" } },
        y: { min: 0, max: maxN, title: { display: true, text: "Endline (number of farmers)" } },
      },
    },
  });
}

function buildPracticeDrilldownPanel(day, f, orgCountyNameFiltered, fullyFiltered) {
  const practiceValue = f.practice[0];
  const practiceRecords = orgCountyNameFiltered.filter((r) => r.question === practiceValue);
  const baseYes = practiceRecords.filter((r) => r.baseline === 1).length;
  const endYes = practiceRecords.filter((r) => r.endline === 1).length;
  const total = practiceRecords.length;
  const label = practiceRecords[0] ? practiceRecords[0].shortLabel : practiceValue;
  const questionText = practiceRecords[0] ? practiceRecords[0].questionText : "";
  const reasons = reasonCounts(practiceRecords);
  const changePP = pct(endYes, total) - pct(baseYes, total);
  const diffCount = endYes - baseYes;

  const container = document.createElement("div");

  const summaryPanel = document.createElement("div");
  summaryPanel.className = "panel";
  summaryPanel.innerHTML = `
    <h2>${label}</h2>
    <div class="panel-sub">${questionText}</div>
    <div class="kpi-row" style="margin-bottom:0;">
      ${kpiCard("Baseline: Doing", baseYes, `of ${total} farmers`, "navy")}
      ${kpiCard("Endline: Doing", endYes, `of ${total} farmers`, "green")}
      ${kpiCard("Change", `${diffCount >= 0 ? "+" : ""}${diffCount} (${changePP >= 0 ? "+" : ""}${changePP.toFixed(1)}pp)`, endYes >= baseYes ? "Improved" : "Declined", endYes >= baseYes ? "green" : "rust")}
    </div>
  `;
  container.appendChild(summaryPanel);

  const twoCol = document.createElement("div");
  twoCol.className = "two-col";

  const reasonPanel = document.createElement("div");
  reasonPanel.className = "panel";
  if (reasons.length) {
    reasonPanel.innerHTML = `
      <h2>Why Farmers Are Not Doing This</h2>
      <div class="panel-sub">Among currently filtered farmers not doing this practice at endline.</div>
      <div class="chart-wrap" style="height:${Math.max(220, reasons.length * 36)}px;"><canvas id="reasons-${day}"></canvas></div>
    `;
  } else {
    reasonPanel.innerHTML = `
      <h2>Why Farmers Are Not Doing This</h2>
      <div class="empty-note">No non-adopters in the current filter selection, or no reasons recorded.</div>
    `;
  }
  twoCol.appendChild(reasonPanel);

  const tablePanel = document.createElement("div");
  tablePanel.className = "panel";
  tablePanel.appendChild(buildFarmerTable(day, fullyFiltered, f));
  twoCol.appendChild(tablePanel);

  container.appendChild(twoCol);

  setTimeout(() => {
    if (reasons.length) {
      renderReasonChart(`reasons-${day}`, reasons);
      addChartDownloadButton(reasonPanel, `reasons-${day}`, `day${day}_${practiceValue}_reasons.png`);
    }
  }, 0);

  return container;
}

function renderReasonChart(canvasId, reasons) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: reasons.map((r) => r.reason),
      datasets: [{ data: reasons.map((r) => r.n), backgroundColor: COLORS.ochre }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, title: { display: true, text: "Number of farmers" } } },
    },
  });
  STATE.charts[canvasId] = chart;
  wireBarFocusClick(chart, canvasId);
}

// ---------------------------------------------------------------------------
// Farmer-level table (only meaningful once a single practice is selected)
// ---------------------------------------------------------------------------
function buildFarmerTable(day, records, f) {
  const wrap = document.createElement("div");
  const sort = STATE.sort[day];

  const sorted = [...records].sort((a, b) => {
    let av = a[sort.col], bv = b[sort.col];
    if (typeof av === "string") { av = av.toLowerCase(); bv = bv.toLowerCase(); }
    if (av < bv) return -1 * sort.dir;
    if (av > bv) return 1 * sort.dir;
    return 0;
  });

  const cols = [
    { key: "farmerName", label: "Farmer" },
    { key: "organization", label: "Organization" },
    { key: "county", label: "County" },
    { key: "baseline", label: "Baseline" },
    { key: "endline", label: "Endline" },
    { key: "narrative", label: "Narrative (if not doing)" },
  ];

  wrap.innerHTML = `
    <h2>Farmer-Level Detail</h2>
    <div class="panel-sub">${records.length} record(s) match the current filters for this practice.</div>
    ${records.length ? `
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr>${cols.map((c) => `<th data-col="${c.key}">${c.label} ${sort.col === c.key ? (sort.dir === 1 ? "&uarr;" : "&darr;") : ""}</th>`).join("")}</tr></thead>
          <tbody>
            ${sorted.map((r) => `
              <tr>
                <td>${farmerNameCell(r.farmerName)}</td>
                <td>${r.organization}</td>
                <td>${r.county}</td>
                <td><span class="status-pill ${r.baseline === 1 ? "status-yes" : "status-no"}">${r.baseline === 1 ? "Doing" : "Not doing"}</span></td>
                <td><span class="status-pill ${r.endline === 1 ? "status-yes" : "status-no"}">${r.endline === 1 ? "Doing" : "Not doing"}</span></td>
                <td>${r.narrative || "-"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="table-footer">
        <span>Click a column header to sort.</span>
        <button class="btn" id="export-${day}">Export filtered data (CSV)</button>
      </div>
    ` : `<div class="empty-note">No farmer records match the current filters.</div>`}
  `;

  if (records.length) {
    wrap.querySelectorAll("th[data-col]").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.getAttribute("data-col");
        if (sort.col === col) sort.dir *= -1;
        else { sort.col = col; sort.dir = 1; }
        renderMain();
      });
    });
    wrap.querySelector(`#export-${day}`).addEventListener("click", () => {
      passwordGatedDownload(sorted, [
        { label: "Farmer", get: (r) => r.farmerName },
        { label: "Organization", get: (r) => r.organization },
        { label: "County", get: (r) => r.county },
        { label: "Practice", get: (r) => r.shortLabel },
        { label: "Baseline", get: (r) => (r.baseline === 1 ? "Doing" : "Not doing") },
        { label: "Endline", get: (r) => (r.endline === 1 ? "Doing" : "Not doing") },
        { label: "Narrative", get: (r) => r.narrative || "" },
      ], `day${day}_${f.practice.join("_")}_filtered.csv`);
    });
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Advanced views: live alluvial (featured practice when "All" is selected)
// + treemap (both respect the filters above), and the New-vs-Old tenure
// comparison (always shows both tenure groups regardless of the Tenure filter)
// ---------------------------------------------------------------------------
function computeTransitionsJS(records) {
  let stayedNotDoing = 0, stopped = 0, started = 0, stayedDoing = 0;
  records.forEach((r) => {
    if (r.baseline === 0 && r.endline === 0) stayedNotDoing++;
    else if (r.baseline === 1 && r.endline === 0) stopped++;
    else if (r.baseline === 0 && r.endline === 1) started++;
    else if (r.baseline === 1 && r.endline === 1) stayedDoing++;
  });
  return { stayedNotDoing, stopped, started, stayedDoing };
}

// Same four categories as computeTransitionsJS, but broken out per practice
// instead of aggregated into one total - one entry per question, each with
// its own four counts, sorted by "doing at endline" (started+stayedDoing)
// descending so the practices with the strongest uptake lead.
function computeTransitionsByPractice(records) {
  const byQ = new Map();
  records.forEach((r) => {
    if (!byQ.has(r.question)) byQ.set(r.question, { question: r.question, label: r.shortLabel, stayedNotDoing: 0, started: 0, stopped: 0, stayedDoing: 0 });
    const b = byQ.get(r.question);
    if (r.baseline === 0 && r.endline === 0) b.stayedNotDoing++;
    else if (r.baseline === 1 && r.endline === 0) b.stopped++;
    else if (r.baseline === 0 && r.endline === 1) b.started++;
    else if (r.baseline === 1 && r.endline === 1) b.stayedDoing++;
  });
  return Array.from(byQ.values()).sort((a, b) => (b.started + b.stayedDoing) - (a.started + a.stayedDoing));
}

// Practice uptake overview: one lollipop-style chart, one practice per x
// position, three series grouped together per practice - scoped to
// whichever practices are currently selected (all, one, or several).
// Overall uptake at endline (continued-doing + newly-started combined)
// sits alongside just the newly-started slice of that total and the
// continued-from-baseline slice, so it's easy to see how much of each
// practice's endline total is genuinely new versus carried over.
function buildUptakeOverviewPanel(day, records) {
  const panel = document.createElement("div");
  panel.className = "panel";
  const uptakeSummary = [...summarizeByPractice(records)].sort((a, b) => b.endCount - a.endCount);
  panel.innerHTML = `
    <h2>Practice Uptake Overview</h2>
    <div class="panel-sub">Reflects the organization/county/name/tenure/practice filters above. "Overall uptake" is everyone doing the practice at endline (continued + newly started); "Newly uptaken" is just the new-adopter slice of that total; "Continued" is farmers who were already doing it at baseline and still were at endline. n = total farmers who answered that question. Click a bar to focus on just that practice and dim the rest; click again to clear.</div>
    ${uptakeSummary.length ? `<div class="chart-wrap" style="height:${Math.max(320, uptakeSummary.length * 42)}px;"><canvas id="uptake-overview-${day}"></canvas></div>` : `<div class="empty-note">No practices match the current filters.</div>`}
  `;
  if (uptakeSummary.length) {
    setTimeout(() => {
      renderLollipopChart(`uptake-overview-${day}`, uptakeSummary.map((s) => `${s.label} (n=${s.n})`), [
        { label: "Overall uptake at endline", data: uptakeSummary.map((s) => s.endCount), color: COLORS.ochre },
        { label: "Newly uptaken after training", data: uptakeSummary.map((s) => s.started), color: COLORS.green },
        { label: "Continued from baseline", data: uptakeSummary.map((s) => s.endCount - s.started), color: COLORS.navy },
      ]);
      addChartDownloadButton(panel, `uptake-overview-${day}`, `day${day}_practice_uptake_overview.png`);
    }, 0);
  }
  return panel;
}

function buildAdvancedViewsPanel(day, coreFiltered, orgCountyNameFiltered, f, nEndlineFiltered, isSinglePractice, practiceScopeLabel) {
  const container = document.createElement("div");

  // --- Live alluvial: one row per farmer. For a single practice, each
  // farmer already has exactly one row. Otherwise ("All Practices" or
  // several specific practices at once), rather than collapsing every
  // practice into one "doing at least one" row, we feature the single
  // practice with the largest baseline-to-endline change among whatever is
  // currently in scope - the same ranking summarizeByPractice already uses
  // for the dumbbell/quadrant charts, so the "featured" pick stays
  // consistent across the page. ---
  const featuredPractice = !isSinglePractice ? summarizeByPractice(coreFiltered)[0] : null;
  const alluvialSource = isSinglePractice
    ? coreFiltered
    : (featuredPractice ? coreFiltered.filter((r) => r.question === featuredPractice.question) : []);
  const transitionCounts = computeTransitionsJS(alluvialSource);
  const alluvialTitle = isSinglePractice
    ? practiceScopeLabel
    : (featuredPractice ? `Featured practice - ${featuredPractice.label}` : "no practices in range");
  const alluvialNote = !isSinglePractice
    ? `Showing the practice with the largest baseline-to-endline change${featuredPractice ? ` (${featuredPractice.change >= 0 ? "+" : ""}${featuredPractice.change.toFixed(1)}pp)` : ""} among the practices currently in scope. Reflects the organization/county/name/tenure/practice filters above.`
    : "Reflects the organization/county/name/tenure filters above.";

  // Minimalist by default: only the per-practice stacked bar shows, with a
  // one-line invitation to reveal the flow diagram below it instead of
  // always showing both side by side.
  const transitionByPractice = computeTransitionsByPractice(coreFiltered);
  const flowOpen = !!STATE.transitionFlowOpen[day];
  const stackPanel = document.createElement("div");
  stackPanel.className = "panel";
  stackPanel.innerHTML = `
    <h2>Transition Category Breakdown</h2>
    <div class="panel-sub">Same four categories as the flow diagram - stayed not doing, started, stopped, stayed doing - one stacked bar per practice, scoped to whichever practices are selected above. n = total farmers who answered that question. Click a bar to focus on just that practice and dim the rest; click again to clear.</div>
    <div class="chart-wrap" style="height:${Math.max(320, transitionByPractice.length * 34)}px;"><canvas id="transition-stack-${day}"></canvas></div>
    <div class="panel-sub" style="margin-top:10px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <span>Want to see this as a flow diagram instead? Click here.</span>
      <button class="btn" id="toggle-flow-${day}">${flowOpen ? "Hide" : "Show"} flow diagram</button>
    </div>
    ${flowOpen ? `
      <div class="panel" id="alluvial-panel-${day}" style="margin-top:14px; border:1px solid var(--line);">
        <h2>Farmer Transitions: ${alluvialTitle}</h2>
        <div class="panel-sub">${alluvialNote}</div>
        <div id="alluvial-${day}" style="min-height:300px;"></div>
      </div>
    ` : ""}
  `;
  container.appendChild(stackPanel);
  setTimeout(() => {
    renderTransitionStackChart(`transition-stack-${day}`, transitionByPractice);
    addChartDownloadButton(stackPanel, `transition-stack-${day}`, `day${day}_transition_category_breakdown.png`);
    if (flowOpen) {
      renderAlluvialSVG(`alluvial-${day}`, transitionCounts);
      const alluvialPanelEl = stackPanel.querySelector(`#alluvial-panel-${day}`);
      addSVGDownloadButton(alluvialPanelEl, () => {
        const svg = document.querySelector(`#alluvial-${day} svg`);
        return svg ? svg.outerHTML : null;
      }, `day${day}_farmer_transitions_flow.svg`);
    }
  }, 0);
  stackPanel.querySelector(`#toggle-flow-${day}`).addEventListener("click", () => {
    STATE.transitionFlowOpen[day] = !flowOpen;
    renderMain();
  });

  // --- New vs Old tenure comparison, baseline and endline shown as two
  // side-by-side charts instead of one combined stacked chart. ---
  const tenurePanel = document.createElement("div");
  tenurePanel.className = "panel";
  const tenureSummary = summarizeByPracticeAndTenure(orgCountyNameFiltered);
  const unknownCount = uniqueFarmerCount(orgCountyNameFiltered.filter((r) => r.tenure === "Unknown"));
  const tenureChartHeight = Math.max(360, tenureSummary.length * 46);
  tenurePanel.innerHTML = `
    <h2>Practice Adoption: New vs Old Farmers</h2>
    <div class="panel-sub">
      New = 1.5 years or less with the organization, Old = more than 1.5 years (from Farmer_Membership records).
      Reflects organization/county/name filters above, but ignores the Tenure filter since both groups are always shown here.
      ${unknownCount > 0 ? `${unknownCount} farmer(s) with unknown tenure are excluded from this chart.` : ""}
    </div>
    <div class="two-col-even">
      <div>
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:2px;"><div class="chart-subtitle" style="margin-bottom:0;">Baseline</div><button class="btn dl-btn" id="dl-tenure-base-${day}">Download</button></div>
        <div class="chart-wrap" style="height:${tenureChartHeight}px;"><canvas id="tenure-compare-baseline-${day}"></canvas></div>
      </div>
      <div>
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:2px;"><div class="chart-subtitle" style="margin-bottom:0;">Endline</div><button class="btn dl-btn" id="dl-tenure-end-${day}">Download</button></div>
        <div class="chart-wrap" style="height:${tenureChartHeight}px;"><canvas id="tenure-compare-endline-${day}"></canvas></div>
      </div>
    </div>
  `;
  container.appendChild(tenurePanel);
  setTimeout(() => {
    renderTenureComparisonChart(`tenure-compare-baseline-${day}`, tenureSummary, "Baseline");
    renderTenureComparisonChart(`tenure-compare-endline-${day}`, tenureSummary, "Endline");
    [["tenure-compare-baseline-", "dl-tenure-base-", "baseline"], ["tenure-compare-endline-", "dl-tenure-end-", "endline"]].forEach(([canvasPrefix, btnPrefix, tag]) => {
      tenurePanel.querySelector(`#${btnPrefix}${day}`).addEventListener("click", () => {
        const chart = STATE.charts[`${canvasPrefix}${day}`];
        if (!chart) return;
        const a = document.createElement("a");
        a.href = chart.toBase64Image("image/png", 1);
        a.download = `day${day}_tenure_comparison_${tag}.png`;
        a.click();
      });
    });
  }, 0);

  // --- Live treemap of reasons. coreFiltered here is already scoped to
  // whichever practices are selected (all, one, or several) by the caller,
  // so this always just uses it directly: "All"/several practices dedupes
  // each reason to one count per farmer across those practices; a single
  // selected practice means each farmer contributes at most one row and a
  // box's count is a plain farmer headcount for that one practice. ---
  const treemapPanel = document.createElement("div");
  treemapPanel.className = "panel";
  const reasonSource = coreFiltered;
  const reasonScopeLabel = practiceScopeLabel;
  const nonAdoptionRecords = reasonSource.filter((r) => r.endline === 0 && r.reasonCategory);
  const reasons = reasonCounts(reasonSource);
  const uniqueNonAdopters = uniqueFarmerCount(nonAdoptionRecords);
  const selectedReason = STATE.selectedReason[day] || null;
  const reasonNote = !isSinglePractice
    ? "Each box counts the unique farmers who gave that reason for not doing at least one of the practices currently in scope - a farmer citing the same reason for several practices only counts once in that box. A farmer who gives different reasons for different practices can still show up in more than one box, which is why the boxes can add up to more than the farmer headcount below. Pick exactly one practice from the Practice dropdown above to see reasons for just that practice, where each box is a plain farmer headcount for that one practice."
    : `Showing reasons for ${reasonScopeLabel} only (per the Practice filter above). Each farmer gives at most one reason for a given practice, so no box here can exceed the farmers surveyed at endline below.`;
  treemapPanel.innerHTML = `
    <h2>Reasons for Non-Adoption (${reasonScopeLabel})</h2>
    <div class="panel-sub">Reflects the organization/county/name/tenure/practice filters above. ${reasonNote}</div>
    <div class="panel-sub" style="margin-top:-10px;">${uniqueNonAdopters} of ${typeof nEndlineFiltered === "number" ? nEndlineFiltered : "?"} farmers surveyed at endline gave a reason for not doing ${!isSinglePractice ? "at least one practice in scope" : reasonScopeLabel}${!isSinglePractice ? `, across ${nonAdoptionRecords.length} practice-level reason(s) in total` : ""}. Click a box to see the farmers behind it${!isSinglePractice ? " and which practice they cited it for" : ""}.</div>
    <div id="treemap-${day}" style="position:relative; height:420px; border:1px solid var(--line); border-radius:4px; overflow:visible;"></div>
    <div id="treemap-drill-${day}" style="margin-top:14px;"></div>
  `;
  container.appendChild(treemapPanel);
  setTimeout(() => {
    renderTreemapDiv(`treemap-${day}`, reasons, selectedReason, (reason) => {
      STATE.selectedReason[day] = STATE.selectedReason[day] === reason ? null : reason;
      renderMain();
    });
    renderReasonDrilldown(`treemap-drill-${day}`, nonAdoptionRecords, selectedReason, day);
    addSVGDownloadButton(treemapPanel, () => buildTreemapSVGString(reasons), `day${day}_reasons_for_non_adoption.svg`);
  }, 0);

  return container;
}

function summarizeByPracticeAndTenure(records) {
  const byQ = new Map();
  records.forEach((r) => {
    if (r.tenure !== "New" && r.tenure !== "Old") return; // exclude Unknown
    if (!byQ.has(r.question)) {
      byQ.set(r.question, { label: r.shortLabel, New: { base: [], end: [] }, Old: { base: [], end: [] } });
    }
    const bucket = byQ.get(r.question)[r.tenure];
    bucket.base.push(r.baseline);
    bucket.end.push(r.endline);
  });
  const out = [];
  byQ.forEach((v, q) => {
    const newN = v.New.base.length;
    const oldN = v.Old.base.length;
    const newBaseDoing = v.New.base.reduce((a, b) => a + b, 0);
    const newEndDoing = v.New.end.reduce((a, b) => a + b, 0);
    const oldBaseDoing = v.Old.base.reduce((a, b) => a + b, 0);
    const oldEndDoing = v.Old.end.reduce((a, b) => a + b, 0);
    out.push({
      question: q,
      label: v.label,
      newN, oldN,
      newBaseDoing, newBaseNotDoing: newN - newBaseDoing,
      newEndDoing, newEndNotDoing: newN - newEndDoing,
      oldBaseDoing, oldBaseNotDoing: oldN - oldBaseDoing,
      oldEndDoing, oldEndNotDoing: oldN - oldEndDoing,
    });
  });
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

// period is "Baseline" or "Endline" - each call renders just that one
// round's New-vs-Old bars, so the two rounds can sit side by side as two
// separate charts instead of one chart with both rounds stacked together.
// One stacked bar per practice (vertical - categories along the bottom,
// counts going up), each split into the same four categories/colors as the
// alluvial's ribbons and legend, so the two panels read as one connected
// view of the same data.
function renderTransitionStackChart(canvasId, summary) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: summary.map((s) => `${s.label} (n=${s.stayedNotDoing + s.started + s.stopped + s.stayedDoing})`),
      datasets: [
        { label: "Stayed not doing", data: summary.map((s) => s.stayedNotDoing), backgroundColor: "#BBBBBB" },
        { label: "Started doing", data: summary.map((s) => s.started), backgroundColor: COLORS.green },
        { label: "Stopped doing", data: summary.map((s) => s.stopped), backgroundColor: COLORS.ochre },
        { label: "Stayed doing", data: summary.map((s) => s.stayedDoing), backgroundColor: COLORS.navy },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      categoryPercentage: 0.72,
      barPercentage: 0.92,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const total = summary[c.dataIndex].stayedNotDoing + summary[c.dataIndex].started + summary[c.dataIndex].stopped + summary[c.dataIndex].stayedDoing;
              return `${c.dataset.label}: ${c.raw} of n=${total} (${total ? ((c.raw / total) * 100).toFixed(1) : "0.0"}%)`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, min: 0, title: { display: true, text: "Number of farmers" } },
        y: { stacked: true, ticks: { font: { size: 11 } } },
      },
    },
  });
  STATE.charts[canvasId] = chart;
  wireBarFocusClick(chart, canvasId);
}

// Grouped, thin, rounded-cap bars standing in for a "lollipop": several
// series per category, side by side, drawn horizontally so many categories
// stack down the page at a fixed row height instead of needing ever more
// width per category. A true dot-on-a-stem needs a second point dataset
// that Chart.js won't auto-offset to match grouped bars, so instead each
// bar's end is rounded almost to a full circle - at this thinness it reads
// as a lollipop head without the alignment problems of overlaying a
// separate point dataset.
function renderLollipopChart(canvasId, labels, series) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        backgroundColor: s.color,
        maxBarThickness: 20,
        borderRadius: 100,
        categoryPercentage: 0.8,
        barPercentage: 0.88,
      })),
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${c.raw} farmer(s)`,
          },
        },
      },
      scales: {
        x: { min: 0, title: { display: true, text: "Number of farmers" } },
        y: { ticks: { font: { size: 11 } } },
      },
    },
  });
  STATE.charts[canvasId] = chart;
  wireBarFocusClick(chart, canvasId);
}

function renderTenureComparisonChart(canvasId, summary, period) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const labels = summary.map((s) => s.label);
  const doingField = period === "Baseline" ? "BaseDoing" : "EndDoing";
  const notDoingField = period === "Baseline" ? "BaseNotDoing" : "EndNotDoing";

  // Every dataset carries _tenure/_role metadata used only by the tooltip -
  // kept separate from `label`, which controls the legend.
  const mkBar = (tenure, role, field, color, legendText) => ({
    label: legendText,
    stack: tenure,
    backgroundColor: color,
    data: summary.map((s) => s[field]),
    _tenure: tenure, _role: role,
  });

  const chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        mkBar("New", "doing", `new${doingField}`, COLORS.green, "New: Doing"),
        mkBar("New", "notdoing", `new${notDoingField}`, COLORS.ochre, "New: Not doing"),
        mkBar("Old", "doing", `old${doingField}`, COLORS.navy, "Old: Doing"),
        mkBar("Old", "notdoing", `old${notDoingField}`, "#c1272d", "Old: Not doing"),
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: `${period}: New vs Old`, font: { size: 12 }, position: "bottom" },
        // Both charts share the exact same 4 series/colors (New/Old x
        // Doing/Not doing) - showing the legend on just the Baseline chart
        // avoids printing the same legend twice for what's effectively one
        // shared key.
        legend: { display: period === "Baseline" },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const ds = ctx.dataset;
              const s = summary[ctx.dataIndex];
              const n = ds._tenure === "New" ? s.newN : s.oldN;
              const roleText = ds._role === "doing" ? "Doing" : "Not doing";
              return `${ds._tenure}: ${roleText} (${period}): ${ctx.raw} of ${n} farmers`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, min: 0, title: { display: true, text: "Number of farmers" } },
        y: { stacked: true },
      },
    },
  });
  STATE.charts[canvasId] = chart;
  wireBarFocusClick(chart, canvasId);
}

// --- Minimal SVG alluvial (2-column flow diagram), mirrors the Python version ---
function renderAlluvialSVG(containerId, t) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const leftNotDoing = t.stayedNotDoing + t.started;
  const leftDoing = t.stopped + t.stayedDoing;
  const rightNotDoing = t.stayedNotDoing + t.stopped;
  const rightDoing = t.started + t.stayedDoing;
  const total = leftNotDoing + leftDoing;

  if (total === 0) {
    el.innerHTML = `<div class="empty-note">No records match the current filters.</div>`;
    return;
  }

  const W = 760, H = 300, gapFrac = 0.04;
  const x0 = 160, x1 = 600;
  const scale = (H * 0.82) / total;
  const gap = total * gapFrac * scale;
  const topMargin = 20;

  const leftBottomH = leftNotDoing * scale;
  const leftTopH = leftDoing * scale;
  const rightBottomH = rightNotDoing * scale;
  const rightTopH = rightDoing * scale;

  const gapUnits = total * gapFrac;
  const fullSpan = total + gapUnits;
  const k = (H * 0.82) / fullSpan; // units -> px

  // Left stack, bottom to top: [0, stayedNotDoing, stayedNotDoing+started] then gap then [.., +stopped, +stayedDoing]
  const lSNDb = 0, lSNDt = t.stayedNotDoing;
  const lSTb = lSNDt, lSTt = lSNDt + t.started;
  const lDoingStart = leftNotDoing + gapUnits;
  const lSPb = lDoingStart, lSPt = lDoingStart + t.stopped;
  const lSDb = lSPt, lSDt = lSPt + t.stayedDoing;

  const rSNDb = 0, rSNDt = t.stayedNotDoing;
  const rSPb = rSNDt, rSPt = rSNDt + t.stopped;
  const rDoingStart = rightNotDoing + gapUnits;
  const rSTb = rDoingStart, rSTt = rDoingStart + t.started;
  const rSDb = rSTt, rSDt = rSTt + t.stayedDoing;

  const toY = (u) => topMargin + (fullSpan - u) * k; // flip so 0 is at bottom

  function ribbon(y0b, y0t, y1b, y1t, color) {
    const xm = (x0 + x1) / 2;
    const Y0b = toY(y0b), Y0t = toY(y0t), Y1b = toY(y1b), Y1t = toY(y1t);
    return `<path d="M ${x0} ${Y0t} C ${xm} ${Y0t}, ${xm} ${Y1t}, ${x1} ${Y1t}
                     L ${x1} ${Y1b} C ${xm} ${Y1b}, ${xm} ${Y0b}, ${x0} ${Y0b} Z"
                  fill="${color}" opacity="0.55"></path>`;
  }

  const barW = 14;
  const svg = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="inherit">
      <text x="${x0}" y="14" font-size="13" font-weight="700" fill="${COLORS.ink}">BASELINE</text>
      <text x="${x1}" y="14" font-size="13" font-weight="700" fill="${COLORS.ink}">ENDLINE</text>

      ${ribbon(lSNDb, lSNDt, rSNDb, rSNDt, "#BBBBBB")}
      ${ribbon(lSTb, lSTt, rSTb, rSTt, COLORS.green)}
      ${ribbon(lSPb, lSPt, rSPb, rSPt, COLORS.ochre)}
      ${ribbon(lSDb, lSDt, rSDb, rSDt, COLORS.navy)}

      <rect x="${x0 - barW}" y="${toY(leftNotDoing)}" width="${barW}" height="${toY(0) - toY(leftNotDoing)}" fill="${COLORS.navy}"></rect>
      <rect x="${x0 - barW}" y="${toY(leftNotDoing + gapUnits + leftDoing)}" width="${barW}" height="${toY(leftNotDoing + gapUnits) - toY(leftNotDoing + gapUnits + leftDoing)}" fill="${COLORS.navy}"></rect>
      <rect x="${x1}" y="${toY(rightNotDoing)}" width="${barW}" height="${toY(0) - toY(rightNotDoing)}" fill="${COLORS.ochre}"></rect>
      <rect x="${x1}" y="${toY(rightNotDoing + gapUnits + rightDoing)}" width="${barW}" height="${toY(rightNotDoing + gapUnits) - toY(rightNotDoing + gapUnits + rightDoing)}" fill="${COLORS.ochre}"></rect>

      <text x="${x0 - barW - 8}" y="${(toY(0) + toY(leftNotDoing)) / 2}" font-size="12" text-anchor="end" fill="${COLORS.ink}">Not doing (${leftNotDoing})</text>
      <text x="${x0 - barW - 8}" y="${(toY(leftNotDoing + gapUnits) + toY(leftNotDoing + gapUnits + leftDoing)) / 2}" font-size="12" text-anchor="end" fill="${COLORS.ink}">Doing (${leftDoing})</text>
      <text x="${x1 + barW + 8}" y="${(toY(0) + toY(rightNotDoing)) / 2}" font-size="12" fill="${COLORS.ink}">Not doing (${rightNotDoing})</text>
      <text x="${x1 + barW + 8}" y="${(toY(rightNotDoing + gapUnits) + toY(rightNotDoing + gapUnits + rightDoing)) / 2}" font-size="12" fill="${COLORS.ink}">Doing (${rightDoing})</text>
    </svg>
    <div style="display:flex; gap:16px; flex-wrap:wrap; font-size:12.5px; margin-top:8px;">
      <span><span style="display:inline-block;width:10px;height:10px;background:#BBBBBB;margin-right:5px;"></span>Stayed not doing (${t.stayedNotDoing})</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:${COLORS.green};margin-right:5px;"></span>Started doing (${t.started})</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:${COLORS.ochre};margin-right:5px;"></span>Stopped doing (${t.stopped})</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:${COLORS.navy};margin-right:5px;"></span>Stayed doing (${t.stayedDoing})</span>
    </div>
  `;
  el.innerHTML = svg;
}

// --- Minimal squarified treemap, ported from the Python implementation ---
function squarifyJS(sizes, x, y, dx, dy) {
  function layoutrow(subset, x, y, dx, dy) {
    const width = subset.reduce((a, b) => a + b, 0) / dy;
    let cy = y;
    return subset.map((s) => {
      const h = s / width;
      const r = { x, y: cy, dx: width, dy: h };
      cy += h;
      return r;
    });
  }
  function layoutcol(subset, x, y, dx, dy) {
    const height = subset.reduce((a, b) => a + b, 0) / dx;
    let cx = x;
    return subset.map((s) => {
      const w = s / height;
      const r = { x: cx, y, dx: w, dy: height };
      cx += w;
      return r;
    });
  }
  function layout(subset, x, y, dx, dy) { return dx >= dy ? layoutrow(subset, x, y, dx, dy) : layoutcol(subset, x, y, dx, dy); }
  function leftover(subset, x, y, dx, dy) {
    if (dx >= dy) { const w = subset.reduce((a, b) => a + b, 0) / dy; return [x + w, y, dx - w, dy]; }
    const h = subset.reduce((a, b) => a + b, 0) / dx; return [x, y + h, dx, dy - h];
  }
  function worst(subset, x, y, dx, dy) {
    const rects = layout(subset, x, y, dx, dy);
    return Math.max(...rects.map((r) => Math.max(r.dx / r.dy, r.dy / r.dx)));
  }

  sizes = sizes.filter((s) => s > 0);
  if (!sizes.length) return [];
  if (sizes.length === 1 || Math.min(dx, dy) <= 0) return layout(sizes, x, y, dx, dy);

  let i = 1;
  while (i < sizes.length && worst(sizes.slice(0, i), x, y, dx, dy) >= worst(sizes.slice(0, i + 1), x, y, dx, dy)) i++;
  const current = sizes.slice(0, i), remaining = sizes.slice(i);
  const placed = layout(current, x, y, dx, dy);
  const [lx, ly, ldx, ldy] = leftover(current, x, y, dx, dy);
  return placed.concat(squarifyJS(remaining, lx, ly, ldx, ldy));
}

const TREEMAP_PALETTE = ["#2E3B52", "#3F7D4B", "#C98A2B", "#A64B2A", "#6B8F71", "#8C6A45",
  "#5B7EA6", "#B08968", "#7A9E7E", "#9C6644", "#4A6670", "#C77B5A"];

// Builds a static standalone SVG mirroring the on-screen treemap (same
// squarify layout/colors), for the panel's download button - the on-screen
// version is plain HTML/CSS divs, not an image, so there's nothing to
// screenshot directly.
function buildTreemapSVGString(reasons) {
  if (!reasons.length) return null;
  const top = reasons.slice(0, 12);
  const otherTotal = reasons.slice(12).reduce((a, r) => a + r.n, 0);
  const items = [...top];
  if (otherTotal > 0) items.push({ reason: "Other reasons", n: otherTotal });
  const totalAll = items.reduce((a, r) => a + r.n, 0);
  const W = 500, H = 300;
  const scale = (W * H) / totalAll;
  const sizes = items.map((r) => r.n * scale);
  const rects = squarifyJS(sizes, 0, 0, W, H);

  const rectsSvg = rects.map((r, i) => {
    const item = items[i];
    const pctVal = ((item.n / totalAll) * 100).toFixed(1);
    const color = item.reason === "Other reasons" ? "#CCCCCC" : TREEMAP_PALETTE[i % TREEMAP_PALETTE.length];
    const area = r.dx * r.dy;
    const showLabel = area > 900;
    const textColor = area > 6000 ? "#fff" : COLORS.ink;
    return `
      <rect x="${r.x}" y="${r.y}" width="${r.dx}" height="${r.dy}" fill="${color}" stroke="#fff" stroke-width="1"></rect>
      ${showLabel ? `<text x="${r.x + r.dx / 2}" y="${r.y + r.dy / 2 - 4}" font-size="10" text-anchor="middle" fill="${textColor}">${item.reason}</text>
      <text x="${r.x + r.dx / 2}" y="${r.y + r.dy / 2 + 10}" font-size="10" font-weight="700" text-anchor="middle" fill="${textColor}">${item.n} farmer(s) (${pctVal}%)</text>` : ""}
    `;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"></rect>
    ${rectsSvg}
  </svg>`;
}

function renderTreemapDiv(containerId, reasons, selectedReason, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) { return; }
  if (!reasons.length) {
    el.innerHTML = `<div class="empty-note">No non-adopters in the current filter selection.</div>`;
    return;
  }
  const top = reasons.slice(0, 12);
  const otherTotal = reasons.slice(12).reduce((a, r) => a + r.n, 0);
  const items = [...top];
  if (otherTotal > 0) items.push({ reason: "Other reasons", n: otherTotal });

  const totalAll = items.reduce((a, r) => a + r.n, 0);
  const W = 100, H = 60;
  const scale = (W * H) / totalAll;
  const sizes = items.map((r) => r.n * scale);
  const rects = squarifyJS(sizes, 0, 0, W, H);

  const divs = rects.map((r, i) => {
    const item = items[i];
    const pctVal = ((item.n / totalAll) * 100).toFixed(1);
    const color = item.reason === "Other reasons" ? "#CCCCCC" : TREEMAP_PALETTE[i % TREEMAP_PALETTE.length];
    const area = r.dx * r.dy;
    const isSelected = item.reason === selectedReason;
    const isDimmed = !!selectedReason && !isSelected;
    // A selected box gets a fixed, larger readable font regardless of its
    // own area (that's the point - small boxes are hard to read, so
    // "coming to front" also means "becoming legible"), plus a scale-up,
    // shadow and higher stacking order so it visually pops above its
    // (now-dimmed) neighbors instead of just gaining a border.
    const fontSize = isSelected ? 14 : (area > 60 ? 12 : area > 20 ? 10.5 : 9);
    const showLabel = isSelected || area > 8;
    const isClickable = item.reason !== "Other reasons";
    const boxStyle = [
      `position:absolute`,
      `left:${(r.x / W) * 100}%`, `top:${(r.y / H) * 100}%`,
      `width:${(r.dx / W) * 100}%`, `height:${(r.dy / H) * 100}%`,
      `background:${color}`,
      `border:${isSelected ? `3px solid ${COLORS.ink}` : "1px solid #fff"}`,
      `box-sizing:border-box`, `display:flex`, `align-items:center`, `justify-content:center`,
      `padding:4px`, `overflow:${isSelected ? "visible" : "hidden"}`, `text-align:center`,
      isClickable ? "cursor:pointer" : "",
      `opacity:${isDimmed ? 0.3 : 1}`,
      `transform:${isSelected ? "scale(1.12)" : "scale(1)"}`,
      `z-index:${isSelected ? 5 : 1}`,
      `box-shadow:${isSelected ? "0 8px 22px rgba(0,0,0,0.35)" : "none"}`,
      `transition:opacity 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease`,
    ].filter(Boolean).join(";");
    return `
      <div data-reason-index="${i}" style="${boxStyle}">
        ${showLabel ? `<span style="font-size:${fontSize}px; color:${(isSelected || area > 150) ? (isSelected ? COLORS.ink : "#fff") : COLORS.ink}; line-height:1.3; ${isSelected ? `background:${color}; padding:6px 8px; border-radius:3px;` : ""}">${item.reason}<br><strong>${item.n} farmer(s) (${pctVal}%)</strong></span>` : ""}
      </div>`;
  }).join("");

  el.innerHTML = `<div style="position:relative; width:100%; height:100%;">${divs}</div>`;

  if (onSelect) {
    el.querySelectorAll("[data-reason-index]").forEach((div) => {
      const idx = parseInt(div.getAttribute("data-reason-index"), 10);
      const item = items[idx];
      if (item.reason === "Other reasons") return;
      div.addEventListener("click", () => onSelect(item.reason));
    });
  }
}

// Drill-down table shown under the treemap: every farmer/practice pair
// behind the currently-selected reason category, so a summary box can be
// traced back to individual farmers and the specific practice they cited
// it for.
function renderReasonDrilldown(containerId, nonAdoptionRecords, selectedReason, day) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!selectedReason) { el.innerHTML = ""; return; }

  const rows = nonAdoptionRecords
    .filter((r) => r.reasonCategory === selectedReason)
    .sort((a, b) => a.farmerName.localeCompare(b.farmerName) || a.shortLabel.localeCompare(b.shortLabel));
  const farmerCount = uniqueFarmerCount(rows);

  el.innerHTML = `
    <div class="panel" style="border:1px solid var(--line);">
      <h2 style="font-size:15px;">${selectedReason} - ${farmerCount} farmer(s), ${rows.length} practice-level instance(s)</h2>
      ${rows.length ? `
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>Farmer</th><th>Organization</th><th>County</th><th>Tenure</th><th>Practice</th><th>Narrative</th></tr></thead>
            <tbody>
              ${rows.map((r) => `<tr><td>${farmerNameCell(r.farmerName)}</td><td>${r.organization}</td><td>${r.county}</td><td>${r.tenure}</td><td>${r.shortLabel}</td><td>${r.narrative || "-"}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div class="table-footer">
          <button class="btn" id="export-drill-${day}">Export list (CSV)</button>
          <button class="btn" id="close-drill-${day}">Close</button>
        </div>
      ` : `
        <div class="empty-note">No records for this reason under the current filters.</div>
        <div class="table-footer"><button class="btn" id="close-drill-${day}">Close</button></div>
      `}
    </div>
  `;
  el.querySelector(`#close-drill-${day}`).addEventListener("click", () => {
    STATE.selectedReason[day] = null;
    renderMain();
  });
  if (rows.length) {
    el.querySelector(`#export-drill-${day}`).addEventListener("click", () => {
      passwordGatedDownload(rows, [
        { label: "Farmer", get: (r) => r.farmerName },
        { label: "Organization", get: (r) => r.organization },
        { label: "County", get: (r) => r.county },
        { label: "Tenure", get: (r) => r.tenure },
        { label: "Practice", get: (r) => r.shortLabel },
        { label: "Narrative", get: (r) => r.narrative || "" },
      ], `day${day}_${selectedReason.replace(/[^a-z0-9]+/gi, "_")}_reason_detail.csv`);
    });
  }
}

function openLightbox(src) {
  const lb = document.getElementById("lightbox");
  document.getElementById("lightboxImg").src = src;
  lb.classList.add("active");
}
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("lightbox").addEventListener("click", () => {
    document.getElementById("lightbox").classList.remove("active");
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  document.getElementById("generatedDate").textContent = "Generated " + new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  document.getElementById("dataSourceNote").textContent = DASHBOARD_DATA.generatedNote || "";
  renderNameLockControl();
  renderTabs();
  renderMain();
  // Close any open multi-select filter dropdown on an outside click - the
  // toolbar itself is rebuilt on every renderMain(), so this one listener
  // (attached once, here) covers every day's dropdowns rather than needing
  // re-attachment on each rebuild.
  document.addEventListener("click", (e) => {
    if (STATE.openMultiSelect && !e.target.closest(".multiselect")) {
      STATE.openMultiSelect = null;
      renderMain();
    }
  });
}
document.addEventListener("DOMContentLoaded", init);
