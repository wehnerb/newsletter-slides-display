// =============================================================================
// NEWSLETTER SLIDES DISPLAY
// Fargo Fire Department station display Worker
//
// Shows static newsletter slide images from a Google Drive folder on the
// station TVs. Each image carries its own start and/or end date in its file
// name, so slides appear and expire automatically with no code or sheet edits.
//
// HOW IT WORKS
//   1. On every page load the Worker lists the image files in the Drive folder.
//   2. File names are parsed for a date rule (see FILE NAME CONVENTION below).
//      Files that do not follow the convention are never displayed.
//   3. Only slides whose rule includes today's date (Central time) are active.
//   4. Active slides take turns on a fixed wall-clock schedule: one slide per
//      ROTATION_MINUTES slot, counted from midnight Central. The slide shown
//      depends only on the clock, never on how often or when the display
//      loads the page, so it is unaffected by SmartHub preload timing.
//   5. With no active slides, a "no current slides" screen is shown instead.
//      If a QR code image is stored in the folder (see QR CODE), it appears
//      on that screen.
//
// FILE NAME CONVENTION (keywords are case-insensitive, dates are YYYY-MM-DD,
// both dates are inclusive and the end date expires at midnight Central):
//   2026-11-18_to_2026-11-25_flu-clinic.jpg   shown from the start date through
//                                             the end date
//   until_2026-11-25_flu-clinic.jpg           shown immediately, through the
//                                             end date
//   always_station-hours.jpg                  no end date, shown until the
//                                             file is removed
//
// IMAGE SIZE
//   Slides can be any width and height. Each image is scaled by CSS to fit the
//   display and centred, never cropped or stretched. When the image's shape
//   differs from the display, empty bars appear at the sides or at the top
//   and bottom. Images with more than MAX_IMAGE_PIXELS pixels are skipped to
//   protect the display hardware from decoding enormous images.
//
// QR CODE
//   A PNG, JPG, GIF or WebP image named qr-code.<ext> (for example
//   qr-code.png) in the same folder is reserved for the "no current slides"
//   screen. It is never treated as a slide.
//
// ENDPOINTS
//   /                 The display page (query: ?layout=wide|full|split|tri,
//                     ?bg=dark). Defaults to the wide layout.
//   /image/{fileId}   Streams an image from Drive. Only currently active
//                     slides and the QR code image can be fetched.
//   /healthz          Health check for UptimeRobot (GET and HEAD).
//
// SECRETS (set as GitHub repository secrets; deploy.yml pushes them to
// Cloudflare on every deploy):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   Service account e-mail address
//   GOOGLE_PRIVATE_KEY             Service account private key (PEM)
//   GOOGLE_DRIVE_FOLDER_ID         ID of the Drive folder holding the slides
//
// SECURITY NOTES
//   - No secret, key, folder ID or token is ever written to a response or log.
//   - The image route serves only files that are in the configured folder, are
//     an allowed image type, are under the size cap, and are either an active
//     slide or the QR code image. Every other Drive file is refused, even if
//     its ID is known.
//   - Anyone who can edit the Drive folder controls what the displays show,
//     including where the QR code points. Keep edit access limited.
//   - This Worker never sets X-Frame-Options, because the displays load it in
//     an iframe.
//
// CODE STYLE
//   String concatenation only (no template literals), matching the project-wide
//   rule that avoids smart-quote corruption in GitHub's browser editor.
// =============================================================================

import { fetchWithTimeout } from './shared/fetch-helpers.js';
import { escapeHtml, sanitizeParam } from './shared/html.js';
import { getAccessToken } from './shared/google-auth.js';
import {
  DARK_BG_COLOR,
  FONT_STACK,
  ACCENT_COLOR,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
} from './shared/colors.js';
import { LAYOUTS } from './shared/layouts.js';

// =============================================================================
// CONFIGURATION
// Everything an administrator might reasonably want to change is here.
// =============================================================================

// Minutes each slide stays up before the next one takes its turn. Whole
// minutes, 1 to 1440. With 20-30 second display slots and 3-5 minute cycles,
// 10-15 minutes keeps every slide visible across several cycles.
const ROTATION_MINUTES = 10;

