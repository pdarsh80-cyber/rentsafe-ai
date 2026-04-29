const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const FALLBACK = {
  summary: "We couldn't fully analyze this agreement. Please try again.",
  overall_risk: "medium",
  overall_confidence: 50,
  findings: [],
  actions: ["Try again or paste the agreement text directly"],
  missing_clauses: [],
  positive_clauses: []
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const { text, pdf, state } = req.body;

  if (!state) return res.status(400).json({ error: { message: 'State is required.' } });
  if (!text && !pdf) return res.status(400).json({ error: { message: 'Agreement text or PDF is required.' } });

  let agreementText = text;

  if (pdf) {
    try {
      const pdfParse = require('pdf-parse');
      const buffer = Buffer.from(pdf, 'base64');
      const result = await pdfParse(buffer);
      agreementText = result.text;
      if (!agreementText || agreementText.trim().length < 50) {
        return res.status(400).json({ error: { message: 'Could not extract text from PDF. Try pasting the text instead.' } });
      }
    } catch (e) {
      console.error('PDF error:', e);
      return res.status(400).json({ error: { message: 'Failed to read PDF. Make sure it is not scanned or image-based.' } });
    }
  }

  const systemPrompt =
    `You are RentSafe AI, India's expert rental agreement auditor. ` +
    `Return ONLY valid JSON. No explanation. No text outside JSON. No markdown. No backticks. ` +
    `Knowledge: Model Tenancy Act 2021, Transfer of Property Act 1882 S105-117, ` +
    `Registration Act 1908 S17, Indian Stamp Act 1899, ` +
    `2026 New Rent Rules, Indian Contract Act 1872, state norms for ${state}.\n\n` +
    `Return ONLY this JSON structure with no extra text:\n` +
    `{"summary":"string","overall_risk":"high|medium|low","overall_confidence":80,` +
    `"findings":[{"title":"string","risk":"high|medium|low","confidence":80,` +
    `"explanation":"string","impact":"string","clause_ref":"string",` +
    `"citation":"string","perspective":"tenant|landlord|both"}],` +
    `"actions":["string"],"missing_clauses":["string"],"positive_clauses":["string"]}\n` +
    `If not a rental agreement return: {"error":"not_agreement","message":"string"}`;

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
          { role: 'user', content: `Audit this rental agreement for ${state}. Return JSON only.\n\n${agreementText}` }
        ],
        temperature: 0.1,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      console.error('Groq HTTP error:', response.status, await response.text());
      return res.status(200).json(FALLBACK);
    }

    const data = await response.json();

    if (!data?.choices?.[0]?.message?.content) {
      console.error('Bad Groq response:', JSON.stringify(data));
      return res.status(200).json(FALLBACK);
    }

    const raw = data.choices[0].message.content
      .replace(/```json|```/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('JSON parse failed. Raw output:', raw);
      return res.status(200).json(FALLBACK);
    }

    // Return direct JSON — no wrapping
    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(200).json(FALLBACK);
  }
};