const STORAGE_KEY = "wv2:state";
const PALETTE = [
  "#ff6b6b", "#ffbf47", "#36c483", "#4da3ff", "#8e7bff",
  "#ff8ad1", "#2cc5bf", "#ffa45c", "#a06bff", "#78c4ff",
];

const SCREENSHOT_CONCURRENCY = 8;
const SCREENSHOT_TIMEOUT_MS = 90_000;
const SCREENSHOT_MAX_RETRIES = 3;
const CHECK_CONCURRENCY = 6;
const CHECK_DELAY_MS = 0;

// ---------- State ----------

const els = {};
const ALL_ELS = [
  "app", "urlInput", "loadBtn", "appendBtn", "checkBtn", "importBtn", "fileInput",
  "dropZone", "filter", "statusFilter", "verdictFilter", "reviewFilter", "tagFilter", "sortBy",
  "list", "stats", "bulkBar", "bulkCount", "bulkReview", "bulkTag", "bulkExport",
  "bulkCapture", "bulkDelete", "bulkClear", "frame", "frameHelp", "frameHelpOpen",
  "frameHelpDismiss", "empty", "current", "thumbGrid", "loadMore", "prevBtn", "nextBtn",
  "popupBtn", "reloadBtn", "detailBtn", "densitySelect", "toast", "gridView", "singleView",
  "compareView", "projectSelect", "renameProjectBtn", "newProjectBtn", "deleteProjectBtn",
  "toggleSidebarBtn", "themeBtn", "helpBtn", "helpModal", "exportModal", "promptModal",
  "promptTitle", "promptInput", "promptOk", "exportSelectionOnly", "exportSelectionCount",
  "detailKv", "verdictRow", "evidenceList", "reclassifyBtn",
  "reviewButtons", "tagEditor", "tagSuggest", "tagInput", "tagAdd",
  "notesArea", "compareAdd", "compareClear", "compareGrid", "mainArea",
  "autoRejectBtn", "autoRejectCount",
  "undoBanner", "undoMessage", "undoBtn", "undoKeepBtn", "undoCountdown",
];
for (const id of ALL_ELS) els[id] = document.getElementById(id);

const viewModeButtons = document.querySelectorAll('.seg [data-view]');
const viewportButtons = document.querySelectorAll('.seg [data-viewport]');
const compareColButtons = document.querySelectorAll('#compareCols [data-cols]');

let state = defaultState();
let projects = [];
let selection = new Set();
let renderQueued = false;
let toastTimer = null;
let frameHelpTimer = null;
let checkRunId = 0;
let screenshotRunId = 0;
let screenshotQueue = [];
let screenshotActive = 0;
let notesDebounce = null;
let projectSaveDebounce = null;
let projectSaving = false;
let sidebarOpen = true;
let anchorIndex = null;

// Keyed-rebuild tracking: DOM rebuilt only when URL set changes
const rendered = {
  listKey: "",
  listViewport: "",
  gridKey: "",
  gridViewport: "",
  density: "",
  activeUrl: null,
};

function defaultState() {
  return {
    projectId: null,
    projectName: "Untitled",
    urls: [],
    checks: {},
    meta: {},
    tags: {},
    notes: {},
    review: {},
    tagPalette: [],
    index: 0,
    view: "grid",
    viewport: "desktop",
    density: "cozy",
    compareUrls: [],
    compareCols: 2,
    filter: { q: "", status: "all", verdict: "all", review: "all", tag: "all" },
    sort: "added",
    theme: "dark",
  };
}

// ---------- Storage ----------

function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("localStorage save failed", e);
  }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch {
    return null;
  }
}

async function loadProjects() {
  try {
    const res = await fetch("/api/projects");
    const json = await res.json();
    projects = json.projects || [];
    renderProjectSelect();
  } catch (e) {
    console.warn("loadProjects failed", e);
  }
}

async function loadProject(id) {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error("not found");
    const p = await res.json();
    state.projectId = p.id;
    state.projectName = p.name;
    state.urls = Array.isArray(p.urls) ? p.urls : [];
    state.tags = p.tags || {};
    state.notes = p.notes || {};
    state.review = p.review || {};
    state.tagPalette = p.tagPalette || [];
    state.checks = state.checks || {};
    state.meta = state.meta || {};
    state.index = 0;
    selection.clear();
    resetVisibleLimit();
    invalidateRendered();
    saveLocal();
    renderAll();
    loadFrame();
    loadMetadataForVisible();
    if (Object.keys(state.checks).length < state.urls.length / 2) runChecks({ force: false });
  } catch (e) {
    notify("Failed to load project");
  }
}

function scheduleProjectSave() {
  clearTimeout(projectSaveDebounce);
  projectSaveDebounce = setTimeout(saveProjectNow, 750);
}

async function saveProjectNow() {
  if (projectSaving) return scheduleProjectSave();
  projectSaving = true;
  const wasNew = !state.projectId;
  try {
    const payload = {
      id: state.projectId || undefined,
      name: state.projectName,
      urls: state.urls,
      tags: state.tags,
      notes: state.notes,
      review: state.review,
      tagPalette: state.tagPalette,
      settings: { viewport: state.viewport, density: state.density, sort: state.sort },
    };
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (json.id && !state.projectId) {
      state.projectId = json.id;
      saveLocal();
    }
    if (wasNew) await loadProjects();
  } catch (e) {
    console.warn("saveProject failed", e);
  } finally {
    projectSaving = false;
  }
}

// ---------- URL parsing ----------

function normaliseUrl(raw) {
  const s = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).href;
  } catch {
    return null;
  }
}

function parseUrls(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const parts = line.split(/[\s,]+/);
    for (const p of parts) {
      const u = normaliseUrl(p);
      if (u) out.push(u);
    }
  }
  return Array.from(new Set(out));
}

function parseCsvUrls(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const header = lines[0].toLowerCase();
  const urlIdx = header.split(",").findIndex(h => /^(url|link|website|site)$/i.test(h.trim().replace(/"/g, "")));
  const out = [];
  const start = urlIdx >= 0 ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const candidate = urlIdx >= 0 ? cells[urlIdx] : cells.find(c => /^https?:\/\//i.test(c.trim()) || /\./.test(c));
    const u = normaliseUrl(candidate || "");
    if (u) out.push(u);
  }
  return Array.from(new Set(out));
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ""; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/^"|"$/g, ""));
}

function parseBookmarksHtml(text) {
  const matches = text.matchAll(/<a\s+[^>]*?href=["']([^"']+)["']/gi);
  const out = [];
  for (const m of matches) {
    const u = normaliseUrl(m[1]);
    if (u) out.push(u);
  }
  return Array.from(new Set(out));
}

function parseJsonUrls(text) {
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      const urls = [];
      for (const item of data) {
        if (typeof item === "string") urls.push(item);
        else if (item && typeof item === "object") urls.push(item.url || item.link || item.href || "");
      }
      return urls.map(normaliseUrl).filter(Boolean);
    }
    if (data && typeof data === "object") {
      if (Array.isArray(data.urls)) return data.urls.map(normaliseUrl).filter(Boolean);
    }
  } catch {}
  return [];
}

function parseFile(name, text) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "csv") return parseCsvUrls(text);
  if (ext === "json") return parseJsonUrls(text);
  if (ext === "html" || ext === "htm") return parseBookmarksHtml(text);
  return parseUrls(text);
}

// ---------- Helpers ----------

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

function statusCategory(check) {
  if (!check || check.status === undefined) return "unchecked";
  const s = Number(check.status);
  if (!s) return "err";
  if (s >= 200 && s < 300) return "2xx";
  if (s >= 300 && s < 400) return "3xx";
  if (s >= 400 && s < 500) return "4xx";
  if (s >= 500 && s < 600) return "5xx";
  return "err";
}

function statusBadgeClass(cat) {
  if (cat === "2xx") return "ok";
  if (cat === "3xx") return "info";
  if (cat === "4xx" || cat === "5xx" || cat === "err") return "bad";
  return "muted";
}

function statusLabel(check) {
  if (!check) return "unchecked";
  if (check.error) return check.error;
  if (!check.status) return "pending";
  return `${check.status}${check.statusText ? " " + check.statusText : ""}`;
}

