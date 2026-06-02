window.addEventListener("error", (event) => {
  const errorBox = document.querySelector("#app-error");
  if (errorBox) errorBox.textContent = `App error: ${event.message}`;
});

const STORAGE_KEY = "nms-state-v1";
const LOGIN_DISABLED = true;

const TESTS = [
  { id: "eeg", label: "EEG", group: "EEG" },
  { id: "ncvSingle", label: "NCV / NCS Single Limb", group: "NCV / NCS" },
  { id: "ncvBoth", label: "NCV / NCS Both Upper + Lower Limb", group: "NCV / NCS" },
  { id: "vep", label: "VEP", group: "VEP" },
  { id: "bera", label: "BERA", group: "BERA" }
];

const DEFAULT_STATE = {
  session: null,
  settings: {
    financialLogicVersion: 2,
    centers: [
      {
        id: "neurology-clinic",
        name: "Neurology Clinic, Kadavanthara",
        tdsPercent: 0,
        technicianFee: 250,
        doctorFee: 0,
        prices: { eeg: 1500, ncvSingle: 1300, ncvBoth: 1900, vep: 1300, bera: 1300 }
      },
      {
        id: "baselios",
        name: "Baselios Hospital, Kothamangalam",
        tdsPercent: 10,
        technicianFee: 250,
        doctorFee: 0,
        prices: { eeg: 980, ncvSingle: 850, ncvBoth: 1260, vep: 0, bera: 0 }
      },
      {
        id: "holy-family",
        name: "Holy Family Hospital, Thodupuzha",
        tdsPercent: 0,
        technicianFee: 0,
        doctorFee: 200,
        prices: { eeg: 980, ncvSingle: 840, ncvBoth: 1260, vep: 0, bera: 0 }
      },
      {
        id: "baby-memorial",
        name: "Baby Memorial Hospital, Thodupuzha",
        tdsPercent: 10,
        technicianFee: 0,
        doctorFee: 250,
        prices: { eeg: 924, ncvSingle: 792, ncvBoth: 1134, vep: 0, bera: 0 }
      }
    ]
  },
  users: [
    { id: crypto.randomUUID(), name: "Admin", email: "admin@nms.local", password: "admin123", role: "admin" },
    { id: crypto.randomUUID(), name: "Data Entry", email: "entry@nms.local", password: "entry123", role: "entry" }
  ],
  entries: [],
  reportHistory: [],
  userActivity: []
};

