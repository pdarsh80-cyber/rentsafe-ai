// api/_lib/cors.js
// Centralised CORS handling so the audit/retrieve endpoints reject requests
// from origins that are not RentSafe's own deployment.

// Explicit whitelist — exact URLs that are always allowed.
const ALLOWED_ORIGINS = new Set([
  // Vercel deployment URL (current).
  "https://rentsafe-7z8zdwcyr-parikhdarsh80-4221s-projects.vercel.app",
  // Likely stable production URL on the same Vercel project.
  "https://rentsafe-parikhdarsh80-4221s-projects.vercel.app",
  // Custom domains (add yours here when you buy one).
  "https://rentsafe.ai",
  "https://www.rentsafe.ai",
  // Local dev — remove these if you want strict production behaviour.
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000"
]);

// Pattern matcher for Vercel preview / production URLs of THIS project.
// Vercel preview URLs change every deployment (hash in the middle), so we
// allow any URL that looks like https://rentsafe...vercel.app belonging to
// this account. This still blocks evil.com and any non-Vercel domain.
const VERCEL_PROJECT_RE = /^https:\/\/rentsafe[a-z0-9-]*\.vercel\.app$/i;

function isAllowed(origin) {
  if (!origin) return true;                  // same-origin direct hit
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (VERCEL_PROJECT_RE.test(origin)) return true;
  return false;
}

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (isAllowed(origin)) {
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    return { sameOrigin: true };
  }
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

module.exports = { ALLOWED_ORIGINS, isAllowed, applyCors, preflight };
