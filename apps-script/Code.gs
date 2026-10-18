/**
 * HoD Task Handler — cloud backend (Google Apps Script bound to the Google Sheet).
 *
 * The Google Sheet is the main storage. The Android app and the desktop (Python) app
 * keep an offline copy and sync with this script whenever they are online.
 * Run setup() once from the Apps Script editor; see README.md.
 *
 * Actions per entry (column "actions", comma separated):
 *   calendar  -> Google Calendar event on the date/time, faculty invited
 *   email     -> email to each assigned faculty member
 *   whatsapp  -> WhatsApp message (WhatsApp Cloud API if configured, else the apps open WhatsApp)
 *   reminder  -> reminder popup on desktop + phone at remindAt (also a Calendar popup)
 * Actions run once, when the entry's status becomes "approved".
 */

const FACULTY_COLS = ['id', 'name', 'initials', 'phone', 'email', 'deleted', 'updated', 'synced'];
const ENTRY_COLS = ['id', 'created', 'updated', 'synced', 'device', 'type', 'title', 'details', 'faculty',
  'date', 'time', 'priority', 'actions', 'remindAt', 'status', 'processed', 'log', 'deleted'];
const STATUSES = ['review', 'approved', 'done', 'cancelled'];

/* ------------------------------------------------------------------ setup */

function setup() {
  const ss = SpreadsheetApp.getActive();
  sheet_('Faculty', FACULTY_COLS);
  sheet_('Entries', ENTRY_COLS);
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  // Picks up rows you approve by typing directly in the Sheet.
  ScriptApp.newTrigger('processPending').timeBased().everyMinutes(5).create();
  Logger.log('Setup done. Your app TOKEN is: ' + props.getProperty('TOKEN'));
  Logger.log('Sheet: ' + ss.getUrl());
}