// Layout used when ?layout= is missing or invalid (keys come from layouts.js).
const DEFAULT_LAYOUT_KEY = 'wide';

// Time zone for every date and time calculation. Respects Daylight Saving.
const DISPLAY_TIME_ZONE = 'America/Chicago';

// Text of the "no current slides" screen.
const NO_SLIDES_TITLE = 'NO CURRENT NEWSLETTER SLIDES';
const NO_SLIDES_MESSAGE = 'Check back soon for new announcements.';
// Short line shown under the QR code image. Leave empty for no caption.
const NO_SLIDES_QR_CAPTION = 'Scan for the full newsletter';

// File name (without extension) reserved for the QR code image in the folder.
const QR_FILE_BASENAME = 'qr-code';

// Smallest page auto-refresh interval, so a slot boundary that is only a few
// seconds away cannot cause a rapid reload loop.
const MIN_REFRESH_SECONDS = 30;

// How soon the page reloads after a Drive failure.
const ERROR_RETRY_SECONDS = 60;

// How often the "no current slides" screen re-checks the folder for new files.
const NO_SLIDES_REFRESH_SECONDS = 300;

// Wait before the single automatic retry when a slide image fails to load
// (covers Google Drive propagation lag after a new upload).
const IMAGE_RETRY_DELAY_MS = 4000;

// Image types that may be displayed. SVG is deliberately excluded.
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// Largest image the proxy will stream (bytes). Recommended size is under 2 MB.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Largest image, in pixels (width x height), that will be displayed. Any shape
// is fine; this only guards against huge images that could stall the
// display's browser. 16,000,000 allows up to 4000 x 4000.
const MAX_IMAGE_PIXELS = 16000000;

// Timeout for each Google API request (milliseconds).
const GOOGLE_FETCH_TIMEOUT_MS = 8000;

// Most files requested from Drive in one listing (Drive's maximum is 1000).
const DRIVE_PAGE_SIZE = 1000;

// QR codes must be dark-on-light to scan, so the QR image sits on a white
// tile. There is no shared-utils constant for this.
const QR_TILE_COLOR = '#FFFFFF';

// =============================================================================
// DERIVED CONSTANTS (do not edit)
// =============================================================================

const SECONDS_PER_DAY = 86400;
const WORKER_NAME = 'newsletter-slides-display';
const LOG_PREFIX = '[' + WORKER_NAME + '] ';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

// Slot length in seconds. A misconfigured ROTATION_MINUTES falls back to 10.
const SLOT_SECONDS = (function () {
  const minutes = Math.floor(ROTATION_MINUTES);
  if (!(minutes >= 1 && minutes <= 1440)) {
    console.error(LOG_PREFIX + 'ROTATION_MINUTES is invalid; using 10.');
    return 600;
  }
  return minutes * 60;
})();

// Google Drive file and folder IDs contain only these characters.
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;

// File name patterns. Dates are matched loosely here and validated as real
// calendar dates afterwards.
const DATE_PATTERN = '(\\d{4}-\\d{2}-\\d{2})';
const RANGE_NAME_PATTERN = new RegExp('^' + DATE_PATTERN + '_to_' + DATE_PATTERN + '_(.+)$', 'i');
const UNTIL_NAME_PATTERN = new RegExp('^until_' + DATE_PATTERN + '_(.+)$', 'i');
const ALWAYS_NAME_PATTERN = /^always_(.+)$/i;
const QR_NAME_PATTERN = new RegExp('^' + QR_FILE_BASENAME + '\\.[a-z0-9]{2,5}$', 'i');

// One formatter, built once, that reads the Central wall clock. hourCycle h23
// guarantees midnight is reported as hour 00, never 24.
const CENTRAL_CLOCK_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// =============================================================================
// TIME HELPERS
// =============================================================================

// Left-pads a number with zeros to the given width.
function padNumber(value, width) {
  let text = String(value);
  while (text.length < width) {
    text = '0' + text;
  }
  return text;
}

