// Harmonized PMS↔GCAL reconcile service — shared by /api/reconcile (Vercel) and cron.
const PMSCore = require('./pms-core.js');

const CAL = '1e4c1e04eee21cf63aa15328394c8097b3df313350c2923731eb965fa60cb0ed@group.calendar.google.com';
const CE = CAL.replace('@', '%40');
const BASE = `https://api.maton.ai/google-calendar/calendar/v3/calendars/${CE}/events`;

function maton(method, url, body, apiKey) {
  return fetch(url, {
    method,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  }).then(async r => {
    let data = {};
    try { data = await r.json(); } catch (e) { /* 204 */ }
    return { st: r.status, data };
  });
}

async function fetchGcalEvents(apiKey, tmin, tmax) {
  const q = `timeMin=${encodeURIComponent(tmin)}&timeMax=${encodeURIComponent(tmax)}&singleEvents=true&orderBy=startTime&maxResults=250`;
  const { st, data } = await maton('GET', `${BASE}?${q}`, null, apiKey);
  if (st !== 200) throw new Error('GCAL list falhou: ' + st);
  return data.items || [];
}

/* ---------- LLM review (OpenRouter; modelo barato) ---------- */
const REVIEW_MODEL = process.env.RECONCILE_MODEL || 'google/gemini-3.5-flash-lite';

function reviewPrompt(diffs, ctx) {
  return `Você é o revisor de conciliação entre o PMS (app da pousada) e o Google Calendar (calendário mestre).
Contexto: ${JSON.stringify(ctx)}

Regras de decisão (veredito por divergência):
- "auto" = correção segura e óbvia, pode aplicar sem perguntar. Direção:
  - "gcal->pms": GCAL é fonte primária de DATAS (Diogo arrasta eventos na UI) → trazer ci/co do GCAL p/ o PMS.
  - "pms->gcal": PMS é fonte de STATUS FINANCEIRO (sinais/pago) e de ALOCAÇÃO de quartos (regra 3→4→5) → empurrar p/ o GCAL.
  - Nomes: preferir o mais completo (ex "Bruna Naiane Alexandrino Santos" > "Bruna Naiane A. Santos").
  - Valores "total (2 quartos)" no GCAL vs rateado por membro no PMS: NÃO é divergência, marcar auto SEM apply (só registrar).
- "confirm" = qualquer coisa destrutiva, ambígua ou com impacto em hóspede: excluir evento, cancelar reserva, trocar quarto de reserva confirmada próxima (<7 dias), conflito real de quarto (2 hóspedes no mesmo quarto), fantasma no GCAL (pode ser reserva nova que o Diogo criou direto no calendário), valor divergente com dinheiro envolvido. NUNCA auto-aplicar esses.

Formato de resposta: JSON PURO (sem markdown), exatamente:
{"findings":[{"id":"D1","verdict":"auto|confirm","direction":"gcal->pms|pms->gcal|","message":"...","apply":null|{"code":"...","fields":{"ci|co|room|guest|total|paid|status|obs":"..."}}}]}
- apply.fields só com os campos que mudam. Para status cancelada use {"status":"cancelada"}.
- Para criar evento que falta no GCAL: {"create":true,"code":"..."} (o backend cria a partir do PMS).
- Para quarto: respeite a regra de alocação e a manutenção do Q4 até 2026-10-15.

Divergências:
${JSON.stringify(diffs)}`;
}

async function llmReview(diffs, ctx, llmKey) {
  const body = {
    model: REVIEW_MODEL,
    temperature: 0,
    max_tokens: 4000,
    messages: [{ role: 'user', content: reviewPrompt(diffs, ctx) }]
  };
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${llmKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://pms-morere.vercel.app', 'X-Title': 'PMS Morere Reconcile' },
    body: JSON.stringify(body)
  });
  if (!r.ok) return { ok: false, err: 'LLM HTTP ' + r.status };
  const j = await r.json();
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  const findings = PMSCore.parseReviewResponse(text);
  if (!findings) return { ok: false, err: 'LLM retornou JSON inválido' };
  return { ok: true, findings, model: REVIEW_MODEL };
}

/* ---------- apply ---------- */
async function applyFinding(f, pmsList, apiKey) {
  // retorna {applied, detail}
  if (!f.apply) return { applied: false, detail: 'sem apply' };
  const a = f.apply;
  if (a.create) {
    return { applied: false, detail: 'create via sync upsert (frontend ou próxima reconciliação)' };
  }
  if (a.fields && a.fields.room !== undefined) {
    // quarto: empurra p/ GCAL via PATCH de suite no evento (o sync.js faz upsert completo depois)
    return { applied: false, detail: 'room aplicado no PMS pelo frontend; GCAL via upsert' };
  }
  return { applied: false, detail: 'apply registrado p/ frontend' };
}

async function reconcile({ pmsList, apiKey, llmKey, tmin, tmax, autoApply = false }) {
  const events = await fetchGcalEvents(apiKey, tmin || '2026-09-01T00:00:00-03:00', tmax || '2027-03-15T00:00:00-03:00');
  const parsed = events.map(PMSCore.parseGcalEvent).filter(g => g.code);
  const diffs = PMSCore.diffRecords(pmsList || [], parsed);
  const ctx = PMSCore.reviewContext(pmsList);
  let findings, llmOk = false, llmErr = '';
  if (diffs.length && llmKey) {
    const r = await llmReview(diffs, ctx, llmKey);
    if (r.ok) { findings = r.findings; llmOk = true; }
    else { llmErr = r.err; findings = PMSCore.fallbackFindings(diffs); }
  } else if (diffs.length) {
    findings = PMSCore.fallbackFindings(diffs);
    llmErr = 'sem LLM key';
  } else findings = [];
  // auto-aplica somente verdict=auto com apply concreto (datas pms-side NÃO — frontend aplica; aqui só GCAL-side)
  const applied = [];
  if (autoApply) {
    for (const f of findings) {
      if (f.verdict === 'auto' && f.direction === 'pms->gcal' && f.apply && f.apply.fields) {
        applied.push({ id: f.id, detail: 'marcado p/ upsert (executado pelo sync)' });
      }
    }
  }
  const needConfirm = findings.filter(f => f.verdict === 'confirm');
  const auto = findings.filter(f => f.verdict === 'auto');
  return {
    ok: true, llmOk, llmErr, model: REVIEW_MODEL,
    summary: { diffs: diffs.length, auto: auto.length, confirm: needConfirm.length, applied: applied.length },
    diffs, findings, applied
  };
}

module.exports = { reconcile, fetchGcalEvents };
