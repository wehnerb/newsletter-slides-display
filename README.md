# Newsletter Slides Display

A Cloudflare Worker that displays newsletter slide images on fire station display screens. Each slide has its own start and/or end date in its file name, so slides appear and expire on their own. Slides are managed by dropping image files into a Google Drive folder. No technical knowledge is required to add or remove content.

## 📄 System Documentation
Full documentation (architecture, setup, account transfer, IT reference): https://github.com/wehnerb/ffd-display-system-documentation

---

## Live URLs

| Environment | URL |
|---|---|
| Production | `https://newsletter-slides-display.bwehner.workers.dev/` |
| Staging | `https://newsletter-slides-display-staging.bwehner.workers.dev/` |
| Health check | `https://newsletter-slides-display.bwehner.workers.dev/healthz` |

---

## Layout Parameter

| Parameter | Default | Options |
|---|---|---|
| `?layout=` | `wide` | `full`, `wide`, `split`, `tri` |
| `?bg=` | transparent | `dark` (solid dark background, for testing in a browser) |

| Layout | Width | Height |
|---|---|---|
| `full` | 1920px | 1075px |
| `wide` | 1735px | 720px |
| `split` | 852px | 720px |
| `tri` | 558px | 720px |

---

## Managing Content

Drop image files into the **Fire Station Display - Newsletter Slides** Google Drive folder. Use JPG, PNG, GIF or WebP.

**Any image dimensions work.** The Worker scales every image to fit the screen and centres it, without cropping or stretching. If the image's shape differs from the screen's, empty bars appear at the sides or at the top and bottom. For the best fit with no empty space on the wide layout, use 1735 × 720 pixels. Images with more than 16 million pixels in total (for example, larger than 4000 × 4000) are skipped, to protect the display hardware.

Keep the file's storage size under 2 MB (5 MB is the hard limit).

### File names

The file name tells the system when to show the slide. Dates are always `YYYY-MM-DD`. Both dates are included, and a slide expires at midnight Central time at the end of its end date. The words `to`, `until` and `always` can be upper or lower case.

| Pattern | Example | Shown |
|---|---|---|
| `START_to_END_name` | `2026-11-18_to_2026-11-25_flu-clinic.jpg` | From the start date through the end date |
| `until_END_name` | `until_2026-11-25_flu-clinic.jpg` | Immediately, through the end date |
| `always_name` | `always_station-hours.jpg` | Until the file is removed |

An image whose name does not follow one of these patterns, or whose dates are not real dates, or whose end date is before its start date, or that is over the pixel limit, is **never shown**. The Worker logs its name so the problem is easy to find.

Files that are not images (such as the naming instructions text file) and subfolders are ignored. To take a slide down early without deleting it, move it into any subfolder.

### QR code

A QR code image named `qr-code` (for example `qr-code.png`) in the same folder is used on the **no current slides** screen and is never shown as a slide. PNG is recommended, at least 600 × 600 pixels with a plain white border. To change where the QR code points, replace the file.

Anyone who can edit the Drive folder controls what the displays show, including the QR code. Keep edit access limited.

---

## How Rotation Works

- Slides active today take turns, one per time slot, counted from midnight Central time. With a 10-minute slot and two slides, the first shows 12:00 AM to 12:10 AM, the second 12:10 AM to 12:20 AM, and so on.
- The slide shown depends only on the clock, not on when the display loads the page, so display timing and preloading do not matter.
- Slides are ordered by start date, then by file name. Slides with no start date (`until_` and `always_`) come before dated ones.
- The page reloads itself at the next slot change and just after midnight, so slides start and expire on time.
- With no active slides, a "no current newsletter slides" screen is shown instead (with the QR code if one is in the folder) and the folder is re-checked every 5 minutes.
- If Google Drive cannot be read, the same screen is shown and the page retries after 60 seconds.
- If a slide image fails to load, it is retried once; if it fails again, the screen shows the "no current slides" screen and reloads after 60 seconds.
- All dates and times use Central time and follow Daylight Saving.

---

## Configuration (`src/index.js`)

| Constant | Default | Description |
|---|---|---|
| `ROTATION_MINUTES` | `10` | Minutes each slide displays before the next takes its turn (1–1440) |
| `DEFAULT_LAYOUT_KEY` | `'wide'` | Layout when no `?layout=` parameter is provided |
| `DISPLAY_TIME_ZONE` | `'America/Chicago'` | Time zone for all date and time logic |
| `NO_SLIDES_TITLE` / `NO_SLIDES_MESSAGE` | text | Wording of the no-slides screen |
| `NO_SLIDES_QR_CAPTION` | `'Scan for the full newsletter'` | Line under the QR code (empty for none) |
| `QR_FILE_BASENAME` | `'qr-code'` | File name (without extension) reserved for the QR code |
| `MIN_REFRESH_SECONDS` | `30` | Smallest page refresh interval |
| `ERROR_RETRY_SECONDS` | `60` | Seconds before a Drive failure or image failure retries |
| `NO_SLIDES_REFRESH_SECONDS` | `300` | How often the no-slides screen re-checks the folder |
| `IMAGE_RETRY_DELAY_MS` | `4000` | Wait before the single automatic image retry |
| `MAX_IMAGE_BYTES` | `5 MB` | Largest image file (storage size) the Worker will serve |
| `MAX_IMAGE_PIXELS` | `16000000` | Largest image, in pixels (width × height), that will be displayed |

---

## Secrets

These are **GitHub repository secrets**. The deploy workflow pushes the three `GOOGLE_*` values to the Worker in Cloudflare on every deploy, so GitHub is the source of truth. To change one, update the GitHub secret, then re-run the latest deploy for both the `staging` and `main` branches. Changing it only in the Cloudflare dashboard is overwritten by the next deploy.

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token — Workers edit permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email — shared with the other Google-connected Workers |
| `GOOGLE_PRIVATE_KEY` | RSA private key from the Google Cloud JSON key file — shared with the other Google-connected Workers |
| `GOOGLE_DRIVE_FOLDER_ID` | Drive folder ID — found in the URL after `/folders/` |

The folder must be shared with the service account email (Viewer).

---

## Deployment

| Branch | Deploys To | Purpose |
|---|---|---|
| `staging` | `newsletter-slides-display-staging.bwehner.workers.dev` | Testing (default branch) |
| `main` | `newsletter-slides-display.bwehner.workers.dev` | Production |

Push to either branch — GitHub Actions deploys automatically (~30–45 sec).  
**Always stage and test before merging to main.**  
Staging and production read the same Drive folder, so test images are visible on production displays while testing. Remove them when finished.  
To roll back: use the Cloudflare dashboard **Deployments** tab, then revert the commit on `main`.

### Shared utilities

`src/shared/` is copied automatically from the `ffd-station-display-utils` repo by the **Sync shared utils** workflow. Do not edit files in `src/shared/` — changes are overwritten on the next sync.

---

## Health Check

`/healthz` returns `200` when Google's APIs are reachable and `503` otherwise (GET and HEAD). Monitored by UptimeRobot every 5 minutes.
