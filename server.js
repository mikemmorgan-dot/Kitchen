/**
 * server.js — Morgan's Kitchen backend
 *
 * Responsibilities:
 *   1. Serve the app (index.html + static files)
 *   2. Proxy blog images (defeats hotlink protection)
 *   3. Scrape + cache recipe menus from 6 food blogs
 *   4. Refresh recipes every Sunday at 3 AM automatically
 *   5. Persist user state (meal log, plan, goals) across sessions
 *
 * Deployment: Render.com free tier (see DEPLOY.md)
 * Local dev:  npm run dev  →  http://localhost:3000
 */

import express from "express";
import * as cheerio from "cheerio";
import { readFileSync, writeFileSync, existsSync } from "fs";
import cron from "node-cron";
import compression from "compression";

const PORT        = process.env.PORT || 3000;
const STATE_FILE  = "./state.json";
const RECIPES_FILE = "./recipes.json";
const WEEK_MS     = 7 * 24 * 60 * 60 * 1000;

// ── Upstash Redis — permanent storage that survives every Render deploy ───────
// Must be defined before loadRecipeStore which runs at startup
const UPSTASH_URL   = (process.env.UPSTASH_REDIS_REST_URL  || "").replace(/\/+$/, "");
const UPSTASH_TOKEN =  process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function kvGet(key) {
  if (!UPSTASH_URL) return null;
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const { result } = await r.json();
    return result ? JSON.parse(result) : null;
  } catch { return null; }
}

async function kvSet(key, value) {
  if (!UPSTASH_URL) return;
  try {
    await fetch(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", key, JSON.stringify(value)])
    });
  } catch {}
}

// ── DEMO image backfill ───────────────────────────────────────────────────────
// Harvests og:image for DEMO recipes with blank images (Cloudflare-blocked
// blogs). Run once by opening /api/backfill-images in a browser. Results are
// stored in Redis ("demo_images") and served to the frontend via /api/menu,
// where existing merge code fills blank DEMO card images by source_url.
let demoImages = {};
let demoNoPhoto = {}; // url -> trace of why every route failed (parked; skipped on reruns)
const demoImagesLoaded = Promise.all([
  kvGet("demo_images").then(d => { if (d && typeof d === "object") demoImages = d; }),
  kvGet("demo_nophoto").then(d => { if (d && typeof d === "object") demoNoPhoto = d; }),
]).catch(() => {});

const BF_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

async function bfFetchPage(url) {
  const T = () => ({ signal: AbortSignal.timeout(15000) }); // 15s cap per attempt
  const trace = [];
  // 1) direct (works for non-blocked blogs)
  try {
    const r = await fetch(url, { headers: { "User-Agent": BF_UA, Accept: "text/html" }, redirect: "follow", ...T() });
    if (r.ok) { const t = await r.text(); if (t.includes("og:image")) return { html: t, trace }; trace.push("direct:no-og"); }
    else trace.push("direct:" + r.status);
  } catch { trace.push("direct:err"); }
  // 2) jina.ai reader proxy
  try {
    const r = await fetch("https://r.jina.ai/" + url, { headers: { "X-Return-Format": "html" }, ...T() });
    if (r.ok) { const t = await r.text(); if (t.includes("og:image")) return { html: t, trace }; trace.push("jina:no-og"); }
    else trace.push("jina:" + r.status);
  } catch { trace.push("jina:err"); }
  // 3) allorigins raw proxy
  try {
    const r = await fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent(url), T());
    if (r.ok) { const t = await r.text(); if (t.includes("og:image")) return { html: t, trace }; trace.push("allorigins:no-og"); }
    else trace.push("allorigins:" + r.status);
  } catch { trace.push("allorigins:err"); }
  // 4) codetabs proxy
  try {
    const r = await fetch("https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url), T());
    if (r.ok) { const t = await r.text(); if (t.includes("og:image")) return { html: t, trace }; trace.push("codetabs:no-og"); }
    else trace.push("codetabs:" + r.status);
  } catch { trace.push("codetabs:err"); }
  // 5) Wayback Machine ("id_" returns the original, unmodified snapshot HTML);
  // cool off and retry once on throttling.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch("https://web.archive.org/web/20240101000000id_/" + url,
        { headers: { "User-Agent": BF_UA }, redirect: "follow", signal: AbortSignal.timeout(25000) });
      if (r.status === 429) { trace.push("wayback:429"); await new Promise(rs => setTimeout(rs, 45000)); continue; }
      if (r.ok) { const t = await r.text(); if (t.includes("og:image")) return { html: t, trace }; trace.push("wayback:no-og"); }
      else trace.push("wayback:" + r.status);
      break;
    } catch { trace.push("wayback:err"); break; }
  }
  return { html: null, trace };
}

