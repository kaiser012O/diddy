// ─────────────────────────────────────────────────────────────────────────
// api/availability.js
//
// MERGED endpoint — combines availability-get.js, availability-set.js,
// availability-exceptions-get.js, and availability-exception-set.js into
// one Serverless Function to stay under Vercel Hobby's 12-function limit.
//
// Routing:
//   GET  /api/availability?doctorId=<uid>&date=YYYY-MM-DD
//        -> public open-slots lookup (availability-get.js)
//   GET  /api/availability?date=YYYY-MM-DD&exceptions=1   (auth required)
//        -> doctor's own exceptions/dayCancelled for that date
//   POST /api/availability   { date, slots: [...] }               (auth)
//        -> full overwrite of openSlots (availability-set.js)
//   POST /api/availability   { date, time, cancelled } | { date, dayCancelled } (auth)
//        -> exception toggle (availability-exception-set.js)
//
// Behavior of each branch is unchanged from the original files.
// ─────────────────────────────────────────────────────────────────────────

import { db, verifyDoctorToken } from './_lib/firebaseAdmin.js';
import { setCors } from './_lib/cors.js';
import { resolveOpenSlots, getBookedTimes, isWithinBookingWindow, isValidCalendarDate } from './_lib/availabilityResolver.js';

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export default async function handler(req, res) {
  setCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    if (req.query.exceptions !== undefined) {
      return handleExceptionsGet(req, res);
    }
    return handleAvailabilityGet(req, res);
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    // Distinguish "full overwrite" (has `slots`) from "exception toggle"
    // (has `time`/`cancelled` or `dayCancelled`) the same way the two
    // original endpoints were shaped.
    if (body.slots !== undefined) {
      return handleAvailabilitySet(req, res);
    }
    return handleExceptionSet(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── GET /api/availability?doctorId=&date= (public open slots) ──────────────
async function handleAvailabilityGet(req, res) {
  const { doctorId, date } = req.query;

  if (!doctorId || typeof doctorId !== 'string') {
    return res.status(400).json({ error: 'Missing doctorId parameter' });
  }
  if (!date || !isValidCalendarDate(date)) {
    return res.status(400).json({ error: 'Invalid or missing date (expected YYYY-MM-DD)' });
  }

  try {
    const clinicRef = db.collection('clinics').doc(doctorId);
    const availabilityRef = clinicRef.collection('availability').doc(date);

    const [clinicSnap, availSnap, bookedTimes] = await Promise.all([
      clinicRef.get(),
      availabilityRef.get(),
      getBookedTimes(db, doctorId, date),
    ]);

    const openSlots = resolveOpenSlots({
      date,
      legacyAvailData: availSnap.exists ? availSnap.data() : null,
      clinicData: clinicSnap.exists ? clinicSnap.data() : null,
      bookedTimes,
    });

    return res.status(200).json({ date, openSlots });

  } catch (err) {
    console.error('[availability-get] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to fetch availability' });
  }
}

// ── GET /api/availability?date=&exceptions=1 (auth, own exceptions) ────────
async function handleExceptionsGet(req, res) {
  let decodedToken;
  try {
    decodedToken = await verifyDoctorToken(req);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing login token' });
  }
  const doctorUid = decodedToken.uid;

  const { date } = req.query;
  if (!date || !isValidCalendarDate(date)) {
    return res.status(400).json({ error: 'Invalid or missing date (expected YYYY-MM-DD)' });
  }

  try {
    const snap = await db
      .collection('clinics')
      .doc(doctorUid)
      .collection('availability')
      .doc(date)
      .get();

    if (!snap.exists) {
      return res.status(200).json({ date, exceptions: [], dayCancelled: false });
    }

    const data = snap.data();
    return res.status(200).json({
      date,
      exceptions: Array.isArray(data.exceptions) ? data.exceptions : [],
      dayCancelled: data.dayCancelled === true,
    });

  } catch (err) {
    console.error('[availability-exceptions-get] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to fetch exceptions' });
  }
}

