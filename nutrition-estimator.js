// nutrition-estimator.js
// Approximates per-serving nutrition from an ingredient list, for recipes whose
// source blog doesn't publish nutrition facts (e.g. fufuskitchen).
//
// Philosophy: under-claim rather than invent. Unmatched ingredients are skipped,
// and if we can't recognise enough of the recipe we return null instead of a
// misleading number. Protein estimates are the most reliable output (protein is
// dominated by a few big, easily-identified items); calories carry more error
// because fat content of meats/oils varies.

// Macros per 100 g. [kcal, protein, carbs, fat, fibre]
// gCup  = grams in 1 cup (for volume measures)
// gUnit = grams of 1 whole item (for countable items)
const FOODS = [
  // ── meat & poultry ────────────────────────────────────────────────────────
  ["ground beef|beef mince|minced beef",      [250, 17.7, 0, 20, 0]],
  ["chuck roast|braising steak|stew(ing)? beef|brisket", [217, 19, 0, 15, 0]],
  ["steak|sirloin|ribeye|flank",              [217, 22, 0, 14, 0],   { gUnit: 225 }],
  ["beef",                                     [217, 19, 0, 15, 0]],
  ["ground lamb|lamb mince",                   [282, 17, 0, 23, 0]],
  ["lamb|leg of lamb|lamb shoulder",           [258, 18, 0, 21, 0]],
  ["ground turkey|turkey mince",               [189, 27, 0, 8, 0]],
  ["turkey",                                   [189, 27, 0, 8, 0]],
  ["chicken breasts?",                           [165, 31, 0, 3.6, 0], { gUnit: 174 }],
  ["chicken thighs?|chicken legs?|drumsticks?",  [209, 26, 0, 11, 0],  { gUnit: 95 }],
  ["whole chicken",                            [190, 27, 0, 9, 0],   { gUnit: 800 }],
  ["chicken",                                  [190, 27, 0, 9, 0]],
  ["bacon",                                    [541, 37, 1.4, 42, 0],{ gUnit: 10 }],
  ["sausage|chorizo",                          [301, 18, 2, 25, 0],  { gUnit: 75 }],
  ["pork|pork loin|pork shoulder",             [242, 26, 0, 14, 0]],
  // ── fish & seafood ────────────────────────────────────────────────────────
  ["salmon fillets?|salmon",                                   [208, 20, 0, 13, 0],  { gUnit: 170 }],
  ["shrimp|prawns?",                           [99, 24, 0.2, 0.3, 0],{ gUnit: 15 }],
  ["tuna steaks?|tuna",                        [132, 28, 0, 1, 0],   { gUnit: 150, gCan: 142 }],
  ["branzino|sea bass|cod|halibut|tilapia|white fish|fish fillets?", [97, 20, 0, 2, 0], { gUnit: 170 }],
  ["sardines?|crab|lobster",                             [89, 19, 0, 1, 0]],
  // ── dairy & eggs ──────────────────────────────────────────────────────────
  ["eggs?",                                    [143, 12.6, 0.7, 9.5, 0], { gUnit: 50 }],
  ["egg whites?",                              [52, 11, 0.7, 0.2, 0],    { gUnit: 33 }],
  ["halloumi",                                 [321, 22, 2.2, 25, 0]],
  ["feta",                                     [264, 14, 4, 21, 0],      { gCup: 150 }],
  ["mozzarella|burrata",                       [300, 22, 2.2, 22, 0],    { gCup: 112 }],
  ["parmesan|pecorino",                        [431, 38, 4, 29, 0],      { gCup: 100 }],
  ["cheddar|shredded cheese|cheese",           [403, 25, 1.3, 33, 0],    { gCup: 113 }],
  ["cream cheese",                             [350, 6, 5.5, 34, 0],     { gCup: 232 }],
  ["greek yogurt|labneh",                      [97, 9, 4, 5, 0],         { gCup: 245 }],
  ["yogurt|yoghurt",                           [61, 3.5, 4.7, 3.3, 0],   { gCup: 245 }],
  ["cottage cheese",                           [98, 11, 3.4, 4.3, 0],    { gCup: 226 }],
  ["heavy cream|double cream",                 [340, 2.1, 2.8, 36, 0],   { gCup: 238 }],
  ["milk",                                     [61, 3.2, 4.8, 3.3, 0],   { gCup: 244 }],
  ["butter|ghee",                              [717, 0.9, 0.1, 81, 0],   { gCup: 227 }],
  // ── legumes & plant protein ───────────────────────────────────────────────
  ["chickpeas|garbanzo",                       [164, 8.9, 27, 2.6, 7.6], { gCup: 164 }],
  ["lentils",                                  [116, 9, 20, 0.4, 8],     { gCup: 198 }],
  ["fava beans|ful|broad beans",               [110, 7.6, 19, 0.4, 5.4], { gCup: 170 }],
  ["white beans|cannellini|navy beans",        [139, 9.7, 25, 0.5, 6.3], { gCup: 179 }],
  ["black beans|kidney beans",                 [132, 8.9, 24, 0.5, 8.7], { gCup: 172 }],
  ["tofu",                                     [76, 8, 1.9, 4.8, 0.3],   { gCup: 248 }],
  ["tempeh",                                   [192, 20, 7.6, 11, 0],{ gUnit: 227 }],
  // ── grains & starches ─────────────────────────────────────────────────────
  ["cooked rice",                              [130, 2.7, 28, 0.3, 0.4], { gCup: 158 }],
  ["rice|basmati|jasmine rice",                [360, 7, 79, 0.9, 1.3],   { gCup: 185 }],
  ["vermicelli|orzo|couscous",                 [360, 12, 73, 1.5, 3],    { gCup: 160 }],
  ["freekeh|bulgur|farro",                     [352, 12, 72, 2.5, 13],   { gCup: 170 }],
  ["quinoa",                                   [368, 14, 64, 6, 7],      { gCup: 170 }],
  ["pasta|spaghetti|penne|noodles",            [371, 13, 75, 1.5, 3.2],  { gCup: 100 }],
  ["oats|rolled oats",                         [389, 17, 66, 7, 10],     { gCup: 90 }],
  ["flour",                                    [364, 10, 76, 1, 2.7],    { gCup: 120 }],
  ["breadcrumbs|panko",                        [395, 13, 72, 5, 4]],
  ["tortillas?",                               [310, 8, 51, 8, 3],       { gUnit: 45 }],
  ["pita|flatbread|naan",                      [275, 9, 55, 1.2, 2.2],   { gUnit: 60 }],
  ["bread|toast|baguette",                     [265, 9, 49, 3.2, 2.7],   { gUnit: 30 }],
  ["potatoes?",                                [77, 2, 17, 0.1, 2.2],    { gUnit: 170 }],
  ["sweet potatoes?",                          [86, 1.6, 20, 0.1, 3],    { gUnit: 95 }],
  // ── vegetables ────────────────────────────────────────────────────────────
  ["onions?|shallots?",                        [40, 1.1, 9.3, 0.1, 1.7], { gUnit: 110, gCup: 160 }],
  ["garlic",                                   [149, 6.4, 33, 0.5, 2.1], { gUnit: 3 }],
  ["cherry tomatoes?|grape tomatoes?",         [18, 0.9, 3.9, 0.2, 1.2], { gCup: 150 }],
  ["tomatoes?|tomato paste|passata",           [18, 0.9, 3.9, 0.2, 1.2], { gUnit: 120, gCup: 180 }],
  ["cucumbers?",                               [15, 0.7, 3.6, 0.1, 0.5], { gUnit: 200, gCup: 120 }],
  ["zucchini|courgette|kousa",                 [17, 1.2, 3.1, 0.3, 1],   { gUnit: 200, gCup: 124 }],
  ["eggplants?|aubergines?",                   [25, 1, 6, 0.2, 3],       { gUnit: 400, gCup: 82 }],
  ["bell peppers?|capsicum|red peppers?",      [26, 1, 6, 0.3, 2.1],     { gUnit: 120, gCup: 150 }],
  ["carrots?",                                 [41, 0.9, 10, 0.2, 2.8],  { gUnit: 60, gCup: 128 }],
  ["spinach",                                  [23, 2.9, 3.6, 0.4, 2.2], { gCup: 30 }],
  ["kale",                                     [49, 4.3, 9, 0.9, 3.6],   { gCup: 20 }],
  ["lettuce|romaine|greens|arugula",           [17, 1.2, 3.3, 0.3, 2.1], { gCup: 47 }],
  ["parsley|cilantro|coriander leaves|dill",   [36, 3, 6, 0.8, 3.3],     { gCup: 60 }],
  ["mint|basil",                               [70, 3.8, 15, 0.9, 8],    { gCup: 30 }],
  ["cabbage",                                  [25, 1.3, 6, 0.1, 2.5],   { gCup: 89 }],
  ["cauliflower",                              [25, 1.9, 5, 0.3, 2],     { gCup: 107 }],
  ["broccoli",                                 [34, 2.8, 7, 0.4, 2.6],   { gCup: 91 }],
  ["mushrooms?",                               [22, 3.1, 3.3, 0.3, 1],   { gCup: 70 }],
  ["green beans",                              [31, 1.8, 7, 0.2, 2.7],   { gCup: 110 }],
  ["peas",                                     [81, 5.4, 14, 0.4, 5],    { gCup: 145 }],
  ["corn",                                     [86, 3.3, 19, 1.2, 2],    { gCup: 165 }],
  ["olives",                                   [115, 0.8, 6, 11, 3],     { gCup: 135 }],
  ["grape leaves|vine leaves",                 [69, 5.6, 11, 2, 9.9]],
  ["molokhia|jute leaves",                     [34, 4.7, 5.6, 0.3, 3]],
  ["avocado",                                  [160, 2, 8.5, 15, 6.7],   { gUnit: 150 }],
  ["pomegranate",                              [83, 1.7, 19, 1.2, 4],    { gCup: 174 }],
  ["pickles",                                  [12, 0.3, 2.3, 0.2, 1.2]],
  ["radish|celery|scallions?|green onions?|leeks?", [20, 1, 4, 0.2, 1.6], { gCup: 100 }],
  // ── fats, nuts, sweeteners, extras ────────────────────────────────────────
  ["olive oil|vegetable oil|avocado oil|oil",  [884, 0, 0, 100, 0],      { gCup: 216 }],
  ["tahini",                                   [595, 17, 21, 54, 9],     { gCup: 240 }],
  ["peanut butter|almond butter",              [588, 25, 20, 50, 6],     { gCup: 258 }],
  ["almonds",                                  [579, 21, 22, 50, 12.5],  { gCup: 143 }],
  ["walnuts|pecans",                           [654, 15, 14, 65, 6.7],   { gCup: 117 }],
  ["pine nuts",                                [673, 14, 13, 68, 3.7],   { gCup: 135 }],
  ["pistachios|cashews",                       [560, 20, 28, 45, 10],    { gCup: 123 }],
  ["sesame seeds",                             [573, 17, 23, 50, 12]],
  ["chia seeds|flax",                          [486, 17, 42, 31, 34]],
  ["coconut milk",                             [230, 2.3, 5.5, 24, 0],   { gCup: 240 }],
  ["mayonnaise|aioli",                         [680, 1, 0.6, 75, 0],     { gCup: 220 }],
  ["ketchup|bbq sauce",                        [101, 1.2, 26, 0.1, 0.3]],
  ["mustard",                                  [66, 4, 6, 3.3, 3.3]],
  ["soy sauce",                                [53, 8, 4.9, 0.1, 0]],
  ["honey|maple syrup",                        [304, 0.3, 82, 0, 0],     { gCup: 340 }],
  ["sugar",                                    [387, 0, 100, 0, 0],      { gCup: 200 }],
  ["pomegranate molasses",                     [280, 0.4, 70, 0, 0]],
  ["lemon juice|lime juice|vinegar|lemons?|limes?", [22, 0.4, 6.9, 0.2, 0.3], { gUnit: 60, gCup: 240 }],
  ["chicken broth|chicken stock|beef broth|beef stock|vegetable broth|vegetable stock|bone broth",
                                               [7, 1, 0.5, 0.2, 0],      { gCup: 240 }],
  ["broth|stock",                              [7, 1, 0.5, 0.2, 0],      { gCup: 240 }],
  ["water",                                    [0, 0, 0, 0, 0],          { gCup: 240 }],
];

