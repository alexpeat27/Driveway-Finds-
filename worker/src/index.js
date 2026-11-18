/* Driveway Finds search Worker.
   Takes one search from the page, asks MarketCheck, Auto.dev and eBay Motors at the same time,
   and returns one merged list with photos. The API keys stay here as Cloudflare secrets.

   Secrets (Settings > Variables and Secrets, type Secret):
     ACCESS_CODE          required. A passphrase the page must send. Without it the Worker refuses everything.
     MARKETCHECK_KEY      optional. Turns on MarketCheck (dealers) and its private-seller search.
     AUTODEV_KEY          optional. Turns on Auto.dev (dealers).
     EBAY_CLIENT_ID       optional, with EBAY_CLIENT_SECRET. Turns on eBay Motors.
     EBAY_CLIENT_SECRET
   Plain variable:
     ALLOWED_ORIGINS      optional. Comma-separated page addresses allowed to call this, e.g.
                          https://alexample.github.io. Leave empty to allow any page that knows the access code. */

const SITE_URL = "https://alexpeat27.github.io/Driveway-Finds-/";
const MAX_PER_SOURCE = 50;
const CACHE_SECONDS = 900; // repeat searches within 15 minutes reuse the last answer and spend no quota
const TIMEOUT_MS = 12000;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    // Someone opening the server's address in a browser is sent to the website itself.
    if (url.pathname === "/" && request.method === "GET" && /text\/html/.test(request.headers.get("Accept") || "")) {
      return Response.redirect(SITE_URL, 302);
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, sources: enabledSources(env) }, 200, cors);
    }
    if (url.pathname !== "/search" || request.method !== "GET") return json({ error: "not_found" }, 404, cors);
    if (!originAllowed(origin, env)) return json({ error: "origin_not_allowed" }, 403, cors);
    if (!env.ACCESS_CODE) return json({ error: "access_code_not_set", message: "Add an ACCESS_CODE secret to the Worker." }, 503, cors);
    if (!sameSecret(request.headers.get("X-Access-Code") || "", env.ACCESS_CODE)) return json({ error: "wrong_access_code" }, 401, cors);

    const c = readCriteria(url.searchParams);
    if (!c.vehicles.length && !c.body) return json({ error: "no_vehicle", message: "Enter a make or model, or pick a body style." }, 400, cors);

    const cacheKey = new Request("https://cache.driveway-finds/search/v2?" + canonicalQuery(c));
    const cache = typeof caches !== "undefined" ? caches.default : null;
    if (cache && url.searchParams.get("fresh") !== "1") {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.json();
        return json(Object.assign(body, { cached: true }), 200, cors);
      }
    }
    const body = await searchAll(c, env);
    if (cache && body.results.length) {
      const res = json(body, 200, { "Cache-Control": "max-age=" + CACHE_SECONDS });
      ctx && ctx.waitUntil ? ctx.waitUntil(cache.put(cacheKey, res)) : await cache.put(cacheKey, res);
    }
    return json(Object.assign(body, { cached: false }), 200, cors);
  },
};

/* ---------- request handling ---------- */
function corsHeaders(origin, env) {
  const h = { "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "X-Access-Code", "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (origin && originAllowed(origin, env)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function originAllowed(origin, env) {
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!list.length) return true;
  return !origin || list.includes(origin); // no Origin header means a direct visit, not another site's page
}
/* Compares without stopping at the first difference, so timing reveals nothing about the code. */
function sameSecret(a, b) {
  const enc = new TextEncoder(), x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}) });
}
function enabledSources(env) {
  const s = [];
  if (env.MARKETCHECK_KEY) s.push("MarketCheck");
  if (env.AUTODEV_KEY) s.push("Auto.dev");
  if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) s.push("eBay Motors");
  return s;
}