let state = loadState();
let currentDashboardTab = "daily";
let deferredInstallPrompt = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const money = (value) => `₹${(Number(value) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const todayISO = () => localDateISO(0);
const monthISO = () => todayISO().slice(0, 7);
const displayDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN");

function localDateISO(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return normalizeState(structuredClone(DEFAULT_STATE));
  try {
    const parsed = JSON.parse(saved);
    return normalizeState({ ...structuredClone(DEFAULT_STATE), ...parsed });
  } catch {
    return normalizeState(structuredClone(DEFAULT_STATE));
  }
}

function normalizeState(input) {
  const normalized = {
    ...structuredClone(DEFAULT_STATE),
    ...input,
    settings: {
      ...structuredClone(DEFAULT_STATE.settings),
      ...(input.settings || {})
    }
  };
  const defaultCenters = structuredClone(DEFAULT_STATE.settings.centers);
  const needsFinancialMigration = input.settings?.financialLogicVersion !== DEFAULT_STATE.settings.financialLogicVersion;
  normalized.settings.financialLogicVersion = DEFAULT_STATE.settings.financialLogicVersion;
  normalized.settings.centers = defaultCenters.map((defaultCenter) => {
    const savedCenter = normalized.settings.centers?.find((center) => center.id === defaultCenter.id) || {};
    if (needsFinancialMigration) return defaultCenter;
    return {
      ...defaultCenter,
      ...savedCenter,
      tdsPercent: savedCenter.tdsPercent ?? defaultCenter.tdsPercent,
      technicianFee: savedCenter.technicianFee ?? defaultCenter.technicianFee,
      doctorFee: savedCenter.doctorFee ?? defaultCenter.doctorFee,
      prices: {
        ...defaultCenter.prices,
        ...(savedCenter.prices || centerPricesFromLegacy(savedCenter.id, normalized.settings.prices))
      }
    };
  });
  normalized.entries = (normalized.entries || []).map((entry) => normalizeEntry(entry, normalized.settings));
  return normalized;
}

function centerPricesFromLegacy(centerId, legacyPrices = {}) {
  if (!legacyPrices || !Object.keys(legacyPrices).length) return {};
  return {
    eeg: legacyPrices.eeg,
    ncvSingle: legacyPrices.ncsUpper || legacyPrices.ncsLower || legacyPrices.ncsTwoLimb,
    ncvBoth: legacyPrices.ncsBoth,
    vep: centerId === "neurology-clinic" ? legacyPrices.vep : 0,
    bera: centerId === "neurology-clinic" ? legacyPrices.bera : 0
  };
}

function normalizeEntry(entry, settings = state.settings) {
  const quantities = migrateQuantities(entry.quantities || {});
  const overrides = migrateOverrides(entry.overrides || {});
  const hasCurrentCalculations = entry.financialLogicVersion === DEFAULT_STATE.settings.financialLogicVersion &&
    entry.calculations &&
    "grossIncome" in entry.calculations &&
    "tdsAmount" in entry.calculations &&
    "amountReceived" in entry.calculations &&
    "netProfit" in entry.calculations;
  const calculations = hasCurrentCalculations
    ? entry.calculations
    : calculateEntry({ centerId: entry.centerId, quantities, overrides }, settings);
  return { ...entry, financialLogicVersion: DEFAULT_STATE.settings.financialLogicVersion, quantities, overrides, calculations };
}

function migrateQuantities(quantities) {
  return {
    eeg: Number(quantities.eeg) || 0,
    ncvSingle: (Number(quantities.ncvSingle) || 0) + (Number(quantities.ncsTwoLimb) || 0) + (Number(quantities.ncsUpper) || 0) + (Number(quantities.ncsLower) || 0),
    ncvBoth: (Number(quantities.ncvBoth) || 0) + (Number(quantities.ncsBoth) || 0),
    vep: Number(quantities.vep) || 0,
    bera: Number(quantities.bera) || 0
  };
}

function migrateOverrides(overrides) {
  return {
    eeg: overrides.eeg ?? "",
    ncvSingle: overrides.ncvSingle ?? overrides.ncsTwoLimb ?? overrides.ncsUpper ?? overrides.ncsLower ?? "",
    ncvBoth: overrides.ncvBoth ?? overrides.ncsBoth ?? "",
    vep: overrides.vep ?? "",
    bera: overrides.bera ?? ""
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function centerById(id) {
  return state.settings.centers.find((center) => center.id === id);
}

function activeUser() {
  return state.users.find((user) => user.id === state.session?.userId);
}

function emptyQuantities() {
  return Object.fromEntries(TESTS.map((test) => [test.id, 0]));
}

function emptyOverrides() {
  return Object.fromEntries(TESTS.map((test) => [test.id, ""]));
}

function calculateEntry({ centerId, quantities, overrides }, settings = state.settings) {
  const center = settings.centers.find((item) => item.id === centerId) || settings.centers[0];
  const lines = TESTS.map((test) => {
    const quantity = Number(quantities[test.id]) || 0;
    const autoAmount = quantity * (Number(center.prices?.[test.id]) || 0);
    const overrideValue = overrides[test.id];
    const hasOverride = overrideValue !== "" && overrideValue !== null && !Number.isNaN(Number(overrideValue));
    const grossIncome = hasOverride ? Number(overrideValue) : autoAmount;
    const tdsAmount = grossIncome * ((Number(center.tdsPercent) || 0) / 100);
    const amountReceived = grossIncome - tdsAmount;
    return { ...test, quantity, autoAmount, grossIncome, tdsAmount, amountReceived, hasOverride };
  });
  const totalTests = lines.reduce((sum, line) => sum + line.quantity, 0);
  const grossIncome = lines.reduce((sum, line) => sum + line.grossIncome, 0);
  const tdsAmount = lines.reduce((sum, line) => sum + line.tdsAmount, 0);
  const amountReceived = lines.reduce((sum, line) => sum + line.amountReceived, 0);
  const technicianFee = totalTests * (Number(center.technicianFee) || 0);
  const doctorFee = totalTests * (Number(center.doctorFee) || 0);
  const netProfit = amountReceived - technicianFee - doctorFee;
  return {
    lines,
    totalTests,
    grossIncome,
    tdsAmount,
    amountReceived,
    technicianFee,
    doctorFee,
    netProfit,
    gross: grossIncome,
    net: netProfit
  };
}

function makeEntryPayload() {
  const quantities = {};
  const overrides = {};
  TESTS.forEach((test) => {
    quantities[test.id] = Number($(`#qty-${test.id}`).value) || 0;
    overrides[test.id] = $(`#override-${test.id}`).value;
  });
  const centerId = $("#entry-center").value;
  const date = $("#entry-date").value;
  const calculations = calculateEntry({ centerId, quantities, overrides });
  return { date, centerId, quantities, overrides, calculations };
}

function initialize() {
  setInitialDates();
  renderStaticControls();
  bindEvents();
  restoreSession();
  renderAll();
  registerServiceWorker();
}

function setInitialDates() {
  ["entry-date", "dash-date", "report-date"].forEach((id) => {
    $(`#${id}`).value = todayISO();
  });
  ["dash-start", "dash-end"].forEach((id) => {
    $(`#${id}`).value = todayISO();
  });
  ["dash-month", "report-month"].forEach((id) => {
    $(`#${id}`).value = monthISO();
  });
}

function renderStaticControls() {
  const defaultCenterId = state.settings.centers[0]?.id || "";
  const preserved = {
    entryCenter: $("#entry-center")?.value || defaultCenterId,
    dashCenter: $("#dash-center")?.value,
    reportCenter: $("#report-center")?.value,
    quantities: {},
    overrides: {}
  };
  TESTS.forEach((test) => {
    preserved.quantities[test.id] = $(`#qty-${test.id}`)?.value ?? 0;
    preserved.overrides[test.id] = $(`#override-${test.id}`)?.value ?? "";
  });
  const centerOptions = state.settings.centers.map((center) => `<option value="${center.id}">${center.name}</option>`).join("");
  $("#entry-center").value = preserved.entryCenter;
  $("#entry-center-buttons").innerHTML = state.settings.centers.map((center) => `
    <button class="institution-btn ${center.id === preserved.entryCenter ? "active" : ""}" type="button" data-entry-center="${center.id}" aria-pressed="${center.id === preserved.entryCenter}">
      ${center.name}
    </button>
  `).join("");
  $("#dash-center").innerHTML = `<option value="all">All centers</option>${centerOptions}`;
  $("#report-center").innerHTML = `<option value="all">All centers</option>${centerOptions}`;
  $("#test-entry-grid").innerHTML = TESTS.map((test) => `
    <div class="test-row" data-test-row="${test.id}">
      <div class="test-name">
        <strong>${test.label}</strong>
        <small>${test.group} pricing: <span id="price-${test.id}">${money(centerById($("#entry-center").value)?.prices?.[test.id] || 0)}</span></small>
      </div>
      <label>Quantity <input id="qty-${test.id}" min="0" type="number" value="0" inputmode="numeric" /></label>
      <label>Auto amount <input id="auto-${test.id}" type="text" value="${money(0)}" readonly /></label>
      <label>Override <input id="override-${test.id}" min="0" type="number" placeholder="Optional" inputmode="decimal" /></label>
    </div>
  `).join("");
  if (preserved.dashCenter) $("#dash-center").value = preserved.dashCenter;
  if (preserved.reportCenter) $("#report-center").value = preserved.reportCenter;
  TESTS.forEach((test) => {
    $(`#qty-${test.id}`).value = preserved.quantities[test.id] ?? 0;
    $(`#override-${test.id}`).value = preserved.overrides[test.id] ?? "";
  });
}

