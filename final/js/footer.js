// ─────────────────────────────────────────────────────────────────────────
// js/footer.js
//
// Site-wide footer — platform's official social links + a small brand line.
// Injected into every page that includes a <div id="site-footer"></div>,
// except signin.html (intentionally excluded — keep that page focused).
//
// 🔧 EDIT HERE ONLY — these are the platform's OWN official accounts, not
// per-doctor data, so they live as plain constants rather than anything
// fetched from Firestore/API. Replace the '#' placeholders with your real
// URLs whenever the accounts are ready; nothing else in the project needs
// to change.
// ─────────────────────────────────────────────────────────────────────────

const SOCIAL_LINKS = {
  facebook: '#',   // ← ضع رابط صفحة فيسبوك الرسمية هنا
  instagram: 'https://www.instagram.com/ycfx_16?igsh=MTRwcm9pMTllc3ozYg==',  // ← ضع رابط حساب إنستجرام الرسمي هنا
  twitter: '#',    // ← ضع رابط حساب تويتر / X الرسمي هنا
};

const ICONS = {
  facebook: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 12.06C22 6.53 17.52 2.04 12 2.04S2 6.53 2 12.06c0 4.99 3.66 9.13 8.44 9.88v-6.99h-2.54v-2.89h2.54V9.85c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.45 2.89h-2.33v6.99C18.34 21.19 22 17.05 22 12.06z"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><path d="M17.5 6.5h.01"/></svg>`,
  twitter: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
};

function buildFooterHTML() {
  const items = [
    { key: 'facebook', label: 'فيسبوك' },
    { key: 'instagram', label: 'إنستجرام' },
    { key: 'twitter', label: 'تويتر' },
  ];

  const iconsHtml = items.map(({ key, label }) => `
    <a href="${SOCIAL_LINKS[key]}" target="_blank" rel="noopener noreferrer" class="footer-social-icon" aria-label="${label}">
      ${ICONS[key]}
    </a>
  `).join('');

  return `
    <footer class="site-footer">
      <div class="site-footer-inner">
        <div class="site-footer-brand">
          <span class="logo-dot"></span>
          <span>Platform</span>
        </div>
        <div class="site-footer-socials">
          ${iconsHtml}
        </div>
      </div>
    </footer>
  `;
}

export function mountFooter(containerId = 'site-footer') {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.outerHTML = buildFooterHTML();
}