function tagColor(name) {
  const preset = state.tagPalette.find(t => t.name === name);
  if (preset) return preset.color;
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

function ensureTagInPalette(name) {
  if (!state.tagPalette.some(t => t.name === name)) {
    state.tagPalette.push({ name, color: tagColor(name) });
  }
}

function notify(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  toastTimer = setTimeout(() => els.toast.classList.remove("visible"), 2600);
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function resetVisibleLimit() { /* no-op: yolo — render everything */ }

function invalidateRendered() {
  rendered.listKey = "invalid";
  rendered.gridKey = "invalid";
  rendered.activeUrl = "invalid";
}

function currentUrl() {
  return state.urls[state.index] || "";
}

function escCss(s) { try { return CSS.escape(s); } catch { return s; } }
function rowFor(url) { return url ? els.list.querySelector(`.item[data-url="${escCss(url)}"]`) : null; }
function cardFor(url) { return url ? els.thumbGrid.querySelector(`.thumb[data-url="${escCss(url)}"]`) : null; }

// ---------- Filtering / sorting ----------

// Verdict vocabulary is intentionally narrow: only surface a label when we're
// confident the URL is bad. Neutral/clean URLs have no verdict — the card stays
// quiet so the user can focus on manual review.
const BAD_VERDICTS = new Set(["parked", "for_sale", "mismatch", "template"]);
const SUSPICIOUS_VERDICTS = BAD_VERDICTS;

function verdictFor(url) {
  return state.checks[url]?.verdict || state.meta[url]?.verdict || null;
}

function errorKindFor(url) {
  return state.checks[url]?.errorKind || state.meta[url]?.errorKind || null;
}

// A URL is a "confident-bad" candidate for auto-reject if its verdict is in
// BAD_VERDICTS, or if its HTTP request failed with a dead-domain errorKind.
const AUTO_REJECT_ERROR_KINDS = new Set(["dns", "refused", "tls"]);
function isAutoRejectCandidate(url) {
  const v = verdictFor(url);
  if (v && BAD_VERDICTS.has(v)) return true;
  const c = state.checks[url];
  if (c && c.status === 0 && AUTO_REJECT_ERROR_KINDS.has(c.errorKind)) return true;
  return false;
}

function validityFor(url) {
  const r = state.review[url];
  if (r === "approved") return "valid";
  if (r === "rejected") return "invalid";
  return null;
}

function setValidity(url, v) {
  if (v === "valid") state.review[url] = "approved";
  else if (v === "invalid") state.review[url] = "rejected";
  else delete state.review[url];
  saveLocal();
  scheduleProjectSave();
  updateItem(url);
  updateAutoRejectButton();
  if (url === currentUrl()) renderDetail();
}

// ---------- Auto-reject + undo banner ----------

let undoTimer = null;
let undoCountdownTimer = null;
let pendingUndo = null; // { urls: [{url, prevReview}], commitTimer }

function autoRejectCandidates() {
  const out = [];
  for (const url of state.urls) {
    if (!isAutoRejectCandidate(url)) continue;
    if (state.review[url] === "rejected") continue; // already rejected
    out.push(url);
  }
  return out;
}

function updateAutoRejectButton() {
  const n = autoRejectCandidates().length;
  if (!els.autoRejectCount) return;
  els.autoRejectCount.textContent = n;
  els.autoRejectBtn.disabled = n === 0;
}

function autoRejectBadVerdicts() {
  const targets = autoRejectCandidates();
  if (!targets.length) { notify("Nothing to auto-reject."); return; }
  const batch = [];
  for (const url of targets) {
    batch.push({ url, prev: state.review[url] });
    state.review[url] = "rejected";
    updateItem(url);
  }
  saveLocal();
  scheduleProjectSave();
  updateAutoRejectButton();
  updateStats();
  showUndoBanner(`Rejected ${batch.length} suspect URLs`, () => {
    for (const { url, prev } of batch) {
      if (prev === undefined) delete state.review[url];
      else state.review[url] = prev;
      updateItem(url);
    }
    saveLocal();
    scheduleProjectSave();
    updateAutoRejectButton();
    updateStats();
    notify(`Undid ${batch.length} auto-rejects.`);
  });
}

function showUndoBanner(message, undoFn, seconds = 20) {
  hideUndoBanner(false);
  pendingUndo = { undoFn };
  els.undoMessage.textContent = message;
  els.undoBanner.hidden = false;
  let remaining = seconds;
  els.undoCountdown.textContent = String(remaining);
  undoCountdownTimer = setInterval(() => {
    remaining -= 1;
    els.undoCountdown.textContent = String(Math.max(0, remaining));
  }, 1000);
  undoTimer = setTimeout(() => hideUndoBanner(false), seconds * 1000);
}

function hideUndoBanner(runUndo) {
  clearTimeout(undoTimer);
  clearInterval(undoCountdownTimer);
  undoTimer = null;
  undoCountdownTimer = null;
  const p = pendingUndo;
  pendingUndo = null;
  els.undoBanner.hidden = true;
  if (runUndo && p?.undoFn) p.undoFn();
}

function filteredUrls() {
  const q = state.filter.q.trim().toLowerCase();
  const statusFilter = state.filter.status;
  const verdictFilter = state.filter.verdict;
  const reviewFilter = state.filter.review;
  const tagFilter = state.filter.tag;

  const out = [];
  for (let i = 0; i < state.urls.length; i++) {
    const url = state.urls[i];
    if (statusFilter !== "all") {
      const cat = statusCategory(state.checks[url]);
      if (cat !== statusFilter) continue;
    }
    if (verdictFilter !== "all") {
      const v = verdictFor(url);
      if (verdictFilter === "suspicious") {
        if (!isAutoRejectCandidate(url)) continue;
      } else if (verdictFilter === "neutral") {
        if (v || !state.checks[url]) continue;
      } else if (verdictFilter === "dead") {
        const c = state.checks[url];
        if (!(c && c.status === 0 && AUTO_REJECT_ERROR_KINDS.has(c.errorKind))) continue;
      } else if (v !== verdictFilter) continue;
    }
    if (reviewFilter !== "all") {
      const r = state.review[url] || "unreviewed";
      if (r !== reviewFilter) continue;
    }
    if (tagFilter !== "all") {
      const tags = state.tags[url] || [];
      if (!tags.includes(tagFilter)) continue;
    }
    if (q) {
      const meta = state.meta[url] || {};
      const note = (state.notes[url] || "").toLowerCase();
      const text = [url, host(url), meta.title || "", meta.description || "", note].join("\n").toLowerCase();
      if (!text.includes(q)) continue;
    }
    out.push(i);
  }

  if (state.sort !== "added") {
    out.sort((a, b) => sortCompare(a, b, state.sort));
  }
  return out;
}

function sortCompare(ai, bi, key) {
  const au = state.urls[ai], bu = state.urls[bi];
  if (key === "host") return host(au).localeCompare(host(bu));
  if (key === "title") {
    const a = (state.meta[au]?.title || host(au)).toLowerCase();
    const b = (state.meta[bu]?.title || host(bu)).toLowerCase();
    return a.localeCompare(b);
  }
  if (key === "status") {
    const a = state.checks[au]?.status || 9999;
    const b = state.checks[bu]?.status || 9999;
    return a - b;
  }
  if (key === "responseMs") {
    const a = state.checks[au]?.responseMs ?? 1e9;
    const b = state.checks[bu]?.responseMs ?? 1e9;
    return a - b;
  }
  if (key === "review") {
    const order = { unreviewed: 0, flagged: 1, reviewed: 2, approved: 3, rejected: 4 };
    const a = order[state.review[au] || "unreviewed"] ?? 0;
    const b = order[state.review[bu] || "unreviewed"] ?? 0;
    return a - b;
  }
  if (key === "verdict") {
    // Null (neutral, needs manual review) sorts first, then mismatch, template,
    // parked, for_sale.
    const order = { mismatch: 1, template: 2, parked: 3, for_sale: 4 };
    const a = order[verdictFor(au)] ?? 0;
    const b = order[verdictFor(bu)] ?? 0;
    return a - b;
  }
  return ai - bi;
}

// ---------- Rendering (structural) ----------

function renderAll() {
  renderProjectSelect();
  renderTagFilter();
  invalidateRendered();
  render();
  renderDetail();
  renderCompare();
}

function renderProjectSelect() {
  const sel = els.projectSelect;
  sel.innerHTML = "";
  const currentOpt = document.createElement("option");
  const nameLabel = state.projectName || "Untitled";
  const idLabel = state.projectId ? "" : " (unsaved)";
  currentOpt.value = state.projectId || "__local__";
  currentOpt.textContent = `${nameLabel}${idLabel}`;
  sel.append(currentOpt);
  for (const p of projects) {
    if (p.id === state.projectId) continue;
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} · ${p.urlCount}`;
    sel.append(opt);
  }
  sel.value = state.projectId || "__local__";
}

function renderTagFilter() {
  const all = new Set();
  for (const url of state.urls) for (const t of (state.tags[url] || [])) all.add(t);
  for (const t of state.tagPalette) all.add(t.name);
  const sorted = [...all].sort();
  const sel = els.tagFilter;
  const current = sel.value;
  sel.innerHTML = '<option value="all">All tags</option>';
  for (const t of sorted) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = `# ${t}`;
    sel.append(opt);
  }
  sel.value = sorted.includes(current) ? current : "all";
}

function render() {
  const total = state.urls.length;
  const filtered = filteredUrls();

  updateToolbarState();
  updateViewVisibility(total);
  updateStats(filtered, filtered.length, total);
  renderBulkBar();

  const key = filtered.map(i => state.urls[i]).join("\n");
  const densityKey = state.density;
  const viewportKey = state.viewport;

  if (key !== rendered.listKey) {
    rebuildList(filtered);
    rendered.listKey = key;
  }

  if (state.view === "grid") {
    if (key !== rendered.gridKey || viewportKey !== rendered.gridViewport || densityKey !== rendered.density) {
      rebuildGrid(filtered);
      rendered.gridKey = key;
      rendered.gridViewport = viewportKey;
      rendered.density = densityKey;
    }
  }

  if (state.view === "compare") renderCompare();

  updateActive();
  updateAutoRejectButton();

  els.loadMore.hidden = true;
}

function updateToolbarState() {
  const url = currentUrl();
  const total = state.urls.length;
  els.current.textContent = url || "No URL loaded";
  els.prevBtn.disabled = !total || state.index <= 0;
  els.nextBtn.disabled = !total || state.index >= total - 1;
  els.popupBtn.disabled = !url;
  els.reloadBtn.disabled = !url && state.view !== "grid";
  els.checkBtn.disabled = !total;
  viewModeButtons.forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
  viewportButtons.forEach(b => b.classList.toggle("active", b.dataset.viewport === state.viewport));
}

function updateViewVisibility(total) {
  els.empty.classList.toggle("hidden", total > 0);
  els.gridView.classList.toggle("active", state.view === "grid" && total > 0);
  els.singleView.classList.toggle("active", state.view === "single" && total > 0);
  els.compareView.classList.toggle("active", state.view === "compare" && total > 0);
}

function updateStats(filteredMaybe, _unused, totalMaybe) {
  const filtered = filteredMaybe ?? filteredUrls();
  const total = totalMaybe ?? state.urls.length;
  let bad = 0, unchecked = 0, decided = 0;
  for (const i of filtered) {
    const url = state.urls[i];
    if (!state.checks[url]) { unchecked++; continue; }
    if (isAutoRejectCandidate(url)) bad++;
    if (state.review[url] === "approved" || state.review[url] === "rejected") decided++;
  }
  els.stats.firstElementChild.innerHTML =
    `<b>${decided}</b>/<b>${filtered.length}</b> decided · <b>${total}</b> total · ${bad} suspect · ${unchecked} pending`;
}

function updateActive() {
  const url = currentUrl();
  if (rendered.activeUrl === url) return;
  rendered.activeUrl = url;
  els.list.querySelectorAll(".item.active").forEach(e => e.classList.remove("active"));
  els.thumbGrid.querySelectorAll(".thumb.active").forEach(e => e.classList.remove("active"));
  if (!url) return;
  const row = rowFor(url);
  const card = cardFor(url);
  row?.classList.add("active");
  card?.classList.add("active");
  if (row) row.scrollIntoView({ block: "nearest" });
}

// ---------- In-place item updates ----------

function updateItem(url) {
  const row = rowFor(url);
  if (row) updateRow(row, url);
  const card = cardFor(url);
  if (card) updateCard(card, url);
}

function updateStatusBadge(el, url) {
  const check = state.checks[url];
  const cat = statusCategory(check);
  el.className = `badge dot ${statusBadgeClass(cat)}`;
  el.textContent = check?.status || (cat === "err" ? "err" : "—");
  el.title = statusLabel(check);
}

function updateReviewPill(el, url) {
  const review = state.review[url];
  if (review && review !== "unreviewed") {
    el.className = `review-pill ${review}`;
    el.textContent = review[0].toUpperCase();
    el.title = `Review: ${review}`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

const VERDICT_LABELS = {
  parked: "Parked",
  for_sale: "For sale",
  mismatch: "Mismatch",
  template: "Template",
};

function updateVerdictPill(el, url) {
  if (!el) return;
  const v = verdictFor(url);
  if (!v || !VERDICT_LABELS[v]) {
    el.hidden = true;
    return;
  }
  const evidence = state.checks[url]?.verdictEvidence || state.meta[url]?.verdictEvidence || [];
  el.className = `verdict-pill ${v}`;
  el.textContent = VERDICT_LABELS[v];
  el.title = evidence.length ? `${v}\n${evidence.join("\n")}` : v;
  el.hidden = false;
}

function updateRow(row, url) {
  const meta = state.meta[url] || {};
  const titleEl = row.querySelector(".title-text");
  if (titleEl) titleEl.textContent = meta.title || host(url);
  const dot = row.querySelector(".notes-dot");
  if (dot) dot.hidden = !state.notes[url];
  updateVerdictPill(row.querySelector(".verdict-pill"), url);
  updateStatusBadge(row.querySelector(".badge"), url);
  updateReviewPill(row.querySelector(".review-pill"), url);
  row.classList.toggle("selected", selection.has(url));
  const cb = row.querySelector("input[type=checkbox]");
  if (cb) cb.checked = selection.has(url);
}

function updateCard(card, url) {
  const meta = state.meta[url] || {};
  const titleEl = card.querySelector(".thumb-title");
  if (titleEl) titleEl.textContent = meta.title || host(url);
  updateVerdictPill(card.querySelector(".verdict-pill"), url);
  updateStatusBadge(card.querySelector(".card-status"), url);
  const ms = card.querySelector(".card-ms");
  if (ms) {
    const t = state.checks[url]?.responseMs;
    ms.textContent = t ? `${t}ms` : "";
    ms.hidden = !t;
  }
  updateReviewPill(card.querySelector(".review-pill"), url);
  card.classList.toggle("selected", selection.has(url));
  card.classList.toggle("dim", isAutoRejectCandidate(url));
  const sel = card.querySelector(".thumb-select input");
  if (sel) sel.checked = selection.has(url);
  const v = validityFor(url);
  card.classList.toggle("decided-valid", v === "valid");
  card.classList.toggle("decided-invalid", v === "invalid");
  const validBtn = card.querySelector(".decide-btn.valid");
  const invalidBtn = card.querySelector(".decide-btn.invalid");
  if (validBtn) validBtn.classList.toggle("active", v === "valid");
  if (invalidBtn) invalidBtn.classList.toggle("active", v === "invalid");
  renderCardTags(card, url);
}

function renderCardTags(card, url) {
  const holder = card.querySelector(".thumb-tags");
  if (!holder) return;
  const tags = state.tags[url] || [];
  holder.replaceChildren();
  for (const t of tags) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    const c = tagColor(t);
    chip.style.background = c + "33";
    chip.style.color = c;
    chip.textContent = t;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      state.filter.tag = t;
      els.tagFilter.value = t;
      resetVisibleLimit();
      scheduleRender();
    });
    holder.append(chip);
  }
}