function int(v, min, max) {
  const n = parseInt(String(v || "").replace(/[^\d]/g, ""), 10);
  if (isNaN(n)) return null;
  return Math.min(Math.max(n, min), max);
}
/* "01" means 2001 and "85" means 1985; a range typed backwards is swapped. */
export function fullYear(v) {
  const s = String(v == null ? "" : v).replace(/[^\d]/g, "");
  if (!s) return null;
  let n = parseInt(s, 10);
  if (s.length <= 2) n += n <= (new Date().getFullYear() % 100) + 1 ? 2000 : 1900;
  return Math.min(Math.max(n, 1950), 2035);
}
function years(a, b) {
  let yearMin = fullYear(a), yearMax = fullYear(b);
  if (yearMin && yearMax && yearMin > yearMax) [yearMin, yearMax] = [yearMax, yearMin];
  return { yearMin, yearMax };
}
/* Model names are spelled with and without a dash ("S10" and "S-10", "F150" and "F-150").
   Auto.dev treats a comma as "or", so send both spellings. */
export function modelSpellings(m) {
  const out = [m];
  const dashed = m.replace(/\b([a-z]{1,3})(\d{2,4})\b/gi, "$1-$2");
  const plain = m.replace(/\b([a-z]{1,3})-(\d{2,4})\b/gi, "$1$2");
  for (const x of [dashed, plain]) if (!out.includes(x)) out.push(x);
  return out.join(",");
}
export function readCriteria(p) {
  const seen = {};
  const vehicles = String(p.get("vehicles") || "").split(/[,;\n]+/).map((s) => s.replace(/[^\w\s.-]/g, "").replace(/\s+/g, " ").trim())
    .filter((s) => { const k = s.toLowerCase(); if (!s || seen[k]) return false; seen[k] = 1; return true; }).slice(0, 5);
  const zip = /^\d{5}$/.test(p.get("zip") || "") ? p.get("zip") : "";
  const dist = p.get("dist") === "any" ? null : int(p.get("dist"), 1, 1000) || 50;
  return {
    vehicles,
    ...years(p.get("yearMin"), p.get("yearMax")),
    priceMin: int(p.get("priceMin"), 0, 10000000), priceMax: int(p.get("priceMax"), 0, 10000000),
    milesMax: int(p.get("milesMax"), 0, 2000000), zip, dist,
    keywords: String(p.get("kw") || "").slice(0, 80),
    body: pick(p.get("body"), BODY_AUTODEV), drive: pick(p.get("drive"), DRIVE_AUTODEV),
    fuel: pick(p.get("fuel"), FUEL_AUTODEV), trans: pick(p.get("trans"), { automatic: 1, manual: 1 }),
    cyl: pick(p.get("cyl"), { 4: 1, 6: 1, 8: 1, 10: 1 }),
    engine: String(p.get("engine") || "").replace(/[^\w\s.-]/g, "").trim().slice(0, 30),
  };
}
function canonicalQuery(c) {
  return JSON.stringify([c.vehicles.map((v) => v.toLowerCase()).sort(), c.yearMin, c.yearMax, c.priceMin, c.priceMax, c.milesMax, c.zip, c.dist, c.keywords.toLowerCase(),
    c.body, c.drive, c.fuel, c.trans, c.cyl, c.engine.toLowerCase()]);
}
function pick(v, allowed) { v = String(v || "").toLowerCase(); return Object.prototype.hasOwnProperty.call(allowed, v) ? v : ""; }

/* ---------- vehicle filters ----------
   Auto.dev's labels, checked against its live data: pickups are "Truck" (sometimes "Pickup"), and most
   sedans, coupes, hatchbacks, wagons and convertibles are just "Car", so those include cars generally. */
