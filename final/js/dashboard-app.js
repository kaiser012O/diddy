// ─────────────────────────────────────────────────────────────────────────
// js/dashboard-app.js
//
// Doctor Dashboard — profile, bookings, and work-hours logic.
// Every piece of data on this page comes from a real API call:
//   - Profile        → GET  /api/clinics?doctorId={uid}
//   - Bookings       → GET  /api/bookings?date={date}   (auth required)
//   - Cancel booking → POST /api/bookings  { action: "cancel", ... }  (auth required)
//   - Open slots     → GET  /api/availability?doctorId={uid}&date={date}
//   - Save slots     → POST /api/availability             (auth required)
//
// No mock/sample data anywhere in this file.
// ─────────────────────────────────────────────────────────────────────────

import { auth } from './firebase.js';

const REFRESH_INTERVAL_MS = 15000; // polling cadence for "near real-time" updates
const SLOT_START_HOUR = 8;
const SLOT_END_HOUR = 20; // exclusive
const DEFAULT_SLOT_DURATION_MIN = 30;
const ALLOWED_SLOT_DURATIONS = [15, 30, 45, 60];
const BOOKING_WINDOW_DAYS = 60;

// ─────────────────────────────────────────────────────────────────────────
// 🔗 CLOUDINARY WIRING POINT — replace these two placeholders once the
// Cloudinary account exists (Settings → Upload → add an UNSIGNED preset).
// Until they're replaced, the photo upload UI shows a clear message
// instead of silently failing.
// ─────────────────────────────────────────────────────────────────────────
const CLOUDINARY_CLOUD_NAME = 'kygdjw7o';
const CLOUDINARY_UPLOAD_PRESET = 'my_website_preset';
const CLOUDINARY_CONFIGURED = CLOUDINARY_CLOUD_NAME !== 'YOUR_CLOUD_NAME' && CLOUDINARY_UPLOAD_PRESET !== 'YOUR_UPLOAD_PRESET';

const MAX_PHOTOS = 6;
const MAX_PHOTO_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAP_CENTER = [36.7538, 3.0588]; // Algiers — used only when the doctor hasn't set a location yet

const state = {
  doctorUid: null,
  bookingsDate: todayISO(),
  availDate: todayISO(),
  bookings: [],       // bookings for state.bookingsDate
  bookingsForAvailDate: [], // bookings for state.availDate (to mark booked slots)
  openSlots: [],       // doctor's open slots for state.availDate
  profile: null,
  loadingBookings: false,
  loadingAvailability: false,
  // Clinic form working copy
  formServices: [],
  formPhotos: [],
  formAvatarUrl: null,
  formLat: null,
  formLng: null,
  // Slot duration + master weekly template
  slotDurationMinutes: DEFAULT_SLOT_DURATION_MIN,
  masterTemplate: null,       // { locked, weekly: {0:[...],...,6:[...]}, slotDurationMinutes, updatedAt } or null
  templateEditWeekly: null,   // working copy of `weekly` while unlocked (edit mode)
  exceptions: [],             // exceptions for state.availDate (times cancelled just for that day)
  dayCancelled: false,        // whether state.availDate is cancelled entirely
};

let pollHandle = null;
let clinicMap = null;
let clinicMarker = null;

// ── Helpers ─────────────────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getAuthHeader() {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

function generateSlotTimes(stepMin = state.slotDurationMinutes || DEFAULT_SLOT_DURATION_MIN) {
  const times = [];
  for (let h = SLOT_START_HOUR; h < SLOT_END_HOUR; h++) {
    for (let m = 0; m < 60; m += stepMin) {
      times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return times;
}

// Local-date-safe day-of-week (0=Sun..6=Sat) for a "YYYY-MM-DD" string —
// must match dayOfWeekFromDateString() in api/_lib/availabilityResolver.js
// exactly, or the dashboard and server would compute different weekdays
// for the same date near timezone edges.
function dayOfWeekFromDateString(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function isWithinBookingWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + BOOKING_WINDOW_DAYS);
  return target >= today && target <= maxDate;
}

function relativeTimeAr(isoString) {
  if (!isoString) return '—';
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'الآن';
  if (minutes < 60) return `منذ ${minutes} دقيقة`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `منذ ${hours} ${hours === 1 ? 'ساعة' : 'ساعات'}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `منذ ${days} ${days === 1 ? 'يوم' : 'أيام'}`;
  return new Date(isoString).toLocaleDateString('ar');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

const STAR_PATH = '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>';

function buildStarsHtml(score, size = 13) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const filled = i <= Math.round(score);
    html += `<svg width="${size}" height="${size}" viewBox="0 0 24 24" class="${filled ? 'star-filled' : 'star-empty'}" stroke="currentColor" stroke-width="1.5">${STAR_PATH}</svg>`;
  }
  return html;
}

function toast(message, isError = false) {
  let el = document.getElementById('dash-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dash-toast';
    el.className = 'save-toast';
    document.body.appendChild(el);
  }
  el.style.background = isError ? '#e0584b' : '';
  el.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      ${isError ? '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>' : '<path d="M20 6L9 17l-5-5"/>'}
    </svg>
    <span>${escapeHtml(message)}</span>
  `;
  el.classList.add('visible');
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => el.classList.remove('visible'), 2600);
}

// ── Profile ─────────────────────────────────────────────────────────────

async function loadProfile() {
  const container = document.getElementById('profile-hero');
  if (!container || !state.doctorUid) return;

  try {
    // 🔒 Send the doctor's own auth header so the backend recognizes this
    // as an owner request and includes the full masterTemplate.weekly
    // contents (see clinic-get.js) — without this, an anonymous-looking
    // request would only get back { locked: true/false }, and the
    // dashboard's schedule-settings card would appear empty even though a
    // template exists.
    const headersForGet = await getAuthHeader();
    const res = await fetch(`/api/clinics?doctorId=${encodeURIComponent(state.doctorUid)}`, { headers: headersForGet });
    if (res.status === 404) {
      state.profile = null;
      updateRatingStat(0, 0);
      renderEmptyProfile(container);
      populateClinicForm(null);
      updateHeroFromProfile(null);
      return;
    }
    if (!res.ok) throw new Error('clinic-get failed');

    const data = await res.json();
    state.profile = data;
    updateRatingStat(data.ratingAverage, data.ratingCount);
    state.slotDurationMinutes = ALLOWED_SLOT_DURATIONS.includes(data.slotDurationMinutes)
      ? data.slotDurationMinutes
      : DEFAULT_SLOT_DURATION_MIN;
    state.masterTemplate = data.masterTemplate || null;
    state.templateEditWeekly = state.masterTemplate && !state.masterTemplate.locked
      ? state.masterTemplate.weekly
      : null;

    if (!data.doctorName && !data.specialty && !data.bio) {
      renderEmptyProfile(container);
    } else {
      renderProfile(container, data);
    }
    populateClinicForm(data);
    updateHeroFromProfile(data);
    renderScheduleCard();
  } catch (err) {
    console.error('[dashboard] loadProfile failed:', err);
    renderEmptyProfile(container);
    populateClinicForm(null);
    updateHeroFromProfile(null);
  }
}