// ---------- List (sidebar) ----------

function rebuildList(visible) {
  const frag = document.createDocumentFragment();
  for (const idx of visible) {
    const url = state.urls[idx];
    frag.append(buildListRow(url, idx));
  }
  els.list.replaceChildren(frag);
}

function buildListRow(url, idx) {
  const row = document.createElement("div");
  row.className = "item";
  row.dataset.index = idx;
  row.dataset.url = url;
  row.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.shiftKey && anchorIndex !== null) {
      rangeSelect(anchorIndex, idx);
    } else if (e.metaKey || e.ctrlKey) {
      toggleSelect(url);
      anchorIndex = idx;
    } else {
      setIndex(idx);
      anchorIndex = idx;
    }
  });

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSelect(url);
    anchorIndex = idx;
  });

  const fav = document.createElement("img");
  fav.className = "favicon";
  fav.loading = "lazy";
  fav.decoding = "async";
  fav.alt = "";
  fav.src = `/api/favicon?url=${encodeURIComponent(url)}`;
  fav.onerror = () => { fav.style.visibility = "hidden"; };

  const text = document.createElement("div");
  text.className = "text";
  const title = document.createElement("div");
  title.className = "title";
  const titleText = document.createElement("span");
  titleText.className = "title-text";
  const dot = document.createElement("span");
  dot.className = "notes-dot";
  dot.title = "Has notes";
  dot.hidden = true;
  title.append(titleText, dot);
  const sub = document.createElement("div");
  sub.className = "host";
  sub.textContent = host(url);
  text.append(title, sub);

  const status = document.createElement("div");
  status.className = "row";
  status.style.gap = "6px";
  const verdictPill = document.createElement("span");
  verdictPill.className = "verdict-pill";
  verdictPill.hidden = true;
  const pill = document.createElement("span");
  pill.className = "review-pill";
  pill.hidden = true;
  const badge = document.createElement("span");
  badge.className = "badge dot muted";
  status.append(verdictPill, pill, badge);

  row.append(cb, fav, text, status);
  updateRow(row, url);
  return row;
}

