const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const express = require("express");
const puppeteer = require("puppeteer");

const PORT = Number(process.env.PORT || 4174);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, ".wv2-data");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const META_DIR = path.join(DATA_DIR, "meta");
const FAVICON_DIR = path.join(DATA_DIR, "favicons");
const PROJECT_DIR = path.join(DATA_DIR, "projects");
const PUBLIC_DIR = path.join(ROOT, "public");

const MAX_CONCURRENT_SHOTS = Number(process.env.SCREENSHOT_CONCURRENCY || 8);
const CACHE_TTL_MS = Number(process.env.SCREENSHOT_CACHE_TTL_HOURS || 168) * 3600 * 1000;
const CHECK_TIMEOUT_MS = 12_000;
const METADATA_BYTES = 512 * 1024;

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

const STOP_TOKENS = new Set([
  "com", "net", "org", "io", "co", "us", "biz", "info", "dev", "app",
  "site", "web", "online", "global", "world", "inc", "llc", "ltd", "corp",
  "group", "company", "the", "and", "for", "of", "www", "html", "cloud",
  "digital", "studio", "agency", "services", "shop", "store",
]);

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, ua: "desktop" },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 1, isMobile: true, hasTouch: true, ua: "tablet" },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ua: "mobile" },
};

const USER_AGENTS = {
  desktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 WebsiteViewer/2.0",
  tablet: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 WebsiteViewer/2.0",
  mobile: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 WebsiteViewer/2.0",
};

for (const dir of [DATA_DIR, CACHE_DIR, META_DIR, FAVICON_DIR, PROJECT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.use(express.json({ limit: "16mb" }));

let browserPromise = null;
let active = 0;
const queue = [];

function hash(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 32);
}

function cacheKey(url, viewport, fullPage) {
  return hash(`${url}|${viewport}|${fullPage ? "full" : "view"}`);
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
  return url.href;
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
      ],
    });
  }
  return browserPromise;
}

function runLimited(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENT_SHOTS && queue.length) {
    const job = queue.shift();
    active++;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

function httpRequest(url, method = "GET", maxBytes = METADATA_BYTES, redirectChain = []) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const started = Date.now();
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
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
        const next = new URL(res.headers.location, url).href;
        redirectChain.push({ url, status });
        httpRequest(next, method, maxBytes, redirectChain)
          .then(resolve)
          .catch(reject);
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
        resolve({
          url: redirectChain[0]?.url || url,
          finalUrl: url,
          status,
          statusText: res.statusMessage || "",
          redirects: redirectChain,
          responseMs: elapsed,
          contentType: res.headers["content-type"] || "",
          server: res.headers["server"] || "",
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
      reject(Object.assign(err, {
        phase: "request",
        responseMs: Date.now() - started,
        redirects: redirectChain,
        originalUrl: redirectChain[0]?.url || url,
      }));
    });
    req.end();
  });
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function extractMetadata(html, baseUrl) {
  if (!html) return {};
  const out = { title: "", description: "", faviconUrl: "", ogImage: "", canonical: "", lang: "", ogSiteName: "", h1: "" };

  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) {
    const lang = htmlTag[0].match(/\blang=["']?([^"'\s>]+)/i);
    if (lang) out.lang = lang[1];
  }

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
    if (!out.ogImage && (name === "og:image" || name === "twitter:image")) {
      try { out.ogImage = new URL(content, baseUrl).href; } catch {}
    }
    if (!out.ogSiteName && name === "og:site_name") out.ogSiteName = content;
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]{0,400}?)<\/h1>/i);
  if (h1Match) out.h1 = decodeEntities(h1Match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());

  const linkTags = html.matchAll(/<link\s+([^>]+?)\/?>/gi);
  let shortcutIcon = "";
  let standardIcon = "";
  let appleIcon = "";
  for (const l of linkTags) {
    const attrs = {};
    const re = /([a-z-:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let a;
    while ((a = re.exec(l[1])) !== null) {
      attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    }
    const rel = (attrs.rel || "").toLowerCase();
    const href = attrs.href || "";
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl).href;
      if (rel === "canonical" && !out.canonical) out.canonical = abs;
      if (rel.includes("icon")) {
        if (rel.includes("shortcut")) shortcutIcon = shortcutIcon || abs;
        else if (rel.includes("apple")) appleIcon = appleIcon || abs;
        else standardIcon = standardIcon || abs;
      }
    } catch {}
  }
  out.faviconUrl = standardIcon || shortcutIcon || appleIcon || new URL("/favicon.ico", baseUrl).href;

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
  if (c === "ENOTFOUND" || c === "EAI_AGAIN") return "dns";
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

