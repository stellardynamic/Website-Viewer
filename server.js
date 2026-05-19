const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const net = require("net");
const dns = require("dns");
const { URL } = require("url");
const express = require("express");
const puppeteer = require("puppeteer");
const { version: APP_VERSION } = require("./package.json");

const PORT = envNumber("PORT", 4174, 1);
const HOST = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const ROOT = __dirname;
const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "website-viewer-"));
const CACHE_DIR = path.join(RUNTIME_DIR, "cache");
const BROWSER_PROFILE_DIR = path.join(RUNTIME_DIR, "browser-profile");
const PUBLIC_DIR = path.join(ROOT, "public");

const MAX_CONCURRENT_SHOTS = envNumber("SCREENSHOT_CONCURRENCY", 8, 1);
const MAX_CONCURRENT_CHECKS = envNumber("SERVER_CHECK_CONCURRENCY", 6, 1);
const PROVIDER_SHOT_CONCURRENCY = envNumber("PROVIDER_SHOT_CONCURRENCY", 2, 1);
const THROTTLED_PROVIDER_SHOT_CONCURRENCY = envNumber("THROTTLED_PROVIDER_SHOT_CONCURRENCY", 1, 1);
const PROVIDER_SHOT_DELAY_MS = envNumber("PROVIDER_SHOT_DELAY_MS", 350, 0);
const THROTTLED_PROVIDER_SHOT_DELAY_MS = envNumber("THROTTLED_PROVIDER_SHOT_DELAY_MS", 2500, 0);
const PROVIDER_CHECK_CONCURRENCY = envNumber("PROVIDER_CHECK_CONCURRENCY", 2, 1);
const THROTTLED_PROVIDER_CHECK_CONCURRENCY = envNumber("THROTTLED_PROVIDER_CHECK_CONCURRENCY", 1, 1);
const PROVIDER_CHECK_DELAY_MS = envNumber("PROVIDER_CHECK_DELAY_MS", 250, 0);
const THROTTLED_PROVIDER_CHECK_DELAY_MS = envNumber("THROTTLED_PROVIDER_CHECK_DELAY_MS", 1500, 0);
const CACHE_TTL_MS = Number(process.env.SCREENSHOT_SESSION_CACHE_TTL_HOURS || 12) * 3600 * 1000;
const CHECK_TIMEOUT_MS = 12_000;
const CAPTURE_TIMEOUT_MS = envNumber("CAPTURE_TIMEOUT_MS", 30_000, 5_000);
const CAPTURE_NAV_TIMEOUT_MS = envNumber("CAPTURE_NAV_TIMEOUT_MS", 8_000, 1_000);
const CAPTURE_IDLE_MS = envNumber("CAPTURE_IDLE_MS", 250, 0);
const CAPTURE_IDLE_TIMEOUT_MS = envNumber("CAPTURE_IDLE_TIMEOUT_MS", 500, 0);
const CAPTURE_SETTLE_MS = envNumber("CAPTURE_SETTLE_MS", 300, 0);
const CAPTURE_SPARSE_EXTRA_WAIT_MS = envNumber("CAPTURE_SPARSE_EXTRA_WAIT_MS", 1_600, 0);
const SCREENSHOT_STEP_TIMEOUT_MS = envNumber("SCREENSHOT_STEP_TIMEOUT_MS", 8_000, 1_000);
const SCREENSHOT_JPEG_QUALITY = Math.min(100, envNumber("SCREENSHOT_JPEG_QUALITY", 72, 1));
const METADATA_BYTES = 512 * 1024;
const ALLOW_PRIVATE_TARGETS = envFlag("ALLOW_PRIVATE_TARGETS", false);
const TARGET_SAFETY_CACHE_MS = 60_000;
const META_STORE_MAX_ENTRIES = envNumber("META_STORE_MAX_ENTRIES", 10_000, 10);
const AUTO_SHUTDOWN = envFlag("AUTO_SHUTDOWN", true);
const AUTO_SHUTDOWN_DEBUG = envFlag("AUTO_SHUTDOWN_DEBUG", false);
const AUTO_SHUTDOWN_GRACE_MS = envNumber("AUTO_SHUTDOWN_GRACE_MS", 5 * 60_000, 1_000);
const AUTO_SHUTDOWN_STARTUP_GRACE_MS = envNumber("AUTO_SHUTDOWN_STARTUP_GRACE_MS", 30 * 60_000, AUTO_SHUTDOWN_GRACE_MS);
const AUTO_SHUTDOWN_CHECK_MS = envNumber("AUTO_SHUTDOWN_CHECK_MS", 15_000, 1_000);
const VIEWER_SESSION_TTL_MS = envNumber("VIEWER_SESSION_TTL_MS", 90_000, 1_000);

const PARKER_HOSTS = [
  "sedoparking.com", "sedo.com/search", "parkingcrew.net", "parkingcrew.com",
  "cashparking.com", "bodis.com", "above.com", "uniregistry.com",
  "dan.com/buy-domain", "hugedomains.com", "afternic.com",
  "buydomains.com", "voodoo.com", "domainmarket.com", "godaddy.com/park",
  "domainparking.ru", "parkingdots.com", "parklogic.com", "teamintel.com",
  "domainsponsor.com", "smartname.com", "epik.com/park",
  "fabulous.com", "trafficz.com", "internettraffic.com", "rook.com",
  "parkquick.com", "fastpark.net",
];

const FOR_SALE_PHRASES = [
  "this domain is for sale", "this domain name is for sale",
  "buy this domain", "purchase this domain", "inquire about this domain",
  "make an offer", "make offer", "domain for sale",
  "this web page is parked", "this webpage is parked", "parked free",
  "parked courtesy of", "courtesy of godaddy", "this site is for sale",
  "interested in this domain", "own this domain", "lease this domain",
  "the domain name is available", "want to buy this domain",
  "get this domain", "is listed for sale",
];

const PARKING_PHRASES = [
  "related searches", "sponsored listings", "sponsored links",
  "ads by", "popular searches", "top searches",
  "trending categories", "related links",
  "checkout our top picks", "may be for sale", "could be for sale",
];

const TEMPLATE_GENERATORS = [
  "wordpress", "wix", "wix.com", "squarespace", "shopify",
  "webflow", "weebly", "duda", "godaddy website builder",
  "site123", "jimdo", "strikingly",
];

const TEMPLATE_PHRASES = [
  "welcome to wordpress", "your website hosted by wix",
  "this is an example page", "sample page",
  "start writing or type / to choose a block",
  "edit or delete it, then start writing",
  "just another wordpress site",
  "change this sentence in header settings",
  "your site title here",
  "proudly powered by wordpress",
];

const MARKETPLACE_HOSTS = [
  "amazon.com", "amazon.co.uk", "amazon.de",
  "linkedin.com", "facebook.com", "twitter.com", "x.com",
  "instagram.com", "tiktok.com", "youtube.com",
  "ebay.com", "alibaba.com", "aliexpress.com",
  "etsy.com", "pinterest.com", "reddit.com",
  "quora.com", "medium.com",
];

