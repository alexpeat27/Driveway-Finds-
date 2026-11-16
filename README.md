# Driveway Finds

Used car and truck search page. No build step: open `index.html`, or host the folder with GitHub Pages.

- `index.html`: the page, its styles and its screen code.
- `core.js`: the logic with no screen code (search links, duplicate checks, VIN checks, price history, backups). The tests load it directly.

## What it does

- **Search**: builds one search and opens it on Facebook Marketplace, Craigslist (plus any nearby Craigslist sites you add), AutoTempest, Cars.com and OfferUp. It lists the filters each site can't apply.
- **Watchlist**: keeps your flagged searches so you can rerun them. It won't flag the same search twice.
- **Finds**: tracks listings you add from any site. You can edit them, record price changes, set a stage (contacted, test drive, inspected, offer, passed) and look up a VIN. The VIN lookup uses free NHTSA data for specs and model-year recalls, and links to NHTSA's page for that VIN's own open recalls.
- **Backup**: download everything as a JSON file and restore it later. Restoring adds what is missing and never overwrites.

On a static host your data lives in that browser only, so download a backup now and then. When the page runs as a Claude Artifact with a database, the data is shared across your devices.

## Tests

```bash
npm test
```

The browser test needs Playwright. It mocks NHTSA, so it doesn't use the network.
