const PALETTE = [
  "#ff6b6b", "#ffbf47", "#36c483", "#4da3ff", "#8e7bff",
  "#ff8ad1", "#2cc5bf", "#ffa45c", "#a06bff", "#78c4ff",
];

const SCREENSHOT_CONCURRENCY = 8;
const SCREENSHOT_TIMEOUT_MS = 45_000;
const SCREENSHOT_MAX_RETRIES = 2;
const SCREENSHOT_BACKGROUND_DELAY_MS = 700;
const CHECK_CONCURRENCY = 6;
const CHECK_DELAY_MS = 0;
const PREVIEW_SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const VIEWER_SESSION_ID = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
const VIEWER_SESSION_HEARTBEAT_MS = 20_000;
const EXPORT_TITLE = "Website Review";
const EXPORT_BASENAME = "website-review";

// ---------- State ----------

const els = {};
const ALL_ELS = [
  "app", "urlInput", "loadBtn", "appendBtn", "checkBtn", "importBtn", "fileInput",
  "dropZone", "filter", "statusFilter", "verdictFilter", "reviewFilter", "tagFilter", "sortBy",
  "list", "stats", "bulkBar", "bulkCount", "bulkReview", "bulkTag", "bulkExport",
  "bulkCapture", "bulkDelete", "bulkClear",
  "empty", "current", "thumbGrid", "prevBtn", "nextBtn",
  "popupBtn", "reloadBtn", "densitySelect", "toast", "gridView",
  "toggleSidebarBtn", "themeBtn", "helpBtn", "helpModal", "exportModal", "promptModal",
  "promptTitle", "promptInput", "promptOk", "exportSelectionOnly", "exportSelectionCount",
  "mainArea",
  "autoRejectBtn", "autoRejectCount",
  "undoBanner", "undoMessage", "undoBtn", "undoKeepBtn", "undoCountdown",
];
for (const id of ALL_ELS) {
  els[id] = document.getElementById(id);
  if (!els[id]) throw new Error(`Missing required UI element #${id}`);
}

let state = defaultState();
let urlLookup = new Set();
let selection = new Set();
let renderQueued = false;
let toastTimer = null;
let checkRunId = 0;
let checkAbortController = null;
let screenshotRunId = 0;
let screenshotQueue = [];
let screenshotActive = 0;
let previewProgressStartedAt = 0;
let backgroundPreviewTimer = null;
let statsRenderQueued = false;
let sidebarOpen = true;
let anchorIndex = null;
let forceRefreshUrls = new Set();
let serverSessionTimer = null;
let serverSessionEnded = false;

// Keyed-rebuild tracking: DOM rebuilt only when URL set changes
const rendered = {
  listKey: "",
  gridKey: "",
  density: "",
  activeUrl: null,
  filtered: [],
};

function defaultState() {
  return {
    urls: [],
    checks: {},
    meta: {},
    tags: {},
    review: {},
    tagPalette: [],
    index: 0,
    density: "spacious",
    filter: { q: "", status: "all", verdict: "all", review: "all", tag: "all" },
    sort: "added",
    theme: "dark",
  };
}

// ---------- Session state ----------

function clearLegacyLocalState() {
  try {
    localStorage.removeItem("wv2:state");
  } catch {}
}

function serverSessionUrl(action) {
  return `/api/session/${action}?id=${encodeURIComponent(VIEWER_SESSION_ID)}`;
}

function pingServerSession(action = "ping") {
  if (serverSessionEnded) return;
  fetch(serverSessionUrl(action), {
    method: "POST",
    cache: "no-store",
    keepalive: true,
  }).catch(() => {});
}

function endServerSession() {
  if (serverSessionEnded) return;
  serverSessionEnded = true;
  if (serverSessionTimer) {
    clearInterval(serverSessionTimer);
    serverSessionTimer = null;
  }
  const url = serverSessionUrl("end");
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url);
  } else {
    fetch(url, { method: "POST", cache: "no-store", keepalive: true }).catch(() => {});
  }
}

function startServerSession() {
  pingServerSession("start");
  serverSessionTimer = setInterval(() => pingServerSession("ping"), VIEWER_SESSION_HEARTBEAT_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pingServerSession("ping");
  });
  window.addEventListener("focus", () => pingServerSession("ping"));
  window.addEventListener("pagehide", endServerSession);
  window.addEventListener("beforeunload", endServerSession);
}

function cancelInFlightWork() {
  checkRunId++;
  checkAbortController?.abort();
  checkAbortController = null;
  forceRefreshUrls.clear();
  resetScreenshotQueue();
}

function syncUrlLookup() {
  urlLookup = new Set(state.urls);
}