function renderEmptyProfile(container) {
  container.innerHTML = `
    <div class="profile-hero-avatar">${renderAvatarInner((auth.currentUser?.displayName || 'د').charAt(0))}</div>
    <div class="profile-hero-body">
      <div class="profile-hero-name">${escapeHtml(auth.currentUser?.displayName || auth.currentUser?.email || 'مرحباً بك')}</div>
      <p class="profile-hero-empty">
        لسه ما أكملتش ملفك المهني. استخدم <a href="#search-input" id="scroll-to-ai-link">مساعد الذكاء الاصطناعي</a> فوق لتوليد بروفايلك في ثواني، أو اكتبه يدوياً.
      </p>
    </div>
  `;
  document.getElementById('scroll-to-ai-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('search-input')?.focus();
    document.getElementById('search-input')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  wireAvatarUploadButton();
}

function renderProfile(container, data) {
  const name = data.doctorName || auth.currentUser?.displayName || 'الطبيب';
  const initial = name.charAt(0);
  state.formAvatarUrl = data.avatarUrl || null;
  const tagsHtml = (data.services || [])
    .slice(0, 6)
    .map(s => `<span class="profile-hero-tag">#${escapeHtml(s)}</span>`)
    .join('');

  container.innerHTML = `
    <div class="profile-hero-avatar">${renderAvatarInner(initial)}</div>
    <div class="profile-hero-body">
      <div class="profile-hero-name-row">
        <span class="profile-hero-name">${escapeHtml(name)}</span>
        ${data.specialty ? `<span class="profile-hero-specialty">${escapeHtml(data.specialty)}</span>` : ''}
      </div>
      ${data.bio ? `<p class="profile-hero-bio">${escapeHtml(data.bio)}</p>` : ''}
      ${tagsHtml ? `<div class="profile-hero-tags">${tagsHtml}</div>` : ''}
    </div>
  `;
  wireAvatarUploadButton();
}

// ── Avatar/logo (Cloudinary — shares the upload mechanism used for clinic
//    photos, but is stored as its own `avatarUrl` field, separate from the
//    6-slot gallery, so it never eats one of the doctor's gallery slots) ──

function renderAvatarInner(initial) {
  const imgHtml = state.formAvatarUrl
    ? `<img src="${escapeHtml(state.formAvatarUrl)}" alt="">`
    : escapeHtml(initial);
  return `
    ${imgHtml}
    <button type="button" class="avatar-upload-btn" id="avatar-upload-trigger" aria-label="تحميل صورة/شعار العيادة">+</button>
  `;
}

function wireAvatarUploadButton() {
  document.getElementById('avatar-upload-trigger')?.addEventListener('click', () => {
    document.getElementById('avatar-upload-input')?.click();
  });
}

async function handleAvatarFileSelected(file) {
  if (!file) return;
  if (!CLOUDINARY_CONFIGURED) {
    toast('ميزة رفع الصور غير مفعّلة بعد — بانتظار إعداد حساب التخزين', true);
    return;
  }
  if (!file.type.startsWith('image/')) {
    toast('نوع الملف غير مدعوم — صور فقط', true);
    return;
  }
  if (file.size > MAX_PHOTO_SIZE_BYTES) {
    toast('حجم الصورة كبير جداً (الحد الأقصى 5MB)', true);
    return;
  }

  const btn = document.getElementById('avatar-upload-trigger');
  btn?.classList.add('uploading');

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();

    if (!res.ok || !data.secure_url) {
      throw new Error(data?.error?.message || 'فشل رفع الصورة');
    }

    state.formAvatarUrl = data.secure_url;

    // Persist immediately so refreshing the page (or the public clinic
    // page / homepage card) reflects the new avatar right away, without
    // waiting for the doctor to hit the separate "save" button below.
    const headers = await getAuthHeader();
    const saveRes = await fetch('/api/clinics', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarUrl: state.formAvatarUrl }),
    });
    if (!saveRes.ok) throw new Error('فشل حفظ الصورة');

    const container = document.getElementById('profile-hero');
    const avatarEl = container?.querySelector('.profile-hero-avatar');
    if (avatarEl) {
      const name = state.profile?.doctorName || auth.currentUser?.displayName || 'الطبيب';
      avatarEl.innerHTML = renderAvatarInner(name.charAt(0));
      wireAvatarUploadButton();
    }
    toast('تم تحديث الصورة');
  } catch (err) {
    console.error('[dashboard] avatar upload failed:', err);
    toast(err.message || 'تعذر رفع الصورة', true);
  } finally {
    document.getElementById('avatar-upload-trigger')?.classList.remove('uploading');
  }
}

// ── Hero side cards ─────────────────────────────────────────────────────
// Independent of whatever date the doctor has selected further down the
// page — these always reflect TODAY specifically, plus the profile's
// booking status and last-saved time.

async function loadHeroSummary() {
  if (!state.doctorUid) return;
  const today = todayISO();

  try {
    const [bookingsRes, availRes] = await Promise.all([
      getAuthHeader().then(headers => fetch(`/api/bookings?date=${encodeURIComponent(today)}`, { headers })),
      fetch(`/api/availability?doctorId=${encodeURIComponent(state.doctorUid)}&date=${encodeURIComponent(today)}`),
    ]);

    const bookingsTodayEl = document.getElementById('hero-bookings-today');
    if (bookingsRes.ok && bookingsTodayEl) {
      const data = await bookingsRes.json();
      const count = (data.bookings || []).filter(b => b.status !== 'cancelled').length;
      bookingsTodayEl.textContent = `${count} ${count === 1 ? 'موعد' : 'مواعيد'}`;
    }

    const availableTodayEl = document.getElementById('hero-available-today');
    if (availRes.ok && availableTodayEl) {
      const data = await availRes.json();
      availableTodayEl.textContent = `${(data.openSlots || []).length} فترة`;
    }
  } catch (err) {
    console.error('[dashboard] loadHeroSummary failed:', err);
  }
}

function updateHeroFromProfile(data) {
  const statusEl = document.getElementById('hero-booking-status');
  const updateEl = document.getElementById('hero-last-update');

  if (statusEl) {
    const enabled = data ? data.bookingEnabled !== false : true;
    statusEl.textContent = enabled ? '● مفعّل' : '● متوقف';
    statusEl.classList.toggle('status-on', enabled);
    statusEl.classList.toggle('status-off', !enabled);
  }
  if (updateEl) {
    updateEl.textContent = data?.updatedAt ? relativeTimeAr(data.updatedAt) : 'لم يُحفظ بعد';
  }
}