const TWO_PART_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
  "co.nz", "com.br", "com.mx", "com.tr", "co.jp", "co.kr", "co.in",
  "com.sg", "com.hk", "com.cn", "com.ar", "com.pl", "com.sa",
]);

const THROTTLED_PROVIDER_KEYS = new Set([
  ...MARKETPLACE_HOSTS,
  "google.com", "bing.com", "snapchat.com", "threads.net",
  "salesforce.com", "hubspot.com",
].map(providerKeyForHost));

const STOP_TOKENS = new Set([
  "com", "net", "org", "io", "co", "us", "biz", "info", "dev", "app",
  "site", "web", "online", "global", "world", "inc", "llc", "ltd", "corp",
  "group", "company", "the", "and", "for", "of", "www", "html", "cloud",
  "digital", "studio", "agency", "services", "shop", "store",
]);

const VIEWPORTS = {
  desktop: { width: 1152, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false, ua: "desktop" },
};

// Block known tracker / analytics / ad domains at the Chrome network layer
// (Network.setBlockedURLs via CDP). This avoids the per-request roundtrip cost
// of page.setRequestInterception and meaningfully cuts page load time on
// ad-heavy sites because the page no longer waits on third-party scripts.
const BLOCKED_URL_PATTERNS = [
  "*://*.doubleclick.net/*",
  "*://*.googletagmanager.com/*",
  "*://*.google-analytics.com/*",
  "*://*.googleadservices.com/*",
  "*://*.googlesyndication.com/*",
  "*://*.googletagservices.com/*",
  "*://analytics.google.com/*",
  "*://*.adservice.google.com/*",
  "*://*.facebook.net/*",
  "*://connect.facebook.net/*",
  "*://px.ads.linkedin.com/*",
  "*://platform.twitter.com/*",
  "*://*.ads-twitter.com/*",
  "*://bat.bing.com/*",
  "*://*.clarity.ms/*",
  "*://*.hotjar.com/*",
  "*://*.hotjar.io/*",
  "*://*.mixpanel.com/*",
  "*://*.segment.io/*",
  "*://*.segment.com/*",
  "*://*.amplitude.com/*",
  "*://*.fullstory.com/*",
  "*://*.mouseflow.com/*",
  "*://*.crazyegg.com/*",
  "*://*.pendo.io/*",
  "*://*.optimizely.com/*",
  "*://*.scorecardresearch.com/*",
  "*://*.quantserve.com/*",
  "*://*.snowplowanalytics.com/*",
  "*://*.amazon-adsystem.com/*",
  "*://*.adnxs.com/*",
  "*://*.newrelic.com/*",
  "*://*.bugsnag.com/*",
  "*://*.sentry.io/*",
  "*://*.cloudflareinsights.com/*",
  // Video / audio — skipping these saves 0.5–1.5s on landing pages with hero
  // background videos. The pages still render normally; only the media element
  // shows its poster image (a separate JPG/PNG that's not blocked here).
  "*://*/*.mp4*",
  "*://*/*.webm*",
  "*://*/*.m4v*",
  "*://*/*.mov*",
  "*://*/*.avi*",
  "*://*/*.mp3*",
  "*://*/*.wav*",
  "*://*/*.ogg*",
  "*://*/*.m4a*",
  "*://*/*.flac*",
  // Fonts are expensive and rarely matter for identifying whether the right
  // page loaded in a thumbnail. The browser falls back to local system fonts.
  "*://*/*.woff*",
  "*://*/*.ttf*",
  "*://*/*.otf*",
  "*://*/*.eot*",
];

const rangePatterns = (prefix, from, to) =>
  Array.from({ length: to - from + 1 }, (_, index) => `*://${prefix}.${from + index}.*/*`);

const firstOctetPatterns = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, index) => `*://${from + index}.*/*`);

const PRIVATE_NETWORK_BLOCK_PATTERNS = [
  "*://localhost/*",
  "*://*.localhost/*",
  "*://*.local/*",
  "*://0.*/*",
  "*://10.*/*",
  ...rangePatterns("100", 64, 127),
  "*://127.*/*",
  "*://169.254.*/*",
  ...rangePatterns("172", 16, 31),
  "*://192.0.0.*/*",
  "*://192.0.2.*/*",
  "*://192.168.*/*",
  "*://198.18.*/*",
  "*://198.19.*/*",
  "*://198.51.100.*/*",
  "*://203.0.113.*/*",
  ...firstOctetPatterns(224, 255),
  "*://[::]/*",
  "*://[::1]/*",
];

const USER_AGENTS = {
  desktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 WebsiteViewer/1.0",
};

for (const dir of [RUNTIME_DIR, CACHE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()");
  next();
});
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (isCrossSiteBrowserRequest(req)) return res.status(403).json({ error: "forbidden" });
  next();
});

let browserPromise = null;
const metaStore = new Map();
const viewerSessions = new Map();
const serverStartedAt = Date.now();
let noViewerSince = null;
let hasSeenViewerSession = false;
let autoShutdownTimer = null;
let shuttingDown = false;

const screenshotLimiter = createProviderLimiter({
  name: "screenshots",
  maxConcurrent: MAX_CONCURRENT_SHOTS,
  providerConcurrency: PROVIDER_SHOT_CONCURRENCY,
  throttledProviderConcurrency: THROTTLED_PROVIDER_SHOT_CONCURRENCY,
  providerDelayMs: PROVIDER_SHOT_DELAY_MS,
  throttledProviderDelayMs: THROTTLED_PROVIDER_SHOT_DELAY_MS,
});

const checkLimiter = createProviderLimiter({
  name: "checks",
  maxConcurrent: MAX_CONCURRENT_CHECKS,
  providerConcurrency: PROVIDER_CHECK_CONCURRENCY,
  throttledProviderConcurrency: THROTTLED_PROVIDER_CHECK_CONCURRENCY,
  providerDelayMs: PROVIDER_CHECK_DELAY_MS,
  throttledProviderDelayMs: THROTTLED_PROVIDER_CHECK_DELAY_MS,
});