// Seasonings: recognised so they count as "understood", but contribute ~nothing
const NEGLIGIBLE = /\b(salt|pepper|cumin|allspice|paprika|sumac|za'?atar|cinnamon|turmeric|coriander|cardamom|nutmeg|oregano|thyme|rosemary|bay lea(f|ves)|chili flakes?|red pepper flakes?|cayenne|baking (powder|soda)|vanilla|spices?|seasoning|garnish|to taste|for serving|to serve)\b/i;

const UNIT_G = { g: 1, gram: 1, grams: 1, gr: 1, kg: 1000, kilogram: 1000,
  oz: 28.35, ounce: 28.35, ounces: 28.35, lb: 453.6, lbs: 453.6, pound: 453.6, pounds: 453.6,
  ml: 1, milliliter: 1, l: 1000, liter: 1000, litre: 1000 };

function parseQuantity(text) {
  // leading amount: "1", "1.5", "1/2", "1 1/2", "½"
  const uni = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1/3, "⅔": 2/3, "⅛": 0.125 };
  let t = text.trim();
  for (const [ch, v] of Object.entries(uni)) t = t.replace(ch, ` ${v} `);
  const m = t.match(/^\s*(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d*\.?\d+)\s*(.*)$/);
  if (!m) return { qty: null, rest: t };
  let qty;
  const raw = m[1].trim();
  if (/\s/.test(raw) && raw.includes("/")) {          // mixed "1 1/2"
    const [whole, frac] = raw.split(/\s+/);
    const [a, b] = frac.split("/").map(Number);
    qty = Number(whole) + a / b;
  } else if (raw.includes("/")) {
    const [a, b] = raw.split("/").map(Number);
    qty = a / b;
  } else qty = Number(raw);
  return { qty: isFinite(qty) ? qty : null, rest: m[2] };
}

