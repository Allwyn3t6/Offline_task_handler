import { firebaseConfig, ALLOWED_EMAIL } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), 2800); };

const state = { faculty: [], tasks: [], settings: {}, selected: new Set() };
let store; // { put(col, doc), del(col, id), watch(col, cb), claim(id) }

/* ---------------- Storage backends ---------------- */

// Firestore with persistent offline cache: writes are saved locally at once
// and synced to the cloud (and your other devices) when back online.
async function firestoreStore(user) {
  const fs = await import(FB + 'firebase-firestore.js');
  const db = fs.initializeFirestore(window.fbApp, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
  });
  const col = c => fs.collection(db, 'users', user.uid, c);
  return {
    put: (c, d) => { fs.setDoc(fs.doc(col(c), d.id), d, { merge: true }).catch(e => toast('Sync error: ' + e.message)); },
    del: (c, id) => { fs.deleteDoc(fs.doc(col(c), id)).catch(e => toast('Sync error: ' + e.message)); },
    watch: (c, cb) => fs.onSnapshot(col(c), snap => cb(snap.docs.map(d => d.data()))),
    // Make sure only one device sends a given notification.
    claim: id => fs.runTransaction(db, async tx => {
      const ref = fs.doc(col('tasks'), id);
      const s = await tx.get(ref);
      const d = s.data();
      const stale = d?.notify === 'sending' && Date.now() - (d.claimedAt || 0) > 5 * 60e3;
      if (!d || (d.notify !== 'queued' && !stale)) return false;
      tx.update(ref, { notify: 'sending', claimedAt: Date.now() });
      return true;
    })
  };
}

// Single-device fallback when Firebase is not configured.
function localStore() {
  const key = c => 'hod_' + c, subs = {};
  const read = c => { try { return JSON.parse(localStorage.getItem(key(c)) || '[]'); } catch { return []; } };
  const write = (c, arr) => { localStorage.setItem(key(c), JSON.stringify(arr)); (subs[c] || []).forEach(cb => cb(arr)); };
  return {
    put: (c, d) => { const a = read(c), i = a.findIndex(x => x.id === d.id); i < 0 ? a.push(d) : (a[i] = { ...a[i], ...d }); write(c, a); },
    del: (c, id) => write(c, read(c).filter(x => x.id !== id)),
    watch: (c, cb) => { (subs[c] ||= []).push(cb); cb(read(c)); },
    claim: async id => { const t = read('tasks').find(x => x.id === id); if (t?.notify !== 'queued') return false; store.put('tasks', { id, notify: 'sending' }); return true; }
  };
}

/* ---------------- Auth / boot ---------------- */

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  updateNet(); addEventListener('online', () => { updateNet(); processQueue(); }); addEventListener('offline', updateNet);

  if (!firebaseConfig.apiKey) {
    $('#who').textContent = 'Local mode (no sync)';
    store = localStore();
    return start();
  }
  const { initializeApp } = await import(FB + 'firebase-app.js');
  const auth = await import(FB + 'firebase-auth.js');
  window.fbApp = initializeApp(firebaseConfig);
  const a = auth.getAuth(window.fbApp);
  await auth.setPersistence(a, auth.indexedDBLocalPersistence);
  const provider = new auth.GoogleAuthProvider();
  provider.setCustomParameters({ login_hint: ALLOWED_EMAIL, hd: ALLOWED_EMAIL.split('@')[1] });

  $('#signin').onclick = async () => {
    $('#loginErr').textContent = '';
    try { await auth.signInWithPopup(a, provider); }
    catch (e) {
      if (/popup/.test(e.code)) return auth.signInWithRedirect(a, provider);
      $('#loginErr').textContent = navigator.onLine ? e.message : 'You must be online for the first sign-in on this device.';
    }
  };
  $('#signout').onclick = () => auth.signOut(a);
  auth.getRedirectResult(a).catch(() => {});

  auth.onAuthStateChanged(a, async user => {
    if (!user) { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#signout').classList.add('hidden'); $('#who').textContent = ''; return; }
    if (user.email?.toLowerCase() !== ALLOWED_EMAIL) {
      await auth.signOut(a);
      $('#loginErr').textContent = `Only ${ALLOWED_EMAIL} can use this app.`;
      return;
    }
    $('#who').textContent = user.email; $('#signout').classList.remove('hidden');
    if (!store) { store = await firestoreStore(user); start(); }
  });
}

