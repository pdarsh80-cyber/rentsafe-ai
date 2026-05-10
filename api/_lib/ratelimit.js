// api/_lib/ratelimit.js
// Lightweight in-memory rate limiter for Vercel serverless functions.
//
// CAVEAT: Vercel runs multiple function instances (especially under load), so
// each instance has its own counter. The hard limit a determined attacker
// faces is therefore (limit × instances). For most casual abuse this is fine
// — burning 100 audits before getting blocked is still way better than 10,000.
//
// FOR REAL PRODUCTION: replace the in-memory `buckets` Map below with Upstash
// Redis (free tier, 10k requests/day). Drop-in: install @upstash/ratelimit and
// @upstash/redis, then swap the check function.

const buckets = new Map(); // key -> { hits: [timestamps], lastCleanup: number }

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    return String(xff).split(",")[0].trim();
  }
  return req.headers["x-real-ip"] ||
         req.connection?.remoteAddress ||
         "unknown";
}

// Sliding-window check. Returns { allowed: boolean, retryAfterSec: number,
// remaining: number }.
function check(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [], lastCleanup: now };
    buckets.set(key, bucket);
  }

  // Drop hits outside the window.
  bucket.hits = bucket.hits.filter(t => now - t < windowMs);

  // Periodic cleanup of stale buckets to prevent unbounded memory growth.
  if (now - bucket.lastCleanup > 60_000) {
    if (bucket.hits.length === 0) {
      buckets.delete(key);
    }
    bucket.lastCleanup = now;
    // Also sweep the whole map occasionally.
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) {
        if (b.hits.length === 0 || now - (b.hits[b.hits.length - 1] || 0) > windowMs) {
          buckets.delete(k);
        }
      }
    }
  }

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0];
    const retryAfterMs = windowMs - (now - oldest);
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      remaining: 0
    };
  }

  bucket.hits.push(now);
  return {
    allowed: true,
    retryAfterSec: 0,
    remaining: limit - bucket.hits.length
  };
}

// Pop the most recent hit from a bucket. Used to refund a slot when the
// downstream work failed (bad PDF, LLM error, JSON parse error) so the user
// is not punished for failed attempts.
function refund(key) {
  const bucket = buckets.get(key);
  if (bucket && bucket.hits.length > 0) {
    bucket.hits.pop();
  }
}

// Check both the burst (per-hour) AND the daily limit. Returns the harsher
// result if either is exceeded. Limits raised so honest testing isn't blocked.
function checkAuditLimits(req) {
  const ip = getClientIp(req);
  const hourly = check("hour:" + ip, 10, 60 * 60 * 1000);   // 10 / hour
  if (!hourly.allowed) return { ...hourly, scope: "hour" };
  const daily = check("day:" + ip, 50, 24 * 60 * 60 * 1000); // 50 / day
  if (!daily.allowed) return { ...daily, scope: "day" };
  return { allowed: true, remaining: Math.min(hourly.remaining, daily.remaining), scope: "ok" };
}

// Refund the audit slots consumed by checkAuditLimits. Call this when the
// audit failed (not_agreement / LLM error / parse error) so the user keeps
// their quota for a real attempt.
function refundAudit(req) {
  const ip = getClientIp(req);
  refund("hour:" + ip);
  refund("day:" + ip);
}

function checkRetrieveLimits(req) {
  const ip = getClientIp(req);
  // Retrieve is cheap, allow more. 30/min, 200/hour.
  const minute = check("rtr-min:" + ip, 30, 60 * 1000);
  if (!minute.allowed) return { ...minute, scope: "minute" };
  const hour = check("rtr-hr:" + ip, 200, 60 * 60 * 1000);
  if (!hour.allowed) return { ...hour, scope: "hour" };
  return { allowed: true, remaining: Math.min(minute.remaining, hour.remaining), scope: "ok" };
}

module.exports = {
  getClientIp,
  refund,
  refundAudit,
  check,
  checkAuditLimits,
  checkRetrieveLimits
};