function matchFood(text) {
  const t = text.toLowerCase();
  let best = null, bestLen = 0;
  for (const entry of FOODS) {
    const [pattern] = entry;
    const rx = new RegExp("\\b(" + pattern + ")\\b", "i");
    const hit = t.match(rx);
    if (hit && hit[0].length > bestLen) { best = entry; bestLen = hit[0].length; }
  }
  return best;
}

function gramsFor(qty, unitWord, food) {
  const opts = food[2] || {};
  const u = (unitWord || "").toLowerCase().replace(/\.$/, "");
  if (UNIT_G[u]) return qty * UNIT_G[u];
  if (/^cups?$/.test(u))            return qty * (opts.gCup || 150);
  if (/^(tbsp|tablespoons?)$/.test(u)) return qty * ((opts.gCup || 150) / 16);
  if (/^(tsp|teaspoons?)$/.test(u))    return qty * ((opts.gCup || 150) / 48);
  if (/^cloves?$/.test(u))          return qty * 3;
  if (/^cans?$/.test(u))            return qty * (opts.gCan || 400);
  if (/^(slices?|pieces?|sprigs?|strips?|rashers?|fillets?|links?)$/.test(u)) return qty * (opts.gUnit || 25);
  if (/^(bunch(es)?|heads?)$/.test(u))       return qty * (opts.gCup || 100);
  // no recognised unit — treat as a count of whole items
  if (opts.gUnit) return qty * opts.gUnit;
  if (opts.gCup)  return qty * opts.gCup;      // e.g. "2 tomatoes" style fallbacks
  return null;                                  // can't size it — skip
}

