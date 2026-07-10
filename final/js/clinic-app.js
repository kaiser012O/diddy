// ─────────────────────────────────────────────────────────────────────────
// js/clinic-app.js
//
// Logic for the public clinic page (clinic.html) — the page that was
// entirely missing before. Any patient with a doctor's link (or arriving
// via the homepage directory) lands here and can see the doctor's real
// published profile and actually book a real appointment.
//
// Data sources, all real:
//   - Profile   → GET  /api/clinics?doctorId={uid}
//   - Open slots→ GET  /api/availability?doctorId={uid}&date={date}
//   - Booking   → POST /api/bookings  { action: "create", ... }
// ─────────────────────────────────────────────────────────────────────────

const SLOT_START_HOUR = 8;
const SLOT_END_HOUR = 20;
const SLOT_STEP_MIN = 30;

let clinicData = null;
let pickedTime = null;
let leafletLoadPromise = null;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function generateSlotTimes() {
  const times = [];
  for (let h = SLOT_START_HOUR; h < SLOT_END_HOUR; h++) {
    for (let m = 0; m < 60; m += SLOT_STEP_MIN) {
      times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return times;
}

const STAR_PATH = '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>';

function buildStarsHtml(score, { size = 14 } = {}) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const filled = i <= Math.round(score);
    html += `<svg width="${size}" height="${size}" viewBox="0 0 24 24" class="${filled ? 'star-filled' : 'star-empty'}" stroke="currentColor" stroke-width="1.5">${STAR_PATH}</svg>`;
  }
  return html;
}

// ── Map (same lazy-load approach as the dashboard, duplicated here since
//    this is a fully separate page/module with no shared bundle) ────────
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
    script.onerror = () => reject(new Error('map load failed'));
    document.head.appendChild(script);
  });
  return leafletLoadPromise;
}

function initMap(lat, lng) {
  const mapEl = document.getElementById('clinic-public-map');
  if (!mapEl || typeof window.L === 'undefined') return;
  const map = window.L.map('clinic-public-map', { zoomControl: true }).setView([lat, lng], 15);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);
  window.L.marker([lat, lng]).addTo(map);
}

// ── Main render ──────────────────────────────────────────────────────────

export async function initClinicPage(doctorId, ratingBookingId) {
  const content = document.getElementById('clinic-content');

  if (!doctorId) {
    renderNotFound(content, 'الرابط غير صحيح، لا يوجد معرّف عيادة.');
    return;
  }

  try {
    const res = await fetch(`/api/clinics?doctorId=${encodeURIComponent(doctorId)}`);
    if (res.status === 404) {
      renderNotFound(content, 'لم يتم العثور على هذه العيادة.');
      return;
    }
    if (!res.ok) throw new Error('failed');

    clinicData = await res.json();
    clinicData.doctorId = doctorId;
    renderClinic(content, clinicData);

    if (ratingBookingId) {
      renderRatingPrompt(ratingBookingId);
    }
  } catch (err) {
    console.error('[clinic] load failed:', err);
    renderNotFound(content, 'تعذر تحميل صفحة العيادة. حاول مرة أخرى لاحقاً.');
  }
}