const BODY_AUTODEV = { pickup: "Truck,Pickup", suv: "SUV", sedan: "Car,Sedan", coupe: "Car,Coupe", hatchback: "Car,Hatchback", wagon: "Car,Wagon", convertible: "Car,Convertible", van: "Van", minivan: "Minivan" };
const DRIVE_AUTODEV = { "4wd": "4WD", awd: "AWD", rwd: "RWD", fwd: "FWD" };
const FUEL_AUTODEV = { gas: "Gasoline,Flex-fuel", diesel: "Diesel", hybrid: "Hybrid,Plug-in Hybrid", electric: "Electric" };
const BODY_LABEL = { pickup: "pickup truck", suv: "SUV", sedan: "sedan", coupe: "coupe", hatchback: "hatchback", wagon: "wagon", convertible: "convertible", van: "van", minivan: "minivan" };
/* Turn a source's free-text value into this app's words, or "" when unknown. */
function driveWord(t) { t = String(t || "").toLowerCase(); return /4wd|4x4|four.?wheel/.test(t) ? "4wd" : /awd|all.?wheel/.test(t) ? "awd" : /rwd|rear/.test(t) ? "rwd" : /fwd|front/.test(t) ? "fwd" : ""; }
function fuelWord(t) { t = String(t || "").toLowerCase(); return /plug|hybrid/.test(t) ? "hybrid" : /electric|\bev\b/.test(t) ? "electric" : /diesel/.test(t) ? "diesel" : /gas|flex|unleaded|petrol/.test(t) ? "gas" : ""; }
function transWord(t) { t = String(t || "").toLowerCase(); return /manual|stick|\bmt\b/.test(t) ? "manual" : /auto|cvt|\bat\b|direct drive/.test(t) ? "automatic" : ""; }
function bodyWord(t) { t = String(t || "").toLowerCase();
  return /minivan/.test(t) ? "minivan" : /\bvan\b/.test(t) ? "van" : /pickup|truck|\bcab\b|crew|chassis/.test(t) ? "pickup" : /suv|sport utility|utility/.test(t) ? "suv" :
    /convertible|cabrio|roadster/.test(t) ? "convertible" : /wagon/.test(t) ? "wagon" : /hatch/.test(t) ? "hatchback" : /coupe/.test(t) ? "coupe" : /sedan/.test(t) ? "sedan" : /\bcar\b/.test(t) ? "car" : ""; }

/* ---------- makes ---------- */
const MULTI_MAKES = ["land rover", "alfa romeo", "aston martin", "mercedes benz", "rolls royce", "am general"];
const ALIASES = { chevy: "chevrolet", vw: "volkswagen", mercedes: "mercedes benz", "mercedes-benz": "mercedes benz", benz: "mercedes benz", landrover: "land rover" };
const PROPER = { "land rover": "Land Rover", "alfa romeo": "Alfa Romeo", "aston martin": "Aston Martin", "mercedes benz": "Mercedes-Benz", "rolls royce": "Rolls-Royce", "am general": "AM General", bmw: "BMW", gmc: "GMC", ram: "Ram", mini: "MINI", fiat: "FIAT" };
export function splitVehicle(v) {
  const s = String(v || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return { make: "", model: "" };
  if (/^range rover\b/.test(s)) return { make: "land rover", model: s };
  const flat = s.replace(/-/g, " ");
  for (const m of MULTI_MAKES) if (flat === m || flat.startsWith(m + " ")) return { make: m, model: s.slice(m.length).trim() };
  const [first, ...rest] = s.split(" ");
  return { make: ALIASES[first] || first, model: rest.join(" ") };
}
function properMake(m) { return PROPER[m] || m.replace(/\b\w/g, (x) => x.toUpperCase()); }

/* ---------- running the sources ---------- */
async function timed(name, fn) {
  const start = Date.now();
  try {
    const results = await fn();
    return { name, ok: true, count: results.length, ms: Date.now() - start, results };
  } catch (e) {
    return { name, ok: false, count: 0, ms: Date.now() - start, error: String((e && e.message) || e).slice(0, 200), results: [] };
  }
}
async function getJson(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, init || {}));
    const text = await r.text();
    if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 401 || r.status === 403 ? " (check the key)" : r.status === 429 ? " (free allowance used up)" : "") + ": " + text.slice(0, 120));
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

/* Looser versions of the search, used when the exact one finds few cars. Make, model and distance never loosen. */
export function looserSearches(c) {
  const out = [];
  if (c.yearMin || c.yearMax) {
    const lo = c.yearMin || c.yearMax, hi = c.yearMax || c.yearMin;
    // Nearby years only; the searched years were already covered.
    out.push(Object.assign({}, c, { yearMin: Math.max(1950, lo - 3), yearMax: Math.min(2035, hi + 3), skipYears: [lo, hi] }));
  }
  if (c.body || c.drive || c.fuel || c.trans || c.cyl || c.engine) out.push(Object.assign({}, c, { body: "", drive: "", fuel: "", trans: "", cyl: "", engine: "" }));
  if (c.priceMin || c.priceMax || c.milesMax) out.push(Object.assign({}, c, { priceMin: null, priceMax: null, milesMax: null }));
  return out;
}
const ENOUGH_EXACT = 10;

