"use strict";
/* Tests the search Worker with MarketCheck, Auto.dev and eBay mocked. No network. */
const test = require("node:test");
const assert = require("node:assert/strict");

const ENV = { ACCESS_CODE: "open sesame", MARKETCHECK_KEY: "mk", AUTODEV_KEY: "ak", EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "sec" };
let W;
const calls = [];
const realFetch = global.fetch;

function reply(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: { "Content-Type": "application/json" } }); }
function mock(overrides) {
  calls.length = 0;
  global.fetch = async (url, init) => {
    url = String(url);
    calls.push({ url, init });
    for (const [k, v] of Object.entries(overrides || {})) if (url.includes(k)) return v(url, init);
    if (url.includes("/fsbo/active")) return reply({ num_found: 1, listings: [
      { id: "p1", vin: "", heading: "2014 Toyota Tacoma by owner", price: 15500, miles: 99000, vdp_url: "https://seller.example/p1",
        media: { photo_links: ["https://img.example/p1.jpg"] }, build: { year: 2014, make: "Toyota", model: "Tacoma" }, city: "Butler", state: "PA" },
    ] });
    if (url.includes("api.marketcheck.com")) return reply({ num_found: 2, listings: [
      { id: "m1", vin: "1M8GDM9AXKP042788", heading: "2015 Toyota Tacoma TRD", price: 21000, miles: 80000, vdp_url: "https://dealer.example/a",
        media: { photo_links: ["https://img.example/a1.jpg", "https://img.example/a2.jpg"] }, build: { year: 2015, make: "Toyota", model: "Tacoma", trim: "TRD" },
        dealer: { name: "Steel City Motors", city: "Pittsburgh", state: "PA" }, dist: 4.2, first_seen_at: 1763300000 },
      { id: "m2", vin: "", heading: "2020 Toyota Tacoma", price: 30000, miles: 20000, vdp_url: "https://dealer.example/too-new", build: { year: 2020 } },
    ] });
    if (url.includes("api.auto.dev")) return reply({ data: [
      { vin: "1M8GDM9AXKP042788", createdAt: "2026-11-15T10:00:00Z", vehicle: { year: 2015, make: "Toyota", model: "Tacoma" },
        retailListing: { price: 21000, miles: 80000, vdp: "https://dealer.example/a?ref=autodev", city: "Pittsburgh", state: "PA", dealer: "Steel City Motors" } },
      { vin: "5TFJX4GN0FX040123", createdAt: "2026-11-16T10:00:00Z", vehicle: { year: 2016, make: "Toyota", model: "Tacoma", trim: "SR5" },
        retailListing: { price: 19995, miles: 64000, vdp: "https://other.example/b", primaryImage: "https://img.example/b.jpg", photoCount: 30, city: "Wexford", state: "PA" } },
    ] });
    if (url.includes("/oauth2/token")) return reply({ access_token: "tok", expires_in: 7200 });
    if (url.includes("item_summary/search")) return reply({ itemSummaries: [
      { itemId: "e1", title: "2013 Toyota Tacoma Double Cab 4x4", price: { value: "17250.00", currency: "USD" }, image: { imageUrl: "https://i.ebayimg.com/e1.jpg" },
        itemWebUrl: "https://www.ebay.com/itm/e1", itemLocation: { city: "Erie", stateOrProvince: "PA" }, seller: { username: "trucks4u" }, itemCreationDate: "2026-11-14T00:00:00Z" },
    ] });
    return reply({ error: "unexpected " + url }, 500);
  };
}
function req(qs, headers) {
  return new Request("https://w.example/search?" + qs, { headers: Object.assign({ "X-Access-Code": "open sesame", Origin: "https://me.github.io" }, headers || {}) });
}

test.before(async () => { W = (await import("../worker/src/index.js")); });
test.after(() => { global.fetch = realFetch; });

test("refuses without the right access code, or with none configured", async () => {
  mock();
  let r = await W.default.fetch(req("vehicles=Toyota+Tacoma", { "X-Access-Code": "nope" }), ENV);
  assert.equal(r.status, 401);
  r = await W.default.fetch(req("vehicles=Toyota+Tacoma"), Object.assign({}, ENV, { ACCESS_CODE: "" }));
  assert.equal(r.status, 503);
  assert.equal(calls.length, 0, "no service is called when refused");
});