// ── Clinic info form ────────────────────────────────────────────────────

function populateClinicForm(data) {
  const d = data || {};
  setVal('f-doctorName', d.doctorName);
  setVal('f-specialty', d.specialty);
  setVal('f-clinicName', d.clinicName);
  setVal('f-bio', d.bio);
  setVal('f-phone', d.phone);
  setVal('f-whatsapp', d.whatsapp);
  setVal('f-address', d.address);
  setVal('f-price', d.consultationPrice);

  const bookingToggle = document.getElementById('f-bookingEnabled');
  if (bookingToggle) bookingToggle.checked = d.bookingEnabled !== false;

  updatePublishUI(d.isPublished === true);

  state.formServices = Array.isArray(d.services) ? [...d.services] : [];
  renderServicesEditor();

  state.formPhotos = Array.isArray(d.photos) ? [...d.photos] : [];
  renderPhotosStrip();

  state.formLat = typeof d.lat === 'number' ? d.lat : null;
  state.formLng = typeof d.lng === 'number' ? d.lng : null;
  placeMapMarker(state.formLat, state.formLng);
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? '';
}

// ── Publish toggle ──────────────────────────────────────────────────────
// This is the actual mechanism behind "does this clinic show up on the
// public homepage" — see api/clinics-list.js. Saves immediately on toggle,
// same instant-save pattern as work hours, since a doctor flipping this
// switch expects it to take effect right away, not after a separate
// "حفظ التغييرات" click further down the form.

function updatePublishUI(isPublished) {
  const label = document.getElementById('publish-status-label');
  const linkRow = document.getElementById('publish-link-row');
  const previewLink = document.getElementById('publish-preview-link');
  const toggle = document.getElementById('f-isPublished');

  if (toggle) toggle.checked = isPublished;
  if (label) label.textContent = isPublished ? 'منشورة' : 'غير منشورة';

  if (isPublished && state.doctorUid) {
    const url = `${window.location.origin}/clinic.html?doctorId=${state.doctorUid}`;
    if (previewLink) previewLink.href = url;
    if (linkRow) linkRow.style.display = 'flex';
  } else if (linkRow) {
    linkRow.style.display = 'none';
  }
}

async function togglePublish(newValue) {
  const toggle = document.getElementById('f-isPublished');
  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/clinics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ isPublished: newValue }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل الحفظ');

    updatePublishUI(newValue);
    toast(newValue ? 'أصبحت عيادتك منشورة الآن للمرضى' : 'تم إلغاء نشر عيادتك');
  } catch (err) {
    console.error('[dashboard] togglePublish failed:', err);
    toast(err.message || 'تعذر تحديث حالة النشر', true);
    if (toggle) toggle.checked = !newValue; // revert the switch visually
  }
}

// ── Services chips editor ──────────────────────────────────────────────

function renderServicesEditor() {
  const container = document.getElementById('services-editor');
  if (!container) return;

  const chipsHtml = state.formServices.map((s, i) => `
    <span class="chip-editable" data-idx="${i}">
      ${escapeHtml(s)}
      <button type="button" data-remove-service="${i}" aria-label="حذف">×</button>
    </span>
  `).join('');

  container.innerHTML = `
    ${chipsHtml}
    <span class="chip-add-input">
      <input type="text" id="new-service-input" placeholder="أضف خدمة..." maxlength="60">
      <button type="button" id="add-service-btn" aria-label="إضافة">+</button>
    </span>
  `;

  container.querySelectorAll('[data-remove-service]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.removeService, 10);
      state.formServices.splice(idx, 1);
      renderServicesEditor();
    });
  });

  const addBtn = document.getElementById('add-service-btn');
  const addInput = document.getElementById('new-service-input');
  const addService = () => {
    const val = addInput.value.trim();
    if (!val) return;
    if (state.formServices.length >= 30) {
      toast('وصلت للحد الأقصى من الخدمات (30)', true);
      return;
    }
    state.formServices.push(val);
    renderServicesEditor();
    document.getElementById('new-service-input')?.focus();
  };
  addBtn?.addEventListener('click', addService);
  addInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addService(); }
  });
}

// ── Map (Leaflet — free, no API key) ───────────────────────────────────

let leafletLoadPromise = null;

// 🔒 PERF FIX: Leaflet used to be loaded synchronously in dashboard.html's
// <head> on every single dashboard visit — ~150KB of render-blocking
// CSS+JS for a map that lives far down the page and that most page loads
// never even scroll to. Loading it on demand (via IntersectionObserver,
// wired up in initDashboardApp) removes that cost entirely for the common
// case, and only pays it the moment the map is actually about to be seen.
function loadLeaflet() {
  if (leafletLoadPromise) return leafletLoadPromise;

  leafletLoadPromise = new Promise((resolve, reject) => {
    if (typeof window.L !== 'undefined') { resolve(); return; }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    link.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
    link.crossOrigin = '';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
    script.crossOrigin = '';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load map library'));
    document.head.appendChild(script);
  });

  return leafletLoadPromise;
}

function initClinicMap() {
  const mapEl = document.getElementById('clinic-map');
  if (!mapEl || typeof window.L === 'undefined' || clinicMap) return;

  const center = [
    state.formLat ?? DEFAULT_MAP_CENTER[0],
    state.formLng ?? DEFAULT_MAP_CENTER[1],
  ];
  const zoom = state.formLat !== null ? 15 : 6;

  clinicMap = window.L.map('clinic-map').setView(center, zoom);

  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(clinicMap);

  clinicMap.on('click', (e) => {
    state.formLat = e.latlng.lat;
    state.formLng = e.latlng.lng;
    placeMapMarker(state.formLat, state.formLng);
  });
}

function placeMapMarker(lat, lng) {
  if (!clinicMap) return;

  if (lat === null || lng === null) return;

  if (clinicMarker) {
    clinicMarker.setLatLng([lat, lng]);
  } else {
    clinicMarker = window.L.marker([lat, lng], { draggable: true }).addTo(clinicMap);
    clinicMarker.on('dragend', () => {
      const pos = clinicMarker.getLatLng();
      state.formLat = pos.lat;
      state.formLng = pos.lng;
    });
  }
  clinicMap.setView([lat, lng], Math.max(clinicMap.getZoom(), 15));
}

// ── Clinic photos (Cloudinary — free, unsigned client-side upload) ─────