function updateNet() {
  const n = $('#net'); const on = navigator.onLine;
  n.textContent = on ? 'Online · synced' : 'Offline · saving locally'; n.className = 'pill ' + (on ? 'on' : 'off');
}

function start() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  store.watch('faculty', f => { state.faculty = f.sort((a, b) => a.initials.localeCompare(b.initials)); renderFaculty(); renderPicker(); renderAll(); });
  store.watch('tasks', t => { state.tasks = t.sort((a, b) => b.createdAt - a.createdAt); renderAll(); processQueue(); });
  store.watch('meta', m => { state.settings = m.find(x => x.id === 'settings') || {}; fillSettings(); processQueue(); });
  wire();
}

/* ---------------- UI wiring ---------------- */

function wire() {
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('hidden', t.id !== 'tab-' + b.dataset.tab));
  });

  const form = $('#taskForm');
  form.addEventListener('input', e => { if (e.target.name === 'title' || e.target.name === 'details') autoAssign(form); });
  form.addEventListener('reset', () => setTimeout(() => { state.selected.clear(); renderPicker(); }));
  form.onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (!state.selected.size) return toast('Choose at least one faculty member (or type @INITIALS)');
    store.put('tasks', { id: uid(), ...f, facultyIds: [...state.selected], status: 'review', createdAt: Date.now() });
    form.reset(); toast('Saved — waiting for your review');
  };

  $('#facultyForm').onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.initials = f.initials.trim().toUpperCase();
    if (state.faculty.some(x => x.initials === f.initials && x.id !== f.id)) return toast('Those initials are already used');
    store.put('faculty', { ...f, id: f.id || uid() });
    e.target.reset(); e.target.id.value = ''; toast('Faculty saved');
  };

  $('#saveSettings').onclick = () => {
    store.put('meta', { id: 'settings', scriptUrl: $('#scriptUrl').value.trim(), scriptSecret: $('#scriptSecret').value.trim(), openWhatsapp: $('#openWhatsapp').checked });
    toast('Settings saved');
  };
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ faculty: state.faculty, tasks: state.tasks }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `hod-tasks-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  };
  $('#search').oninput = renderSent; $('#filterFaculty').onchange = renderSent;
}

// "@RK" or a standalone "RK" (2+ letters, uppercase) in title/details selects that faculty.
function autoAssign(form) {
  const text = form.title.value + ' ' + form.details.value;
  for (const f of state.faculty) {
    const i = f.initials.replace(/[^A-Z0-9]/gi, '');
    if (!i) continue;
    const tagged = new RegExp(`@${i}(?![A-Za-z0-9])`, 'i').test(text);
    const bare = i.length >= 2 && new RegExp(`(^|[^A-Za-z0-9@])${i}(?![A-Za-z0-9])`).test(text); // exact uppercase word
    if (tagged || bare) state.selected.add(f.id);
  }
  renderPicker();
}

function fillSettings() {
  $('#scriptUrl').value = state.settings.scriptUrl || '';
  $('#scriptSecret').value = state.settings.scriptSecret || '';
  $('#openWhatsapp').checked = !!state.settings.openWhatsapp;
}

/* ---------------- Rendering ---------------- */

const facById = id => state.faculty.find(f => f.id === id);
const names = t => t.facultyIds.map(id => facById(id)).filter(Boolean);
const when = t => [t.dueDate && new Date(t.dueDate + 'T00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), t.dueTime].filter(Boolean).join(' · ') || 'No deadline';

function renderPicker() {
  const p = $('#facultyPicker');
  if (!state.faculty.length) { p.innerHTML = '<span class="meta">Add faculty in the Admin tab first.</span>'; return; }
  p.innerHTML = state.faculty.map(f => `<button type="button" class="chip ${state.selected.has(f.id) ? 'on' : ''}" data-id="${f.id}" title="${esc(f.name)}">${esc(f.initials)} · ${esc(f.name)}</button>`).join('');
  p.querySelectorAll('.chip').forEach(c => c.onclick = () => { const id = c.dataset.id; state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id); renderPicker(); });
  const sel = $('#filterFaculty'), v = sel.value;
  sel.innerHTML = '<option value="">All faculty</option>' + state.faculty.map(f => `<option value="${f.id}">${esc(f.initials)} — ${esc(f.name)}</option>`).join('');
  sel.value = v;
}

function renderFaculty() {
  $('#facultyTable').innerHTML = state.faculty.map(f => `<tr><td><b>${esc(f.initials)}</b></td><td>${esc(f.name)}</td><td>${esc(f.phone)}</td><td>${esc(f.email)}</td>
    <td><button class="small ghost" data-edit="${f.id}">Edit</button> <button class="small bad" data-del="${f.id}">✕</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="empty">No faculty yet</td></tr>';
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const f = facById(b.dataset.edit), form = $('#facultyForm');
    for (const k of ['id', 'name', 'initials', 'phone', 'email']) form[k].value = f[k] || '';
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { if (confirm('Delete this faculty member?')) store.del('faculty', b.dataset.del); });
}