// ---------- Grid ----------

function rebuildGrid(visible) {
  resetScreenshotQueue();
  els.thumbGrid.className = `thumb-grid density-${state.density}`;
  const frag = document.createDocumentFragment();
  for (const idx of visible) {
    const url = state.urls[idx];
    frag.append(buildThumbCard(url, idx));
  }
  els.thumbGrid.replaceChildren(frag);
  observeThumbs();
}

function buildThumbCard(url, idx) {
  const card = document.createElement("article");
  card.className = "thumb";
  card.dataset.index = idx;
  card.dataset.url = url;
  card.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest(".thumb-select")) return;
    if (e.shiftKey && anchorIndex !== null) rangeSelect(anchorIndex, idx);
    else if (e.metaKey || e.ctrlKey) { toggleSelect(url); anchorIndex = idx; }
    else { setIndex(idx); anchorIndex = idx; }
  });
  card.addEventListener("dblclick", () => {
    setIndex(idx);
    state.view = "single";
    render();
    loadFrame();
  });

  const shot = document.createElement("div");
  shot.className = `thumb-shot ${state.viewport}`;

  const selectBtn = document.createElement("div");
  selectBtn.className = "thumb-select";
  selectBtn.title = "Select";
  selectBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleSelect(url); anchorIndex = idx; });

  const badges = document.createElement("div");
  badges.className = "thumb-badges";
  const verdictPill = document.createElement("span");
  verdictPill.className = "verdict-pill";
  verdictPill.hidden = true;
  const statusBadge = document.createElement("span");
  statusBadge.className = "badge dot card-status muted";
  const ms = document.createElement("span");
  ms.className = "badge muted card-ms";
  ms.hidden = true;
  const pill = document.createElement("span");
  pill.className = "review-pill";
  pill.hidden = true;
  badges.append(verdictPill, statusBadge, ms, pill);

  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = `Preview of ${host(url)}`;
  img.dataset.url = url;

  shot.append(selectBtn, badges, img);

  const metaRow = document.createElement("div");
  metaRow.className = "thumb-meta";
  const fav = document.createElement("img");
  fav.className = "thumb-fav";
  fav.loading = "lazy";
  fav.decoding = "async";
  fav.alt = "";
  fav.src = `/api/favicon?url=${encodeURIComponent(url)}`;
  fav.onerror = () => { fav.style.visibility = "hidden"; };

  const titleRow = document.createElement("div");
  titleRow.className = "thumb-title-row";
  const title = document.createElement("div");
  title.className = "thumb-title";
  const sub = document.createElement("div");
  sub.className = "thumb-host";
  sub.textContent = host(url);
  titleRow.append(title, sub);

  const actions = document.createElement("div");
  actions.className = "thumb-actions";
  const openBtn = document.createElement("button");
  openBtn.textContent = "Open";
  openBtn.title = "Open in popup";
  openBtn.addEventListener("click", (e) => { e.stopPropagation(); setIndex(idx); openPopup(); });
  const viewBtn = document.createElement("button");
  viewBtn.textContent = "View";
  viewBtn.title = "Open in single view";
  viewBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setIndex(idx);
    state.view = "single";
    render();
    loadFrame();
  });
  actions.append(openBtn, viewBtn);

  const tags = document.createElement("div");
  tags.className = "thumb-tags";

  const decide = document.createElement("div");
  decide.className = "decision-row";
  const validBtn = document.createElement("button");
  validBtn.className = "decide-btn valid";
  validBtn.textContent = "✓ Valid";
  validBtn.title = "Mark valid (y)";
  validBtn.addEventListener("click", (e) => { e.stopPropagation(); setValidity(url, "valid"); });
  const invalidBtn = document.createElement("button");
  invalidBtn.className = "decide-btn invalid";
  invalidBtn.textContent = "✕ Invalid";
  invalidBtn.title = "Mark invalid (n)";
  invalidBtn.addEventListener("click", (e) => { e.stopPropagation(); setValidity(url, "invalid"); });
  decide.append(validBtn, invalidBtn);

  metaRow.append(fav, titleRow, actions, tags, decide);
  card.append(shot, metaRow);
  updateCard(card, url);
  return card;
}

// ---------- Screenshot queue ----------

function screenshotUrl(url, viewport) {
  return `/api/screenshot?url=${encodeURIComponent(url)}&viewport=${viewport}`;
}

function resetScreenshotQueue() {
  screenshotRunId++;
  screenshotQueue = [];
  screenshotActive = 0;
}

let thumbObserver = null;
function observeThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      // Once a screenshot is loaded, we're done with this card.
      if (card.classList.contains("loaded")) {
        thumbObserver.unobserve(card);
        continue;
      }
      // Skip if already in flight or already queued — don't re-queue duplicates.
      if (card.dataset.shotInFlight === "1") continue;
      // Failed cards retry when they come back into view. Clear the failed
      // styling before retry so the placeholder shows "Loading preview" again.
      if (card.classList.contains("failed")) {
        card.classList.remove("failed");
      }
      queueScreenshot(card);
    }
  }, { rootMargin: "600px 0px" });
  els.thumbGrid.querySelectorAll(".thumb").forEach(c => thumbObserver.observe(c));
}

const DEAD_ERROR_RE = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|timeout)/i;

function isKnownDead(url) {
  const c = state.checks[url];
  if (!c) return false;
  return c.status === 0 && DEAD_ERROR_RE.test(c.error || "");
}

function queueScreenshot(card) {
  const url = card.dataset.url;
  if (isKnownDead(url)) {
    card.classList.add("failed");
    delete card.dataset.shotInFlight;
    return;
  }
  card.dataset.shotInFlight = "1";
  screenshotQueue.push({ card, runId: screenshotRunId });
  pumpScreenshotQueue();
}

function pumpScreenshotQueue() {
  while (screenshotActive < SCREENSHOT_CONCURRENCY && screenshotQueue.length) {
    const job = screenshotQueue.shift();
    if (job.runId !== screenshotRunId) continue;
    if (!job.card.isConnected) {
      delete job.card.dataset.shotInFlight;
      continue;
    }
    screenshotActive++;
    loadScreenshot(job).finally(() => { screenshotActive--; pumpScreenshotQueue(); });
  }
}

function loadScreenshot(job) {
  return new Promise((resolve) => {
    if (job.runId !== screenshotRunId) return resolve();
    const card = job.card;
    const img = card.querySelector("img[data-url]");
    if (!img) { delete card.dataset.shotInFlight; return resolve(); }
    const url = card.dataset.url;

    const markSettled = (ok) => {
      delete card.dataset.shotInFlight;
      if (ok) {
        card.classList.remove("failed");
        card.classList.add("loaded");
        resolve();
        return;
      }
      const attempts = Number(card.dataset.shotAttempts || 0) + 1;
      card.dataset.shotAttempts = String(attempts);
      card.classList.remove("loaded");
      if (attempts < SCREENSHOT_MAX_RETRIES) {
        // Schedule a retry; if the card scrolls into view during that window the
        // IntersectionObserver will kick it off even sooner.
        setTimeout(() => {
          if (!card.isConnected) return;
          if (card.classList.contains("loaded")) return;
          queueScreenshot(card);
        }, 2000 * attempts);
      } else {
        card.classList.add("failed");
      }
      resolve();
    };

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      markSettled(false);
    }, SCREENSHOT_TIMEOUT_MS);
    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      markSettled(true);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      markSettled(false);
    };
    // Cache-bust on retry so the browser actually re-requests.
    const attempts = Number(card.dataset.shotAttempts || 0);
    const bust = attempts ? `&retry=${attempts}` : "";
    img.src = screenshotUrl(url, state.viewport) + bust;
  });
}