function renderPhotosStrip() {
  const strip = document.getElementById('clinic-photos-strip');
  if (!strip) return;

  const thumbsHtml = state.formPhotos.map((url, i) => `
    <div class="photo-thumb">
      <img src="${escapeHtml(url)}" alt="صورة العيادة">
      <button type="button" data-remove-photo="${i}" aria-label="حذف الصورة">×</button>
    </div>
  `).join('');

  const canAddMore = state.formPhotos.length < MAX_PHOTOS;
  const addBtnHtml = canAddMore ? `
    <button type="button" class="photo-add-btn" id="photo-add-trigger">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
      <span>إضافة صورة</span>
    </button>
  ` : '';

  strip.innerHTML = thumbsHtml + addBtnHtml;

  strip.querySelectorAll('[data-remove-photo]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.removePhoto, 10);
      state.formPhotos.splice(idx, 1);
      renderPhotosStrip();
    });
  });

  document.getElementById('photo-add-trigger')?.addEventListener('click', () => {
    document.getElementById('clinic-photos-input')?.click();
  });
}

async function handlePhotoFilesSelected(fileList) {
  if (!CLOUDINARY_CONFIGURED) {
    toast('ميزة رفع الصور غير مفعّلة بعد — بانتظار إعداد حساب التخزين', true);
    return;
  }

  const files = Array.from(fileList || []);
  const remainingSlots = MAX_PHOTOS - state.formPhotos.length;
  if (remainingSlots <= 0) {
    toast(`وصلت للحد الأقصى (${MAX_PHOTOS} صور)`, true);
    return;
  }

  for (const file of files.slice(0, remainingSlots)) {
    if (!file.type.startsWith('image/')) {
      toast('نوع الملف غير مدعوم — صور فقط', true);
      continue;
    }
    if (file.size > MAX_PHOTO_SIZE_BYTES) {
      toast('حجم الصورة كبير جداً (الحد الأقصى 5MB)', true);
      continue;
    }
    await uploadPhotoToCloudinary(file);
  }
}

async function uploadPhotoToCloudinary(file) {
  const strip = document.getElementById('clinic-photos-strip');
  const placeholder = document.createElement('div');
  placeholder.className = 'photo-thumb uploading';
  strip?.insertBefore(placeholder, strip.lastElementChild);

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();

    if (!res.ok || !data.secure_url) {
      throw new Error(data?.error?.message || 'فشل رفع الصورة');
    }

    state.formPhotos.push(data.secure_url);
    renderPhotosStrip();
  } catch (err) {
    console.error('[dashboard] photo upload failed:', err);
    toast(err.message || 'تعذر رفع الصورة', true);
    placeholder.remove();
  }
}

// ── Save clinic form ────────────────────────────────────────────────────

async function saveClinicForm(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-save-clinic-form');
  if (btn) { btn.disabled = true; btn.textContent = 'جاري الحفظ...'; }

  const price = document.getElementById('f-price')?.value;

  const payload = {
    doctorName: document.getElementById('f-doctorName')?.value.trim() || null,
    specialty: document.getElementById('f-specialty')?.value.trim() || null,
    clinicName: document.getElementById('f-clinicName')?.value.trim() || null,
    bio: document.getElementById('f-bio')?.value.trim() || null,
    phone: document.getElementById('f-phone')?.value.trim() || null,
    whatsapp: document.getElementById('f-whatsapp')?.value.trim() || null,
    address: document.getElementById('f-address')?.value.trim() || null,
    services: state.formServices,
    photos: state.formPhotos,
    avatarUrl: state.formAvatarUrl,
    bookingEnabled: !!document.getElementById('f-bookingEnabled')?.checked,
    consultationPrice: price ? Number(price) : null,
  };

  if (state.formLat !== null && state.formLng !== null) {
    payload.lat = state.formLat;
    payload.lng = state.formLng;
  }

  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/clinics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل الحفظ');

    toast('تم حفظ معلومات العيادة بنجاح');
    await loadProfile();
  } catch (err) {
    console.error('[dashboard] saveClinicForm failed:', err);
    toast(err.message || 'تعذر حفظ التغييرات', true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'حفظ التغييرات'; }
  }
}

// ── Bookings ────────────────────────────────────────────────────────────

async function loadBookings(showSpinner = true) {
  const listEl = document.getElementById('bookings-list');
  const refreshBtn = document.getElementById('bookings-refresh-btn');
  if (!listEl) return;

  if (showSpinner) refreshBtn?.classList.add('spinning');
  state.loadingBookings = true;

  try {
    const headers = await getAuthHeader();
    const res = await fetch(`/api/bookings?date=${encodeURIComponent(state.bookingsDate)}`, { headers });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to load bookings');
    }

    const data = await res.json();
    const freshBookings = (data.bookings || []).filter(b => b.status !== 'cancelled');
    freshBookings.sort((a, b) => a.time.localeCompare(b.time));

    // 🔒 PERF FIX: polling used to call renderBookings() — a full
    // innerHTML rebuild of every booking row — every 15 seconds
    // unconditionally, even when nothing had changed. On top of the
    // work-hours grid doing the same, that's two full DOM rebuilds every
    // poll tick, which is a real contributor to scroll jank if a tick
    // lands while the doctor is mid-scroll. A cheap fingerprint comparison
    // skips the rebuild whenever the data is unchanged.
    const fingerprint = JSON.stringify(freshBookings.map(b => [b.id, b.time, b.clientName, b.clientPhone, b.status]));
    const changed = fingerprint !== state._bookingsFingerprint;
    state.bookings = freshBookings;

    if (changed) {
      state._bookingsFingerprint = fingerprint;
      renderBookings();
      renderStats();
    }
  } catch (err) {
    console.error('[dashboard] loadBookings failed:', err);
    listEl.innerHTML = `<div class="error-banner">تعذر تحميل الحجوزات: ${escapeHtml(err.message)}</div>`;
  } finally {
    state.loadingBookings = false;
    refreshBtn?.classList.remove('spinning');
  }
}

