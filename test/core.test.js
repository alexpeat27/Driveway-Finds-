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

test("sameCriteria ignores case, spacing and vehicle order", () => {
  const a = crit({ vehicles: "Toyota Tacoma, Ford F-150", priceMax: "20000" });
  const b = crit({ vehicles: "ford  f-150,toyota tacoma ", priceMax: "20000" });
  assert.ok(DF.sameCriteria(a, b));
  assert.ok(!DF.sameCriteria(a, crit({ vehicles: "Toyota Tacoma", priceMax: "20000" })));
  assert.ok(DF.sameCriteria(crit({ dist: "any" }), Object.assign(blank(), { dist: "" })));
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

test("old saved searches are translated, new ones are left alone", () => {
  const old = DF.migrateCriteria({ vehicles: "Ford F-250", body: "7", drive: "3", cyl: "4", fuel: "2", trans: "1", kw: "plow", dist: "75" });
  assert.deepEqual([old.body, old.drive, old.cyl, old.fuel, old.trans, old.dist, old.kw, old.fmt], ["pickup", "4wd", "6", "diesel", "manual", "100", undefined, 2]);
  const now = DF.migrateCriteria({ fmt: 2, cyl: "4", body: "suv", drive: "awd" });
  assert.deepEqual([now.cyl, now.body, now.drive], ["4", "suv", "awd"]);
  assert.equal(DF.migrateCriteria({ fmt: 2, body: "7" }).body, "", "an unknown value is dropped");
  assert.equal(DF.migrateCriteria({ body: "6" }).body, "", "old Off-road has no equivalent");
  assert.ok(DF.sameCriteria({ vehicles: "Ford", drive: "3" }, { fmt: 2, vehicles: "ford", drive: "4wd" }));
  assert.deepEqual(DF.chipList({ fmt: 2, vehicles: "Ford", body: "pickup", drive: "4wd", cyl: "8", dist: "any" }), ["Pickup", "4x4", "8 cyl", "Anywhere in the US"]);
  assert.equal(DF.title({ fmt: 2, body: "minivan" }), "Any Minivan");
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