function renderNotFound(content, message) {
  content.innerHTML = `
    <div class="clinic-not-found">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <h2>عذراً</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function renderClinic(content, data) {
  const name = data.doctorName || data.clinicName || 'الطبيب';
  const initial = name.charAt(0);

  const avatarHtml = data.avatarUrl
    ? `<img src="${escapeHtml(data.avatarUrl)}" alt="">`
    : escapeHtml(initial);

  const galleryHtml = (data.photos || []).length
    ? `<div class="clinic-gallery">${data.photos.map(p => `<img src="${escapeHtml(p)}" alt="">`).join('')}</div>`
    : '';

  const tagsHtml = (data.services || [])
    .map(s => `<span class="profile-hero-tag">#${escapeHtml(s)}</span>`)
    .join('');

  const priceHtml = data.consultationPrice
    ? `<span class="clinic-price-badge">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        سعر الكشف: ${escapeHtml(String(data.consultationPrice))}
      </span>`
    : '';

  const ratingSummaryHtml = data.ratingCount > 0
    ? `<div class="rating-summary">
        <span class="stars">${buildStarsHtml(data.ratingAverage)}</span>
        <span class="rating-number">${escapeHtml(String(data.ratingAverage))}</span>
        <span class="rating-count">(${escapeHtml(String(data.ratingCount))} تقييم)</span>
      </div>`
    : `<div class="rating-summary no-ratings">لا توجد تقييمات بعد</div>`;

  const contactRows = [];
  if (data.phone) {
    contactRows.push(`
      <div class="clinic-contact-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        <a href="tel:${escapeHtml(data.phone)}" dir="ltr">${escapeHtml(data.phone)}</a>
      </div>
    `);
  }
  if (data.whatsapp) {
    contactRows.push(`
      <div class="clinic-contact-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        <a href="https://wa.me/${escapeHtml(data.whatsapp.replace(/[^\d]/g, ''))}" target="_blank" rel="noopener" dir="ltr">${escapeHtml(data.whatsapp)}</a>
      </div>
    `);
  }
  if (data.address) {
    contactRows.push(`
      <div class="clinic-contact-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <span>${escapeHtml(data.address)}</span>
      </div>
    `);
  }

  content.innerHTML = `
    <div class="profile-hero">
      <div class="profile-hero-avatar">${avatarHtml}</div>
      <div class="profile-hero-body">
        <div class="profile-hero-name-row">
          <span class="profile-hero-name">${escapeHtml(name)}</span>
          ${data.specialty ? `<span class="profile-hero-specialty">${escapeHtml(data.specialty)}</span>` : ''}
        </div>
        ${data.bio ? `<p class="profile-hero-bio">${escapeHtml(data.bio)}</p>` : ''}
        ${tagsHtml ? `<div class="profile-hero-tags">${tagsHtml}</div>` : ''}
        ${ratingSummaryHtml}
      </div>
    </div>

    ${galleryHtml}
    ${priceHtml}

    ${contactRows.length ? `<div class="section-card" style="margin-bottom:22px;">${contactRows.join('')}</div>` : ''}

    ${data.lat !== null && data.lng !== null ? '<div id="clinic-public-map"></div>' : ''}

    <div class="section-card" id="booking-widget">
      <div class="section-head">
        <span class="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          احجز موعدك
        </span>
        <div class="date-filter">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          <input type="date" id="booking-date-input">
        </div>
      </div>
      <div id="booking-widget-body"></div>
    </div>

    <div class="section-card" id="reviews-section" style="margin-top:18px;">
      <div class="section-head">
        <span class="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
          آراء المرضى
        </span>
      </div>
      <div id="reviews-list"><div class="empty-state-mini">جاري التحميل...</div></div>
    </div>
  `;

  if (data.lat !== null && data.lng !== null) {
    loadLeaflet().then(() => initMap(data.lat, data.lng)).catch(() => {});
  }

  loadReviews(data.doctorId);

  if (data.bookingEnabled === false) {
    document.getElementById('booking-widget-body').innerHTML = `
      <div class="booking-disabled-notice">
        الحجز الإلكتروني غير متاح حالياً لهذه العيادة. يرجى التواصل مباشرة عبر الهاتف أو واتساب أعلاه.
      </div>
    `;
    document.querySelector('#booking-widget .date-filter').style.display = 'none';
    return;
  }

  const dateInput = document.getElementById('booking-date-input');
  dateInput.value = todayISO();
  dateInput.min = todayISO();
  dateInput.addEventListener('change', () => loadSlotsForDate(dateInput.value));

  loadSlotsForDate(todayISO());
}

