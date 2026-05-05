// api/audit.js
// Refactored: grounded RAG-style audit with citation verification.
//
// Pipeline:
//   1. Build a system prompt that injects the actual statute text and the
//      void-clause pattern catalog (filtered by the user's state).
//   2. Force the model to cite ONLY ids that appear in the injected corpus.
//   3. After the model returns, verify every citation_id and matched_pattern
//      against the corpus. Drop unverified ones, attach replacement_clause
//      from any matched pattern.
//   4. Build legacy `clause_ref` and `citation` strings so the existing
//      frontend keeps working without any FE changes.
//
// Backward-compatible response shape (existing fields preserved). New fields
// added: findings[].clause_quote, .citation_ids, .citations[],
// .matched_pattern, .replacement_clause, .pattern_title, ._meta.

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const corpus = require('./_lib/corpus');

function buildSystemPrompt(state) {
  const statutes = corpus.getRelevantStatutes(state);
  const patterns = corpus.getRelevantPatterns(state);

  const statuteBlock = statutes.length
    ? statutes.map(s => {
        const label = `${s.act_name || s.act_id} §${s.section}` +
          (s.jurisdiction !== 'national' ? ` (${s.jurisdiction})` : '');
        return `[${s.id}] ${label}\n  Text: "${s.text}"\n  Plain: ${s.plain_summary}`;
      }).join('\n\n')
    : '(no statutes loaded)';

  const patternBlock = patterns.length
    ? patterns.map(p => {
        return `[${p.id}] ${p.title} (severity=${p.severity})\n` +
          `  Detect: ${p.pattern_description}\n` +
          `  Why void: ${p.why_void}\n` +
          `  Cites: ${(p.citation_ids || []).join(', ')}`;
      }).join('\n\n')
    : '(no patterns loaded)';

  return [
    'You are RentSafe AI, an Indian rental contract auditor.',
    'You audit rental agreements against the EXACT statutes and patterns provided below.',
    '',
    'CRITICAL RULES:',
    '- Cite ONLY the statute IDs listed in APPLICABLE STATUTES below. Do not invent IDs or section numbers.',
    '- If you reference a void-clause pattern, use its exact ID from KNOWN VOID-CLAUSE PATTERNS.',
    '- If no statute in the list applies to a clause, leave citation_ids empty rather than fabricating one.',
    '- Quote the offending clause text briefly (≤200 chars) in clause_quote.',
    '- Be conservative. Better to flag fewer high-confidence issues than many low-confidence ones.',
    '',
    '==== APPLICABLE STATUTES ====',
    statuteBlock,
    '',
    '==== KNOWN VOID-CLAUSE PATTERNS ====',
    patternBlock,
    '',
    '==== OUTPUT ====',
    'Return ONLY a single JSON object. No markdown, no backticks, no commentary.',
    'Schema:',
    '{',
    '  "summary": "string (1-2 sentences)",',
    '  "overall_risk": "high"|"medium"|"low",',
    '  "overall_confidence": 0-100,',
    '  "findings": [',
    '    {',
    '      "title": "string",',
    '      "clause_quote": "string (≤200 chars)",',
    '      "risk": "high"|"medium"|"low",',
    '      "confidence": 0-100,',
    '      "explanation": "string",',
    '      "impact": "string",',
    '      "citation_ids": ["string"],',
    '      "matched_pattern": "string | null",',
    '      "perspective": "tenant"|"landlord"|"both"',
    '    }',
    '  ],',
    '  "actions": ["string"],',
    '  "missing_clauses": ["string"],',
    '  "positive_clauses": ["string"]',
    '}',
    '',
    'If the input is not a rental agreement, return exactly:',
    '{"error":"not_agreement","message":"This does not appear to be a rental agreement."}'
  ].join('\n');
}