function metaFile(url) {
  return path.join(META_DIR, `${hash(url)}.json`);
}

function readMeta(url) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(url), "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(url, data) {
  const current = readMeta(url) || {};
  const merged = { ...current, ...data, updatedAt: Date.now() };
  fs.writeFileSync(metaFile(url), JSON.stringify(merged, null, 2));
  return merged;
}

async function capture(url, viewport, fullPage, outFile) {
  const vp = VIEWPORTS[viewport] || VIEWPORTS.desktop;
  const browser = await getBrowser();
  const page = await browser.newPage();
  let response = null;
  try {
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
    });
    await page.setUserAgent(USER_AGENTS[viewport] || USER_AGENTS.desktop);
    page.setDefaultNavigationTimeout(20_000);
    // Don't fail the whole capture if navigation hits a timeout — often the page
    // is interactive enough to screenshot even if some subresources are still loading.
    response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    }).catch(() => null);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 3_500 }).catch(() => {});

    const meta = await page.evaluate(() => {
      const sel = (s) => document.querySelector(s);
      const metaContent = (name) => sel(`meta[name="${name}"]`)?.content || sel(`meta[property="${name}"]`)?.content || "";
      const links = [...document.querySelectorAll("link[rel]")];
      const icon = links.find((l) => /icon/i.test(l.rel) && !/apple/i.test(l.rel))?.href
        || links.find((l) => /shortcut/i.test(l.rel))?.href
        || links.find((l) => /apple/i.test(l.rel))?.href
        || new URL("/favicon.ico", location.href).href;
      return {
        title: (document.title || "").trim(),
        description: metaContent("description") || metaContent("og:description"),
        ogImage: metaContent("og:image") || metaContent("twitter:image"),
        canonical: sel("link[rel='canonical']")?.href || "",
        lang: document.documentElement.lang || "",
        faviconUrl: icon,
        finalUrl: location.href,
      };
    }).catch(() => ({}));

    await page.screenshot({
      path: outFile,
      type: "png",
      fullPage: !!fullPage,
      captureBeyondViewport: !!fullPage,
    });

    return {
      status: response?.status() || 0,
      meta,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

app.get("/api/check", async (req, res) => {
  let url;
  try {
    url = normaliseUrl(String(req.query.url || ""));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const result = await httpRequest(url, "GET");
    const contentType = result.contentType.toLowerCase();
    let metadata = null;
    let verdict = null;
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml") || (!contentType && result.body?.length);
    if (isHtml) {
      const html = result.body.toString("utf8");
      metadata = extractMetadata(html, result.finalUrl);
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
      contentLength: result.contentLength,
      metadata,
      verdict: verdict.verdict,
      verdictConfidence: verdict.confidence,
      verdictEvidence: verdict.evidence,
      verdictScore: verdict.score,
    });
  } catch (err) {
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
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const viewport = VIEWPORTS[req.query.viewport] ? String(req.query.viewport) : "desktop";
  const fullPage = String(req.query.fullPage || "0") === "1";
  const file = path.join(CACHE_DIR, `${cacheKey(url, viewport, fullPage)}.png`);

  if (!isFresh(file)) {
    // If the most recent /api/check told us this URL is unreachable (DNS miss,
    // connection refused, TLS error — status 0), skip Puppeteer entirely. Spending
    // 20s trying to render a dead domain just stalls the queue for real captures.
    const cachedMeta = readMeta(url);
    const deadKinds = new Set(["dns", "refused", "tls", "timeout"]);
    if (cachedMeta && cachedMeta.status === 0 && deadKinds.has(cachedMeta.errorKind)) {
      return res.status(502).json({ error: `skipped: ${cachedMeta.error}` });
    }
    try {
      const result = await runLimited(() => capture(url, viewport, fullPage, file));
      if (result?.meta) {
        writeMeta(url, {
          title: result.meta.title || undefined,
          description: result.meta.description || undefined,
          faviconUrl: result.meta.faviconUrl || undefined,
          ogImage: result.meta.ogImage || undefined,
          canonical: result.meta.canonical || undefined,
          lang: result.meta.lang || undefined,
          finalUrl: result.meta.finalUrl || undefined,
        });
      }
    } catch (err) {
      return res.status(502).json({ error: err.message || "Screenshot failed." });
    }
  }

  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(file, { dotfiles: "allow" });
});

function sendCachedFile(res, file) {
  res.sendFile(file, { dotfiles: "allow" });
}

app.get("/api/metadata", (req, res) => {
  let url;
  try {
    url = normaliseUrl(String(req.query.url || ""));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const meta = readMeta(url);
  if (!meta) return res.status(404).json({ error: "no metadata cached" });
  res.json(meta);
});

app.get("/api/favicon", async (req, res) => {
  let url;
  try {
    url = normaliseUrl(String(req.query.url || ""));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const meta = readMeta(url);
  const favUrl = meta?.faviconUrl || new URL("/favicon.ico", url).href;
  const file = path.join(FAVICON_DIR, `${hash(favUrl)}.bin`);
  const metaSidecar = `${file}.meta`;

  if (isFresh(file) && fs.existsSync(metaSidecar)) {
    try {
      const ct = fs.readFileSync(metaSidecar, "utf8");
      res.setHeader("Content-Type", ct || "image/x-icon");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return sendCachedFile(res, file);
    } catch {}
  }

  try {
    const result = await httpRequest(favUrl, "GET", 512 * 1024);
    if (result.status >= 200 && result.status < 300 && result.body?.length) {
      fs.writeFileSync(file, result.body);
      fs.writeFileSync(metaSidecar, result.contentType || "image/x-icon");
      res.setHeader("Content-Type", result.contentType || "image/x-icon");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return sendCachedFile(res, file);
    }
  } catch {}

  res.setHeader("Content-Type", "image/svg+xml");
  res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#263244"/><circle cx="8" cy="8" r="3" fill="#8fa0b8"/></svg>');
});

app.get("/api/screenshot/status", (_req, res) => {
  res.json({ active, queued: queue.length, concurrency: MAX_CONCURRENT_SHOTS });
});

function listProjects() {
  const out = [];
  for (const f of fs.readdirSync(PROJECT_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, f), "utf8"));
      out.push({
        id: p.id,
        name: p.name || "Untitled",
        urlCount: Array.isArray(p.urls) ? p.urls.length : 0,
        updatedAt: p.updatedAt || 0,
        createdAt: p.createdAt || 0,
      });
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

app.get("/api/projects", (_req, res) => {
  res.json({ projects: listProjects() });
});

app.get("/api/projects/:id", (req, res) => {
  const file = path.join(PROJECT_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
  res.type("application/json").send(fs.readFileSync(file, "utf8"));
});

app.post("/api/projects", (req, res) => {
  const body = req.body || {};
  const id = (body.id && /^[a-z0-9_-]{3,40}$/i.test(body.id)) ? body.id : crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  const file = path.join(PROJECT_DIR, `${id}.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const project = {
    id,
    name: body.name || existing.name || "Untitled",
    urls: Array.isArray(body.urls) ? body.urls : (existing.urls || []),
    tags: body.tags && typeof body.tags === "object" ? body.tags : (existing.tags || {}),
    notes: body.notes && typeof body.notes === "object" ? body.notes : (existing.notes || {}),
    review: body.review && typeof body.review === "object" ? body.review : (existing.review || {}),
    tagPalette: Array.isArray(body.tagPalette) ? body.tagPalette : (existing.tagPalette || []),
    settings: body.settings || existing.settings || {},
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  fs.writeFileSync(file, JSON.stringify(project, null, 2));
  res.json({ id, project });
});

app.delete("/api/projects/:id", (req, res) => {
  const file = path.join(PROJECT_DIR, `${req.params.id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

app.use(express.static(PUBLIC_DIR));

const server = app.listen(PORT, () => {
  console.log(`Website Viewer v2 running at http://localhost:${PORT}/`);
});

async function shutdown() {
  server.close();
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser) await browser.close().catch(() => {});
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
