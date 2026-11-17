"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const DF = require("../core.js");

const S = { fbCity: "pittsburgh", clSite: "pittsburgh", clExtra: "" };
const q = (u) => new URL(u).searchParams;
const blank = () => Object.fromEntries(DF.FIELDS.map((k) => [k, ""]));
const crit = (o) => Object.assign(blank(), { dist: "50" }, o);

test("splitVehicle handles two-word makes and nicknames", () => {
  assert.deepEqual(DF.splitVehicle("Land Rover Defender"), { make: "land rover", model: "defender" });
  assert.deepEqual(DF.splitVehicle("Alfa Romeo Giulia"), { make: "alfa romeo", model: "giulia" });
  assert.deepEqual(DF.splitVehicle("Mercedes-Benz G550"), { make: "mercedes benz", model: "g550" });
  assert.deepEqual(DF.splitVehicle("Chevy Silverado 1500"), { make: "chevrolet", model: "silverado 1500" });
  assert.deepEqual(DF.splitVehicle("Range Rover Sport"), { make: "land rover", model: "range rover sport" });
  assert.deepEqual(DF.splitVehicle("Toyota"), { make: "toyota", model: "" });
  assert.deepEqual(DF.splitVehicle(""), { make: "", model: "" });
});

test("AutoTempest link no longer splits Land Rover into make 'land'", () => {
  const p = q(DF.atUrl(crit({ zip: "15222" }), "Land Rover Defender"));
  assert.equal(p.get("make"), "landrover");
  assert.equal(p.get("model"), "defender");
  const t = q(DF.atUrl(crit({}), "Ford F-150"));
  assert.equal(t.get("make"), "ford");
  assert.equal(t.get("model"), "f-150");
  assert.equal(q(DF.atUrl(crit({ dist: "any" }), "Ford")).get("radius"), "any");
  assert.equal(q(DF.atUrl(crit({ dist: "75" }), "Ford")).get("radius"), "100");
});

