/* harness: node test/reconcile.harness.cjs
   Loop 1 (fixtures): diffRecords contra casos conhecidos.
   Loop 2 (dados vivos): GCAL real via Maton × PMS real do index.html (SEED).
   Sai nonzero se qualquer assert falhar. */
const fs = require('fs');
const path = require('path');
const C = require('../api/pms-core.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; /* console.log('ok', name); */ }
  else { fail++; console.log('FAIL', name, '\n  got: ', a, '\n  want:', b); }
}

/* ---------- Loop 1: fixtures ---------- */
console.log('== Loop 1: fixtures ==');

// 1. suiteToRoom
eq('room Q8 Bangalô', C.suiteToRoom('Q8 Bangalô'), 'Q8');
eq('room genérico Booking → null', C.suiteToRoom('Quarto Duplo (tipo 3,4,5)'), null);
eq('room Deluxe vista-mar → Q6', C.suiteToRoom('Quarto Duplo Deluxe com Vista do Mar'), 'Q6');
eq('room "2x Quarto Duplo" → null (multi-room ambiguo)', C.suiteToRoom('2x Quarto Duplo'), null);
eq('room lista "Q3,4,5" → null', C.suiteToRoom('Q3 Peguari, Q4 Lagosta, Q5 Xaréu (3,4,5)'), null);
eq('room vazia → null', C.suiteToRoom(''), null);

// 2. parseBRL
eq('BRL "R$ 1.860,00"', C.parseBRL('R$ 1.860,00'), 1860);
eq('BRL "1650"', C.parseBRL('1650'), 1650);
eq('BRL "A combinar" → null', C.parseBRL('A combinar'), null);
eq('BRL vazia → null', C.parseBRL(''), null);
eq('BRL "R$ 4.721,60 total (2 quartos)"', C.parseBRL('R$ 4.721,60 total (2 quartos)'), 4721.6);
eq('BRL "3.019.00" (milhar+decimal)', C.parseBRL('3.019.00'), 3.019);

// 3. parseGcalEvent
const ev1 = {
  id: 'x1', summary: 'Maria Cristiana S V Pereira — 6655509099 — Quarto Duplo (2/2)',
  description: 'Codigo: 6655509099\nPlataforma: Booking\nHospede: Maria Cristiana S V Pereira\nCheck-in: 2027-01-16\nCheck-out: 2027-01-20\nSuite: Quarto Duplo (tipo 3,4,5) (2/2)\nValor: R$ 4.721,60 total (2 quartos)',
  start: { date: '2027-01-16' }, end: { date: '2027-01-20' }
};
const p1 = C.parseGcalEvent(ev1);
eq('multiroom (2/2) code', p1.code, '6655509099-b');
eq('multiroom room genérico → null', p1.room, null);
eq('multiroom total', p1.total, 4721.6);

const ev2 = {
  id: 'x2', summary: 'Tatiane — Manual — Bangalô (Q8)',
  description: 'Codigo: MANUAL\nPlataforma: Direta\nSuite: \nDeposito: R$ 330,00',
  start: { date: '2026-09-25' }, end: { date: '2026-09-28' }
};
eq('CODE_ALIASES MANUAL → DIR-TATIANE', C.parseGcalEvent(ev2).code, 'DIR-TATIANE');

const ev3 = {
  id: 'x3', summary: 'Fulano — 123 — Q3 (CANCELADA)',
  description: 'Codigo: 123\nCheck-in: 2026-10-01\nCheck-out: 2026-10-03',
  start: { date: '2026-10-01' }, end: { date: '2026-10-03' }
};
eq('cancelled flag', C.parseGcalEvent(ev3).cancelled, true);

