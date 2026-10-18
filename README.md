# HoD Task Handler — BME, KPRIET

Record **things to do, new ideas, assignments, delegation of duty, events, reminders and other roles**.
Everything goes into **one Google Sheet**, which is the main cloud storage.

```
 Android app ─┐                           ┌─► Google Calendar  (events, faculty invited)
              ├─► Apps Script ─► Google ──┼─► Email            (to the assigned faculty)
 Desktop app ─┘   (web API)      Sheet    ├─► WhatsApp         (Cloud API, or one-tap from the apps)
 (Python)                                  └─► Reminders        (pop up on desktop + phone + Calendar)
```

* **Works offline.** Both apps save everything on the device. When the device is online they upload to the Sheet and pull changes made on the other devices.
* **Auto-assign.** Type `@RK` (or `RK` in capitals) and that faculty member is ticked.
* **Actions per entry.** Tick any of these:
  * **Add to Google Calendar**: creates an event on the date and time and invites the faculty.
  * **Send email**: emails the full details to each assigned faculty member.
  * **Send WhatsApp**: sent automatically if WhatsApp Cloud API is set up. Otherwise the app opens WhatsApp with the message typed and you tap Send.
  * **Remind me**: a reminder pops up on the desktop and on the phone at the "remind at" time. A Google Calendar popup is also added as a backup.
* **Review first.** Use *Save for review*, check the entry in the **Review** tab, then press *Approve & send*. Use *Save & approve* to send at once. Actions run once, when the entry is approved.
* **Faculty (Admin)** tab: name, initials, phone and email. You can edit them from the phone or the laptop.
* You can also type or edit rows directly in the Sheet. Set `status` to `approved` and the actions run within 5 minutes.

## 1. Google Sheet + Apps Script (once, about 10 min)

1. Signed in as **hod_bme@kpriet.ac.in**, create a new Google Sheet (for example *HoD Tasks*).
2. In the Sheet: **Extensions → Apps Script**. Delete the sample code and paste [`apps-script/Code.gs`](apps-script/Code.gs).
   Under **Project Settings**, tick *Show "appsscript.json"* and paste [`apps-script/appsscript.json`](apps-script/appsscript.json).
3. Choose the function **`setup`** and click **Run**, then allow the permissions.
   Open **Execution log** and copy the **TOKEN** it prints. This is your app password.
4. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*. Copy the **Web app URL** (ends in `/exec`).
   *Anyone* only means the URL is reachable. Every request still needs your TOKEN.
5. After you change the code later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

## 2. Android app

* Download the APK: GitHub → **Actions → Build Android APK** → latest run → **HodTasks-apk**. Unzip it and install `app-debug.apk` on the phone (allow "install unknown apps").
* Open **Settings** in the app, paste the URL and TOKEN, then tap *Save & sync*.
* Allow notifications. On Android 12+ also tap **Allow exact reminder alarms**.
* The phone syncs when you open the app, after every change, and about every 15 min in the background. Reminders ring even if the app is closed.

## 3. Desktop app (PC and both laptops)

* Install Python 3 from python.org. On Windows, tick *Add to PATH*; tkinter is included.
* Copy the `desktop/` folder and run `python hod_tasks.py`. On Windows you can double-click `run_windows.bat`.
* Open **Settings**, paste the URL and TOKEN, then click *Save & sync*.
* Keep it running (it can be minimised) so reminders can pop up. To start it with Windows, press `Win+R`, type `shell:startup`, and put a shortcut to `run_windows.bat` there.
* Optional: `pip install plyer` adds native Windows notifications as well as the pop-up window.
* Data is kept in `~/.hod_tasks/data.db`.

## 4. Optional: fully automatic WhatsApp

Without this step, WhatsApp is one tap from the apps. To send automatically:

1. Set up the WhatsApp Cloud API at <https://developers.facebook.com> (WhatsApp → Getting started) with a business phone number.
2. Create a message template, e.g. `task_assigned`, with the body
   `Dear {{1}}, you have been assigned: {{2}}. Due: {{3}}. Details: {{4}} — HoD, BME`, and wait for approval.
3. In Apps Script → **Project Settings → Script properties**, add `WA_TOKEN`, `WA_PHONE_ID`, `WA_TEMPLATE` (and `WA_LANG` if it isn't `en`).

## Sheet columns

**Faculty**: `id, name, initials, phone, email, deleted, updated, synced`
**Entries**: `id, created, updated, synced, device, type, title, details, faculty (initials, comma separated), date (YYYY-MM-DD), time (HH:MM), priority, actions (calendar,email,whatsapp,reminder), remindAt (YYYY-MM-DDTHH:MM), status (review/approved/done/cancelled), processed, log, deleted`

The `log` column shows what was done, e.g. `calendar: event created | email: sent to RK`.

## Development

`tests/` runs `Code.gs` in a mock Apps Script server and syncs two desktop stores through it:
`node tests/mock_apps_script.js apps-script/Code.gs & python tests/test_sync.py`
