// ============================================================================
// app.js - Farmer Practice Adoption Dashboard
// Reads DASHBOARD_DATA (from dashboard_data.js) and renders an Overview tab
// plus one filterable tab per day.
// ============================================================================

const DOWNLOAD_PASSWORD = "Kenya_AE_Hub@2026";

const STATE = {
  activeTab: "overview",
  filters: {}, // keyed by day number -> {organization, county, farmerSearch, practice, baselineStatus, endlineStatus}
  sort: {},    // keyed by day number -> {col, dir}
  charts: {},  // keyed by canvas id -> Chart.js instance, so we can destroy before redraw
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
};

function defaultFilters() {
  return {
    organization: "All",
    county: "All",
    farmerSearch: "",
    practice: "All",
    tenure: "All",
    baselineStatus: "All",
    endlineStatus: "All",
  };
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
    if (f.organization !== "All" && r.organization !== f.organization) return false;
    if (f.county !== "All" && r.county !== f.county) return false;
    if (f.farmerSearch && !r.farmerName.toLowerCase().includes(f.farmerSearch.toLowerCase())) return false;
    if (f.practice !== "All" && r.question !== f.practice) return false;
    if (f.tenure !== "All" && r.tenure !== f.tenure) return false;
    if (f.baselineStatus !== "All") {
      const want = f.baselineStatus === "Doing" ? 1 : 0;
      if (r.baseline !== want) return false;
    }
    if (f.endlineStatus !== "All") {
      const want = f.endlineStatus === "Doing" ? 1 : 0;
      if (r.endline !== want) return false;
    }
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
    if (!byQ.has(r.question)) byQ.set(r.question, { label: r.shortLabel, base: [], end: [] });
    byQ.get(r.question).base.push(r.baseline);
    byQ.get(r.question).end.push(r.endline);
  });
  const out = [];
  byQ.forEach((v, q) => {
    const baseAvg = pct(v.base.reduce((a, b) => a + b, 0), v.base.length);
    const endAvg = pct(v.end.reduce((a, b) => a + b, 0), v.end.length);
    out.push({ question: q, label: v.label, basePct: baseAvg, endPct: endAvg, change: endAvg - baseAvg, n: v.base.length });
  });
  out.sort((a, b) => b.change - a.change);
  return out;
}