// 4. diffRecords — divergências básicas
const pms = [
  { code: 'A1', guest: 'Ana', ci: '2026-10-01', co: '2026-10-05', room: 'Q3', channel: 'Booking', total: 800, paid: 0, status: 'confirmada', pax: '2 adultos' },
  { code: 'B2', guest: 'Beto', ci: '2026-10-03', co: '2026-10-06', room: 'Q3', channel: 'Booking', total: 900, paid: 0, status: 'confirmada', pax: '2 adultos' },
  { code: 'C3', guest: 'Cida', ci: '2026-11-01', co: '2026-11-03', room: null, channel: 'Booking', total: 500, paid: 0, status: 'confirmada', pax: '2 adultos' }
];
const gcal = [
  { id: 'g1', code: 'A1', guest: 'Ana', ci: '2026-10-01', co: '2026-10-06', room: null, suiteText: 'Quarto Duplo', channel: 'Booking', total: 800, paid: null, cancelled: false },
  { id: 'g2', code: 'ZZ9', guest: 'Zé', ci: '2026-12-01', co: '2026-12-03', room: 'Q5', suiteText: 'Q5', channel: 'Booking', total: 600, paid: null, cancelled: false }
];
const diffs = C.diffRecords(pms, gcal);
const kinds = diffs.map(d => d.kind).sort();
eq('kinds básicos', kinds, ['date_mismatch', 'missing_in_gcal', 'missing_in_gcal', 'phantom', 'room_conflict', 'room_unassigned_gcal', 'unassigned'].sort());
eq('missing B2', diffs.find(d => d.kind === 'missing_in_gcal' && d.code === 'B2') ? true : false, true);

// 5. parseReviewResponse
const fake = '```json\n{"findings":[{"id":"D1","verdict":"auto","direction":"gcal->pms","message":"ok","apply":{"code":"A1","fields":{"co":"2026-10-06"}}}]}```';
const pr = C.parseReviewResponse(fake);
eq('parse review', pr && pr[0] && pr[0].apply.fields.co, '2026-10-06');
eq('parse review inválido → null', C.parseReviewResponse('sem json aqui'), null);
eq('fallback tudo confirm', C.fallbackFindings([{ id: 'D1', msg: 'x' }])[0].verdict, 'confirm');

/* ---------- Loop 2: dados vivos ---------- */
console.log('== Loop 2: dados vivos (GCAL × PMS) ==');
(async () => {
  const https = require('https');
  const key = fs.readFileSync(process.env.HOME + '/.hermes/keys/maton_api_key.txt', 'utf8').trim();
  const CID = '1e4c1e04eee21cf63aa15328394c8097b3df313350c2923731eb965fa60cb0ed@group.calendar.google.com'.replace('@', '%40');
  const q = `timeMin=${encodeURIComponent('2026-09-01T00:00:00-03:00')}&timeMax=${encodeURIComponent('2027-03-15T00:00:00-03:00')}&singleEvents=true&orderBy=startTime&maxResults=250`;
  const url = `https://api.maton.ai/google-calendar/calendar/v3/calendars/${CID}/events?${q}`;
  const raw = await new Promise((res, rej) => {
    https.get(url, { headers: { Authorization: 'Bearer ' + key } }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => res(b));
    }).on('error', rej);
  });
  const items = JSON.parse(raw).items || [];
  console.log('eventos GCAL:', items.length);
  const parsed = items.map(C.parseGcalEvent).filter(g => g.code);

  // PMS: extrai SEED do index.html e avalia num sandbox
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const seedSrc = js.match(/function SEED\(\)\{return (\[[\s\S]*?\]);\}/)[1];
  const R = (code, guest, ci, co, room, channel, total, paid, status, pax, extra) =>
    Object.assign({ code, guest, ci, co, room, channel, total, paid: paid || 0, status, pax }, extra || {});
  const seed = eval(seedSrc);
  console.log('reservas PMS:', seed.length);

  const d2 = C.diffRecords(seed, parsed);
  const byKind = {};
  d2.forEach(d => { byKind[d.kind] = (byKind[d.kind] || 0) + 1; });
  console.log('diffs por kind:', JSON.stringify(byKind));
  // invariantes vivos:
  eq('zero date_mismatch (PMS sincronizado c/ GCAL)', byKind['date_mismatch'] || 0, 0);
  eq('zero missing_in_gcal', byKind['missing_in_gcal'] || 0, 0);
  eq('zero phantom', byKind['phantom'] || 0, 0);
  eq('zero allocation_violation', byKind['allocation_violation'] || 0, 0);
  // conflito conhecido Leticia x Almog (Q6, jan/27) — aguardando decisao do Diogo; o harness
  // garante que ele CONTINUA detectado (se sumir sem resolucao, o diff quebrou)
  eq('conflito conhecido Leticia/Almog segue detectado', (byKind['room_conflict'] || 0) >= 1, true);

  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e.message); process.exit(2); });
