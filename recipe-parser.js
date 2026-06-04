// recipe-parser.js
// The technical crux: turn any WordPress food-blog recipe page into one clean,
// predictable object your app can render. Works by reading the schema.org
// "Recipe" JSON-LD that recipe plugins (WP Recipe Maker, Tasty, etc.) embed in
// every page. JSON-LD is machine-readable and stable, so we never scrape fragile
// HTML layout.

import * as cheerio from "cheerio";

// ---------- small helpers ----------

const stripTags = (s = "") =>
  String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&#8217;/g, "’")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// "PT1H10M" -> "1 hr 10 mins"
const humanDuration = (iso) => {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  const [, d, h, min] = m.map((x) => (x ? parseInt(x, 10) : 0));
  const parts = [];
  if (d) parts.push(`${d} day${d > 1 ? "s" : ""}`);
  if (h) parts.push(`${h} hr${h > 1 ? "s" : ""}`);
  if (min) parts.push(`${min} min${min > 1 ? "s" : ""}`);
  return parts.length ? parts.join(" ") : null;
};

// pull the first number out of "12 g" / "210 kcal" -> 12 / 210
const num = (v) => {
  if (v == null) return null;
  const m = String(v).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
};

const firstString = (v) => {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return firstString(v[0]);
  if (typeof v === "object") return v.url || v.name || v["@id"] || null;
  return null;
};

// images come as: string | [string] | {url} | [{url}]
const pickImage = (img) => {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return pickImage(img[0]);
  if (typeof img === "object") return img.url || pickImage(img.contentUrl);
  return null;
};

// ---------- find the Recipe node inside any JSON-LD shape ----------

function findRecipeNode(json) {
  const queue = Array.isArray(json) ? [...json] : [json];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    const type = node["@type"];
    const isRecipe = Array.isArray(type)
      ? type.includes("Recipe")
      : type === "Recipe";
    if (isRecipe) return node;
    if (Array.isArray(node["@graph"])) queue.push(...node["@graph"]);
  }
  return null;
}

// ---------- instructions: the messiest field in the spec ----------
// Can be: a string, [strings], [{HowToStep,text}], or grouped into
// [{HowToSection,name,itemListElement:[HowToStep]}]. We normalize to sections.

function parseInstructions(instr) {
  if (!instr) return [];
  if (typeof instr === "string") {
    return [{ name: null, steps: [stripTags(instr)] }];
  }
  const sections = [];
  let loose = [];
  for (const item of [].concat(instr)) {
    if (typeof item === "string") {
      loose.push(stripTags(item));
    } else if (item && item["@type"] === "HowToSection") {
      const steps = [].concat(item.itemListElement || [])
        .map((s) => stripTags(typeof s === "string" ? s : s.text))
        .filter(Boolean);
      sections.push({ name: stripTags(item.name) || null, steps });
    } else if (item && (item.text || item.name)) {
      loose.push(stripTags(item.text || item.name));
    }
  }
  if (loose.length) sections.unshift({ name: null, steps: loose });
  return sections;
}

// ---------- nutrition ----------

function parseNutrition(n = {}) {
  return {
    calories: num(n.calories),
    protein_g: num(n.proteinContent),
    carbs_g: num(n.carbohydrateContent),
    fat_g: num(n.fatContent),
    fiber_g: num(n.fiberContent),
    sugar_g: num(n.sugarContent),
    sodium_mg: num(n.sodiumContent),
    serving_size: n.servingSize || null,
  };
}

// ---------- main entry points ----------

export function parseRecipeFromHtml(html, sourceUrl = "") {
  const $ = cheerio.load(html);
  let recipe = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (recipe) return;
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      recipe = findRecipeNode(JSON.parse(raw));
    } catch {
      /* some sites emit invalid JSON-LD; just skip that block */
    }
  });

  if (!recipe) {
    throw new Error("No schema.org Recipe JSON-LD found on this page.");
  }

  const yieldRaw = Array.isArray(recipe.recipeYield)
    ? recipe.recipeYield[0]
    : recipe.recipeYield;
  const servings = num(yieldRaw);

  // derive a clean blog name from the host, e.g. eatingbirdfood
  let blog = null;
  try {
    blog = new URL(sourceUrl).hostname.replace(/^www\./, "").split(".")[0];
  } catch {}

  const video = recipe.video || null;

  return {
    title: stripTags(firstString(recipe.name)),
    blog,                                   // subtitle, per your spec
    author: firstString(recipe.author),
    source_url: sourceUrl,
    image: pickImage(recipe.image),
    description: stripTags(firstString(recipe.description)),
    servings: servings || null,
    yield_text: typeof yieldRaw === "string" ? yieldRaw : null,
    times: {
      prep: humanDuration(recipe.prepTime),
      cook: humanDuration(recipe.cookTime),
      total: humanDuration(recipe.totalTime),
    },
    ingredients: [].concat(recipe.recipeIngredient || []).map(stripTags),
    instructions: parseInstructions(recipe.recipeInstructions),
    nutrition: parseNutrition(recipe.nutrition || {}),
    video: video
      ? {
          embed_url: video.embedUrl || null,
          content_url: video.contentUrl || null,
          thumbnail: pickImage(video.thumbnailUrl),
        }
      : null,
    rating: recipe.aggregateRating
      ? {
          value: num(recipe.aggregateRating.ratingValue),
          count: num(recipe.aggregateRating.ratingCount),
        }
      : null,
  };
}

export async function fetchAndParseRecipe(url) {
  const res = await fetch(url, {
    headers: {
      // identify politely; some hosts block empty UAs
      "User-Agent":
        "Mozilla/5.0 (compatible; FamilyMenuApp/0.1; personal use)",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();
  return parseRecipeFromHtml(html, url);
}