function envNumber(name, fallback, min = 0) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function formatDuration(ms) {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function queryFlag(value) {
  if (Array.isArray(value)) return value.some(queryFlag);
  const s = String(value ?? "").trim().toLowerCase();
  return Boolean(s) && !["0", "false", "no", "off"].includes(s);
}

function headerOriginMatchesHost(req, headerName) {
  const value = req.get(headerName);
  if (!value) return false;
  try {
    const expectedHost = String(req.get("host") || "").toLowerCase();
    return Boolean(expectedHost) && new URL(value).host.toLowerCase() === expectedHost;
  } catch {
    return false;
  }
}

function isCrossSiteBrowserRequest(req) {
  const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") return true;
  return fetchSite !== "same-origin" &&
    !headerOriginMatchesHost(req, "origin") &&
    !headerOriginMatchesHost(req, "referer");
}

function providerKeyForUrl(raw) {
  try {
    return providerKeyForHost(new URL(raw).hostname);
  } catch {
    return "unknown";
  }
}

function providerKeyForHost(hostname) {
  const lower = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!lower) return "unknown";
  if (lower === "localhost" || net.isIP(lower)) return lower;
  const labels = lower.split(".").filter(Boolean);
  if (labels.length <= 2) return lower;
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_PART_TLDS.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

function sessionIdFromReq(req) {
  const id = String(req.query.id || "").trim();
  if (!/^[a-z0-9._:-]{8,120}$/i.test(id)) return "";
  return id;
}

function pruneStaleViewerSessions(now = Date.now()) {
  for (const [id, lastSeen] of viewerSessions) {
    if (now - lastSeen > VIEWER_SESSION_TTL_MS) viewerSessions.delete(id);
  }
}

function recordViewerSession(req) {
  const id = sessionIdFromReq(req);
  if (!id) return "";
  hasSeenViewerSession = true;
  viewerSessions.set(id, Date.now());
  noViewerSince = null;
  return id;
}

function endViewerSession(req) {
  const id = sessionIdFromReq(req);
  if (id) viewerSessions.delete(id);
  pruneStaleViewerSessions();
  if (!viewerSessions.size && noViewerSince == null) noViewerSince = Date.now();
}

function activeBackgroundWork() {
  const shots = screenshotLimiter.snapshot();
  const checks = checkLimiter.snapshot();
  return shots.active + shots.queued + checks.active + checks.queued;
}

function checkAutoShutdown() {
  if (!AUTO_SHUTDOWN || shuttingDown) return;
  pruneStaleViewerSessions();
  const activeWork = activeBackgroundWork();
  if (AUTO_SHUTDOWN_DEBUG) {
    console.log(`auto-shutdown check: sessions=${viewerSessions.size} work=${activeWork} noViewerFor=${noViewerSince == null ? 0 : Date.now() - noViewerSince}ms`);
  }
  if (viewerSessions.size || activeWork) {
    noViewerSince = null;
    return;
  }
  if (!hasSeenViewerSession && Date.now() - serverStartedAt < AUTO_SHUTDOWN_STARTUP_GRACE_MS) {
    return;
  }
  if (noViewerSince == null) {
    noViewerSince = Date.now();
    return;
  }
  if (Date.now() - noViewerSince >= AUTO_SHUTDOWN_GRACE_MS) {
    shutdown("No Website Viewer tabs are open; shutting down local server.");
  }
}

function startAutoShutdownWatcher() {
  if (!AUTO_SHUTDOWN || autoShutdownTimer) return;
  if (AUTO_SHUTDOWN_DEBUG) console.log(`auto-shutdown watcher started; check every ${AUTO_SHUTDOWN_CHECK_MS}ms`);
  autoShutdownTimer = setInterval(checkAutoShutdown, AUTO_SHUTDOWN_CHECK_MS);
}

function createProviderLimiter(options) {
  const {
    name,
    maxConcurrent,
    providerConcurrency,
    throttledProviderConcurrency,
    providerDelayMs,
    throttledProviderDelayMs,
  } = options;
  let active = 0;
  const queue = [];
  const providers = new Map();
  let pumpTimer = null;

  function settleJob(job, settle, value) {
    if (job.settled) return;
    job.settled = true;
    job.unsubscribeAbort?.();
    job.unsubscribeAbort = null;
    settle(value);
  }

  function removeQueuedJob(job) {
    const idx = queue.indexOf(job);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    settleJob(job, job.reject, clientAbortError());
    return true;
  }

  function pruneAbortedQueue() {
    for (let i = queue.length - 1; i >= 0; i--) {
      const job = queue[i];
      if (job.signal?.aborted) removeQueuedJob(job);
    }
  }

  function stateFor(provider) {
    if (!providers.has(provider)) {
      providers.set(provider, { active: 0, nextAt: 0, backoffReason: "" });
    }
    return providers.get(provider);
  }

  function isThrottled(provider) {
    return THROTTLED_PROVIDER_KEYS.has(provider);
  }

  function maxFor(provider) {
    return isThrottled(provider) ? throttledProviderConcurrency : providerConcurrency;
  }

  function delayFor(provider) {
    return isThrottled(provider) ? throttledProviderDelayMs : providerDelayMs;
  }

  function schedulePump(delay) {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, Math.max(25, delay));
  }

  function pump() {
    pruneAbortedQueue();
    while (active < maxConcurrent && queue.length) {
      const now = Date.now();
      let chosen = -1;
      let soonest = Infinity;

      for (let i = 0; i < queue.length; i++) {
        const job = queue[i];
        const state = stateFor(job.provider);
        if (state.active >= maxFor(job.provider)) continue;
        if (state.nextAt > now) {
          soonest = Math.min(soonest, state.nextAt);
          continue;
        }
        chosen = i;
        break;
      }

      if (chosen === -1) {
        if (soonest < Infinity) schedulePump(soonest - now);
        return;
      }

      const job = queue.splice(chosen, 1)[0];
      job.unsubscribeAbort?.();
      job.unsubscribeAbort = null;
      const state = stateFor(job.provider);
      active++;
      state.active++;
      Promise.resolve()
        .then(() => {
          throwIfAborted(job.signal);
          return job.task();
        })
        .then(
          (value) => settleJob(job, job.resolve, value),
          (err) => settleJob(job, job.reject, err)
        )
        .finally(() => {
          active--;
          state.active--;
          if (!job.signal?.aborted) {
            state.nextAt = Math.max(state.nextAt, Date.now() + delayFor(job.provider));
          }
          pump();
        });
    }
  }

  function run(provider, task, signal) {
    const key = provider || "unknown";
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(clientAbortError());
        return;
      }
      const job = { provider: key, task, resolve, reject, signal, settled: false, unsubscribeAbort: null };
      queue.push(job);
      if (signal?.onAbort) {
        job.unsubscribeAbort = signal.onAbort(() => {
          if (removeQueuedJob(job)) pump();
        });
      }
      stateFor(key);
      pump();
    });
  }

  function penalize(provider, delayMs, reason) {
    if (!provider || !delayMs) return;
    const state = stateFor(provider);
    state.nextAt = Math.max(state.nextAt, Date.now() + delayMs);
    state.backoffReason = reason || "backoff";
    pump();
  }

  function snapshot() {
    const queuedByProvider = {};
    for (const job of queue) queuedByProvider[job.provider] = (queuedByProvider[job.provider] || 0) + 1;
    const providerRows = {};
    for (const [provider, state] of providers) {
      const queued = queuedByProvider[provider] || 0;
      if (!state.active && !queued && state.nextAt <= Date.now()) continue;
      providerRows[provider] = {
        active: state.active,
        queued,
        throttled: isThrottled(provider),
        nextInMs: Math.max(0, state.nextAt - Date.now()),
        backoffReason: state.backoffReason,
      };
    }
    return { name, active, queued: queue.length, concurrency: maxConcurrent, providers: providerRows };
  }

  return { run, penalize, snapshot };
}

function hash(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 32);
}

function cacheKey(url, viewport) {
  return hash(`${url}|${viewport}`);
}

function screenshotFile(url, viewport) {
  return path.join(CACHE_DIR, `${cacheKey(url, viewport)}.jpg`);
}