export async function searchAll(c, env) {
  const vehicles = c.vehicles.length ? c.vehicles : [""];
  const run = (crit, withEbay) => {
    const jobs = [];
    for (const v of vehicles) {
      const mm = splitVehicle(v);
      if (env.MARKETCHECK_KEY) {
        jobs.push(timed("MarketCheck", () => marketcheck(crit, mm, env, "dealer")));
        jobs.push(timed("MarketCheck private sellers", () => marketcheck(crit, mm, env, "private")));
      }
      if (env.AUTODEV_KEY) jobs.push(timed("Auto.dev", () => autodev(crit, mm, env)));
      if (withEbay && env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) jobs.push(timed("eBay Motors", () => ebay(crit, v, env)));
    }
    return Promise.all(jobs);
  };
  let done = await run(c, true);
  const exactSoFar = merge([].concat(...done.map((d) => d.results))).filter((l) => grade(l, c).exact).length;
  let widened = false;
  if (exactSoFar < ENOUGH_EXACT) {
    const extra = await Promise.all(looserSearches(c).map((crit) => run(crit, false)));
    for (const e of extra) done = done.concat(e);
    widened = extra.length > 0;
  }
  // One status line per source, adding up counts across vehicles and looser searches.
  const sources = [];
  for (const d of done) {
    const s = sources.find((x) => x.name === d.name);
    if (!s) sources.push({ name: d.name, ok: d.ok, count: d.count, error: d.error || "" });
    else { s.count += d.count; s.ok = s.ok && d.ok; if (d.error && !s.error) s.error = d.error; }
  }
  const results = merge([].concat(...done.map((d) => d.results))).map((l) => Object.assign(l, grade(l, c)));
  results.sort(byMatch);
  return { results, sources, enabled: enabledSources(env), widened, at: Date.now() };
}
/* Exact matches first, newest first; then the rest by fewest misses, nearest year, newest. */
export function byMatch(a, b) {
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  if (!a.exact && a.misses !== b.misses) return a.misses - b.misses;
  if (!a.exact && a.yearGap !== b.yearGap) return a.yearGap - b.yearGap;
  return (b.listedAt || 0) - (a.listedAt || 0);
}

/* Same VIN, or same link, is one car. The copy with the most photos and details wins,
   and the others are kept as alternative links. */
export function merge(list) {
  const out = [], byKey = new Map();
  for (const l of list) {
    if (!l || !l.url) continue;
    const keys = [l.vin ? "vin:" + l.vin : "", "url:" + l.url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase()].filter(Boolean);
    const hit = keys.map((k) => byKey.get(k)).find(Boolean);
    if (hit) {
      if (score(l) > score(hit)) { const also = hit.also.concat([{ source: hit.source, url: hit.url }]); Object.assign(hit, l, { also }); }
      else if (!hit.also.some((a) => a.url === l.url) && hit.url !== l.url) hit.also.push({ source: l.source, url: l.url });
      keys.forEach((k) => byKey.set(k, hit));
    } else {
      const row = Object.assign({ also: [] }, l);
      out.push(row);
      keys.forEach((k) => byKey.set(k, row));
    }
  }
  return out;
}
function score(l) { return (l.photo ? 4 : 0) + (l.price ? 2 : 0) + (l.miles != null ? 1 : 0) + (l.vin ? 1 : 0); }
/* Grades one listing against every filter that was set. Each check is ok: true (meets it), false (states
   a different value) or null (the listing doesn't say). A listing is exact when nothing is false. */
