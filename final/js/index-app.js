// ─────────────────────────────────────────────────────────────────────────
// js/index-app.js
//
// Populates the homepage's clinic directory. Before this file existed,
// #doctors-grid in index.html had no data source at all — the "No clinics
// yet" empty state was the ONLY thing that could ever show, permanently,
// regardless of how many doctors had actually published a page.
//
// Data source: GET /api/clinics (public, returns only clinics the
// doctor has explicitly published — see the isPublished toggle in
// dashboard.html / api/clinic-save.js).
// ─────────────────────────────────────────────────────────────────────────

let allClinics = [];
let activeFilter = '';
let searchQuery = '';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function matchesFilter(clinic) {
  const haystack = `${clinic.specialty || ''} ${(clinic.services || []).join(' ')}`.toLowerCase();

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    const searchable = `${clinic.clinicName || ''} ${clinic.doctorName || ''} ${clinic.specialty || ''} ${(clinic.services || []).join(' ')}`.toLowerCase();
    if (!searchable.includes(q)) return false;
  }

  if (!activeFilter) return true;

  // Specialty is free text (often AI-generated), not a fixed enum, so this
  // is a best-effort substring match against the filter chip's keyword
  // rather than an exact category match.
  const filterKeywords = {
    general: ['عام', 'general'],
    orthodontics: ['تقويم', 'ortho'],
    implants: ['زراعة', 'implant'],
    cosmetic: ['تجميل', 'cosmetic'],
    gum: ['لثة', 'gum', 'periodont'],
    root_canal: ['عصب', 'root canal', 'endodont'],
    pediatric: ['أطفال', 'pediatric', 'kids'],
  };
  const keywords = filterKeywords[activeFilter] || [activeFilter];
  return keywords.some(k => haystack.includes(k.toLowerCase()));
}

function renderClinics() {
  const grid = document.getElementById('doctors-grid');
  const emptyState = document.getElementById('empty-state');
  if (!grid) return;

  const visible = allClinics.filter(matchesFilter);

  if (visible.length === 0) {
    grid.innerHTML = '';
    emptyState?.classList.remove('hidden');
    return;
  }

  emptyState?.classList.add('hidden');

  grid.innerHTML = visible.map(clinic => {
    const name = clinic.doctorName || clinic.clinicName || 'طبيب';
    const photoBlock = clinic.photo
      ? `<img src="${escapeHtml(clinic.photo)}" alt="" style="width:100%;height:140px;object-fit:cover;">`
      : `<div style="width:100%;height:140px;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-family:var(--font-serif);font-size:32px;font-weight:800;color:var(--accent-500);">${escapeHtml(name.charAt(0))}</div>`;

    const servicesHtml = (clinic.services || []).slice(0, 3)
      .map(s => `<span style="font-size:10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-full);padding:3px 9px;color:var(--text-secondary);">#${escapeHtml(s)}</span>`)
      .join('');

    return `
      <a href="clinic.html?doctorId=${encodeURIComponent(clinic.doctorId)}" class="doctor-card" style="display:block;">
        ${photoBlock}
        <div style="padding:14px 16px;">
          <div style="font-family:var(--font-serif);font-weight:700;font-size:15px;margin-bottom:3px;">${escapeHtml(name)}</div>
          ${clinic.specialty ? `<div style="font-size:12px;color:var(--accent-500);font-weight:600;margin-bottom:8px;">${escapeHtml(clinic.specialty)}</div>` : ''}
          ${clinic.bio ? `<p style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escapeHtml(clinic.bio)}</p>` : ''}
          ${servicesHtml ? `<div style="display:flex;flex-wrap:wrap;gap:5px;">${servicesHtml}</div>` : ''}
        </div>
      </a>
    `;
  }).join('');
}

async function loadClinics() {
  const grid = document.getElementById('doctors-grid');
  try {
    const res = await fetch('/api/clinics');
    if (!res.ok) throw new Error('Failed to load clinics');
    const data = await res.json();
    allClinics = data.clinics || [];
    renderClinics();
  } catch (err) {
    console.error('[index] loadClinics failed:', err);
    if (grid) grid.innerHTML = '';
    document.getElementById('empty-state')?.classList.remove('hidden');
  }
}

export function initIndexApp() {
  document.getElementById('empty-state')?.classList.add('hidden'); // hide until we know the real state

  document.getElementById('filters-row')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    activeFilter = chip.dataset.filter || '';
    renderClinics();
  });

  const searchInput = document.getElementById('search-input');
  let searchDebounce = null;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = searchInput.value.trim();
      renderClinics();
    }, 250);
  });

  loadClinics();
}
