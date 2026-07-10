// ─────────────────────────────────────────────────────────────────────────
// api/clinic-save.js
//
// Saves (or updates) the doctor's clinic profile in Firestore.
// This is called after the AI builder generates the profile, OR when the
// doctor manually edits/fills fields himself — same endpoint handles both.
//
// PROTECTED: requires a valid Firebase Auth token (doctor must be signed in).
// The clinic document is stored at:  clinics/{doctorUid}
//
// Expected request body (all fields optional except none are required —
// the doctor can save partial data and complete it later):
// {
//   "clinicName": "string",
//   "doctorName": "string",
//   "specialty": "string",
//   "bio": "string",
//   "phone": "string",
//   "whatsapp": "string",
//   "address": "string",
//   "services": ["string", ...],
//   "links": { "instagram": "url", "facebook": "url", ... },
//   "lat": 36.7538,
//   "lng": 3.0588,
//   "bookingEnabled": true,
//   "consultationPrice": 1500,
//   "photos": ["https://res.cloudinary.com/.../photo1.jpg", ...],
//   "isPublished": true
// }
//
// Response: { "success": true, "clinicId": "<doctorUid>" }
// ─────────────────────────────────────────────────────────────────────────

import { db, verifyDoctorToken } from './_lib/firebaseAdmin.js';
import { setCors } from './_lib/cors.js';

const MAX_PHOTOS = 6;
const MAX_PHOTO_URL_LENGTH = 500;
const MAX_CONSULTATION_PRICE = 1000000; // sanity ceiling, not a real business limit

