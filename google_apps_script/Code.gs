// Google Apps Script backend for sensor_logger.ino.
//
// Setup: open the Google Sheet > Extensions > Apps Script, paste this file,
// set TOKEN, then Deploy > New deployment > Web app with
// "Execute as: Me" and "Who has access: Anyone". Copy the /exec URL into secrets.h.
//
// POST (from the logger): appends one row with a server-side timestamp.
// GET  (for the website): returns the latest rows as JSON, e.g. <url>?n=500

const TOKEN = 'change-me';        // must match SHEETS_TOKEN in secrets.h
const SHEET_NAME = 'data';
const MAX_ROWS_PER_GET = 20000;   // ~7 days at one row per 40 s

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.token !== TOKEN) return json_({ ok: false, error: 'bad token' });

  const sheet = getSheet_();
  if (sheet.getLastRow() === 0) sheet.appendRow(['timestamp', ...body.columns]);
  sheet.appendRow([new Date(), ...body.values]);
  return json_({ ok: true });
}

function doGet(e) {
  const n = Math.min(Number(e.parameter.n) || 500, MAX_ROWS_PER_GET);
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return json_({ columns: [], rows: [] });

  const numCols = sheet.getLastColumn();
  const columns = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  const firstRow = Math.max(2, lastRow - n + 1);
  const rows = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, numCols).getValues();
  return json_({ columns, rows });
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