function screenshotOptions(outFile) {
  return {
    path: outFile,
    type: "jpeg",
    quality: SCREENSHOT_JPEG_QUALITY,
  };
}

function isFresh(file) {
  try {
    const stat = fs.statSync(file);
    return Date.now() - stat.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

function normaliseUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http/https URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded usernames or passwords are not supported.");
  }
  return url.href;
}

const targetSafetyCache = new Map();

function cleanHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function ipv4Parts(address) {
  const parts = String(address || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function isPrivateIPv4(address) {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function isPrivateIPv6(address) {
  const value = cleanHostname(address);
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return true;
  if (value.startsWith("ff")) return true;
  if (value.startsWith("2001:db8")) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isBlockedAddress(address) {
  const host = cleanHostname(address);
  const version = net.isIP(host);
  if (version === 4) return isPrivateIPv4(host);
  if (version === 6) return isPrivateIPv6(host);
  return false;
}

function isLocalHostname(hostname) {
  const host = cleanHostname(hostname);
  return !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

function targetBlockedError(hostname) {
  const err = new Error(
    `Private or local network targets are blocked by default (${hostname}). ` +
    "Set ALLOW_PRIVATE_TARGETS=1 only if you intentionally need intranet/local URLs."
  );
  err.code = "TARGET_BLOCKED";
  err.statusCode = 400;
  err.targetBlocked = true;
  return err;
}

function isTargetBlockedError(err) {
  return Boolean(err?.targetBlocked || err?.code === "TARGET_BLOCKED");
}

async function assertSafeTargetUrl(rawUrl) {
  if (ALLOW_PRIVATE_TARGETS) return;
  const parsed = new URL(rawUrl);
  const host = cleanHostname(parsed.hostname);
  if (isLocalHostname(host) || isBlockedAddress(host)) throw targetBlockedError(host);

  const cached = targetSafetyCache.get(host);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.blocked) throw targetBlockedError(host);
    return;
  }

  try {
    const records = await dns.promises.lookup(host, { all: true, verbatim: false });
    const blocked = records.some((record) => isBlockedAddress(record.address));
    targetSafetyCache.set(host, { blocked, expiresAt: Date.now() + TARGET_SAFETY_CACHE_MS });
    if (blocked) throw targetBlockedError(host);
  } catch (err) {
    if (isTargetBlockedError(err)) throw err;
    // DNS and network failures are handled by the normal check/capture path.
  }
}

function safeLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err || ALLOW_PRIVATE_TARGETS) {
      callback(err, address, family);
      return;
    }
    const records = Array.isArray(address) ? address : [{ address, family }];
    const blocked = records.some((record) => isBlockedAddress(record.address));
    if (blocked) {
      callback(targetBlockedError(cleanHostname(hostname)));
      return;
    }
    callback(null, address, family);
  });
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      acceptInsecureCerts: true,
      ignoreHTTPSErrors: true,
      userDataDir: BROWSER_PROFILE_DIR,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--hide-scrollbars",
      ],
    }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

// Track consecutive newPage timeouts so we can recycle a stuck browser. A single
// timeout can happen for benign reasons (system busy), but a run of three almost
// always means the puppeteer browser is wedged and won't recover on its own.
const NEW_PAGE_TIMEOUT_MS = 20_000;
let consecutiveNewPageFailures = 0;

async function openPage(browser, timeoutMessage = "Opening browser page timed out.") {
  const pagePromise = browser.newPage();
  try {
    const page = await withTimeout(pagePromise, NEW_PAGE_TIMEOUT_MS, timeoutMessage);
    consecutiveNewPageFailures = 0;
    return page;
  } catch (err) {
    // The newPage() promise is still in flight even though withTimeout rejected.
    // Close the page when (if) it finally resolves so it doesn't leak a tab.
    pagePromise.then(p => p?.close?.().catch(() => {}), () => {});
    consecutiveNewPageFailures++;
    if (consecutiveNewPageFailures >= 3) {
      consecutiveNewPageFailures = 0;
      const stuck = browserPromise;
      browserPromise = null;
      if (stuck) stuck.then(b => b?.close?.().catch(() => {}), () => {});
    }
    throw err;
  }
}

async function httpRequest(url, method = "GET", maxBytes = METADATA_BYTES, redirectChain = [], signal = null) {
  await assertSafeTargetUrl(url);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(clientAbortError());
      return;
    }
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const started = Date.now();
    let unsubscribeAbort = null;
    let finished = false;
    const finishReject = (err) => {
      if (finished) return;
      finished = true;
      unsubscribeAbort?.();
      reject(err);
    };
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      lookup: safeLookup,
      headers: {
        "User-Agent": USER_AGENTS.desktop,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: CHECK_TIMEOUT_MS,
    }, (res) => {
      const status = res.statusCode;
      const elapsed = Date.now() - started;

      if (status >= 300 && status < 400 && res.headers.location && redirectChain.length < 8) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url);
        if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
          finishReject(Object.assign(new Error("unsupported_redirect_protocol"), {
            responseMs: elapsed,
            redirects: redirectChain,
          }));
          return;
        }
        const next = nextUrl.href;
        redirectChain.push({ url, status });
        httpRequest(next, method, maxBytes, redirectChain, signal)
          .then((result) => {
            if (finished) return;
            finished = true;
            unsubscribeAbort?.();
            resolve(result);
          })
          .catch(finishReject);
        return;
      }

      const chunks = [];
      let total = 0;
      let truncated = false;
      res.on("data", (chunk) => {
        if (total >= maxBytes) {
          truncated = true;
          req.destroy();
          return;
        }
        const slice = total + chunk.length > maxBytes ? chunk.slice(0, maxBytes - total) : chunk;
        chunks.push(slice);
        total += slice.length;
      });
      res.on("end", () => finish());
      res.on("close", () => finish());
      function finish() {
        if (finished) return;
        finished = true;
        unsubscribeAbort?.();
        resolve({
          url: redirectChain[0]?.url || url,
          finalUrl: url,
          status,
          statusText: res.statusMessage || "",
          redirects: redirectChain,
          responseMs: elapsed,
          contentType: res.headers["content-type"] || "",
          server: res.headers["server"] || "",
          retryAfter: res.headers["retry-after"] || "",
          contentLength: Number(res.headers["content-length"]) || total,
          body: Buffer.concat(chunks),
          truncated,
        });
      }
    });

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => {
      finishReject(Object.assign(err, {
        phase: "request",
        responseMs: Date.now() - started,
        redirects: redirectChain,
        originalUrl: redirectChain[0]?.url || url,
      }));
    });
    if (signal?.onAbort) {
      unsubscribeAbort = signal.onAbort(() => req.destroy(clientAbortError()));
    }
    req.end();
  });
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}

function backoffForStatus(status, retryAfter) {
  const retryMs = parseRetryAfter(retryAfter);
  if (status === 429 || status === 999) return Math.min(Math.max(retryMs || 60_000, 10_000), 5 * 60_000);
  if (status === 403) return Math.min(Math.max(retryMs || 10_000, 5_000), 60_000);
  return 0;
}