function reasonCounts(records) {
  const notDoing = records.filter((r) => r.endline === 0 && r.reasonCategory);
  const counts = new Map();
  notDoing.forEach((r) => counts.set(r.reasonCategory, (counts.get(r.reasonCategory) || 0) + 1));
  return Array.from(counts.entries())
    .map(([reason, n]) => ({ reason, n }))
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

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function renderTabs() {
  const nav = document.getElementById("tabNav");
  nav.innerHTML = "";
  const tabs = [{ id: "overview", label: "Overview" }, ...DASHBOARD_DATA.days.map((d) => ({ id: `day${d.day}`, label: d.title }))];
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
  if (STATE.activeTab === "overview") {
    main.appendChild(buildOverviewView());
  } else {
    const day = parseInt(STATE.activeTab.replace("day", ""), 10);
    main.appendChild(buildDayView(day));
  }
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------
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
    ${kpiCard("Unique Farmers (All Days)", overall.nUniqueFarmersTotal, "Deduplicated by Name + Organization + County", "green")}
    ${kpiCard("Found at Endline (Any Day)", overall.nUniqueFoundEndlineAny, "At least one day they took part in", "green")}
    ${kpiCard("Never Found at Endline", overall.nUniqueNotFoundEndlineAny, "Across every day they took part in", "rust")}
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

  wrap.appendChild(buildDownloadPanel());
  return wrap;
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
  const f = STATE.filters[day];

  const wrap = document.createElement("section");
  wrap.className = "view active";

  // --- Toolbar ---
  // Organization/County/Tenure options are narrowed by whichever of the
  // other identity filters (org/county/name/tenure) are already set, so
  // picking a County only offers Organizations that actually appear there,
  // and vice versa, instead of always listing every value in the day.
  function optionsFor(field) {
    const scoped = allRecords.filter((r) => {
      if (field !== "organization" && f.organization !== "All" && r.organization !== f.organization) return false;
      if (field !== "county" && f.county !== "All" && r.county !== f.county) return false;
      if (field !== "tenure" && f.tenure !== "All" && r.tenure !== f.tenure) return false;
      if (f.farmerSearch && !r.farmerName.toLowerCase().includes(f.farmerSearch.toLowerCase())) return false;
      return true;
    });
    return distinctSorted(scoped, field);
  }
  // If a previous selection is no longer valid given the other filters
  // (e.g. County narrowed Organization down to a list that no longer
  // includes the chosen org), reset it to "All" rather than showing a
  // dead-end selection.
  let orgChoices = optionsFor("organization");
  if (f.organization !== "All" && !orgChoices.includes(f.organization)) f.organization = "All";
  let countyChoices = optionsFor("county");
  if (f.county !== "All" && !countyChoices.includes(f.county)) f.county = "All";
  let tenureChoices = optionsFor("tenure");
  if (f.tenure !== "All" && !tenureChoices.includes(f.tenure)) f.tenure = "All";

  const orgs = ["All", ...orgChoices];
  const counties = ["All", ...countyChoices];
  const practices = [["All", "All Practices"], ...distinctQuestions(allRecords)];
  const tenureOptions = ["All", ...tenureChoices];

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.innerHTML = `
    <div class="field">
      <label for="f-org-${day}">Organization</label>
      <select id="f-org-${day}">${orgs.map((o) => `<option ${o === f.organization ? "selected" : ""}>${o}</option>`).join("")}</select>
    </div>
    <div class="field">
      <label for="f-county-${day}">County</label>
      <select id="f-county-${day}">${counties.map((c) => `<option ${c === f.county ? "selected" : ""}>${c}</option>`).join("")}</select>
    </div>
    <div class="field">
      <label for="f-name-${day}">Farmer name</label>
      <input id="f-name-${day}" type="text" placeholder="Search name..." value="${f.farmerSearch}">
    </div>
    <div class="field">
      <label for="f-tenure-${day}">Tenure</label>
      <select id="f-tenure-${day}">${tenureOptions.map((t) => `<option ${t === f.tenure ? "selected" : ""}>${t}</option>`).join("")}</select>
    </div>
    <div class="field">
      <label for="f-practice-${day}">Practice</label>
      <select id="f-practice-${day}">${practices.map(([q, label]) => `<option value="${q}" ${q === f.practice ? "selected" : ""}>${label}</option>`).join("")}</select>
    </div>
    <div class="field">
      <label for="f-base-${day}">Baseline status</label>
      <select id="f-base-${day}" ${f.practice === "All" ? "disabled" : ""}>
        ${["All", "Doing", "Not doing"].map((s) => `<option ${s === f.baselineStatus ? "selected" : ""}>${s}</option>`).join("")}
      </select>
    </div>
    <div class="field">
      <label for="f-end-${day}">Endline status</label>
      <select id="f-end-${day}" ${f.practice === "All" ? "disabled" : ""}>
        ${["All", "Doing", "Not doing"].map((s) => `<option ${s === f.endlineStatus ? "selected" : ""}>${s}</option>`).join("")}
      </select>
    </div>
    <button class="btn reset-btn" id="reset-${day}">Reset filters</button>
  `;
  wrap.appendChild(toolbar);

  toolbar.querySelector(`#f-org-${day}`).addEventListener("change", (e) => { f.organization = e.target.value; renderMain(); });
  toolbar.querySelector(`#f-county-${day}`).addEventListener("change", (e) => { f.county = e.target.value; renderMain(); });
  toolbar.querySelector(`#f-name-${day}`).addEventListener("input", (e) => { f.farmerSearch = e.target.value; renderMain(); });
  toolbar.querySelector(`#f-tenure-${day}`).addEventListener("change", (e) => { f.tenure = e.target.value; renderMain(); });
  toolbar.querySelector(`#f-practice-${day}`).addEventListener("change", (e) => { f.practice = e.target.value; renderMain(); });
  toolbar.querySelector(`#f-base-${day}`).addEventListener("change", (e) => { f.baselineStatus = e.target.value; renderMain(); });
  toolbar.querySelector(`#f-end-${day}`).addEventListener("change", (e) => { f.endlineStatus = e.target.value; renderMain(); });
  toolbar.querySelector(`#reset-${day}`).addEventListener("click", () => { STATE.filters[day] = defaultFilters(); renderMain(); });

  // --- KPIs ---
  // Org/county/name/tenure filters narrow the farmer pool; baseline/endline
  // status filters only make sense once a single practice is selected.
  const coreFiltered = allRecords.filter((r) => {
    if (f.organization !== "All" && r.organization !== f.organization) return false;
    if (f.county !== "All" && r.county !== f.county) return false;
    if (f.farmerSearch && !r.farmerName.toLowerCase().includes(f.farmerSearch.toLowerCase())) return false;
    if (f.tenure !== "All" && r.tenure !== f.tenure) return false;
    return true;
  });
  // Same as coreFiltered but ignoring the Tenure dropdown - used only by the
  // New-vs-Old comparison chart, which always needs both groups present.
  const orgCountyNameFiltered = allRecords.filter((r) => {
    if (f.organization !== "All" && r.organization !== f.organization) return false;
    if (f.county !== "All" && r.county !== f.county) return false;
    if (f.farmerSearch && !r.farmerName.toLowerCase().includes(f.farmerSearch.toLowerCase())) return false;
    return true;
  });
  const fullyFiltered = applyFilters(allRecords, f);

  const kpiRow = document.createElement("div");
  kpiRow.className = "kpi-row";
  kpiRow.innerHTML = `
    ${kpiCard("Farmers at Baseline", meta.nBaselineSurveyed, "Whole-day survey attendance", "navy")}
    ${kpiCard("Farmers at Endline", meta.nEndlineSurveyed, "Whole-day survey attendance", "navy")}
    ${kpiCard("Not Found at Endline", meta.nNotFoundEndline, "Surveyed at baseline only", "rust")}
    ${kpiCard("Matched in Charts", meta.nMatched, "Complete baseline + endline data", "green")}
    ${kpiCard("Currently Filtered", uniqueFarmerCount(coreFiltered), "Farmers matching org/county/name/tenure filters", "ochre")}
  `;
  wrap.appendChild(kpiRow);

  // --- Main content: All Practices vs single-practice drill-down ---
  if (f.practice === "All") {
    wrap.appendChild(buildAllPracticesPanel(day, coreFiltered));
  } else {
    wrap.appendChild(buildPracticeDrilldownPanel(day, f, coreFiltered, fullyFiltered));
  }

  // --- Advanced views: live alluvial + treemap (respect filters above) and
  // the New-vs-Old tenure comparison (ignores the Tenure dropdown itself) ---
  wrap.appendChild(buildAdvancedViewsPanel(day, coreFiltered, orgCountyNameFiltered, f));

  return wrap;
}

function buildAllPracticesPanel(day, records) {
  const panel = document.createElement("div");
  panel.className = "panel";
  const summary = summarizeByPractice(records);

  panel.innerHTML = `
    <h2>All Practices: Baseline vs Endline</h2>
    <div class="panel-sub">Filtered by organization/county/name above. Select a specific practice in the toolbar to drill into farmer-level detail and reasons for non-adoption.</div>
    <div class="two-col">
      <div class="chart-wrap" style="height:${Math.max(320, summary.length * 34)}px;"><canvas id="dumbbell-${day}"></canvas></div>
      <div class="chart-wrap" style="height:${Math.max(320, summary.length * 34)}px;"><canvas id="quadrant-${day}"></canvas></div>
    </div>
  `;
  setTimeout(() => {
    renderDumbbellChart(`dumbbell-${day}`, summary);
    renderQuadrantChart(`quadrant-${day}`, summary);
  }, 0);
  return panel;
}

function renderDumbbellChart(canvasId, summary) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const sorted = [...summary].sort((a, b) => a.change - b.change);
  STATE.charts[canvasId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: sorted.map((s) => s.label),
      datasets: [
        {
          label: "Baseline to Endline range",
          data: sorted.map((s) => [Math.min(s.basePct, s.endPct), Math.max(s.basePct, s.endPct)]),
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
        title: { display: true, text: "Baseline vs Endline (% of farmers)", font: { size: 13 } },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const s = sorted[ctx.dataIndex];
              return `Baseline ${s.basePct.toFixed(1)}%  ->  Endline ${s.endPct.toFixed(1)}%  (${s.change >= 0 ? "+" : ""}${s.change.toFixed(1)} pp)`;
            },
          },
        },
      },
      scales: { x: { min: 0, max: 100, title: { display: true, text: "% of farmers" } } },
    },
  });
}

