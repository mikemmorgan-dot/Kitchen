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

const PORT        = process.env.PORT || 3000;
const STATE_FILE  = "./state.json";
const RECIPES_FILE = "./recipes.json";
const WEEK_MS     = 7 * 24 * 60 * 60 * 1000;

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
  ],
  salad: [
    "https://www.eatingbirdfood.com/category/meal-type/salads/",
    "https://www.themediterraneandish.com/category/salads/",
    "https://detoxinista.com/category/all-recipes/course/salads-dressings/",
    "https://www.skinnytaste.com/recipes/salad/",
    "https://pinchofyum.com/recipes/salad",
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

function loadRecipeStore() {
  try {
    if (existsSync(RECIPES_FILE)) {
      recipeStore = JSON.parse(readFileSync(RECIPES_FILE, "utf8"));
      console.log(`[store] Loaded recipes from disk (updated ${recipeStore.lastUpdated})`);
    }
  } catch (e) {
    console.warn("[store] Could not load recipes.json:", e.message);
  }
}

function saveRecipeStore() {
  try { writeFileSync(RECIPES_FILE, JSON.stringify(recipeStore)); }
  catch (e) { console.warn("[store] Could not save recipes.json:", e.message); }
}

function isStale() {
  if (!recipeStore.lastUpdated) return true;
  return Date.now() - new Date(recipeStore.lastUpdated).getTime() > WEEK_MS;
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

    const img   = $(el).find("img").first();
    const thumb =
      img.attr("data-lazy-src") || img.attr("data-src") || img.attr("src") || null;
    // Skip category/tag/author pages — must look like a real post slug
    if (/\/(category|tag|author|page)\//.test(href)) return;

    const title =
      $(el).find("h2, h3, .entry-title, .recipe-card__title").first().text().trim() ||
      a.attr("title") || img.attr("alt") || "";
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
  saveRecipeStore();
  console.log(`[cron] Done — ${total} recipes across ${Object.keys(updated).length} meal types.`);
}

// Load on startup, scrape if stale
loadRecipeStore();
if (isStale()) {
  console.log("[startup] Recipe store is empty or stale — triggering scrape…");
  scrapeAll().catch(e => console.error("[startup] Scrape failed:", e.message));
}

// Weekly refresh: every Sunday at 3 AM
cron.schedule("0 3 * * 0", () => {
  console.log("[cron] Weekly refresh triggered");
  scrapeAll().catch(e => console.error("[cron] Scrape failed:", e.message));
});

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((_, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options("*", (_, res) => res.sendStatus(204));

// ── Recipe menu endpoint ─────────────────────────────────────────────────────
// Returns fresh scraped recipes for a meal type.
// The frontend merges these with hardcoded DEMO data (DEMO fills in nutrition).
app.get("/api/menu/:meal", (req, res) => {
  const { meal } = req.params;
  const recipes = recipeStore[meal] || [];
  res.json(recipes);
});

// Trigger a manual refresh (useful right after first deploy)
app.post("/api/refresh", async (req, res) => {
  res.json({ ok: true, message: "Refresh started in background" });
  scrapeAll().catch(e => console.error("[manual] Scrape failed:", e.message));
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

// ── User state persistence ───────────────────────────────────────────────────
app.get("/api/state", (_, res) => {
  try {
    if (existsSync(STATE_FILE)) return res.json(JSON.parse(readFileSync(STATE_FILE, "utf8")));
  } catch {}
  res.json({});
});
app.post("/api/state", (req, res) => {
  try { writeFileSync(STATE_FILE, JSON.stringify(req.body, null, 2)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single recipe parser ─────────────────────────────────────────────────────
// Dynamically import recipe-parser so the module is optional
app.get("/api/recipe", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "missing ?url=" });
  try {
    const { fetchAndParseRecipe } = await import("./recipe-parser.js");
    const data = await fetchAndParseRecipe(url);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Image proxy ──────────────────────────────────────────────────────────────
const imgCache = new Map();
app.get("/img", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  try {
    if (imgCache.has(url)) {
      const { type, buf } = imgCache.get(url);
      res.set("Content-Type", type).set("Cache-Control", "public, max-age=604800");
      return res.end(buf);
    }
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": new URL(url).origin + "/",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return res.status(502).end();
    const type = r.headers.get("content-type") || "image/jpeg";
    const buf  = Buffer.from(await r.arrayBuffer());
    if (buf.length < 3_000_000) imgCache.set(url, { type, buf });
    res.set("Content-Type", type).set("Cache-Control", "public, max-age=604800").end(buf);
  } catch { res.status(502).end(); }
});

// Serve the app
app.use(express.static("."));

app.listen(PORT, () =>
  console.log(`Morgan's Kitchen running → http://localhost:${PORT}`)
);