function renderBookings() {
  const listEl = document.getElementById('bookings-list');
  const countEl = document.getElementById('bookings-count');
  if (!listEl) return;

  if (countEl) {
    countEl.textContent = state.bookings.length
      ? `${state.bookings.length} ${state.bookings.length === 1 ? 'حجز' : 'حجوزات'}`
      : '';
  }

  if (state.bookings.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state-mini">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
        <p>لا توجد حجوزات في هذا اليوم</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = state.bookings.map(b => {
    const isPast = b.date < todayISO();
    const attendance = b.attendance || 'pending';

    let actionsHtml;
    if (!isPast) {
      actionsHtml = `
        <span class="status-pill">مؤكد</span>
        <button class="btn-cancel" data-cancel-id="${escapeHtml(b.id)}" data-date="${escapeHtml(b.date)}" data-time="${escapeHtml(b.time)}">إلغاء</button>
      `;
    } else if (attendance === 'attended') {
      actionsHtml = `<span class="status-pill">✓ حضر</span>`;
    } else if (attendance === 'no_show') {
      actionsHtml = `<span class="status-pill status-pill-noshow">✗ لم يحضر</span>`;
    } else {
      // Past appointment, doctor hasn't confirmed attendance yet — this is
      // exactly what gates the automatic rating-request WhatsApp message
      // (see api/cron-send-rating-requests.js), so make it easy to resolve.
      actionsHtml = `
        <button class="btn-attendance btn-attended" data-attendance-id="${escapeHtml(b.id)}" data-value="attended">✓ حضر</button>
        <button class="btn-attendance btn-noshow" data-attendance-id="${escapeHtml(b.id)}" data-value="no_show">✗ لم يحضر</button>
      `;
    }

    return `
      <div class="booking-row" data-booking-id="${escapeHtml(b.id)}">
        <div class="booking-left">
          <span class="booking-time-badge">${escapeHtml(b.time)}</span>
          <div class="booking-info">
            <div class="name">${escapeHtml(b.clientName || 'بدون اسم')}</div>
            <div class="phone">${escapeHtml(b.clientPhone || '')}</div>
          </div>
        </div>
        <div class="booking-actions">${actionsHtml}</div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('[data-cancel-id]').forEach(btn => {
    btn.addEventListener('click', () => cancelBooking(btn.dataset.cancelId, btn));
  });

  listEl.querySelectorAll('[data-attendance-id]').forEach(btn => {
    btn.addEventListener('click', () => markAttendance(btn.dataset.attendanceId, btn.dataset.value, btn));
  });
}

async function markAttendance(bookingId, value, btnEl) {
  const row = btnEl.closest('.booking-row');
  const actionsEl = row?.querySelector('.booking-actions');
  if (actionsEl) actionsEl.style.opacity = '.5';

  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ action: 'attendance', doctorId: state.doctorUid, bookingId, attendance: value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل التحديث');

    // Update local state and re-render just this list, no full refetch needed
    const booking = state.bookings.find(b => b.id === bookingId);
    if (booking) booking.attendance = value;
    renderBookings();
    toast(value === 'attended' ? 'تم تعليم الحجز كـ "حضر"' : 'تم تعليم الحجز كـ "لم يحضر"');
  } catch (err) {
    console.error('[dashboard] markAttendance failed:', err);
    toast(err.message || 'تعذر تحديث حالة الحضور', true);
    if (actionsEl) actionsEl.style.opacity = '1';
  }
}

async function cancelBooking(bookingId, btnEl) {
  if (!confirm('هل تريد إلغاء هذا الحجز؟ سيتم إشعار المريض.')) return;

  const row = btnEl.closest('.booking-row');
  row?.classList.add('cancelling');
  btnEl.disabled = true;

  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        action: 'cancel',
        doctorId: state.doctorUid,
        bookingId,
        cancelledBy: 'doctor',
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل إلغاء الحجز');

    toast('تم إلغاء الحجز بنجاح');
    await Promise.all([loadBookings(false), loadAvailability(false)]);
  } catch (err) {
    console.error('[dashboard] cancelBooking failed:', err);
    toast(err.message || 'تعذر إلغاء الحجز', true);
    row?.classList.remove('cancelling');
    btnEl.disabled = false;
  }
}

// ── Stats ───────────────────────────────────────────────────────────────

function renderStats() {
  const totalEl = document.getElementById('stat-total-bookings');
  const selectedEl = document.getElementById('stat-selected-hours');
  const availableEl = document.getElementById('stat-available-hours');

  if (totalEl) totalEl.textContent = String(state.bookings.length);
  if (selectedEl) selectedEl.textContent = String(state.openSlots.length);
  if (availableEl) {
    // openSlots already EXCLUDES booked times (booking-create removes the
    // slot from openSlots), so "available" = openSlots that aren't booked.
    // Subtracting bookedCount again here would double-count them.
    const bookedTimes = new Set(state.bookingsForAvailDate.map(b => b.time));
    const freeCount = state.openSlots.filter(t => !bookedTimes.has(t)).length;
    availableEl.textContent = String(freeCount);
  }
}

function updateRatingStat(average, count) {
  const el = document.getElementById('stat-rating-average');
  if (!el) return;
  el.textContent = count > 0 ? `${average} ★` : '—';
}

async function loadDashboardReviews() {
  const list = document.getElementById('dashboard-reviews-list');
  if (!list || !state.doctorUid) return;

  try {
    const res = await fetch(`/api/ratings?doctorId=${encodeURIComponent(state.doctorUid)}`);
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    const reviews = data.ratings || [];

    if (reviews.length === 0) {
      list.innerHTML = `<div class="empty-state-mini"><p>لا توجد تقييمات بعد.</p></div>`;
      return;
    }

    list.innerHTML = reviews.map(r => `
      <div class="review-card">
        <div class="review-card-head">
          <span class="review-card-name">${escapeHtml(r.clientName || 'مريض')}</span>
          <span class="review-card-date">${escapeHtml((r.createdAt || '').slice(0, 10))}</span>
        </div>
        <div class="review-card-stars">${buildStarsHtml(r.score)}</div>
        ${r.comment ? `<p class="review-card-comment">${escapeHtml(r.comment)}</p>` : ''}
      </div>
    `).join('');
  } catch (err) {
    console.error('[dashboard] loadDashboardReviews failed:', err);
    list.innerHTML = `<div class="error-banner">تعذر تحميل التقييمات.</div>`;
  }
}

// ── Availability (work hours) ──────────────────────────────────────────

async function loadAvailability(showSpinner = true) {
  const gridMorning = document.getElementById('slots-grid-morning');
  const gridAfternoon = document.getElementById('slots-grid-afternoon');
  const refreshBtn = document.getElementById('avail-refresh-btn');
  if (!gridMorning || !gridAfternoon || !state.doctorUid) return;

  // 🔒 BUG FIX: a background poll landing in the middle of the 500ms
  // work-hours save debounce would fetch the server's not-yet-updated
  // openSlots and briefly "undo" a click that was already confirmed
  // on screen, right before the real save caught up on the next tick —
  // a visible flicker. Manual refreshes (showSpinner=true) still always
  // run, since that's an explicit user action.
  if (!showSpinner && isAvailabilitySavePending()) return;

  if (showSpinner) refreshBtn?.classList.add('spinning');
  state.loadingAvailability = true;

  try {
    // Open slots (public endpoint, already resolves legacy vs master
    // template server-side) + bookings for that date (to mark booked
    // slots) + the clinic doc's own availability/{date} sub-fields
    // (exceptions/dayCancelled) so the locked-mode grid can show them.
    // Note: clinicRes/masterTemplate isn't actually consumed in this
    // function (state.masterTemplate is populated by loadProfile()
    // instead) — this fetch was previously unused dead weight. Left as a
    // plain unauthenticated call since nothing here reads its result, but
    // kept out of the destructuring to make that explicit.
    const [availRes, bookingsRes] = await Promise.all([
      fetch(`/api/availability?doctorId=${encodeURIComponent(state.doctorUid)}&date=${encodeURIComponent(state.availDate)}`),
      getAuthHeader().then(headers =>
        fetch(`/api/bookings?date=${encodeURIComponent(state.availDate)}`, { headers })
      ),
    ]);

    if (!availRes.ok) throw new Error('Failed to load availability');
    const availData = await availRes.json();
    const freshOpenSlots = availData.openSlots || [];

    let freshBookingsForDate = [];
    if (bookingsRes.ok) {
      const bookingsData = await bookingsRes.json();
      freshBookingsForDate = (bookingsData.bookings || []).filter(b => b.status !== 'cancelled');
    }

    // exceptions/dayCancelled for this date aren't part of the PUBLIC
    // availability-get response by design (patients don't need to know
    // WHY a slot is closed) — clinic-get returns the doctor's own data,
    // but exceptions live under the availability subcollection, not on
    // the clinic doc itself, so we still need a small dedicated read.
    // Reused resolver logic client-side would duplicate server logic and
    // risk drifting out of sync, so instead we fetch the raw per-day doc
    // via a lightweight authenticated helper.
    let freshExceptions = [];
    let freshDayCancelled = false;
    try {
      const headers = await getAuthHeader();
      const excRes = await fetch(`/api/availability?exceptions=1&date=${encodeURIComponent(state.availDate)}`, { headers });
      if (excRes.ok) {
        const excData = await excRes.json();
        freshExceptions = excData.exceptions || [];
        freshDayCancelled = excData.dayCancelled === true;
      }
    } catch (e) {
      // Non-fatal — grid just won't show exception state until next load.
    }

    // 🔒 PERF FIX: same fingerprint-guarded skip as loadBookings() — avoid
    // rebuilding all ~24 slot buttons every 15s when nothing changed.
    const fingerprint = JSON.stringify([
      freshOpenSlots.slice().sort(),
      freshBookingsForDate.map(b => b.time).sort(),
      freshExceptions.slice().sort(),
      freshDayCancelled,
    ]);
    const changed = fingerprint !== state._availabilityFingerprint;

    state.openSlots = freshOpenSlots;
    state.bookingsForAvailDate = freshBookingsForDate;
    state.exceptions = freshExceptions;
    state.dayCancelled = freshDayCancelled;

    if (changed) {
      state._availabilityFingerprint = fingerprint;
      renderAvailability();
      renderStats();
    }
  } catch (err) {
    console.error('[dashboard] loadAvailability failed:', err);
    toast('تعذر تحميل أوقات العمل', true);
  } finally {
    state.loadingAvailability = false;
    refreshBtn?.classList.remove('spinning');
  }
}

// ── Slot duration + master weekly template ────────────────────────────────

function renderScheduleCard() {
  const select = document.getElementById('slot-duration-select');
  const lockBtn = document.getElementById('template-lock-toggle-btn');
  const statusEl = document.getElementById('template-lock-status');
  if (!select) return;

  const isLocked = state.masterTemplate?.locked === true;

  select.value = String(state.slotDurationMinutes);
  select.disabled = isLocked;

  if (lockBtn) {
    lockBtn.textContent = isLocked
      ? 'فتح الجدول للتعديل'
      : (state.masterTemplate ? 'تثبيت الجدول الدائم' : 'تثبيت الجدول الدائم لأول مرة');
  }
  if (statusEl) {
    statusEl.textContent = isLocked
      ? 'الجدول مُثبَّت — هذه الأوقات متاحة تلقائياً كل أسبوع.'
      : 'وضع التعديل — غيّر المدة والأوقات ثم اضغط "تثبيت" لتفعيلها أسبوعياً.';
    statusEl.classList.toggle('locked', isLocked);
  }

  // Re-render the grid below since whether it's editable/clickable depends
  // on this locked state too.
  renderAvailability();
}

// Changing slot duration is ONLY meaningful (and only allowed server-side)
// while the template is unlocked — the dropdown is disabled while locked,
// but we still guard here in case of any stale event.
async function handleSlotDurationChange(e) {
  const newDuration = parseInt(e.target.value, 10);
  if (state.masterTemplate?.locked === true) {
    toast('افتح الجدول أولاً لتغيير مدة الحصة', true);
    renderScheduleCard();
    return;
  }
  if (!ALLOWED_SLOT_DURATIONS.includes(newDuration)) return;

  state.slotDurationMinutes = newDuration;
  // Immediate visual feedback: rebuild the time grid at the new interval
  // right away, with no page reload — this is purely a local re-render,
  // the actual persistence happens through clinic-save (existing form
  // save flow already includes this field) or when the template is saved.
  renderAvailability();

  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/clinics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ slotDurationMinutes: newDuration }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل الحفظ');
  } catch (err) {
    console.error('[dashboard] slot duration save failed:', err);
    toast(err.message || 'تعذر حفظ مدة الحصة', true);
  }
}

// Builds the `weekly` object for the CURRENT availDate's weekday from
// whatever is presently shown as "selected" (green) in the grid. This is
// deliberately simple: the doctor sets up one representative day per
// weekday while unlocked, and each day they configure updates that
// weekday's entry in the working template copy. Locking saves whichever
// weekdays were configured this way.
function captureCurrentDayIntoTemplateDraft() {
  const dow = String(dayOfWeekFromDateString(state.availDate));
  const draft = { ...(state.templateEditWeekly || state.masterTemplate?.weekly || {}) };
  draft[dow] = [...state.openSlots];
  state.templateEditWeekly = draft;
  return draft;
}

async function handleTemplateLockToggle() {
  const btn = document.getElementById('template-lock-toggle-btn');
  const isLocked = state.masterTemplate?.locked === true;

  if (isLocked) {
    // Unlocking never needs conflict validation — it's always safe to go
    // back to edit mode; conflicts are only checked when LOCKING.
    if (btn) btn.disabled = true;
    try {
      const headers = await getAuthHeader();
      const res = await fetch('/api/master-template-set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ locked: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'فشل فتح الجدول');
      state.masterTemplate = data.masterTemplate;
      state.templateEditWeekly = data.masterTemplate.weekly;
      toast('تم فتح الجدول للتعديل');
      renderScheduleCard();
    } catch (err) {
      console.error('[dashboard] unlock template failed:', err);
      toast(err.message || 'تعذر فتح الجدول', true);
    } finally {
      if (btn) btn.disabled = false;
    }
    return;
  }

  // Locking: build the weekly template from whatever's been configured so
  // far via captureCurrentDayIntoTemplateDraft(), calling it once more now
  // to make sure today's currently-visible grid is included too.
  const weekly = captureCurrentDayIntoTemplateDraft();

  if (btn) btn.disabled = true;
  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/master-template-set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ weekly, slotDurationMinutes: state.slotDurationMinutes, locked: true }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 409 && Array.isArray(data.conflicts) && data.conflicts.length > 0) {
        const list = data.conflicts.slice(0, 5).map(c => `${c.date} ${c.time}`).join('، ');
        toast(`تعارض مع حجوزات قائمة: ${list}${data.conflicts.length > 5 ? '...' : ''}`, true);
      } else {
        toast(data.error || 'تعذر تثبيت الجدول', true);
      }
      return;
    }

    state.masterTemplate = data.masterTemplate;
    state.templateEditWeekly = null;
    toast('تم تثبيت الجدول الدائم بنجاح');
    renderScheduleCard();
    loadAvailability();
  } catch (err) {
    console.error('[dashboard] lock template failed:', err);
    toast(err.message || 'تعذر تثبيت الجدول', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}


  const gridMorning = document.getElementById('slots-grid-morning');
  const gridAfternoon = document.getElementById('slots-grid-afternoon');
  const dayCancelBtn = document.getElementById('day-cancel-btn');
  if (!gridMorning || !gridAfternoon) return;

  const isLocked = state.masterTemplate?.locked === true;
  const bookedTimes = new Set(state.bookingsForAvailDate.map(b => b.time));

  // Locked mode: the grid is a READ-ONLY reflection of the resolved
  // schedule (master template minus exceptions minus bookings), and
  // clicking a green slot toggles an EXCEPTION for this date only —
  // it never writes to openSlots/master template directly.
  //
  // Unlocked mode (no template yet, or template.locked === false): this
  // is the original free-form "click to open/close a slot for this date"
  // behavior, completely unchanged from before.
  const openSet = new Set(state.openSlots);
  const exceptionSet = new Set(state.exceptions);

  const allTimes = generateSlotTimes();
  const morning = allTimes.filter(t => parseInt(t.split(':')[0], 10) < 12);
  const afternoon = allTimes.filter(t => parseInt(t.split(':')[0], 10) >= 12);

  const renderGrid = (times) => times.map(time => {
    const isBooked = bookedTimes.has(time);

    if (isLocked) {
      const isException = exceptionSet.has(time);
      const isOpen = openSet.has(time) && !isBooked;
      // In locked mode a slot is either: booked (red, disabled), open
      // (green, clickable → cancel it for today), or already excepted /
      // not part of the template (neutral, clickable only if it belongs
      // to the template so the doctor can restore it).
      const inTemplate = isOpen || isException;
      if (!inTemplate && !isBooked) return ''; // not part of this weekday's template at all
      const cls = isBooked ? 'booked' : (isOpen ? 'selected' : 'excepted');
      const disabled = isBooked || state.dayCancelled;
      return `<button class="slot-btn ${cls}" data-time="${time}" data-exception="${isException}" ${disabled ? 'disabled' : ''}>${time}</button>`;
    }

    const isSelected = openSet.has(time);
    const cls = isBooked ? 'booked' : (isSelected ? 'selected' : '');
    return `<button class="slot-btn ${cls}" data-time="${time}" ${isBooked ? 'disabled' : ''}>${time}</button>`;
  }).join('');

  gridMorning.innerHTML = renderGrid(morning);
  gridAfternoon.innerHTML = renderGrid(afternoon);

  [gridMorning, gridAfternoon].forEach(grid => {
    grid.querySelectorAll('.slot-btn:not([disabled])').forEach(btn => {
      if (isLocked) {
        btn.addEventListener('click', () => toggleException(btn.dataset.time, btn.dataset.exception === 'true', btn));
      } else {
        btn.addEventListener('click', () => toggleSlot(btn.dataset.time, btn));
      }
    });
  });

  if (dayCancelBtn) {
    dayCancelBtn.hidden = !isLocked;
    dayCancelBtn.textContent = state.dayCancelled ? 'إلغاء الإغلاق (إعادة فتح اليوم)' : 'إلغاء اليوم بالكامل';
    dayCancelBtn.classList.toggle('danger-active', state.dayCancelled);
  }
}

// 🔒 BUG FIX — race condition in instant-save work hours:
//
// The previous version read `state.openSlots` and sent it to the server
// inside an async function, but only wrote the result back to
// `state.openSlots` AFTER the network request resolved. Clicking several
// slots quickly (exactly what happens when a doctor sets up their whole
// day) fired several overlapping requests that each read the SAME stale
// `state.openSlots` snapshot, computed a different "add/remove one time"
// array, and raced to the server — since /api/availability replaces
// the entire day's list on every call, whichever request happened to
// finish last silently wiped out all the others. The doctor saw every
// click turn green instantly (that part was only ever local), but a page
// refresh revealed only whatever the last-arriving request had saved.
//
// Fix: (1) update `state.openSlots` SYNCHRONOUSLY the moment a slot is
// clicked, so every subsequent click — even ones fired before any network
// request completes — always starts from the true up-to-date selection.
// (2) serialize the actual network saves through a single debounced queue
// that always sends the CURRENT state at send-time, and automatically
// re-sends once more if new clicks came in while a save was in flight.
// This also cuts network traffic from "one request per click" down to
// "one request per short burst of clicks", which helps the scroll-jank
// issue too.
let saveDebounceHandle = null;
let saveInFlight = false;
let saveQueued = false;
let saveDate = null;

function isAvailabilitySavePending() {
  return saveInFlight || saveQueued || saveDebounceHandle !== null;
}

function scheduleAvailabilitySave(date) {
  saveDate = date;
  clearTimeout(saveDebounceHandle);
  saveDebounceHandle = setTimeout(flushAvailabilitySave, 500);
}

async function flushAvailabilitySave() {
  saveDebounceHandle = null;
  if (saveInFlight) {
    // A save is already running — just flag that another one is needed
    // once it finishes, so we never drop clicks that arrive mid-flight.
    saveQueued = true;
    return;
  }
  saveInFlight = true;
  saveQueued = false;

  const dateToSave = saveDate;
  const slotsToSave = [...state.openSlots]; // snapshot AFTER all sync updates so far

  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ date: dateToSave, slots: slotsToSave }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل الحفظ');
  } catch (err) {
    console.error('[dashboard] availability save failed:', err);
    toast(err.message || 'تعذر حفظ أوقات العمل', true);
  } finally {
    saveInFlight = false;
    if (saveQueued) flushAvailabilitySave(); // one more click arrived mid-flight — send the latest state now
  }
}

function toggleSlot(time, btnEl) {
  const wasSelected = state.openSlots.includes(time);

  // Update the source of truth immediately (synchronously) — every
  // subsequent click, however fast, now reads this up-to-date array.
  state.openSlots = wasSelected
    ? state.openSlots.filter(t => t !== time)
    : [...state.openSlots, time];

  btnEl.classList.toggle('selected', !wasSelected);
  btnEl.classList.add('pending-save');
  renderStats();

  scheduleAvailabilitySave(state.availDate);

  // If a master template exists and is unlocked (edit mode), keep the
  // in-memory weekly draft in sync as the doctor configures each weekday
  // via this same familiar per-day grid — so whenever they later hit
  // "Lock", every weekday they touched is included, not just the last one.
  if (state.masterTemplate && state.masterTemplate.locked === false) {
    captureCurrentDayIntoTemplateDraft();
  }

  // Clear the "pending" indicator once this debounce window's save settles.
  // (Harmless if a later click's save clears it slightly early — it's a
  // lightweight visual cue, not a correctness signal.)
  setTimeout(() => btnEl.classList.remove('pending-save'), 700);
}

// ── Locked-mode: toggling an exception for ONE date, without touching
//    the master template. Optimistic UI update + immediate API call
//    (no debounce needed here — clicks on this grid are rare, unlike the
//    free-form daily setup flow above which needs the debounce/queue).
async function toggleException(time, wasException, btnEl) {
  const willCancel = !wasException; // clicking an open (green) slot cancels it; clicking an excepted slot restores it

  // Optimistic local update
  if (willCancel) {
    state.exceptions = [...new Set([...state.exceptions, time])];
  } else {
    state.exceptions = state.exceptions.filter(t => t !== time);
  }
  renderAvailability();

  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ date: state.availDate, time, cancelled: willCancel }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل الحفظ');
  } catch (err) {
    console.error('[dashboard] toggleException failed:', err);
    toast(err.message || 'تعذر حفظ الاستثناء', true);
    // Roll back optimistic update on failure
    loadAvailability(false);
  }
}

async function handleDayCancelToggle() {
  const nextDayCancelled = !state.dayCancelled;
  const btn = document.getElementById('day-cancel-btn');
  if (btn) btn.disabled = true;

  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ date: state.availDate, dayCancelled: nextDayCancelled }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل الحفظ');
    state.dayCancelled = nextDayCancelled;
    renderAvailability();
    toast(nextDayCancelled ? 'تم إلغاء اليوم بالكامل' : 'تم إعادة فتح اليوم');
  } catch (err) {
    console.error('[dashboard] handleDayCancelToggle failed:', err);
    toast(err.message || 'تعذر حفظ التغيير', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}



function startPolling() {
  stopPolling();
  pollHandle = setInterval(() => {
    // 🔒 BUG FIX: the old logic here was `if (sameDate) { /* nothing */ }
    // else if (!loading) loadAvailability()` — that first branch was meant
    // to "skip the redundant second fetch" but instead permanently
    // skipped refreshing the work-hours grid entirely whenever both date
    // pickers showed the same day (the default state), so incoming
    // bookings never visually removed a slot from the grid until the
    // doctor manually changed a date or cancelled something. Fixed: always
    // refresh both — a doctor's dashboard is low-traffic enough that one
    // extra read every 15s is negligible, and correctness matters more.
    if (!state.loadingBookings) loadBookings(false);
    if (!state.loadingAvailability) loadAvailability(false);
    loadHeroSummary();
  }, REFRESH_INTERVAL_MS);
}

function stopPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else startPolling();
});