function taskCard(t, mode) {
  const people = names(t).map(f => `<span class="tag">${esc(f.initials)} · ${esc(f.name)}</span>`).join('');
  const notify = t.status === 'approved' ? ({ queued: '<span class="tag queued">Sending when online</span>', sending: '<span class="tag queued">Sending…</span>', sent: '<span class="tag done">Notified ✓</span>', failed: `<span class="tag High" title="${esc(t.notifyError)}">Send failed</span> <button class="small" data-retry="${t.id}">Retry</button>`, manual: '<span class="tag">Approved</span>' }[t.notify] || '') : '';
  const btns = mode === 'review'
    ? `<button class="ok" data-approve="${t.id}">Approve & send</button><button class="ghost" data-editTask="${t.id}">Edit</button><button class="bad" data-delTask="${t.id}">Delete</button>`
    : `${names(t).map(f => `<button class="small ghost" data-wa="${t.id}|${f.id}">WhatsApp ${esc(f.initials)}</button><a class="btn small ghost" href="${mailto(t, f)}">Email ${esc(f.initials)}</a>`).join('')}
       <button class="small ${t.done ? 'ghost' : 'ok'}" data-done="${t.id}">${t.done ? 'Reopen' : 'Mark done'}</button>`;
  return `<div class="card task"><h4>${esc(t.title)}</h4>
    <div class="meta"><span class="tag">${esc(t.type)}</span><span class="tag ${esc(t.priority)}">${esc(t.priority)}</span> ${esc(when(t))} ${t.done ? '<span class="tag done">Completed</span>' : ''} ${notify}</div>
    ${t.details ? `<div class="details">${esc(t.details)}</div>` : ''}<div>${people}</div><div class="actions">${btns}</div></div>`;
}

function renderAll() {
  const review = state.tasks.filter(t => t.status === 'review');
  $('#reviewCount').textContent = review.length;
  $('#reviewList').innerHTML = review.map(t => taskCard(t, 'review')).join('') || '<div class="card empty">Nothing waiting for review 🎉</div>';
  renderSent();
  bindTaskButtons();
}

function renderSent() {
  const q = $('#search').value.toLowerCase(), fid = $('#filterFaculty').value;
  const list = state.tasks.filter(t => t.status === 'approved' && (!fid || t.facultyIds.includes(fid))
    && (!q || (t.title + t.details + t.type + names(t).map(f => f.name + f.initials).join(' ')).toLowerCase().includes(q)));
  $('#sentList').innerHTML = list.map(t => taskCard(t, 'sent')).join('') || '<div class="card empty">No assigned tasks yet</div>';
  bindTaskButtons();
}

