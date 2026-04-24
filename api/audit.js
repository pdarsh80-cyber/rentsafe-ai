const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const { text, pdf, state } = req.body;

  if (!state) {
    return res.status(400).json({ error: { message: 'State is required.' } });
  }
  if (!text && !pdf) {
    return res.status(400).json({ error: { message: 'Agreement text or PDF is required.' } });
  }

  let agreementText = text;

  if (pdf) {
    try {
      const pdfParse = require('pdf-parse');
      const buffer = Buffer.from(pdf, 'base64');
      const parsed = await pdfParse(buffer);
      agreementText = parsed.text;
      if (!agreementText || agreementText.trim().length < 50) {
        return res.status(400).json({ error: { message: 'Could not extract text from the PDF. Try copying and pasting the text instead.' } });
      }
    } catch (e) {
      console.error('PDF parse error:', e);
      return res.status(400).json({ error: { message: 'Failed to read the PDF. Make sure it is not scanned or image-based.' } });
    }
  }

  const systemPrompt =
    `You are RentSafe AI, India's expert rental agreement auditor. ` +
    `Knowledge: Model Tenancy Act 2021, Transfer of Property Act 1882 S105-117, ` +
    `Registration Act 1908 S17, Indian Stamp Act 1899, ` +
    `2026 New Rent Rules (digital registration mandatory; informal agreements void), ` +
    `Indian Contract Act 1872, state norms for ${state}.\n\n` +
    `Be DIRECT and RISK-FOCUSED. Return ONLY valid JSON, no markdown, no backticks:\n` +
    `{"summary":"2-3 direct risk-first sentences",` +
    `"overall_risk":"high|medium|low","overall_confidence":80,` +
    `"findings":[{"title":"max 8 words","risk":"high|medium|low","confidence":80,` +
    `"explanation":"2-3 plain sentences","impact":"1 sentence real consequence",` +
    `"clause_ref":"max 15 word paraphrase of problematic clause",` +
    `"citation":"Act Year Section","perspective":"tenant|landlord|both"}],` +
    `"actions":["practical step max 15 words"],` +
    `"missing_clauses":["clause"],"positive_clauses":["what is correct"]}\n` +
    `Generate 3-5 actions. ` +
    `If not a rental agreement return: {"error":"not_agreement","message":"friendly message"}`;

  const userPrompt = `Audit this rental agreement for ${state}. Return JSON only.\n\n${agreementText}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Groq error:', errBody);
      return res.status(502).json({ error: { message: 'AI service error. Please try again.' } });
    }

    const data = await response.json();
    const raw = data.choices[0].message.content
      .replace(/```json|```/g, '')
      .trim();

    JSON.parse(raw);

    return res.status(200).json({
      content: [{ type: 'text', text: raw }]
    });

  } catch (err) {
    console.error(err);
    if (err instanceof SyntaxError) {
      return res.status(502).json({ error: { message: 'AI returned an unexpected response. Please try again.' } });
    }
    return res.status(500).json({ error: { message: 'Failed to process agreement. Please try again.' } });
  }
};