"""Offline store + Google Sheet sync for the HoD Task Handler desktop app (stdlib only)."""
import json
import os
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime

ENTRY_FIELDS = ['id', 'created', 'updated', 'synced', 'device', 'type', 'title', 'details', 'faculty',
                'date', 'time', 'priority', 'actions', 'remindAt', 'status', 'processed', 'log', 'deleted']
FACULTY_FIELDS = ['id', 'name', 'initials', 'phone', 'email', 'deleted', 'updated', 'synced']
TYPES = ['Things to do', 'New idea', 'Assignment', 'Delegation of duty', 'Other role', 'Event', 'Reminder']
ACTIONS = ['calendar', 'email', 'whatsapp', 'reminder']


def now_ms():
    return int(time.time() * 1000)


class Store:
    """SQLite copy of the Sheet plus an outbox of changes not yet uploaded."""

    def __init__(self, path):
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.RLock()
        with self.lock:
            self.db.executescript('''
              CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, data TEXT);
              CREATE TABLE IF NOT EXISTS faculty (id TEXT PRIMARY KEY, data TEXT);
              CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT);
              CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);''')
            self.db.commit()

    # ---- meta / settings
    def get(self, k, default=''):
        with self.lock:
            r = self.db.execute('SELECT v FROM meta WHERE k=?', (k,)).fetchone()
        return r[0] if r else default

    def set(self, k, v):
        with self.lock:
            self.db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (k, str(v)))
            self.db.commit()

    # ---- records
    def _all(self, table):
        with self.lock:
            return [json.loads(r[0]) for r in self.db.execute(f'SELECT data FROM {table}')]

    def _put(self, table, rec):
        with self.lock:
            self.db.execute(f'INSERT OR REPLACE INTO {table} VALUES (?,?)', (rec['id'], json.dumps(rec)))

    def entries(self):
        return sorted((e for e in self._all('entries') if e.get('deleted') != 'true'),
                      key=lambda e: -int(e.get('created') or 0))

    def faculty(self):
        return sorted((f for f in self._all('faculty') if f.get('deleted') != 'true'),
                      key=lambda f: f.get('initials', ''))

    def entry(self, eid):
        return next((e for e in self._all('entries') if e['id'] == eid), None)

    def save_entry(self, rec):
        """Create/update locally and queue for upload."""
        rec = dict(rec)
        rec.setdefault('id', uuid.uuid4().hex)
        rec.setdefault('created', now_ms())
        rec['updated'] = now_ms()
        rec['device'] = self.get('device', 'desktop')
        old = self.entry(rec['id']) or {}
        merged = {**old, **rec}
        with self.lock:
            self._put('entries', merged)
            self.db.execute('INSERT INTO outbox (op) VALUES (?)', (json.dumps({'op': 'upsertEntry', 'entry': rec}),))
            self.db.commit()
        return merged

    def save_faculty(self, rec):
        rec = dict(rec)
        rec.setdefault('id', uuid.uuid4().hex)
        rec['initials'] = rec.get('initials', '').strip().upper()
        rec['updated'] = now_ms()
        with self.lock:
            self._put('faculty', rec)
            self.db.execute('INSERT INTO outbox (op) VALUES (?)', (json.dumps({'op': 'upsertFaculty', 'faculty': rec}),))
            self.db.commit()
        return rec

    def pending(self):
        with self.lock:
            return self.db.execute('SELECT COUNT(*) FROM outbox').fetchone()[0]

    # ---- sync
    def merge(self, table, rows):
        """Take server rows, except where we hold a newer unsent local edit."""
        with self.lock:
            local = {r['id']: r for r in self._all(table)}
            for r in rows:
                mine = local.get(r['id'])
                if mine and int(mine.get('updated') or 0) > int(r.get('updated') or 0):
                    continue
                self._put(table, r)
            self.db.commit()

    def sync(self, url, token):
        """Upload the outbox and download changes. Returns a status string; raises on network errors."""
        if not url or not token:
            return 'Not configured'
        with self.lock:
            rows = self.db.execute('SELECT seq, op FROM outbox ORDER BY seq LIMIT 200').fetchall()
        since = int(self.get('since', '0') or 0)
        if rows:
            body = json.dumps({'token': token, 'device': self.get('device', 'desktop'), 'since': since,
                               'ops': [json.loads(o) for _, o in rows]}).encode()
            req = urllib.request.Request(url, data=body, headers={'Content-Type': 'text/plain;charset=utf-8'})
        else:
            req = urllib.request.Request(url + ('&' if '?' in url else '?') +
                                         urllib.parse.urlencode({'token': token, 'since': since}))
        with urllib.request.urlopen(req, timeout=60) as res:  # Apps Script answers via a redirect; urllib follows it
            out = json.loads(res.read().decode())
        if not out.get('ok'):
            raise RuntimeError(out.get('error', 'Server error'))
        with self.lock:
            if rows:
                self.db.execute('DELETE FROM outbox WHERE seq<=?', (rows[-1][0],))
            self.db.commit()
        # Server copies are authoritative once our edits are uploaded.
        self.merge('faculty', out.get('faculty', []))
        self.merge('entries', out.get('entries', []))
        self.set('since', out.get('serverTime', since))
        failed = [r for r in out.get('results', []) if not r.get('ok')]
        return f'Synced {datetime.now():%H:%M}' + (f' ({len(failed)} rejected)' if failed else '')

    # ---- reminders
    def due_reminders(self):
        """Reminders due now on this device (each device pops each reminder once)."""
        shown = set(json.loads(self.get('shown', '[]')))
        snooze = json.loads(self.get('snooze', '{}'))
        out, now = [], datetime.now()
        for e in self.entries():
            if 'reminder' not in (e.get('actions') or '') or e.get('status') in ('done', 'cancelled'):
                continue
            at = parse_dt(snooze.get(e['id']) or e.get('remindAt') or f"{e.get('date', '')} {e.get('time', '')}")
            if at and at <= now and (e['id'] not in shown or e['id'] in snooze):
                out.append(e)
        return out

    def mark_shown(self, eid):
        shown = set(json.loads(self.get('shown', '[]')))
        shown.add(eid)
        self.set('shown', json.dumps(sorted(shown)))
        snooze = json.loads(self.get('snooze', '{}'))
        snooze.pop(eid, None)
        self.set('snooze', json.dumps(snooze))

    def snooze(self, eid, minutes=10):
        snooze = json.loads(self.get('snooze', '{}'))
        snooze[eid] = datetime.fromtimestamp(time.time() + minutes * 60).strftime('%Y-%m-%dT%H:%M')
        self.set('snooze', json.dumps(snooze))