function bindEvents() {
  $("#login-form")?.addEventListener("submit", handleLogin);
  $("#logout-btn")?.addEventListener("click", logout);
  $("#entry-form").addEventListener("submit", saveEntry);
  $("#entry-form").addEventListener("input", renderEntrySummary);
  $("#entry-center-buttons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-entry-center]");
    if (!button) return;
    if ($("#entry-center").value === button.dataset.entryCenter) return;
    $("#entry-center").value = button.dataset.entryCenter;
    clearEntryAmounts();
    $("#save-message").textContent = "";
    updateInstitutionButtons();
    renderEntrySummary();
  });
  $$(".date-chip").forEach((button) => button.addEventListener("click", () => {
    $("#entry-date").value = localDateISO(Number(button.dataset.dateOffset) || 0);
    updateDateShortcuts();
  }));
  $("#entry-form").addEventListener("reset", () => setTimeout(renderEntrySummary, 0));
  $("#edit-entry-btn").addEventListener("click", loadSameDayEntry);
  $("#quick-print-btn").addEventListener("click", () => window.print());
  $("#print-report-btn").addEventListener("click", () => printReport("print"));
  $("#pdf-report-btn").addEventListener("click", () => printReport("save-pdf"));
  $("#download-report-btn").addEventListener("click", () => printReport("download-pdf"));
  $("#daily-whatsapp-btn").addEventListener("click", () => quickWhatsapp("daily"));
  $("#monthly-whatsapp-btn").addEventListener("click", () => quickWhatsapp("monthly"));
  $("#report-type").addEventListener("change", renderReports);
  ["report-date", "report-month", "report-start", "report-end", "report-center"].forEach((id) => {
    $(`#${id}`).addEventListener("change", renderReports);
  });
  ["dash-date", "dash-month", "dash-start", "dash-end", "dash-center"].forEach((id) => {
    $(`#${id}`).addEventListener("change", renderDashboard);
  });
  $("#history-search").addEventListener("input", renderHistory);
  $("#history-start").addEventListener("change", renderHistory);
  $("#history-end").addEventListener("change", renderHistory);
  $("#export-csv-btn").addEventListener("click", exportCsv);
  $("#pricing-form").addEventListener("submit", savePricing);
  $("#center-rules-form").addEventListener("submit", saveCenterRules);
  $("#user-form").addEventListener("submit", saveUser);
  $("#install-btn").addEventListener("click", installPwa);
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => showView(item.dataset.view)));
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
    currentDashboardTab = tab.dataset.dashboardTab;
    $$(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    renderDashboard();
  }));
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("#install-btn").classList.remove("hidden");
  });
}

function restoreSession() {
  if (!LOGIN_DISABLED && activeUser()) {
    showApp();
    return;
  }
  const admin = state.users.find((user) => user.role === "admin") || state.users[0];
  state.session = { userId: admin.id };
  saveState();
  showApp();
}

function handleLogin(event) {
  event.preventDefault();
  const email = $("#login-email").value.trim().toLowerCase();
  const password = $("#login-password").value;
  const user = state.users.find((candidate) => candidate.email.toLowerCase() === email && candidate.password === password);
  if (!user) {
    $("#login-error").textContent = "Invalid email or password.";
    return;
  }
  state.session = { userId: user.id };
  saveState();
  $("#login-error").textContent = "";
  showApp();
}

function logout() {
  if (LOGIN_DISABLED) {
    restoreSession();
    return;
  }
  state.session = null;
  saveState();
  $("#login-screen").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
}

