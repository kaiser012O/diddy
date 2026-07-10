// ─────────────────────────────────────────────────────────────────────────
// api/bookings.js
//
// MERGED endpoint — combines bookings-list.js, booking-create.js,
// booking-cancel.js, and booking-attendance.js into one Serverless
// Function to stay under Vercel Hobby's 12-function limit.
//
// Routing:
//   GET  /api/bookings                          -> list doctor's bookings (auth)
//   POST /api/bookings   { action: "create", ... }     -> create booking (public)
//   POST /api/bookings   { action: "cancel", ... }      -> cancel booking
//   POST /api/bookings   { action: "attendance", ... }  -> mark attendance (auth)
//
// Behavior of each branch is unchanged from the original files.
// ─────────────────────────────────────────────────────────────────────────

import { db, verifyDoctorToken } from './_lib/firebaseAdmin.js';
import { setCors } from './_lib/cors.js';
import { checkRateLimit, getClientIp } from './_lib/rateLimit.js';
import { resolveOpenSlots, isWithinBookingWindow, isValidCalendarDate } from './_lib/availabilityResolver.js';
import { sendWhatsAppMessage } from './_lib/whatsapp.js';

const MAX_BOOKINGS_WITHOUT_DATE_FILTER = 200;

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PHONE_REGEX = /^[0-9+\s-]{8,20}$/;
const UNSAFE_CHARS_REGEX = /[<>{}$`]/;
const MAX_BOOKINGS_PER_WINDOW = 10;
const CREATE_WINDOW_MS = 60 * 60 * 1000;

const MAX_CANCELS_PER_WINDOW = 20;
const CANCEL_WINDOW_MS = 60 * 60 * 1000;

const VALID_ATTENDANCE_VALUES = ['attended', 'no_show'];

export default async function handler(req, res) {
  setCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return handleBookingsList(req, res);
  }

  if (req.method === 'POST') {
    const action = req.body?.action;
    if (action === 'create') return handleBookingCreate(req, res);
    if (action === 'cancel') return handleBookingCancel(req, res);
    if (action === 'attendance') return handleBookingAttendance(req, res);
    return res.status(400).json({ error: 'Missing or invalid "action" (must be "create", "cancel", or "attendance")' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── GET /api/bookings (doctor's own bookings) ───────────────────────────────
async function handleBookingsList(req, res) {
  let decodedToken;
  try {
    decodedToken = await verifyDoctorToken(req);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing login token' });
  }

  const doctorUid = decodedToken.uid;
  const { date } = req.query;
  const hasDateFilter = date && /^\d{4}-\d{2}-\d{2}$/.test(date);

  try {
    const bookingsCollection = db
      .collection('clinics')
      .doc(doctorUid)
      .collection('bookings');

    let snapshot;

    if (hasDateFilter) {
      snapshot = await bookingsCollection
        .where('date', '==', date)
        .get();
    } else {
      snapshot = await bookingsCollection
        .orderBy('date', 'desc')
        .limit(MAX_BOOKINGS_WITHOUT_DATE_FILTER)
        .get();
    }

    let bookings = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    bookings = bookings.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.time || '').localeCompare(b.time || '');
    });

    return res.status(200).json({ bookings });

  } catch (err) {
    console.error('[bookings-list] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to fetch bookings' });
  }
}

// ── POST action:"create" (public) ───────────────────────────────────────────
async function handleBookingCreate(req, res) {
  const ip = getClientIp(req);
  const allowed = await checkRateLimit('booking-create', ip, MAX_BOOKINGS_PER_WINDOW, CREATE_WINDOW_MS);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many booking attempts. Please try again later.' });
  }

  const { doctorId, date, time, clientName, clientPhone } = req.body || {};

  if (!doctorId || typeof doctorId !== 'string') {
    return res.status(400).json({ error: 'Missing doctorId' });
  }
  if (!date || !isValidCalendarDate(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }
  if (!time || !TIME_REGEX.test(time)) {
    return res.status(400).json({ error: 'Invalid time' });
  }
  if (!clientPhone || !PHONE_REGEX.test(clientPhone)) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }
  if (clientName !== undefined && clientName !== null) {
    if (typeof clientName !== 'string' || clientName.length > 100) {
      return res.status(400).json({ error: 'Client name too long' });
    }
    if (UNSAFE_CHARS_REGEX.test(clientName)) {
      return res.status(400).json({ error: 'Client name contains invalid characters' });
    }
  }

  const normalizedPhone = clientPhone.replace(/[\s-]/g, '');
  const phoneAllowed = await checkRateLimit('booking-create-phone', normalizedPhone, MAX_BOOKINGS_PER_WINDOW, CREATE_WINDOW_MS);
  if (!phoneAllowed) {
    return res.status(429).json({ error: 'Too many booking attempts. Please try again later.' });
  }

  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const requestedDateTime = new Date(y, mo - 1, d, h, mi);
  if (requestedDateTime.getTime() < Date.now()) {
    return res.status(400).json({ error: 'Cannot book an appointment in the past' });
  }

  if (!isWithinBookingWindow(date)) {
    return res.status(400).json({ error: 'Bookings can only be made within the next 60 days' });
  }

  const availabilityRef = db
    .collection('clinics')
    .doc(doctorId)
    .collection('availability')
    .doc(date);

  const bookingsRef = db
    .collection('clinics')
    .doc(doctorId)
    .collection('bookings');

  try {
    const clinicSnap = await db.collection('clinics').doc(doctorId).get();
    if (clinicSnap.exists && clinicSnap.data().bookingEnabled === false) {
      return res.status(403).json({ error: 'Online booking is currently disabled for this clinic' });
    }
  } catch (err) {
    console.error('[booking-create] Failed to check bookingEnabled:', err);
    return res.status(500).json({ error: 'Failed to create booking' });
  }

  const MAX_ACTIVE_BOOKINGS_PER_PHONE_PER_DAY = 2;
  try {
    const sameDayPhoneSnap = await bookingsRef.where('date', '==', date).where('clientPhone', '==', clientPhone).get();
    const activeCount = sameDayPhoneSnap.docs.filter(d => d.data().status !== 'cancelled').length;
    if (activeCount >= MAX_ACTIVE_BOOKINGS_PER_PHONE_PER_DAY) {
      return res.status(409).json({ error: 'You already have the maximum number of bookings with this clinic for this day' });
    }
  } catch (err) {
    console.error('[booking-create] Failed to check per-phone daily cap:', err);
    return res.status(500).json({ error: 'Failed to create booking' });
  }

  const clinicRef = db.collection('clinics').doc(doctorId);

  try {
    const bookingId = await db.runTransaction(async (transaction) => {
      const [availSnap, clinicSnap] = await Promise.all([
        transaction.get(availabilityRef),
        transaction.get(clinicRef),
      ]);

      const bookingsSnap = await transaction.get(
        bookingsRef.where('date', '==', date)
      );
      const bookedTimes = new Set(
        bookingsSnap.docs
          .map((doc) => doc.data())
          .filter((b) => b.status !== 'cancelled')
          .map((b) => b.time)
      );

      const openSlots = resolveOpenSlots({
        date,
        legacyAvailData: availSnap.exists ? availSnap.data() : null,
        clinicData: clinicSnap.exists ? clinicSnap.data() : null,
        bookedTimes,
      });

      if (!openSlots.includes(time)) {
        throw new Error('SLOT_NOT_AVAILABLE');
      }

      if (availSnap.exists && Array.isArray(availSnap.data().openSlots)) {
        const updatedSlots = availSnap.data().openSlots.filter((s) => s !== time);
        transaction.update(availabilityRef, { openSlots: updatedSlots });
      }

      const newBookingRef = bookingsRef.doc();
      transaction.set(newBookingRef, {
        date,
        time,
        clientName: clientName || null,
        clientPhone,
        status: 'confirmed',
        createdAt: new Date().toISOString(),
        ratingRequestSent: false,
        attendance: 'pending',
      });

      return newBookingRef.id;
    });

    try {
      const clinicSnapForNotify = await clinicRef.get();
      const doctorWhatsapp = clinicSnapForNotify.exists ? clinicSnapForNotify.data().whatsapp : null;

      if (doctorWhatsapp) {
        await sendWhatsAppMessage(
          doctorWhatsapp,
          `📅 حجز جديد!\nالمريض: ${clientName || 'بدون اسم'}\nالتاريخ: ${date}\nالوقت: ${time}\nالهاتف: ${clientPhone}`
        );
      }
    } catch (notifyErr) {
      console.error('[booking-create] WhatsApp notification failed (booking still succeeded):', notifyErr);
    }

    return res.status(200).json({ success: true, bookingId });

  } catch (err) {
    if (err.message === 'SLOT_NOT_AVAILABLE') {
      return res.status(409).json({ error: 'This time slot was just taken. Please choose another.' });
    }
    console.error('[booking-create] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to create booking' });
  }
}

// ── POST action:"cancel" ────────────────────────────────────────────────────
async function handleBookingCancel(req, res) {
  const ip = getClientIp(req);
  const allowed = await checkRateLimit('booking-cancel', ip, MAX_CANCELS_PER_WINDOW, CANCEL_WINDOW_MS);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many cancellation attempts. Please try again later.' });
  }

  const { doctorId, bookingId, cancelledBy, clientPhone } = req.body || {};

  if (!doctorId || typeof doctorId !== 'string') {
    return res.status(400).json({ error: 'Missing doctorId' });
  }
  if (!bookingId || typeof bookingId !== 'string') {
    return res.status(400).json({ error: 'Missing bookingId' });
  }
  if (cancelledBy !== 'doctor' && cancelledBy !== 'client') {
    return res.status(400).json({ error: 'cancelledBy must be "doctor" or "client"' });
  }
  if (cancelledBy === 'client' && (!clientPhone || typeof clientPhone !== 'string')) {
    return res.status(400).json({ error: 'clientPhone is required to cancel as a client' });
  }

  if (cancelledBy === 'doctor') {
    let decodedToken;
    try {
      decodedToken = await verifyDoctorToken(req);
    } catch (err) {
      return res.status(401).json({ error: 'Unauthorized: invalid or missing login token' });
    }
    if (decodedToken.uid !== doctorId) {
      return res.status(403).json({ error: 'Forbidden: you can only cancel your own clinic bookings' });
    }
  }

  const bookingRef = db
    .collection('clinics')
    .doc(doctorId)
    .collection('bookings')
    .doc(bookingId);

  const availabilityCollectionRef = db
    .collection('clinics')
    .doc(doctorId)
    .collection('availability');

  try {
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingSnap.data();
    const { date, time, clientPhone: bookingPhone } = booking;

    if (cancelledBy === 'client' && clientPhone !== bookingPhone) {
      return res.status(403).json({ error: 'Forbidden: phone number does not match this booking' });
    }

    const availabilityRef = availabilityCollectionRef.doc(date);

    await db.runTransaction(async (transaction) => {
      const availSnap = await transaction.get(availabilityRef);

      if (availSnap.exists && Array.isArray(availSnap.data().openSlots)) {
        const currentSlots = availSnap.data().openSlots;
        if (!currentSlots.includes(time)) {
          const restoredSlots = [...currentSlots, time].sort();
          transaction.set(availabilityRef, { openSlots: restoredSlots }, { merge: true });
        }
      }

      transaction.delete(bookingRef);
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[booking-cancel] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to cancel booking' });
  }
}

// ── POST action:"attendance" ────────────────────────────────────────────────
async function handleBookingAttendance(req, res) {
  let decodedToken;
  try {
    decodedToken = await verifyDoctorToken(req);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing login token' });
  }

  const { doctorId, bookingId, attendance } = req.body || {};

  if (!doctorId || typeof doctorId !== 'string') {
    return res.status(400).json({ error: 'Missing doctorId' });
  }
  if (decodedToken.uid !== doctorId) {
    return res.status(403).json({ error: 'Forbidden: you can only update your own clinic bookings' });
  }
  if (!bookingId || typeof bookingId !== 'string') {
    return res.status(400).json({ error: 'Missing bookingId' });
  }
  if (!VALID_ATTENDANCE_VALUES.includes(attendance)) {
    return res.status(400).json({ error: 'attendance must be "attended" or "no_show"' });
  }

  try {
    const bookingRef = db.collection('clinics').doc(doctorId).collection('bookings').doc(bookingId);
    const snap = await bookingRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    await bookingRef.update({ attendance });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[booking-attendance] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to update attendance' });
  }
}
