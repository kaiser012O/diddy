// ─────────────────────────────────────────────────────────────────────────
// server.js
//
// Local/VPS server — runs this project WITHOUT Vercel, using plain Node +
// Express. Every file in api/*.js is used EXACTLY as-is (each still
// exports `export default async function handler(req, res)`, the same
// shape Vercel calls it with) — nothing in api/ was modified for this.
//
// Why this matters: if you ever decide to deploy on Vercel instead, you
// don't "redo" anything. Just delete this file (and server-lib/, and
// package.json's "express"/"node-cron" deps if you want), drop vercel.json
// back in, and push — the api/ folder already works there unchanged.
//
// Usage:
//   npm install
//   cp .env.example .env      # fill in your real Firebase/Twilio/Gemini keys
//   npm start                 # serves the whole site at http://localhost:3000
// ─────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { toExpressHandler } from './server-lib/vercelAdapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

// Vercel parses JSON bodies automatically for every function; Express
// needs this explicitly. Kept generous (2mb) since avatar/photo uploads
// go through Cloudinary directly from the browser — the API only ever
// receives the resulting URL strings, not raw image bytes.
app.use(express.json({ limit: '2mb' }));

// ── API routes ──────────────────────────────────────────────────────────
// One line per api/*.js file, mapping it to the exact same path the
// frontend already calls (see js/*.js — they all hit /api/<name>).
// Each import is dynamic + wrapped by toExpressHandler so any file that
// throws during import (e.g. a missing env var) surfaces a clear error
// instead of silently crashing the whole server at boot.
const apiRoutes = [
  ['clinics', './api/clinics.js'],
  ['bookings', './api/bookings.js'],
  ['availability', './api/availability.js'],
  ['ratings', './api/ratings.js'],
  ['master-template-set', './api/master-template-set.js'],
  ['ai-generate', './api/ai-generate.js'],
  ['cron-send-rating-requests', './api/cron-send-rating-requests.js'],
];

for (const [routeName, filePath] of apiRoutes) {
  const { default: handler } = await import(filePath);
  // Vercel serves each function at ALL methods on the same path (the
  // function itself checks req.method) — app.all() mirrors that exactly.
  app.all(`/api/${routeName}`, toExpressHandler(handler));
}

// ── Optional: run the rating-request cron job automatically, in-process ──
// Vercel Cron (see the old vercel.json) hit this same endpoint once a day.
// Locally there's no external cron service, so node-cron does the same
// job on the same schedule, calling the exact same handler function.
// Uses the same CRON_SECRET check inside the handler for consistency —
// so this only runs if CRON_SECRET is set in your .env, same as before.
if (process.env.CRON_SECRET) {
  cron.schedule('0 18 * * *', async () => {
    console.log('[cron] Running daily rating-request job...');
    const { default: cronHandler } = await import('./api/cron-send-rating-requests.js');
    const fakeReq = { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, method: 'GET' };
    const fakeRes = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { console.log(`[cron] Result (${this.statusCode}):`, body); return this; },
      end() { return this; },
    };
    try {
      await cronHandler(fakeReq, fakeRes);
    } catch (err) {
      console.error('[cron] Job failed:', err);
    }
  });
  console.log('[server] Daily rating-request cron scheduled for 18:00 server time.');
} else {
  console.log('[server] CRON_SECRET not set — automatic rating-request cron is disabled (you can still trigger it manually, see README).');
}

// ── Static frontend ─────────────────────────────────────────────────────
// Serves index.html, dashboard.html, clinic.html, signin.html, css/, js/
// exactly as Vercel would for any non-/api path.
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`\n✅ Server running at http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`   Homepage:  http://localhost:${PORT}/index.html\n`);
});