function applyBackoff(limiter, provider, status, retryAfter) {
  const delay = backoffForStatus(Number(status), retryAfter);
  if (delay) limiter.penalize(provider, delay, `HTTP ${status}`);
}

function decodeCodePoint(value, radix = 10) {
  const n = Number.parseInt(value, radix);
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => decodeCodePoint(n, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => decodeCodePoint(n, 16));
}

function extractMetadata(html) {
  if (!html) return {};
  const out = { title: "", description: "", ogSiteName: "", h1: "" };

  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i);
  if (titleMatch) out.title = decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim());

  const metaTags = html.matchAll(/<meta\s+([^>]+?)\/?>/gi);
  for (const m of metaTags) {
    const attrs = {};
    const re = /([a-z-:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let a;
    while ((a = re.exec(m[1])) !== null) {
      attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    }
    const name = (attrs.name || attrs.property || "").toLowerCase();
    const content = attrs.content || "";
    if (!out.description && (name === "description" || name === "og:description")) out.description = content;
    if (!out.ogSiteName && name === "og:site_name") out.ogSiteName = content;
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]{0,400}?)<\/h1>/i);
  if (h1Match) out.h1 = decodeEntities(h1Match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());

  return out;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeDomain(hostname) {
  const withoutTld = hostname
    .replace(/^www\./, "")
    .replace(/\.[a-z]{2,}(\.[a-z]{2,})?$/i, "");
  return withoutTld
    .split(/[-._]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 3 && !STOP_TOKENS.has(t));
}

// Categorize Node/OpenSSL error codes into buckets the client uses for bulk
// auto-reject (dead domains) vs retry-worthy.
function classifyErrorKind(code) {
  if (!code) return "unknown";
  const c = String(code).toUpperCase();
  if (c === "ENOTFOUND") return "dns";
  if (c === "EAI_AGAIN") return "network";
  if (c === "ECONNREFUSED") return "refused";
  if (c === "ECONNRESET" || c === "EPIPE") return "reset";
  if (c.includes("TIMEOUT") || c === "ETIMEDOUT") return "timeout";
  if (c.includes("CERT") || c.includes("SELF_SIGNED") || c.includes("UNABLE_TO_VERIFY") || c.includes("SSL") || c.includes("TLS")) return "tls";
  if (c.includes("HOSTNAME") || c.includes("ALTNAME")) return "tls";
  return "network";
}

// Classifier output is narrowed to confident-bad verdicts only. A neutral/clean
// URL returns verdict: null — the card shows no pill and the user decides manually.
// HTTP failures (status 0, 4xx, 5xx) are handled by the status badge, not a verdict.
function signalParkerHost(lower, evidence) {
  for (const host of PARKER_HOSTS) {
    if (lower.includes(host)) {
      evidence.push(`parker: ${host}`);
      return 2;
    }
  }
  return 0;
}

function signalForSale(textLower, evidence) {
  for (const phrase of FOR_SALE_PHRASES) {
    if (textLower.includes(phrase)) {
      evidence.push(`for-sale phrase: "${phrase}"`);
      return 1;
    }
  }
  return 0;
}

function signalParkingPhrase(textLower, evidence) {
  for (const phrase of PARKING_PHRASES) {
    if (textLower.includes(phrase)) {
      evidence.push(`parking phrase: "${phrase}"`);
      return 1;
    }
  }
  return 0;
}

function signalTitleIsDomain(title, hostname, evidence) {
  if (!title) return 0;
  if (title === hostname.toLowerCase()) {
    evidence.push("title equals domain");
    return 1;
  }
  const bare = tokenizeDomain(hostname).join("");
  if (bare && title.replace(/\s+/g, "") === bare) {
    evidence.push("title equals domain base");
    return 1;
  }
  return 0;
}

function signalDomainMismatch(hostname, title, meta, textLower, evidence) {
  const tokens = tokenizeDomain(hostname);
  if (!tokens.length) return 0;
  const description = (meta?.description || "").toLowerCase();
  const ogSite = (meta?.ogSiteName || "").toLowerCase();
  const h1 = (meta?.h1 || "").toLowerCase();
  const corpus = `${title} ${description} ${ogSite} ${h1} ${textLower.slice(0, 4000)}`;
  const hits = tokens.filter(t => corpus.includes(t));
  if (hits.length === 0) {
    if (tokens.length >= 2) {
      evidence.push(`no domain tokens in content (${tokens.join(", ")})`);
      return 2;
    }
    evidence.push(`domain name "${tokens[0]}" not in content`);
    return 1;
  }
  if (tokens.length >= 2 && hits.length < tokens.length / 2) {
    evidence.push(`weak domain token match (${hits.length}/${tokens.length})`);
    return 1;
  }
  return 0;
}

function signalMarketplaceRedirect(requestHost, checkResult, evidence) {
  if (!checkResult?.finalUrl) return 0;
  let finalHost = "";
  try { finalHost = new URL(checkResult.finalUrl).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return 0; }
  if (!finalHost || finalHost === requestHost) return 0;
  for (const h of MARKETPLACE_HOSTS) {
    if (finalHost === h || finalHost.endsWith(`.${h}`)) {
      evidence.push(`redirects to marketplace: ${finalHost}`);
      return 2;
    }
  }
  return 0;
}

function signalParkerRedirect(requestHost, checkResult, evidence) {
  let finalHost = "";
  try { finalHost = new URL(checkResult?.finalUrl || "").hostname.toLowerCase(); }
  catch { return 0; }
  if (!finalHost) return 0;
  for (const h of PARKER_HOSTS) {
    const base = h.split("/")[0];
    if (finalHost === base || finalHost.endsWith(`.${base}`)) {
      evidence.push(`redirect to parker: ${finalHost}`);
      return 2;
    }
  }
  return 0;
}

function signalTemplateSite(lower, textLower, evidence) {
  let score = 0;
  const genMatch = lower.match(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)["']/i)
    || lower.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']generator["']/i);
  if (genMatch) {
    const gen = genMatch[1].toLowerCase();
    for (const needle of TEMPLATE_GENERATORS) {
      if (gen.includes(needle)) {
        evidence.push(`generator: ${needle}`);
        score += 1;
        break;
      }
    }
  }
  for (const phrase of TEMPLATE_PHRASES) {
    if (textLower.includes(phrase)) {
      evidence.push(`template default text: "${phrase}"`);
      score += 2;
      return score;
    }
  }
  return score;
}