/**
 * Estimate per-serving nutrition.
 * @returns {object|null} nutrition object, or null when confidence is too low.
 */
export function estimateNutrition(ingredients, servings = 4) {
  if (!Array.isArray(ingredients) || !ingredients.length) return null;
  const n = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  let understood = 0, sized = 0, unsizedProtein = 0;
  const PROTEIN_DENSE = 15;   // g per 100 g — meat, fish, tofu-and-up

  for (const raw of ingredients) {
    const line = String(raw || "").trim();
    if (!line) continue;
    if (NEGLIGIBLE.test(line) && !matchFood(line)) { understood++; continue; }

    const { qty, rest } = parseQuantity(line);
    const food = matchFood(rest || line);
    if (!food) continue;                       // unknown ingredient — skip, don't invent
    understood++;
    if (qty == null) {                         // known food, no amount at all
      if (food[1][1] >= PROTEIN_DENSE) unsizedProtein++;
      continue;
    }

    const unitWord = (rest.match(/^\s*([a-zA-Z.]+)/) || [])[1] || "";
    const grams = gramsFor(qty, unitWord, food);
    if (grams == null || !isFinite(grams) || grams <= 0) {
      // We recognised the food but can't turn it into a weight. Dropping a
      // protein-dense line silently is how a chicken dinner ends up reading 2 g,
      // so remember it and refuse to publish a number below.
      if (food[1][1] >= PROTEIN_DENSE) unsizedProtein++;
      continue;
    }
    sized++;

    const [, macros] = food;
    const f = grams / 100;
    n.calories  += macros[0] * f;
    n.protein_g += macros[1] * f;
    n.carbs_g   += macros[2] * f;
    n.fat_g     += macros[3] * f;
    n.fiber_g   += macros[4] * f;
  }

  const coverage = understood / ingredients.length;
  // Not enough of the recipe recognised, or nothing measurable → no estimate.
  if (coverage < 0.55 || sized < 2) return null;
  // A main protein we couldn't size means the headline number would be far too
  // low. Better to return nothing and leave the card blank than to under-claim.
  if (unsizedProtein) return null;

  const per = Math.max(1, Number(servings) || 4);
  const out = {
    calories:  Math.round(n.calories  / per),
    protein_g: Math.round(n.protein_g / per),
    carbs_g:   Math.round(n.carbs_g   / per),
    fat_g:     Math.round(n.fat_g     / per),
    fiber_g:   Math.round(n.fiber_g   / per),
    estimated: true,
  };
  // Sanity guard — a per-serving figure this extreme means we mis-parsed.
  if (out.calories < 40 || out.calories > 2000 || out.protein_g > 150) return null;
  return out;
}

export function needsNutrition(rec) {
  const n = rec && rec.nutrition;
  if (!n || typeof n !== "object") return true;
  const p = Number(n.protein_g), c = Number(n.calories);
  return !(p > 0) || !(c > 0);
}