function sheet_(name, cols) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@'); // keep dates as plain text
  const head = sh.getRange(1, 1, 1, cols.length);
  if (head.getValues()[0].join() !== cols.join()) head.setValues([cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

/* -------------------------------------------------------------- web API */

function doGet(e) {
  return handle_(() => {
    auth_(e.parameter.token);
    return pull_(Number(e.parameter.since || 0));
  });
}

// Body: {token, device, since, ops:[{op:'upsertEntry', entry}|{op:'upsertFaculty', faculty}]}
function doPost(e) {
  return handle_(() => {
    const body = JSON.parse(e.postData.contents);
    auth_(body.token);
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    const results = [];
    try {
      (body.ops || []).forEach(op => {
        try {
          if (op.op === 'upsertEntry') upsert_('Entries', ENTRY_COLS, Object.assign({ device: body.device || '' }, op.entry));
          else if (op.op === 'upsertFaculty') upsert_('Faculty', FACULTY_COLS, op.faculty);
          else throw new Error('Unknown op ' + op.op);
          results.push({ ok: true });
        } catch (err) { results.push({ ok: false, error: String(err) }); }
      });
      SpreadsheetApp.flush();
    } finally { lock.releaseLock(); }
    processPending(); // run actions for anything just approved
    return Object.assign({ results: results }, pull_(Number(body.since || 0)));
  });
}

function handle_(fn) {
  let out;
  try { out = Object.assign({ ok: true }, fn()); } catch (err) { out = { ok: false, error: String(err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function auth_(token) {
  const t = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!t || token !== t) throw new Error('Invalid token');
}

/* ------------------------------------------------------------ data layer */

function rows_(name, cols) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  const vals = sh.getDataRange().getValues().slice(1);
  return vals.map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => o[c] = text_(r[j]));
    return o;
  }).filter(o => o.id || o.title || o.name);
}

// Cells typed by hand may come back as Date objects; normalise to text.
function text_(v) {
  if (v instanceof Date) {
    const tz = Session.getScriptTimeZone();
    return v.getHours() || v.getMinutes() ? Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm") : Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  return v === null || v === undefined ? '' : String(v);
}

function write_(name, cols, obj) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  const row = cols.map(c => obj[c] === undefined || obj[c] === null ? '' : String(obj[c]));
  if (obj._row) sh.getRange(obj._row, 1, 1, cols.length).setValues([row]);
  else sh.appendRow(row);
}

// Last write wins, by the client's "updated" time. Server-only fields are protected.
function upsert_(name, cols, incoming) {
  if (!incoming || !incoming.id) throw new Error('Missing id');
  const existing = rows_(name, cols).find(r => r.id === incoming.id);
  const now = Date.now();
  if (existing && Number(existing.updated || 0) > Number(incoming.updated || 0)) return; // older edit, ignore
  const merged = Object.assign({}, existing || {}, incoming, { synced: now });
  if (!merged.updated) merged.updated = now;
  if (name === 'Entries') {
    if (!merged.created) merged.created = now;
    if (existing) { merged.processed = existing.processed; merged.log = existing.log; } // set only by server
    if (existing && existing.processed && merged.status === 'review') merged.status = 'approved'; // already sent
    if (STATUSES.indexOf(merged.status) < 0) merged.status = 'review';
  }
  if (name === 'Faculty') merged.initials = String(merged.initials || '').toUpperCase().trim();
  write_(name, cols, merged);
}

function pull_(since) {
  const strip = r => { const o = Object.assign({}, r); delete o._row; return o; };
  return {
    serverTime: Date.now(),
    faculty: rows_('Faculty', FACULTY_COLS).filter(r => Number(r.synced || 0) > since).map(strip),
    entries: rows_('Entries', ENTRY_COLS).filter(r => Number(r.synced || 0) > since).map(strip)
  };
}

/* --------------------------------------------------------------- actions */

function processPending() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const faculty = rows_('Faculty', FACULTY_COLS).filter(f => f.deleted !== 'true');
    rows_('Entries', ENTRY_COLS).forEach(en => {
      if (!en.id && en.title) { en.id = Utilities.getUuid(); en.created = en.updated = Date.now(); } // typed in the Sheet
      if (en.status !== 'approved' || en.processed || en.deleted === 'true') {
        if (!en.synced && en.id) { en.synced = Date.now(); write_('Entries', ENTRY_COLS, en); }
        return;
      }
      const people = assigned_(en, faculty);
      const acts = String(en.actions || '').toLowerCase().split(/[,\s]+/).filter(String);
      const log = [];
      const step = (label, fn) => { try { log.push(label + ': ' + fn()); } catch (err) { log.push(label + ' FAILED: ' + err); } };
      if (acts.indexOf('calendar') >= 0) step('calendar', () => calendarEvent_(en, people));
      if (acts.indexOf('email') >= 0) step('email', () => email_(en, people));
      if (acts.indexOf('whatsapp') >= 0) step('whatsapp', () => whatsapp_(en, people));
      if (acts.indexOf('reminder') >= 0) step('reminder', () => reminder_(en));
      en.processed = new Date().toISOString();
      en.log = log.join(' | ') || 'saved';
      en.synced = Date.now();
      write_('Entries', ENTRY_COLS, en);
    });
  } finally { lock.releaseLock(); }
}

function assigned_(en, faculty) {
  let codes = String(en.faculty || '').toUpperCase().split(/[,\s]+/).filter(String);
  if (!codes.length) codes = ((en.title + ' ' + en.details).match(/@([A-Za-z0-9]+)/g) || []).map(s => s.slice(1).toUpperCase());
  return faculty.filter(f => codes.indexOf(f.initials) >= 0);
}

