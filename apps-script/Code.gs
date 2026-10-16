// Google Apps Script: sends approved tasks by email from hod_bme@kpriet.ac.in
// and logs them to a Google Sheet. Deploy as Web App (Execute as: Me, Access: Anyone).
const SECRET = 'change-this-to-a-long-random-text';   // paste the same value in the app's Admin page
const LOG_SHEET_ID = '';                              // optional: Google Sheet ID for a log

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) return out({ ok: false, error: 'Bad secret' });
    const t = data.task;
    data.recipients.forEach(r => {
      if (r.email) GmailApp.sendEmail(r.email, r.subject, r.body, { name: 'HoD - BME, KPRIET' });
    });
    if (t.dueDate) addCalendar_(t, data.recipients);
    if (LOG_SHEET_ID) SpreadsheetApp.openById(LOG_SHEET_ID).getSheets()[0].appendRow([
      new Date(), t.type, t.title, t.details, t.dueDate, t.dueTime, t.priority,
      data.recipients.map(r => r.name).join(', ')
    ]);
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

// Adds a calendar invite for the faculty (they get it in their Google Calendar).
function addCalendar_(t, recipients) {
  const start = new Date(t.dueDate + 'T' + (t.dueTime || '09:00') + ':00');
  const end = new Date(start.getTime() + 30 * 60000);
  CalendarApp.getDefaultCalendar().createEvent('[' + t.type + '] ' + t.title, start, end, {
    description: t.details || '',
    guests: recipients.map(r => r.email).filter(Boolean).join(','),
    sendInvites: true
  });
}

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