// ── Init ────────────────────────────────────────────────────────────────

let initialized = false;

export function initDashboardApp(doctorUid) {
  // Guard against being called more than once (e.g. if onAuthStateChanged
  // ever fires again for an already-signed-in session). Without this,
  // every date-picker/refresh-button click would fire its handler once per
  // extra init call, and 'dashboard:profile-saved' would trigger multiple
  // redundant reloads.
  if (initialized) {
    state.doctorUid = doctorUid;
    return;
  }
  initialized = true;

  state.doctorUid = doctorUid;

  // Date pickers
  const bookingsDateInput = document.getElementById('bookings-date-input');
  const availDateInput = document.getElementById('avail-date-input');
  if (bookingsDateInput) {
    bookingsDateInput.value = state.bookingsDate;
    bookingsDateInput.addEventListener('change', () => {
      state.bookingsDate = bookingsDateInput.value || todayISO();
      loadBookings();
    });
  }
  if (availDateInput) {
    availDateInput.value = state.availDate;
    availDateInput.addEventListener('change', () => {
      state.availDate = availDateInput.value || todayISO();
      loadAvailability();
    });
  }

  document.getElementById('bookings-refresh-btn')?.addEventListener('click', () => loadBookings());
  document.getElementById('avail-refresh-btn')?.addEventListener('click', () => loadAvailability());
  document.getElementById('day-cancel-btn')?.addEventListener('click', handleDayCancelToggle);
  document.getElementById('slot-duration-select')?.addEventListener('change', handleSlotDurationChange);
  document.getElementById('template-lock-toggle-btn')?.addEventListener('click', handleTemplateLockToggle);

  // Refresh the profile card immediately after the AI-generated profile is saved
  window.addEventListener('dashboard:profile-saved', () => loadProfile());

  // Clinic info form
  document.getElementById('clinic-form')?.addEventListener('submit', saveClinicForm);

  document.getElementById('f-isPublished')?.addEventListener('change', (e) => {
    togglePublish(e.target.checked);
  });

  document.getElementById('publish-copy-link')?.addEventListener('click', async (e) => {
    const btn = e.target;
    const url = `${window.location.origin}/clinic.html?doctorId=${state.doctorUid}`;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = 'تم النسخ ✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'نسخ الرابط'; btn.classList.remove('copied'); }, 2000);
    } catch {
      toast('تعذر نسخ الرابط', true);
    }
  });

  document.getElementById('clinic-photos-input')?.addEventListener('change', (e) => {
    handlePhotoFilesSelected(e.target.files);
    e.target.value = ''; // allow re-selecting the same file later
  });

  document.getElementById('avatar-upload-input')?.addEventListener('change', (e) => {
    handleAvatarFileSelected(e.target.files?.[0]);
    e.target.value = '';
  });

  // Lazy-load the map only once its section is about to be visible
  const mapSection = document.getElementById('clinic-map')?.closest('section, div.section-card, form') 
    || document.getElementById('clinic-map');
  if (mapSection) {
    const mapObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        mapObserver.disconnect();
        loadLeaflet().then(initClinicMap).catch(err => console.error('[dashboard] map load failed:', err));
      }
    }, { rootMargin: '400px' }); // start loading a bit before it's actually on screen
    mapObserver.observe(mapSection);
  }

  loadProfile();
  loadBookings();
  loadAvailability();
  loadHeroSummary();
  loadDashboardReviews();
  startPolling();
}
