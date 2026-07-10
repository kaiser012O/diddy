// ─────────────────────────────────────────────────────────────────────────
// /api/ai-generate.js
// Vercel Serverless Function — acts as a secure proxy between the frontend
// and the Gemini API. The API key NEVER reaches the browser.
//
// Required setup on Vercel:
//   Project Settings → Environment Variables → add:
//     Key:   GEMINI_API_KEY
//     Value: (your real Gemini API key from aistudio.google.com)
// ─────────────────────────────────────────────────────────────────────────

import { setCors } from './_lib/cors.js';
import { checkRateLimit, getClientIp } from './_lib/rateLimit.js';

// This endpoint calls a paid AI API and has no login requirement, so it's
// the easiest one to abuse for cost. Keep this limit tight.
const MAX_REQUESTS_PER_WINDOW = 5;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

export default async function handler(req, res) {
  setCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Rate limit: this endpoint costs real money per call ─────────────────
  const ip = getClientIp(req);
  const allowed = await checkRateLimit('ai-generate', ip, MAX_REQUESTS_PER_WINDOW, WINDOW_MS);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { description } = req.body || {};

  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'Missing "description" field' });
  }

  // Basic length guard to avoid abuse / huge payloads
  if (description.length > 2000) {
    return res.status(400).json({ error: 'Description too long' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[ai-generate] GEMINI_API_KEY is not set in environment variables.');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  try {
    const prompt = `You are a medical assistant helping a doctor describe their clinic profile.
Based on the following description written by a doctor, generate a clean, professional
summary in JSON format with these fields: "specialty", "yearsOfExperience" (number or null),
"bio" (2-3 sentences, professional tone), "services" (array of strings).

Doctor's description: "${description}"

Respond ONLY with valid JSON, no markdown, no extra text.`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.error('[ai-generate] Gemini API error:', errText);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await geminiResponse.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Try to parse the model's JSON output; fall back to raw text if it fails
    let parsed;
    try {
      const cleaned = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { raw: text };
    }

    return res.status(200).json({ result: parsed });

  } catch (err) {
    console.error('[ai-generate] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
