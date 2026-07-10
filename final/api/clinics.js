// ─────────────────────────────────────────────────────────────────────────
// api/clinics.js
//
// MERGED endpoint — combines the previous clinics-list.js, clinic-get.js,
// and clinic-save.js into a single Serverless Function to stay under
// Vercel Hobby's 12-function limit. Routing is done by method + query:
//
//   GET  /api/clinics                 -> list published clinics (public)
//   GET  /api/clinics?doctorId=<uid>  -> get one clinic profile
//   POST /api/clinics                 -> save/update clinic (auth required)
//
// Behavior of each branch is unchanged from the original files.
// ─────────────────────────────────────────────────────────────────────────

import { db, verifyDoctorToken } from './_lib/firebaseAdmin.js';
import { setCors } from './_lib/cors.js';
import { checkRateLimit, getClientIp } from './_lib/rateLimit.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 60;
const MAX_REQUESTS_PER_WINDOW = 30;
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const MAX_PHOTOS = 6;
const MAX_PHOTO_URL_LENGTH = 500;
const MAX_CONSULTATION_PRICE = 1000000;
const ALLOWED_SLOT_DURATIONS = [15, 30, 45, 60];

export default async function handler(req, res) {
  setCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    if (req.query.doctorId) {
      return handleClinicGet(req, res);
    }
    return handleClinicsList(req, res);
  }

  if (req.method === 'POST') {
    return handleClinicSave(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── GET /api/clinics (list published clinics) ──────────────────────────────
async function handleClinicsList(req, res) {
  const ip = getClientIp(req);
  const allowed = await checkRateLimit('clinics-list', ip, MAX_REQUESTS_PER_WINDOW, WINDOW_MS);
  if (!allowed) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  try {
    const snapshot = await db
      .collection('clinics')
      .where('isPublished', '==', true)
      .limit(limit)
      .get();

    const clinics = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        doctorId: doc.id,
        clinicName: data.clinicName || null,
        doctorName: data.doctorName || null,
        specialty: data.specialty || null,
        bio: data.bio || null,
        address: data.address || null,
        services: Array.isArray(data.services) ? data.services : [],
        photo: Array.isArray(data.photos) && data.photos.length > 0 ? data.photos[0] : null,
      };
    });

    return res.status(200).json({ clinics });

  } catch (err) {
    console.error('[clinics-list] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to fetch clinics' });
  }
}

// ── GET /api/clinics?doctorId=... (single clinic profile) ──────────────────
async function handleClinicGet(req, res) {
  const { doctorId } = req.query;

  if (!doctorId || typeof doctorId !== 'string') {
    return res.status(400).json({ error: 'Missing doctorId parameter' });
  }

  let isOwner = false;
  try {
    const decoded = await verifyDoctorToken(req);
    isOwner = decoded.uid === doctorId;
  } catch (err) {
    isOwner = false;
  }

  try {
    const clinicRef = db.collection('clinics').doc(doctorId);
    const snapshot = await clinicRef.get();

    if (!snapshot.exists) {
      return res.status(404).json({ error: 'Clinic not found' });
    }

    const data = snapshot.data();

    return res.status(200).json({
      doctorId,
      clinicName: data.clinicName || null,
      doctorName: data.doctorName || null,
      specialty: data.specialty || null,
      bio: data.bio || null,
      phone: data.phone || null,
      whatsapp: data.whatsapp || null,
      address: data.address || null,
      services: data.services || [],
      links: data.links || {},
      lat: typeof data.lat === 'number' ? data.lat : null,
      lng: typeof data.lng === 'number' ? data.lng : null,
      bookingEnabled: data.bookingEnabled !== false,
      consultationPrice: typeof data.consultationPrice === 'number' ? data.consultationPrice : null,
      photos: Array.isArray(data.photos) ? data.photos : [],
      avatarUrl: data.avatarUrl || null,
      isPublished: data.isPublished === true,
      ratingAverage: data.ratingAverage || 0,
      ratingCount: data.ratingCount || 0,
      slotDurationMinutes: data.slotDurationMinutes || null,
      masterTemplate: data.masterTemplate
        ? (isOwner
            ? data.masterTemplate
            : { locked: data.masterTemplate.locked === true })
        : null,
      updatedAt: data.updatedAt || null,
    });

  } catch (err) {
    console.error('[clinic-get] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to fetch clinic profile' });
  }
}

// ── POST /api/clinics (save/update clinic, auth required) ──────────────────
async function handleClinicSave(req, res) {
  let decodedToken;
  try {
    decodedToken = await verifyDoctorToken(req);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing login token' });
  }

  const doctorUid = decodedToken.uid;

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
    slotDurationMinutes,
  } = req.body || {};

  if (bio && bio.length > 2000) {
    return res.status(400).json({ error: 'Bio too long (max 2000 characters)' });
  }
  if (services && (!Array.isArray(services) || services.length > 30)) {
    return res.status(400).json({ error: 'Invalid services list' });
  }

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

  if (bookingEnabled !== undefined && typeof bookingEnabled !== 'boolean') {
    return res.status(400).json({ error: 'bookingEnabled must be true or false' });
  }

  if (isPublished !== undefined && typeof isPublished !== 'boolean') {
    return res.status(400).json({ error: 'isPublished must be true or false' });
  }

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

  if (avatarUrl !== undefined && avatarUrl !== null) {
    if (
      typeof avatarUrl !== 'string' ||
      avatarUrl.length > MAX_PHOTO_URL_LENGTH ||
      !/^https:\/\/res\.cloudinary\.com\//.test(avatarUrl)
    ) {
      return res.status(400).json({ error: 'Invalid avatar URL' });
    }
  }

  if (slotDurationMinutes !== undefined && slotDurationMinutes !== null) {
    if (!ALLOWED_SLOT_DURATIONS.includes(slotDurationMinutes)) {
      return res.status(400).json({ error: 'slotDurationMinutes must be one of 15, 30, 45, 60' });
    }
  }

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

    if (slotDurationMinutes !== undefined) {
      const clinicSnap = await clinicRef.get();
      const existingTemplate = clinicSnap.exists ? clinicSnap.data().masterTemplate : null;
      if (existingTemplate?.locked === true) {
        return res.status(409).json({
          error: 'Cannot change slot duration while the weekly schedule is locked. Unlock it first.',
        });
      }
      updates.slotDurationMinutes = slotDurationMinutes;
    }

    await clinicRef.set(updates, { merge: true });

    return res.status(200).json({ success: true, clinicId: doctorUid });

  } catch (err) {
    console.error('[clinic-save] Firestore error:', err);
    return res.status(500).json({ error: 'Failed to save clinic profile' });
  }
}