function showApp() {
  const user = activeUser();
  $("#login-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  $("#current-user-name").textContent = user.name;
  $("#current-user-role").textContent = user.role === "admin" ? "Admin" : "Data Entry User";
  $$(".admin-only").forEach((element) => element.classList.toggle("hidden", user.role !== "admin"));
  $$('[data-view="reports"], [data-view="history"]').forEach((element) => element.classList.toggle("hidden", user.role !== "admin"));
  if (user.role !== "admin" && ["settings", "reports", "history"].includes($(".nav-item.active")?.dataset.view)) showView("entry");
  renderAll();
}

function showView(view) {
  if (view === "settings" && activeUser()?.role !== "admin") return;
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const titles = {
    entry: "Daily Entry",
    dashboard: "Analytics Dashboard",
    reports: "Reports and WhatsApp Sharing",
    history: "Historical Data",
    settings: "Settings and Admin"
  };
  $("#view-title").textContent = titles[view];
  renderAll();
}

function renderAll() {
  if (!activeUser()) return;
  renderStaticControls();
  renderEntrySummary();
  renderDashboard();
  renderReports();
  renderHistory();
  renderSettings();
}

function renderEntrySummary() {
  const center = centerById($("#entry-center").value) || state.settings.centers[0];
  if ($("#entry-center").value !== center.id) $("#entry-center").value = center.id;
  updateInstitutionButtons();
  updateDateShortcuts();
  TESTS.forEach((test) => {
    const qty = Number($(`#qty-${test.id}`)?.value) || 0;
    const auto = qty * (Number(center.prices?.[test.id]) || 0);
    const autoInput = $(`#auto-${test.id}`);
    const priceLabel = $(`#price-${test.id}`);
    if (autoInput) autoInput.value = money(auto);
    if (priceLabel) priceLabel.textContent = money(center.prices?.[test.id] || 0);
  });
  const payload = makeEntryPayload();
  $("#entry-summary").innerHTML = summaryRows(payload.calculations);
}

function updateDateShortcuts() {
  const selected = $("#entry-date").value;
  $$(".date-chip").forEach((button) => {
    const active = selected === localDateISO(Number(button.dataset.dateOffset) || 0);
    button.classList.toggle("active", active);
  });
}

function clearEntryAmounts() {
  TESTS.forEach((test) => {
    const quantity = $(`#qty-${test.id}`);
    const override = $(`#override-${test.id}`);
    if (quantity) quantity.value = 0;
    if (override) override.value = "";
  });
}

function updateInstitutionButtons() {
  const selected = $("#entry-center").value;
  $$("[data-entry-center]").forEach((button) => {
    const active = button.dataset.entryCenter === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function summaryRows(calc) {
  return [
    ["Total tests", calc.totalTests.toLocaleString("en-IN")],
    ["Gross Neurodiagnostics Income (Before TDS)", money(calc.grossIncome)],
    ["TDS amount", money(calc.tdsAmount)],
    ["Amount received after TDS", money(calc.amountReceived)],
    ["Technician fees", money(calc.technicianFee)],
    ["Doctor reporting fees", money(calc.doctorFee)],
    ["Final net profit", money(calc.netProfit)]
  ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("");
}

function saveEntry(event) {
  event.preventDefault();
  const payload = makeEntryPayload();
  if (!payload.date || !payload.centerId) return;
  const existingIndex = state.entries.findIndex((entry) => entry.date === payload.date && entry.centerId === payload.centerId);
  const record = {
    id: existingIndex >= 0 ? state.entries[existingIndex].id : crypto.randomUUID(),
    ...payload,
    financialLogicVersion: DEFAULT_STATE.settings.financialLogicVersion,
    savedAt: new Date().toISOString(),
    savedBy: activeUser().id
  };
  if (existingIndex >= 0) state.entries[existingIndex] = record;
  else state.entries.push(record);
  addActivity(existingIndex >= 0 ? "entry-updated" : "entry-created", { entryId: record.id, date: record.date, centerId: record.centerId });
  saveState();
  $("#save-message").textContent = `Saved ${centerById(payload.centerId).name} for ${displayDate(payload.date)}.`;
  renderAll();
}

function loadSameDayEntry() {
  const date = $("#entry-date").value;
  const centerId = $("#entry-center").value;
  const entry = state.entries.find((item) => item.date === date && item.centerId === centerId);
  if (!entry) {
    $("#save-message").textContent = "No saved entry found for that date and institution.";
    return;
  }
  TESTS.forEach((test) => {
    $(`#qty-${test.id}`).value = entry.quantities[test.id] || 0;
    $(`#override-${test.id}`).value = entry.overrides[test.id] ?? "";
  });
  $("#save-message").textContent = "Entry loaded for editing.";
  renderEntrySummary();
}

function aggregateEntries(entries) {
  const numericKeys = ["totalTests", "grossIncome", "tdsAmount", "amountReceived", "technicianFee", "doctorFee", "netProfit"];
  const totals = {
    totalTests: 0,
    grossIncome: 0,
    tdsAmount: 0,
    amountReceived: 0,
    technicianFee: 0,
    doctorFee: 0,
    netProfit: 0,
    tests: emptyQuantities(),
    centers: Object.fromEntries(state.settings.centers.map((center) => [center.id, emptyAggregate()]))
  };
  entries.forEach((entry) => {
    const calc = entry.calculations;
    numericKeys.forEach((key) => {
      totals[key] += calc[key] || 0;
    });
    TESTS.forEach((test) => {
      totals.tests[test.id] += Number(entry.quantities[test.id]) || 0;
    });
    const centerTotal = totals.centers[entry.centerId] || emptyAggregate();
    numericKeys.forEach((key) => {
      centerTotal[key] += calc[key] || 0;
    });
    TESTS.forEach((test) => {
      centerTotal.tests[test.id] += Number(entry.quantities[test.id]) || 0;
    });
    totals.centers[entry.centerId] = centerTotal;
  });
  totals.gross = totals.grossIncome;
  totals.net = totals.netProfit;
  return totals;
}

function emptyAggregate() {
  return {
    totalTests: 0,
    grossIncome: 0,
    tdsAmount: 0,
    amountReceived: 0,
    technicianFee: 0,
    doctorFee: 0,
    netProfit: 0,
    tests: emptyQuantities()
  };
}

function entriesFor({ date, month, weekDate, centerId, start, end }) {
  const week = weekDate ? weekBounds(weekDate) : null;
  return state.entries.filter((entry) => {
    const inDate = !date || entry.date === date;
    const inMonth = !month || entry.date.startsWith(month);
    const inWeek = !week || (entry.date >= week.start && entry.date <= week.end);
    const inCenter = !centerId || centerId === "all" || entry.centerId === centerId;
    const inStart = !start || entry.date >= start;
    const inEnd = !end || entry.date <= end;
    return inDate && inMonth && inWeek && inCenter && inStart && inEnd;
  });
}

function weekBounds(dateIso) {
  const date = new Date(`${dateIso}T00:00:00`);
  const day = date.getDay() || 7;
  const start = new Date(date);
  start.setDate(date.getDate() - day + 1);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function renderDashboard() {
  const centerId = $("#dash-center").value;
  let entries;
  if (currentDashboardTab === "daily") {
    entries = entriesFor({ date: $("#dash-date").value, centerId });
  } else if (currentDashboardTab === "weekly") {
    entries = entriesFor({ weekDate: $("#dash-date").value, centerId });
  } else if (currentDashboardTab === "monthly") {
    entries = entriesFor({ month: $("#dash-month").value, centerId });
  } else if (currentDashboardTab === "range") {
    entries = entriesFor({ start: $("#dash-start").value, end: $("#dash-end").value, centerId });
  } else {
    const selectedCenter = centerId === "all" ? state.settings.centers[0].id : centerId;
    entries = entriesFor({ centerId: selectedCenter });
  }
  const totals = aggregateEntries(entries);
  $("#dashboard-content").innerHTML = `
    ${renderMetricCards(totals)}
    <div class="dashboard-grid">
      ${renderCenterCards(totals)}
      <section class="panel dashboard-wide"><div class="panel-head compact"><h3>Technician Salary Report</h3></div>${technicianSalaryReport(entries, totals)}</section>
      <section class="panel"><div class="panel-head compact"><h3>Revenue by Center</h3></div>${barChart(centerValues(totals, "grossIncome"), money, "teal")}</section>
      <section class="panel"><div class="panel-head compact"><h3>Test Volume by Center</h3></div>${barChart(centerValues(totals, "totalTests"), numberFormat, "blue")}</section>
      <section class="panel"><div class="panel-head compact"><h3>Test Category Mix</h3></div>${barChart(testValues(totals), numberFormat, "amber")}</section>
      <section class="panel"><div class="panel-head compact"><h3>Profit Trend</h3></div>${barChart(trendValues(entries, "netProfit"), money, "green")}</section>
      <section class="panel"><div class="panel-head compact"><h3>Monthly Trend</h3></div>${barChart(trendValues(entries, "grossIncome"), money, "teal")}</section>
    </div>
  `;
}

function renderMetricCards(totals) {
  const cards = [
    ["Total tests", numberFormat(totals.totalTests)],
    ["Gross income before TDS", money(totals.grossIncome)],
    ["TDS deducted", money(totals.tdsAmount)],
    ["Amount received after TDS", money(totals.amountReceived)],
    ["Technician fees", money(totals.technicianFee)],
    ["Doctor reporting fees", money(totals.doctorFee)],
    ["Final net profit", money(totals.netProfit)]
  ];
  return `<div class="metrics-grid">${cards.map(([label, value]) => `<article class="metric-card"><span>${label}</span><strong>${value}</strong></article>`).join("")}</div>`;
}

function renderCenterCards(totals) {
  return state.settings.centers.map((center) => {
    const value = totals.centers[center.id] || emptyAggregate();
    const expenses = value.technicianFee + value.doctorFee;
    return `
      <section class="panel center-card">
        <h3>${center.name}</h3>
        <dl class="metric-list">
          <div><dt>Tests</dt><dd>${numberFormat(value.totalTests)}</dd></div>
          <div><dt>Gross income</dt><dd>${money(value.grossIncome)}</dd></div>
          <div><dt>TDS deducted</dt><dd>${money(value.tdsAmount)}</dd></div>
          <div><dt>Amount received</dt><dd>${money(value.amountReceived)}</dd></div>
          <div><dt>Expenses</dt><dd>${money(expenses)}</dd></div>
          <div><dt>Net profit</dt><dd>${money(value.netProfit)}</dd></div>
          <div><dt>Average gross per test</dt><dd>${money(value.totalTests ? value.grossIncome / value.totalTests : 0)}</dd></div>
        </dl>
      </section>
    `;
  }).join("");
}

function numberFormat(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-IN");
}

function centerValues(totals, key) {
  return state.settings.centers.map((center) => ({ label: center.name.replace(", Thodupuzha", ""), value: totals.centers[center.id]?.[key] || 0 }));
}

function technicianSalaryReport(entries, totals) {
  const techCenters = state.settings.centers.filter((center) => Number(center.technicianFee) > 0);
  if (!techCenters.length) return `<p>No technician fee rules are configured.</p>`;
  const centerRows = techCenters.map((center) => {
    const value = totals.centers[center.id] || emptyAggregate();
    return {
      center,
      cases: value.totalTests,
      rate: Number(center.technicianFee) || 0,
      salary: value.technicianFee
    };
  });
  const detailRows = entries
    .filter((entry) => Number(centerById(entry.centerId)?.technicianFee) > 0 && entry.calculations.totalTests > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => {
      const center = centerById(entry.centerId);
      return `
        <tr>
          <td>${displayDate(entry.date)}</td>
          <td>${center?.name || entry.centerId}</td>
          <td>${numberFormat(entry.calculations.totalTests)}</td>
          <td>${money(center?.technicianFee || 0)}</td>
          <td>${money(entry.calculations.technicianFee)}</td>
        </tr>
      `;
    }).join("");
  return `
    <div class="metrics-grid compact-metrics">
      <article class="metric-card"><span>Total technician cases</span><strong>${numberFormat(centerRows.reduce((sum, row) => sum + row.cases, 0))}</strong></article>
      <article class="metric-card"><span>Total technician salary</span><strong>${money(totals.technicianFee)}</strong></article>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Centre</th><th>Cases</th><th>Rate / Case</th><th>Salary</th></tr></thead>
        <tbody>
          ${centerRows.map((row) => `<tr><td>${row.center.name}</td><td>${numberFormat(row.cases)}</td><td>${money(row.rate)}</td><td>${money(row.salary)}</td></tr>`).join("")}
          <tr><th>Total</th><th>${numberFormat(centerRows.reduce((sum, row) => sum + row.cases, 0))}</th><th></th><th>${money(totals.technicianFee)}</th></tr>
        </tbody>
      </table>
    </div>
    <div class="table-wrap salary-detail">
      <table>
        <thead><tr><th>Date</th><th>Centre</th><th>Cases</th><th>Rate / Case</th><th>Salary</th></tr></thead>
        <tbody>${detailRows || `<tr><td colspan="5">No technician salary entries for the selected period.</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function testValues(totals) {
  return TESTS.map((test) => ({ label: test.label.replace("NCV / NCS ", ""), value: totals.tests[test.id] || 0 }));
}

function trendValues(entries, key) {
  const grouped = {};
  entries.forEach((entry) => {
    const label = entry.date.slice(0, 7);
    grouped[label] = (grouped[label] || 0) + (entry.calculations[key] || 0);
  });
  return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value }));
}

function barChart(items, formatter, tone) {
  if (!items.length || items.every((item) => !item.value)) return `<p>No data available yet.</p>`;
  const max = Math.max(...items.map((item) => item.value), 1);
  return `<div class="chart">${items.map((item) => `
    <div class="bar-row">
      <strong>${item.label}</strong>
      <div class="bar-track"><div class="bar-fill ${tone}" style="width:${Math.max(4, (item.value / max) * 100)}%"></div></div>
      <span>${formatter(item.value)}</span>
    </div>`).join("")}</div>`;
}

function reportScope() {
  const type = $("#report-type").value;
  const centerId = $("#report-center").value;
  if (type === "daily") return { title: "Daily Report", date: $("#report-date").value, centerId };
  if (type === "monthly") return { title: "Monthly Report", month: $("#report-month").value, centerId };
  return { title: "Custom Date Range Report", start: $("#report-start").value, end: $("#report-end").value, centerId };
}

function renderReports() {
  const type = $("#report-type").value;
  $$(".report-controls label").forEach((label) => {
    const text = label.textContent.trim().toLowerCase();
    const show = (type === "daily" && text.startsWith("date")) ||
      (type === "monthly" && text.startsWith("month")) ||
      (type === "range" && (text.startsWith("start") || text.startsWith("end"))) ||
      text.startsWith("report") ||
      text.startsWith("center");
    label.style.display = show ? "grid" : "none";
  });
  const scope = reportScope();
  const entries = entriesFor(scope);
  const totals = aggregateEntries(entries);
  const rangeText = scope.date ? displayDate(scope.date) : scope.month ? scope.month : `${scope.start || "Start"} to ${scope.end || "End"}`;
  const text = whatsappText(scope.title, rangeText, totals);
  $("#report-output").innerHTML = `
    <div class="report-header">
      <div>
        <h3>Neurodiagnostics ${scope.title}</h3>
        <p>Date range: ${rangeText}</p>
      </div>
      <div><strong>Generated:</strong><br>${new Date().toLocaleString("en-IN")}</div>
    </div>
    ${renderMetricCards(totals)}
    <div class="dashboard-grid">
      <section class="panel print-include"><div class="panel-head compact"><h3>Test Volume Summary</h3></div>${reportTestTable(totals)}</section>
      <section class="panel print-include"><div class="panel-head compact"><h3>Gross Income Summary</h3></div>${barChart(centerValues(totals, "grossIncome"), money, "teal")}</section>
      <section class="panel print-include"><div class="panel-head compact"><h3>TDS Summary</h3></div>${barChart(centerValues(totals, "tdsAmount"), money, "amber")}</section>
      <section class="panel print-include"><div class="panel-head compact"><h3>Amount Received Summary</h3></div>${barChart(centerValues(totals, "amountReceived"), money, "blue")}</section>
      <section class="panel print-include"><div class="panel-head compact"><h3>Expense Summary</h3></div>${expenseSummary(totals)}</section>
      <section class="panel print-include"><div class="panel-head compact"><h3>Final Net Profit Summary</h3></div>${barChart(centerValues(totals, "netProfit"), money, "green")}</section>
      <section class="panel print-include"><div class="panel-head compact"><h3>Center-wise Performance</h3></div>${reportCenterTable(totals)}</section>
      <section class="panel print-include"><div class="panel-head compact"><h3>Test Mix Chart</h3></div>${barChart(testValues(totals), numberFormat, "amber")}</section>
    </div>
    <div class="whatsapp-box">
      <h3>WhatsApp Report Sharing</h3>
      <label>Recipient number <input id="whatsapp-number" type="tel" placeholder="Optional, include country code" /></label>
      <textarea id="whatsapp-text">${text}</textarea>
      <div class="whatsapp-actions">
        <button class="primary-btn" type="button" id="share-whatsapp-btn">Share via WhatsApp</button>
        <button class="secondary-btn" type="button" id="copy-whatsapp-btn">Copy Report Text</button>
        <button class="secondary-btn" type="button" id="share-pdf-btn">Share PDF</button>
      </div>
    </div>
  `;
  $("#share-whatsapp-btn").addEventListener("click", openWhatsapp);
  $("#copy-whatsapp-btn").addEventListener("click", copyWhatsapp);
  $("#share-pdf-btn").addEventListener("click", () => printReport("share-pdf"));
}

function reportCenterTable(totals) {
  return `<div class="table-wrap"><table><thead><tr><th>Center</th><th>Test Volume</th><th>Gross Income</th><th>TDS Deducted</th><th>Amount Received</th><th>Technician Fee</th><th>Doctor Fee</th><th>Net Profit</th></tr></thead><tbody>
    ${state.settings.centers.map((center) => {
      const row = totals.centers[center.id] || emptyAggregate();
      return `<tr><td>${center.name}</td><td>${numberFormat(row.totalTests)}</td><td>${money(row.grossIncome)}</td><td>${money(row.tdsAmount)}</td><td>${money(row.amountReceived)}</td><td>${money(row.technicianFee)}</td><td>${money(row.doctorFee)}</td><td>${money(row.netProfit)}</td></tr>`;
    }).join("")}
    <tr><th>Grand Total</th><th>${numberFormat(totals.totalTests)}</th><th>${money(totals.grossIncome)}</th><th>${money(totals.tdsAmount)}</th><th>${money(totals.amountReceived)}</th><th>${money(totals.technicianFee)}</th><th>${money(totals.doctorFee)}</th><th>${money(totals.netProfit)}</th></tr>
  </tbody></table></div>`;
}

function reportTestTable(totals) {
  return `<div class="table-wrap"><table><thead><tr><th>Test</th><th>Quantity</th></tr></thead><tbody>
    ${TESTS.map((test) => `<tr><td>${test.label}</td><td>${numberFormat(totals.tests[test.id])}</td></tr>`).join("")}
  </tbody></table></div>`;
}

function expenseSummary(totals) {
  return `<dl class="metric-list">
    <div><dt>Technician fees</dt><dd>${money(totals.technicianFee)}</dd></div>
    <div><dt>Doctor reporting fees</dt><dd>${money(totals.doctorFee)}</dd></div>
    <div><dt>Total expenses</dt><dd>${money(totals.technicianFee + totals.doctorFee)}</dd></div>
  </dl>`;
}

function whatsappText(title, rangeText, totals) {
  const lines = ["NEURODIAGNOSTICS REPORT", "", `Date / Period: ${rangeText}`, ""];
  state.settings.centers.forEach((center) => {
    const value = totals.centers[center.id] || emptyAggregate();
    lines.push(center.name);
    lines.push(`Tests: ${numberFormat(value.totalTests)}`);
    lines.push(`Gross Income: ${money(value.grossIncome)}`);
    lines.push(`TDS: ${money(value.tdsAmount)}`);
    lines.push(`Amount Received: ${money(value.amountReceived)}`);
    if (value.technicianFee) lines.push(`Technician Fee: ${money(value.technicianFee)}`);
    if (value.doctorFee) lines.push(`Doctor Fee: ${money(value.doctorFee)}`);
    lines.push(`Net Profit: ${money(value.netProfit)}`, "");
  });
  lines.push("GRAND TOTALS", "");
  lines.push(`Gross Income: ${money(totals.grossIncome)}`, "");
  lines.push(`TDS Deducted: ${money(totals.tdsAmount)}`, "");
  lines.push(`Amount Received: ${money(totals.amountReceived)}`, "");
  lines.push(`Technician Fees: ${money(totals.technicianFee)}`, "");
  lines.push(`Doctor Fees: ${money(totals.doctorFee)}`, "");
  lines.push(`Final Net Profit: ${money(totals.netProfit)}`);
  return lines.join("\n");
}

function openWhatsapp() {
  saveReportHistory("whatsapp");
  const number = $("#whatsapp-number").value.replace(/\D/g, "");
  const text = encodeURIComponent($("#whatsapp-text").value);
  const url = number ? `https://wa.me/${number}?text=${text}` : `https://wa.me/?text=${text}`;
  window.open(url, "_blank", "noopener");
}

function printReport(action) {
  saveReportHistory(action);
  window.print();
}

function saveReportHistory(action) {
  const scope = reportScope();
  state.reportHistory.push({
    id: crypto.randomUUID(),
    action,
    scope,
    generatedAt: new Date().toISOString(),
    userId: activeUser()?.id || null
  });
  addActivity("report-generated", { action, scope });
  saveState();
}

function addActivity(type, detail = {}) {
  state.userActivity = state.userActivity || [];
  state.userActivity.push({
    id: crypto.randomUUID(),
    type,
    detail,
    at: new Date().toISOString(),
    userId: activeUser()?.id || null
  });
}

function quickWhatsapp(type) {
  $("#report-type").value = type;
  renderReports();
  openWhatsapp();
}

async function copyWhatsapp() {
  await navigator.clipboard.writeText($("#whatsapp-text").value);
  $("#copy-whatsapp-btn").textContent = "Copied";
  setTimeout(() => { $("#copy-whatsapp-btn").textContent = "Copy Report Text"; }, 1200);
}

function renderHistory() {
  const query = $("#history-search").value.trim().toLowerCase();
  const start = $("#history-start").value;
  const end = $("#history-end").value;
  const rows = state.entries
    .filter((entry) => (!start || entry.date >= start) && (!end || entry.date <= end))
    .filter((entry) => {
      const center = centerById(entry.centerId)?.name || "";
      const testNames = TESTS.filter((test) => entry.quantities[test.id]).map((test) => test.label).join(" ");
      return !query || `${entry.date} ${center} ${testNames}`.toLowerCase().includes(query);
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  $("#history-table").innerHTML = rows.map((entry) => {
    const calc = entry.calculations;
    return `<tr>
      <td>${displayDate(entry.date)}</td>
      <td>${centerById(entry.centerId)?.name || entry.centerId}</td>
      <td>${numberFormat(calc.totalTests)}</td>
      <td>${money(calc.grossIncome)}</td>
      <td>${money(calc.tdsAmount)}</td>
      <td>${money(calc.amountReceived)}</td>
      <td>${money(calc.technicianFee + calc.doctorFee)}</td>
      <td>${money(calc.netProfit)}</td>
      <td><button class="ghost-btn" type="button" data-load-entry="${entry.id}">Edit</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="9">No entries found.</td></tr>`;
  $$("[data-load-entry]").forEach((button) => button.addEventListener("click", () => loadEntryById(button.dataset.loadEntry)));
}

function loadEntryById(id) {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;
  $("#entry-date").value = entry.date;
  $("#entry-center").value = entry.centerId;
  TESTS.forEach((test) => {
    $(`#qty-${test.id}`).value = entry.quantities[test.id] || 0;
    $(`#override-${test.id}`).value = entry.overrides[test.id] ?? "";
  });
  showView("entry");
  renderEntrySummary();
}

function exportCsv() {
  const headers = ["date", "center", "tests", "grossIncomeBeforeTds", "tdsAmount", "amountReceivedAfterTds", "technicianFee", "doctorFee", "netProfit"];
  const rows = state.entries.map((entry) => [
    entry.date,
    centerById(entry.centerId)?.name || entry.centerId,
    entry.calculations.totalTests,
    entry.calculations.grossIncome,
    entry.calculations.tdsAmount,
    entry.calculations.amountReceived,
    entry.calculations.technicianFee,
    entry.calculations.doctorFee,
    entry.calculations.netProfit
  ]);
  const csv = [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nms-export-${todayISO()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderSettings() {
  $("#pricing-form").innerHTML = state.settings.centers.map((center) => `
    <div class="settings-price-group">
      <strong>${center.name}</strong>
      ${TESTS.map((test) => `
        <label class="settings-row">
          <span>${test.label}</span>
          <input type="number" min="0" name="${center.id}-${test.id}" value="${center.prices?.[test.id] || 0}" />
        </label>`).join("")}
    </div>`).join("") + `<button class="primary-btn" type="submit">Save Pricing</button>`;
  $("#center-rules-form").innerHTML = state.settings.centers.map((center) => `
    <div class="rule-row">
      <label>Centre <input name="${center.id}-name" value="${center.name}" /></label>
      <label>TDS % <input type="number" min="0" max="100" step="0.01" name="${center.id}-tdsPercent" value="${center.tdsPercent}" /></label>
      <label>Tech fee <input type="number" min="0" name="${center.id}-technicianFee" value="${center.technicianFee}" /></label>
      <label>Doctor fee <input type="number" min="0" name="${center.id}-doctorFee" value="${center.doctorFee}" /></label>
    </div>`).join("") + `<button class="primary-btn" type="submit">Save Revenue Rules</button>`;
  $("#users-list").innerHTML = state.users.map((user) => `
    <div class="user-item">
      <span><strong>${user.name}</strong><br><small>${user.email} - ${user.role === "admin" ? "Admin" : "Data Entry User"}</small></span>
      <button class="ghost-btn" type="button" data-edit-user="${user.id}">Edit</button>
    </div>`).join("");
  $$("[data-edit-user]").forEach((button) => button.addEventListener("click", () => editUser(button.dataset.editUser)));
}

function savePricing(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  state.settings.centers = state.settings.centers.map((center) => {
    const prices = {};
    TESTS.forEach((test) => {
      prices[test.id] = Number(form.get(`${center.id}-${test.id}`)) || 0;
    });
    return { ...center, prices };
  });
  saveState();
  renderAll();
}

function saveCenterRules(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  state.settings.centers = state.settings.centers.map((center) => ({
    ...center,
    name: String(form.get(`${center.id}-name`) || center.name).trim(),
    tdsPercent: Number(form.get(`${center.id}-tdsPercent`)) || 0,
    technicianFee: Number(form.get(`${center.id}-technicianFee`)) || 0,
    doctorFee: Number(form.get(`${center.id}-doctorFee`)) || 0
  }));
  saveState();
  renderAll();
}

function editUser(id) {
  const user = state.users.find((item) => item.id === id);
  if (!user) return;
  $("#user-id").value = user.id;
  $("#user-name").value = user.name;
  $("#user-email").value = user.email;
  $("#user-password").value = user.password;
  $("#user-role").value = user.role;
}

function saveUser(event) {
  event.preventDefault();
  const id = $("#user-id").value || crypto.randomUUID();
  const user = {
    id,
    name: $("#user-name").value.trim(),
    email: $("#user-email").value.trim(),
    password: $("#user-password").value,
    role: $("#user-role").value
  };
  const index = state.users.findIndex((item) => item.id === id);
  if (index >= 0) state.users[index] = user;
  else state.users.push(user);
  saveState();
  event.target.reset();
  $("#user-id").value = "";
  renderAll();
}

async function installPwa() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("#install-btn").classList.add("hidden");
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

initialize();