async function loadSlotsForDate(date) {
  const body = document.getElementById('booking-widget-body');
  pickedTime = null;
  body.innerHTML = `<div class="empty-state-mini">جاري تحميل الأوقات المتاحة...</div>`;

  try {
    const res = await fetch(`/api/availability?doctorId=${encodeURIComponent(clinicData.doctorId)}&date=${encodeURIComponent(date)}`);
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    const openSlots = data.openSlots || [];

    if (openSlots.length === 0) {
      body.innerHTML = `
        <div class="empty-state-mini">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          <p>لا توجد أوقات متاحة في هذا اليوم، جرّب تاريخاً آخر.</p>
        </div>
      `;
      return;
    }

    body.innerHTML = `
      <div class="slots-grid" id="public-slots-grid">
        ${openSlots.map(t => `<button type="button" class="slot-btn" data-time="${t}">${t}</button>`).join('')}
      </div>
      <div id="booking-form-container"></div>
    `;

    document.querySelectorAll('#public-slots-grid .slot-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#public-slots-grid .slot-btn').forEach(b => b.classList.remove('picked'));
        btn.classList.add('picked');
        pickedTime = btn.dataset.time;
        renderBookingForm(date);
      });
    });
  } catch (err) {
    console.error('[clinic] loadSlots failed:', err);
    body.innerHTML = `<div class="error-banner">تعذر تحميل الأوقات المتاحة.</div>`;
  }
}

function renderBookingForm(date) {
  const container = document.getElementById('booking-form-container');
  if (!container) return;

  container.innerHTML = `
    <form class="auth-form booking-form-row" id="patient-booking-form">
      <div class="auth-field">
        <label for="patient-name">الاسم</label>
        <input type="text" id="patient-name" class="auth-input" placeholder="اسمك الكامل" required>
      </div>
      <div class="auth-field">
        <label for="patient-phone">رقم الهاتف</label>
        <input type="tel" id="patient-phone" class="auth-input" placeholder="0555123456" dir="ltr" required>
      </div>
      <div id="booking-error" class="auth-error hidden"></div>
      <button type="submit" class="btn-signin" id="btn-confirm-booking">
        تأكيد الحجز — ${escapeHtml(pickedTime)}
      </button>
    </form>
  `;

  document.getElementById('patient-booking-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('booking-error');
    errEl.classList.add('hidden');

    const clientName = document.getElementById('patient-name').value.trim();
    const clientPhone = document.getElementById('patient-phone').value.trim();
    const btn = document.getElementById('btn-confirm-booking');

    btn.disabled = true;
    btn.textContent = 'جاري الحجز...';

    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          doctorId: clinicData.doctorId,
          date,
          time: pickedTime,
          clientName,
          clientPhone,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 409) {
          errEl.textContent = 'تم حجز هذا الوقت للتو، يرجى اختيار وقت آخر.';
          errEl.classList.remove('hidden');
          loadSlotsForDate(date); // refresh the grid — that slot is gone now
          return;
        }
        throw new Error(data.error || 'فشل الحجز');
      }

      renderBookingSuccess(date);
    } catch (err) {
      errEl.textContent = err.message || 'حدث خطأ، حاول مرة أخرى.';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = `تأكيد الحجز — ${pickedTime}`;
    }
  });
}

function renderBookingSuccess(date) {
  const body = document.getElementById('booking-widget-body');
  body.innerHTML = `
    <div class="booking-success">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
      <h3>تم تأكيد حجزك!</h3>
      <p>موعدك يوم ${escapeHtml(date)} الساعة ${escapeHtml(pickedTime)}. سيتواصل معك العيادة عند الحاجة.</p>
    </div>
  `;
}

// ── Reviews ─────────────────────────────────────────────────────────────

