// ─────────────────────────────────────────────────────────────────────────
// api/_lib/rateLimit.js
//
// Simple fixed-window rate limiter backed by Firestore — no extra service
// needed (Redis/Upstash) for a project this size. Not perfectly precise
// under heavy concurrent load, but good enough to stop casual abuse and
// runaway costs on public, unauthenticated endpoints.
//
// Usage:
//   const ip = getClientIp(req);
//   const ok = await checkRateLimit('ai-generate', ip, 5, 60 * 60 * 1000);
//   if (!ok) return res.status(429).json({ error: 'Too many requests' });
// ─────────────────────────────────────────────────────────────────────────

import { db } from './firebaseAdmin.js';

export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Returns true if the request is allowed, false if the limit was exceeded.
 * @param {string} bucket - logical name for this limit (e.g. "ai-generate")
 * @param {string} ip - client identifier
 * @param {number} maxRequests - max requests allowed per window
 * @param {number} windowMs - window size in milliseconds
 */
export async function checkRateLimit(bucket, ip, maxRequests, windowMs) {
  const ref = db.collection('rateLimits').doc(`${bucket}_${ip}`);

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();

      if (!snap.exists) {
        tx.set(ref, { count: 1, windowStart: now });
        return true;
      }

      const data = snap.data();
      const windowStart = data.windowStart || 0;
      const count = data.count || 0;

      if (now - windowStart > windowMs) {
        tx.set(ref, { count: 1, windowStart: now });
        return true;
      }

      if (count >= maxRequests) {
        return false;
      }

      tx.update(ref, { count: count + 1 });
      return true;
    });
  } catch (err) {
    // If the rate limiter itself fails (e.g. transient Firestore error),
    // fail OPEN rather than blocking legitimate traffic — but log it so
    // it doesn't go unnoticed.
    console.error(`[rateLimit] Failed to check limit for bucket "${bucket}":`, err);
    return true;
  }
}
