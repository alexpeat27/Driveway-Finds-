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

const MAX_PER_SOURCE = 50;
const CACHE_SECONDS = 900; // repeat searches within 15 minutes reuse the last answer and spend no quota
const TIMEOUT_MS = 12000;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, sources: enabledSources(env) }, 200, cors);
    }
    if (url.pathname !== "/search" || request.method !== "GET") return json({ error: "not_found" }, 404, cors);
    if (!originAllowed(origin, env)) return json({ error: "origin_not_allowed" }, 403, cors);
    if (!env.ACCESS_CODE) return json({ error: "access_code_not_set", message: "Add an ACCESS_CODE secret to the Worker." }, 503, cors);
    if (!sameSecret(request.headers.get("X-Access-Code") || "", env.ACCESS_CODE)) return json({ error: "wrong_access_code" }, 401, cors);

    const c = readCriteria(url.searchParams);
    if (!c.vehicles.length) return json({ error: "no_vehicle", message: "Enter at least one make or model." }, 400, cors);

    const cacheKey = new Request("https://cache.driveway-finds/search?" + canonicalQuery(c));
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
export function readCriteria(p) {
  const seen = {};
  const vehicles = String(p.get("vehicles") || "").split(/[,;\n]+/).map((s) => s.replace(/[^\w\s.-]/g, "").replace(/\s+/g, " ").trim())
    .filter((s) => { const k = s.toLowerCase(); if (!s || seen[k]) return false; seen[k] = 1; return true; }).slice(0, 5);
  const zip = /^\d{5}$/.test(p.get("zip") || "") ? p.get("zip") : "";
  const dist = p.get("dist") === "any" ? null : int(p.get("dist"), 1, 1000) || 50;
  return {
    vehicles,
    yearMin: int(p.get("yearMin"), 1950, 2035), yearMax: int(p.get("yearMax"), 1950, 2035),
    priceMin: int(p.get("priceMin"), 0, 10000000), priceMax: int(p.get("priceMax"), 0, 10000000),
    milesMax: int(p.get("milesMax"), 0, 2000000), zip, dist,
    keywords: String(p.get("kw") || "").slice(0, 80),
  };
}
function canonicalQuery(c) {
  return JSON.stringify([c.vehicles.map((v) => v.toLowerCase()).sort(), c.yearMin, c.yearMax, c.priceMin, c.priceMax, c.milesMax, c.zip, c.dist, c.keywords.toLowerCase()]);
}

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

export async function searchAll(c, env) {
  const jobs = [];
  for (const v of c.vehicles) {
    const mm = splitVehicle(v);
    if (env.MARKETCHECK_KEY) {
      jobs.push(timed("MarketCheck", () => marketcheck(c, mm, env, "dealer")));
      jobs.push(timed("MarketCheck private sellers", () => marketcheck(c, mm, env, "private")));
    }
    if (env.AUTODEV_KEY) jobs.push(timed("Auto.dev", () => autodev(c, mm, env)));
    if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) jobs.push(timed("eBay Motors", () => ebay(c, v, env)));
  }
  const done = await Promise.all(jobs);
  // One status line per source, adding up counts across vehicles.
  const sources = [];
  for (const d of done) {
    const s = sources.find((x) => x.name === d.name);
    if (!s) sources.push({ name: d.name, ok: d.ok, count: d.count, error: d.error || "" });
    else { s.count += d.count; s.ok = s.ok && d.ok; if (d.error && !s.error) s.error = d.error; }
  }
  const all = [].concat(...done.map((d) => d.results));
  const results = merge(all).filter((l) => fits(l, c));
  results.sort((a, b) => (b.listedAt || 0) - (a.listedAt || 0));
  return { results, sources, enabled: enabledSources(env), at: Date.now() };
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
/* Services sometimes ignore a filter, so check again here. Missing values are kept. */
export function fits(l, c) {
  if (c.yearMin && l.year && l.year < c.yearMin) return false;
  if (c.yearMax && l.year && l.year > c.yearMax) return false;
  if (c.priceMax && l.price && l.price > c.priceMax) return false;
  if (c.priceMin && l.price && l.price < c.priceMin) return false;
  if (c.milesMax && l.miles != null && l.miles > c.milesMax) return false;
  return true;
}

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
  if (c.zip) { p.set("zip", c.zip); p.set("radius", String(Math.min(c.dist || 100, 100))); }
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
    });
  });
}

/* ---------- Auto.dev ----------
   GET https://api.auto.dev/listings with "Authorization: Bearer <key>". Ranges are written min-max.
   Free plan: 1,000 calls a month. */
async function autodev(c, mm, env) {
  const p = new URLSearchParams({ limit: String(MAX_PER_SOURCE) });
  if (mm.make) p.set("vehicle.make", properMake(mm.make));
  if (mm.model) p.set("vehicle.model", mm.model);
  if (c.yearMin || c.yearMax) p.set("vehicle.year", (c.yearMin || 1950) + "-" + (c.yearMax || 2035));
  if (c.priceMin || c.priceMax) p.set("retailListing.price", (c.priceMin || 1) + "-" + (c.priceMax || 10000000));
  if (c.milesMax) p.set("retailListing.miles", "0-" + c.milesMax);
  if (c.zip) { p.set("zip", c.zip); if (c.dist) p.set("distance", String(c.dist)); }
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
  const q = [vehicle, c.keywords].filter(Boolean).join(" ");
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