const LABEL = {
  body: { pickup: "Pickup", suv: "SUV", sedan: "Sedan", coupe: "Coupe", hatchback: "Hatchback", wagon: "Wagon", convertible: "Convertible", van: "Van", minivan: "Minivan" },
  drive: { "4wd": "4x4", awd: "AWD", rwd: "RWD", fwd: "FWD" }, fuel: { gas: "Gas", diesel: "Diesel", hybrid: "Hybrid", electric: "Electric" },
  trans: { automatic: "Automatic", manual: "Manual" },
};
const money = (n) => "$" + Number(n).toLocaleString("en-US");
export function grade(l, c) {
  const checks = [];
  const add = (key, label, ok, has) => checks.push({ key, label, ok: has ? ok : null });
  if (c.yearMin || c.yearMax) {
    const lo = c.yearMin || 1950, hi = c.yearMax || 2035;
    const label = c.yearMin && c.yearMax ? (lo === hi ? String(lo) : lo + "–" + hi) : c.yearMin ? lo + " or newer" : hi + " or older";
    add("year", label, l.year >= lo && l.year <= hi, !!l.year);
  }
  if (c.engine) {
    const hay = (l.engine + " " + l.title).toLowerCase(), want = c.engine.toLowerCase();
    add("engine", /^\d(\.\d)?$/.test(c.engine) ? c.engine + "L" : c.engine, hay.includes(want), !!l.engine || hay.includes(want));
  }
  if (c.drive) add("drive", LABEL.drive[c.drive], l.drive === c.drive, !!l.drive);
  if (c.cyl) add("cyl", c.cyl + " cyl", l.cyl === Number(c.cyl), !!l.cyl);
  if (c.body) add("body", LABEL.body[c.body], l.body === c.body || (l.body === "car" && ["sedan", "coupe", "hatchback", "wagon", "convertible"].includes(c.body)), !!l.body);
  if (c.fuel) add("fuel", LABEL.fuel[c.fuel], l.fuel === c.fuel, !!l.fuel);
  if (c.trans) add("trans", LABEL.trans[c.trans], l.trans === c.trans, !!l.trans);
  if (c.priceMin || c.priceMax) {
    const label = c.priceMin && c.priceMax ? money(c.priceMin) + "–" + money(c.priceMax) : c.priceMax ? "Under " + money(c.priceMax) : "Over " + money(c.priceMin);
    add("price", label, (!c.priceMin || l.price >= c.priceMin) && (!c.priceMax || l.price <= c.priceMax), !!l.price);
  }
  if (c.milesMax) add("miles", "Under " + Number(c.milesMax).toLocaleString("en-US") + " mi", l.miles <= c.milesMax, l.miles != null);
  const misses = checks.filter((x) => x.ok === false).length;
  const lo = c.yearMin || c.yearMax, hi = c.yearMax || c.yearMin;
  const yearGap = l.year && lo ? (l.year < lo ? lo - l.year : l.year > hi ? l.year - hi : 0) : 0;
  return { checks, exact: misses === 0, misses, yearGap };
}
/* Kept for callers that only need yes or no. */
export function fits(l, c) { return grade(l, c).exact; }

/* ---------- normalizing ---------- */
function num(v) { if (v == null || v === "") return null; const n = Number(String(v).replace(/[^\d.]/g, "")); return isFinite(n) && n > 0 ? n : (n === 0 ? 0 : null); }
function httpUrl(u) { try { const x = new URL(String(u)); return x.protocol === "https:" || x.protocol === "http:" ? x.href : ""; } catch (e) { return ""; } }
function time(v) { const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v || ""); return isFinite(t) ? t : null; }
function cleanVin(v) { const s = String(v || "").toUpperCase(); return /^[A-HJ-NPR-Z0-9]{17}$/.test(s) ? s : ""; }
function listing(o) {
  return {
    source: o.source, sellerType: o.sellerType || "",
    title: String(o.title || [o.year, o.make, o.model, o.trim].filter(Boolean).join(" ") || "Listing").slice(0, 140),
    year: num(o.year), make: o.make || "", model: o.model || "",
    price: num(o.price), miles: o.miles == null ? null : num(o.miles),
    vin: cleanVin(o.vin), url: httpUrl(o.url), photo: httpUrl(o.photo), photoCount: num(o.photoCount) || (o.photo ? 1 : 0),
    location: [o.city, o.state].filter(Boolean).join(", "), distance: num(o.distance),
    seller: String(o.seller || "").slice(0, 80), listedAt: time(o.listedAt),
    body: bodyWord(o.body), drive: driveWord(o.drive), fuel: fuelWord(o.fuel), trans: transWord(o.trans),
    cyl: num(o.cyl) || null, engine: String(o.engine || "").slice(0, 60),
  };
}