async function loadReviews(doctorId) {
  const list = document.getElementById('reviews-list');
  if (!list) return;

  try {
    const res = await fetch(`/api/ratings?doctorId=${encodeURIComponent(doctorId)}`);
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    const reviews = data.ratings || [];

    if (reviews.length === 0) {
      list.innerHTML = `<div class="empty-state-mini"><p>لا توجد آراء بعد — كن أول من يقيّم هذه العيادة.</p></div>`;
      return;
    }

    list.innerHTML = reviews.map(r => `
      <div class="review-card">
        <div class="review-card-head">
          <span class="review-card-name">${escapeHtml(r.clientName || 'مريض')}</span>
          <span class="review-card-date">${escapeHtml((r.createdAt || '').slice(0, 10))}</span>
        </div>
        <div class="review-card-stars">${buildStarsHtml(r.score, { size: 13 })}</div>
        ${r.comment ? `<p class="review-card-comment">${escapeHtml(r.comment)}</p>` : ''}
      </div>
    `).join('');
  } catch (err) {
    console.error('[clinic] loadReviews failed:', err);
    list.innerHTML = `<div class="error-banner">تعذر تحميل الآراء.</div>`;
  }
}

// ── Rating submission ───────────────────────────────────────────────────
// Triggered when a patient arrives via a link like
// clinic.html?doctorId=xxx&rate=bookingId123 — sent to them after their
// appointment date has passed (via the automatic WhatsApp follow-up cron,
// see api/cron-send-rating-requests.js).

export function renderRatingPrompt(bookingId) {
  const content = document.getElementById('clinic-content');
  if (!content || !bookingId) return;

  const promptEl = document.createElement('div');
  promptEl.className = 'section-card';
  promptEl.id = 'rating-prompt';
  promptEl.style.marginBottom = '18px';
  promptEl.innerHTML = `
    <div class="section-head">
      <span class="section-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
        كيف كانت تجربتك؟
      </span>
    </div>
    <div class="star-picker" id="star-picker">
      ${[1, 2, 3, 4, 5].map(n => `
        <button type="button" data-value="${n}" aria-label="${n} نجوم">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
        </button>
      `).join('')}
    </div>
    <form class="auth-form booking-form-row" id="rating-form">
      <div class="auth-field">
        <label for="rating-phone">رقم الهاتف (نفس رقم الحجز)</label>
        <input type="tel" id="rating-phone" class="auth-input" placeholder="0555123456" dir="ltr" required>
      </div>
      <div class="auth-field">
        <label for="rating-comment">تعليقك (اختياري)</label>
        <input type="text" id="rating-comment" class="auth-input" placeholder="شارك تجربتك مع الطبيب...">
      </div>
      <div id="rating-error" class="auth-error hidden"></div>
      <button type="submit" class="btn-signin" id="btn-submit-rating">إرسال التقييم</button>
    </form>
  `;

  content.insertBefore(promptEl, content.firstChild);

  let pickedScore = 0;
  const buttons = promptEl.querySelectorAll('#star-picker button');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      pickedScore = Number(btn.dataset.value);
      buttons.forEach(b => b.classList.toggle('active', Number(b.dataset.value) <= pickedScore));
    });
  });

  document.getElementById('rating-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('rating-error');
    errEl.classList.add('hidden');

    if (!pickedScore) {
      errEl.textContent = 'يرجى اختيار عدد النجوم أولاً';
      errEl.classList.remove('hidden');
      return;
    }

    const clientPhone = document.getElementById('rating-phone').value.trim();
    const comment = document.getElementById('rating-comment').value.trim();
    const btn = document.getElementById('btn-submit-rating');
    btn.disabled = true;
    btn.textContent = 'جاري الإرسال...';

    try {
      const res = await fetch('/api/ratings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doctorId: clinicData?.doctorId,
          bookingId,
          clientPhone,
          score: pickedScore,
          comment: comment || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'فشل إرسال التقييم');

      promptEl.innerHTML = `
        <div class="booking-success">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
          <h3>شكراً لك!</h3>
          <p>تم إرسال تقييمك بنجاح.</p>
        </div>
      `;
      if (clinicData?.doctorId) loadReviews(clinicData.doctorId);
    } catch (err) {
      errEl.textContent = err.message || 'حدث خطأ، حاول مرة أخرى.';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'إرسال التقييم';
    }
  });
}
