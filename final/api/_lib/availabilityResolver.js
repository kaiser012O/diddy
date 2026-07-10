// ─────────────────────────────────────────────────────────────────────────
// api/_lib/availabilityResolver.js
//
// SINGLE SOURCE OF TRUTH for "what times is this doctor open on date X".
// Used by BOTH availability-get.js (what the patient sees) and
// booking-create.js (what the server allows a booking against) so the two
// can never silently disagree with each other.
//
// Resolution order (priority, highest first):
//   1. Legacy per-day doc: clinics/{doctorId}/availability/{date} has an
//      `openSlots` array that was written directly (old system, or a day
//      the doctor edited before ever activating a master template).
//      → used AS-IS. This preserves every existing booking/availability
//        row exactly as it worked before master templates existed.
//   2. Master template is locked (active) AND `date` is within the
//      booking window (today .. +60 days inclusive):
//      → weekly[dayOfWeek] MINUS this date's exceptions MINUS dayCancelled
//        MINUS times already booked.
//   3. Otherwise → [] (matches old behavior for a day nobody ever set up).
//
// Booked times are always subtracted server-side regardless of which path
// was used above — never trust openSlots alone to reflect real bookings.
// ─────────────────────────────────────────────────────────────────────────

export const BOOKING_WINDOW_DAYS = 60;

// 🔒 BUG FIX: every endpoint used to validate dates with ONLY the shape
// regex /^\d{4}-\d{2}-\d{2}$/, which accepts calendar-impossible strings
// like "2026-02-30" or "2026-13-45". JavaScript's Date constructor doesn't
// reject those — it silently "rolls over" to a different, real date
// (e.g. new Date(2026, 1, 30) becomes March 2nd, 2026) instead of
// throwing. That means a direct API call (curl/Postman, bypassing the
// <input type="date"> picker that normally prevents this) could create a
// booking or availability entry on a completely different date than the
// one the caller thought they specified — silent data corruption, not a
// crash. This helper checks the shape AND re-derives y/m/d from the
// constructed Date to confirm nothing was rolled over.
export function isValidCalendarDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

// Returns 0-6 (Sun-Sat) for a "YYYY-MM-DD" string, evaluated as a LOCAL
// calendar date (not UTC) so it lines up with how the rest of the app
// already treats date strings (see todayISO() in dashboard-app.js).
export function dayOfWeekFromDateString(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

// Is `dateStr` within [today, today+BOOKING_WINDOW_DAYS] inclusive?
// Both bounds computed from the SERVER clock — never trust a client-sent
// "today" for this kind of check.
export function isWithinBookingWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  target.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + BOOKING_WINDOW_DAYS);

  return target >= today && target <= maxDate;
}

// Fetches confirmed (non-cancelled) booked times for doctorId/date.
// Exported separately so callers already inside a transaction can still
// use the pure computation below without double-fetching bookings.
export async function getBookedTimes(db, doctorId, date) {
  const bookingsSnap = await db
    .collection('clinics')
    .doc(doctorId)
    .collection('bookings')
    .where('date', '==', date)
    .get();

  return new Set(
    bookingsSnap.docs
      .map((doc) => doc.data())
      .filter((b) => b.status !== 'cancelled')
      .map((b) => b.time)
  );
}

// Pure function: given the raw docs/data already fetched, compute the
// resolved open slots. No Firestore calls here — makes it safe to use
// both outside and inside a transaction.
//
// Params:
//   date               - "YYYY-MM-DD"
//   legacyAvailData     - data() of clinics/{doctorId}/availability/{date}, or null/undefined
//   clinicData          - data() of clinics/{doctorId} (for masterTemplate), or null/undefined
//   bookedTimes          - Set<string> of already-booked HH:MM for this date
export function resolveOpenSlots({ date, legacyAvailData, clinicData, bookedTimes }) {
  const booked = bookedTimes || new Set();

  // 1. Legacy per-day doc with an explicit openSlots array wins outright.
  if (legacyAvailData && Array.isArray(legacyAvailData.openSlots)) {
    return legacyAvailData.openSlots.filter((t) => !booked.has(t));
  }

  // 2. Master template, only if locked (active) and within the booking window.
  const template = clinicData?.masterTemplate;
  if (template?.locked === true && isWithinBookingWindow(date)) {
    if (legacyAvailData?.dayCancelled === true) {
      return [];
    }

    const dow = String(dayOfWeekFromDateString(date));
    const weeklySlots = Array.isArray(template.weekly?.[dow]) ? template.weekly[dow] : [];
    const exceptions = new Set(
      Array.isArray(legacyAvailData?.exceptions) ? legacyAvailData.exceptions : []
    );

    return weeklySlots.filter((t) => !exceptions.has(t) && !booked.has(t));
  }

  // 3. Nothing set up for this day.
  return [];
}