// Reads the Central wall clock from a single instant, so the date and the
// time of day can never straddle midnight.
//   nowMs: milliseconds since the Unix epoch
// Returns { dateStr: 'YYYY-MM-DD', secondsOfDay: 0-86399 }
function getCentralClock(nowMs) {
  const parts = {};
  const list = CENTRAL_CLOCK_FORMATTER.formatToParts(new Date(nowMs));
  for (let i = 0; i < list.length; i++) {
    if (list[i].type !== 'literal') {
      parts[list[i].type] = parseInt(list[i].value, 10);
    }
  }
  const hour = parts.hour === 24 ? 0 : parts.hour;
  return {
    dateStr: padNumber(parts.year, 4) + '-' + padNumber(parts.month, 2) + '-' + padNumber(parts.day, 2),
    secondsOfDay: hour * 3600 + parts.minute * 60 + parts.second,
  };
}

// Seconds until the page should reload while a slide is showing: the next slot
// boundary, but never later than just after midnight, so a slide that expires
// (or starts) at midnight is picked up promptly.
function getSlideRefreshSeconds(secondsOfDay) {
  const slotIndex = Math.floor(secondsOfDay / SLOT_SECONDS);
  const toNextSlot = (slotIndex + 1) * SLOT_SECONDS - secondsOfDay;
  const toMidnight = SECONDS_PER_DAY - secondsOfDay;
  const refresh = Math.max(MIN_REFRESH_SECONDS, toNextSlot + 1);
  return Math.min(refresh, toMidnight + 1);
}

// Seconds until the "no current slides" screen re-checks the folder: a fixed
// interval, but never later than just after midnight (a slide may start then).
function getNoSlidesRefreshSeconds(secondsOfDay) {
  const toMidnight = SECONDS_PER_DAY - secondsOfDay;
  return Math.min(NO_SLIDES_REFRESH_SECONDS, toMidnight + 1);
}

// =============================================================================
// FILE NAME PARSING AND SLIDE SELECTION
// =============================================================================

