# HoD Task Handler — BME, KPRIET

An offline-first web app (PWA) for the HoD to record **things to do, new ideas, assignments, delegation of duty and other roles**, assign them to faculty, review them, and send them on approval.

- **Works offline**: entries are saved on the device at once and sync to the cloud when the device is back online.
- **Same data on every device** (PC, two laptops, phone): sign in with `hod_bme@kpriet.ac.in` on each one. No other account can sign in.
- **Auto-assign**: type `@RK` (or the initials in capitals, e.g. `RK`) in the title or details and that faculty member is selected.
- **Review → Approve → Send**: new entries wait in **Review**. When you press *Approve & send*, the task is emailed to the faculty member with a calendar invite for the date and time. If you are offline it goes out as soon as you are back online.
- **WhatsApp / Email buttons** for each faculty member on every assigned task. You can also have WhatsApp open on its own after you approve.
- **Admin page**: faculty name, initials, phone and email. It also has the automation settings and a JSON backup.
- Can be installed as an app: use "Install app" in Chrome/Edge, or "Add to Home Screen" on the phone.

## One-time setup (≈15 minutes)

### 1. Firebase (sync + login, free plan)
1. Go to <https://console.firebase.google.com> and click **Add project**.
2. **Build → Authentication → Get started → Google → Enable**.
3. **Build → Firestore Database → Create database** (production mode). Open the **Rules** tab, paste the contents of `firestore.rules` and click **Publish**.
4. **Project settings → Your apps → Web (`</>`)**: register the app and copy the `firebaseConfig` into `firebase-config.js`.
5. **Authentication → Settings → Authorized domains**: add the domain where you host the app (e.g. `yourname.github.io`).

### 2. Host it (free)
Choose one:
- **GitHub Pages**: repo **Settings → Pages → Deploy from branch**, then pick this branch and `/ (root)`.
- **Firebase Hosting**: `npm i -g firebase-tools && firebase init hosting && firebase deploy`.

Open the URL on each device and sign in once while online.

### 3. Automatic email (Google Apps Script, free)
1. While signed in as `hod_bme@kpriet.ac.in`, open <https://script.google.com> and create a **New project**.
2. Paste in `apps-script/Code.gs`, then change `SECRET` to a long random text.
3. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*. Authorize it and copy the URL.
4. In the app go to **Admin → Automation**, paste the URL and the secret, then click **Save settings**.

Emails are sent from your own Gmail and calendar invites from your own calendar. Approved items show a status: *Sending when online → Notified ✓*.

## Local mode
If `firebase-config.js` has no `apiKey`, the app runs on one device only and keeps its data in that browser. This is handy for trying it out.

## Files
| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `sw.js`, `manifest.json`, `icon.svg` | Offline support / install |
| `firebase-config.js` | Your Firebase keys + allowed email |
| `firestore.rules` | Security: only the HoD account can read or write |
| `apps-script/Code.gs` | Email + calendar automation |
