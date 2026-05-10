// api/generate.js
// State-aware rental agreement generator.
//
// Pipeline:
//   1. Validate the user's structured inputs.
//   2. Inject all relevant statutes for that state into the system prompt.
//   3. Inject the void-clause patterns as 'things to AVOID'.
//   4. LLM generates a complete agreement.
//   5. Post-check: scan output for known void-clause keyword patterns.
//      Flag any matches as warnings (the model occasionally slips).
//   6. Return { agreement, warnings, _meta }.

const fetch = function() { var args = arguments; return import('node-fetch').then(function(m){ return m.default.apply(null, args); }); };
const corpus = require('./_lib/corpus');
const rl = require('./_lib/ratelimit');
const corsLib = require('./_lib/cors');

function s(v) { return (v == null ? '' : String(v)).trim(); }
function n(v) { var x = parseFloat(v); return Number.isFinite(x) ? x : null; }

function buildSystemPrompt(state, propertyType) {
  const statutes = corpus.getRelevantStatutes(state);
  const patterns = corpus.getRelevantPatterns(state);

  const statuteBlock = statutes.map(function(st){
    const label = (st.act_name || st.act_id) + ' \u00a7' + st.section;
    return '[' + st.id + '] ' + label + ': ' + st.plain_summary;
  }).join('\n');

  const avoidBlock = patterns.map(function(p){
    return '[' + p.id + '] AVOID: ' + p.title;
  }).join('\n');

  return [
    'You are RentSafe AI Drafter. Your job is to draft a formal, compliant Indian rental agreement.',
    'You are drafting a ' + propertyType + ' tenancy for the state of ' + state + '.',
    '',
    'CRITICAL RULES:',
    '- The agreement MUST comply with every applicable statute below.',
    '- The agreement MUST NOT contain any clause matching the void-clause patterns below.',
    '- Use formal Indian rental agreement language (THIS AGREEMENT made on..., WHEREAS..., NOW THEREFORE...).',
    '- Use numbered clauses. Quote rupee amounts in figures and words.',
    '- Default deposit cap: 2 months rent (residential) or 6 months rent (commercial). If the user input exceeds this, silently cap at the legal maximum and add a note.',
    '- Default termination notice: 1 month written notice from either party.',
    '- Default rent revision: 90 days written notice, once per 12 months.',
    '- Include a clause requiring digital registration with the Rent Authority within 60 days.',
    '- Include a Schedule II compliant repair-allocation clause (structural = landlord, day-to-day = tenant).',
    '- End with a signature block for Landlord, Tenant, Witness 1, Witness 2.',
    '',
    '==== APPLICABLE STATUTES (you MUST comply with these) ====',
    statuteBlock || '(corpus empty)',
    '',
    '==== VOID-CLAUSE PATTERNS (you MUST NOT include any of these) ====',
    avoidBlock || '(catalog empty)',
    '',
    '==== OUTPUT FORMAT ====',
    'Return ONLY a single JSON object with this schema:',
    '{',
    '  "agreement": "the full agreement text, with line breaks",',
    '  "capped_fields": {"deposit": "original->compliant", ...},  // optional, only if you capped a user input',
    '  "notes": ["plain-English notes about deviations from user input"]',
    '}',
    '',
    'Do NOT use markdown. Do NOT wrap in backticks. Return raw JSON.'
  ].join('\n');
}

// After generation, scan the agreement text for patterns we know are void.
// This is a safety net in case the model slipped.
function scanForVoidPatterns(agreementText, state) {
  const text = String(agreementText || '').toLowerCase();
  const patterns = corpus.getRelevantPatterns(state);
  const hits = [];
  patterns.forEach(function(p){
    const kws = p.pattern_keywords || [];
    const matched = kws.filter(function(k){ return text.indexOf(String(k).toLowerCase()) >= 0; });
    if (matched.length >= 2) {
      hits.push({ id: p.id, title: p.title, severity: p.severity, matched: matched });
    }
  });
  return hits;
}

