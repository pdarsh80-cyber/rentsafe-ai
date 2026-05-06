# Security & Anti-Copy Posture

This document describes what is currently protected, what is intentionally not, and what to do if you find an issue. Honest about scope so nobody is surprised.

## What is protected

**Legal corpus is not publicly downloadable.** The statute and void-clause JSON files live inside `api/_lib/data/` rather than at the project root. Vercel does not serve files inside `api/` as static assets, so a curious visitor cannot grab the corpus by hitting `/data/statutes.seed.json`. The corpus is loaded by serverless functions at runtime via `require('./data/...')`.

**Rate limiting is enforced per IP.** `/api/audit` is capped at 5 requests per hour and 20 per day. `/api/retrieve` is capped at 30 per minute and 200 per hour. Limits are sliding-window and return HTTP 429 with a `Retry-After` header. The implementation is in-memory; for high-traffic production, replace with Upstash Redis (see comment in `api/_lib/ratelimit.js`).

**CORS is locked down to whitelisted origins.** `api/_lib/cors.js` defines the allowed origins. Cross-origin requests from any other domain return HTTP 403. Preflight (`OPTIONS`) requests are handled. **Edit `cors.js` to add your real production domain before launch.**

**Prompt injection is mitigated.** User-supplied agreement text is run through `api/_lib/sanitize.js`, which (a) redacts common injection markers ("ignore previous instructions", "you are now…", system tokens), (b) strips zero-width characters, and (c) caps total length. The user content is then wrapped in `<<<BEGIN AGREEMENT…END AGREEMENT>>>` delimiters and the system prompt explicitly instructs the model to treat content inside as data, not instructions.

**LLM citations are verified before response.** The audit handler calls `corpus.findStatuteById()` for every citation the model returns. Hallucinated section IDs are dropped and recorded in `dropped_citations`. This means a successful prompt injection cannot inject fake legal references into the user's audit.

**No secrets in the frontend.** The Groq API key lives only in `process.env.GROQ_API_KEY` on Vercel. The frontend never sees it.

**XSS is blocked in result rendering.** `index.html` uses an `esc()` helper to escape `&`, `<`, `>`, and `"` in every LLM-derived string before inserting into the DOM.

**License + copyright notice.** A `LICENSE` file at the project root and a header comment in each source file establish ownership.

## What is intentionally NOT protected

**The frontend code is fully visible.** Anyone with `view-source` can read the entire `index.html` (HTML, CSS, JavaScript). Minification helps but does not prevent copying. This is true of every public web app — the realistic mitigation is brand, distribution, and traction, not code obfuscation.

**The audit endpoint is publicly callable from your own domain.** A motivated attacker who proxies their requests through your domain (or scrapes the frontend HTML to discover the API contract) can still make audits. Rate limiting bounds the damage; it does not eliminate the risk.

**The `localStorage` paywall counter is bypassable.** Anyone can edit `localStorage` in DevTools to reset their free-audit count. This is a known limitation of client-side gating. **When you add real payment, validate entitlement on the server, not the client.**

**Vercel serverless functions run multiple instances.** The in-memory rate limiter is per-instance, so under heavy load a determined attacker can hit the limit × N instances. For real abuse protection, swap to Upstash Redis.

**Determined cloning by a competitor.** If a well-funded competitor (NoBroker, MagicBricks) decided to reproduce the product, they could in 1–2 weeks. The defense is not code; it is users, brand, and the proprietary depth of the legal corpus.

## What you must do before launch

1. **Edit `api/_lib/cors.js`** — replace `rentssafe-ai.vercel.app` with your actual deployment URL, and remove `localhost:*` entries if you want strict production behavior.
2. **Confirm `GROQ_API_KEY` is set** in Vercel project environment variables (Settings → Environment Variables). It must NOT be committed to the repo.
3. **Delete the empty `data/` folder** at the project root if it remains after the corpus migration. The new location is `api/_lib/data/`.
4. **Update the contact email** in `LICENSE` and the brand text where placeholders remain.
5. **(Optional, recommended for >1k users)** Sign up for Upstash Redis (free tier, 10k req/day) and replace the in-memory rate limiter. Instructions in `api/_lib/ratelimit.js`.

## Reporting a vulnerability

Email pdarsh907@gmail.com with the subject "RentSafe Security". Include reproduction steps and the impact you observed. Public disclosure is appreciated only after a fix has shipped.

## Security checklist (last reviewed)

- [x] Corpus not publicly served
- [x] Rate limiting on `/api/audit` and `/api/retrieve`
- [x] CORS whitelist enforced
- [x] Prompt-injection sanitization
- [x] LLM citation verification
- [x] No secrets in frontend
- [x] XSS escaping in result rendering
- [x] License + copyright notice
- [ ] Upstash Redis for distributed rate limiting (recommended for production)
- [ ] Server-side payment entitlement (required before charging real money)
- [ ] Content Security Policy header (nice-to-have)
- [ ] Logging + alerting for abuse (nice-to-have)
