// ─────────────────────────────────────────────────────────────────────────
// api/_lib/cors.js
//
// Centralized CORS handling for every API route.
//
// Set on Vercel (Project Settings → Environment Variables):
//   ALLOWED_ORIGIN = https://your-real-domain.com
//
// If ALLOWED_ORIGIN isn't set yet, this falls back to '*' so nothing
// breaks during development — but set it before going live in production,
// especially on routes that accept an Authorization header.
// ─────────────────────────────────────────────────────────────────────────

export function setCors(req, res, methods = 'GET, OPTIONS') {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  // Basic security headers, cheap to set on every response:
  // - X-Content-Type-Options: stops browsers from guessing content types
  //   in a way that could turn a JSON error response into executable HTML.
  // - X-Frame-Options / frame-ancestors: prevents this API's responses
  //   (and any HTML pages served alongside it) from being embedded in a
  //   hidden iframe on another site for clickjacking.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}
