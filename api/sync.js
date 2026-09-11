// POST /api/sync {op, code, payload} — ponte PMS -> Google Calendar via Maton.
// A chave Maton fica em process.env.MATON_API_KEY (Vercel env, nunca no navegador).
// Ops: upsert | move | cancel | remove | ping
//
// code PMS -> [eventIds] (levantado 11/set/2026 do calendario mestre)
const GCAL_IDS = {
 '5276958152':['3o3l0aqi3mpq54610qb1haem6k'],'5966461908':['ilinuc3lk5a11oucuh0145dvr0'],
 '5372297171':['oqflhc87jvoluio8n3g9onn6cc'],'5077689913':['fbbq63eqbmebhaupdm26rubhq0'],
 '5833390567':['fk1jv2q54s8rd613ulvb58stbk'],'5624842510':['6aqri8aqet6gr4kummvc1sl7s8'],
 '6550233808':['th7fvb5t71onv5uaiscgos8kjk'],'6438756876':['tgpqcfqgpf45pudthg9plm3p48'],
 'DIR-AMIGOPAI':['bflq4ovkf20rj6scn0a228qbks'],'6322042906':['shj1tsoa4ebqpumvfb5tv54cm0'],
 'DIR-GRAZIELX':['h58ln5moco1s73r4hi94ccm064'],'DIR-TATIANE':['h2m84rc62fh2r9jd37v9i6nuqo'],
 '5553787235':['ejathbee639i4ek27pokf65oak'],'6758535376':['pqat4bdqv2lmqumjvlgha5l2bk'],
 '6133651414':['5q0cssnbgsqfuu1qlqeanc7u9s'],'5919780696':['d34op7s332emn9joplovq392mc'],
 '5643277374':['2kl1e52ohb1frgrt3k9senbu64'],'5350099465':['1fhvr05ippqf8shb5cume6fdf8'],
 '6833220672':['3opei354q5u6avqr5kd4407un4'],'5666636994':['jlen64js564lhp4pc22rncribk'],
 '5540340133':['lui3ln1egpntdddl12i93pcuuo'],'5340616788':['kiq67vgtbks7ok26r3v2oaq3v0'],
 '6144914949':['i8dc59ht607vpshuddgnilj9cs'],'6912465115':['4tjenr3akicmmq62j2mnd0ksbk'],
 '6840967150':['7i4lo1i7uphvb3hn9rih6epnok'],
 '6980943444':['_6p144gq46p0jcb9l6l1j6b9k84p3ib9p74p46b9o8crk4dpg6sqkchhj6s'],
 'DIR-IZADORAD':['deefvjbea4h5kp718nf3sou01o'],'6137444344':['n3ahiv8o9v5pmds2hqqj5su5a4'],
 'DIR-WELLINGT':['q9ihr1u8eo3bkjrkbldch2sd2k'],
 'DIR-RAISSAVO-a':['d0bdae0kr6phj2j3huionm26rk'],'DIR-RAISSAVO-b':['nrtbss7vih1138q1ttdc4v4do8'],
 'DIR-RAISSA2':['sj28tvdpqqfae9bjt6iinf5sbo'],'DIR-LETICIAP':['snitgokmumh41cgf9kjin17ch4'],
 '5118172753':['9k0mj5nn5svdh7hht977j860mk'],'5033914795':['jadbt728p1spo57p8g4ppi19a4'],
 '6628256918':['kacddpm09pcv29spufjh3169s4'],'6499845521':['4q38tjsi2v595qiotd9365cmdo'],
 'DIR-ROBLEDOF-a':['97jt98gdq598hahb1d32henh7s'],'DIR-ROBLEDOF-b':['g5agm93bui45m0bp9bnpqcai3c'],
 '6655509099-a':['5fmt432jq4grodqepilsj8oh5s'],'6655509099-b':['k6ep219e3p9e4kand06vkhgccc'],
 'DIR-GEMMINAF':['kctggvk2vdss3u4i3obci1al04'],'5046956112':['lg8j52o87eekgldhs4u7djbec0'],
 '6773189787':['02bsrvv25ai8q97kj382c744mk'],
 '5286029133-a':['j67pq91rj1u7ds2t28qgmgdmbs'],'5286029133-b':['ml4lac39usnki07c6boc41inco'],
 '5271276885-a':['jesli4tal5i0482duh2h9aapqk'],'DIR-NINASANT':['vpcqc4k7iaraeg8va4unv6qs4k']
};