export default async function handler(req, res) {
  setCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Verify the doctor is actually signed in ──────────────────────────
  let decodedToken;
  try {
    decodedToken = await verifyDoctorToken(req);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing login token' });
  }

  const doctorUid = decodedToken.uid;

  // ── 2. Validate incoming data ────────────────────────────────────────────
  const {
    clinicName,
    doctorName,
    specialty,
    bio,
    phone,
    whatsapp,
    address,
    services,
    links,
    lat,
    lng,
    bookingEnabled,
    consultationPrice,
    photos,
    avatarUrl,
    isPublished,
  } = req.body || {};

  // Basic sanity limits to avoid abuse (very long strings, huge arrays)
  if (bio && bio.length > 2000) {
    return res.status(400).json({ error: 'Bio too long (max 2000 characters)' });
  }
  if (services && (!Array.isArray(services) || services.length > 30)) {
    return res.status(400).json({ error: 'Invalid services list' });
  }

  // ── Map coordinates: must be real numbers within valid geographic ranges
  if (lat !== undefined && lat !== null) {
    if (typeof lat !== 'number' || Number.isNaN(lat) || lat < -90 || lat > 90) {
      return res.status(400).json({ error: 'Invalid latitude (must be between -90 and 90)' });
    }
  }
  if (lng !== undefined && lng !== null) {
    if (typeof lng !== 'number' || Number.isNaN(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid longitude (must be between -180 and 180)' });
    }
  }

  // ── Booking toggle: strict boolean only
  if (bookingEnabled !== undefined && typeof bookingEnabled !== 'boolean') {
    return res.status(400).json({ error: 'bookingEnabled must be true or false' });
  }

  // ── Publish toggle: strict boolean only. This is the actual "is this
  //    clinic visible in the public directory" switch — see clinics-list.js.
  if (isPublished !== undefined && typeof isPublished !== 'boolean') {
    return res.status(400).json({ error: 'isPublished must be true or false' });
  }

  // ── Consultation price: display-only number, no payment logic attached
  if (consultationPrice !== undefined && consultationPrice !== null) {
    if (
      typeof consultationPrice !== 'number' ||
      Number.isNaN(consultationPrice) ||
      consultationPrice < 0 ||
      consultationPrice > MAX_CONSULTATION_PRICE
    ) {
      return res.status(400).json({ error: 'Invalid consultation price' });
    }
  }

  // ── Clinic photos: array of hosted image URLs (uploaded client-side to
  //    Cloudinary before this request; we only ever store the resulting
  //    URLs here, never raw file data). Our server never touches the file
  //    bytes at all, so the usual "malicious file upload" attack surface
  //    (executable disguised as an image, oversized files, etc.) doesn't
  //    apply to our own infrastructure — Cloudinary's own platform is
  //    what actually receives and serves the file. What we DO need to
  //    guard here is different: these URLs get rendered as <img src="...">
  //    on the public clinic page later, so we restrict them to Cloudinary's
  //    own domain specifically, not just "any https:// URL" — otherwise a
  //    tampered request could store an arbitrary attacker-controlled link
  //    that gets shown to patients as if it were a legitimate clinic photo.
  if (photos !== undefined) {
    if (!Array.isArray(photos) || photos.length > MAX_PHOTOS) {
      return res.status(400).json({ error: `You can save up to ${MAX_PHOTOS} clinic photos` });
    }
    for (const url of photos) {
      if (
        typeof url !== 'string' ||
        url.length > MAX_PHOTO_URL_LENGTH ||
        !/^https:\/\/res\.cloudinary\.com\//.test(url)
      ) {
        return res.status(400).json({ error: 'Invalid photo URL' });
      }
    }
  }

  // ── Avatar/logo: single hosted image URL, same trust model as `photos`
  //    (uploaded client-side to Cloudinary; we only store the resulting
  //    URL). Kept as its own field, separate from the 6-slot gallery, so
  //    uploading a logo never consumes one of the doctor's gallery slots.
  if (avatarUrl !== undefined && avatarUrl !== null) {
    if (
      typeof avatarUrl !== 'string' ||
      avatarUrl.length > MAX_PHOTO_URL_LENGTH ||
      !/^https:\/\/res\.cloudinary\.com\//.test(avatarUrl)
    ) {
      return res.status(400).json({ error: 'Invalid avatar URL' });
    }
  }

  // ── 3. Save to Firestore ─────────────────────────────────────────────────
  // 🔒 BUG FIX (kept from earlier fix): the previous version always wrote
  // every field, falling back to `null` for anything not included in this
  // request — e.g. saving just {specialty, bio} from the AI flow would
  // silently overwrite phone, whatsapp, address, clinicName, and links to
  // null, DESTROYING any data saved earlier through a different flow.
  // `merge: true` only protects fields that are absent from the object
  // being written — it does nothing if we hand it every key as `null`.
  // The fix: only include a key in the update object when the caller
  // actually sent it, so untouched fields are left exactly as they were
  // in Firestore. Every new field below follows the same pattern.
  const updates = { updatedAt: new Date().toISOString() };
  if (clinicName !== undefined) updates.clinicName = clinicName || null;
  if (doctorName !== undefined) updates.doctorName = doctorName || null;
  if (specialty !== undefined) updates.specialty = specialty || null;
  if (bio !== undefined) updates.bio = bio || null;
  if (phone !== undefined) updates.phone = phone || null;
  if (whatsapp !== undefined) updates.whatsapp = whatsapp || null;
  if (address !== undefined) updates.address = address || null;
  if (services !== undefined) updates.services = services || [];
  if (links !== undefined) updates.links = links || {};
  if (lat !== undefined) updates.lat = lat;
  if (lng !== undefined) updates.lng = lng;
  if (bookingEnabled !== undefined) updates.bookingEnabled = bookingEnabled;
  if (consultationPrice !== undefined) updates.consultationPrice = consultationPrice;
  if (photos !== undefined) updates.photos = photos;
  if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl || null;
  if (isPublished !== undefined) updates.isPublished = isPublished;

  try {
    const clinicRef = db.collection('clinics').doc(doctorUid);

    await clinicRef.set(updates, { merge: true });

    return res.status(200).json({ success: true, clinicId: doctorUid });

  } catch (err) {
    console.error('[clinic-save] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to save clinic profile' });
  }
}