function verifyAndEnrich(parsed) {
  if (!parsed || !Array.isArray(parsed.findings)) return parsed;

  parsed.findings = parsed.findings.map(f => {
    f = Object.assign({}, f);

    // 1. Verify every citation_id exists in the corpus.
    const ids = Array.isArray(f.citation_ids) ? f.citation_ids : [];
    const verified = ids.filter(id => !!corpus.findStatuteById(id));
    const dropped = ids.filter(id => !corpus.findStatuteById(id));
    f.citation_ids = verified;
    if (dropped.length) f.dropped_citations = dropped;

    // 2. Build structured citation objects for any future UI use.
    f.citations = verified.map(id => {
      const s = corpus.findStatuteById(id);
      return {
        id: s.id,
        label: `${s.act_name || s.act_id} §${s.section}` +
          (s.jurisdiction !== 'national' ? ` (${s.jurisdiction})` : ''),
        text: s.text,
        plain_summary: s.plain_summary
      };
    });

    // 3. Look up matched void-clause pattern (if any).
    if (f.matched_pattern) {
      const p = corpus.findPatternById(f.matched_pattern);
      if (p) {
        f.replacement_clause = p.replacement_clause;
        f.pattern_title = p.title;
        f.pattern_severity = p.severity;
        // If the model didn't cite the pattern's statutes, add them.
        const patternCites = (p.citation_ids || []).filter(id => corpus.findStatuteById(id));
        patternCites.forEach(id => {
          if (!f.citation_ids.includes(id)) {
            f.citation_ids.push(id);
            const s = corpus.findStatuteById(id);
            f.citations.push({
              id: s.id,
              label: `${s.act_name || s.act_id} §${s.section}` +
                (s.jurisdiction !== 'national' ? ` (${s.jurisdiction})` : ''),
              text: s.text,
              plain_summary: s.plain_summary
            });
          }
        });
      } else {
        f.matched_pattern = null;
      }
    }

    // 4. Backward-compat fields the existing frontend reads.
    f.clause_ref = f.clause_quote || f.clause_ref || '';
    f.citation = f.citations.length
      ? f.citations.map(c => c.label).join('; ')
      : (f.citation || '');

    return f;
  });

  return parsed;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const body = req.body || {};
  const { text, pdf, state } = body;

  if (!state) {
    return res.status(400).json({ error: { message: 'State is required.' } });
  }
  if (!corpus.normalizeState(state)) {
    return res.status(400).json({ error: { message: 'Unknown state: ' + state } });
  }
  if (!text && !pdf) {
    return res.status(400).json({ error: { message: 'Agreement text or PDF is required.' } });
  }

  let agreementText = text;

  if (pdf) {
    try {
      const pdfParse = require('pdf-parse');
      const buffer = Buffer.from(pdf, 'base64');
      const result = await pdfParse(buffer);
      agreementText = result.text;
      if (!agreementText || agreementText.trim().length < 50) {
        return res.status(400).json({
          error: { message: 'Could not extract text from PDF. Try pasting the text instead.' }
        });
      }
    } catch (e) {
      console.error('PDF error:', e);
      return res.status(400).json({
        error: { message: 'Failed to read PDF. Make sure it is not scanned or image-based.' }
      });
    }
  }

  // Truncate ridiculously large inputs to keep the prompt within model limits.
  // 60_000 chars ≈ ~15k tokens of agreement text — plenty for typical leases.
  if (agreementText.length > 60000) {
    agreementText = agreementText.slice(0, 60000) + '\n\n[truncated]';
  }

  const systemPrompt = buildSystemPrompt(state);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content:
              `Audit this rental agreement for state: ${state}.\n` +
              `Return JSON only, citing only IDs from the provided corpus.\n\n` +
              agreementText
          }
        ],
        temperature: 0.1,
        max_tokens: 3500,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Groq HTTP error:', response.status, errBody);
      return res.status(502).json({
        error: { message: 'Audit service is busy. Please try again in a moment.' }
      });
    }

    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;

    if (!content) {
      console.error('Empty Groq response:', JSON.stringify(data).slice(0, 400));
      return res.status(502).json({ error: { message: 'No response from audit service.' } });
    }

    const raw = content.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('JSON parse failed. Raw output:', raw.slice(0, 500));
      return res.status(502).json({
        error: { message: 'Audit service returned malformed output. Please retry.' }
      });
    }

    if (parsed && parsed.error === 'not_agreement') {
      return res.status(200).json(parsed);
    }

    parsed = verifyAndEnrich(parsed);

    parsed._meta = {
      corpus_version: '0.1.0',
      state: corpus.normalizeState(state),
      statutes_considered: corpus.getRelevantStatutes(state).length,
      patterns_considered: corpus.getRelevantPatterns(state).length
    };

    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: { message: 'Audit failed unexpectedly. Please retry.' } });
  }
};