/* ---------- MarketCheck ----------
   Dealer search: GET /v2/search/car/active. Private sellers: GET /v2/search/car/fsbo/active.
   Free plan: 500 calls a month, searches within 100 miles. */
async function marketcheck(c, mm, env, kind) {
  const p = new URLSearchParams({ api_key: env.MARKETCHECK_KEY, rows: String(MAX_PER_SOURCE), sort_by: "dom", sort_order: "asc" });
  if (mm.make) p.set("make", properMake(mm.make).toLowerCase());
  if (mm.model) p.set("model", mm.model);
  if (kind === "dealer") p.set("car_type", "used");
  if (c.yearMin || c.yearMax) p.set("year_range", (c.yearMin || 1950) + "-" + (c.yearMax || 2035));
  if (c.priceMin || c.priceMax) p.set("price_range", (c.priceMin || 0) + "-" + (c.priceMax || 10000000));
  if (c.milesMax) p.set("miles_range", "0-" + c.milesMax);
  // "Anywhere in the US" sends no ZIP. The free plan caps the radius at 100 miles.
  if (c.zip && c.dist) { p.set("zip", c.zip); p.set("radius", String(Math.min(c.dist, 100))); }
  const path = kind === "private" ? "/v2/search/car/fsbo/active" : "/v2/search/car/active";
  const j = await getJson("https://api.marketcheck.com" + path + "?" + p.toString());
  return (j.listings || []).map((x) => {
    const b = x.build || {}, d = x.dealer || x.seller || {}, m = x.media || {};
    const photos = m.photo_links || m.photo_links_cached || x.photo_links || [];
    return listing({
      source: kind === "private" ? "MarketCheck (private seller)" : "MarketCheck", sellerType: kind === "private" ? "private" : "dealer",
      title: x.heading, year: b.year || x.year, make: b.make || x.make, model: b.model || x.model, trim: b.trim || x.trim,
      price: x.price, miles: x.miles, vin: x.vin, url: x.vdp_url || x.source_url || x.url, photo: photos[0], photoCount: photos.length,
      city: d.city || x.city, state: d.state || x.state, distance: x.dist, seller: d.name || x.seller_name,
      listedAt: x.first_seen_at || x.first_seen_at_date || x.scraped_at,
      body: b.body_type, drive: b.drivetrain, fuel: b.fuel_type, trans: b.transmission, cyl: b.cylinders, engine: b.engine,
    });
  });
}

/* ---------- Auto.dev ----------
   GET https://api.auto.dev/listings with "Authorization: Bearer <key>". Ranges are written min-max.
   Free plan: 1,000 calls a month. */
async function autodev(c, mm, env) {
  const p = new URLSearchParams({ limit: String(MAX_PER_SOURCE) }); // the free plan returns at most 20
  if (mm.make) p.set("vehicle.make", properMake(mm.make));
  if (mm.model) p.set("vehicle.model", modelSpellings(mm.model));
  if (c.skipYears) {
    const ys = [];
    for (let y = c.yearMin; y <= c.yearMax; y++) if (y < c.skipYears[0] || y > c.skipYears[1]) ys.push(y);
    p.set("vehicle.year", ys.join(","));
  } else if (c.yearMin || c.yearMax) p.set("vehicle.year", (c.yearMin || 1950) + "-" + (c.yearMax || 2035));
  // An engine size like "5.3" becomes "5.3L*", which Auto.dev matches against "5.3L 8Cyl ...". Names are checked afterwards.
  const size = String(c.engine || "").match(/^(\d{1,2}\.\d)\s*l?$/i);
  if (size) p.set("vehicle.engine", size[1] + "L*");
  if (c.priceMin || c.priceMax) p.set("retailListing.price", (c.priceMin || 1) + "-" + (c.priceMax || 10000000));
  if (c.milesMax) p.set("retailListing.miles", "0-" + c.milesMax);
  if (c.body) p.set("vehicle.bodyStyle", BODY_AUTODEV[c.body]);
  if (c.drive) p.set("vehicle.drivetrain", DRIVE_AUTODEV[c.drive]);
  if (c.fuel) p.set("vehicle.fuel", FUEL_AUTODEV[c.fuel]);
  if (c.trans) p.set("vehicle.transmission", c.trans === "manual" ? "Manual" : "Automatic");
  if (c.cyl) p.set("vehicle.cylinders", c.cyl);
  // Auto.dev reads a ZIP without a distance as "this ZIP only", so "Anywhere in the US" sends neither.
  if (c.zip && c.dist) { p.set("zip", c.zip); p.set("distance", String(c.dist)); }
  const j = await getJson("https://api.auto.dev/listings?" + p.toString(), { headers: { Authorization: "Bearer " + env.AUTODEV_KEY } });
  const rows = Array.isArray(j) ? j : j.data || j.records || j.listings || [];
  return rows.map((x) => {
    const v = x.vehicle || {}, r = x.retailListing || x.listing || {};
    return listing({
      source: "Auto.dev", sellerType: "dealer",
      year: v.year || x.year, make: v.make || x.make, model: v.model || x.model, trim: v.trim || x.trim,
      price: r.price || x.price || x.priceUnformatted, miles: r.miles != null ? r.miles : x.mileage || x.mileageUnformatted,
      vin: x.vin || v.vin, url: r.vdp || r.vdpUrl || x.vdpUrl || x.clickoffUrl, photo: r.primaryImage || x.primaryPhotoUrl || (x.photoUrls || [])[0],
      photoCount: r.photoCount || (x.photoUrls || []).length, city: r.city || x.city, state: r.state || x.state,
      distance: x.distanceFromOrigin || x.distance, seller: r.dealer || x.dealerName, listedAt: x.createdAt || x.created_at,
      body: v.bodyStyle, drive: v.drivetrain, fuel: v.fuel, trans: v.transmission, cyl: v.cylinders, engine: v.engine,
    });
  });
}

