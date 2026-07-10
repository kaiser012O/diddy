// ─────────────────────────────────────────────────────────────────────────
// api/master-template-set.js
//
// Lets a signed-in doctor create/update/lock/unlock their recurring WEEKLY
// schedule template. Stored at clinics/{doctorUid}.masterTemplate.
//
// PROTECTED: requires a valid Firebase Auth token.
//
// Two distinct actions, both go through this one endpoint:
//
//   1. SAVE WHILE UNLOCKED (edit mode) — free-form editing:
//      { "weekly": { "0": ["09:00", ...], ..., "6": [...] },
//        "slotDurationMinutes": 30,
//        "locked": false }
//
//   2. LOCK (activate) — same body but "locked": true. This is where we
//      enforce the "protect existing future bookings" policy: if ANY
//      confirmed future booking (within the 60-day window) would fall on
//      a time that doesn't exist in the new weekly template for its
//      weekday, the whole request is rejected with a clear list of the
//      conflicting bookings so the doctor knows exactly what to resolve.
//
//   3. UNLOCK — { "locked": false } with no `weekly`/`slotDurationMinutes` —
//      just flips back to edit mode without changing the template itself.
//
// Response: { "success": true, "masterTemplate": {...} }
//        or: { "error": "...", "conflicts": [{date, time}, ...] }  (409)
// ─────────────────────────────────────────────────────────────────────────

import { db, verifyDoctorToken } from './_lib/firebaseAdmin.js';
import { setCors } from './_lib/cors.js';
import { BOOKING_WINDOW_DAYS, dayOfWeekFromDateString } from './_lib/availabilityResolver.js';

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALLOWED_SLOT_DURATIONS = [15, 30, 45, 60];
const VALID_DAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'];
const MAX_SLOTS_PER_DAY = 100;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysISO(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function validateWeekly(weekly) {
  if (typeof weekly !== 'object' || weekly === null || Array.isArray(weekly)) {
    return 'weekly must be an object keyed by weekday (0-6)';
  }
  for (const key of Object.keys(weekly)) {
    if (!VALID_DAY_KEYS.includes(key)) {
      return `Invalid weekday key: ${key} (expected 0-6)`;
    }
    const times = weekly[key];
    if (!Array.isArray(times) || times.length > MAX_SLOTS_PER_DAY) {
      return `Invalid slots list for day ${key}`;
    }
    for (const t of times) {
      if (typeof t !== 'string' || !TIME_REGEX.test(t)) {
        return `Invalid time format "${t}" for day ${key} (expected HH:MM)`;
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  setCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let decodedToken;
  try {
    decodedToken = await verifyDoctorToken(req);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing login token' });
  }
  const doctorUid = decodedToken.uid;

  const { weekly, slotDurationMinutes, locked } = req.body || {};

  if (typeof locked !== 'boolean') {
    return res.status(400).json({ error: 'locked (boolean) is required' });
  }

  // Weekly/slotDurationMinutes are optional ONLY for a pure unlock request.
  const isPureUnlock = locked === false && weekly === undefined && slotDurationMinutes === undefined;

  if (!isPureUnlock) {
    if (weekly === undefined) {
      return res.status(400).json({ error: 'weekly is required' });
    }
    const weeklyError = validateWeekly(weekly);
    if (weeklyError) {
      return res.status(400).json({ error: weeklyError });
    }
    if (slotDurationMinutes === undefined || !ALLOWED_SLOT_DURATIONS.includes(slotDurationMinutes)) {
      return res.status(400).json({ error: 'slotDurationMinutes must be one of 15, 30, 45, 60' });
    }
  }

  const clinicRef = db.collection('clinics').doc(doctorUid);

  try {
    // ── Pure unlock: just flip the flag, nothing else to validate ────────
    if (isPureUnlock) {
      const clinicSnap = await clinicRef.get();
      const existing = clinicSnap.exists ? clinicSnap.data().masterTemplate : null;
      if (!existing) {
        return res.status(404).json({ error: 'No master template exists yet' });
      }
      const updated = { ...existing, locked: false, updatedAt: new Date().toISOString() };
      await clinicRef.set({ masterTemplate: updated }, { merge: true });
      return res.status(200).json({ success: true, masterTemplate: updated });
    }

    // ── Saving while staying unlocked (edit mode, no conflict check needed
    //    since nothing is being locked in yet — the doctor is still free
    //    to keep adjusting) ────────────────────────────────────────────────
    if (locked === false) {
      const masterTemplate = {
        locked: false,
        weekly,
        slotDurationMinutes,
        updatedAt: new Date().toISOString(),
      };
      await clinicRef.set({ masterTemplate, slotDurationMinutes }, { merge: true });
      return res.status(200).json({ success: true, masterTemplate });
    }

    // ── Locking (activating): must check every confirmed future booking
    //    within the booking window against the NEW weekly template. If a
    //    booked time doesn't exist in that weekday's new slot list, reject
    //    the whole lock with the specific conflicting bookings listed. ────
    const startDate = todayISO();
    const endDate = addDaysISO(startDate, BOOKING_WINDOW_DAYS);

    const bookingsSnap = await db
      .collection('clinics')
      .doc(doctorUid)
      .collection('bookings')
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();

    const conflicts = [];
    for (const doc of bookingsSnap.docs) {
      const b = doc.data();
      if (b.status === 'cancelled') continue;
      const dow = String(dayOfWeekFromDateString(b.date));
      const allowedTimes = Array.isArray(weekly[dow]) ? weekly[dow] : [];
      if (!allowedTimes.includes(b.time)) {
        conflicts.push({ date: b.date, time: b.time });
      }
    }

    if (conflicts.length > 0) {
      conflicts.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return res.status(409).json({
        error: 'Cannot lock this schedule: it conflicts with existing future bookings. Please resolve them first or keep a schedule that covers these times.',
        conflicts,
      });
    }

    const masterTemplate = {
      locked: true,
      weekly,
      slotDurationMinutes,
      updatedAt: new Date().toISOString(),
    };
    await clinicRef.set({ masterTemplate, slotDurationMinutes }, { merge: true });
    return res.status(200).json({ success: true, masterTemplate });

  } catch (err) {
    console.error('[master-template-set] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to save master template' });
  }
}
