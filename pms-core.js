/* pms-core.js — lógica PURA de conciliação PMS ↔ GCAL (sem DOM, sem fetch).
   Usado pelo index.html (browser) e pelo harness test/reconcile.harness.cjs (node).
   Contrato: diffRecords(pmsList, gcalParsedList) -> diffs[]; LLM decide; apply é no index. */
const PMSCore = (() => {

  const ROOM_ALIASES = [
    // Q explícito tem prioridade sobre nome (ex "Q2 (Bangalo 2)" é Q2, não Q8)
    [/q2(?![0-9])/i, 'Q2'], [/q3(?![0-9])/i, 'Q3'], [/q4(?![0-9])/i, 'Q4'], [/q5(?![0-9])/i, 'Q5'],
    [/q6(?![0-9])/i, 'Q6'], [/q7(?![0-9])/i, 'Q7'], [/q8(?![0-9])/i, 'Q8'], [/q9|mirante/i, 'Q9'],
    [/peguari/i, 'Q3'], [/lagosta/i, 'Q4'], [/xar[eé]u/i, 'Q5'],
    [/budi[aã]o|deluxe.*vista|vista.*mar/i, 'Q6'], [/bangal[oô]/i, 'Q8']
  ];
  // códigos GCAL legados que mapeiam p/ código PMS diferente
  const CODE_ALIASES = { 'MANUAL': 'DIR-TATIANE' };

  function suiteToRoom(s) {
    if (!s) return null;
    s = String(s);
    // genérico Booking sem quarto físico identificável → null
    if (/quarto duplo|standard|a definir/i.test(s) && !/deluxe|vista|bangal|q[2-9]|peguari|lagosta|xar|budi/i.test(s)) return null;
    if (/suite dupla|suite padr/i.test(s) && !/q[2-9]/i.test(s)) return null;
    // "Q3,4,5" / listas de múltiplos quartos → null (ambíguo)
    if (/q\s*3\s*[,\/]\s*4/i.test(s) || /q3.*q4|q4.*q5|3,4,5/i.test(s)) return null;
    for (const [re, q] of ROOM_ALIASES) if (re.test(s)) return q;
    return null;
  }

  function parseBRL(s) {
    if (s == null) return null;
    let t = String(s).trim();
    if (/a combinar|pendente|aguardando|^\s*$|—|^-$/.test(t)) return null;
    // parêntese explicativo: "R$ 0 (sinal unico...)" / "R$ 3.340,00 (1/2 do total...)" → só o valor
    t = t.split('(')[0].trim();
    t = t.replace(/R\$\s*/g, '').trim();
    // "9.100" / "3.340" sem centavos = milhar (padrão GCAL); com ",xx" = decimal BR
    if (/,/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    const v = parseFloat(t);
    return isFinite(v) ? v : null;
  }

  function fold(s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  function fld(desc, name) {
    // GCAL usa " | " como separador inline: "Codigo: X | Plataforma: ..." — captura até o pipe
    const m = new RegExp('^' + name + '\\s*:\\s*([^|\\n\\r]+)', 'im').exec(desc || '');
    return m ? m[1].trim() : '';
  }

  // nome do hóspede: extrai de "Hóspede:" (GCAL antigo, sem prefixo) ou "Hospede:"
  function gcalGuest(d, summaryParts) {
    let g = fld(d, 'Hospede');
    if (g) {
      // GCAL antigo grava "Hóspede: Nome | Pax: ... | Valor: ..." tudo na mesma linha
      g = g.split('|')[0].trim();
      // linha de detalhe numérica (ex "Hóspede: 6133651414") não é nome
      if (/^\d{6,}$/.test(g)) g = '';
    }
    return g || summaryParts[0] || '';
  }

  function parseGcalEvent(e) {
    const d = (e.description || '').replace(/\r/g, '');
    const summary = e.summary || '';
    const parts = summary.split('—').map(s => s.trim());
    // código: description "Codigo:" (novo) ou inline "Código: X | Hóspede:" (GCAL antigo) ou summary (fallback)
    let code = fld(d, 'C[oó]digo') || parts[1] || '';
    code = code.split('|')[0].trim();
    if (CODE_ALIASES[code]) code = CODE_ALIASES[code];
    // multi-room: "(1/2)" → -a, "(2/2)" → -b
    let suffix = '';
    if (/\(1\/2\)/.test(summary)) suffix = '-a';
    else if (/\(2\/2\)/.test(summary)) suffix = '-b';
    if (suffix && code && !/-a$|-b$/.test(code)) code = code + suffix;
    const guest = gcalGuest(d, parts);
    const suiteText = fld(d, 'Suite') || parts[2] || '';
    // Raissa (grupo): "Valor: R$ 5.500,00 total (2 quartos)" → total do GRUPO, não por membro.
    // O PMS rateia (2750 cada); o diff de grupo já cobre a checagem — não comparar por membro.
    const isGroupValue = /total\s*\(\s*2\s*quartos\s*\)/i.test(d);
    let plat = fld(d, 'Plataforma') || '';
    plat = /booking/i.test(plat) ? 'Booking' : /airbnb/i.test(plat) ? 'Airbnb' : (plat ? 'Direta' : '');
    const s = e.start || {}, en = e.end || {};
    const ci = (s.date || String(s.dateTime || '').slice(0, 10));
    const co = (en.date || String(en.dateTime || '').slice(0, 10));
    return {
      id: e.id, code, guest, ci, co,
      room: suiteToRoom(suiteText), suiteText, groupValue: isGroupValue,
      channel: plat, total: parseBRL(fld(d, 'Valor total') || fld(d, 'Valor')),
      paid: parseBRL(fld(d, 'Sinal pago') || fld(d, 'Pago')),
      pax: fld(d, 'Pax'),
      cancelled: /cancelada/i.test(summary),
      summary
    };
  }

  function baseCode(code) { return String(code || '').replace(/-a$|-b$/, ''); }

  function overlaps(a, b) {
    return a.room && a.room === b.room && a.ci < b.co && b.ci < a.co;
  }

  /* diffRecords: compara PMS (S.res) com eventos GCAL parseados.
     Retorna diffs: {id, kind, code, msg, pms?, gcal?, members?} */
  function diffRecords(pmsList, gcalList) {
    const diffs = [];
    let n = 0;
    const D = (d) => diffs.push(Object.assign({ id: 'D' + (++n) }, d));
    const pmsByCode = {};
    (pmsList || []).forEach(r => { pmsByCode[r.code] = r; });
    const gcalByCode = {};
    (gcalList || []).forEach(g => {
      if (!g.code) return;
      (gcalByCode[g.code] = gcalByCode[g.code] || []).push(g);
    });

    // 1) grupos multi-room: base com membros -a/-b no PMS mas evento(s) base no GCAL
    const handledPms = new Set(), handledGcalIds = new Set();
    const groupMembers = (base) => [pmsByCode[base + '-a'], pmsByCode[base + '-b']].filter(Boolean);
    // evento GCAL sem sufixo cuja base tem membros -a/-b no PMS → grupo
    Object.keys(gcalByCode).forEach(code => {
      if (/-a$|-b$/.test(code)) return;
      const members = groupMembers(code);
      if (!members.length) return;
      const evs = gcalByCode[code];
      members.forEach(m => handledPms.add(m.code));
      evs.forEach(g => handledGcalIds.add(g.id));
      const g = evs[0];
      // datas: evento cobre o span dos membros?
      const cis = members.map(m => m.ci).sort(), cos = members.map(m => m.co).sort();
      if (g.ci !== cis[0] || g.co !== cos[cos.length - 1]) {
        D({ kind: 'multiroom_dates', code, msg: `Grupo ${code}: GCAL ${g.ci}→${g.co} vs PMS ${cis[0]}→${cos[cos.length - 1]}`, members: members.map(m => m.code), gcal: g });
      }
      // quartos alocados no PMS mas evento genérico → sugerir push p/ GCAL
      const rooms = members.map(m => m.room || '?').join('+');
      if (!g.room) {
        D({ kind: 'multiroom_rooms', code, msg: `Grupo ${code}: PMS alocou ${rooms}, GCAL genérico ("${g.suiteText}")`, members: members.map(m => ({ code: m.code, room: m.room })), gcal: g });
      }
    });

    // 2) match 1:1
    Object.keys(pmsByCode).forEach(code => {
      if (handledPms.has(code)) return;
      const r = pmsByCode[code];
      if (/^BLOQ-/.test(code)) return; // bloqueios são locais do PMS
      const evs = (gcalByCode[code] || []).filter(g => !handledGcalIds.has(g.id));
      if (!evs.length) {
        // janela do harness/GCAL começa em set/26: histórico anterior não é divergência
        if (r.status !== 'cancelada' && r.co >= '2026-09-01') D({ kind: 'missing_in_gcal', code, msg: `${r.guest} (${code} ${r.ci}→${r.co}) existe no PMS mas NÃO tem evento no GCAL`, pms: pick(r) });
        return;
      }
      const g = evs[0];
      handledGcalIds.add(g.id);
      if (r.ci !== g.ci || r.co !== g.co)
        D({ kind: 'date_mismatch', code, msg: `${r.guest}: PMS ${r.ci}→${r.co} vs GCAL ${g.ci}→${g.co}`, pms: { ci: r.ci, co: r.co }, gcal: { ci: g.ci, co: g.co } });
      const pr = r.room || null, gr = g.room || null;
      if (pr && !gr)
        D({ kind: 'room_unassigned_gcal', code, msg: `${r.guest}: PMS ${pr}, GCAL genérico ("${g.suiteText || '?'}")`, pms: { room: pr }, gcal: { suiteText: g.suiteText } });
      else if (!pr && gr)
        D({ kind: 'room_missing_pms', code, msg: `${r.guest}: GCAL ${gr}, PMS sem quarto`, pms: { room: null }, gcal: { room: gr } });
      else if (pr && gr && pr !== gr)
        D({ kind: 'room_mismatch', code, msg: `${r.guest}: PMS ${pr} vs GCAL ${gr}`, pms: { room: pr }, gcal: { room: gr } });
      // nome: tolera "(nome a confirmar)", sufixo "(2a reserva)" e abreviação "A." vs "Alves"
      const fg = fold(r.guest).replace(/\s*\(.*?\)\s*/g, '').trim(), gg = fold(g.guest).replace(/\s*\(.*?\)\s*/g, '').trim();
      const tokensG = gg.split(' ').filter(t => t.length > 1 && !/^(a|de|da|do|dos|e)$/.test(t));
      const guestSame = fg === gg || (gg && fg.startsWith(gg)) || (gg && gg.startsWith(fg)) ||
        tokensG.length > 1 && tokensG.every(t => fg.includes(t) || fg.split(' ').some(w => w.startsWith(t[0]) && Math.abs(w.length - t.length) <= 4));
      if (!guestSame && g.guest)
        D({ kind: 'guest_mismatch', code, msg: `Nome: PMS "${r.guest}" vs GCAL "${g.guest}"`, pms: { guest: r.guest }, gcal: { guest: g.guest } });
      if (r.total != null && g.total != null && !g.groupValue && Math.abs(r.total - g.total) > 0.5)
        D({ kind: 'value_mismatch', code, msg: `Valor: PMS R$${r.total} vs GCAL R$${g.total}`, pms: { total: r.total }, gcal: { total: g.total } });
      if (r.paid != null && g.paid != null && Math.abs(r.paid - g.paid) > 0.5)
        D({ kind: 'paid_mismatch', code, msg: `Sinal: PMS R$${r.paid} vs GCAL R$${g.paid}`, pms: { paid: r.paid }, gcal: { paid: g.paid } });
      if (r.status === 'cancelada' && !g.cancelled)
        D({ kind: 'status_mismatch', code, msg: `${r.guest}: PMS cancelada, GCAL ativo`, pms: { status: 'cancelada' }, gcal: { status: 'ativo' } });
      if (r.status !== 'cancelada' && g.cancelled)
        D({ kind: 'status_mismatch', code, msg: `${r.guest}: GCAL marcado CANCELADA, PMS ${r.status}`, pms: { status: r.status }, gcal: { status: 'cancelada' } });
    });

    // 3) fantasmas: no GCAL mas não no PMS
    Object.keys(gcalByCode).forEach(code => {
      if (pmsByCode[code] || groupMembers(code).length) return;
      gcalByCode[code].forEach(g => {
        if (handledGcalIds.has(g.id)) return;
        handledGcalIds.add(g.id);
        D({ kind: 'phantom', code, msg: `GCAL tem "${g.guest}" ${g.ci}→${g.co} (${g.suiteText || 's/ quarto'}) — fora do PMS`, gcal: g });
      });
    });

    // 4) violações de alocação + conflitos (só PMS, p/ o LLM julgar com contexto)
    const Q4_INI = '2026-09-22', Q4_FIM = '2026-10-15';
    (pmsList || []).forEach(r => {
      if (['cancelada', 'checkout', 'bloqueio', 'manutencao'].includes(r.status)) return;
      if (r.channel === 'Booking' && !r.room && r.co >= '2026-09-11')
        D({ kind: 'unassigned', code: r.code, msg: `${r.guest} (${r.ci}→${r.co}) Booking sem quarto`, pms: pick(r) });
      if (r.room === 'Q4' && r.ci < Q4_FIM && r.co > Q4_INI)
        D({ kind: 'allocation_violation', code: r.code, msg: `${r.guest} alocada Q4 em período de manutenção (até ${Q4_FIM})`, pms: pick(r) });
    });
    const act = (pmsList || []).filter(r => !['cancelada', 'checkout'].includes(r.status));
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++)
      if (overlaps(act[i], act[j]))
        D({ kind: 'room_conflict', code: act[i].code, msg: `Conflito ${act[i].room}: ${act[i].guest} × ${act[j].guest} (${act[i].ci}→${act[i].co} vs ${act[j].ci}→${act[j].co})`, members: [act[i].code, act[j].code] });

    return diffs;
  }

  function pick(r) {
    return { code: r.code, guest: r.guest, ci: r.ci, co: r.co, room: r.room, channel: r.channel, total: r.total, paid: r.paid, status: r.status, pax: r.pax };
  }

  function reviewContext(pmsList) {
    const t = new Date();
    const iso = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    return {
      today: iso,
      allocationRule: 'Booking "3,4,5"/suite dupla/padrao → Q3; cheio → Q4; ambos cheios → Q5. Deluxe vista-mar → Q6. Bangalo → Q8.',
      q4Maintenance: 'Q4 em manutenção 2026-09-22 → 2026-10-15 (fallback Q3→Q5 no período)',
      notes: 'GCAL é a fonte primária de DATAS (Diogo arrasta eventos na UI). PMS é fonte de status financeiro (sinais). Códigos -a/-b são multi-room (mesmo código base). BLOQ-* são locais do PMS.'
    };
  }

  /* fallback quando o LLM falha: tudo vira confirm (nada auto-aplica no escuro) */
  function fallbackFindings(diffs) {
    return (diffs || []).map(d => ({
      id: d.id, verdict: 'confirm', direction: '',
      message: d.msg + ' (LLM indisponível — revisar manualmente)',
      apply: null
    }));
  }

  /* valida/normaliza resposta do LLM */
  function parseReviewResponse(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      const j = JSON.parse(t.slice(a, b + 1));
      const f = j.findings || j.results || j.items;
      if (!Array.isArray(f)) return null;
      return f.filter(x => x && x.id && /^(auto|confirm)$/.test(x.verdict)).map(x => ({
        id: x.id, verdict: x.verdict, direction: x.direction || '',
        message: String(x.message || x.reason || ''),
        apply: x.apply || null
      }));
    } catch (e) { return null; }
  }

  return {
    suiteToRoom, parseBRL, fold, parseGcalEvent, diffRecords,
    reviewContext, fallbackFindings, parseReviewResponse, CODE_ALIASES
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PMSCore;
