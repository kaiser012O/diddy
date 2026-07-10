// ─────────────────────────────────────────────────────────────────────────
// api/ratings.js
//
// MERGED endpoint — combines ratings-list.js and rating-create.js into one
// Serverless Function to stay under Vercel Hobby's 12-function limit.
//
//   GET  /api/ratings?doctorId=<uid>&limit=20   -> list ratings (public)
//   POST /api/ratings                            -> submit a rating (public)
//
// Behavior of each branch is unchanged from the original files.
// ─────────────────────────────────────────────────────────────────────────

import { db } from './_lib/firebaseAdmin.js';
import { setCors } from './_lib/cors.js';
import { checkRateLimit, getClientIp } from './_lib/rateLimit.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const MAX_RATINGS_PER_WINDOW = 10;
const WINDOW_MS = 60 * 60 * 1000;
const PHONE_REGEX = /^[0-9+\s-]{8,20}$/;
const UNSAFE_CHARS_REGEX = /[<>{}$`]/;

function normalizePhone(phone) {
  return (phone || '').replace(/[^\d]/g, '');
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  setCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return handleRatingsList(req, res);
  }

  if (req.method === 'POST') {
    return handleRatingCreate(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── GET /api/ratings?doctorId=&limit= (public) ──────────────────────────────
async function handleRatingsList(req, res) {
  const { doctorId } = req.query;
  if (!doctorId || typeof doctorId !== 'string') {
    return res.status(400).json({ error: 'Missing doctorId parameter' });
  }

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  try {
    const snapshot = await db
      .collection('clinics')
      .doc(doctorId)
      .collection('ratings')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const ratings = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        score: data.score,
        comment: data.comment || null,
        clientName: data.clientName || null,
        createdAt: data.createdAt,
      };
    });

    return res.status(200).json({ ratings });

  } catch (err) {
    console.error('[ratings-list] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to fetch ratings' });
  }
}

// ── POST /api/ratings (public, rate-limited) ────────────────────────────────
async function handleRatingCreate(req, res) {
  const ip = getClientIp(req);
  const allowed = await checkRateLimit('rating-create', ip, MAX_RATINGS_PER_WINDOW, WINDOW_MS);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many rating attempts. Please try again later.' });
  }

  const { doctorId, bookingId, clientPhone, score, comment } = req.body || {};

  if (!doctorId || typeof doctorId !== 'string') {
    return res.status(400).json({ error: 'Missing doctorId' });
  }
  if (!bookingId || typeof bookingId !== 'string') {
    return res.status(400).json({ error: 'Missing bookingId' });
  }
  if (!clientPhone || !PHONE_REGEX.test(clientPhone)) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }
  const scoreNum = Number(score);
  if (!Number.isInteger(scoreNum) || scoreNum < 1 || scoreNum > 5) {
    return res.status(400).json({ error: 'Score must be an integer from 1 to 5' });
  }
  if (comment && (typeof comment !== 'string' || comment.length > 500)) {
    return res.status(400).json({ error: 'Comment too long (max 500 characters)' });
  }
  if (comment && UNSAFE_CHARS_REGEX.test(comment)) {
    return res.status(400).json({ error: 'Comment contains invalid characters' });
  }

  const bookingRef = db.collection('clinics').doc(doctorId).collection('bookings').doc(bookingId);
  const clinicRef = db.collection('clinics').doc(doctorId);
  const ratingRef = db.collection('clinics').doc(doctorId).collection('ratings').doc();

  try {
    await db.runTransaction(async (transaction) => {
      const bookingSnap = await transaction.get(bookingRef);

      if (!bookingSnap.exists) {
        throw new Error('BOOKING_NOT_FOUND');
      }

      const booking = bookingSnap.data();

      if (normalizePhone(booking.clientPhone) !== normalizePhone(clientPhone)) {
        throw new Error('PHONE_MISMATCH');
      }

      if (booking.date >= todayISO()) {
        throw new Error('APPOINTMENT_NOT_PAST');
      }

      if (booking.attendance === 'no_show') {
        throw new Error('NOT_ATTENDED');
      }

      if (booking.rated === true) {
        throw new Error('ALREADY_RATED');
      }

      const clinicSnap = await transaction.get(clinicRef);
      const clinicData = clinicSnap.exists ? clinicSnap.data() : {};
      const oldCount = clinicData.ratingCount || 0;
      const oldAverage = clinicData.ratingAverage || 0;

      const newCount = oldCount + 1;
      const newAverage = (oldAverage * oldCount + scoreNum) / newCount;

      transaction.set(ratingRef, {
        bookingId,
        score: scoreNum,
        comment: comment || null,
        clientName: booking.clientName || null,
        createdAt: new Date().toISOString(),
      });

      transaction.update(bookingRef, { rated: true });

      transaction.set(
        clinicRef,
        {
          ratingCount: newCount,
          ratingAverage: Math.round(newAverage * 10) / 10,
        },
        { merge: true }
      );
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    const knownErrors = {
      BOOKING_NOT_FOUND: [404, 'لم يتم العثور على هذا الحجز'],
      PHONE_MISMATCH: [403, 'رقم الهاتف لا يطابق صاحب الحجز'],
      APPOINTMENT_NOT_PAST: [400, 'لا يمكن تقييم موعد لم يحن بعد'],
      NOT_ATTENDED: [403, 'لا يمكن تقييم موعد لم تتم زيارته'],
      ALREADY_RATED: [409, 'تم تقييم هذا الحجز من قبل'],
    };

    if (knownErrors[err.message]) {
      const [status, message] = knownErrors[err.message];
      return res.status(status).json({ error: message });
    }

    console.error('[rating-create] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to submit rating' });
  }
}
