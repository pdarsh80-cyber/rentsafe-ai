// api/_lib/corpus.js
// Loads the legal knowledge base (statutes + void-clause patterns) and exposes
// search / lookup helpers used by the audit and retrieve endpoints.
//
// The underscore-prefixed folder is ignored by Vercel's routing (so this file
// is bundled with functions that require it but is not exposed as an endpoint).

// Corpus files live INSIDE api/_lib/data/ (not /data/ at the project root).
// This is intentional: files inside api/ are not served as static assets by
// Vercel, so the corpus cannot be downloaded directly from a public URL.
const statutesData = require('./data/statutes.seed.json');
const voidClausesData = require('./data/void-clauses.json');

const STATUTES = Array.isArray(statutesData.statutes) ? statutesData.statutes : [];
const VOID_PATTERNS = Array.isArray(voidClausesData.patterns) ? voidClausesData.patterns : [];

const STATE_MAP = {
  'tamil nadu': 'TN', 'tn': 'TN',
  'andhra pradesh': 'AP', 'ap': 'AP',
  'uttar pradesh': 'UP', 'up': 'UP',
  'assam': 'AS', 'as': 'AS',
  'karnataka': 'KA', 'ka': 'KA',
  'maharashtra': 'MH', 'mh': 'MH',
  'gujarat': 'GJ', 'gj': 'GJ',
  'delhi': 'DL', 'dl': 'DL',
  'rajasthan': 'RJ', 'rj': 'RJ',
  'west bengal': 'WB', 'wb': 'WB',
  'madhya pradesh': 'MP', 'mp': 'MP',
  'kerala': 'KL', 'kl': 'KL',
  'telangana': 'TG', 'tg': 'TG',
  'haryana': 'HR', 'hr': 'HR',
  'punjab': 'PB', 'pb': 'PB',
  'odisha': 'OD', 'od': 'OD',
  'bihar': 'BR', 'br': 'BR',
  'jharkhand': 'JH', 'jh': 'JH',
  'chhattisgarh': 'CG', 'cg': 'CG',
  'uttarakhand': 'UK', 'uk': 'UK',
  'himachal pradesh': 'HP', 'hp': 'HP',
  'goa': 'GA', 'ga': 'GA'
};

function normalizeState(state) {
  if (!state) return null;
  const s = String(state).trim().toLowerCase();
  if (STATE_MAP[s]) return STATE_MAP[s];
  if (s.length === 2) return s.toUpperCase();
  return null;
}

function getRelevantStatutes(state) {
  const code = normalizeState(state);
  return STATUTES.filter(s =>
    s.jurisdiction === 'national' || (code && s.jurisdiction === code)
  );
}

function getRelevantPatterns(state) {
  const code = normalizeState(state);
  return VOID_PATTERNS.filter(p => {
    const j = p.jurisdictions || [];
    return j.includes('national') || (code && j.includes(code));
  });
}

function findStatuteById(id) {
  if (!id) return null;
  return STATUTES.find(s => s.id === id) || null;
}

function findPatternById(id) {
  if (!id) return null;
  return VOID_PATTERNS.find(p => p.id === id) || null;
}

function searchStatutes(query, state, limit) {
  if (!Number.isFinite(limit)) limit = 5;
  const q = String(query || '').toLowerCase();
  const candidates = getRelevantStatutes(state);
  const queryWords = new Set(
    q.split(/[^a-z0-9]+/).filter(w => w.length > 3)
  );
  const scored = candidates.map(s => {
    const text = (
      (s.text || '') + ' ' +
      (s.plain_summary || '') + ' ' +
      (s.topics || []).join(' ')
    ).toLowerCase();
    let score = 0;
    (s.topics || []).forEach(t => {
      const norm = t.replace(/_/g, ' ');
      if (q.includes(norm)) score += 4;
    });
    queryWords.forEach(w => { if (text.includes(w)) score += 1; });
    return { statute: s, score: score };
  });
  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.statute);
}

function searchPatterns(query, state) {
  const q = String(query || '').toLowerCase();
  const candidates = getRelevantPatterns(state);
  return candidates.filter(p => {
    const keywords = p.pattern_keywords || [];
    return keywords.some(k => q.includes(String(k).toLowerCase()));
  });
}

module.exports = {
  STATUTES: STATUTES,
  VOID_PATTERNS: VOID_PATTERNS,
  normalizeState: normalizeState,
  getRelevantStatutes: getRelevantStatutes,
  getRelevantPatterns: getRelevantPatterns,
  findStatuteById: findStatuteById,
  findPatternById: findPatternById,
  searchStatutes: searchStatutes,
  searchPatterns: searchPatterns
};