function renderQuadrantChart(canvasId, summary) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  STATE.charts[canvasId] = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Practices",
          data: summary.map((s) => ({ x: s.basePct, y: s.endPct, label: s.label, change: s.change })),
          backgroundColor: summary.map((s) => (s.change >= 0 ? COLORS.green : COLORS.rust)),
          pointRadius: 7,
          pointHoverRadius: 9,
        },
        {
          label: "No change",
          data: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
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
        title: { display: true, text: "Baseline % vs Endline % (above line = improved)", font: { size: 13 } },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const d = ctx.raw;
              if (!d.label) return "";
              return `${d.label}: ${d.x.toFixed(1)}% -> ${d.y.toFixed(1)}%`;
            },
          },
        },
      },
      scales: {
        x: { min: 0, max: 100, title: { display: true, text: "Baseline %" } },
        y: { min: 0, max: 100, title: { display: true, text: "Endline %" } },
      },
    },
  });
}

function buildPracticeDrilldownPanel(day, f, orgCountyNameFiltered, fullyFiltered) {
  const practiceRecords = orgCountyNameFiltered.filter((r) => r.question === f.practice);
  const baseYes = practiceRecords.filter((r) => r.baseline === 1).length;
  const endYes = practiceRecords.filter((r) => r.endline === 1).length;
  const total = practiceRecords.length;
  const label = practiceRecords[0] ? practiceRecords[0].shortLabel : f.practice;
  const questionText = practiceRecords[0] ? practiceRecords[0].questionText : "";
  const reasons = reasonCounts(practiceRecords);

  const container = document.createElement("div");

  const summaryPanel = document.createElement("div");
  summaryPanel.className = "panel";
  summaryPanel.innerHTML = `
    <h2>${label}</h2>
    <div class="panel-sub">${questionText}</div>
    <div class="kpi-row" style="margin-bottom:0;">
      ${kpiCard("Baseline: Doing", `${pct(baseYes, total).toFixed(1)}%`, `${baseYes} of ${total} farmers`, "navy")}
      ${kpiCard("Endline: Doing", `${pct(endYes, total).toFixed(1)}%`, `${endYes} of ${total} farmers`, "green")}
      ${kpiCard("Change", `${(pct(endYes, total) - pct(baseYes, total)).toFixed(1)} pp`, endYes >= baseYes ? "Improved" : "Declined", endYes >= baseYes ? "green" : "rust")}
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
    if (reasons.length) renderReasonChart(`reasons-${day}`, reasons);
  }, 0);

  return container;
}

function renderReasonChart(canvasId, reasons) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  STATE.charts[canvasId] = new Chart(ctx, {
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
    { key: "reasonCategory", label: "Reason (if not doing)" },
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
                <td>${r.farmerName}</td>
                <td>${r.organization}</td>
                <td>${r.county}</td>
                <td><span class="status-pill ${r.baseline === 1 ? "status-yes" : "status-no"}">${r.baseline === 1 ? "Doing" : "Not doing"}</span></td>
                <td><span class="status-pill ${r.endline === 1 ? "status-yes" : "status-no"}">${r.endline === 1 ? "Doing" : "Not doing"}</span></td>
                <td>${r.reasonCategory || "-"}</td>
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
      downloadCSV(sorted, [
        { label: "Farmer", get: (r) => r.farmerName },
        { label: "Organization", get: (r) => r.organization },
        { label: "County", get: (r) => r.county },
        { label: "Practice", get: (r) => r.shortLabel },
        { label: "Baseline", get: (r) => (r.baseline === 1 ? "Doing" : "Not doing") },
        { label: "Endline", get: (r) => (r.endline === 1 ? "Doing" : "Not doing") },
        { label: "Reason", get: (r) => r.reasonCategory || "" },
      ], `day${day}_${f.practice}_filtered.csv`);
    });
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Advanced views: live alluvial + treemap (both respect the filters above)
// and the New-vs-Old tenure comparison (replaces the old "featured practice"
// alluvial; always shows both tenure groups regardless of the Tenure filter)
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

// When "All Practices" is selected, coreFiltered has one row per
// farmer-per-question, so feeding it straight into computeTransitionsJS
// would count the same farmer once per practice (e.g. 14x on Day 1). This
// collapses to one row per farmer: baseline/endline = 1 if that farmer was
// doing ANY practice at that round, 0 if they were doing none.
function collapseToFarmerLevel(records) {
  const byFarmer = new Map();
  records.forEach((r) => {
    const key = farmerKey(r);
    if (!byFarmer.has(key)) byFarmer.set(key, { baseline: 0, endline: 0 });
    const bucket = byFarmer.get(key);
    if (r.baseline === 1) bucket.baseline = 1;
    if (r.endline === 1) bucket.endline = 1;
  });
  return Array.from(byFarmer.values());
}

function buildAdvancedViewsPanel(day, coreFiltered, orgCountyNameFiltered, f) {
  const container = document.createElement("div");

  // --- Live alluvial: one row per farmer. For a single practice, each
  // farmer already has exactly one row. For "All Practices" combined, each
  // farmer is collapsed first so they're counted once (not once per
  // practice), per the "adopted at least one practice" definition. ---
  const alluvialSource = f.practice === "All"
    ? collapseToFarmerLevel(coreFiltered)
    : coreFiltered.filter((r) => r.question === f.practice);
  const alluvialPanel = document.createElement("div");
  alluvialPanel.className = "panel";
  const alluvialTitle = f.practice === "All" ? "all practices combined" : (coreFiltered.find((r) => r.question === f.practice) || {}).shortLabel || f.practice;
  const alluvialNote = f.practice === "All"
    ? "Each farmer is counted once here: \u201cDoing\u201d means doing at least one of this day's practices. Reflects the organization/county/name/tenure filters above."
    : "Reflects the organization/county/name/tenure filters above.";
  alluvialPanel.innerHTML = `
    <h2>Farmer Transitions: ${alluvialTitle}</h2>
    <div class="panel-sub">${alluvialNote} Change the Practice dropdown to switch between all practices combined and a single practice.</div>
    <div id="alluvial-${day}" style="min-height:300px;"></div>
  `;
  container.appendChild(alluvialPanel);
  setTimeout(() => renderAlluvialSVG(`alluvial-${day}`, computeTransitionsJS(alluvialSource)), 0);

  // --- New vs Old tenure comparison (replaces the old featured-practice view) ---
  const tenurePanel = document.createElement("div");
  tenurePanel.className = "panel";
  const tenureSummary = summarizeByPracticeAndTenure(orgCountyNameFiltered);
  const unknownCount = uniqueFarmerCount(orgCountyNameFiltered.filter((r) => r.tenure === "Unknown"));
  tenurePanel.innerHTML = `
    <h2>Practice Adoption: New vs Old Farmers</h2>
    <div class="panel-sub">
      New = 1.5 years or less with the organization, Old = more than 1.5 years (from Farmer_Membership records).
      Reflects organization/county/name filters above, but ignores the Tenure filter since both groups are always shown here.
      ${unknownCount > 0 ? `${unknownCount} farmer(s) with unknown tenure are excluded from this chart.` : ""}
    </div>
    <div class="chart-wrap" style="height:${Math.max(360, tenureSummary.length * 46)}px;"><canvas id="tenure-compare-${day}"></canvas></div>
  `;
  container.appendChild(tenurePanel);
  setTimeout(() => renderTenureComparisonChart(`tenure-compare-${day}`, tenureSummary), 0);

  // --- Live treemap of reasons (all practices, respects filters above) ---
  const treemapPanel = document.createElement("div");
  treemapPanel.className = "panel";
  const reasons = reasonCounts(coreFiltered);
  treemapPanel.innerHTML = `
    <h2>Reasons for Non-Adoption (All Practices)</h2>
    <div class="panel-sub">Reflects the organization/county/name/tenure filters above. Box size = number of farmer-practice instances.</div>
    <div id="treemap-${day}" style="position:relative; height:420px; border:1px solid var(--line); border-radius:4px; overflow:hidden;"></div>
  `;
  container.appendChild(treemapPanel);
  setTimeout(() => renderTreemapDiv(`treemap-${day}`, reasons), 0);

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
    out.push({
      question: q,
      label: v.label,
      newBasePct: pct(v.New.base.reduce((a, b) => a + b, 0), v.New.base.length),
      newEndPct: pct(v.New.end.reduce((a, b) => a + b, 0), v.New.end.length),
      oldBasePct: pct(v.Old.base.reduce((a, b) => a + b, 0), v.Old.base.length),
      oldEndPct: pct(v.Old.end.reduce((a, b) => a + b, 0), v.Old.end.length),
      newN: v.New.base.length,
      oldN: v.Old.base.length,
    });
  });
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function renderTenureComparisonChart(canvasId, summary) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const labels = summary.map((s) => s.label);
  const mk = (field, stack, color) => ({
    label: "_", stack, backgroundColor: color, data: summary.map((s) => s[field]),
  });

  STATE.charts[canvasId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { ...mk("newBasePct", "newBase", COLORS.green), label: "New: Doing" },
        { stack: "newBase", backgroundColor: COLORS.greenSoft, data: summary.map((s) => 100 - s.newBasePct), label: "New: Not doing" },
        { ...mk("newEndPct", "newEnd", COLORS.green), label: "_New doing 2" },
        { stack: "newEnd", backgroundColor: COLORS.greenSoft, data: summary.map((s) => 100 - s.newEndPct), label: "_New not doing 2" },
        { ...mk("oldBasePct", "oldBase", COLORS.ochre), label: "Old: Doing" },
        { stack: "oldBase", backgroundColor: COLORS.ochreSoft, data: summary.map((s) => 100 - s.oldBasePct), label: "Old: Not doing" },
        { ...mk("oldEndPct", "oldEnd", COLORS.ochre), label: "_Old doing 2" },
        { stack: "oldEnd", backgroundColor: COLORS.ochreSoft, data: summary.map((s) => 100 - s.oldEndPct), label: "_Old not doing 2" },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: "Left to right within each practice: New-Baseline, New-Endline, Old-Baseline, Old-Endline", font: { size: 12 }, position: "bottom" },
        legend: {
          labels: { filter: (item) => !item.text.startsWith("_") },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.label.startsWith("_")) return null;
              return `${ctx.dataset.label}: ${ctx.raw.toFixed(1)}%`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, min: 0, max: 100, title: { display: true, text: "% of farmers" } },
        y: { stacked: true },
      },
    },
  });
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
      ${ribbon(lSPb, lSPt, rSPb, rSPt, COLORS.rust)}
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
      <span><span style="display:inline-block;width:10px;height:10px;background:${COLORS.rust};margin-right:5px;"></span>Stopped doing (${t.stopped})</span>
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

function renderTreemapDiv(containerId, reasons) {
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
    const fontSize = area > 60 ? 12 : area > 20 ? 10.5 : 9;
    const showLabel = area > 8;
    return `
      <div style="position:absolute; left:${(r.x / W) * 100}%; top:${(r.y / H) * 100}%; width:${(r.dx / W) * 100}%; height:${(r.dy / H) * 100}%;
                  background:${color}; border:1px solid #fff; box-sizing:border-box; display:flex; align-items:center; justify-content:center;
                  padding:4px; overflow:hidden; text-align:center;">
        ${showLabel ? `<span style="font-size:${fontSize}px; color:${area > 150 ? "#fff" : COLORS.ink}; line-height:1.25;">${item.reason}<br><strong>${item.n} (${pctVal}%)</strong></span>` : ""}
      </div>`;
  }).join("");

  el.innerHTML = `<div style="position:relative; width:100%; height:100%;">${divs}</div>`;
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
  renderTabs();
  renderMain();
}
document.addEventListener("DOMContentLoaded", init);
