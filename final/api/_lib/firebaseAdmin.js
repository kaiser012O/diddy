// ─────────────────────────────────────────────────────────────────────────
// api/_lib/firebaseAdmin.js
//
// Shared Firebase Admin initialization.
// Every API function that needs Firestore or needs to verify a doctor's
// login token imports { db, auth } from this file — never initializes
// Firebase directly itself. This avoids "app already initialized" errors
// and keeps credentials in ONE place.
//
// Required Vercel Environment Variables (Project Settings → Environment Variables):
//   FIREBASE_PROJECT_ID     = mid6-59c85
//   FIREBASE_CLIENT_EMAIL   = (from the service account JSON, "client_email")
//   FIREBASE_PRIVATE_KEY    = (from the service account JSON, "private_key")
//
// How to get these values:
//   Firebase Console → Project Settings → Service Accounts →
//   "Generate new private key" → downloads a JSON file with these fields.
// ─────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

function initFirebaseAdmin() {
  // Prevent re-initializing on every function call (Vercel reuses warm instances)
  if (getApps().length > 0) {
    return getApps()[0];
  }

  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
  });
}

const app = initFirebaseAdmin();

export const db = getFirestore(app);
export const auth = getAuth(app);

// ─────────────────────────────────────────────────────────────────────────
// Helper: verify the Firebase ID token sent from the frontend
// (the doctor's dashboard sends this in the Authorization header)
// Returns the decoded token (contains uid, email, etc.) or throws.
// ─────────────────────────────────────────────────────────────────────────
export async function verifyDoctorToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    throw new Error('Missing Authorization token');
  }

  const decoded = await auth.verifyIdToken(token);
  return decoded; // decoded.uid is the doctor's unique ID
}
