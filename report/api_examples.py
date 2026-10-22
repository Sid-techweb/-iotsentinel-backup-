"""Calls the demo API (port 4200) and records real request / response pairs for the report appendix (secrets masked)."""
import json, re, urllib.request, urllib.error, os

API = 'http://localhost:4200/api'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'api_examples.json')


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {'Content-Type': 'application/json', **(headers or {})}
    req = urllib.request.Request(API + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        return e.code, (json.loads(raw) if raw else None)


def mask(o):
    s = json.dumps(o)
    s = re.sub(r'eyJ[\w-]+\.[\w-]+\.[\w-]+', 'eyJhbGciOiJIUzI1NiIs...<JWT>', s)
    s = re.sub(r'"apiKey": "[0-9a-f]{32}"', '"apiKey": "<shown once - 32 hex characters>"', s)
    return json.loads(s)


examples = []
st, login = call('POST', '/auth/login', {'email': 'admin@iot-sentinel.demo', 'password': 'report-demo-pass-1'})
token = login['token']
auth = {'Authorization': 'Bearer ' + token}
examples.append(('Sign in', 'POST /api/auth/login', {'email': 'admin@iot-sentinel.demo', 'password': '********'}, st, mask(login)))

st, dev = call('POST', '/devices', {'name': 'boiler-room-sensor-07', 'type': 'Smart Sensor', 'location': 'Boiler Room', 'firmwareVersion': '1.3.0'}, auth)
examples.append(('Create a device', 'POST /api/devices', {'name': 'boiler-room-sensor-07', 'type': 'Smart Sensor', 'location': 'Boiler Room', 'firmwareVersion': '1.3.0'}, st, mask(dev)))
key = dev['apiKey']

st, tel = call('POST', '/telemetry', {'temperature': 31.4, 'cpu': 22, 'memory': 47, 'battery': 88, 'signal': -61}, {'x-api-key': key})
examples.append(('Send telemetry (device key)', 'POST /api/telemetry', {'temperature': 31.4, 'cpu': 22, 'memory': 47, 'battery': 88, 'signal': -61}, st, tel))

st, lst = call('GET', '/devices?q=boiler', None, auth)
examples.append(('List / search devices', 'GET /api/devices?q=boiler', None, st, mask(lst)))

st, one = call('PATCH', f"/devices/{dev['id']}", {'location': 'Boiler Room B'}, auth)
examples.append(('Update a device', f"PATCH /api/devices/{dev['id']}", {'location': 'Boiler Room B'}, st, mask(one)))

st, m = call('POST', f"/devices/{dev['id']}/maintenance", {'kind': 'inspection', 'summary': 'Commissioning check', 'details': 'Sensor calibrated on site.'}, auth)
examples.append(('Record maintenance', f"POST /api/devices/{dev['id']}/maintenance", {'kind': 'inspection', 'summary': 'Commissioning check', 'details': 'Sensor calibrated on site.'}, st, mask(m)))

st, al = call('GET', '/alerts?status=active', None, auth)
examples.append(('List active alerts (first item)', 'GET /api/alerts?status=active', None, st, mask(al[:1] if isinstance(al, list) else al)))

st, bad = call('POST', '/devices', {'name': 'x', 'type': 'Smart Sensor', 'firmwareVersion': 'one'}, auth)
examples.append(('Validation error', 'POST /api/devices', {'name': 'x', 'type': 'Smart Sensor', 'firmwareVersion': 'one'}, st, mask(bad)))

st, none = call('GET', '/devices', None, None)
examples.append(('Missing token', 'GET /api/devices', None, st, mask(none)))

st, gone = call('DELETE', f"/devices/{dev['id']}", None, auth)
examples.append(('Delete a device', f"DELETE /api/devices/{dev['id']}", None, st, gone))

json.dump(examples, open(OUT, 'w', encoding='utf8'), indent=1)
print('recorded', len(examples), 'examples')
for e in examples:
    print(e[0], e[3])
