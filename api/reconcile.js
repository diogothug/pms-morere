// POST /api/reconcile {pms: [...]} → {summary, diffs, findings}
// GET /api/reconcile → status (só diz se as envs existem, sem vazar nada)
// Pipeline: GCAL (via Maton) × PMS (enviado pelo app) → diff determinístico (pms-core)
// → review LLM (OpenRouter) → findings auto|confirm. Auto de GCAL-side aplica aqui;
// o resto o frontend aplica com 1 clique (ou pede tua confirmação).
const { reconcile } = require('./_reconcile.js');

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET')
    return res.status(200).json({
      ok: true, svc: 'pms-reconcile',
      env: { maton: !!process.env.MATON_API_KEY, llm: !!process.env.OPENROUTER_API_KEY }
    });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, err: 'POST only' });
  if (!process.env.MATON_API_KEY)
    return res.status(200).json({ ok: false, err: 'MATON_API_KEY nao configurada no Vercel' });

  const { pms, autoApply } = req.body || {};
  if (!Array.isArray(pms))
    return res.status(200).json({ ok: false, err: 'envie {pms:[...]}' });
  try {
    const out = await reconcile({
      pmsList: pms,
      apiKey: process.env.MATON_API_KEY,
      llmKey: process.env.OPENROUTER_API_KEY || '',
      autoApply: autoApply !== false
    });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, err: String(e).slice(0, 300) });
  }
}