// True when the string is a real calendar date (rejects 2026-02-30, month 13).
// Years outside 2000-2100 are treated as typos.
function isRealDate(dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10);
  const day = parseInt(dateStr.slice(8, 10), 10);
  if (year < 2000 || year > 2100) {
    return false;
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

// True when the file name is the reserved QR code image name.
function isQrFileName(name) {
  return QR_NAME_PATTERN.test(name);
}

// True when Drive reports that an image has more pixels than MAX_IMAGE_PIXELS.
// Drive fills in the dimensions shortly after an upload, so a missing value is
// allowed rather than blocked.
//   imageMediaMetadata: the Drive field { width, height } or undefined
function exceedsPixelLimit(imageMediaMetadata) {
  if (!imageMediaMetadata) {
    return false;
  }
  const width = Number(imageMediaMetadata.width);
  const height = Number(imageMediaMetadata.height);
  if (!(width > 0 && height > 0)) {
    return false;
  }
  return width * height > MAX_IMAGE_PIXELS;
}

// Parses a slide file name into its date rule.
// Returns { ok: true, start: 'YYYY-MM-DD' | null, end: 'YYYY-MM-DD' | null }
// or { ok: false, reason: '...' }. A null start means "already started"; a
// null end means "never expires".
function parseSlideFileName(name) {
  let match = RANGE_NAME_PATTERN.exec(name);
  if (match) {
    if (!isRealDate(match[1])) {
      return { ok: false, reason: 'start date is not a real date' };
    }
    if (!isRealDate(match[2])) {
      return { ok: false, reason: 'end date is not a real date' };
    }
    if (match[2] < match[1]) {
      return { ok: false, reason: 'end date is before start date' };
    }
    return { ok: true, start: match[1], end: match[2] };
  }

  match = UNTIL_NAME_PATTERN.exec(name);
  if (match) {
    if (!isRealDate(match[1])) {
      return { ok: false, reason: 'end date is not a real date' };
    }
    return { ok: true, start: null, end: match[1] };
  }

  if (ALWAYS_NAME_PATTERN.test(name)) {
    return { ok: true, start: null, end: null };
  }

  return { ok: false, reason: 'name does not match a recognized pattern' };
}

// True when the date rule includes the given date. YYYY-MM-DD strings compare
// correctly as plain strings.
function isActiveOn(rule, dateStr) {
  if (rule.start !== null && dateStr < rule.start) {
    return false;
  }
  if (rule.end !== null && dateStr > rule.end) {
    return false;
  }
  return true;
}

// Ordering for the rotation: start date first (slides with no start date sort
// before dated ones), then file name, then file ID so the order never changes
// between page loads.
function compareSlides(a, b) {
  const aStart = a.start === null ? '0000-00-00' : a.start;
  const bStart = b.start === null ? '0000-00-00' : b.start;
  if (aStart !== bStart) {
    return aStart < bStart ? -1 : 1;
  }
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  if (aName !== bName) {
    return aName < bName ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

// Splits a Drive file listing into the slides active today and the QR image.
//   files:   [{ id, name, mimeType }] from the Drive listing
//   dateStr: today's Central date, YYYY-MM-DD
// Returns { activeSlides: [{ id, name, start, end }], qrFile: {id, name} | null }
// Non-image files (instructions, documents) are skipped silently. Image files
// with names that break the convention, or that are too large in pixels, are
// skipped and logged by name so the problem is easy to find in the Worker logs.
function classifyFiles(files, dateStr) {
  const activeSlides = [];
  const qrCandidates = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file || typeof file.id !== 'string' || typeof file.name !== 'string') {
      continue;
    }
    if (ALLOWED_IMAGE_TYPES.indexOf(file.mimeType) === -1) {
      continue;
    }
    if (exceedsPixelLimit(file.imageMediaMetadata)) {
      console.error(LOG_PREFIX + 'Ignored file "' + file.name + '": image has more than ' + MAX_IMAGE_PIXELS + ' pixels.');
      continue;
    }
    if (isQrFileName(file.name)) {
      qrCandidates.push({ id: file.id, name: file.name });
      continue;
    }
    const rule = parseSlideFileName(file.name);
    if (!rule.ok) {
      console.error(LOG_PREFIX + 'Ignored file "' + file.name + '": ' + rule.reason + '.');
      continue;
    }
    if (isActiveOn(rule, dateStr)) {
      activeSlides.push({ id: file.id, name: file.name, start: rule.start, end: rule.end });
    }
  }

  activeSlides.sort(compareSlides);

  // If more than one QR image exists, use the first by name and say so.
  qrCandidates.sort(function (a, b) {
    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
  });
  if (qrCandidates.length > 1) {
    console.error(LOG_PREFIX + 'More than one QR code image found; using "' + qrCandidates[0].name + '".');
  }

  return {
    activeSlides: activeSlides,
    qrFile: qrCandidates.length > 0 ? qrCandidates[0] : null,
  };
}

// Picks the slide whose turn it is. Depends only on the clock.
function pickSlide(activeSlides, secondsOfDay) {
  const slotIndex = Math.floor(secondsOfDay / SLOT_SECONDS);
  return activeSlides[slotIndex % activeSlides.length];
}

// =============================================================================
// GOOGLE DRIVE ACCESS
// =============================================================================

// Checks that every required secret is present and the folder ID is well
// formed. Returns a short description of the first problem found (never a
// secret value), or null when the configuration is valid.
function findConfigProblem(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    return 'GOOGLE_SERVICE_ACCOUNT_EMAIL is not set';
  }
  if (!env.GOOGLE_PRIVATE_KEY) {
    return 'GOOGLE_PRIVATE_KEY is not set';
  }
  if (!env.GOOGLE_DRIVE_FOLDER_ID) {
    return 'GOOGLE_DRIVE_FOLDER_ID is not set';
  }
  if (!DRIVE_ID_PATTERN.test(env.GOOGLE_DRIVE_FOLDER_ID)) {
    return 'GOOGLE_DRIVE_FOLDER_ID is not a valid Drive ID';
  }
  return null;
}