/* ---------- eBay Motors ----------
   An app token from client credentials, then Browse API item_summary/search in Cars & Trucks (category 6001).
   The token lasts about two hours, so it is kept in memory between searches. */
let ebayToken = { value: "", until: 0 };
async function ebayAuth(env) {
  if (ebayToken.value && Date.now() < ebayToken.until) return ebayToken.value;
  const j = await getJson("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(env.EBAY_CLIENT_ID + ":" + env.EBAY_CLIENT_SECRET) },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  ebayToken = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in || 7200) - 300) * 1000 };
  return ebayToken.value;
}
async function ebay(c, vehicle, env) {
  const token = await ebayAuth(env);
  const q = [vehicle || BODY_LABEL[c.body] || "", c.drive === "4wd" ? "4x4" : "", c.fuel === "diesel" ? "diesel" : "", c.engine, c.keywords].filter(Boolean).join(" ");
  const p = new URLSearchParams({ q, category_ids: "6001", limit: String(MAX_PER_SOURCE), sort: "newlyListed" });
  const f = ["buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION}", "deliveryCountry:US"];
  if (c.priceMin || c.priceMax) f.push("price:[" + (c.priceMin || 0) + ".." + (c.priceMax || "") + "]", "priceCurrency:USD");
  if (c.zip && c.dist) f.push("pickupCountry:US", "pickupPostalCode:" + c.zip, "pickupRadius:" + c.dist, "pickupRadiusUnit:mi");
  p.set("filter", f.join(","));
  const headers = { Authorization: "Bearer " + token, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" };
  if (c.zip) headers["X-EBAY-C-ENDUSERCTX"] = "contextualLocation=" + encodeURIComponent("country=US,zip=" + c.zip);
  const j = await getJson("https://api.ebay.com/buy/browse/v1/item_summary/search?" + p.toString(), { headers });
  return (j.itemSummaries || []).map((x) => {
    const yr = String(x.title || "").match(/\b(19[5-9]\d|20[0-3]\d)\b/);
    const loc = x.itemLocation || {};
    return listing({
      source: "eBay Motors", sellerType: "",
      title: x.title, year: yr ? yr[1] : null, price: x.price && x.price.value, miles: null,
      url: x.itemWebUrl, photo: (x.image && x.image.imageUrl) || (x.thumbnailImages && x.thumbnailImages[0] && x.thumbnailImages[0].imageUrl),
      photoCount: 1 + (x.additionalImages || []).length, city: loc.city, state: loc.stateOrProvince,
      seller: x.seller && x.seller.username, listedAt: x.itemCreationDate,
    });
  });
}