function classify(html, url, meta, checkResult) {
  // Only output a verdict when we're confident the URL is bad.
  // null = neutral, user reviews manually.
  if (!html) {
    return { verdict: null, evidence: [], confidence: 0, score: { parking: 0, forSale: 0, mismatch: 0, template: 0 } };
  }

  const evidence = [];
  const lower = html.toLowerCase();
  const text = stripHtml(html);
  const textLower = text.toLowerCase();
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^www\./, "");
  const title = (meta?.title || "").trim().toLowerCase();

  let parking = 0, forSale = 0, mismatch = 0, template = 0;

  parking += signalParkerHost(lower, evidence);
  forSale += signalForSale(textLower, evidence);
  parking += signalParkingPhrase(textLower, evidence);
  parking += signalTitleIsDomain(title, hostname, evidence);
  mismatch += signalDomainMismatch(hostname, title, meta, textLower, evidence);
  mismatch += signalMarketplaceRedirect(hostname, checkResult, evidence);
  parking += signalParkerRedirect(hostname, checkResult, evidence);
  template += signalTemplateSite(lower, textLower, evidence);

  // Verdict decision — tight, no noisy fallbacks.
  let verdict = null;
  if (forSale >= 1) verdict = "for_sale";
  else if (parking >= 2) verdict = "parked";
  else if (template >= 2 && (parking >= 1 || mismatch >= 1)) verdict = "template";
  else if (mismatch >= 2) verdict = "mismatch";

  const rawScore = parking * 1.2 + forSale * 2.0 + mismatch * 0.9 + template * 0.8;
  const confidence = verdict ? Math.min(1, rawScore / 4) : 0;

  return { verdict, evidence, confidence, score: { parking, forSale, mismatch, template } };
}

function readMeta(url) {
  return metaStore.get(url) || null;
}

function pruneMetaStore() {
  while (metaStore.size > META_STORE_MAX_ENTRIES) {
    const oldest = metaStore.keys().next().value;
    if (!oldest) return;
    metaStore.delete(oldest);
  }
}

function writeMeta(url, data) {
  const current = readMeta(url) || {};
  const merged = { ...current, ...data, updatedAt: Date.now() };
  metaStore.delete(url);
  metaStore.set(url, merged);
  pruneMetaStore();
  return merged;
}

function htmlEscape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function shortError(reason) {
  const s = String(reason?.message || reason?.code || reason || "Navigation failed");
  return s.replace(/^net::/i, "").slice(0, 220);
}

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function abortableDelay(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(clientAbortError());
      return;
    }
    let unsubscribeAbort = null;
    const timer = setTimeout(() => {
      unsubscribeAbort?.();
      resolve();
    }, ms);
    if (signal?.onAbort) {
      unsubscribeAbort = signal.onAbort(() => {
        clearTimeout(timer);
        reject(clientAbortError());
      });
    }
  });
}