const CAL = '1e4c1e04eee21cf63aa15328394c8097b3df313350c2923731eb965fa60cb0ed@group.calendar.google.com';
const CE = CAL.replace('@', '%40');
const BASE = `https://api.maton.ai/google-calendar/calendar/v3/calendars/${CE}/events`;

async function maton(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Authorization': `Bearer ${process.env.MATON_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await r.json(); } catch (e) { /* 204 vazio */ }
  return { st: r.status, data };
}

async function findIds(code) {
  if (GCAL_IDS[code]) return GCAL_IDS[code];
  // fallback: busca pelo campo Codigo: na description
  const { st, data } = await maton('GET', BASE + '?singleEvents=true&orderBy=startTime&maxResults=250');
  if (st !== 200) return [];
  const ids = [];
  for (const e of (data.items || [])) {
    const m = /^C[oó]digo\s*:\s*(\S+)/im.exec(e.description || '');
    if (m && m[1].trim() === code) ids.push(e.id);
  }
  return ids;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json({ ok: true, svc: 'pms-sync' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, err: 'POST only' });
  if (!process.env.MATON_API_KEY) return res.status(200).json({ ok: false, err: 'MATON_API_KEY nao configurada no Vercel' });

  const { op, code, payload = {} } = req.body || {};
  // trava de segurança: códigos de teste nunca criam evento real
  if (/^(SYNC-|TEST|DUMMY)/i.test(code || '') && op !== 'ping')
    return res.status(200).json({ ok: false, err: 'codigo de teste bloqueado' });
  try {
    if (op === 'ping') {
      const { st } = await maton('GET', BASE + '?maxResults=1&singleEvents=true');
      return res.status(200).json({ ok: st === 200 });
    }
    if (op === 'upsert' || op === 'move') {
      const ids = await findIds(code);
      const body = {
        summary: payload.summary || code,
        description: payload.description || '',
        start: { date: payload.ci }, end: { date: payload.co }
      };
      if (!ids.length) {
        const { st, data } = await maton('POST', BASE, body);
        return res.status(200).json({ ok: st === 200 || st === 201, ids: data.id ? [data.id] : [] });
      }
      let ok = true;
      for (const id of ids) {
        const { st } = await maton('PATCH', `${BASE}/${id}`, body);
        ok = ok && st === 200;
      }
      return res.status(200).json({ ok, ids });
    }
    if (op === 'cancel') {
      // cancelada: PATCH summary/description, MANTEM datas (quarto segue bloqueado)
      const ids = await findIds(code);
      const body = { summary: payload.summary || code, description: payload.description || '' };
      if (!ids.length) {
        const full = { ...body, start: { date: payload.ci }, end: { date: payload.co } };
        const { st, data } = await maton('POST', BASE, full);
        return res.status(200).json({ ok: st === 200 || st === 201, ids: data.id ? [data.id] : [] });
      }
      let ok = true;
      for (const id of ids) {
        const { st } = await maton('PATCH', `${BASE}/${id}`, body);
        ok = ok && st === 200;
      }
      return res.status(200).json({ ok, ids });
    }
    if (op === 'remove') {
      const ids = await findIds(code);
      let ok = true;
      for (const id of ids) {
        const { st } = await maton('DELETE', `${BASE}/${id}`);
        ok = ok && (st === 200 || st === 204);
      }
      return res.status(200).json({ ok, ids });
    }
    return res.status(200).json({ ok: false, err: 'op desconhecida: ' + op });
  } catch (e) {
    return res.status(200).json({ ok: false, err: String(e).slice(0, 200) });
  }
}
