// api/_lib/cors.js
// Centralised CORS handling so the audit/retrieve endpoints reject requests
// from origins that are not RentSafe's own deployment. This stops other
// websites from embedding our API in their own products without permission.

// EDIT THIS LIST WITH YOUR ACTUAL DEPLOYMENT URLS.
// Wildcards are NOT supported — list every domain explicitly.
const ALLOWED_ORIGINS = new Set([
  "https://rentsafe.ai",
  "https://www.rentsafe.ai",
  "https://rentssafe-ai.vercel.app",
  "https://rentsafe-ai.vercel.app",
  // Local dev — remove in production if you want to be strict.
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000"
]);

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    return { sameOrigin: true };
  }
  // Same-origin requests (no Origin header at all) are always fine — they
  // come from your own page directly. Block cross-origin from other sites.
  if (!origin) return { sameOrigin: true };
  return { sameOrigin: false };
}

function preflight(req, res) {
  if (req.method === "OPTIONS") {
    applyCors(req, res);
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = { ALLOWED_ORIGINS, applyCors, preflight };
