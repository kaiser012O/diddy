// ─────────────────────────────────────────────────────────────────────────
// api/cron-send-rating-requests.js
//
// Runs automatically once a day (see the "crons" entry in vercel.json).
// For every doctor, scans their bookings for appointments whose date has
// already passed, that the doctor has explicitly marked as "attended" (see
// the attendance toggle in the dashboard), and that haven't been notified
// yet — then sends the patient a WhatsApp message with a direct rating
// link. Fully automatic once the doctor confirms attendance; no manual
// "copy the link" step needed anywhere.
//
// Bookings still 'pending' attendance are left alone and re-checked on
// every future run until the doctor marks them either way — a patient who
// never showed up should never receive a "thanks for visiting" message.
//
// SECURITY: only Vercel itself can trigger this (see CRON_SECRET check
// below) — it is NOT a public endpoint.
//
// Required additional environment variables (on top of the WhatsApp ones
// in api/_lib/whatsapp.js):
//   CRON_SECRET   = any random string 16+ characters (generate once, paste
//                   into Vercel env vars — Vercel then sends it back
//                   automatically as the Authorization header every time
//                   it triggers this endpoint)
//   SITE_URL      = the site's real public URL, e.g.
//                   https://my-platform-pi.vercel.app
//                   (falls back to Vercel's own VERCEL_URL if not set,
//                   but setting it explicitly is more reliable)
//
// Design notes:
//   - Deliberately queries each doctor's `bookings` subcollection
//     separately (not a cross-doctor collectionGroup query) with a single
//     equality filter only (`ratingRequestSent == false`). A single
//     equality filter never needs a manually-created Firestore index —
//     the exact same lesson learned the hard way with bookings-list.js.
//     A collectionGroup query would need one, adding another manual setup
//     step and another way for this to silently break in production.
//   - The "is this appointment actually in the past" check happens in
//     plain JS after fetching, not as a second Firestore filter, for the
//     same index-avoidance reason.
// ─────────────────────────────────────────────────────────────────────────

import { db } from './_lib/firebaseAdmin.js';
import { sendWhatsAppMessage } from './_lib/whatsapp.js';

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const siteUrl = process.env.SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!siteUrl) {
    console.error('[cron-rating-requests] No SITE_URL configured — cannot build rating links.');
    return res.status(500).json({ error: 'SITE_URL not configured' });
  }

  const today = todayISO();
  let notifiedCount = 0;
  let scannedDoctors = 0;
  let errors = 0;

  try {
    const clinicsSnapshot = await db.collection('clinics').get();
    scannedDoctors = clinicsSnapshot.size;

    for (const clinicDoc of clinicsSnapshot.docs) {
      const doctorId = clinicDoc.id;

      const bookingsSnapshot = await db
        .collection('clinics')
        .doc(doctorId)
        .collection('bookings')
        .where('ratingRequestSent', '==', false)
        .get();

      for (const bookingDoc of bookingsSnapshot.docs) {
        const booking = bookingDoc.data();

        // Only notify for appointments that have actually already happened
        // AND that the doctor explicitly confirmed the patient attended.
        // 'pending' (doctor hasn't marked it yet) is deliberately left
        // alone here — the cron will simply retry on the next run, once a
        // day, until the doctor marks it either way.
        if (booking.date >= today) continue;
        if (booking.attendance !== 'attended') continue;
        if (!booking.clientPhone) continue;

        const ratingUrl = `${siteUrl}/clinic.html?doctorId=${doctorId}&rate=${bookingDoc.id}`;
        const doctorName = clinicDoc.data().doctorName || 'الطبيب';

        try {
          const result = await sendWhatsAppMessage(
            booking.clientPhone,
            `شكراً لزيارتك ${doctorName}! نتمنى أن تشاركنا رأيك في تجربتك:\n${ratingUrl}`
          );

          // Mark as notified regardless of send success — if the number is
          // invalid or Twilio fails, retrying daily forever isn't useful;
          // this keeps the cron job's workload bounded to genuinely new
          // past appointments each run.
          await bookingDoc.ref.update({ ratingRequestSent: true });

          if (result.success) {
            notifiedCount++;
          } else {
            errors++;
          }
        } catch (sendErr) {
          console.error(`[cron-rating-requests] Failed to notify booking ${bookingDoc.id}:`, sendErr);
          await bookingDoc.ref.update({ ratingRequestSent: true }).catch(() => {});
          errors++;
        }
      }
    }

    return res.status(200).json({
      success: true,
      scannedDoctors,
      notified: notifiedCount,
      errors,
    });

  } catch (err) {
    console.error('[cron-rating-requests] Unexpected error:', err);
    return res.status(500).json({ error: 'Failed to process rating requests' });
  }
}