// Requests a short-lived read-only access token for the service account.
function requestAccessToken(env) {
  return getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY, DRIVE_SCOPE);
}

// Lists the non-folder files directly inside the slide folder.
// Throws on any failure so the caller can fall back to the no-slides screen.
// The folder ID was validated against DRIVE_ID_PATTERN before this is called,
// so it is safe to place inside the query string.
async function listFolderFiles(folderId, accessToken) {
  const query =
    "'" + folderId + "' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false";
  const requestUrl =
    DRIVE_FILES_URL +
    '?q=' + encodeURIComponent(query) +
    '&fields=' + encodeURIComponent('nextPageToken,files(id,name,mimeType,imageMediaMetadata(width,height))') +
    '&pageSize=' + DRIVE_PAGE_SIZE;

  const res = await fetchWithTimeout(
    requestUrl,
    { headers: { Authorization: 'Bearer ' + accessToken }, cf: { cacheTtl: 0 } },
    GOOGLE_FETCH_TIMEOUT_MS
  );
  if (!res.ok) {
    throw new Error('Drive listing failed with status ' + res.status);
  }
  const data = await res.json();
  if (data.nextPageToken) {
    console.error(LOG_PREFIX + 'Folder has more than ' + DRIVE_PAGE_SIZE + ' files; the extra files are ignored. Remove old files.');
  }
  return Array.isArray(data.files) ? data.files : [];
}

// =============================================================================
// HTML GENERATION
// =============================================================================

// Wraps body HTML in a complete page sized to the layout.
//   layout:         { width, height }
//   darkBg:         true for a solid dark background, false for transparent
//   refreshSeconds: meta-refresh interval
//   extraCss:       page-specific CSS
//   headScript:     optional <script> element for <head>
//   bodyHtml:       page content
function buildDocument(layout, darkBg, refreshSeconds, extraCss, headScript, bodyHtml) {
  const background = darkBg ? DARK_BG_COLOR : 'transparent';
  return (
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="UTF-8">' +
    '<meta http-equiv="refresh" content="' + Math.ceil(refreshSeconds) + '">' +
    '<meta name="viewport" content="width=' + layout.width + ', height=' + layout.height + '">' +
    '<title>Newsletter Slides</title>' +
    '<style>' +
    '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }' +
    'html, body { width: ' + layout.width + 'px; height: ' + layout.height + 'px; overflow: hidden;' +
    ' background: ' + background + '; font-family: ' + FONT_STACK + '; }' +
    extraCss +
    '</style>' +
    headScript +
    '</head>' +
    '<body>' + bodyHtml + '</body>' +
    '</html>'
  );
}

// CSS for the centred message block used by the no-slides and error screens,
// scaled from the layout so it reads correctly at every size.
function buildMessageCss(layout) {
  const base = Math.min(layout.width, layout.height);
  const qrSize = Math.floor(base * 0.55);
  return (
    '.msg { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;' +
    ' gap: ' + Math.floor(base * 0.08) + 'px; padding: 0 ' + Math.floor(base * 0.06) + 'px; text-align: center; }' +
    '.msg-text { display: flex; flex-direction: column; align-items: center; gap: ' + Math.floor(base * 0.025) + 'px; }' +
    '.msg-title { font-size: ' + Math.floor(base * 0.055) + 'px; font-weight: 700; letter-spacing: 0.06em;' +
    ' color: ' + ACCENT_COLOR + '; }' +
    '.msg-body { font-size: ' + Math.floor(base * 0.035) + 'px; color: ' + TEXT_PRIMARY + '; }' +
    '.msg-caption { font-size: ' + Math.floor(base * 0.028) + 'px; color: ' + TEXT_SECONDARY + '; }' +
    '.msg-qr { display: flex; flex-direction: column; align-items: center; gap: ' + Math.floor(base * 0.015) + 'px; }' +
    '.msg-qr img { display: block; width: ' + qrSize + 'px; height: ' + qrSize + 'px; object-fit: contain;' +
    ' background: ' + QR_TILE_COLOR + '; padding: ' + Math.floor(qrSize * 0.04) + 'px; }'
  );
}