function diagnosticScreenshotHtml(url, viewport, reason) {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "");
  const view = VIEWPORTS[viewport] || VIEWPORTS.desktop;
  const error = shortError(reason);
  const checkedAt = new Date().toLocaleString("en-US", { hour12: true });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      width: ${view.width}px;
      min-height: ${view.height}px;
      display: grid;
      place-items: center;
      background: #0b0f14;
      color: #e8eef7;
      font: 18px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(860px, calc(100vw - 96px));
      border: 1px solid #334157;
      border-radius: 10px;
      background: #121821;
      box-shadow: 0 18px 60px rgba(0, 0, 0, .38);
      overflow: hidden;
    }
    header {
      padding: 24px 28px;
      border-bottom: 1px solid #263244;
      background: #171f2b;
    }
    .eyebrow {
      color: #ffbf47;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    h1 {
      margin: 8px 0 0;
      font-size: 34px;
      line-height: 1.12;
      font-weight: 800;
    }
    section {
      display: grid;
      gap: 14px;
      padding: 24px 28px 28px;
    }
    dl {
      display: grid;
      grid-template-columns: 130px 1fr;
      gap: 10px 18px;
      margin: 0;
    }
    dt { color: #8fa0b8; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 15px;
    }
    .note {
      color: #8fa0b8;
      font-size: 15px;
      border-top: 1px solid #263244;
      padding-top: 16px;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Diagnostic Capture</div>
      <h1>${htmlEscape(host)}</h1>
    </header>
    <section>
      <dl>
        <dt>URL</dt><dd class="code">${htmlEscape(url)}</dd>
        <dt>Result</dt><dd>${htmlEscape(error)}</dd>
        <dt>Checked</dt><dd>${htmlEscape(checkedAt)}</dd>
      </dl>
      <div class="note">The site did not render normally in the local browser, so Website Viewer captured this diagnostic image instead of showing a broken thumbnail.</div>
    </section>
  </main>
</body>
</html>`;
}

async function pageLooksBlank(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").trim();
    const childCount = document.body?.children?.length || 0;
    const title = (document.title || "").trim();
    return location.href === "about:blank" || (!text && !childCount && !title);
  }).catch(() => true);
}

function pageIsChromeError(page) {
  return String(page?.url?.() || "").startsWith("chrome-error://");
}

function browserVisualReadiness() {
  const body = document.body;
  if (!body || location.href === "about:blank") {
    return { ready: false, textLength: 0, mediaCount: 0, pendingMediaCount: 0, paintCount: 0 };
  }

  const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
  const minArea = Math.max(600, viewportWidth * viewportHeight * 0.002);
  const textLength = (body.innerText || "").replace(/\s+/g, " ").trim().length;
  const paintCount = performance.getEntriesByType?.("paint")?.filter((entry) => (
    entry.name === "first-contentful-paint"
  )).length || 0;
  let mediaCount = 0;
  let pendingMediaCount = 0;

  const visibleArea = (el) => {
    const rect = el.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
    return width * height;
  };

  for (const el of document.querySelectorAll("img,svg,canvas,video,iframe,picture,[role='img']")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) < 0.05) continue;
    const area = visibleArea(el);
    if (area < minArea) continue;

    if (el.tagName === "IMG") {
      if (el.complete && el.naturalWidth > 0) mediaCount++;
      else pendingMediaCount++;
    } else {
      mediaCount++;
    }
  }

  return {
    ready: textLength >= 30 || mediaCount > 0 || paintCount > 0,
    textLength,
    mediaCount,
    pendingMediaCount,
    paintCount,
  };
}

async function waitForCaptureSettle(page, signal) {
  await abortableDelay(CAPTURE_SETTLE_MS, signal);
  throwIfAborted(signal);

  const readiness = await page.evaluate(browserVisualReadiness).catch(() => ({ ready: true }));
  if (readiness.ready || CAPTURE_SPARSE_EXTRA_WAIT_MS <= 0) return;

  await page.waitForFunction(`(${browserVisualReadiness})().ready`, {
    polling: 100,
    timeout: CAPTURE_SPARSE_EXTRA_WAIT_MS,
  }).catch(() => {});
  throwIfAborted(signal);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })).catch(() => {});
}

async function renderDiagnosticScreenshot(page, url, viewport, reason) {
  await page.setContent(diagnosticScreenshotHtml(url, viewport, reason), {
    waitUntil: "domcontentloaded",
    timeout: 5_000,
  });
}

async function applyPageViewport(page, viewport) {
  const vp = VIEWPORTS[viewport] || VIEWPORTS.desktop;
  await page.setViewport({
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
  });
  await page.setUserAgent(USER_AGENTS[viewport] || USER_AGENTS.desktop);
}

async function blockTrackers(page) {
  try {
    const client = await page.createCDPSession();
    await client.send("Network.enable");
    await client.send("Network.setBlockedURLs", {
      urls: ALLOW_PRIVATE_TARGETS
        ? BLOCKED_URL_PATTERNS
        : BLOCKED_URL_PATTERNS.concat(PRIVATE_NETWORK_BLOCK_PATTERNS),
    });
  } catch {
    // Tracker blocking is a nice-to-have; if the CDP call fails we still capture.
  }
}

async function blockUnsafeDocumentRequests(page) {
  if (ALLOW_PRIVATE_TARGETS) return;
  try {
    const client = await page.createCDPSession();
    await client.send("Fetch.enable", {
      patterns: [{ requestStage: "Request", resourceType: "Document" }],
    });
    client.on("Fetch.requestPaused", (event) => {
      (async () => {
        try {
          await assertSafeTargetUrl(event.request.url);
          await client.send("Fetch.continueRequest", { requestId: event.requestId });
        } catch {
          await client.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient",
          }).catch(() => {});
        }
      })().catch(() => {});
    });
  } catch {
    // Main URL validation still runs before capture; this guard catches redirects
    // and iframe navigations when CDP Fetch is available.
  }
}

function createRequestAbortSignal(req, res) {
  const abortCallbacks = new Set();
  const signal = {
    aborted: false,
    closePage: null,
    onAbort(fn) {
      if (signal.aborted) {
        fn();
        return () => {};
      }
      abortCallbacks.add(fn);
      return () => abortCallbacks.delete(fn);
    },
  };
  req.on("close", () => {
    if (res.writableEnded) return;
    if (signal.aborted) return;
    signal.aborted = true;
    signal.closePage?.();
    for (const fn of abortCallbacks) fn();
    abortCallbacks.clear();
  });
  return signal;
}

function clientAbortError() {
  const err = new Error("client_aborted");
  err.clientAborted = true;
  return err;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const err = clientAbortError();
  throw err;
}

async function closePageFast(page) {
  if (!page) return;
  await withTimeout(page.close(), 2_000, "Page close timed out.").catch(() => {});
}

async function writeDiagnosticCapture(url, viewport, outFile, reason, signal) {
  const browser = await getBrowser();
  const page = await openPage(browser, "Opening diagnostic page timed out.");
  if (signal) signal.closePage = () => closePageFast(page);
  try {
    throwIfAborted(signal);
    await applyPageViewport(page, viewport);
    throwIfAborted(signal);
    await renderDiagnosticScreenshot(page, url, viewport, reason);
    throwIfAborted(signal);
    await withTimeout(page.screenshot(screenshotOptions(outFile)), SCREENSHOT_STEP_TIMEOUT_MS, "Diagnostic screenshot timed out.");
    return {
      status: 0,
      statusText: "Diagnostic capture",
      responseMs: 0,
      contentType: "text/html",
      meta: {
        title: providerKeyForUrl(url),
        finalUrl: url,
      },
      retryAfter: "",
      finalUrl: url,
      diagnostic: true,
      error: shortError(reason),
    };
  } finally {
    if (signal?.closePage) signal.closePage = null;
    await closePageFast(page);
  }
}

async function capture(url, viewport, outFile, signal) {
  await assertSafeTargetUrl(url);
  const browser = await getBrowser();
  let page = await openPage(browser, "Opening browser page timed out.");
  if (signal) signal.closePage = () => closePageFast(page);
  let response = null;
  const started = Date.now();
  let navigationError = null;
  let diagnostic = false;
  const watchdog = setTimeout(() => {
    closePageFast(page);
  }, CAPTURE_TIMEOUT_MS);
  try {
    throwIfAborted(signal);
    await applyPageViewport(page, viewport);
    await blockUnsafeDocumentRequests(page);
    await blockTrackers(page);
    page.setDefaultNavigationTimeout(CAPTURE_NAV_TIMEOUT_MS);
    throwIfAborted(signal);
    // Don't fail the whole capture if navigation hits a timeout — often the page
    // is interactive enough to screenshot even if some subresources are still loading.
    response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: CAPTURE_NAV_TIMEOUT_MS,
    }).catch((err) => {
      navigationError = err;
      return null;
    });
    throwIfAborted(signal);
    if (CAPTURE_IDLE_TIMEOUT_MS > 0) {
      await page.waitForNetworkIdle({
        idleTime: CAPTURE_IDLE_MS,
        timeout: CAPTURE_IDLE_TIMEOUT_MS,
      }).catch(() => {});
    }
    throwIfAborted(signal);
    await waitForCaptureSettle(page, signal);
    throwIfAborted(signal);

    if (navigationError && (pageIsChromeError(page) || await pageLooksBlank(page))) {
      diagnostic = true;
      await renderDiagnosticScreenshot(page, url, viewport, navigationError);
    }
    throwIfAborted(signal);

    const meta = await page.evaluate(() => {
      const sel = (s) => document.querySelector(s);
      const metaContent = (name) => sel(`meta[name="${name}"]`)?.content || sel(`meta[property="${name}"]`)?.content || "";
      return {
        title: (document.title || "").trim(),
        description: metaContent("description") || metaContent("og:description"),
        finalUrl: location.href,
      };
    }).catch(() => ({}));

    const shotOptions = screenshotOptions(outFile);

    try {
      throwIfAborted(signal);
      await withTimeout(page.screenshot(shotOptions), SCREENSHOT_STEP_TIMEOUT_MS, "Screenshot timed out.");
    } catch (err) {
      throwIfAborted(signal);
      diagnostic = true;
      await closePageFast(page);
      page = await openPage(browser, "Opening diagnostic page timed out.");
      if (signal) signal.closePage = () => closePageFast(page);
      await applyPageViewport(page, viewport);
      await renderDiagnosticScreenshot(page, url, viewport, err);
      throwIfAborted(signal);
      await withTimeout(page.screenshot(shotOptions), SCREENSHOT_STEP_TIMEOUT_MS, "Diagnostic screenshot timed out.");
    }
    throwIfAborted(signal);

    return {
      status: response?.status() || 0,
      statusText: response?.statusText?.() || "",
      responseMs: Date.now() - started,
      contentType: response?.headers?.()?.["content-type"] || "",
      meta,
      retryAfter: response?.headers()?.["retry-after"] || "",
      finalUrl: meta?.finalUrl || page.url(),
      diagnostic,
      error: navigationError ? shortError(navigationError) : "",
    };
  } finally {
    clearTimeout(watchdog);
    if (signal?.closePage) signal.closePage = null;
    await closePageFast(page);
  }
}

app.get("/api/check", async (req, res) => {
  let url;
  try {
    url = normaliseUrl(String(req.query.url || ""));
    await assertSafeTargetUrl(url);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  const provider = providerKeyForUrl(url);
  const abortSignal = createRequestAbortSignal(req, res);
  try {
    const result = await checkLimiter.run(provider, () => httpRequest(url, "GET", METADATA_BYTES, [], abortSignal), abortSignal);
    if (abortSignal.aborted) return;
    applyBackoff(checkLimiter, provider, result.status, result.retryAfter);
    const contentType = result.contentType.toLowerCase();
    let metadata = null;
    let verdict = null;
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml") || (!contentType && result.body?.length);
    if (isHtml) {
      const html = result.body.toString("utf8");
      metadata = extractMetadata(html);
      verdict = classify(html, url, metadata, { status: result.status, finalUrl: result.finalUrl });
      writeMeta(url, {
        ...metadata,
        status: result.status,
        finalUrl: result.finalUrl,
        responseMs: result.responseMs,
        contentType: result.contentType,
        server: result.server,
        verdict: verdict.verdict,
        verdictConfidence: verdict.confidence,
        verdictEvidence: verdict.evidence,
        verdictScore: verdict.score,
      });
    } else {
      verdict = { verdict: null, evidence: [], confidence: 0, score: {} };
      writeMeta(url, {
        status: result.status,
        finalUrl: result.finalUrl,
        responseMs: result.responseMs,
        contentType: result.contentType,
        server: result.server,
        verdict: null,
        verdictConfidence: 0,
        verdictEvidence: [],
      });
    }
    return res.json({
      ok: true,
      url,
      finalUrl: result.finalUrl,
      status: result.status,
      statusText: result.statusText,
      redirects: result.redirects,
      responseMs: result.responseMs,
      contentType: result.contentType,
      server: result.server,
      provider,
      contentLength: result.contentLength,
      metadata,
      verdict: verdict.verdict,
      verdictConfidence: verdict.confidence,
      verdictEvidence: verdict.evidence,
      verdictScore: verdict.score,
    });
  } catch (err) {
    if (abortSignal.aborted || err.clientAborted) return;
    if (isTargetBlockedError(err)) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }
    const errCode = err.code || err.message || "network_error";
    const errorKind = classifyErrorKind(errCode);
    writeMeta(url, {
      status: 0,
      error: errCode,
      errorKind,
      responseMs: err.responseMs || 0,
      verdict: null,
      verdictConfidence: 0,
      verdictEvidence: [],
    });
    return res.json({
      ok: false,
      url,
      status: 0,
      error: errCode,
      errorKind,
      redirects: err.redirects || [],
      responseMs: err.responseMs || 0,
      provider,
      verdict: null,
      verdictConfidence: 0,
      verdictEvidence: [],
    });
  }
});

app.get("/api/screenshot", async (req, res) => {
  let url;
  try {
    url = normaliseUrl(String(req.query.url || ""));
    await assertSafeTargetUrl(url);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  const viewport = VIEWPORTS[req.query.viewport] ? String(req.query.viewport) : "desktop";
  const file = screenshotFile(url, viewport);
  const provider = providerKeyForUrl(url);
  const abortSignal = createRequestAbortSignal(req, res);
  const forceRefresh = queryFlag(req.query.refresh) || queryFlag(req.query.retry);

  if (forceRefresh || !isFresh(file)) {
    try {
      const result = await screenshotLimiter.run(provider, () => {
        throwIfAborted(abortSignal);
        return capture(url, viewport, file, abortSignal);
      }, abortSignal);
      if (abortSignal.aborted) return;
      applyBackoff(screenshotLimiter, provider, result.status, result.retryAfter);
      if (result?.meta) {
        writeMeta(url, {
          title: result.meta.title || undefined,
          description: result.meta.description || undefined,
          finalUrl: result.meta.finalUrl || result.finalUrl || undefined,
          status: result.status || undefined,
          statusText: result.statusText || undefined,
          responseMs: result.responseMs || undefined,
          contentType: result.contentType || undefined,
          screenshotOk: true,
          screenshotDiagnostic: result.diagnostic || undefined,
          screenshotError: result.error || undefined,
        });
      }
    } catch (err) {
      if (abortSignal.aborted || err.clientAborted) return;
      if (isTargetBlockedError(err)) {
        return res.status(err.statusCode || 400).json({ error: err.message });
      }
      try {
        const result = await screenshotLimiter.run(provider, () => {
          throwIfAborted(abortSignal);
          return writeDiagnosticCapture(url, viewport, file, err, abortSignal);
        }, abortSignal);
        if (abortSignal.aborted) return;
        writeMeta(url, {
          title: result.meta.title || undefined,
          finalUrl: result.finalUrl || undefined,
          status: result.status,
          statusText: result.statusText,
          responseMs: result.responseMs,
          contentType: result.contentType,
          screenshotOk: true,
          screenshotDiagnostic: true,
          screenshotError: result.error,
        });
      } catch (diagErr) {
        if (abortSignal.aborted || diagErr.clientAborted) return;
        return res.status(502).json({ error: diagErr.message || err.message || "Screenshot failed." });
      }
    }
  } else {
    const cachedMeta = readMeta(url) || {};
    if (!cachedMeta.screenshotDiagnostic && (!cachedMeta.screenshotOk || !cachedMeta.status || Number(cachedMeta.status) === 0)) {
      writeMeta(url, {
        status: 200,
        statusText: "Browser capture OK",
        screenshotOk: true,
      });
    }
  }

  if (abortSignal.aborted) return;
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(file);
});

app.get("/api/metadata", (req, res) => {
  let url;
  try {
    url = normaliseUrl(String(req.query.url || ""));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const meta = readMeta(url);
  res.json(meta || {});
});

app.get("/api/screenshot/status", (_req, res) => {
  const shots = screenshotLimiter.snapshot();
  res.json({
    active: shots.active,
    queued: shots.queued,
    concurrency: shots.concurrency,
    providers: shots.providers,
    checks: checkLimiter.snapshot(),
  });
});

app.post("/api/session/start", (req, res) => {
  const id = recordViewerSession(req);
  if (!id) return res.status(400).json({ error: "missing_session_id" });
  res.json({
    ok: true,
    autoShutdown: AUTO_SHUTDOWN,
    graceMs: AUTO_SHUTDOWN_GRACE_MS,
    heartbeatTtlMs: VIEWER_SESSION_TTL_MS,
  });
});

app.post("/api/session/ping", (req, res) => {
  const id = recordViewerSession(req);
  if (!id) return res.status(400).json({ error: "missing_session_id" });
  res.json({ ok: true });
});

app.post("/api/session/end", (req, res) => {
  endViewerSession(req);
  res.status(204).end();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "Website Viewer", version: APP_VERSION });
});

app.use(express.static(PUBLIC_DIR, {
  etag: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  },
}));

const server = app.listen(PORT, HOST, () => {
  const displayHost = HOST === "127.0.0.1" ? "localhost" : HOST;
  console.log(`Website Viewer ${APP_VERSION} running at http://${displayHost}:${PORT}/`);
  if (AUTO_SHUTDOWN) {
    console.log(`The local server will close automatically ${formatDuration(AUTO_SHUTDOWN_GRACE_MS)} after all Website Viewer tabs are closed.`);
  }
});
startAutoShutdownWatcher();

async function shutdown(reason = "") {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.log(reason);
  if (autoShutdownTimer) {
    clearInterval(autoShutdownTimer);
    autoShutdownTimer = null;
  }
  server.close();
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser) await withTimeout(browser.close(), 5_000, "Browser close timed out.").catch(() => {});
  }
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