module.exports = async function handler(req, res) {
  if (corsLib.preflight(req, res)) return;
  const cors = corsLib.applyCors(req, res);
  if (!cors.sameOrigin) return res.status(403).json({ error: { message: 'Cross-origin requests are not allowed.' } });
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  // Use audit limits — generation is similarly expensive.
  const limitRes = rl.checkAuditLimits(req);
  if (!limitRes.allowed) {
    res.setHeader('Retry-After', String(limitRes.retryAfterSec));
    return res.status(429).json({ error: { message: 'Generation limit reached. Try again later.' } });
  }

  const b = req.body || {};
  const state = s(b.state);
  if (!state) return res.status(400).json({ error: { message: 'State is required.' } });
  if (!corpus.normalizeState(state)) return res.status(400).json({ error: { message: 'Unknown state: ' + state } });

  const propertyType = b.propertyType === 'commercial' ? 'commercial' : 'residential';
  const inputs = {
    propertyType: propertyType,
    state: state,
    landlord: { name: s(b.landlordName), address: s(b.landlordAddress) },
    tenant: { name: s(b.tenantName), address: s(b.tenantAddress) },
    property: { address: s(b.propertyAddress), description: s(b.propertyDescription) },
    rent: n(b.rent),
    deposit: n(b.deposit),
    termMonths: n(b.termMonths),
    startDate: s(b.startDate),
    noticeMonths: n(b.noticeMonths) || 1,
    escalationPercent: n(b.escalationPercent),
    utilities: s(b.utilities),
    petsAllowed: !!b.petsAllowed,
    sublettingAllowed: !!b.sublettingAllowed,
    specialClauses: s(b.specialClauses)
  };

  if (!inputs.landlord.name || !inputs.tenant.name || !inputs.property.address || !inputs.rent || !inputs.termMonths) {
    return res.status(400).json({ error: { message: 'Missing required field. Need at least: landlord name, tenant name, property address, rent, term.' } });
  }

  const systemPrompt = buildSystemPrompt(state, propertyType);
  const userMessage = 'Draft the agreement using these inputs (compliance is your responsibility):\n\n' + JSON.stringify(inputs, null, 2);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.2,
        max_tokens: 4000,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      console.error('Groq HTTP error:', response.status, await response.text());
      rl.refundAudit(req);
      var friendly = 'Generation service unavailable. Please retry — your free quota was not used.';
      if (response.status === 429) friendly = 'AI provider hit its free-tier rate limit. Please wait ~60 seconds and retry. Your quota was not used.';
      return res.status(502).json({ error: { message: friendly, _provider_status: response.status } });
    }
    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
    if (!content) { rl.refundAudit(req); return res.status(502).json({ error: { message: 'No response from generation service. Your free quota was not used.' } }); }

    let parsed;
    try { parsed = JSON.parse(content.replace(/```json|```/g, '').trim()); }
    catch (e) { rl.refundAudit(req); return res.status(502).json({ error: { message: 'Generation returned malformed output. Your free quota was not used.' } }); }

    if (!parsed || !parsed.agreement || typeof parsed.agreement !== 'string') {
      rl.refundAudit(req);
      return res.status(502).json({ error: { message: 'Generation returned no agreement text. Your free quota was not used.' } });
    }

    // Safety net: scan the generated text for void-clause patterns.
    const warnings = scanForVoidPatterns(parsed.agreement, state);

    return res.status(200).json({
      agreement: parsed.agreement,
      capped_fields: parsed.capped_fields || null,
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      warnings: warnings,
      _meta: {
        corpus_version: '0.2.0',
        state: corpus.normalizeState(state),
        propertyType: propertyType,
        statutes_considered: corpus.getRelevantStatutes(state).length,
        patterns_avoided: corpus.getRelevantPatterns(state).length
      }
    });
  } catch (err) {
    console.error('Generate handler error:', err);
    rl.refundAudit(req);
    return res.status(500).json({ error: { message: 'Generation failed unexpectedly. Your free quota was not used.' } });
  }
};
