# strava-to-peakbagger

A Chrome extension that pre-fills [peakbagger.com](https://peakbagger.com) Add-Ascent forms using your [Strava](https://strava.com) activities. Open the popup, see your activities that summited a peak, click Log ascents on the one you want — get one pre-filled peakbagger tab per peak, click Save in each.

**v0.3.1 · experimental · personal use only** — see [Limitations](#limitations-and-design-choices) for why.

## What it does

- Fetches your Strava activities (uses your own Strava API app — you create it during setup).
- Eagerly matches recent activities in the background against peakbagger.com peaks within a configurable horizontal distance of your GPS track. Activities that didn't summit anything are silently filtered out.
- Opens one peakbagger Add-Ascent tab per match, with date, time, gain, distance, duration, and a link back to the Strava activity all pre-filled.
- You review and click Save in each tab. The extension tracks which `(activity, peak)` pairs you've saved so they don't reappear next time.

## Install (from a release zip)

Quickest path; no developer tools needed.

1. Download the latest `strava-to-peakbagger-*.zip` from the [Releases page](https://github.com/evanjfaulkner/strava-to-peakbagger/releases).
2. Unzip it.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped directory.

## Install (from source)

Requires Node 20+ and pnpm (via [corepack](https://nodejs.org/api/corepack.html)).

```bash
git clone https://github.com/evanjfaulkner/strava-to-peakbagger.git
cd strava-to-peakbagger
corepack enable pnpm
pnpm install
pnpm build
```

Then in `chrome://extensions`: Developer mode → Load unpacked → `.output/chrome-mv3/`.

## First-run configuration

Three pieces of one-time setup, all done from the extension's Options page (click the extension icon → puzzle-piece → Strava → Peakbagger → ⋮ → Options, or right-click the toolbar icon → Options).

### 1. Strava API app

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create an app. Any name/website is fine.
2. Set **Authorization Callback Domain** to exactly `chromiumapp.org` (no `https://`, no path).
3. Copy your **Client ID** and **Client Secret**.

### 2. Peakbagger climber ID

1. Sign in to [peakbagger.com](https://peakbagger.com).
2. Click **My Home Page**. The URL will look like `https://peakbagger.com/climber/climber.aspx?cid=12345` — copy the number after `cid=`.

### 3. Wire it up

1. Open the extension's Options page.
2. Paste Client ID, Client Secret, and Climber ID into the form.
3. Click **Save**.
4. Click **Connect Strava** — a Strava authorize popup opens. Click Authorize. The page should show "Connected as `<your name>` (#`<your athlete id>`)".

## How to use

1. Click the extension icon. On first install (or first open of a new day), the popup auto-refreshes from Strava and starts matching your recent activities in the background. You'll see `Scanned N · Found M matches` tick up as it works, and matched activities appear in the list as soon as they're found.
2. The popup only shows activities that summited at least one peak — Yoga / flat city runs / non-summit rides are silently filtered out.
3. Click **Log ascents** on the activity you want to log. Single-peak activities open one pre-filled tab. **Multi-peak activities** (ridge traverses) open one tab at a time: the first peak is set to create a new peakbagger Trip, and subsequent peaks auto-open as you click Save — each one attaches to the same trip in order.
4. Switch to each opened tab. Verify the pre-filled fields, then click **Save Ascent** on the peakbagger form.
5. After saving, the activity drops out of the popup's default view. Partially-saved activities show an `M/N saved` badge.
6. Click **Load more** at the bottom of the list to scan the next 20 unmatched activities. If you hit Strava's rate limit, the button text will tell you when to try again.

Subsequent popup opens on the same day are instant — they read cached results. Each new day, the auto-trigger fires once when you first open the popup.

Per-row affordances:

- **Open** — runs the match pipeline for that activity.
- **Hide** — marks the activity as processed locally without saving anything on peakbagger. Use this to dismiss false-positive matches or activities you don't want to log.
- **Show hidden** (header toggle) — reveals hidden + already-saved rows. Each gets an **Unhide** button.

## Configuration knobs

All on the Options page.

- **Horizontal match threshold** (`horizM`, default **75 m**) — how close a track point must come to a peak's coordinates to count as a summit. Tune lower if you get false positives, higher if real summits are being missed. Ski GPS tends to be noisier than hiking; 75 m handles both well in practice.
- **Vertical match threshold** (`vertM`, default 25 m) — currently dormant, since peakbagger's bbox API doesn't return peak elevations. Reserved for a future enhancement.
- **Initial lookback (days)** (`lookbackDays`, default 90) — how far back to fetch Strava activities on each Refresh (manual click or daily auto-trigger).
- **Activity-type blacklist** — Strava sport types skipped before fetching streams. Defaults to indoor activities (Yoga, WeightTraining, VirtualRide, etc.). One per line.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Connect Strava` popup says "redirect_uri is invalid" | Callback domain on your Strava app isn't `chromiumapp.org` | Edit at [strava.com/settings/api](https://www.strava.com/settings/api), exact string `chromiumapp.org`. |
| `Rate limited — try again at HH:MM` on the Load more button | Strava 100/15-min non-upload limit hit by an auto-continue chain | Wait until the displayed time. The button re-enables automatically. |
| "Invalid User!!!" page when a tab opens | Climber ID not saved (or wrong) in Options | Re-check your cid from peakbagger's My Home Page URL; Save. |
| Tab opens with peak name visible but other fields blank | Content script silently bailed (the most common cause was a `pid` parsing issue, fixed in v0.1.0) | In the page's DevTools Console, set log level to **Verbose** and look for `[s2p]` messages. |
| Activity stays visible after saving | Post-save signal didn't reach the SW. The Step-12 SW tab-mapping should prevent this, but the **Hide** button is the manual recovery. | Click Hide on the row, or open the **Options → Recent log** section to see what happened. |
| Popup is empty after Refresh | All activities in your lookback window are blacklisted, OR Strava returned an error | Check the Recent log on the Options page. |

The **Options → Recent log** section shows the last 50 events (connect, refresh, processActivity, save, errors). For deeper digging, `chrome://extensions` → the extension card → service worker **Inspect views** opens the SW DevTools.

## Architecture

```
┌──────────┐            ┌──────────────────────┐         ┌──────────────────┐
│  Popup   │──messages──▶  Service worker      │──HTTP──▶  Strava API      │
└──────────┘            │  - Strava client     │         └──────────────────┘
                        │  - Peakbagger client │──HTTP──▶  peakbagger.com  │
                        │  - Matcher           │         │  (PLLBB.aspx)    │
                        │  - Prefill builder   │         └──────────────────┘
                        │  - Storage helpers   │
                        └──────────┬───────────┘
                                   │ chrome.tabs.create
                                   ▼
                        ┌─────────────────────────┐
                        │  peakbagger Add-Ascent  │
                        │  (content script        │
                        │   fills form, sends     │
                        │   ascent-saved on save) │
                        └─────────────────────────┘
```

- Built with [WXT](https://wxt.dev) + TypeScript.
- Service worker handles all network and state.
- Popup is a thin client that talks to the SW via `chrome.runtime.sendMessage`.
- A content script (`ascentedit.content.ts`) runs on peakbagger Add-Ascent pages, reads the prefill payload from `chrome.storage.local`, and fills the form fields.

## Limitations and design choices

- **Personal use only.** Your Strava OAuth `client_secret` lives in `chrome.storage.local`. Strava's API agreement frowns on embedding secrets in clients; this is acceptable for a single-user install where you control both ends, but you should never publish a forked version of this extension that ships someone else's secret.
- **Peakbagger ToS forbids automated scraping.** The extension keeps a human in the loop (you click Save) and is rate-limited and sends a polite User-Agent. This mirrors the posture of [`npwolf/peakbagger_gpx_ascent_logger`](https://github.com/npwolf/peakbagger_gpx_ascent_logger). If you intend to share this beyond personal use, contact Greg Slayden (peakbagger's owner) first.
- **Strava Single-Player Mode** — since Nov 2024, new Strava API apps cap at 1 authorized athlete unless approved by Strava. Fine for personal use; not for distribution.
- **Eager batched matching.** v0.2 changed the model from "click Open to find out" to "open popup, see matches." A batch of 20 fresh activities auto-runs on first open of each local day. The popup hides activities that scanned to zero matches.
- **Multi-peak trip automation is sequential, not parallel.** Multi-peak activities open one ascentedit tab at a time so the first save can create a peakbagger Trip, and subsequent ascents can attach to it. If you want every peak as a standalone ascent, you can manually clear the Trip dropdown in each tab before saving.
- **Peakbagger's PLLBB endpoint doesn't return elevation**, so the vertical match gate (`vertM`) is dormant in v1. The horizontal gate (`horizM`) does all the filtering.

## Development

```bash
pnpm dev          # WXT dev server with HMR
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm check        # lint + typecheck + test
pnpm build        # production build → .output/chrome-mv3/
pnpm zip          # bundled .zip → .output/<name>-<version>-chrome.zip
```

## Acknowledgements

This extension stands on three earlier projects that did the hardest reverse-engineering work:

- [flegallo/peakbagger-tools](https://github.com/flegallo/peakbagger-tools) — Go client (2020) whose source documents the peakbagger Add-Ascent form schema (`AscentEdit.aspx`, `DateText`, `GainFt`, etc.).
- [npwolf/peakbagger_gpx_ascent_logger](https://github.com/npwolf/peakbagger_gpx_ascent_logger) — Chrome MV3 extension whose architecture (user-clicks-Save) inspired the v1 posture.
- [dreamiurg/peakbagger-cli](https://github.com/dreamiurg/peakbagger-cli) — Python read-side reference for scraping peakbagger pages.

## License

[MIT](./LICENSE) © 2026 Evan Faulkner