function bfExtractOgImage(html, pageUrl) {
  const m = html.match(/property=["']og:image["'][^>]*?content=["']([^"']+)["']/i)
         || html.match(/content=["']([^"']+)["'][^>]*?property=["']og:image["']/i);
  if (!m) return null;
  let img = m[1].replace(/&amp;/g, "&");
  // Unwrap Wayback Machine URLs back to the original blog URL
  const arch = img.match(/^https?:\/\/web\.archive\.org\/web\/[^/]+\/(https?.+)$/);
  if (arch) img = arch[1].replace(/^(https?):\/+/, "$1://");
  try {
    const base = new URL(pageUrl).hostname.replace(/^www\./, "");
    if (!img.includes(base)) return null;                       // must belong to same blog
    if (!/\.(jpe?g|png|webp)(\?.*)?$/i.test(img)) return null;  // must be a real photo
    return img;
  } catch { return null; }
}

// Find the enclosing {...} object around a string index (same brace-matching
// used for all DEMO edits).
function bfEntryBounds(s, idx) {
  let depth = 0, st = -1;
  for (let i = idx; i >= 0; i--) {
    const c = s[i];
    if (c === "}") depth++;
    else if (c === "{") { if (depth === 0) { st = i; break; } depth--; }
  }
  if (st < 0) return null;
  depth = 0;
  for (let j = st; j < s.length; j++) {
    const c = s[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) return [st, j + 1]; }
  }
  return null;
}

// ── Blog category URLs scraped each week ─────────────────────────────────────
const MEAL_SOURCES = {
  breakfast: [
    "https://www.eatingbirdfood.com/category/meal-type/breakfast/",
    "https://www.themediterraneandish.com/category/breakfast/",
    "https://theeastcoastkitchen.com/category/breakfast/",
    "https://detoxinista.com/category/all-recipes/course/breakfast/",
    "https://www.skinnytaste.com/recipes/breakfast-brunch/",
    "https://pinchofyum.com/recipes/breakfast",
  ],
  lunch: [
    "https://www.eatingbirdfood.com/category/meal-type/lunch/",
    "https://www.themediterraneandish.com/category/entree/",
    "https://theeastcoastkitchen.com/category/lunch/",
    "https://detoxinista.com/category/all-recipes/course/main-entrees/",
    "https://www.skinnytaste.com/recipes/lunch/",
    "https://pinchofyum.com/recipes/lunch",
  ],
  dinner: [
    "https://www.eatingbirdfood.com/category/meal-type/dinner/",
    "https://www.themediterraneandish.com/category/entree/",
    "https://theeastcoastkitchen.com/category/dinner/",
    "https://detoxinista.com/category/all-recipes/course/main-entrees/",
    "https://www.skinnytaste.com/recipes/dinner-recipes/",
    "https://pinchofyum.com/recipes/dinner",
    "https://www.fufuskitchen.com/category/dinner/",
  ],
  salad: [
    "https://www.eatingbirdfood.com/category/meal-type/salads/",
    "https://www.themediterraneandish.com/category/salads/",
    "https://detoxinista.com/category/all-recipes/course/salads-dressings/",
    "https://www.skinnytaste.com/recipes/salad/",
    "https://pinchofyum.com/recipes/salad",
    "https://www.fufuskitchen.com/category/salads/",
  ],
};

// Derive blog slug from URL
function blogFromUrl(url) {
  if (url.includes("eatingbirdfood"))      return "eatingbirdfood";
  if (url.includes("themediterraneandish")) return "themediterraneandish";
  if (url.includes("theeastcoastkitchen")) return "theeastcoastkitchen";
  if (url.includes("detoxinista"))         return "detoxinista";
  if (url.includes("skinnytaste"))         return "skinnytaste";
  if (url.includes("pinchofyum"))          return "pinchofyum";
  return "";
}

// ── Recipe store (in-memory + disk persistence) ───────────────────────────────
let recipeStore = { lastUpdated: null };

async function loadRecipeStore() {
  // Try Upstash first (survives deploys)
  const fromKV = await kvGet("recipe_cache");
  if (fromKV && fromKV.lastUpdated) {
    recipeStore = fromKV;
    console.log(`[store] Loaded ${Object.values(fromKV).flat().length - 1} recipes from Upstash (updated ${fromKV.lastUpdated})`);
    return;
  }
  // Fall back to local file (local dev / first run before Upstash)
  try {
    if (existsSync(RECIPES_FILE)) {
      recipeStore = JSON.parse(readFileSync(RECIPES_FILE, "utf8"));
      console.log(`[store] Loaded recipes from disk (updated ${recipeStore.lastUpdated})`);
      // Migrate to Upstash immediately
      await kvSet("recipe_cache", recipeStore);
      console.log("[store] Migrated recipe cache to Upstash");
    }
  } catch (e) {
    console.warn("[store] Could not load recipes.json:", e.message);
  }
}

async function saveRecipeStore() {
  // Save to Upstash (primary — deploy-proof)
  await kvSet("recipe_cache", recipeStore);
  // Also save to disk as local backup
  try { writeFileSync(RECIPES_FILE, JSON.stringify(recipeStore)); }
  catch (e) { console.warn("[store] Could not save recipes.json:", e.message); }
}

function isStale() {
  if (!recipeStore.lastUpdated) return true;
  return Date.now() - new Date(recipeStore.lastUpdated).getTime() > WEEK_MS;
}

// ── Image extraction ───────────────────────────────────────────────────────
// Recipe blogs (pinchofyum, detoxinista, skinnytaste…) lazy-load card images:
// the visible <img src> is a data: placeholder, and the real URL lives in
// srcset / data-lazy-src / data-src or a <noscript> fallback (which cheerio
// keeps as text). Pull the first genuine image URL out of any of those.
function bestFromSrcset(v) {
  if (!v) return null;
  const parts = v.split(",").map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null; // last = largest
}
function looksLikeRealImage(u) {
  if (!u || u.startsWith("data:")) return false;
  if (/(sprite|icon|logo|favicon|placeholder|blank|spacer|1x1|avatar|gravatar|emoji)/i.test(u)) return false;
  return /\.(jpe?g|png|webp)(\?|$)/i.test(u);
}
function pickImage($, el) {
  const cands = [];
  $(el).find("img").each((_, im) => {
    const $im = $(im);
    ["data-lazy-src", "data-src", "data-original", "src"].forEach(a => {
      const v = $im.attr(a); if (v) cands.push(v);
    });
    ["data-lazy-srcset", "data-srcset", "srcset"].forEach(a => {
      const u = bestFromSrcset($im.attr(a)); if (u) cands.push(u);
    });
  });
  // <noscript> contents are parsed as text by cheerio — scan the raw HTML too.
  const html = $(el).html() || "";
  let m;
  const re = /(?:src|data-lazy-src|data-src|srcset)=["']([^"']+)["']/gi;
  while ((m = re.exec(html))) {
    cands.push(m[1].includes(",") ? bestFromSrcset(m[1]) : m[1]);
  }
  for (const u of cands) if (looksLikeRealImage(u)) return u;
  return "";
}

// ── Scraping ──────────────────────────────────────────────────────────────────
async function scrapeCategoryPage(pageUrl) {
  const blog = blogFromUrl(pageUrl);
  const r = await fetch(pageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MorgansKitchen/1.0; personal use)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const $ = cheerio.load(await r.text());
  const host = new URL(pageUrl).origin;
  const seen = new Set();
  const items = [];

  $("article, .post, .recipe-card, .entry").each((_, el) => {
    const a    = $(el).find("a[href]").first();
    let href   = a.attr("href");
    if (!href || href === "#") return;
    if (!href.startsWith("http")) href = host + href;
    if (seen.has(href)) return;
    seen.add(href);

    // Skip category/tag/author pages — must look like a real post slug
    if (/\/(category|tag|author|page)\//.test(href)) return;

    const thumb = pickImage($, el);

    const title =
      $(el).find("h2, h3, .entry-title, .recipe-card__title").first().text().trim() ||
      a.attr("title") || $(el).find("img").first().attr("alt") || "";
    if (!title || title.length < 4) return;

    items.push({ title, source_url: href, blog, image: thumb || "" });
  });
  return items;
}

async function scrapeAll() {
  console.log("[cron] Starting recipe refresh…");
  const updated = {};
  let total = 0;
  for (const [meal, urls] of Object.entries(MEAL_SOURCES)) {
    const seen = new Set();
    const recipes = [];
    for (const url of urls) {
      try {
        const items = await scrapeCategoryPage(url);
        for (const item of items) {
          if (!seen.has(item.source_url)) {
            seen.add(item.source_url);
            // Filter detoxinista dressings from salad
            if (meal === "salad" && /dressing/i.test(item.title)) continue;
            recipes.push(item);
          }
        }
        console.log(`  [ok] ${url.split("/")[2]} → ${items.length} items`);
      } catch (e) {
        console.warn(`  [fail] ${url}: ${e.message}`);
      }
    }
    updated[meal] = recipes;
    total += recipes.length;
  }
  recipeStore = { ...updated, lastUpdated: new Date().toISOString() };
  await saveRecipeStore();
  console.log(`[cron] Done — ${total} recipes across ${Object.keys(updated).length} meal types.`);
}

// Load on startup, scrape if stale
loadRecipeStore().then(() => {
  if (isStale()) {
    console.log("[startup] Recipe store is empty or stale — triggering scrape…");
    scrapeAll().catch(e => console.error("[startup] Scrape failed:", e.message));
  }
});

// Weekly refresh: every Sunday at 3 AM
cron.schedule("0 3 * * 0", () => {
  console.log("[cron] Weekly refresh triggered");
  scrapeAll().catch(e => console.error("[cron] Scrape failed:", e.message));
});

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(compression());          // gzip all responses — shrinks index.html ~5x
app.use(express.json({ limit: "2mb" }));
app.use((_, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options("*", (_, res) => res.sendStatus(204));

// ── Keep-alive ping (set UptimeRobot to hit this every 5 min — prevents Render spin-down) ──
app.get("/ping", (_, res) => res.json({ ok: true, t: Date.now() }));

// ── Service worker — caches app shell for near-instant repeat loads ──────────
app.get("/sw.js", (_, res) => {
  res.set("Content-Type", "application/javascript");
  res.set("Cache-Control", "no-cache");
  res.send(`
const CACHE = "morgans-kitchen-v48";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add("/")));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Images: cache-first (rarely change)
  if (url.pathname.startsWith("/img")) {
    e.respondWith(caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(r => {
        if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(() => hit)
    ));
    return;
  }
  // API: network-first (always fresh)
  if (url.pathname.startsWith("/api")) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // App shell: stale-while-revalidate — instant from cache, refreshes in background
  if (url.pathname === "/" || url.pathname === "/index.html") {
    e.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match("/");
      const fresh = fetch(e.request).then(r => {
        if (r.ok) cache.put("/", r.clone());
        return r;
      });
      return cached || fresh;
    }));
    return;
  }
  e.respondWith(fetch(e.request));
});

// Receive notification requests from the app
self.addEventListener("message", e => {
  if (e.data?.type === "WATER_NOTIF") {
    self.registration.showNotification(e.data.title, {
      body:  e.data.body,
      icon:  e.data.icon  || "/apple-touch-icon.jpg",
      badge: e.data.badge || "/apple-touch-icon.jpg",
      tag:   "water-reminder",
      requireInteraction: false,
    });
  }
});

// Tap notification → open the app
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type:"window"}).then(list => {
    for (const c of list) if (c.url === "/" && "focus" in c) return c.focus();
    if (clients.openWindow) return clients.openWindow("/");
  }));
});
  `);
});

let bfState = { running: false, done: 0, total: 0, ok: 0, fail: 0, failures: [] };

app.all("/api/backfill-images", async (req, res) => {
  await demoImagesLoaded; // never start before saved progress is loaded
  if (bfState.running) {
    return res.type("text/plain").send(
      `Backfill running: ${bfState.done}/${bfState.total} checked, ${bfState.ok} images found so far. Reopen this page to check progress.`);
  }
  let targets = [];
  try {
    const html = readFileSync("./index.html", "utf8");
    const re = /["']?image["']?\s*:\s*""/g;
    let m;
    while ((m = re.exec(html))) {
      const b = bfEntryBounds(html, m.index);
      if (!b) continue;
      const sm = html.slice(b[0], b[1]).match(/["']?source_url["']?\s*:\s*"(https?:\/\/[^"]+)"/);
      if (sm) targets.push(sm[1]);
    }
  } catch (e) {
    return res.status(500).type("text/plain").send("Could not read index.html: " + e.message);
  }
  const force = "retry" in req.query;
  const todo = [...new Set(targets)].filter(u => !demoImages[u] && (force || !demoNoPhoto[u]));
  if (!todo.length) {
    return res.type("text/plain").send(
      `Done: ${Object.keys(demoImages).length} photos saved. ${Object.keys(demoNoPhoto).length} recipes have no findable photo anywhere (likely dead or unarchived pages) — see /api/backfill-status for the list. Add ?retry=1 to this URL to force another attempt on those.`);
  }
  bfState = { running: true, done: 0, total: todo.length, ok: 0, fail: 0, failures: [] };
  res.type("text/plain").send(
    `Backfill started for ${todo.length} remaining recipes — ${Object.keys(demoImages).length} photos from earlier runs are already saved and will be kept. Reopen this page to check progress; pull to refresh the app when it finishes.`);
  (async () => {
    for (const u of todo) {
      try {
        const { html, trace } = await bfFetchPage(u);
        const img = html ? bfExtractOgImage(html, u) : null;
        if (img) {
          demoImages[u] = img;
          delete demoNoPhoto[u];
          bfState.ok++;
          await kvSet("demo_images", demoImages); // checkpoint every success
          await kvSet("demo_nophoto", demoNoPhoto);
        } else {
          bfState.fail++; bfState.failures.push(u);
          demoNoPhoto[u] = (html ? "og-rejected " : "") + trace.join(" ");
          await kvSet("demo_nophoto", demoNoPhoto);
        }
      } catch (e) { bfState.fail++; bfState.failures.push(u); }
      bfState.done++;
      // Render free tier sleeps after ~15 min without inbound traffic, which
      // would kill this run. Ping our own public URL periodically to stay awake.
      const SELF = process.env.RENDER_EXTERNAL_URL || "";
      if (SELF && bfState.done % 5 === 0) fetch(SELF + "/api/status").catch(() => {});
      await new Promise(r => setTimeout(r, 2500)); // gentle pace — avoids archive.org throttling
    }
    await kvSet("demo_images", demoImages);
    bfState.running = false;
    console.log(`[backfill] finished: ${bfState.ok} found, ${bfState.fail} failed`);
  })().catch(e => { bfState.running = false; console.error("[backfill]", e.message); });
});

// ── RSS auto-discovery ────────────────────────────────────────────────────────
// Reads each blog's RSS feed, parses every new post through the JSON-LD recipe
// parser (full ingredients, the blog's own nutrition facts, official photo).
// Posts without a Recipe schema (roundups, essays) and desserts/snacks/drinks
// are skipped. Results persist in Redis and are served through /api/menu.
let discovered = {};
const discoveredLoaded = kvGet("discovered_recipes")
  .then(d => { if (d && typeof d === "object") discovered = d; }).catch(() => {});

const FEED_BLOGS = ["skinnytaste.com","eatingbirdfood.com","themediterraneandish.com",
  "pinchofyum.com","detoxinista.com","theeastcoastkitchen.com","fufuskitchen.com"];

const SKIP_CATS = /dessert|snack|drink|cocktail|smoothie bowl cake|sweets|baking|cookie|cake|muffin|brownie/i;
function feedCourse(cats) {
  const c = cats.join(" ").toLowerCase();
  if (SKIP_CATS.test(c)) return null;            // not a meal — skip
  if (/breakfast|brunch/.test(c)) return "breakfast";
  if (/salad/.test(c))            return "salad";
  if (/lunch|sandwich|wrap/.test(c)) return "lunch";
  return "dinner";                                // mains, soups, everything else
}

let discState = { running: false, done: 0, total: 0, added: 0, skipped: 0, lastRun: null };

async function discoverNew() {
  if (discState.running) return;
  await Promise.all([discoveredLoaded, demoImagesLoaded]);
  discState = { running: true, done: 0, total: 0, added: 0, skipped: 0, lastRun: new Date().toISOString() };
  try {
    const { parseRecipeFromHtml } = await import("./recipe-parser.js");
    // URLs the app already has: DEMO entries + previously discovered
    const known = new Set(Object.keys(discovered));
    try {
      const html = readFileSync("./index.html", "utf8");
      for (const m of html.matchAll(/["']?source_url["']?\s*:\s*"(https?:\/\/[^"]+)"/g)) known.add(m[1].replace(/\/$/, ""));
    } catch {}
    // Collect candidate posts from all feeds
    const candidates = [];
    for (const host of FEED_BLOGS) {
      try {
        const r = await fetch(`https://www.${host}/feed/?nocache=${Date.now()}`,
          { headers: { "User-Agent": BF_UA, Accept: "application/rss+xml,text/xml,*/*", "Cache-Control": "no-cache" },
            signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const $ = cheerio.load(await r.text(), { xmlMode: true });
        $("item").each((_, el) => {
          const link = $(el).find("link").first().text().trim();
          const cats = $(el).find("category").map((_, c) => $(c).text()).get();
          if (link) candidates.push({ link, cats });
        });
      } catch {}
      await new Promise(rs => setTimeout(rs, 500));
    }
    const todo = candidates.filter(c => !known.has(c.link.replace(/\/$/, "")));
    discState.total = todo.length;
    for (const { link, cats } of todo) {
      try {
        const course = feedCourse(cats);
        if (!course) { discState.skipped++; discState.done++; continue; }
        const { html } = await bfFetchPage(link);
        const rec = html ? parseRecipeFromHtml(html, link) : null;
        if (rec?.title && rec.ingredients?.length) {
          rec.course = course;
          rec.blog = rec.blog || new URL(link).hostname.replace(/^www\./, "").split(".")[0];
          discovered[link] = rec;
          discState.added++;
          await kvSet("discovered_recipes", discovered);
        } else discState.skipped++;
      } catch { discState.skipped++; }
      discState.done++;
      const SELF = process.env.RENDER_EXTERNAL_URL || "";
      if (SELF && discState.done % 5 === 0) fetch(SELF + "/api/status").catch(() => {});
      await new Promise(rs => setTimeout(rs, 2000));
    }
  } finally {
    discState.running = false;
    console.log(`[discover] done: +${discState.added} recipes, ${discState.skipped} skipped`);
  }
}

app.all("/api/discover", async (req, res) => {
  if (discState.running) {
    return res.type("text/plain").send(
      `Discovery running: ${discState.done}/${discState.total} posts checked, ${discState.added} recipes added, ${discState.skipped} skipped.`);
  }
  res.type("text/plain").send(
    `Discovery started — reading all 7 blog feeds for new recipes. Reopen this page for progress; pull to refresh the app when done. (Library so far: ${Object.keys(discovered).length} discovered recipes.)`);
  discoverNew().catch(e => console.error("[discover]", e.message));
});

// ── RSS feed reachability check ───────────────────────────────────────────────
// One-tap diagnostic: which blogs' RSS feeds can this server actually read?
// Tries each /feed/ directly, then through the proxies. Wayback is skipped on
// purpose — archived feeds are stale, useless for discovering new posts.
app.get("/api/feed-check", async (_, res) => {
  const blogs = ["skinnytaste.com","eatingbirdfood.com","themediterraneandish.com",
    "pinchofyum.com","detoxinista.com","theeastcoastkitchen.com","fufuskitchen.com"];
  const looksLikeFeed = t => /<rss[\s>]|<feed[\s>]/i.test(t) && /<item[\s>]|<entry[\s>]/i.test(t);
  const tryOne = async (label, u, opts) => {
    try {
      const r = await fetch(u, { ...opts, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { label, fail: r.status };
      const t = await r.text();
      if (!looksLikeFeed(t)) return { label, fail: "not-a-feed" };
      const items = (t.match(/<item[\s>]|<entry[\s>]/gi) || []).length;
      const title = (t.match(/<item[\s\S]*?<title>(?:<!\[CDATA\[)?([^<\]]+)/i) || [])[1] || "?";
      return { label, ok: true, items, title: title.trim() };
    } catch { return { label, fail: "err" }; }
  };
  const checkBlog = async host => {
    const feed = `https://www.${host}/feed/`;
    const routes = [
      ["direct", feed, { headers: { "User-Agent": BF_UA, Accept: "application/rss+xml,text/xml,*/*" } }],
      ["jina", "https://r.jina.ai/" + feed, { headers: { "X-Return-Format": "html" } }],
      ["allorigins", "https://api.allorigins.win/raw?url=" + encodeURIComponent(feed), {}],
      ["codetabs", "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(feed), {}],
    ];
    const fails = [];
    for (const [label, u, opts] of routes) {
      const r = await tryOne(label, u, opts);
      if (r.ok) return `✅ ${host} — readable via ${label} (${r.items} posts, latest: "${r.title}")`;
      fails.push(`${label}:${r.fail}`);
    }
    return `❌ ${host} — unreadable (${fails.join(" ")})`;
  };
  const results = await Promise.all(blogs.map(checkBlog));
  res.type("text/plain").send("RSS FEED CHECK\n\n" + results.join("\n\n"));
});

// Backfill report — see what failed
app.get("/api/backfill-status", async (_, res) => {
  await demoImagesLoaded;
  const byBlog = {};
  for (const u of Object.keys(demoNoPhoto)) {
    let b = "?"; try { b = new URL(u).hostname.replace(/^www\./, "").split(".")[0]; } catch {}
    byBlog[b] = (byBlog[b] || 0) + 1;
  }
  res.json({
    running: bfState.running, progress: `${bfState.done}/${bfState.total}`,
    photosSaved: Object.keys(demoImages).length,
    noPhotoFound: Object.keys(demoNoPhoto).length,
    noPhotoByBlog: byBlog,
    details: demoNoPhoto,
  });
});

// ── Recipe menu endpoint ─────────────────────────────────────────────────────
// Returns fresh scraped recipes for a meal type.
// The frontend merges these with hardcoded DEMO data (DEMO fills in nutrition).
app.get("/api/menu/:meal", (req, res) => {
  const { meal } = req.params;
  const recipes = recipeStore[meal] || [];
  // Append image-only stubs for DEMO recipes whose photos were harvested by
  // /api/backfill-images. The frontend uses these solely to fill blank DEMO
  // card images by source_url; they never render as new cards (all stub blogs
  // are in the frontend's CLOUDFLARE_BLOGS exclusion list and their URLs match
  // existing DEMO entries).
  const have = new Set(recipes.map(r => r.source_url));
  // Recipes auto-discovered from the blogs' RSS feeds (full details parsed)
  const disc = Object.values(discovered).filter(r =>
    (r.course || "dinner") === meal && !have.has(r.source_url));
  disc.forEach(r => have.add(r.source_url));
  const stubs = Object.entries(demoImages)
    .filter(([u]) => !have.has(u))
    .map(([u, img]) => {
      let blog = "";
      try { blog = new URL(u).hostname.replace(/^www\./, "").split(".")[0]; } catch {}
      return { source_url: u, image: img, title: "", blog };
    });
  res.json([...recipes, ...disc, ...stubs]);
});

// Trigger a manual refresh (useful right after first deploy)
app.all("/api/refresh", async (req, res) => {
  res.send("Refresh started — give it a minute or two, then reopen the app and pull to refresh.");
  scrapeAll().catch(e => console.error("[manual] Scrape failed:", e.message))
    .finally(() => discoverNew().catch(e => console.error("[discover]", e.message)));
});

// Scrape status
app.get("/api/status", (_, res) => {
  const counts = Object.fromEntries(
    Object.entries(recipeStore)
      .filter(([k]) => k !== "lastUpdated")
      .map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
  );
  res.json({ lastUpdated: recipeStore.lastUpdated || null, counts });
});

// ── Profile management ────────────────────────────────────────────────────────
const PROFILES_FILE = "./profiles.json";
function sanitizeName(n){ return (n||"").replace(/[^a-zA-Z0-9_\-]/g,"").slice(0,30)||"anonymous"; }

app.get("/api/profiles", async (_, res) => {
  const d = await kvGet("profiles");
  if (d) return res.json(d);
  try { if (existsSync(PROFILES_FILE)) return res.json(JSON.parse(readFileSync(PROFILES_FILE,"utf8"))); } catch {}
  res.json([]);
});
app.post("/api/profiles", async (req, res) => {
  const list = (Array.isArray(req.body)?req.body:[]).filter(n=>typeof n==="string").slice(0,30);
  await kvSet("profiles", list);
  try { writeFileSync(PROFILES_FILE, JSON.stringify(list)); } catch {}
  res.json({ ok: true });
});

// ── Shared state (plan + shopping) — defined before /:profile ─────────────────
app.get("/api/state/shared", async (_, res) => {
  const d = await kvGet("state_shared");
  if (d) return res.json(d);
  try { if (existsSync("./state_shared.json")) return res.json(JSON.parse(readFileSync("./state_shared.json","utf8"))); } catch {}
  res.json({});
});
app.post("/api/state/shared", async (req, res) => {
  await kvSet("state_shared", req.body);
  try { writeFileSync("./state_shared.json", JSON.stringify(req.body,null,2)); } catch {}
  res.json({ ok: true });
});

// ── Personal state per profile ────────────────────────────────────────────────
app.get("/api/state/:profile", async (req, res) => {
  const key  = `state_${sanitizeName(req.params.profile)}`;
  const d    = await kvGet(key);
  if (d) return res.json(d);
  const file = `./${key}.json`;
  try { if (existsSync(file)) return res.json(JSON.parse(readFileSync(file,"utf8"))); } catch {}
  res.json({});
});
app.post("/api/state/:profile", async (req, res) => {
  const key  = `state_${sanitizeName(req.params.profile)}`;
  await kvSet(key, req.body);
  const file = `./${key}.json`;
  try { writeFileSync(file, JSON.stringify(req.body,null,2)); } catch {}
  res.json({ ok: true });
});

// Legacy /api/state (backward compat)
app.get("/api/state", async (_, res) => {
  const d = await kvGet("state_anonymous");
  if (d) return res.json(d);
  try { if (existsSync("./state_anonymous.json")) return res.json(JSON.parse(readFileSync("./state_anonymous.json","utf8"))); } catch {}
  res.json({});
});
app.post("/api/state", async (req, res) => {
  await kvSet("state_anonymous", req.body);
  try { writeFileSync("./state_anonymous.json", JSON.stringify(req.body,null,2)); } catch {}
  res.json({ ok: true });
});

// ── Single recipe parser ─────────────────────────────────────────────────────
// Dynamically import recipe-parser so the module is optional
app.get("/api/recipe", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "missing ?url=" });
  try {
    // Fetch through the full chain (direct -> proxies -> Wayback) so recipes
    // from Cloudflare-blocked blogs load reliably, then parse the JSON-LD.
    const { parseRecipeFromHtml } = await import("./recipe-parser.js");
    const { html } = await bfFetchPage(url);
    if (!html) return res.status(502).json({ error: "Could not reach that page from any route" });
    res.json(parseRecipeFromHtml(html, url));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Image proxy ──────────────────────────────────────────────────────────────
const imgCache = new Map();
app.get("/img", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  const grab = (u, extraHeaders) =>
    fetch(u, {
      headers: { "User-Agent": UA, ...extraHeaders },
      signal: AbortSignal.timeout(10_000),
    });
  try {
    if (imgCache.has(url)) {
      const { type, buf } = imgCache.get(url);
      res.set("Content-Type", type).set("Cache-Control", "public, max-age=604800");
      return res.end(buf);
    }
    // 1) Try the origin directly (with a matching Referer to beat basic hotlink rules).
    let r = null;
    try { r = await grab(url, { Referer: new URL(url).origin + "/" }); } catch { r = null; }
    // 2) If the origin blocks datacenter IPs (Cloudflare / hotlink protection),
    //    retry through weserv.nl, which fetches from its own infrastructure.
    if (!r || !r.ok) {
      const noScheme = url.replace(/^https?:\/\//, "");
      const weserv = "https://images.weserv.nl/?url=ssl:" + noScheme;
      try { r = await grab(weserv); } catch { r = null; }
    }
    if (!r || !r.ok) return res.status(502).end();
    const type = r.headers.get("content-type") || "image/jpeg";
    const buf  = Buffer.from(await r.arrayBuffer());
    if (buf.length < 3_000_000) imgCache.set(url, { type, buf });
    res.set("Content-Type", type).set("Cache-Control", "public, max-age=604800").end(buf);
  } catch { res.status(502).end(); }
});

// Serve PWA manifest
app.get("/manifest.json", (_, res) => {
  res.set("Content-Type", "application/manifest+json");
  res.set("Cache-Control", "public, max-age=3600");
  res.sendFile("manifest.json", { root: "." });
});

// Serve the app
app.use(express.static("."));

app.listen(PORT, () =>
  console.log(`Morgan's Kitchen running → http://localhost:${PORT}`)
);
