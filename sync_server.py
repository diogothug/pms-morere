"""PMS sync backend — ponte PMS (navegador) -> Google Calendar (via Maton).
Roda na VPS. A chave Maton fica AQUI, nunca no frontend.

Uso:
  export MATON_API_KEY="$(cat ~/.hermes/keys/maton_api_key.txt)"
  python3 sync_server.py  # :8787

O frontend (pms-morere.vercel.app) chama POST /api/sync {op, code, payload}.
Ops: upsert | move | cancel | remove | ping
"""
import json, os, re, urllib.request, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get('PMS_SYNC_PORT', '8787'))
MATON = os.environ.get('MATON_API_KEY', '')
CAL_ID = '1e4c1e04eee21cf63aa15328394c8097b3df313350c2923731eb965fa60cb0ed@group.calendar.google.com'
CE = CAL_ID.replace('@', '%40')
BASE = f'https://api.maton.ai/google-calendar/calendar/v3/calendars/{CE}/events'

# code PMS -> [eventIds] (levantado 11/set/2026 do calendario mestre)
MAP_FILE = os.path.join(os.path.dirname(__file__), 'gcal_map.json')

def maton(method, url, data=None):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', f'Bearer {MATON}')
    req.add_header('Content-Type', 'application/json')
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        body = resp.read().decode()
        return resp.status, json.loads(body) if body else {}
    except Exception as e:
        # tenta extrair corpo do HTTPError
        try:
            body = e.read().decode()
            return e.code, json.loads(body) if body else {'err': body[:200]}
        except Exception:
            return 500, {'err': str(e)[:200]}

def load_map():
    try:
        return json.load(open(MAP_FILE))
    except Exception:
        return {}

def save_map(m):
    json.dump(m, open(MAP_FILE, 'w'), indent=1)

def find_by_code(code):
    """Busca eventIds pelo campo Codigo: na description (fonte da verdade)."""
    m = load_map()
    if code in m:
        return m[code]
    # fallback: lista eventos e casa por description
    st, data = maton('GET', BASE + '?singleEvents=true&orderBy=startTime&maxResults=250')
    ids = []
    for e in data.get('items', []):
        d = e.get('description', '') or ''
        mm = re.search(r'^C[oó]digo\s*:\s*(\S+)', d, re.M | re.I)
        if mm and mm.group(1).strip() == code:
            ids.append(e['id'])
    if ids:
        m[code] = ids
        save_map(m)
    return ids

def upsert(code, p):
    """Cria ou atualiza todos os eventos do codigo. Retorna ids."""
    ids = find_by_code(code)
    body = {
        'summary': p.get('summary', code),
        'description': p.get('description', ''),
        'start': {'date': p['ci']}, 'end': {'date': p['co']},
    }
    if not ids:
        st, data = maton('POST', BASE, json.dumps(body).encode())
        if st in (200, 201) and data.get('id'):
            m = load_map(); m[code] = [data['id']]; save_map(m)
            return True, [data['id']]
        return False, data
    ok, out = True, []
    for eid in ids:
        st, data = maton('PATCH', f'{BASE}/{eid}', json.dumps(body).encode())
        out.append(eid); ok = ok and st == 200
    return ok, out

def cancel(code, p):
    """Cancelada: PATCH summary/description, MANTEM as datas (bloqueia o quarto)."""
    body = dict(summary=p.get('summary', code), description=p.get('description', ''))
    ids = find_by_code(code)
    if not ids:
        return upsert(code, p)
    ok = True
    for eid in ids:
        st, _ = maton('PATCH', f'{BASE}/{eid}', json.dumps(body).encode())
        ok = ok and st == 200
    return ok, ids

def remove(code):
    """Excluida no PMS: DELETE real no GCAL."""
    ids = find_by_code(code)
    ok = True
    for eid in ids:
        st, _ = maton('DELETE', f'{BASE}/{eid}')
        ok = ok and st in (200, 204)
    m = load_map(); m.pop(code, None); save_map(m)
    return ok, ids

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        self.send_response(200); self._cors()
        self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'ok': True, 'svc': 'pms-sync'}).encode())

    def do_POST(self):
        if self.path != '/api/sync':
            self.send_response(404); self._cors(); self.end_headers(); return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)) or 0))
        except Exception:
            body = {}
        op, code, p = body.get('op'), body.get('code'), body.get('payload', {})
        try:
            if op == 'ping':
                st, _ = maton('GET', BASE + '?maxResults=1&singleEvents=true')
                res = {'ok': st == 200}
            elif op in ('upsert', 'move'):
                ok, ids = upsert(code, p); res = {'ok': ok, 'ids': ids}
            elif op == 'cancel':
                ok, ids = cancel(code, p); res = {'ok': ok, 'ids': ids}
            elif op == 'remove':
                ok, ids = remove(code); res = {'ok': ok, 'ids': ids}
            else:
                res = {'ok': False, 'err': f'op desconhecida: {op}'}
        except Exception as e:
            res = {'ok': False, 'err': str(e)[:200]}
        out = json.dumps(res).encode()
        self.send_response(200); self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out))); self.end_headers()
        self.wfile.write(out)

if __name__ == '__main__':
    if not MATON:
        print('MATON_API_KEY vazia — exporte antes de rodar.')
    print(f'pms-sync na porta {PORT} (map: {MAP_FILE})')
    HTTPServer(('127.0.0.1', PORT), H).serve_forever()