// ---------- Metadata ----------

async function loadMetadataFor(url) {
  try {
    const res = await fetch(`/api/metadata?url=${encodeURIComponent(url)}`);
    if (!res.ok) return;
    const m = await res.json();
    const prev = state.meta[url];
    state.meta[url] = { ...prev, ...m };
    saveLocal();
    updateItem(url);
  } catch {}
}

async function loadMetadataForVisible() {
  // Metadata is already populated by /api/check on the initial pass.
  // This is a backfill for any URL that was loaded from storage without meta.
  const filtered = filteredUrls();
  for (const idx of filtered) {
    const url = state.urls[idx];
    if (!state.meta[url]?.title && !state.checks[url]) loadMetadataFor(url);
  }
}

// ---------- Checks ----------

async function runChecks({ force = false } = {}) {
  if (!state.urls.length) return;
  const runId = ++checkRunId;
  const targets = state.urls.filter(u => force || !state.checks[u]);
  if (!targets.length) { notify("All URLs already checked."); return; }
  notify(`Checking ${targets.length} URLs...`);
  let cursor = 0;
  let processed = 0;
  const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length && runId === checkRunId) {
      const url = targets[cursor++];
      try {
        const res = await fetch(`/api/check?url=${encodeURIComponent(url)}`);
        const json = await res.json();
        if (runId !== checkRunId) return;
        state.checks[url] = {
          status: json.status || 0,
          statusText: json.statusText || "",
          responseMs: json.responseMs || 0,
          finalUrl: json.finalUrl || "",
          contentType: json.contentType || "",
          redirects: json.redirects || [],
          error: json.error || null,
          errorKind: json.errorKind || null,
          verdict: json.verdict || null,
          verdictConfidence: json.verdictConfidence || 0,
          verdictEvidence: json.verdictEvidence || [],
        };
        if (json.metadata) {
          state.meta[url] = { ...state.meta[url], ...json.metadata };
        }
        updateItem(url);
        updateAutoRejectButton();
        if (url === currentUrl()) renderDetail();
      } catch {
        if (runId !== checkRunId) return;
        state.checks[url] = { status: 0, error: "fetch_failed" };
        updateItem(url);
      }
      processed++;
      if (processed % 16 === 0) { saveLocal(); updateStats(); }
      if (CHECK_DELAY_MS && cursor < targets.length) await new Promise(r => setTimeout(r, CHECK_DELAY_MS));
    }
  });
  await Promise.all(workers);
  saveLocal();
  updateStats();
  if (runId === checkRunId) {
    const bad = state.urls.filter(u => ["4xx", "5xx", "err"].includes(statusCategory(state.checks[u]))).length;
    notify(`Checked. ${bad} bad/unreachable.`);
  }
}

// ---------- Selection ----------

function toggleSelect(url) {
  if (selection.has(url)) selection.delete(url);
  else selection.add(url);
  updateItem(url);
  renderBulkBar();
}

function rangeSelect(fromIdx, toIdx) {
  const a = Math.min(fromIdx, toIdx), b = Math.max(fromIdx, toIdx);
  for (let i = a; i <= b; i++) {
    selection.add(state.urls[i]);
    updateItem(state.urls[i]);
  }
  renderBulkBar();
}

function selectAllFiltered() {
  const filtered = filteredUrls();
  for (const i of filtered) {
    const u = state.urls[i];
    selection.add(u);
    updateItem(u);
  }
  renderBulkBar();
}

function clearSelection() {
  const prev = [...selection];
  selection.clear();
  for (const u of prev) updateItem(u);
  renderBulkBar();
}

function renderBulkBar() {
  const count = selection.size;
  els.bulkBar.classList.toggle("visible", count > 0);
  els.bulkCount.textContent = `${count} selected`;
  document.body.classList.toggle("selection-mode", count > 0);
}

// ---------- Index / nav ----------

function setIndex(i, { keepView = true } = {}) {
  if (!state.urls.length) { state.index = 0; saveLocal(); render(); return; }
  state.index = Math.max(0, Math.min(state.urls.length - 1, i));
  saveLocal();
  if (!keepView && state.view === "grid") state.view = "single";
  updateActive();
  renderDetail();
  updateToolbarState();
  if (state.view === "single") loadFrame();
}

function move(step) {
  if (!state.urls.length) return;
  const filtered = filteredUrls();
  const currentPos = filtered.indexOf(state.index);
  if (currentPos < 0) { setIndex(filtered[0] ?? 0); return; }
  const nextPos = Math.max(0, Math.min(filtered.length - 1, currentPos + step));
  setIndex(filtered[nextPos]);
}

// Jump through only URLs that still need a manual decision:
// skip already-decided URLs AND skip auto-classified bad ones (they'll be
// handled by the bulk auto-reject button).
function moveTriage(step) {
  if (!state.urls.length) return;
  const filtered = filteredUrls();
  if (!filtered.length) return;
  const needsHumanLook = (idx) => {
    const u = state.urls[idx];
    const review = state.review[u];
    if (review === "approved" || review === "rejected") return false;
    if (isAutoRejectCandidate(u)) return false;
    return true;
  };
  let pos = filtered.indexOf(state.index);
  if (pos < 0) pos = 0;
  const n = filtered.length;
  for (let i = 1; i <= n; i++) {
    const p = ((pos + i * step) % n + n) % n;
    if (needsHumanLook(filtered[p])) {
      setIndex(filtered[p]);
      return;
    }
  }
  notify("No more URLs need manual review.");
}

function loadFrame() {
  const url = currentUrl();
  clearTimeout(frameHelpTimer);
  els.frameHelp.classList.remove("visible");
  els.frame.src = url || "about:blank";
  if (url) {
    frameHelpTimer = setTimeout(() => {
      if (state.view === "single" && currentUrl() === url) {
        els.frameHelp.classList.add("visible");
      }
    }, 4500);
  }
}

function openPopup() {
  const url = currentUrl();
  if (!url) return;
  const win = window.open(url, "wv2_preview", "popup=yes,width=1280,height=900");
  if (win) win.focus();
}

// ---------- Detail panel ----------