function urlInCurrentList(url) {
  return urlLookup.has(url);
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
  const headerCells = splitCsvLine(lines[0]);
  const urlIdx = headerCells.findIndex(h => /^(url|link|website|site)$/i.test(h.trim().replace(/"/g, "")));
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
  if (check.fromScreenshot) {
    const raw = check.rawError ? ` Raw check: ${check.rawError}.` : "";
    return `Browser capture OK.${raw}`;
  }
  if (check.error) return check.error;
  if (!check.status) return "pending";
  return `${check.status}${check.statusText ? " " + check.statusText : ""}`;
}

function browserCaptureOk(url) {
  const m = state.meta[url] || {};
  return Boolean(m.screenshotOk && !m.screenshotDiagnostic && m.screenshotSessionId === PREVIEW_SESSION_ID);
}

function cardPreviewState(url) {
  const card = cardFor(url);
  if (!card) return "";
  if (card.classList.contains("loaded")) return "loaded";
  if (card.classList.contains("failed")) return "failed";
  if (card.dataset.shotActive === "1") return "active";
  if (card.dataset.shotQueued === "1") return "queued";
  return "";
}

function previewSettled(url) {
  const cardState = cardPreviewState(url);
  return cardState === "loaded" || cardState === "failed";
}

function effectiveCheck(url) {
  const check = state.checks[url];
  const meta = state.meta[url] || {};
  if (check?.status) return check;
  if (browserCaptureOk(url)) {
    return {
      ...(check || {}),
      status: meta.status || 200,
      statusText: meta.statusText || "Browser capture OK",
      responseMs: meta.responseMs || check?.responseMs || 0,
      finalUrl: meta.finalUrl || check?.finalUrl || "",
      contentType: meta.contentType || check?.contentType || "",
      error: null,
      fromScreenshot: true,
      rawError: check?.error || meta.screenshotError || "",
    };
  }
  if (check?.error && !previewSettled(url)) return null;
  return check;
}

function statusCategoryForUrl(url) {
  return statusCategory(effectiveCheck(url));
}

function noteBrowserCapture(url) {
  if (!urlInCurrentList(url)) return;
  const check = state.checks[url];
  if (check?.status || state.meta[url]?.screenshotDiagnostic) return;
  const prev = state.meta[url] || {};
  state.meta[url] = {
    ...prev,
    status: prev.status || 200,
    statusText: prev.statusText || "Browser capture OK",
    screenshotOk: true,
    screenshotSessionId: PREVIEW_SESSION_ID,
  };
  updateItem(url);
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

function pruneTagPalette() {
  const used = new Set(Object.values(state.tags).flat());
  state.tagPalette = state.tagPalette.filter(t => used.has(t.name));
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

function verdictFor(url) {
  return state.checks[url]?.verdict || state.meta[url]?.verdict || null;
}

// A URL is a "confident-bad" candidate for auto-reject if its verdict is in
// BAD_VERDICTS, or if its HTTP request failed with a dead-domain errorKind.
const AUTO_REJECT_ERROR_KINDS = new Set(["dns", "refused", "tls"]);
function isAutoRejectCandidate(url) {
  const v = verdictFor(url);
  if (v && BAD_VERDICTS.has(v)) return true;
  if (browserCaptureOk(url)) return false;
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
  updateItem(url);
  updateAutoRejectButton();
  scheduleStatsUpdate();
}

// ---------- Auto-reject + undo banner ----------

let undoTimer = null;
let undoCountdownTimer = null;
let pendingUndo = null; // { urls: [{url, prevReview}], commitTimer }
let promptCallback = null;

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
  updateAutoRejectButton();
  updateStats();
  showUndoBanner(`Rejected ${batch.length} suspect URLs`, () => {
    for (const { url, prev } of batch) {
      if (prev === undefined) delete state.review[url];
      else state.review[url] = prev;
      updateItem(url);
    }
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
      const cat = statusCategoryForUrl(url);
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
      const text = [url, host(url), meta.title || "", meta.description || ""].join("\n").toLowerCase();
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
  renderTagFilter();
  invalidateRendered();
  render();
}

function renderTagFilter() {
  const all = new Set();
  for (const url of state.urls) for (const t of (state.tags[url] || [])) all.add(t);
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
  rendered.filtered = filtered;

  updateToolbarState();
  updateViewVisibility(total);
  renderBulkBar();

  const key = filtered.map(i => state.urls[i]).join("\n");
  const densityKey = state.density;

  if (key !== rendered.listKey) {
    rebuildList(filtered);
    rendered.listKey = key;
  }

  if (key !== rendered.gridKey || densityKey !== rendered.density) {
    rebuildGrid(filtered);
    rendered.gridKey = key;
    rendered.density = densityKey;
  }

  // Stats AFTER the rebuilds so the preview count can read each card's current
  // DOM class. If we computed it before rebuild, cards either don't exist yet
  // (fresh load) or are about to be replaced, and the count would be wrong.
  updateStats(filtered, total);
  updateActive();
  updateAutoRejectButton();
}

function scheduleStatsUpdate() {
  if (statsRenderQueued) return;
  statsRenderQueued = true;
  requestAnimationFrame(() => {
    statsRenderQueued = false;
    updateStats();
  });
}

function updateToolbarState() {
  const url = currentUrl();
  const total = state.urls.length;
  els.current.textContent = url || "No URL loaded";
  els.prevBtn.disabled = !total || state.index <= 0;
  els.nextBtn.disabled = !total || state.index >= total - 1;
  els.popupBtn.disabled = !url;
  els.reloadBtn.disabled = !total;
  els.checkBtn.disabled = !total;
}

function updateViewVisibility(total) {
  els.empty.classList.toggle("hidden", total > 0);
  els.gridView.classList.toggle("active", total > 0);
}

function updateStats(filteredMaybe, totalMaybe) {
  const filtered = filteredMaybe ?? (rendered.filtered.length || state.urls.length ? rendered.filtered : filteredUrls());
  const total = totalMaybe ?? state.urls.length;
  let bad = 0, unchecked = 0, decided = 0;
  let previewsDone = 0, previewsActive = 0, previewsQueued = 0;
  for (const i of filtered) {
    const url = state.urls[i];
    const r = state.review[url];
    if (r === "approved" || r === "rejected") decided++;
    if (!effectiveCheck(url)) { unchecked++; continue; }
    if (isAutoRejectCandidate(url)) bad++;
  }
  for (const card of els.thumbGrid.children) {
    if (!card.classList?.contains("thumb")) continue;
    if (card.classList.contains("loaded") || card.classList.contains("failed")) previewsDone++;
    else if (card.dataset.shotActive === "1") previewsActive++;
    else if (card.dataset.shotQueued === "1") previewsQueued++;
  }
  els.stats.firstElementChild.innerHTML =
    `<b>${decided}</b>/<b>${filtered.length}</b> decided · <b>${total}</b> total · ${bad} suspect · ${unchecked} pending`;
  updatePreviewProgress({
    total: filtered.length,
    done: previewsDone,
    active: previewsActive,
    queued: previewsQueued,
  });
}

function updatePreviewProgress(progress) {
  let wrap = document.getElementById("previewProgress");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "previewProgress";
    wrap.className = "preview-progress";
    wrap.innerHTML = `
      <div class="preview-progress-head">
        <span id="previewProgressLabel"></span>
        <span id="previewProgressMeta"></span>
      </div>
      <div class="preview-track" aria-hidden="true"><div id="previewProgressFill" class="preview-fill"></div></div>
    `;
    els.stats.insertBefore(wrap, els.stats.lastElementChild);
  }

  const { total, done, active, queued } = progress;
  wrap.hidden = !total;
  if (!total) return;
  const pct = Math.round((done / total) * 100);
  const eta = previewEta(progress);
  document.getElementById("previewProgressLabel").textContent =
    `Previews ${done}/${total}${eta.label ? ` · ${eta.label}` : ""}`;
  document.getElementById("previewProgressMeta").textContent = eta.meta ||
    (done >= total ? "complete" : `${pct}% · ${active} loading · ${queued} queued`);
  document.getElementById("previewProgressFill").style.width = `${pct}%`;
}

function previewEta({ total, done, active, queued }) {
  if (!total) return { label: "", meta: "" };
  if (done >= total) {
    const elapsed = previewProgressStartedAt ? ` in ${formatDuration(Date.now() - previewProgressStartedAt)}` : "";
    return { label: "complete", meta: `complete${elapsed}` };
  }
  const remaining = Math.max(0, total - done);
  const pct = Math.round((done / total) * 100);
  const base = `${pct}% · ${active} loading · ${queued} queued`;
  if (!previewProgressStartedAt || !done) {
    return { label: "warming up", meta: active || queued ? `${base} · warming up` : "starting preview queue" };
  }
  const elapsed = Date.now() - previewProgressStartedAt;
  const enoughSamples = done >= Math.min(12, Math.max(4, Math.ceil(total * 0.03))) || elapsed >= 30_000;
  if (!enoughSamples) {
    return { label: "warming up", meta: `${base} · warming up` };
  }
  const rate = done / Math.max(1, elapsed);
  if (!Number.isFinite(rate) || rate <= 0) return { label: "estimating", meta: `${base} · estimating time left` };
  const etaMs = remaining / rate;
  return {
    label: `ETA ${formatDuration(etaMs)}`,
    meta: `${base} · ETA ${formatDuration(etaMs)} · elapsed ${formatDuration(elapsed)}`,
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
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
  if (!el) return;
  const check = effectiveCheck(url);
  const cat = statusCategory(check);
  const keepCardClass = el.classList.contains("card-status");
  el.className = `badge dot ${keepCardClass ? "card-status " : ""}${statusBadgeClass(cat)}`;
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
    const t = effectiveCheck(url)?.responseMs;
    ms.textContent = t ? `${t}ms` : "";
    ms.hidden = !t;
  }
  updateReviewPill(card.querySelector(".review-pill"), url);
  card.classList.toggle("selected", selection.has(url));
  card.classList.toggle("dim", isAutoRejectCandidate(url));
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

  const text = document.createElement("div");
  text.className = "text";
  const title = document.createElement("div");
  title.className = "title";
  const titleText = document.createElement("span");
  titleText.className = "title-text";
  title.append(titleText);
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

  row.append(cb, text, status);
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
  const shot = document.createElement("div");
  shot.className = "thumb-shot";

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
  // The app-level queue controls preview concurrency. Native lazy loading can
  // defer off-screen thumbnails even after the queue assigns src, which makes
  // long lists appear to stop loading until the user scrolls.
  img.loading = "eager";
  img.decoding = "async";
  img.alt = `Preview of ${host(url)}`;
  img.dataset.url = url;

  shot.append(selectBtn, badges, img);

  const metaRow = document.createElement("div");
  metaRow.className = "thumb-meta";

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
  actions.append(openBtn);

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

  metaRow.append(titleRow, actions, tags, decide);
  card.append(shot, metaRow);
  updateCard(card, url);
  return card;
}

// ---------- Screenshot queue ----------

function screenshotUrl(url, viewport, options = {}) {
  const params = new URLSearchParams({ url, viewport });
  if (options.retry) params.set("retry", String(options.retry));
  if (options.refresh) params.set("refresh", String(options.refresh));
  return `/api/screenshot?${params.toString()}`;
}

function resetScreenshotQueue() {
  screenshotRunId++;
  screenshotQueue = [];
  screenshotActive = 0;
  previewProgressStartedAt = 0;
  clearTimeout(backgroundPreviewTimer);
  backgroundPreviewTimer = null;
  els.thumbGrid?.querySelectorAll("img[data-url]").forEach((img) => img.removeAttribute("src"));
  scheduleStatsUpdate();
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
      // Skip active captures. Queued background captures can still be promoted.
      if (card.dataset.shotActive === "1") continue;
      // Failed cards retry when they come back into view. Clear the failed
      // styling before retry so the placeholder shows "Loading preview" again.
      if (card.classList.contains("failed")) {
        card.classList.remove("failed");
      }
      queueScreenshot(card, { priority: true });
    }
  }, { rootMargin: "600px 0px" });
  els.thumbGrid.querySelectorAll(".thumb").forEach(c => thumbObserver.observe(c));
  scheduleBackgroundPreviews();
}

function scheduleBackgroundPreviews() {
  clearTimeout(backgroundPreviewTimer);
  const runId = screenshotRunId;
  backgroundPreviewTimer = setTimeout(() => {
    if (runId !== screenshotRunId) return;
    queueAllBackgroundPreviews();
  }, SCREENSHOT_BACKGROUND_DELAY_MS);
}

function queueAllBackgroundPreviews() {
  const cards = [...els.thumbGrid.querySelectorAll(".thumb")];
  for (const card of cards) {
    if (card.classList.contains("loaded") || card.classList.contains("failed")) continue;
    queueScreenshot(card);
  }
  scheduleStatsUpdate();
}

function queueScreenshot(card, { priority = false } = {}) {
  if (!card?.isConnected || card.classList.contains("loaded")) return;
  if (!urlInCurrentList(card.dataset.url)) return;
  if (card.dataset.shotActive === "1") return;

  if (card.dataset.shotQueued === "1") {
    if (priority) {
      const existingIndex = screenshotQueue.findIndex(job => job.runId === screenshotRunId && job.card === card);
      if (existingIndex > 0) {
        const [job] = screenshotQueue.splice(existingIndex, 1);
        screenshotQueue.unshift(job);
      }
    }
    scheduleStatsUpdate();
    return;
  }

  card.dataset.shotQueued = "1";
  if (!previewProgressStartedAt) previewProgressStartedAt = Date.now();
  const job = { card, runId: screenshotRunId };
  if (priority) screenshotQueue.unshift(job);
  else screenshotQueue.push(job);
  scheduleStatsUpdate();
  pumpScreenshotQueue();
}

function pumpScreenshotQueue() {
  while (screenshotActive < SCREENSHOT_CONCURRENCY && screenshotQueue.length) {
    const job = screenshotQueue.shift();
    if (job.runId !== screenshotRunId || !urlInCurrentList(job.card?.dataset?.url)) {
      delete job.card?.dataset?.shotQueued;
      continue;
    }
    if (!job.card.isConnected) {
      delete job.card.dataset.shotQueued;
      continue;
    }
    delete job.card.dataset.shotQueued;
    job.card.dataset.shotActive = "1";
    scheduleStatsUpdate();
    screenshotActive++;
    loadScreenshot(job).finally(() => {
      if (job.runId === screenshotRunId) {
        screenshotActive = Math.max(0, screenshotActive - 1);
      }
      pumpScreenshotQueue();
    });
  }
}

function loadScreenshot(job) {
  return new Promise((resolve) => {
    const card = job.card;
    const img = card.querySelector("img[data-url]");
    if (!img) { delete card.dataset.shotActive; return resolve(); }
    const url = card.dataset.url;
    if (job.runId !== screenshotRunId || !urlInCurrentList(url)) {
      delete card.dataset.shotActive;
      return resolve();
    }

    const markSettled = (ok, reason = "") => {
      delete card.dataset.shotActive;
      if (job.runId !== screenshotRunId || !card.isConnected || !urlInCurrentList(url)) {
        scheduleStatsUpdate();
        resolve();
        return;
      }
      if (ok) {
        card.classList.remove("failed");
        card.classList.add("loaded");
        forceRefreshUrls.delete(url);
        noteBrowserCapture(url);
        scheduleStatsUpdate();
        loadMetadataFor(url).then(() => {
          scheduleStatsUpdate();
          updateAutoRejectButton();
        });
        resolve();
        return;
      }
      const attempts = Number(card.dataset.shotAttempts || 0) + 1;
      card.dataset.shotAttempts = String(attempts);
      card.classList.remove("loaded");
      if (reason !== "timeout" && attempts < SCREENSHOT_MAX_RETRIES) {
        // Schedule a retry; if the card scrolls into view during that window the
        // IntersectionObserver will kick it off even sooner.
        setTimeout(() => {
          if (!card.isConnected) return;
          if (card.classList.contains("loaded")) return;
          if (job.runId !== screenshotRunId || !urlInCurrentList(url)) return;
          queueScreenshot(card);
        }, 2000 * attempts);
      } else {
        card.classList.add("failed");
        forceRefreshUrls.delete(url);
      }
      scheduleStatsUpdate();
      resolve();
    };

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      img.removeAttribute("src");
      markSettled(false, "timeout");
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
      markSettled(false, "error");
    };
    // Cache-bust on retry so the browser actually re-requests.
    const attempts = Number(card.dataset.shotAttempts || 0);
    const refresh = forceRefreshUrls.has(url) ? `${Date.now()}-${attempts}` : "";
    img.src = screenshotUrl(url, "desktop", { retry: attempts || "", refresh });
  });
}

// ---------- Metadata ----------

async function loadMetadataFor(url) {
  if (!urlInCurrentList(url)) return;
  try {
    const res = await fetch(`/api/metadata?url=${encodeURIComponent(url)}`);
    if (!res.ok) return;
    const m = await res.json();
    if (!urlInCurrentList(url)) return;
    const prev = state.meta[url];
    const next = { ...prev, ...m };
    if (prev?.screenshotOk && !next.screenshotDiagnostic && (!next.status || Number(next.status) === 0)) {
      next.status = prev.status || 200;
      next.statusText = prev.statusText || "Browser capture OK";
      next.screenshotOk = true;
    }
    state.meta[url] = next;
    updateItem(url);
  } catch {}
}

// ---------- Checks ----------

async function runChecks({ force = false } = {}) {
  if (!state.urls.length) return;
  const runId = ++checkRunId;
  checkAbortController?.abort();
  const targets = state.urls.filter(u => force || !state.checks[u]);
  if (!targets.length) {
    checkAbortController = null;
    notify("All URLs already checked.");
    return;
  }
  const controller = new AbortController();
  checkAbortController = controller;
  notify(`Checking ${targets.length} URLs...`);
  let cursor = 0;
  let processed = 0;
  const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length && runId === checkRunId) {
      const url = targets[cursor++];
      if (!urlInCurrentList(url)) continue;
      try {
        const res = await fetch(`/api/check?url=${encodeURIComponent(url)}`, { signal: controller.signal });
        const json = await res.json();
        if (runId !== checkRunId) return;
        if (!urlInCurrentList(url)) continue;
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
      } catch (err) {
        if (controller.signal.aborted) return;
        if (runId !== checkRunId) return;
        if (!urlInCurrentList(url)) continue;
        state.checks[url] = { status: 0, error: "fetch_failed" };
        updateItem(url);
      }
      processed++;
      if (processed % 16 === 0) updateStats();
      if (CHECK_DELAY_MS && cursor < targets.length) await new Promise(r => setTimeout(r, CHECK_DELAY_MS));
    }
  });
  await Promise.all(workers);
  if (checkAbortController === controller) checkAbortController = null;
  updateStats();
  if (runId === checkRunId) {
    const bad = state.urls.filter(u => ["4xx", "5xx", "err"].includes(statusCategoryForUrl(u))).length;
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
  const visible = rendered.filtered.length ? rendered.filtered : filteredUrls();
  const fromPos = visible.indexOf(fromIdx);
  const toPos = visible.indexOf(toIdx);
  const range = fromPos >= 0 && toPos >= 0
    ? visible.slice(Math.min(fromPos, toPos), Math.max(fromPos, toPos) + 1)
    : Array.from({ length: Math.abs(toIdx - fromIdx) + 1 }, (_, i) => Math.min(fromIdx, toIdx) + i);
  for (const idx of range) {
    const url = state.urls[idx];
    if (!url) continue;
    selection.add(url);
    updateItem(url);
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

function setIndex(i) {
  if (!state.urls.length) { state.index = 0; render(); return; }
  state.index = Math.max(0, Math.min(state.urls.length - 1, i));
  updateActive();
  updateToolbarState();
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

function openPopup() {
  const url = currentUrl();
  if (!url) return;
  const win = window.open(url, "_blank", "noopener,noreferrer,popup=yes,width=1280,height=900");
  if (win) {
    win.opener = null;
    win.focus();
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

function addTagToSelection(tag) {
  const t = String(tag || "").trim().replace(/^#/, "");
  if (!t || !selection.size) return 0;
  const changed = [];
  for (const url of selection) {
    const existing = state.tags[url] || [];
    if (existing.includes(t)) continue;
    state.tags[url] = [...existing, t];
    changed.push(url);
  }
  if (!changed.length) return 0;
  ensureTagInPalette(t);
  renderTagFilter();
  for (const url of changed) updateItem(url);
  return changed.length;
}

function forceRefreshUrlsFor(urls) {
  let count = 0;
  for (const url of urls) {
    if (!urlInCurrentList(url)) continue;
    forceRefreshUrls.add(url);
    count++;
  }
  return count;
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
  const urlSet = new Set(urls);
  const name = EXPORT_BASENAME;
  if (format === "urls") {
    download(`${name}.txt`, "text/plain", urls.join("\n"));
  } else if (format === "csv") {
    const rows = ["url,review,http_status,response_ms,title"];
    for (const url of urls) {
      const c = effectiveCheck(url) || {};
      const m = state.meta[url] || {};
      const review = validityFor(url) || state.review[url] || "";
      rows.push([
        csvEscape(url),
        csvEscape(review),
        csvEscape(c.status || ""),
        csvEscape(c.responseMs || ""),
        csvEscape(m.title || host(url)),
      ].join(","));
    }
    download(`${name}.csv`, "text/csv", rows.join("\n"));
  } else if (format === "json") {
    const payload = {
      name: EXPORT_TITLE,
      exportedAt: new Date().toISOString(),
      urls,
      checks: Object.fromEntries(Object.entries(state.checks).filter(([k]) => urlSet.has(k))),
      meta: Object.fromEntries(Object.entries(state.meta).filter(([k]) => urlSet.has(k))),
      tags: Object.fromEntries(Object.entries(state.tags).filter(([k]) => urlSet.has(k))),
      review: Object.fromEntries(Object.entries(state.review).filter(([k]) => urlSet.has(k))),
      tagPalette: state.tagPalette,
    };
    download(`${name}.json`, "application/json", JSON.stringify(payload, null, 2));
  } else if (format === "md") {
    const lines = [`# ${EXPORT_TITLE}`, "", `Exported ${new Date().toLocaleString()}`, ""];
    for (const url of urls) {
      const m = state.meta[url] || {};
      const c = effectiveCheck(url) || {};
      const tags = (state.tags[url] || []).map(t => `\`#${t}\``).join(" ");
      lines.push(`## [${m.title || host(url)}](${url})`);
      const bits = [];
      if (c.status) bits.push(`status ${c.status}`);
      if (c.responseMs) bits.push(`${c.responseMs}ms`);
      if (state.review[url] && state.review[url] !== "unreviewed") bits.push(state.review[url]);
      if (tags) bits.push(tags);
      if (bits.length) lines.push(`_${bits.join(" · ")}_`);
      if (m.description) lines.push("", m.description);
      lines.push("");
    }
    download(`${name}.md`, "text/markdown", lines.join("\n"));
  } else if (format === "html") {
    const cards = urls.map(url => {
      const m = state.meta[url] || {};
      const c = effectiveCheck(url) || {};
      return `<article><a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(m.title || host(url))}</strong></a><br><small>${escapeHtml(host(url))} · ${c.status || "—"} · ${c.responseMs || "—"}ms</small>${m.description ? `<p>${escapeHtml(m.description)}</p>` : ""}</article>`;
    }).join("\n");
    const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(EXPORT_TITLE)}</title><style>body{font:14px system-ui;margin:24px;max-width:760px}article{padding:12px 0;border-bottom:1px solid #ddd}blockquote{color:#555;border-left:3px solid #ccc;padding-left:10px;margin:6px 0}</style><h1>${escapeHtml(EXPORT_TITLE)}</h1>${cards}`;
    download(`${name}.html`, "text/html", html);
  }
}

function csvEscape(v) {
  let s = String(v ?? "");
  if (/^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s)) s = `'${s}`;
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
  if (fresh.length) syncUrlLookup();
  scheduleRender();
  if (fresh.length) {
    runChecks({ force: false });
  }
}

function loadFromInput() {
  const urls = parseUrls(els.urlInput.value);
  if (!urls.length) { notify("No URLs found."); return; }
  startNewList(urls);
}

function appendFromInput() {
  const urls = parseUrls(els.urlInput.value);
  if (!urls.length) { notify("No URLs found."); return; }
  appendUrls(urls);
  els.urlInput.value = "";
}

// ---------- List lifecycle ----------

function startNewList(urls = []) {
  cancelInFlightWork();
  state = defaultState();
  state.urls = Array.from(new Set(urls.map(normaliseUrl).filter(Boolean)));
  syncUrlLookup();
  selection.clear();
  invalidateRendered();
  renderAll();
  if (state.urls.length) {
    runChecks({ force: false });
  }
}

// ---------- Modals ----------

function openModal(id) { document.getElementById(id).classList.add("visible"); }
function closeModals() {
  document.querySelectorAll(".modal.visible").forEach(m => m.classList.remove("visible"));
  promptCallback = null;
}

function openPrompt(title, initial, cb) {
  els.promptTitle.textContent = title;
  els.promptInput.value = initial || "";
  promptCallback = cb;
  openModal("promptModal");
  setTimeout(() => els.promptInput.focus(), 50);
}

function submitPrompt() {
  const cb = promptCallback;
  if (!cb) return closeModals();
  const value = els.promptInput.value.trim();
  promptCallback = null;
  closeModals();
  cb(value);
}

// ---------- Theme / layout ----------

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme();
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  applySidebarState();
}

function applySidebarState() {
  els.mainArea.classList.toggle("sidebar-hidden", !sidebarOpen);
  els.mainArea.classList.toggle("sidebar-open", sidebarOpen);
}

// ---------- Event wiring ----------

function wireEvents() {
  els.loadBtn.addEventListener("click", loadFromInput);
  els.appendBtn.addEventListener("click", appendFromInput);
  els.checkBtn.addEventListener("click", () => runChecks({ force: true }));
  document.getElementById("clearBtn").addEventListener("click", () => {
    if (!confirm("Clear all URLs in this list?")) return;
    cancelInFlightWork();
    state.urls = [];
    state.checks = {};
    state.meta = {};
    state.tags = {};
    state.review = {};
    state.tagPalette = [];
    state.index = 0;
    syncUrlLookup();
    selection.clear();
    invalidateRendered();
    renderAll();
  });

  els.filter.addEventListener("input", () => {
    state.filter.q = els.filter.value;
    invalidateRendered();
    scheduleRender();
  });
  els.statusFilter.addEventListener("change", () => {
    state.filter.status = els.statusFilter.value;
    invalidateRendered();
    render();
  });
  els.verdictFilter.addEventListener("change", () => {
    state.filter.verdict = els.verdictFilter.value;
    invalidateRendered();
    render();
  });
  els.reviewFilter.addEventListener("change", () => {
    state.filter.review = els.reviewFilter.value;
    invalidateRendered();
    render();
  });
  els.tagFilter.addEventListener("change", () => {
    state.filter.tag = els.tagFilter.value;
    invalidateRendered();
    render();
  });
  els.sortBy.addEventListener("change", () => {
    state.sort = els.sortBy.value;
    invalidateRendered();
    render();
  });

  els.densitySelect.addEventListener("change", () => {
    state.density = els.densitySelect.value;
    render();
  });

  els.prevBtn.addEventListener("click", () => move(-1));
  els.nextBtn.addEventListener("click", () => move(1));
  els.popupBtn.addEventListener("click", openPopup);
  els.reloadBtn.addEventListener("click", () => {
    const urls = filteredUrls().map(i => state.urls[i]);
    const count = forceRefreshUrlsFor(urls);
    invalidateRendered();
    render();
    if (count) notify(`Refreshing ${count} previews.`);
  });

  els.current.addEventListener("click", () => {
    const u = currentUrl();
    if (!u) return;
    navigator.clipboard?.writeText(u).then(() => notify("Copied."));
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
      delete state.review[u];
      forceRefreshUrls.delete(u);
    }
    pruneTagPalette();
    syncUrlLookup();
    state.index = Math.max(0, Math.min(state.index, state.urls.length - 1));
    selection.clear();
    invalidateRendered();
    renderTagFilter();
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
    updateAutoRejectButton();
    scheduleStatsUpdate();
    notify(`Marked ${selection.size} as ${next}.`);
  });
  els.bulkTag.addEventListener("click", () => {
    openPrompt("Add tag to selection", "", (tag) => {
      if (!tag) return;
      const changed = addTagToSelection(tag);
      notify(changed ? `Tagged ${changed}.` : "No URLs changed.");
    });
  });
  els.bulkExport.addEventListener("click", () => {
    els.exportSelectionOnly.checked = true;
    els.exportSelectionCount.textContent = String(selection.size);
    openModal("exportModal");
  });
  // Force-refresh visible cards so the grid actually re-renders each preview.
  // Cards outside the current filter won't have a DOM element; for those we
  // just warm the server-side cache so the next time they're visible they're
  // already captured.
  els.bulkCapture.addEventListener("click", () => {
    if (!selection.size) return;
    let refreshed = 0;
    for (const u of selection) {
      forceRefreshUrls.add(u);
      const card = cardFor(u);
      if (card) {
        card.classList.remove("loaded", "failed");
        delete card.dataset.shotAttempts;
        const img = card.querySelector("img[data-url]");
        if (img) img.removeAttribute("src");
        queueScreenshot(card, { priority: true });
        refreshed++;
      } else {
        const refresh = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        fetch(screenshotUrl(u, "desktop", { refresh }))
          .catch(() => {})
          .finally(() => forceRefreshUrls.delete(u));
      }
    }
    notify(`Capturing ${selection.size} screenshots${refreshed < selection.size ? " (some off-screen)" : ""}.`);
  });

  els.toggleSidebarBtn.addEventListener("click", toggleSidebar);
  els.themeBtn.addEventListener("click", toggleTheme);
  els.helpBtn.addEventListener("click", () => openModal("helpModal"));

  els.autoRejectBtn.addEventListener("click", autoRejectBadVerdicts);
  els.undoBtn.addEventListener("click", () => hideUndoBanner(true));
  els.undoKeepBtn.addEventListener("click", () => hideUndoBanner(false));
  els.promptOk.addEventListener("click", submitPrompt);
  els.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPrompt();
  });

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
  else if (k === "r") runChecks({ force: true });
  else if (k === "x") { const u = currentUrl(); if (u) toggleSelect(u); }
  else if (k === "a" && !e.shiftKey) { e.preventDefault(); selectAllFiltered(); }
  else if (k === "a" && e.shiftKey) { e.preventDefault(); clearSelection(); }
  else if (k === "f") {
    const u = currentUrl();
    if (u) { state.review[u] = "flagged"; updateItem(u); scheduleStatsUpdate(); }
  }
  else if (k === "v") {
    const u = currentUrl();
    if (u) { state.review[u] = "reviewed"; updateItem(u); scheduleStatsUpdate(); }
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
  else if (e.key === "Delete" || (e.key === "Backspace" && selection.size)) {
    // Backspace only deletes when there's a selection (and the bulk handler
    // already confirms). For the single current URL we require Delete to avoid
    // accidental deletes when focus has drifted off a form field.
    if (selection.size) { els.bulkDelete.click(); }
    else {
      const u = currentUrl();
      if (u && confirm(`Remove ${host(u)}?`)) {
        state.urls.splice(state.index, 1);
        delete state.checks[u]; delete state.meta[u]; delete state.tags[u];
        delete state.review[u];
        forceRefreshUrls.delete(u);
        pruneTagPalette();
        syncUrlLookup();
        state.index = Math.max(0, Math.min(state.index, state.urls.length - 1));
        invalidateRendered();
        renderTagFilter();
        render();
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
  clearLegacyLocalState();
  startServerSession();
  applyTheme();
  applySidebarState();
  els.urlInput.value = "";
  els.filter.value = state.filter.q || "";
  els.statusFilter.value = state.filter.status;
  els.verdictFilter.value = state.filter.verdict || "all";
  els.reviewFilter.value = state.filter.review;
  els.tagFilter.value = state.filter.tag;
  els.sortBy.value = state.sort;
  els.densitySelect.value = state.density;

  wireEvents();
  renderAll();
}

init();
