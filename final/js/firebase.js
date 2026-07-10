// ─────────────────────────────────────────────────────────────────────────
// js/firebase.js
// Single shared Firebase client initialization.
// Every page imports { auth, app } from here instead of re-declaring
// firebaseConfig — avoids "app already initialized" errors and keeps
// config in ONE place.
//
// Note: this apiKey is a public client identifier, not a secret — it's
// safe to ship in frontend code. Actual protection comes from Firestore
// Security Rules + the backend's verifyDoctorToken() (see api/_lib/firebaseAdmin.js).
// ─────────────────────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAnalytics, isSupported as analyticsIsSupported } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAkktk_1PMCrWcaN52LeA9Iae8TcLxeNo4",
  authDomain: "mid6-59c85.firebaseapp.com",
  databaseURL: "https://mid6-59c85-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "mid6-59c85",
  storageBucket: "mid6-59c85.firebasestorage.app",
  messagingSenderId: "712594584760",
  appId: "1:712594584760:web:3702a07e4c9b2147f9b04d",
  measurementId: "G-SBE0279RGJ",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// ── Force LOCAL persistence explicitly ──────────────────────────────────
// Without this, some browsers (Brave with Shields, Safari ITP, private/
// incognito windows) fall back to session-only or in-memory persistence,
// which silently logs the doctor out every time they close the tab.
// If persistence itself fails (storage fully blocked), we surface a clear
// warning instead of a mysterious repeated sign-in loop.
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.error(
    '[Firebase] Could not set local persistence — the browser may be blocking storage ' +
    '(e.g. Brave Shields, private browsing, or 3rd-party cookie blocking). ' +
    'The doctor will be signed out on every page reload.',
    err
  );
});

// Analytics only works in a real browser with a supported environment
// (fails silently in some contexts, e.g. private browsing) — guard it.
export let analytics = null;
analyticsIsSupported().then((supported) => {
  if (supported) analytics = getAnalytics(app);
});

const googleProvider = new GoogleAuthProvider();

/**
 * Sign in with Google popup.
 * First-time sign-in auto-creates the Firebase user record.
 * Returns the Firebase user on success, throws on failure/cancel.
 */
export async function signInWithGoogle() {
  const { user } = await signInWithPopup(auth, googleProvider);
  return user;
}

/**
 * Sign in an EXISTING account with email/password.
 * (No sign-up flow — accounts are created via Google or manually.)
 */
export async function signInWithEmail(email, password) {
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  return user;
}

/**
 * Send a password reset email.
 */
export async function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

/**
 * Sign the current user out.
 */
export async function signOutDoctor() {
  return signOut(auth);
}

/**
 * Convenience re-export so pages don't need a second Firebase import
 * just to watch auth state.
 */
export { onAuthStateChanged };

/**
 * Maps common Firebase Auth error codes to i18n-friendly keys
 * (see auth_error_invalid / auth_error_generic in js/i18n.js).
 */
export function mapAuthError(err) {
  const code = err?.code || '';
  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found' ||
    code === 'auth/invalid-email'
  ) {
    return 'auth_error_invalid';
  }
  return 'auth_error_generic';
}