test("only listed page addresses may call it when ALLOWED_ORIGINS is set", async () => {
  mock();
  const env = Object.assign({}, ENV, { ALLOWED_ORIGINS: "https://me.github.io/" });
  let r = await W.default.fetch(req("vehicles=Toyota", { Origin: "https://evil.example" }), env);
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
  r = await W.default.fetch(req("vehicles=Toyota"), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://me.github.io");
  const pre = await W.default.fetch(new Request("https://w.example/search", { method: "OPTIONS", headers: { Origin: "https://me.github.io" } }), env);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Headers"), /X-Access-Code/);
});

test("searches every source, merges the same car, drops out-of-range results", async () => {
  mock();
  const r = await W.default.fetch(req("vehicles=Toyota+Tacoma&yearMin=2012&yearMax=2019&priceMax=22000&milesMax=100000&zip=15222&dist=50"), ENV);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.sources.map((s) => [s.name, s.ok, s.count]), [
    ["MarketCheck", true, 2], ["MarketCheck private sellers", true, 1], ["Auto.dev", true, 2], ["eBay Motors", true, 1],
  ]);
  // 6 raw results: the 2020 truck is out of range and the VIN 1M8... appears twice, so 4 remain.
  assert.equal(body.results.length, 4);
  const dup = body.results.find((x) => x.vin === "1M8GDM9AXKP042788");
  assert.equal(dup.source, "MarketCheck", "the copy with photos wins");
  assert.equal(dup.photo, "https://img.example/a1.jpg");
  assert.deepEqual(dup.also.map((a) => a.source), ["Auto.dev"]);
  const priv = body.results.find((x) => x.sellerType === "private");
  assert.equal(priv.location, "Butler, PA");
  const eb = body.results.find((x) => x.source === "eBay Motors");
  assert.equal(eb.price, 17250);
  assert.equal(eb.year, 2013);
  assert.equal(eb.photo, "https://i.ebayimg.com/e1.jpg");
  for (const x of body.results) assert.match(x.url, /^https:\/\//);

  // What was sent to each service.
  const mc = new URL(calls.find((c) => c.url.includes("/search/car/active")).url).searchParams;
  assert.equal(mc.get("make"), "toyota");
  assert.equal(mc.get("model"), "tacoma");
  assert.equal(mc.get("year_range"), "2012-2019");
  assert.equal(mc.get("price_range"), "0-22000");
  assert.equal(mc.get("miles_range"), "0-100000");
  assert.equal(mc.get("radius"), "50");
  const ad = calls.find((c) => c.url.includes("api.auto.dev"));
  assert.equal(ad.init.headers.Authorization, "Bearer ak");
  assert.equal(new URL(ad.url).searchParams.get("vehicle.make"), "Toyota");
  assert.equal(new URL(ad.url).searchParams.get("retailListing.price"), "1-22000");
  const eu = calls.find((c) => c.url.includes("item_summary/search"));
  assert.equal(new URL(eu.url).searchParams.get("category_ids"), "6001");
  assert.match(new URL(eu.url).searchParams.get("filter"), /price:\[0\.\.22000\]/);
});

test("MarketCheck's free plan radius cap is respected", async () => {
  mock();
  await W.default.fetch(req("vehicles=Ford&zip=15222&dist=500"), ENV);
  assert.equal(new URL(calls.find((c) => c.url.includes("/search/car/active")).url).searchParams.get("radius"), "100");
});

test("one failing source does not sink the others, and says why", async () => {
  mock({ "api.auto.dev": () => reply({ error: "quota" }, 429) });
  const body = await (await W.default.fetch(req("vehicles=Toyota+Tacoma"), ENV)).json();
  const ad = body.sources.find((s) => s.name === "Auto.dev");
  assert.equal(ad.ok, false);
  assert.match(ad.error, /free allowance used up/);
  assert.ok(body.results.length >= 2);
});

test("only sources with keys are used", async () => {
  mock();
  const body = await (await W.default.fetch(req("vehicles=Toyota"), { ACCESS_CODE: "open sesame", AUTODEV_KEY: "ak" })).json();
  assert.deepEqual(body.sources.map((s) => s.name), ["Auto.dev"]);
  assert.ok(calls.every((c) => c.url.includes("api.auto.dev")));
});

test("several vehicles are searched separately, at most five", async () => {
  mock();
  const c = W.readCriteria(new URLSearchParams("vehicles=Land Rover Defender, Ford F-150, a,b,c,d,e"));
  assert.equal(c.vehicles.length, 5);
  assert.deepEqual(W.splitVehicle("Land Rover Defender"), { make: "land rover", model: "defender" });
  await W.default.fetch(req("vehicles=" + encodeURIComponent("Land Rover Defender, Ford F-150")), { ACCESS_CODE: "open sesame", MARKETCHECK_KEY: "mk" });
  const makes = calls.filter((x) => x.url.includes("/search/car/active")).map((x) => new URL(x.url).searchParams.get("make"));
  assert.deepEqual(makes.sort(), ["ford", "land rover"]);
});

test("Anywhere in the US sends no ZIP, so services search nationwide", async () => {
  mock();
  await W.default.fetch(req("vehicles=Toyota+Tacoma&zip=15222&dist=any"), ENV);
  for (const host of ["api.auto.dev", "/search/car/active"]) {
    const p = new URL(calls.find((c) => c.url.includes(host)).url).searchParams;
    assert.equal(p.get("zip"), null, host + " got a ZIP");
  }
  mock();
  await W.default.fetch(req("vehicles=Toyota+Tacoma&zip=15222&dist=250"), ENV);
  const ad = new URL(calls.find((c) => c.url.includes("api.auto.dev")).url).searchParams;
  assert.equal(ad.get("zip"), "15222");
  assert.equal(ad.get("distance"), "250");
});

test("no vehicle is a clear error", async () => {
  mock();
  const r = await W.default.fetch(req("vehicles="), ENV);
  assert.equal(r.status, 400);
});

test("health check lists the sources that have keys, without revealing them", async () => {
  const r = await W.default.fetch(new Request("https://w.example/"), { ACCESS_CODE: "x", MARKETCHECK_KEY: "secret-value" });
  const text = await r.text();
  assert.match(text, /MarketCheck/);
  assert.doesNotMatch(text, /secret-value/);
});
