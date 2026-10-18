import sys, os, json, urllib.request, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'desktop')); from hod_core import *
U='http://localhost:8799/exec'; d=tempfile.mkdtemp()
pc=Store(d+'/pc.db'); lap=Store(d+'/lap.db'); pc.set('device','pc'); lap.set('device','lap')
# offline save
pc.save_faculty({'name':'Dr R Kumar','initials':'rk','phone':'9876543210','email':'rk@x.in'})
e=pc.save_entry({'type':'Assignment','title':'NBA file','faculty':'RK','date':'2026-10-20','time':'10:00','actions':'calendar,email,reminder','remindAt':'2000-01-01T09:00','status':'review'})
try: pc.sync('http://localhost:1/x','T')
except Exception as ex: print('offline ok, pending', pc.pending())
print(pc.sync(U,'T'), 'pending', pc.pending())
print(lap.sync(U,'T'), [x['title'] for x in lap.entries()], [f['initials'] for f in lap.faculty()])
lap.save_entry({'id':e['id'],'status':'approved'}); print(lap.sync(U,'T'))
print(pc.sync(U,'T'), pc.entry(e['id'])['status'], pc.entry(e['id'])['log'])
print(json.load(urllib.request.urlopen('http://localhost:8799/stats')))
print('due', [x['title'] for x in pc.due_reminders()]); pc.mark_shown(e['id']); print('after shown', pc.due_reminders())
print('auto', auto_faculty('please @rk and SM do it', [{'initials':'RK'},{'initials':'SM'},{'initials':'AB'}]))
print(whatsapp_url(pc.entry(e['id']), lap.faculty()[0])[:40])
assert pc.pending() == 0 and pc.entry(e['id'])['status'] == 'approved'
assert 'email: sent to RK' in pc.entry(e['id'])['log']
assert lap.entry(e['id'])['title'] == 'NBA file'
print('ALL OK')
