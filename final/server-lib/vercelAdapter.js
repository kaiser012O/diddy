// ─────────────────────────────────────────────────────────────────────────
// server-lib/vercelAdapter.js
//
// Makes a Vercel-style serverless handler — export default async function
// handler(req, res) { ... } — work unmodified under plain Express.
//
// Why this is needed at all: Express's `req`/`res` objects already behave
// almost exactly like Vercel's (same Node http.IncomingMessage/ServerResponse
// underneath), EXCEPT for two small but important differences every one of
// our api/*.js files relies on:
//
//   1. res.status(code).json(obj)  — Vercel gives you this chainable helper
//      built in. Express only has res.json() and res.status() separately;
//      they DO chain the same way in modern Express, so this mostly already
//      works — but we still normalize it here so this adapter is the one
//      place that guarantees it, regardless of Express version quirks.
//
//   2. Uncaught errors — on Vercel, if a handler throws, Vercel itself
//      catches it and returns a generic 500. Plain Express does NOT do this
//      for async route handlers by default (a rejected promise in an async
//      handler crashes the process if unhandled). This wrapper catches
//      exactly that case so one buggy request can never take down the
//      whole local server.
//
// Everything else (req.query, req.body, req.headers, req.method) already
// matches Vercel's shape 1:1 when using express.json() — no translation
// needed there.
// ─────────────────────────────────────────────────────────────────────────

export function toExpressHandler(vercelHandler) {
  return async function expressRouteHandler(req, res) {
    try {
      await vercelHandler(req, res);
    } catch (err) {
      console.error(`[server] Unhandled error in ${req.method} ${req.originalUrl}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };
}