// ── POST /api/availability { date, slots } (auth, full overwrite) ──────────
async function handleAvailabilitySet(req, res) {
  let decodedToken;
  try {
    decodedToken = await verifyDoctorToken(req);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing login token' });
  }

  const doctorUid = decodedToken.uid;
  const { date, slots } = req.body || {};

  if (!date || !isValidCalendarDate(date)) {
    return res.status(400).json({ error: 'Invalid or missing date (expected YYYY-MM-DD)' });
  }

  if (!Array.isArray(slots) || slots.length > 100) {
    return res.status(400).json({ error: 'Invalid slots list' });
  }
  for (const slot of slots) {
    if (typeof slot !== 'string' || !TIME_REGEX.test(slot)) {
      return res.status(400).json({ error: `Invalid time format: ${slot} (expected HH:MM)` });
    }
  }

  try {
    const availabilityRef = db
      .collection('clinics')
      .doc(doctorUid)
      .collection('availability')
      .doc(date);

    const bookingsSnap = await db
      .collection('clinics')
      .doc(doctorUid)
      .collection('bookings')
      .where('date', '==', date)
      .get();

    const bookedTimes = new Set(
      bookingsSnap.docs
        .map((doc) => doc.data())
        .filter((b) => b.status !== 'cancelled')
        .map((b) => b.time)
    );

    const cleanSlots = [...new Set(slots)]
      .filter((t) => !bookedTimes.has(t))
      .sort();

    await availabilityRef.set({
      date,
      openSlots: cleanSlots,
      updatedAt: new Date().toISOString(),
    });

    return res.status(200).json({ success: true, date, slotsCount: cleanSlots.length });

  } catch (err) {
    console.error('[availability-set] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to save availability' });
  }
}

// ── POST /api/availability { date, time, cancelled } | { date, dayCancelled } (auth) ──
async function handleExceptionSet(req, res) {
  let decodedToken;
  try {
    decodedToken = await verifyDoctorToken(req);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing login token' });
  }
  const doctorUid = decodedToken.uid;

  const { date, time, cancelled, dayCancelled } = req.body || {};

  if (!date || !isValidCalendarDate(date)) {
    return res.status(400).json({ error: 'Invalid or missing date (expected YYYY-MM-DD)' });
  }
  if (!isWithinBookingWindow(date)) {
    return res.status(400).json({ error: 'Exceptions can only be set within the next 60 days' });
  }

  const isDayToggle = dayCancelled !== undefined;
  const isTimeToggle = time !== undefined || cancelled !== undefined;

  if (isDayToggle === isTimeToggle) {
    return res.status(400).json({ error: 'Provide either {time, cancelled} or {dayCancelled}, not both' });
  }

  if (isTimeToggle) {
    if (!time || !TIME_REGEX.test(time)) {
      return res.status(400).json({ error: 'Invalid time format (expected HH:MM)' });
    }
    if (typeof cancelled !== 'boolean') {
      return res.status(400).json({ error: 'cancelled must be a boolean' });
    }
  } else {
    if (typeof dayCancelled !== 'boolean') {
      return res.status(400).json({ error: 'dayCancelled must be a boolean' });
    }
  }

  const availabilityRef = db
    .collection('clinics')
    .doc(doctorUid)
    .collection('availability')
    .doc(date);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(availabilityRef);
      const existing = snap.exists ? snap.data() : {};
      const currentExceptions = Array.isArray(existing.exceptions) ? existing.exceptions : [];
      const currentDayCancelled = existing.dayCancelled === true;

      let nextExceptions = currentExceptions;
      let nextDayCancelled = currentDayCancelled;

      if (isTimeToggle) {
        nextExceptions = cancelled
          ? [...new Set([...currentExceptions, time])]
          : currentExceptions.filter((t) => t !== time);
      } else {
        nextDayCancelled = dayCancelled;
      }

      transaction.set(
        availabilityRef,
        {
          date,
          exceptions: nextExceptions,
          dayCancelled: nextDayCancelled,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

      return { exceptions: nextExceptions, dayCancelled: nextDayCancelled };
    });

    return res.status(200).json({ success: true, date, ...result });

  } catch (err) {
    console.error('[availability-exception-set] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to save exception' });
  }
}