def parse_dt(s):
    m = re.search(r'(\d{4})-(\d{2})-(\d{2})(?:[T ]+(\d{1,2}):(\d{2}))?', s or '')
    if not m:
        return None
    y, mo, d, h, mi = m.groups()
    return datetime(int(y), int(mo), int(d), int(h or 9), int(mi or 0))


def auto_faculty(text, faculty):
    """Initials mentioned as @RK (or a stand-alone capital RK) in the text."""
    found = []
    for f in faculty:
        i = re.escape(f.get('initials', ''))
        if i and (re.search(rf'@{i}(?![A-Za-z0-9])', text, re.I) or
                  (len(f['initials']) >= 2 and re.search(rf'(?<![A-Za-z0-9@]){i}(?![A-Za-z0-9])', text))):
            found.append(f['initials'])
    return found


def message(e, f):
    due = ' '.join(x for x in (e.get('date'), e.get('time')) if x) or 'No deadline'
    return (f"Dear {f['name']},\n\nYou have been assigned the following by the HoD, BME:\n\n"
            f"Category: {e.get('type')}\nTitle: {e.get('title')}\nDue: {due}\nPriority: {e.get('priority') or 'Normal'}\n"
            + (f"\nDetails:\n{e['details']}\n" if e.get('details') else '')
            + "\nRegards,\nHoD – Biomedical Engineering\nKPRIET")


def whatsapp_url(e, f):
    p = re.sub(r'\D', '', f.get('phone', ''))
    if len(p) == 10:
        p = '91' + p
    return f'https://wa.me/{p}?text=' + urllib.parse.quote(message(e, f))
