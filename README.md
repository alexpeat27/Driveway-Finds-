# Driveway Finds

Used car and truck search page. No build step: open `index.html`, or host the folder with GitHub Pages.

- `index.html`: the page, its styles and its screen code.
- `core.js`: the logic with no screen code (search links, duplicate checks, VIN checks, price history, backups). The tests load it directly.
- `worker/`: the optional search server behind the **Search everything** button. See [worker/SETUP.md](worker/SETUP.md).

## What it does

- **Search**: one button searches every data source connected to your search server (Auto.dev, MarketCheck dealers and private sellers, eBay Motors) and shows one list with photos. The same car listed twice appears once. Filters: makes and models, year, body style, drive, cylinders, engine, fuel, transmission, price, mileage, and distance from a ZIP code. A source applies what it can, and the server re-checks every result. It needs the free search server in `worker/`.
- **Watchlist**: saved searches you can run again with one click. The same search can't be saved twice.
- **Finds**: tracks listings you save from results or add from any site. You can edit them, record price changes, set a stage (contacted, test drive, inspected, offer, passed) and look up a VIN. The VIN lookup uses free NHTSA data for specs and model-year recalls, and links to NHTSA's page for that VIN's own open recalls.
- **Backup**: download everything as a JSON file and restore it later. Restoring adds what is missing and never overwrites.

On a static host your data lives in that browser only, so download a backup now and then. When the page runs as a Claude Artifact with a database, the data is shared across your devices.

## Tests

```bash
npm test
```

The browser test needs Playwright. The tests mock NHTSA and the car-data services, so they don't use the network.
