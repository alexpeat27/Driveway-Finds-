"use strict";
/* Drives the real page in Chromium. NHTSA is mocked so the test needs no network. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { /* not installed */ }
const PAGE = "file://" + path.resolve(__dirname, "..", "index.html");

test("page works end to end", { skip: !chromium && "playwright is not installed" }, async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.route("https://vpic.nhtsa.dot.gov/**", (r) => r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ Results: [{ ModelYear: "2015", Make: "TOYOTA", Model: "Tacoma", Trim: "TRD", DisplacementL: "4.0", EngineCylinders: "6", DriveType: "4WD", FuelTypePrimary: "Gasoline", BodyClass: "Pickup", ErrorCode: "0" }] }) }));
  await page.route("https://api.nhtsa.gov/**", (r) => r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ Count: 1, results: [{ NHTSACampaignNumber: "15V000", Component: "AIR BAGS" }] }) }));
  try {
    await page.goto(PAGE);

    // Launch panel: buttons for every site, and the skipped-filter note.
    await page.fill("#vehicles", "Land Rover Defender");
    await page.selectOption("#cyl", "5");
    const at = await page.getAttribute("#at-links a", "href");
    assert.match(at, /make=landrover&model=defender/);
    assert.equal(await page.locator("#more-links a").count(), 2);
    assert.match(await page.textContent("#skipped"), /Facebook: .*cylinders/);

    // The form survives a reload.
    await page.reload();
    assert.equal(await page.inputValue("#vehicles"), "Land Rover Defender");

    // Flagging the same search twice keeps one.
    await page.click("#flag");
    await page.click("#flag");
    assert.equal(await page.textContent("#n-watch"), "1");
    assert.match(await page.textContent("#toast"), /already on the Watchlist/);

    // Add a listing with a VIN lookup.
    await page.goto(PAGE + "#finds");
    await page.fill("#a-url", "https://www.cars.com/vehicledetail/abc/?utm_source=x");
    await page.fill("#a-vin", "1M8GDM9AXKP042788");
    await page.click("#a-vin-go");
    await page.waitForFunction(() => /Tacoma/.test(document.getElementById("a-vin-out").textContent));
    assert.equal(await page.inputValue("#a-title"), "2015 Toyota Tacoma TRD");
    await page.fill("#a-price", "20000");
    await page.fill("#a-miles", "80000");
    await page.click("#add button[type=submit]");
    const card = page.locator("#find-list .item").first();
    assert.match(await card.textContent(), /1 recall for this model/);
    assert.match(await card.textContent(), /VIN 1M8GDM9AXKP042788/);

    // The same link again is refused.
    await page.fill("#a-url", "https://cars.com/vehicledetail/abc");
    assert.match(await page.textContent("#a-site"), /Already in Finds/);
    await page.click("#add button[type=submit]");
    assert.equal(await page.locator("#find-list .item").count(), 1);

    // Edit the price and stage; the drop shows.
    await card.getByRole("button", { name: "Edit" }).click();
    await card.locator(".edit input[type=number]").first().fill("18500");
    await card.locator(".edit select").first().selectOption("contacted");
    await card.getByRole("button", { name: "Save changes" }).click();
    const text = await page.locator("#find-list .item").first().textContent();
    assert.match(text, /Down \$1,500/);
    assert.match(text, /Contacted seller/);
    assert.match(text, /Price history: \$20,000 .* → \$18,500/);

    // Backup, wipe, restore.
    await page.goto(PAGE + "#watchlist");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export")]);
    const file = path.join(os.tmpdir(), "df-backup-test.json");
    await dl.saveAs(file);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.finds.length, 1);
    assert.equal(saved.searches.length, 1);
    await page.evaluate(() => localStorage.removeItem("driveway-finds-v1"));
    await page.reload();
    assert.equal(await page.textContent("#n-finds"), "0");
    await page.setInputFiles("#import", file);
    await page.waitForFunction(() => document.getElementById("n-finds").textContent === "1");
    assert.equal(await page.textContent("#n-watch"), "1");
    await page.setInputFiles("#import", file);
    await page.waitForFunction(() => /Nothing new/.test(document.getElementById("toast").textContent));

    // Removing a search needs a second click and keeps its finds.
    const rm = page.locator("#watch-list").getByRole("button", { name: "Remove" });
    await rm.click();
    assert.equal(await page.textContent("#n-watch"), "1");
    await page.locator("#watch-list .btn.armed").click();
    await page.waitForFunction(() => document.getElementById("n-watch").textContent === "0");
    assert.equal(await page.textContent("#n-finds"), "1");

    // Hide then delete needs a second click too.
    await page.goto(PAGE + "#finds");
    await page.getByRole("button", { name: "Hide, never show again" }).click();
    await page.click("[data-show=hidden]");
    const del = page.getByRole("button", { name: "Delete for good" });
    await del.click();
    assert.equal(await page.locator("#find-list .item").count(), 1);
    await page.locator("#find-list .btn.armed").click();
    assert.equal(await page.locator("#find-list .item").count(), 0);

    // Phone width: no sideways scroll.
    await page.setViewportSize({ width: 375, height: 800 });
    for (const tab of ["search", "watchlist", "finds"]) {
      await page.goto(PAGE + "#" + tab);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, tab + " scrolls sideways by " + over + "px");
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("Search everything shows merged results with photos and saves to Finds", { skip: !chromium && "playwright is not installed" }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const seen = [];
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.route("https://img.example/**", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
  await page.route("https://w.example/**", (r) => {
    const req = r.request();
    seen.push({ url: req.url(), code: req.headers()["x-access-code"] });
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "X-Access-Code" };
    if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors });
    if (req.headers()["x-access-code"] !== "open sesame") return r.fulfill({ status: 401, headers: cors, contentType: "application/json", body: '{"error":"wrong_access_code"}' });
    return r.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({
      enabled: ["MarketCheck", "Auto.dev"], cached: false, at: Date.now(),
      sources: [{ name: "MarketCheck", ok: true, count: 2 }, { name: "Auto.dev", ok: false, count: 0, error: "HTTP 429 (free allowance used up)" }],
      results: [
        { source: "MarketCheck", title: "2015 Toyota Tacoma TRD", year: 2015, price: 21000, miles: 80000, vin: "1M8GDM9AXKP042788", url: "https://dealer.example/a", photo: "https://img.example/a.png", location: "Pittsburgh, PA", listedAt: Date.now() - 1000, also: [{ source: "Auto.dev", url: "https://dealer.example/a2" }] },
        { source: "MarketCheck (private seller)", sellerType: "private", title: "2014 Toyota Tacoma", year: 2014, price: 15500, miles: 99000, url: "https://seller.example/p1", photo: "", location: "Butler, PA", listedAt: Date.now() - 5e8, also: [] },
      ] }) });
  });
  try {
    await page.goto(PAGE);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    // Without setup it sends you to the setup box.
    await page.click("#search-all");
    await page.waitForFunction(() => location.hash === "#watchlist");
    await page.fill("#workerUrl", "http://w.example");
    await page.dispatchEvent("#workerUrl", "change");
    assert.match(await page.textContent("#toast"), /https:\/\//);
    await page.fill("#workerUrl", "https://w.example/");
    await page.dispatchEvent("#workerUrl", "change");
    await page.fill("#accessCode", "wrong");
    await page.dispatchEvent("#accessCode", "change");
    await page.click("#test-worker");
    await page.waitForFunction(() => /doesn't match/.test(document.getElementById("worker-out").textContent));
    await page.fill("#accessCode", "open sesame");
    await page.dispatchEvent("#accessCode", "change");
    await page.click("#test-worker");
    await page.waitForFunction(() => /Connected\. Sources with keys: MarketCheck, Auto\.dev/.test(document.getElementById("worker-out").textContent));

    // Run it.
    await page.goto(PAGE + "#search");
    await page.click("#search-all");
    await page.waitForFunction(() => document.querySelectorAll("#r-list .rc").length === 2);
    const q = new URL(seen[seen.length - 1].url).searchParams;
    assert.equal(q.get("vehicles"), "Toyota Tacoma");
    assert.equal(q.get("priceMax"), "22000");
    assert.match(await page.textContent("#r-head"), /2 results for Toyota Tacoma/);
    assert.match(await page.textContent("#r-status"), /Auto\.dev: failed/);
    assert.match(await page.textContent("#r-status"), /free allowance used up/);
    const first = page.locator("#r-list .rc").first();
    assert.equal(await first.locator("img").count(), 1);
    assert.equal(await first.getByRole("link", { name: "Also on Auto.dev" }).count(), 1);
    assert.match(await page.locator("#r-list .rc").nth(1).textContent(), /No photo/);
    await page.selectOption("#r-sort", "price");
    assert.match(await page.locator("#r-list .rc").first().textContent(), /\$15,500/);

    // Save one to Finds, and it keeps its photo.
    await page.locator("#r-list .rc").first().getByRole("button", { name: "Save to Finds" }).click();
    await page.waitForFunction(() => document.getElementById("n-finds").textContent === "1");
    assert.ok(await page.locator("#r-list .rc").first().getByRole("button", { name: "In Finds" }).isDisabled());
    await page.goto(PAGE + "#finds");
    assert.match(await page.locator("#find-list .item").first().textContent(), /Private seller/);
    assert.match(await page.locator("#find-list .item").first().textContent(), /MarketCheck \(private seller\)/);

    // Phone width: the results grid does not scroll sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(PAGE + "#search");
    await page.click("#search-all");
    await page.waitForFunction(() => document.querySelectorAll("#r-list .rc").length === 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("VIN lookup: a second VIN replaces the auto-filled title, and NHTSA's 400 means no recalls", { skip: !chromium && "playwright is not installed" }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const cors = { "access-control-allow-origin": "*" };
  await page.route("https://vpic.nhtsa.dot.gov/**", (r) => {
    const bus = r.request().url().includes("1M8GDM9AXKP042788");
    r.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({ Results: [bus
      ? { ModelYear: "1989", Make: "MOTOR COACH INDUSTRIES", Model: "102C3", ErrorCode: "0" }
      : { ModelYear: "2016", Make: "TOYOTA", Model: "Tacoma", ErrorCode: "0" }] }) });
  });
  await page.route("https://api.nhtsa.gov/**", (r) => r.fulfill({ status: 400, headers: cors, contentType: "application/json", body: '{"Count":0,"Message":"Results returned successfully","results":[]}' }));
  try {
    await page.goto(PAGE + "#finds");
    await page.fill("#a-vin", "1M8GDM9AXKP042788");
    await page.click("#a-vin-go");
    await page.waitForFunction(() => /Motor Coach/.test(document.getElementById("a-vin-out").textContent));
    assert.match(await page.textContent("#a-vin-out"), /No recalls on record/);
    await page.fill("#a-vin", "5TFJX4GN1FX040123");
    await page.click("#a-vin-go");
    await page.waitForFunction(() => /Tacoma/.test(document.getElementById("a-vin-out").textContent));
    assert.equal(await page.inputValue("#a-title"), "2016 Toyota Tacoma");
    // A title the person typed is left alone.
    await page.fill("#a-title", "My pick");
    await page.fill("#a-vin", "1M8GDM9AXKP042788");
    await page.click("#a-vin-go");
    await page.waitForFunction(() => /Motor Coach/.test(document.getElementById("a-vin-out").textContent));
    assert.equal(await page.inputValue("#a-title"), "My pick");
  } finally {
    await browser.close();
  }
});
