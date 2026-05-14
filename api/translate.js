// api/translate.js
// Batched translate endpoint for multilingual mode (Feature 1).
// Body: { strings: string[], language: string }
// Returns: { translations: string[], _meta }

const fetch = function() {
  const args = arguments;
  return import('node-fetch').then(function(m){ return m.default.apply(null, args); });
};
const rl = require('./_lib/ratelimit');
const corsLib = require('./_lib/cors');

const SUPPORTED = {
  en: 'English',
  hi: 'Hindi',
  gu: 'Gujarati',
  mr: 'Marathi',
  kn: 'Kannada',
  ml: 'Malayalam',
  ta: 'Tamil',
  te: 'Telugu',
  pa: 'Punjabi',
  bn: 'Bengali'
};

module.exports = async function handler(req, res) {
  if (corsLib.preflight(req, res)) return;
  const cors = corsLib.applyCors(req, res);
  if (!cors.sameOrigin) return res.status(403).json({ error: { message: 'Cross-origin requests are not allowed.' } });
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  const limitRes = rl.checkRetrieveLimits(req);
  if (!limitRes.allowed) {
    res.setHeader('Retry-After', String(limitRes.retryAfterSec));
    return res.status(429).json({ error: { message: 'Translation limit reached. Slow down.' } });
  }

  const body = req.body || {};
  const strings = Array.isArray(body.strings) ? body.strings : null;
  const langCode = String(body.language || '').toLowerCase();
  const targetLang = SUPPORTED[langCode];

  if (!strings || strings.length === 0) {
    return res.status(400).json({ error: { message: 'strings array is required' } });
  }
  if (strings.length > 60) {
    return res.status(400).json({ error: { message: 'too many strings — max 60 per request' } });
  }
  if (!targetLang) {
    return res.status(400).json({ error: { message: 'unsupported language: ' + langCode } });
  }
  // Identity passthrough for English.
  if (langCode === 'en') {
    return res.status(200).json({ translations: strings, _meta: { language: 'en', passthrough: true } });
  }

  // Cap total chars to keep the LLM call cheap.
  const totalChars = strings.reduce(function(s, t){ return s + String(t || '').length; }, 0);
  if (totalChars > 12000) {
    return res.status(400).json({ error: { message: 'total text too long — split into smaller batches' } });
  }

  const systemPrompt = [
    'You are a professional Indian-language translator.',
    'Translate every English string in the given JSON array to ' + targetLang + '.',
    '',
    'CRITICAL RULES:',
    '- Return ONLY a JSON object: {"translations": ["...", "..."]}. Same length and order as the input array.',
    '- DO NOT translate: section numbers ("Section 11(1)"), act names ("Model Tenancy Act", "Indian Contract Act"), statute IDs ("mta-2021-s11-1"), rupee amounts ("Rs. 50,000"), brand names ("RentSafe AI"), case names, or any English legal citation. Keep them in English exactly as given.',
    '- Use natural, conversational ' + targetLang + ', not formal Sanskritised/Latinised vocabulary. Aim for what a regular middle-class Indian renter would speak at home.',
    '- Preserve original punctuation, line breaks, and any HTML entities.',
    '- If a string is already in ' + targetLang + ' or contains only proper nouns/numbers, return it unchanged.',
    '- Do not add commentary, footnotes, or anything outside the JSON.'
  ].join('\n');

  const userMessage = 'Translate this array to ' + targetLang + ':\n' + JSON.stringify(strings);

  try {
    async function callGroq(attempt) {
      attempt = attempt || 1;
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          temperature: 0.2,
          max_tokens: 3500,
          response_format: { type: 'json_object' }
        })
      });
      if (r.status === 429 && attempt < 2) {
        await new Promise(function(res){ setTimeout(res, 4500); });
        return callGroq(attempt + 1);
      }
      return r;
    }
    const response = await callGroq();
    if (!response.ok) {
      const errBody = await response.text();
      console.error('Groq translate HTTP error:', response.status, errBody);
      const friendly = response.status === 429
        ? 'Translation service hit its rate limit. Please wait a minute and retry.'
        : 'Translation service unavailable. Please retry.';
      return res.status(502).json({ error: { message: friendly, _provider_status: response.status } });
    }
    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
    if (!content) return res.status(502).json({ error: { message: 'No response from translation service.' } });
    let parsed;
    try { parsed = JSON.parse(content.replace(/```json|```/g, '').trim()); }
    catch (e) { return res.status(502).json({ error: { message: 'Translation returned malformed output.' } }); }
    let translations = Array.isArray(parsed.translations) ? parsed.translations : null;
    if (!translations) return res.status(502).json({ error: { message: 'Translation response missing translations array.' } });
    // If length mismatched, pad with originals to keep the client UI sane.
    while (translations.length < strings.length) translations.push(strings[translations.length]);
    translations = translations.slice(0, strings.length);
    return res.status(200).json({ translations: translations, _meta: { language: langCode, count: translations.length } });
  } catch (err) {
    console.error('Translate handler error:', err);
    return res.status(500).json({ error: { message: 'Translation failed unexpectedly.' } });
  }
};