test("Craigslist link keeps every filter and caps distance at 500", () => {
  const c = crit({ vehicles: "Toyota Tacoma, Ford F-150", body: "7", drive: "3", cyl: "5", fuel: "2", trans: "2", priceMax: "22000", zip: "15222", dist: "750" });
  const u = DF.clUrl(c, S);
  assert.match(u, /^https:\/\/pittsburgh\.craigslist\.org\/search\/cto\?/);
  const p = q(u);
  assert.equal(p.get("query"), "(Toyota Tacoma)|(Ford F-150)");
  assert.equal(p.get("auto_bodytype"), "7");
  assert.equal(p.get("search_distance"), "500");
  assert.equal(p.get("postal"), "15222");
  assert.match(DF.clUrl(c, S, "morgantown"), /^https:\/\/morgantown\.craigslist\.org\//);
});

test("clSites lists the main site first, then nearby ones without repeats", () => {
  assert.deepEqual(DF.clSites({ clSite: "pittsburgh", clExtra: "Morgantown, wheeling, pittsburgh" }), ["pittsburgh", "morgantown", "wheeling"]);
  assert.deepEqual(DF.clSites({}), ["pittsburgh"]);
});

test("Facebook link turns 4x4 and diesel into words", () => {
  const p = q(DF.fbUrl(crit({ drive: "3", fuel: "2", priceMax: "9000" }), S, "Ford F-250"));
  assert.equal(p.get("query"), "Ford F-250 4x4 diesel");
  assert.equal(p.get("maxPrice"), "9000");
  assert.equal(p.get("sellerType"), "individual");
});

test("Cars.com link uses its make and model slugs", () => {
  const p = q(DF.carsUrl(crit({ zip: "15222", dist: "150", priceMax: "30000", yearMin: "2015" }), "Ford F-150"));
  assert.deepEqual(p.getAll("makes[]"), ["ford"]);
  assert.deepEqual(p.getAll("models[]"), ["ford-f_150"]);
  assert.equal(p.get("maximum_distance"), "200");
  assert.equal(p.get("list_price_max"), "30000");
  assert.equal(p.get("stock_type"), "used");
  assert.deepEqual(q(DF.carsUrl(crit({}), "Land Rover Defender")).getAll("models[]"), ["land_rover-defender"]);
  assert.equal(q(DF.carsUrl(crit({}), "Toyota")).getAll("models[]").length, 0);
});

test("OfferUp link carries the vehicle and price", () => {
  const p = q(DF.offerupUrl(crit({ priceMax: "8000", kw: "plow" }), "Ford F-250"));
  assert.equal(p.get("q"), "Ford F-250 plow");
  assert.equal(p.get("PRICE_MAX"), "8000");
});

test("skippedFilters names the filters a site cannot use", () => {
  const c = crit({ body: "7", drive: "3", cyl: "5", trans: "2", priceMax: "1", zip: "15222" });
  assert.deepEqual(DF.skippedFilters("facebook", c), ["body style", "cylinders", "transmission", "ZIP and distance"]);
  assert.deepEqual(DF.skippedFilters("craigslist", c), []);
  assert.deepEqual(DF.skippedFilters("facebook", crit({ drive: "1" })), ["drive"]);
  assert.deepEqual(DF.skippedFilters("autotempest", crit({ zip: "15222", dist: "any" })), []);
});

test("sameCriteria ignores case, spacing and vehicle order", () => {
  const a = crit({ vehicles: "Toyota Tacoma, Ford F-150", priceMax: "20000" });
  const b = crit({ vehicles: "ford  f-150,toyota tacoma ", priceMax: "20000" });
  assert.ok(DF.sameCriteria(a, b));
  assert.ok(!DF.sameCriteria(a, crit({ vehicles: "Toyota Tacoma", priceMax: "20000" })));
  assert.ok(DF.sameCriteria(crit({}), Object.assign(blank(), { dist: "" })));
});

test("normUrl spots the same listing pasted twice", () => {
  assert.equal(
    DF.normUrl("https://www.facebook.com/marketplace/item/123456789/?ref=search&tracking=abc"),
    DF.normUrl("https://m.facebook.com/marketplace/item/123456789")
  );
  assert.equal(
    DF.normUrl("https://www.cars.com/vehicledetail/abc-123/?utm_source=x&b=2&a=1#photos"),
    DF.normUrl("https://cars.com/vehicledetail/abc-123?a=1&b=2")
  );
  assert.notEqual(DF.normUrl("https://cars.com/vehicledetail/1"), DF.normUrl("https://cars.com/vehicledetail/2"));
  assert.equal(DF.normUrl("javascript:alert(1)"), "");
  const finds = [{ id: "a", url: "https://pittsburgh.craigslist.org/cto/d/x/7712.html" }];
  assert.equal(DF.findByUrl(finds, "https://pittsburgh.craigslist.org/cto/d/x/7712.html?lang=en"), null);
  assert.equal(DF.findByUrl(finds, "https://pittsburgh.craigslist.org/cto/d/x/7712.html/").id, "a");
});

test("price history records only real changes", () => {
  let h = DF.withPrice([], 20000, 18500, 1);
  assert.deepEqual(h, [{ price: 20000, at: 1 }, { price: 18500, at: 1 }]);
  h = DF.withPrice(h, 18500, 18500, 2);
  assert.equal(h.length, 2);
  h = DF.withPrice(h, 18500, 17000, 3);
  assert.equal(h.length, 3);
  assert.deepEqual(DF.priceChange({ price: 17000, priceHistory: h }), { from: 20000, to: 17000, drop: 3000 });
  assert.equal(DF.priceChange({ price: 20000, priceHistory: [{ price: 20000, at: 1 }] }), null);
  assert.equal(DF.priceChange({ price: null, priceHistory: h }), null);
  assert.deepEqual(DF.withPrice(undefined, null, 5000, 9), [{ price: 5000, at: 9 }]);
});

test("cost per remaining mile and budget gap", () => {
  assert.equal(DF.cpm({ price: 15000, miles: 50000 }, 200000), 0.1);
  assert.equal(DF.cpm({ price: 15000, miles: 250000 }, 200000), null);
  assert.equal(DF.cpm({ price: 0, miles: 1 }, 200000), null);
  assert.equal(DF.budgetGap({ searchId: "s", price: 18000 }, [{ id: "s", criteria: { priceMax: "20000" } }]), 10);
  assert.equal(DF.budgetGap({ searchId: "x", price: 18000 }, []), null);
});

test("VIN check digit", () => {
  // Well-known valid example VINs.
  assert.deepEqual(DF.checkVin("1M8GDM9AXKP042788"), { ok: true, vin: "1M8GDM9AXKP042788", checkDigit: true });
  assert.equal(DF.checkVin("11111111111111111").checkDigit, true);
  assert.equal(DF.checkVin("1M8GDM9A1KP042788").checkDigit, false);
  assert.equal(DF.checkVin("1M8GDM9AXKP04278").ok, false);
  assert.equal(DF.checkVin("1M8GDM9AXKP04278O").ok, false); // letter O is never used
  assert.equal(DF.checkVin(" 1m8gdm9axkp042788 ").vin, "1M8GDM9AXKP042788");
});

test("findVin pulls a valid VIN out of a link", () => {
  assert.equal(DF.findVin("https://www.carfax.com/vehicle/1M8GDM9AXKP042788?x=1"), "1M8GDM9AXKP042788");
  assert.equal(DF.findVin("https://example.com/listing/1M8GDM9A1KP042788"), "");
  assert.equal(DF.findVin("https://example.com/abcdefghjklmnprst"), "");
});

test("parseVpic and parseRecalls read NHTSA answers", () => {
  const vp = { Results: [{ ModelYear: "2015", Make: "TOYOTA", Model: "Tacoma", Trim: "TRD Off Road", DisplacementL: "4.0", EngineCylinders: "6", DriveType: "4WD/4-Wheel Drive/4x4", FuelTypePrimary: "Gasoline", TransmissionStyle: "", BodyClass: "Pickup", ErrorCode: "0" }] };
  const d = DF.parseVpic(vp);
  assert.equal(d.title, "2015 Toyota Tacoma TRD Off Road");
  assert.equal(d.specs, "4.0L 6 cyl · 4WD/4-Wheel Drive/4x4 · Gasoline · Pickup");
  assert.equal(d.partial, false);
  assert.equal(DF.parseVpic({ Results: [{ ErrorCode: "7" }] }), null);
  assert.equal(DF.parseVpic({}), null);
  const r = DF.parseRecalls({ Count: 2, results: [{ NHTSACampaignNumber: "15V123000", Component: "AIR BAGS" }, { NHTSACampaignNumber: "16V1", Component: "BRAKES" }] });
  assert.equal(r.count, 2);
  assert.equal(r.items[0].id, "15V123000");
  assert.equal(DF.parseRecalls(null).count, 0);
  assert.match(DF.recallsUrl("Toyota", "Tacoma", 2015), /make=Toyota&model=Tacoma&modelYear=2015$/);
});

test("backup round trip and merge never duplicates", () => {
  const state = {
    searches: [{ id: "s1", criteria: crit({ vehicles: "Toyota Tacoma" }) }],
    finds: [{ id: "f1", url: "https://cars.com/vehicledetail/1" }],
    settings: { fbCity: "pittsburgh" },
  };
  const text = JSON.stringify(DF.makeBackup(state, 0));
  const b = DF.readBackup(text);
  assert.equal(DF.mergePlan(state, b).searches.length, 0);
  assert.equal(DF.mergePlan(state, b).finds.length, 0);
  const other = DF.readBackup(JSON.stringify({
    app: "driveway-finds", version: 1,
    searches: [{ id: "s2", criteria: crit({ vehicles: "toyota tacoma" }) }, { id: "s3", criteria: crit({ vehicles: "Ford" }) }],
    finds: [
      { id: "f2", url: "https://www.cars.com/vehicledetail/1/?utm_source=a" },
      { id: "f3", url: "https://cars.com/vehicledetail/3" },
      { id: "f4", url: "https://cars.com/vehicledetail/3#x" },
      { id: "f5", url: "javascript:alert(1)" },
      { id: "../bad", url: "https://cars.com/x" },
    ],
  }));
  const plan = DF.mergePlan(state, other);
  assert.deepEqual(plan.searches.map((s) => s.id), ["s3"]);
  assert.deepEqual(plan.finds.map((f) => f.id), ["f3"]);
  assert.throws(() => DF.readBackup("not json"), /not a Driveway Finds backup/);
  assert.throws(() => DF.readBackup(JSON.stringify({ app: "other", searches: [], finds: [] })), /not a Driveway Finds backup/);
});

test("detectTitle reads branded titles but not denials", () => {
  assert.equal(DF.detectTitle("Clean truck, rebuilt title"), "rebuilt");
  assert.equal(DF.detectTitle("salvage"), "salvage");
  assert.equal(DF.detectTitle("never salvage, clean title"), "");
});