// Builds the message block shown on the no-slides and error screens.
//   title, message: text lines (escaped here)
//   qrFile:         { id } of the QR image, or null for no QR code
//   options:        { id: element id | null, hidden: boolean, deferQr: boolean }
//     deferQr leaves the QR image's src empty (the URL goes in data-src) so a
//     hidden block does not download the image until it is actually shown.
function buildMessageBlock(title, message, qrFile, options) {
  const idAttr = options.id ? ' id="' + options.id + '"' : '';
  const styleAttr = options.hidden ? ' style="display: none;"' : '';

  let qrHtml = '';
  if (qrFile && DRIVE_ID_PATTERN.test(qrFile.id)) {
    const qrUrl = '/image/' + encodeURIComponent(qrFile.id);
    const srcAttrs = options.deferQr
      ? ' data-src="' + escapeHtml(qrUrl) + '"'
      : ' src="' + escapeHtml(qrUrl) + '"';
    qrHtml =
      '<div class="msg-qr">' +
      '<img' + srcAttrs + ' alt="QR code" onerror="this.parentNode.style.display=\'none\'">' +
      (NO_SLIDES_QR_CAPTION ? '<div class="msg-caption">' + escapeHtml(NO_SLIDES_QR_CAPTION) + '</div>' : '') +
      '</div>';
  }

  return (
    '<div class="msg"' + idAttr + styleAttr + '>' +
    '<div class="msg-text">' +
    '<div class="msg-title">' + escapeHtml(title) + '</div>' +
    (message ? '<div class="msg-body">' + escapeHtml(message) + '</div>' : '') +
    '</div>' +
    qrHtml +
    '</div>'
  );
}

// Complete "no current slides" page (also used when Drive cannot be read).
function buildNoSlidesPage(layout, darkBg, refreshSeconds, qrFile) {
  return buildDocument(
    layout,
    darkBg,
    refreshSeconds,
    buildMessageCss(layout),
    '',
    buildMessageBlock(NO_SLIDES_TITLE, NO_SLIDES_MESSAGE, qrFile, { id: null, hidden: false, deferQr: false })
  );
}

// Complete configuration-error page. Names the problem (never a secret value).
function buildConfigErrorPage(layout, darkBg, detail) {
  return buildDocument(
    layout,
    darkBg,
    ERROR_RETRY_SECONDS,
    buildMessageCss(layout),
    '',
    buildMessageBlock('CONFIGURATION ERROR', detail, null, { id: null, hidden: false, deferQr: false })
  );
}

// Complete slide page. The slide fills the layout (letterboxed if its shape
// differs). If the image fails to load it is retried once after
// IMAGE_RETRY_DELAY_MS; if it fails again the page swaps to the no-slides
// screen and reloads itself after ERROR_RETRY_SECONDS.
function buildSlidePage(layout, darkBg, refreshSeconds, slide, qrFile) {
  const slideUrl = '/image/' + encodeURIComponent(slide.id);

  const css =
    buildMessageCss(layout) +
    '.slide { display: block; width: 100%; height: 100%; object-fit: contain; }';

  const script =
    '<script>' +
    'var retried = false;' +
    'function slideError(img) {' +
    ' if (!retried) {' +
    '  retried = true;' +
    '  setTimeout(function () { img.src = img.getAttribute("data-src") + "?retry=1"; }, ' + IMAGE_RETRY_DELAY_MS + ');' +
    '  return;' +
    ' }' +
    ' img.style.display = "none";' +
    ' var fb = document.getElementById("fallback");' +
    ' var qr = fb.querySelector("img[data-src]");' +
    ' if (qr) { qr.src = qr.getAttribute("data-src"); }' +
    ' fb.style.display = "flex";' +
    ' setTimeout(function () { location.reload(); }, ' + (ERROR_RETRY_SECONDS * 1000) + ');' +
    '}' +
    '</script>';

  const body =
    '<img class="slide" src="' + escapeHtml(slideUrl) + '" data-src="' + escapeHtml(slideUrl) + '"' +
    ' alt="" onerror="slideError(this)">' +
    buildMessageBlock(NO_SLIDES_TITLE, NO_SLIDES_MESSAGE, qrFile, { id: 'fallback', hidden: true, deferQr: true });

  return buildDocument(layout, darkBg, refreshSeconds, css, script, body);
}