function renderDetail() {
  const url = currentUrl();
  const meta = state.meta[url] || {};
  const check = state.checks[url] || {};

  // Verdict row
  const v = verdictFor(url);
  const conf = check.verdictConfidence ?? meta.verdictConfidence ?? 0;
  const evidence = check.verdictEvidence || meta.verdictEvidence || [];
  els.verdictRow.replaceChildren();
  if (url) {
    const pill = document.createElement("span");
    pill.className = `verdict-pill ${v}`;
    pill.textContent = VERDICT_LABELS[v] || v;
    els.verdictRow.append(pill);
    if (conf) {
      const confPill = document.createElement("span");
      confPill.className = "badge muted";
      confPill.textContent = `${Math.round(conf * 100)}% conf`;
      els.verdictRow.append(confPill);
    }
  }
  els.evidenceList.replaceChildren();
  for (const e of evidence) {
    const li = document.createElement("li");
    li.textContent = e;
    els.evidenceList.append(li);
  }
  els.reclassifyBtn.disabled = !url;

  const kv = [];
  if (url) kv.push(["URL", `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`]);
  if (check.finalUrl && check.finalUrl !== url) kv.push(["Final", `<a href="${escapeAttr(check.finalUrl)}" target="_blank" rel="noopener">${escapeHtml(check.finalUrl)}</a>`]);
  if (check.status !== undefined) kv.push(["Status", `${check.status || "—"} ${escapeHtml(check.statusText || "")}`.trim()]);
  if (check.responseMs) kv.push(["Response", `${check.responseMs} ms`]);
  if (check.contentType) kv.push(["Type", escapeHtml(check.contentType)]);
  if (check.redirects?.length) kv.push(["Redirects", String(check.redirects.length)]);
  if (meta.title) kv.push(["Title", escapeHtml(meta.title)]);
  if (meta.description) kv.push(["Description", escapeHtml(meta.description)]);
  if (meta.canonical) kv.push(["Canonical", `<a href="${escapeAttr(meta.canonical)}" target="_blank" rel="noopener">${escapeHtml(meta.canonical)}</a>`]);
  if (meta.lang) kv.push(["Lang", escapeHtml(meta.lang)]);
  if (meta.ogImage) kv.push(["OG image", `<a href="${escapeAttr(meta.ogImage)}" target="_blank" rel="noopener">open</a>`]);

  els.detailKv.innerHTML = kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

  const review = state.review[url] || "unreviewed";
  els.reviewButtons.querySelectorAll("button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.review === review);
  });

  const tags = state.tags[url] || [];
  els.tagEditor.replaceChildren();
  for (const t of tags) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    const c = tagColor(t);
    chip.style.background = c + "33";
    chip.style.color = c;
    chip.innerHTML = `${escapeHtml(t)}<span class="rm" role="button" aria-label="Remove tag">×</span>`;
    chip.querySelector(".rm").addEventListener("click", () => removeTag(url, t));
    els.tagEditor.append(chip);
  }

  els.tagSuggest.replaceChildren();
  const all = new Set();
  for (const u of state.urls) for (const t of (state.tags[u] || [])) all.add(t);
  for (const t of state.tagPalette) all.add(t.name);
  const suggest = [...all].filter(t => !tags.includes(t)).sort().slice(0, 8);
  for (const t of suggest) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    const c = tagColor(t);
    chip.style.background = c + "22";
    chip.style.color = c;
    chip.style.opacity = ".7";
    chip.textContent = t;
    chip.addEventListener("click", () => addTag(url, t));
    els.tagSuggest.append(chip);
  }

  if (document.activeElement !== els.notesArea) {
    els.notesArea.value = state.notes[url] || "";
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

function addTag(url, tag) {
  const t = String(tag || "").trim().replace(/^#/, "");
  if (!t) return;
  const existing = state.tags[url] || [];
  if (existing.includes(t)) return;
  state.tags[url] = [...existing, t];
  ensureTagInPalette(t);
  saveLocal();
  scheduleProjectSave();
  renderDetail();
  renderTagFilter();
  updateItem(url);
}

function removeTag(url, tag) {
  const existing = state.tags[url] || [];
  state.tags[url] = existing.filter(t => t !== tag);
  if (!state.tags[url].length) delete state.tags[url];
  saveLocal();
  scheduleProjectSave();
  renderDetail();
  renderTagFilter();
  updateItem(url);
}

// ---------- Compare view ----------

function renderCompare() {
  const grid = els.compareGrid;
  grid.className = `compare-view cols-${state.compareCols}`;
  grid.replaceChildren();
  compareColButtons.forEach(b => b.classList.toggle("active", Number(b.dataset.cols) === state.compareCols));
  const urls = state.compareUrls.slice(0, Math.max(state.compareCols, 4));
  const slotCount = Math.max(state.compareCols, urls.length || state.compareCols);
  for (let i = 0; i < slotCount; i++) {
    const url = urls[i];
    const slot = document.createElement("div");
    slot.className = `compare-slot${url ? "" : " empty"}`;

    const head = document.createElement("div");
    head.className = "slot-head";
    if (url) {
      const fav = document.createElement("img");
      fav.className = "thumb-fav";
      fav.src = `/api/favicon?url=${encodeURIComponent(url)}`;
      fav.onerror = () => { fav.style.visibility = "hidden"; };
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = (state.meta[url]?.title || host(url));
      const vpSel = document.createElement("select");
      vpSel.innerHTML = `<option value="desktop">🖥</option><option value="tablet">📱</option><option value="mobile">📲</option>`;
      vpSel.value = slot.dataset.viewport || state.viewport;
      slot.dataset.viewport = vpSel.value;
      vpSel.addEventListener("change", () => {
        slot.dataset.viewport = vpSel.value;
        const img = slot.querySelector("img.shot");
        if (img) img.src = screenshotUrl(url, vpSel.value);
      });
      const rm = document.createElement("button");
      rm.className = "icon ghost";
      rm.textContent = "✕";
      rm.addEventListener("click", () => {
        state.compareUrls = state.compareUrls.filter(u => u !== url);
        saveLocal();
        renderCompare();
      });
      head.append(fav, title, vpSel, rm);
    } else {
      head.innerHTML = `<div></div><div class="title" style="color: var(--muted)">Empty slot</div><div></div><div></div>`;
    }

    const body = document.createElement("div");
    body.className = "slot-body";
    if (url) {
      const img = document.createElement("img");
      img.className = "shot";
      img.alt = `Preview of ${host(url)}`;
      img.src = screenshotUrl(url, slot.dataset.viewport || state.viewport);
      body.append(img);
    } else {
      body.textContent = "Add current URL from the toolbar";
    }

    slot.append(head, body);
    grid.append(slot);
  }
}

function compareAddCurrent() {
  const url = currentUrl();
  if (!url) return;
  if (!state.compareUrls.includes(url)) state.compareUrls.push(url);
  if (state.compareUrls.length > state.compareCols) state.compareUrls = state.compareUrls.slice(-state.compareCols);
  saveLocal();
  state.view = "compare";
  render();
}

// ---------- Export / Import ----------

function download(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportAs(format, selectionOnly) {
  const urls = selectionOnly ? state.urls.filter(u => selection.has(u)) : state.urls;
  if (!urls.length) { notify("Nothing to export."); return; }
  const name = (state.projectName || "urls").replace(/\s+/g, "-").toLowerCase();
  if (format === "urls") {
    download(`${name}.txt`, "text/plain", urls.join("\n"));
  } else if (format === "csv") {
    const rows = ["url,status"];
    for (const url of urls) {
      const v = validityFor(url) || "";
      rows.push(`${csvEscape(url)},${v}`);
    }
    download(`${name}.csv`, "text/csv", rows.join("\n"));
  } else if (format === "json") {
    const payload = {
      name: state.projectName,
      exportedAt: new Date().toISOString(),
      urls,
      checks: Object.fromEntries(Object.entries(state.checks).filter(([k]) => urls.includes(k))),
      meta: Object.fromEntries(Object.entries(state.meta).filter(([k]) => urls.includes(k))),
      tags: Object.fromEntries(Object.entries(state.tags).filter(([k]) => urls.includes(k))),
      notes: Object.fromEntries(Object.entries(state.notes).filter(([k]) => urls.includes(k))),
      review: Object.fromEntries(Object.entries(state.review).filter(([k]) => urls.includes(k))),
      tagPalette: state.tagPalette,
    };
    download(`${name}.json`, "application/json", JSON.stringify(payload, null, 2));
  } else if (format === "md") {
    const lines = [`# ${state.projectName}`, "", `Exported ${new Date().toLocaleString()}`, ""];
    for (const url of urls) {
      const m = state.meta[url] || {};
      const c = state.checks[url] || {};
      const tags = (state.tags[url] || []).map(t => `\`#${t}\``).join(" ");
      lines.push(`## [${m.title || host(url)}](${url})`);
      const bits = [];
      if (c.status) bits.push(`status ${c.status}`);
      if (c.responseMs) bits.push(`${c.responseMs}ms`);
      if (state.review[url] && state.review[url] !== "unreviewed") bits.push(state.review[url]);
      if (tags) bits.push(tags);
      if (bits.length) lines.push(`_${bits.join(" · ")}_`);
      if (m.description) lines.push("", m.description);
      if (state.notes[url]) lines.push("", "> " + state.notes[url].replace(/\n/g, "\n> "));
      lines.push("");
    }
    download(`${name}.md`, "text/markdown", lines.join("\n"));
  } else if (format === "html") {
    const cards = urls.map(url => {
      const m = state.meta[url] || {};
      const c = state.checks[url] || {};
      return `<article><a href="${escapeAttr(url)}" target="_blank" rel="noopener"><strong>${escapeHtml(m.title || host(url))}</strong></a><br><small>${escapeHtml(host(url))} · ${c.status || "—"} · ${c.responseMs || "—"}ms</small>${m.description ? `<p>${escapeHtml(m.description)}</p>` : ""}${state.notes[url] ? `<blockquote>${escapeHtml(state.notes[url])}</blockquote>` : ""}</article>`;
    }).join("\n");
    const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(state.projectName)}</title><style>body{font:14px system-ui;margin:24px;max-width:760px}article{padding:12px 0;border-bottom:1px solid #ddd}blockquote{color:#555;border-left:3px solid #ccc;padding-left:10px;margin:6px 0}</style><h1>${escapeHtml(state.projectName)}</h1>${cards}`;
    download(`${name}.html`, "text/html", html);
  }
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------- Imports ----------

async function handleFiles(files) {
  const added = [];
  for (const file of files) {
    const text = await file.text();
    const urls = parseFile(file.name, text);
    added.push(...urls);
  }
  if (!added.length) { notify("No URLs found in file."); return; }
  const unique = Array.from(new Set(added));
  appendUrls(unique);
  notify(`Imported ${unique.length} URLs.`);
}

function appendUrls(urls) {
  const existing = new Set(state.urls);
  const fresh = urls.filter(u => !existing.has(u));
  state.urls.push(...fresh);
  resetVisibleLimit();
  saveLocal();
  scheduleProjectSave();
  scheduleRender();
  if (fresh.length) {
    runChecks({ force: false });
    loadMetadataForVisible();
  }
}

function loadFromInput() {
  const urls = parseUrls(els.urlInput.value);
  if (!urls.length) { notify("No URLs found."); return; }
  newProject(state.projectName || "Untitled", urls);
}

function appendFromInput() {
  const urls = parseUrls(els.urlInput.value);
  if (!urls.length) { notify("No URLs found."); return; }
  appendUrls(urls);
  els.urlInput.value = "";
}

// ---------- Project CRUD (client) ----------

function newProject(name, urls = []) {
  state = defaultState();
  state.projectName = name || "Untitled";
  state.urls = Array.from(new Set(urls.map(normaliseUrl).filter(Boolean)));
  state.view = "grid";
  selection.clear();
  resetVisibleLimit();
  invalidateRendered();
  saveLocal();
  scheduleProjectSave();
  renderAll();
  loadFrame();
  if (state.urls.length) {
    runChecks({ force: false });
    loadMetadataForVisible();
  }
}

async function deleteCurrentProject() {
  if (!state.projectId) {
    newProject("Untitled");
    return;
  }
  if (!confirm(`Delete project "${state.projectName}"?`)) return;
  try {
    await fetch(`/api/projects/${state.projectId}`, { method: "DELETE" });
    newProject("Untitled");
    await loadProjects();
  } catch {
    notify("Delete failed.");
  }
}

function renameCurrentProject() {
  openPrompt("Rename project", state.projectName, (name) => {
    if (!name) return;
    state.projectName = name;
    saveLocal();
    scheduleProjectSave();
    renderProjectSelect();
  });
}

// ---------- Modals ----------

function openModal(id) { document.getElementById(id).classList.add("visible"); }
function closeModals() { document.querySelectorAll(".modal.visible").forEach(m => m.classList.remove("visible")); }

function openPrompt(title, initial, cb) {
  els.promptTitle.textContent = title;
  els.promptInput.value = initial || "";
  const onOk = () => {
    const v = els.promptInput.value.trim();
    closeModals();
    els.promptOk.removeEventListener("click", onOk);
    cb(v);
  };
  els.promptOk.addEventListener("click", onOk);
  openModal("promptModal");
  setTimeout(() => els.promptInput.focus(), 50);
}

// ---------- Theme / layout ----------

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  saveLocal();
  applyTheme();
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  els.mainArea.classList.toggle("sidebar-hidden", !sidebarOpen);
}

// ---------- Event wiring ----------

function wireEvents() {
  els.loadBtn.addEventListener("click", loadFromInput);
  els.appendBtn.addEventListener("click", appendFromInput);
  els.checkBtn.addEventListener("click", () => runChecks({ force: true }));
  document.getElementById("clearBtn").addEventListener("click", () => {
    if (!confirm("Clear all URLs in this project?")) return;
    state.urls = [];
    state.checks = {};
    state.meta = {};
    state.tags = {};
    state.notes = {};
    state.review = {};
    selection.clear();
    resetVisibleLimit();
    invalidateRendered();
    saveLocal();
    scheduleProjectSave();
    render();
    loadFrame();
  });

  els.filter.addEventListener("input", () => {
    state.filter.q = els.filter.value;
    resetVisibleLimit();
    invalidateRendered();
    scheduleRender();
  });
  els.statusFilter.addEventListener("change", () => {
    state.filter.status = els.statusFilter.value;
    resetVisibleLimit();
    invalidateRendered();
    render();
  });
  els.verdictFilter.addEventListener("change", () => {
    state.filter.verdict = els.verdictFilter.value;
    resetVisibleLimit();
    invalidateRendered();
    render();
  });
  els.reclassifyBtn.addEventListener("click", async () => {
    const url = currentUrl();
    if (!url) return;
    els.reclassifyBtn.disabled = true;
    try {
      const res = await fetch(`/api/check?url=${encodeURIComponent(url)}`);
      const json = await res.json();
      state.checks[url] = {
        status: json.status || 0,
        statusText: json.statusText || "",
        responseMs: json.responseMs || 0,
        finalUrl: json.finalUrl || "",
        contentType: json.contentType || "",
        redirects: json.redirects || [],
        error: json.error || null,
        errorKind: json.errorKind || null,
        verdict: json.verdict || null,
        verdictConfidence: json.verdictConfidence || 0,
        verdictEvidence: json.verdictEvidence || [],
      };
      if (json.metadata) state.meta[url] = { ...state.meta[url], ...json.metadata };
      saveLocal();
      updateItem(url);
      updateAutoRejectButton();
      renderDetail();
      updateStats();
    } finally {
      els.reclassifyBtn.disabled = false;
    }
  });
  els.reviewFilter.addEventListener("change", () => {
    state.filter.review = els.reviewFilter.value;
    resetVisibleLimit();
    invalidateRendered();
    render();
  });
  els.tagFilter.addEventListener("change", () => {
    state.filter.tag = els.tagFilter.value;
    resetVisibleLimit();
    invalidateRendered();
    render();
  });
  els.sortBy.addEventListener("change", () => {
    state.sort = els.sortBy.value;
    invalidateRendered();
    render();
  });

  viewModeButtons.forEach(b => b.addEventListener("click", () => {
    state.view = b.dataset.view;
    saveLocal();
    render();
    if (state.view === "single") loadFrame();
  }));

  viewportButtons.forEach(b => b.addEventListener("click", () => {
    if (state.viewport === b.dataset.viewport) return;
    state.viewport = b.dataset.viewport;
    saveLocal();
    render();
  }));

  compareColButtons.forEach(b => b.addEventListener("click", () => {
    state.compareCols = Number(b.dataset.cols);
    saveLocal();
    renderCompare();
  }));

  els.compareAdd.addEventListener("click", compareAddCurrent);
  els.compareClear.addEventListener("click", () => { state.compareUrls = []; saveLocal(); renderCompare(); });

  els.densitySelect.addEventListener("change", () => {
    state.density = els.densitySelect.value;
    saveLocal();
    render();
  });

  els.prevBtn.addEventListener("click", () => move(-1));
  els.nextBtn.addEventListener("click", () => move(1));
  els.popupBtn.addEventListener("click", openPopup);
  els.frameHelpOpen.addEventListener("click", openPopup);
  els.frameHelpDismiss.addEventListener("click", () => els.frameHelp.classList.remove("visible"));
  els.reloadBtn.addEventListener("click", () => {
    if (state.view === "single") loadFrame();
    else if (state.view === "grid") {
      invalidateRendered();
      render();
    }
  });

  els.current.addEventListener("click", () => {
    const u = currentUrl();
    if (!u) return;
    navigator.clipboard?.writeText(u).then(() => notify("Copied."));
  });

  els.detailBtn.addEventListener("click", () => {
    document.getElementById("singleLayout").classList.toggle("no-detail");
  });

  // Drop zone
  els.dropZone.addEventListener("dragover", (e) => { e.preventDefault(); els.dropZone.classList.add("drag"); });
  els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("drag"));
  els.dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("drag");
    if (e.dataTransfer.files?.length) {
      await handleFiles(e.dataTransfer.files);
    } else {
      const txt = e.dataTransfer.getData("text");
      if (txt) {
        els.urlInput.value = txt;
        appendFromInput();
      }
    }
  });
  els.importBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", async () => {
    if (els.fileInput.files?.length) await handleFiles(els.fileInput.files);
    els.fileInput.value = "";
  });

  // Bulk actions
  els.bulkClear.addEventListener("click", clearSelection);
  els.bulkDelete.addEventListener("click", () => {
    if (!selection.size) return;
    if (!confirm(`Remove ${selection.size} URLs?`)) return;
    state.urls = state.urls.filter(u => !selection.has(u));
    for (const u of selection) {
      delete state.checks[u]; delete state.meta[u]; delete state.tags[u];
      delete state.notes[u]; delete state.review[u];
    }
    selection.clear();
    invalidateRendered();
    saveLocal();
    scheduleProjectSave();
    render();
  });
  els.bulkReview.addEventListener("click", () => {
    const cycle = ["unreviewed", "reviewed", "flagged", "approved", "rejected"];
    const current = selection.size ? state.review[[...selection][0]] || "unreviewed" : "unreviewed";
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
    for (const u of selection) {
      if (next === "unreviewed") delete state.review[u];
      else state.review[u] = next;
      updateItem(u);
    }
    notify(`Marked ${selection.size} as ${next}.`);
    saveLocal();
    scheduleProjectSave();
  });
  els.bulkTag.addEventListener("click", () => {
    openPrompt("Add tag to selection", "", (tag) => {
      if (!tag) return;
      for (const u of selection) addTag(u, tag);
      notify(`Tagged ${selection.size}.`);
    });
  });
  els.bulkExport.addEventListener("click", () => {
    els.exportSelectionOnly.checked = true;
    els.exportSelectionCount.textContent = String(selection.size);
    openModal("exportModal");
  });
  els.bulkCapture.addEventListener("click", () => {
    for (const u of selection) {
      const img = new Image();
      img.src = screenshotUrl(u, state.viewport);
    }
    notify(`Capturing ${selection.size} screenshots in background.`);
  });

  // Detail panel — review & notes & tags
  els.reviewButtons.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-review]");
    if (!btn) return;
    const url = currentUrl();
    if (!url) return;
    const r = btn.dataset.review;
    if (r === "unreviewed") delete state.review[url];
    else state.review[url] = r;
    saveLocal();
    scheduleProjectSave();
    els.reviewButtons.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.review === r));
    updateItem(url);
  });
  els.tagAdd.addEventListener("click", () => {
    const url = currentUrl();
    if (!url) return;
    const v = els.tagInput.value.trim();
    if (!v) return;
    addTag(url, v);
    els.tagInput.value = "";
  });
  els.tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); els.tagAdd.click(); }
  });
  els.notesArea.addEventListener("input", () => {
    const url = currentUrl();
    if (!url) return;
    clearTimeout(notesDebounce);
    const v = els.notesArea.value;
    notesDebounce = setTimeout(() => {
      if (v) state.notes[url] = v;
      else delete state.notes[url];
      saveLocal();
      scheduleProjectSave();
      updateItem(url);
    }, 600);
  });

  // Project picker
  els.projectSelect.addEventListener("change", () => {
    const id = els.projectSelect.value;
    if (id === "__local__") return;
    if (id === state.projectId) return;
    loadProject(id);
  });
  els.newProjectBtn.addEventListener("click", () => {
    openPrompt("New project name", "", (name) => newProject(name || "Untitled"));
  });
  els.renameProjectBtn.addEventListener("click", renameCurrentProject);
  els.deleteProjectBtn.addEventListener("click", deleteCurrentProject);
  els.toggleSidebarBtn.addEventListener("click", toggleSidebar);
  els.themeBtn.addEventListener("click", toggleTheme);
  els.helpBtn.addEventListener("click", () => openModal("helpModal"));

  els.autoRejectBtn.addEventListener("click", autoRejectBadVerdicts);
  els.undoBtn.addEventListener("click", () => hideUndoBanner(true));
  els.undoKeepBtn.addEventListener("click", () => hideUndoBanner(false));

  // Export modal
  document.querySelectorAll("#exportModal [data-export]").forEach(btn => {
    btn.addEventListener("click", () => {
      exportAs(btn.dataset.export, els.exportSelectionOnly.checked);
      closeModals();
    });
  });

  document.getElementById("exportBtn").addEventListener("click", () => {
    els.exportSelectionOnly.checked = false;
    els.exportSelectionCount.textContent = String(selection.size);
    openModal("exportModal");
  });

  document.querySelectorAll("[data-close-modal]").forEach(b => b.addEventListener("click", closeModals));
  document.querySelectorAll(".modal").forEach(m => {
    m.addEventListener("click", (e) => { if (e.target === m) closeModals(); });
  });

  window.addEventListener("keydown", onKey);
}

