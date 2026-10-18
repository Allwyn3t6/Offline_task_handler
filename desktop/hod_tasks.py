"""HoD Task Handler — desktop app (Windows / macOS / Linux). Python 3.8+, no extra packages needed.

Run:  python hod_tasks.py
Works offline: everything is saved locally and uploaded to the Google Sheet when online.
Reminders pop up on screen while the app is running (it can sit minimised).
"""
import os
import sys
import threading
import tkinter as tk
import webbrowser
from tkinter import messagebox, ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hod_core import ACTIONS, TYPES, Store, auto_faculty, message, whatsapp_url  # noqa: E402

DATA = os.path.join(os.path.expanduser('~'), '.hod_tasks', 'data.db')
SYNC_EVERY_MS = 60_000


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('HoD Task Handler — BME, KPRIET')
        self.geometry('980x640')
        self.store = Store(DATA)
        if not self.store.get('device'):
            self.store.set('device', 'desktop-' + os.environ.get('COMPUTERNAME', os.uname().nodename if hasattr(os, 'uname') else 'pc'))
        self.status = tk.StringVar(value='Starting…')
        self.syncing = False
        self.popups = {}

        nb = ttk.Notebook(self)
        nb.pack(fill='both', expand=True)
        self.tab_new, self.tab_review, self.tab_all, self.tab_fac, self.tab_set = (ttk.Frame(nb, padding=10) for _ in range(5))
        for f, t in [(self.tab_new, 'New entry'), (self.tab_review, 'Review'), (self.tab_all, 'All entries'),
                     (self.tab_fac, 'Faculty (Admin)'), (self.tab_set, 'Settings')]:
            nb.add(f, text=t)
        self.nb = nb
        ttk.Label(self, textvariable=self.status, anchor='w', relief='sunken').pack(fill='x')

        self.build_new()
        self.review_tree = self.build_list(self.tab_review, review=True)
        self.all_tree = self.build_list(self.tab_all, review=False)
        self.build_faculty()
        self.build_settings()
        self.refresh()
        self.after(500, self.sync)
        self.after(5000, self.check_reminders)

    # ------------------------------------------------------------ new entry
    def build_new(self):
        f = self.tab_new
        self.v = {k: tk.StringVar() for k in ('type', 'title', 'date', 'time', 'priority', 'remindAt')}
        self.v['type'].set(TYPES[0]); self.v['priority'].set('Normal')
        row = 0
        def lab(text):
            nonlocal row
            ttk.Label(f, text=text).grid(row=row, column=0, sticky='nw', pady=3)
        lab('Category'); ttk.Combobox(f, textvariable=self.v['type'], values=TYPES, state='readonly', width=30).grid(row=row, column=1, sticky='w'); row += 1
        lab('Title'); e = ttk.Entry(f, textvariable=self.v['title'], width=70); e.grid(row=row, column=1, sticky='we'); row += 1
        lab('Details'); self.details = tk.Text(f, height=6, width=70, wrap='word'); self.details.grid(row=row, column=1, sticky='we'); row += 1
        lab('Date (YYYY-MM-DD)'); ttk.Entry(f, textvariable=self.v['date'], width=14).grid(row=row, column=1, sticky='w'); row += 1
        lab('Time (HH:MM)'); ttk.Entry(f, textvariable=self.v['time'], width=8).grid(row=row, column=1, sticky='w'); row += 1
        lab('Priority'); ttk.Combobox(f, textvariable=self.v['priority'], values=['Low', 'Normal', 'High', 'Urgent'], state='readonly', width=12).grid(row=row, column=1, sticky='w'); row += 1
        lab('Assign to'); self.fac_frame = ttk.Frame(f); self.fac_frame.grid(row=row, column=1, sticky='w'); row += 1
        lab('Actions'); af = ttk.Frame(f); af.grid(row=row, column=1, sticky='w'); row += 1
        self.act = {a: tk.BooleanVar() for a in ACTIONS}
        labels = {'calendar': 'Add to Google Calendar', 'email': 'Send email', 'whatsapp': 'Send WhatsApp', 'reminder': 'Remind me'}
        for a in ACTIONS:
            ttk.Checkbutton(af, text=labels[a], variable=self.act[a]).pack(side='left', padx=4)
        lab('Remind at (YYYY-MM-DD HH:MM)'); ttk.Entry(f, textvariable=self.v['remindAt'], width=18).grid(row=row, column=1, sticky='w'); row += 1
        bf = ttk.Frame(f); bf.grid(row=row, column=1, sticky='e', pady=10)
        ttk.Button(bf, text='Clear', command=self.clear_form).pack(side='left', padx=4)
        ttk.Button(bf, text='Save for review', command=lambda: self.save_entry('review')).pack(side='left', padx=4)
        ttk.Button(bf, text='Save & approve now', command=lambda: self.save_entry('approved')).pack(side='left', padx=4)
        f.columnconfigure(1, weight=1)
        self.fac_sel = {}
        self.v['title'].trace_add('write', lambda *_: self.auto_assign())
        self.details.bind('<KeyRelease>', lambda _: self.auto_assign())
        self.editing = None

    def render_fac_checks(self):
        for w in self.fac_frame.winfo_children():
            w.destroy()
        old = {k: v.get() for k, v in self.fac_sel.items()}
        self.fac_sel = {}
        for i, fa in enumerate(self.store.faculty()):
            var = tk.BooleanVar(value=old.get(fa['initials'], False))
            self.fac_sel[fa['initials']] = var
            ttk.Checkbutton(self.fac_frame, text=f"{fa['initials']} · {fa['name']}", variable=var).grid(row=i // 4, column=i % 4, sticky='w', padx=4)
        if not self.fac_sel:
            ttk.Label(self.fac_frame, text='Add faculty in the Faculty tab first').grid()

    def auto_assign(self):
        for ini in auto_faculty(self.v['title'].get() + ' ' + self.details.get('1.0', 'end'), self.store.faculty()):
            if ini in self.fac_sel:
                self.fac_sel[ini].set(True)

    def clear_form(self):
        for k in ('title', 'date', 'time', 'remindAt'):
            self.v[k].set('')
        self.details.delete('1.0', 'end')
        for v in list(self.fac_sel.values()) + list(self.act.values()):
            v.set(False)
        self.editing = None

    def save_entry(self, status):
        title = self.v['title'].get().strip()
        if not title:
            return messagebox.showwarning('Missing', 'Please enter a title')
        acts = [a for a, v in self.act.items() if v.get()]
        fac = [i for i, v in self.fac_sel.items() if v.get()]
        if ({'email', 'whatsapp'} & set(acts)) and not fac:
            return messagebox.showwarning('Missing', 'Choose the faculty to send to (or type @INITIALS)')
        if 'reminder' in acts and not (self.v['remindAt'].get() or self.v['date'].get()):
            return messagebox.showwarning('Missing', 'Give a "Remind at" time or a date for the reminder')
        rec = {'type': self.v['type'].get(), 'title': title, 'details': self.details.get('1.0', 'end').strip(),
               'date': self.v['date'].get().strip(), 'time': self.v['time'].get().strip(), 'priority': self.v['priority'].get(),
               'faculty': ','.join(fac), 'actions': ','.join(acts), 'remindAt': self.v['remindAt'].get().strip().replace(' ', 'T'),
               'status': status}
        if self.editing:
            rec['id'] = self.editing
        self.store.save_entry(rec)
        self.clear_form()
        self.refresh()
        self.sync()
        self.status.set('Saved' + (' — waiting for review' if status == 'review' else ' and approved'))

    # ----------------------------------------------------------- lists
    def build_list(self, parent, review):
        cols = ('title', 'type', 'faculty', 'due', 'actions', 'status', 'log')
        tree = ttk.Treeview(parent, columns=cols, show='headings', selectmode='browse')
        widths = (260, 110, 80, 110, 150, 80, 260)
        for c, w in zip(cols, widths):
            tree.heading(c, text=c.title()); tree.column(c, width=w, anchor='w')
        tree.pack(fill='both', expand=True)
        tree.bind('<Double-1>', lambda _: self.show_details(tree))
        bf = ttk.Frame(parent); bf.pack(fill='x', pady=6)
        sel = lambda: tree.selection()[0] if tree.selection() else None
        if review:
            ttk.Button(bf, text='Approve & send', command=lambda: self.set_status(sel(), 'approved')).pack(side='left', padx=3)
            ttk.Button(bf, text='Edit', command=lambda: self.edit(sel())).pack(side='left', padx=3)
            ttk.Button(bf, text='Delete', command=lambda: self.delete(sel())).pack(side='left', padx=3)
        else:
            ttk.Button(bf, text='Mark done', command=lambda: self.set_status(sel(), 'done')).pack(side='left', padx=3)
            ttk.Button(bf, text='Open WhatsApp', command=lambda: self.open_whatsapp(sel())).pack(side='left', padx=3)
            ttk.Button(bf, text='Details', command=lambda: self.show_details(tree)).pack(side='left', padx=3)
            ttk.Button(bf, text='Delete', command=lambda: self.delete(sel())).pack(side='left', padx=3)
        ttk.Button(bf, text='Sync now', command=self.sync).pack(side='right')
        return tree

    def refresh(self):
        self.render_fac_checks()
        for tree, review in ((self.review_tree, True), (self.all_tree, False)):
            tree.delete(*tree.get_children())
            for e in self.store.entries():
                if (e.get('status') == 'review') != review:
                    continue
                due = ' '.join(x for x in (e.get('date'), e.get('time')) if x)
                tree.insert('', 'end', iid=e['id'], values=(e.get('title'), e.get('type'), e.get('faculty'), due,
                                                            e.get('actions'), e.get('status'), e.get('log') or ''))
        n = len(self.review_tree.get_children())
        self.nb.tab(1, text=f'Review ({n})' if n else 'Review')
        self.render_fac_table()

    def set_status(self, eid, status):
        if eid:
            self.store.save_entry({'id': eid, 'status': status}); self.refresh(); self.sync()

    def delete(self, eid):
        if eid and messagebox.askyesno('Delete', 'Delete this entry?'):
            self.store.save_entry({'id': eid, 'deleted': 'true'}); self.refresh(); self.sync()

    def edit(self, eid):
        e = self.store.entry(eid) if eid else None
        if not e:
            return
        self.clear_form()
        for k in ('type', 'title', 'date', 'time', 'priority'):
            self.v[k].set(e.get(k) or '')
        self.v['remindAt'].set((e.get('remindAt') or '').replace('T', ' '))
        self.details.insert('1.0', e.get('details') or '')
        for i in (e.get('faculty') or '').split(','):
            if i in self.fac_sel: self.fac_sel[i].set(True)
        for a in (e.get('actions') or '').split(','):
            if a in self.act: self.act[a].set(True)
        self.editing = eid
        self.nb.select(0)

    def open_whatsapp(self, eid):
        e = self.store.entry(eid) if eid else None
        if not e:
            return
        fac = {f['initials']: f for f in self.store.faculty()}
        for i in (e.get('faculty') or '').split(','):
            if i in fac:
                webbrowser.open(whatsapp_url(e, fac[i]))

    def show_details(self, tree):
        if not tree.selection():
            return
        e = self.store.entry(tree.selection()[0])
        fac = {f['initials']: f for f in self.store.faculty()}
        people = [fac[i] for i in (e.get('faculty') or '').split(',') if i in fac]
        body = message(e, people[0]) if people else (e.get('details') or '')
        messagebox.showinfo(e.get('title'), f"{body}\n\nActions: {e.get('actions')}\nStatus: {e.get('status')}\nLog: {e.get('log') or '-'}")

    # ----------------------------------------------------------- faculty
    def build_faculty(self):
        f = self.tab_fac
        form = ttk.Frame(f); form.pack(fill='x')
        self.fv = {k: tk.StringVar() for k in ('id', 'name', 'initials', 'phone', 'email')}
        for i, k in enumerate(('name', 'initials', 'phone', 'email')):
            ttk.Label(form, text=k.title()).grid(row=0, column=i, sticky='w')
            ttk.Entry(form, textvariable=self.fv[k], width=(10 if k == 'initials' else 24)).grid(row=1, column=i, padx=3)
        ttk.Button(form, text='Save', command=self.save_fac).grid(row=1, column=4, padx=3)
        ttk.Button(form, text='New', command=lambda: [v.set('') for v in self.fv.values()]).grid(row=1, column=5)
        cols = ('initials', 'name', 'phone', 'email')
        self.fac_tree = ttk.Treeview(f, columns=cols, show='headings')
        for c in cols:
            self.fac_tree.heading(c, text=c.title())
        self.fac_tree.pack(fill='both', expand=True, pady=8)
        self.fac_tree.bind('<<TreeviewSelect>>', lambda _: self.load_fac())
        ttk.Button(f, text='Delete selected', command=self.del_fac).pack(anchor='w')

    def render_fac_table(self):
        self.fac_tree.delete(*self.fac_tree.get_children())
        for fa in self.store.faculty():
            self.fac_tree.insert('', 'end', iid=fa['id'], values=(fa['initials'], fa['name'], fa['phone'], fa['email']))

    def load_fac(self):
        if self.fac_tree.selection():
            fa = next(x for x in self.store.faculty() if x['id'] == self.fac_tree.selection()[0])
            for k in self.fv:
                self.fv[k].set(fa.get(k, ''))

    def save_fac(self):
        rec = {k: v.get().strip() for k, v in self.fv.items()}
        if not (rec['name'] and rec['initials'] and rec['email']):
            return messagebox.showwarning('Missing', 'Name, initials and email are required')
        if any(f['initials'] == rec['initials'].upper() and f['id'] != rec['id'] for f in self.store.faculty()):
            return messagebox.showwarning('Duplicate', 'Those initials are already used')
        if not rec['id']:
            del rec['id']
        self.store.save_faculty(rec)
        for v in self.fv.values():
            v.set('')
        self.refresh(); self.sync()

    def del_fac(self):
        if self.fac_tree.selection() and messagebox.askyesno('Delete', 'Delete this faculty member?'):
            fa = next(x for x in self.store.faculty() if x['id'] == self.fac_tree.selection()[0])
            self.store.save_faculty({**fa, 'deleted': 'true'}); self.refresh(); self.sync()

    # ----------------------------------------------------------- settings / sync
    def build_settings(self):
        f = self.tab_set
        self.url = tk.StringVar(value=self.store.get('url')); self.token = tk.StringVar(value=self.store.get('token'))
        ttk.Label(f, text='Apps Script Web App URL').pack(anchor='w')
        ttk.Entry(f, textvariable=self.url, width=100).pack(anchor='w', fill='x')
        ttk.Label(f, text='Token (shown in the Apps Script log after running setup)').pack(anchor='w', pady=(8, 0))
        ttk.Entry(f, textvariable=self.token, width=50).pack(anchor='w')
        ttk.Button(f, text='Save & sync', command=self.save_settings).pack(anchor='w', pady=10)

    def save_settings(self):
        self.store.set('url', self.url.get().strip()); self.store.set('token', self.token.get().strip())
        self.store.set('since', '0'); self.sync()

    def sync(self):
        if self.syncing:
            return
        self.syncing = True
        def work():
            try:
                msg = self.store.sync(self.store.get('url'), self.store.get('token'))
            except Exception as ex:  # offline or server error: keep data, retry later
                msg = f'Offline — {self.store.pending()} change(s) waiting ({type(ex).__name__})'
            self.after(0, lambda: self.done_sync(msg))
        threading.Thread(target=work, daemon=True).start()

    def done_sync(self, msg):
        self.syncing = False
        self.status.set(msg)
        self.refresh()
        self.after_cancel(self._timer) if getattr(self, '_timer', None) else None
        self._timer = self.after(SYNC_EVERY_MS, self.sync)

    # ----------------------------------------------------------- reminders
    def check_reminders(self):
        for e in self.store.due_reminders():
            if e['id'] not in self.popups:
                self.popup(e)
        self.after(20_000, self.check_reminders)

    def popup(self, e):
        self.store.mark_shown(e['id'])
        w = tk.Toplevel(self)
        self.popups[e['id']] = w
        w.title('⏰ Reminder')
        w.attributes('-topmost', True)
        w.geometry('+80+80')
        ttk.Label(w, text=e.get('title'), font=('Segoe UI', 14, 'bold'), wraplength=420).pack(padx=20, pady=(16, 4))
        ttk.Label(w, text=e.get('details') or '', wraplength=420).pack(padx=20)
        ttk.Label(w, text=f"{e.get('type')} · {e.get('faculty') or ''}").pack(pady=4)
        bf = ttk.Frame(w); bf.pack(pady=12)
        def close(action):
            if action == 'done':
                self.store.save_entry({'id': e['id'], 'status': 'done'}); self.sync()
            elif action == 'snooze':
                self.store.snooze(e['id'], 10)
            self.popups.pop(e['id'], None); w.destroy(); self.refresh()
        ttk.Button(bf, text='Done', command=lambda: close('done')).pack(side='left', padx=4)
        ttk.Button(bf, text='Snooze 10 min', command=lambda: close('snooze')).pack(side='left', padx=4)
        ttk.Button(bf, text='Dismiss', command=lambda: close('dismiss')).pack(side='left', padx=4)
        w.protocol('WM_DELETE_WINDOW', lambda: close('dismiss'))
        self.bell(); w.lift(); w.focus_force()
        try:  # native notification too, if the optional 'plyer' package is installed
            from plyer import notification
            notification.notify(title='Reminder: ' + e.get('title', ''), message=(e.get('details') or '')[:200], timeout=30)
        except Exception:
            pass


if __name__ == '__main__':
    App().mainloop()