// =============================================================================
// RESPONSE HELPERS
// =============================================================================

// HTML response. Never cached, so the clock always decides what is shown.
function htmlResponse(request, html, status) {
  return new Response(request.method === 'HEAD' ? null : html, {
    status: status,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// Plain-text response for errors and the health check.
function textResponse(request, text, status) {
  return new Response(request.method === 'HEAD' ? null : text, {
    status: status,
    headers: {
      'Content-Type': 'text/plain; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// =============================================================================
// ROUTE: DISPLAY PAGE  ( / )
// =============================================================================

async function handleDisplay(request, env, url) {
  // Layout and background options. hasOwnProperty avoids inherited names such
  // as "constructor" being accepted as a layout.
  const layoutParam = sanitizeParam(url.searchParams.get('layout'));
  const layoutKey =
    layoutParam && Object.prototype.hasOwnProperty.call(LAYOUTS, layoutParam)
      ? layoutParam
      : DEFAULT_LAYOUT_KEY;
  const layout = LAYOUTS[layoutKey];
  const darkBg = sanitizeParam(url.searchParams.get('bg')) === 'dark';

  const configProblem = findConfigProblem(env);
  if (configProblem) {
    console.error(LOG_PREFIX + 'Configuration problem: ' + configProblem + '.');
    return htmlResponse(request, buildConfigErrorPage(layout, darkBg, configProblem), 200);
  }

  const clock = getCentralClock(Date.now());

  // Read the folder. Any failure shows the no-slides screen and retries soon.
  let classified;
  try {
    const accessToken = await requestAccessToken(env);
    const files = await listFolderFiles(env.GOOGLE_DRIVE_FOLDER_ID, accessToken);
    classified = classifyFiles(files, clock.dateStr);
  } catch (err) {
    console.error(LOG_PREFIX + 'Could not read the slide folder: ' + (err && err.message ? err.message : String(err)));
    return htmlResponse(request, buildNoSlidesPage(layout, darkBg, ERROR_RETRY_SECONDS, null), 200);
  }

  // Nothing active today: show the no-slides screen (with the QR code if any).
  if (classified.activeSlides.length === 0) {
    const refresh = getNoSlidesRefreshSeconds(clock.secondsOfDay);
    return htmlResponse(request, buildNoSlidesPage(layout, darkBg, refresh, classified.qrFile), 200);
  }

  const slide = pickSlide(classified.activeSlides, clock.secondsOfDay);
  const refresh = getSlideRefreshSeconds(clock.secondsOfDay);
  return htmlResponse(request, buildSlidePage(layout, darkBg, refresh, slide, classified.qrFile), 200);
}

// =============================================================================
// ROUTE: IMAGE PROXY  ( /image/{fileId} )
// =============================================================================

// Streams one image from Drive, but only if it is a file the display is
// allowed to show. Responses use generic status codes and reveal nothing
// about files that are refused.
async function handleImage(request, env, url) {
  const fileId = url.pathname.slice('/image/'.length);
  if (!DRIVE_ID_PATTERN.test(fileId)) {
    return textResponse(request, 'Not found', 404);
  }

  const configProblem = findConfigProblem(env);
  if (configProblem) {
    console.error(LOG_PREFIX + 'Configuration problem: ' + configProblem + '.');
    return textResponse(request, 'Service not configured', 503);
  }

  try {
    const accessToken = await requestAccessToken(env);
    const authHeaders = { Authorization: 'Bearer ' + accessToken };
    const fileUrl = DRIVE_FILES_URL + '/' + encodeURIComponent(fileId);

    // Step 1: look at the file's details before sending a single byte.
    const metaRes = await fetchWithTimeout(
      fileUrl + '?fields=' + encodeURIComponent('id,name,mimeType,size,parents,trashed,imageMediaMetadata(width,height)'),
      { headers: authHeaders, cf: { cacheTtl: 0 } },
      GOOGLE_FETCH_TIMEOUT_MS
    );
    if (metaRes.status === 404) {
      return textResponse(request, 'Not found', 404);
    }
    if (!metaRes.ok) {
      console.error(LOG_PREFIX + 'Image details request failed with status ' + metaRes.status + '.');
      return textResponse(request, 'Upstream error', 502);
    }
    const meta = await metaRes.json();

    // Step 2: the file must be in the configured folder, not in the trash, and
    // an allowed image type.
    const inFolder = Array.isArray(meta.parents) && meta.parents.indexOf(env.GOOGLE_DRIVE_FOLDER_ID) !== -1;
    if (!inFolder || meta.trashed || ALLOWED_IMAGE_TYPES.indexOf(meta.mimeType) === -1 || typeof meta.name !== 'string') {
      return textResponse(request, 'Not found', 404);
    }

    // Step 3: it must be today's slide or the QR code image.
    let allowed = isQrFileName(meta.name);
    if (!allowed) {
      const rule = parseSlideFileName(meta.name);
      allowed = rule.ok && isActiveOn(rule, getCentralClock(Date.now()).dateStr);
    }
    if (!allowed) {
      return textResponse(request, 'Not found', 404);
    }

    // Step 4: size caps (bytes and pixels).
    const size = parseInt(meta.size, 10);
    if (isNaN(size) || size > MAX_IMAGE_BYTES || exceedsPixelLimit(meta.imageMediaMetadata)) {
      return textResponse(request, 'Image too large', 413);
    }

    const headers = {
      'Content-Type': meta.mimeType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers: headers });
    }

    // Step 5: stream the image straight through (no buffering, no encoding).
    const mediaRes = await fetchWithTimeout(
      fileUrl + '?alt=media',
      { headers: authHeaders, cf: { cacheTtl: 0 } },
      GOOGLE_FETCH_TIMEOUT_MS
    );
    if (!mediaRes.ok || !mediaRes.body) {
      console.error(LOG_PREFIX + 'Image download failed with status ' + mediaRes.status + '.');
      return textResponse(request, 'Upstream error', 502);
    }
    return new Response(mediaRes.body, { status: 200, headers: headers });
  } catch (err) {
    console.error(LOG_PREFIX + 'Image request failed: ' + (err && err.message ? err.message : String(err)));
    return textResponse(request, 'Upstream error', 502);
  }
}

// =============================================================================
// ROUTE: HEALTH CHECK  ( /healthz )
// =============================================================================

// Same pattern as the other Workers: confirm Google's token endpoint is
// reachable. A bogus grant type returns 400, which proves the endpoint is up.
// Returns 200 when healthy, 503 when degraded. Supports GET and HEAD.
async function handleHealth(request) {
  let status = 'healthy';
  let detail;

  try {
    const probe = await fetchWithTimeout(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=placeholder',
      },
      5000
    );
    if (probe.status === 400) {
      detail = 'google-apis: reachable';
    } else {
      status = 'degraded';
      detail = 'google-apis: unexpected status ' + probe.status;
    }
  } catch (err) {
    status = 'degraded';
    detail = 'google-apis: unreachable (' + (err && err.name ? err.name : 'error') + ')';
  }

  const body = 'status: ' + status + '\n' + 'worker: ' + WORKER_NAME + '\n' + detail + '\n';
  return textResponse(request, body, status === 'healthy' ? 200 : 503);
}

// =============================================================================
// ENTRY POINT
// =============================================================================

export default {
  async fetch(request, env) {
    // Read-only service: only GET and HEAD are accepted.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(request, 'Method not allowed', 405);
    }

    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return handleHealth(request);
    }
    if (url.pathname.indexOf('/image/') === 0) {
      return handleImage(request, env, url);
    }
    if (url.pathname === '/') {
      return handleDisplay(request, env, url);
    }
    return textResponse(request, 'Not found', 404);
  },
};
