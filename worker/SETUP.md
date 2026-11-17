# Setting up Search everything

The page's **Search everything** button calls a small search server (a Cloudflare Worker) that you own.
It keeps your car-data keys hidden and asks MarketCheck, Auto.dev and eBay Motors at the same time.
Everything here is on free plans. About 15 minutes in total.

## 1. Put the Worker online (5 minutes, no installs)

1. Sign in at dash.cloudflare.com.
2. Open **Workers & Pages** (under Compute in the left menu), choose **Create**, then **Start with Hello World**.
3. Name it `driveway-finds` and choose **Deploy**.
4. Choose **Edit code**. Delete everything in the editor, paste the whole of `worker/src/index.js` from this repo, and choose **Deploy**.
5. Copy the address it shows, e.g. `https://driveway-finds.yourname.workers.dev`. Opening it should show `{"ok":true,"sources":[]}`.

## 2. Add your access code

In the Worker, open **Settings**, then **Variables and Secrets**, then **Add**. Set the type to **Secret**.

| Name | Value |
|---|---|
| `ACCESS_CODE` | A passphrase you make up, e.g. four random words. The Worker refuses every search until this is set. |

Choose **Deploy** after adding secrets. A saved secret can't be viewed again, so keep a copy in a password manager.

## 3. Get the free data keys (add any or all; each one turns on that source)

| Source | Where | Secret name(s) | Free allowance |
|---|---|---|---|
| MarketCheck (dealers and private sellers) | developers.marketcheck.com: sign up, then copy your API key | `MARKETCHECK_KEY` | 500 calls a month, within 100 miles |
| Auto.dev (dealers) | auto.dev: sign up, then copy your API key from the dashboard | `AUTODEV_KEY` | 1,000 calls a month |
| eBay Motors | developer.ebay.com: join the Developers Program, create a **Production** keyset | `EBAY_CLIENT_ID` (App ID) and `EBAY_CLIENT_SECRET` (Cert ID) | Free |

One Search everything press uses 2 MarketCheck calls (dealers and private sellers), 1 Auto.dev call and 1 eBay call for each vehicle in your search.
The Worker reuses an answer for 15 minutes, so repeating a search doesn't spend more calls.

## 4. Optional: lock it to your page

Add a plain variable (not a secret) named `ALLOWED_ORIGINS` with your page's address, e.g. `https://yourname.github.io`.
Other websites then can't use your Worker even if they learn the access code.

## 5. Connect the page

On the page's **Watchlist** tab, find **Search everything**. Paste the Worker address and your access code, then choose **Test connection**.
The access code is saved only in that browser, so enter it once on each device.

## Deploying from a computer instead

From this repo on a computer with Node.js:

```bash
cd worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put ACCESS_CODE
```

Repeat `npx wrangler secret put` for each key name in step 3.