function when_(en) {
  const m = String(en.date || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = String(en.time || '').match(/(\d{1,2}):(\d{2})/);
  return { date: new Date(+m[1], +m[2] - 1, +m[3], t ? +t[1] : 9, t ? +t[2] : 0), hasTime: !!t };
}

function due_(en) { return [en.date, en.time].filter(String).join(' ') || 'No deadline'; }

function message_(en, f) {
  return 'Dear ' + f.name + ',\n\nYou have been assigned the following by the HoD, BME:\n\n' +
    'Category: ' + en.type + '\nTitle: ' + en.title + '\nDue: ' + due_(en) + '\nPriority: ' + (en.priority || 'Normal') + '\n' +
    (en.details ? '\nDetails:\n' + en.details + '\n' : '') + '\nRegards,\nHoD – Biomedical Engineering\nKPRIET';
}

function calendarEvent_(en, people) {
  const w = when_(en);
  if (!w) return 'skipped (no date)';
  const cal = CalendarApp.getDefaultCalendar();
  const opts = { description: (en.details || '') + '\n\nAssigned: ' + people.map(p => p.name).join(', '),
    guests: people.map(p => p.email).filter(String).join(','), sendInvites: true };
  const title = '[' + en.type + '] ' + en.title;
  const ev = w.hasTime ? cal.createEvent(title, w.date, new Date(w.date.getTime() + 3600e3), opts) : cal.createAllDayEvent(title, w.date, opts);
  ev.addPopupReminder(30);
  return 'event created';
}

function email_(en, people) {
  const sent = people.filter(p => p.email).map(p => {
    MailApp.sendEmail({ to: p.email, subject: '[' + en.type + '] ' + en.title + ' — due ' + due_(en), body: message_(en, p), name: 'HoD - BME, KPRIET' });
    return p.initials;
  });
  return sent.length ? 'sent to ' + sent.join(',') : 'no email addresses';
}

// WhatsApp Cloud API (Meta). Set script properties WA_TOKEN, WA_PHONE_ID, WA_TEMPLATE (body with 4 params:
// name, title, due, details) and optionally WA_LANG. Without them the apps open WhatsApp for you to tap Send.
function whatsapp_(en, people) {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty('WA_TOKEN'), phoneId = p.getProperty('WA_PHONE_ID'), tpl = p.getProperty('WA_TEMPLATE');
  if (!token || !phoneId || !tpl) return 'manual (open from app)';
  const sent = people.filter(f => f.phone).map(f => {
    let to = String(f.phone).replace(/\D/g, ''); if (to.length === 10) to = '91' + to;
    const params = [f.name, en.title, due_(en), (en.details || '-').slice(0, 900)].map(t => ({ type: 'text', text: String(t) }));
    const res = UrlFetchApp.fetch('https://graph.facebook.com/v20.0/' + phoneId + '/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ messaging_product: 'whatsapp', to: to, type: 'template',
        template: { name: tpl, language: { code: p.getProperty('WA_LANG') || 'en' }, components: [{ type: 'body', parameters: params }] } })
    });
    if (res.getResponseCode() >= 300) throw new Error(f.initials + ' ' + res.getContentText().slice(0, 200));
    return f.initials;
  });
  return 'sent to ' + sent.join(',');
}

// Clients pop up the reminder themselves; the Calendar popup is a backup that also rings on every device.
function reminder_(en) {
  const at = String(en.remindAt || '').match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  const w = at ? { date: new Date(+at[1], +at[2] - 1, +at[3], +at[4], +at[5]) } : when_(en);
  if (!w) return 'skipped (no time)';
  const ev = CalendarApp.getDefaultCalendar().createEvent('⏰ ' + en.title, w.date, new Date(w.date.getTime() + 15 * 60e3), { description: en.details || '' });
  ev.removeAllReminders(); ev.addPopupReminder(0);
  return 'set for ' + Utilities.formatDate(w.date, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

// Edits typed directly in the Sheet are pushed to the apps on their next sync.
function onEdit(e) {
  const sh = e.range.getSheet();
  const cols = sh.getName() === 'Entries' ? ENTRY_COLS : sh.getName() === 'Faculty' ? FACULTY_COLS : null;
  if (!cols || e.range.getLastRow() < 2) return;
  const first = Math.max(2, e.range.getRow()), n = e.range.getLastRow() - first + 1, now = String(Date.now());
  ['updated', 'synced'].forEach(c => sh.getRange(first, cols.indexOf(c) + 1, n, 1).setValues(Array(n).fill([now])));
}
