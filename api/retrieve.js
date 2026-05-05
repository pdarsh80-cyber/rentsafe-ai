// api/retrieve.js
// POST endpoint that takes a clause + state and returns the most relevant
// statutes and any matched void-clause patterns from the local corpus.
//
// Body: { clause: string, state: string, limit?: number }
// Returns:
//   {
//     statutes: [{ id, act_name, section, jurisdiction, text, plain_summary, topics }],
//     patterns: [{ id, title, severity, why_void, citation_ids, replacement_clause }]
//   }

const corpus = require('./_lib/corpus');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const body = req.body || {};
  const clause = body.clause;
  const state = body.state;
  const limit = Number.isFinite(body.limit) ? Math.min(Math.max(body.limit, 1), 20) : 5;

  if (!clause || typeof clause !== 'string' || clause.trim().length < 5) {
    return res.status(400).json({ error: { message: 'clause is required and must be a non-trivial string' } });
  }
  if (!state) {
    return res.status(400).json({ error: { message: 'state is required' } });
  }
  if (!corpus.normalizeState(state)) {
    return res.status(400).json({ error: { message: 'unknown state: ' + state } });
  }

  const statutes = corpus.searchStatutes(clause, state, limit).map(s => ({
    id: s.id,
    act_id: s.act_id,
    act_name: s.act_name || s.act_id,
    section: s.section,
    jurisdiction: s.jurisdiction,
    text: s.text,
    plain_summary: s.plain_summary,
    topics: s.topics || []
  }));

  const patterns = corpus.searchPatterns(clause, state).map(p => ({
    id: p.id,
    title: p.title,
    severity: p.severity,
    why_void: p.why_void,
    citation_ids: p.citation_ids || [],
    replacement_clause: p.replacement_clause,
    perspective: p.perspective
  }));

  return res.status(200).json({
    statutes,
    patterns,
    _meta: {
      state_code: corpus.normalizeState(state),
      corpus_version: '0.1.0'
    }
  });
};