function bindTaskButtons() {
  document.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => approve(b.dataset.approve));
  document.querySelectorAll('[data-delTask]').forEach(b => b.onclick = () => { if (confirm('Delete this entry?')) store.del('tasks', b.dataset.deltask); });
  document.querySelectorAll('[data-editTask]').forEach(b => b.onclick = () => editTask(b.dataset.edittask));
  document.querySelectorAll('[data-done]').forEach(b => b.onclick = () => { const t = state.tasks.find(x => x.id === b.dataset.done); store.put('tasks', { id: t.id, done: !t.done }); });
  document.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => store.put('tasks', { id: b.dataset.retry, notify: 'queued' }));
  document.querySelectorAll('[data-wa]').forEach(b => b.onclick = () => { const [tid, fid] = b.dataset.wa.split('|'); openWa(state.tasks.find(x => x.id === tid), facById(fid)); });
}

function editTask(id) {
  const t = state.tasks.find(x => x.id === id), form = $('#taskForm');
  for (const k of ['type', 'title', 'details', 'dueDate', 'dueTime', 'priority']) form[k].value = t[k] || '';
  state.selected = new Set(t.facultyIds); renderPicker();
  store.del('tasks', id);
  document.querySelector('nav [data-tab=new]').click();
  toast('Editing — save again to send back to review');
}

/* ---------------- Approval & automation ---------------- */

function message(t, f) {
  return `Dear ${f.name},\n\nYou have been assigned the following by the HoD, BME:\n\n` +
    `Category: ${t.type}\nTitle: ${t.title}\nDue: ${when(t)}\nPriority: ${t.priority}\n` +
    (t.details ? `\nDetails:\n${t.details}\n` : '') + `\nRegards,\nHoD – Biomedical Engineering\nKPRIET`;
}
const subject = t => `[${t.type}] ${t.title} — due ${when(t)}`;
const mailto = (t, f) => `mailto:${encodeURIComponent(f.email)}?subject=${encodeURIComponent(subject(t))}&body=${encodeURIComponent(message(t, f))}`;
function openWa(t, f) {
  let p = (f.phone || '').replace(/\D/g, ''); if (p.length === 10) p = '91' + p;
  window.open(`https://wa.me/${p}?text=${encodeURIComponent(message(t, f))}`, '_blank');
}

function approve(id) {
  const t = state.tasks.find(x => x.id === id);
  const auto = !!state.settings.scriptUrl;
  store.put('tasks', { id, status: 'approved', approvedAt: Date.now(), notify: auto ? 'queued' : 'manual' });
  toast(auto ? (navigator.onLine ? 'Approved — sending…' : 'Approved — will send when online') : 'Approved — use the Email/WhatsApp buttons in Assigned');
  if (state.settings.openWhatsapp && navigator.onLine) names(t).forEach(f => openWa(t, f));
}

let busy = false;
async function processQueue() {
  if (busy || !navigator.onLine || !store || !state.settings.scriptUrl) return;
  busy = true;
  try {
    for (const t of state.tasks.filter(t => t.status === 'approved' && ['queued', 'sending'].includes(t.notify))) {
      let ok = false; try { ok = await store.claim(t.id); } catch { continue; }
      if (!ok) continue;
      try {
        const recipients = names(t).map(f => ({ name: f.name, email: f.email, phone: f.phone, subject: subject(t), body: message(t, f) }));
        const res = await fetch(state.settings.scriptUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: state.settings.scriptSecret, task: t, recipients }) });
        const out = await res.json();
        if (!out.ok) throw new Error(out.error || 'Script error');
        store.put('tasks', { id: t.id, notify: 'sent', notifiedAt: Date.now() });
      } catch (e) {
        store.put('tasks', { id: t.id, notify: 'failed', notifyError: e.message });
      }
    }
  } finally { busy = false; }
}

boot().catch(e => { console.error(e); toast('Startup error: ' + e.message); });
