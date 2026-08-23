/**
 * domdupuy.com — web traffic log.
 *
 * Replaces the user_data.csv that server.js used to append to. Receives one
 * JSON POST per page view from the Express server (never from the browser, so
 * the shared token below stays server-side) and appends a row to the traffic
 * spreadsheet. Also serves the visitor count the site's WATCHERS readout shows.
 *
 * Column layout, chosen to carry over the three columns the CSV already had
 * (Date, User Agent, IP) and add the fields the CSV had no room for:
 *
 *   A  Timestamp     ISO 8601, server clock
 *   B  IP            public IP, from api.ipify.org via the browser
 *   C  User Agent    raw UA string
 *   D  Path          request path, e.g. "/" or "/?source=home"
 *   E  Referrer      document.referrer, blank on direct hits
 *   F  Source        the ?source= query param, or "direct"
 *
 * A header row IS written on the first append here (unlike the GQH sheet),
 * because this spreadsheet starts empty — nothing exists to shift down.
 *
 * Setup:
 *   1. Paste this file into Code.gs and save. SPREADSHEET_ID below already
 *      points at the traffic spreadsheet.
 *   2. Project Settings (gear icon) -> Script Properties -> Add script
 *      property: name TRAFFIC_TOKEN, value = the same long random string as
 *      the server's SHEETS_TOKEN environment variable.
 *   3. Deploy -> New deployment -> Web app.
 *        Execute as:       Me
 *        Who has access:   Anyone
 *      "Anyone" is required — the Express server calls this unauthenticated.
 *      The token is what keeps strangers from writing rows.
 *   5. Copy the /exec URL into the server's SHEETS_WEBAPP_URL variable.
 *
 * Redeploying after an edit: Deploy -> Manage deployments -> pencil ->
 * Version: "New version" -> Deploy. The /exec URL does not change, so the
 * server's environment variables stay as they are.
 *
 * As with the GQH endpoint, anonymous web app executions do not show up in the
 * editor's Executions list. Use the GET probes on doGet() to diagnose instead.
 */

var SPREADSHEET_ID = '1Ls-Ix3La3pHduI7w06JYkHXBK1lkjH1bZRiEV0-acLU';

/**
 * Shared secret, read from Script Properties rather than hardcoded, because
 * this file lives in a public GitHub repo — a token committed here would be
 * readable by anyone and let them POST fake rows at the counter.
 *
 * Set it once: Project Settings (gear, left sidebar) -> Script Properties ->
 * Add script property -> name TRAFFIC_TOKEN, value = the server's
 * SHEETS_TOKEN. It survives redeploys; you only do this once.
 *
 * Unset, this returns null and every POST fails closed as 'bad token'.
 */
function trafficToken_() {
  return PropertiesService.getScriptProperties().getProperty('TRAFFIC_TOKEN');
}

// The CSV this replaces ended at 5,147 displayed visits (5,120 hardcoded
// offset + 27 logged rows). Starting the sheet's count from that number keeps
// the site's WATCHERS readout continuous across the migration instead of
// dropping back to zero. Lower it to 0 if you would rather count from scratch.
var COUNT_OFFSET = 5147;

// Collapse repeat hits from the same IP inside this many minutes into a single
// row. 0 logs every hit, which is what the CSV did — keep it at 0 unless the
// counter starts inflating from refreshes.
var DEDUPE_WINDOW_MINUTES = 0;

var SHEET_NAME = 'Traffic';
var HEADERS = ['Timestamp', 'IP', 'User Agent', 'Path', 'Referrer', 'Source'];

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    var expected = trafficToken_();
    if (!expected) {
      return jsonResponse_({ ok: false, error: 'TRAFFIC_TOKEN script property is not set' });
    }
    if (payload.token !== expected) {
      return jsonResponse_({ ok: false, error: 'bad token' });
    }

    var sheet = getSheet_();
    var ip = String(payload.ip || '').trim();

    if (isDuplicate_(sheet, ip)) {
      return jsonResponse_({ ok: true, deduped: true, count: readCount_(sheet) });
    }

    sheet.appendRow([
      payload.timestamp || new Date().toISOString(),
      ip,
      payload.userAgent || '',
      payload.path || '',
      payload.referrer || '',
      payload.source || 'direct',
    ]);

    // appendRow invalidates the cached count, so drop it rather than letting a
    // stale value sit there for the rest of its TTL.
    CacheService.getScriptCache().remove('traffic_count');

    return jsonResponse_({ ok: true, count: readCount_(sheet) });
  } catch (error) {
    console.error(error);
    return jsonResponse_({ ok: false, error: String(error) });
  }
}

/**
 * GET /exec           -> { count } , what the site's WATCHERS readout reads
 * GET /exec?diag=1    -> row count, offset, and effective user, for checking
 *                        that the deployment is pointed at the right sheet
 */
function doGet(e) {
  var params = (e && e.parameter) || {};

  if (params.diag) {
    var sheet = getSheet_();
    return jsonResponse_({
      ok: true,
      dataRows: Math.max(0, sheet.getLastRow() - 1),
      countOffset: COUNT_OFFSET,
      count: readCount_(sheet),
      spreadsheet: SpreadsheetApp.openById(SPREADSHEET_ID).getName(),
      effectiveUser: Session.getEffectiveUser().getEmail(),
      // Reports only whether the property exists, never its value — this
      // endpoint is public.
      tokenConfigured: Boolean(trafficToken_()),
    });
  }

  return jsonResponse_({ ok: true, count: readCount_(getSheet_()) });
}

/**
 * Visit count = logged rows (excluding the header) + the CSV-era offset.
 * Cached briefly because every page load asks for it, and getLastRow() on a
 * growing sheet is the slowest part of this endpoint.
 */
function readCount_(sheet) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('traffic_count');
  if (cached !== null) return Number(cached);

  var count = Math.max(0, sheet.getLastRow() - 1) + COUNT_OFFSET;
  cache.put('traffic_count', String(count), 30);
  return count;
}

/**
 * True when this IP was already logged inside the dedupe window. Scans only
 * the tail of the sheet — a full-column read would get slower every day.
 */
function isDuplicate_(sheet, ip) {
  if (!DEDUPE_WINDOW_MINUTES || !ip) return false;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  var start = Math.max(2, lastRow - 199);
  var rows = sheet.getRange(start, 1, lastRow - start + 1, 2).getValues();
  var cutoff = Date.now() - DEDUPE_WINDOW_MINUTES * 60 * 1000;

  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][1]).trim() !== ip) continue;
    var cell = rows[i][0];
    var ms = cell instanceof Date ? cell.getTime() : new Date(String(cell)).getTime();
    if (!isNaN(ms) && ms >= cutoff) return true;
  }
  return false;
}

/**
 * Opens the traffic sheet by ID, creating it and its header row on first use.
 * This project is standalone rather than container-bound, so
 * getActiveSpreadsheet() would return null.
 */
function getSheet_() {
  var spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonResponse_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON
  );
}