function onKey(e) {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (typing) {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }
  if (e.key === "Escape") { closeModals(); return; }
  const k = e.key.toLowerCase();
  if (k === "j" || e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); move(1); }
  else if (k === "k" || e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
  else if (e.key === "Enter") { e.preventDefault(); openPopup(); }
  else if (k === "g") { state.view = "grid"; render(); }
  else if (k === "s") { state.view = "single"; render(); loadFrame(); }
  else if (k === "c") { state.view = "compare"; render(); }
  else if (e.key === "1") { if (state.viewport !== "desktop") { state.viewport = "desktop"; render(); } }
  else if (e.key === "2") { if (state.viewport !== "tablet") { state.viewport = "tablet"; render(); } }
  else if (e.key === "3") { if (state.viewport !== "mobile") { state.viewport = "mobile"; render(); } }
  else if (k === "r") runChecks({ force: true });
  else if (k === "x") { const u = currentUrl(); if (u) toggleSelect(u); }
  else if (k === "a" && !e.shiftKey) { e.preventDefault(); selectAllFiltered(); }
  else if (k === "a" && e.shiftKey) { e.preventDefault(); clearSelection(); }
  else if (k === "f") {
    const u = currentUrl();
    if (u) { state.review[u] = "flagged"; saveLocal(); scheduleProjectSave(); updateItem(u); renderDetail(); }
  }
  else if (k === "v") {
    const u = currentUrl();
    if (u) { state.review[u] = "reviewed"; saveLocal(); scheduleProjectSave(); updateItem(u); renderDetail(); }
  }
  else if (k === "y") {
    const u = currentUrl();
    if (u) { setValidity(u, "valid"); moveTriage(1); }
  }
  else if (k === "n") {
    const u = currentUrl();
    if (u) { setValidity(u, "invalid"); moveTriage(1); }
  }
  else if (e.key === "]") { e.preventDefault(); moveTriage(1); }
  else if (e.key === "[") { e.preventDefault(); moveTriage(-1); }
  else if (e.key === "Delete" || e.key === "Backspace") {
    if (selection.size) { els.bulkDelete.click(); }
    else {
      const u = currentUrl();
      if (u && confirm(`Remove ${host(u)}?`)) {
        state.urls.splice(state.index, 1);
        delete state.checks[u]; delete state.meta[u]; delete state.tags[u];
        delete state.notes[u]; delete state.review[u];
        state.index = Math.min(state.index, state.urls.length - 1);
        invalidateRendered();
        saveLocal();
        scheduleProjectSave();
        render();
        loadFrame();
      }
    }
  }
  else if (k === "/" || e.key === "/") { e.preventDefault(); els.filter.focus(); }
  else if (e.key === "\\") { e.preventDefault(); toggleSidebar(); }
  else if (k === "t") toggleTheme();
  else if (e.key === "?" || (e.shiftKey && e.key === "/")) { e.preventDefault(); openModal("helpModal"); }
}

// ---------- Init ----------

async function init() {
  const local = loadLocal();
  if (local) state = local;
  applyTheme();
  els.urlInput.value = "";
  els.filter.value = state.filter.q || "";
  els.statusFilter.value = state.filter.status;
  els.verdictFilter.value = state.filter.verdict || "all";
  els.reviewFilter.value = state.filter.review;
  els.tagFilter.value = state.filter.tag;
  els.sortBy.value = state.sort;
  els.densitySelect.value = state.density;

  wireEvents();
  await loadProjects();
  if (state.projectId && projects.some(p => p.id === state.projectId)) {
    await loadProject(state.projectId);
  } else {
    renderAll();
    loadFrame();
    if (state.urls.length) {
      runChecks({ force: false });
      loadMetadataForVisible();
    }
  }
}

init();
