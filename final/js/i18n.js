// ─── i18n — Bilingual System (EN default / AR) ───────────────────────────

const DICT = {
  en: {
    dir: 'ltr',
    nav_create: 'Create My Clinic',
    nav_dashboard: 'My Dashboard',
    search_placeholder: 'Search doctors, specialties, clinics...',
    hero_title: 'Book your appointment',
    hero_title_accent: 'in seconds',
    hero_sub: 'Find trusted clinics and book instantly — no account needed',
    filter_all: 'All',
    filter_general: 'General',
    filter_orthodontics: 'Orthodontics',
    filter_implants: 'Implants',
    filter_cosmetic: 'Cosmetic',
    filter_gum: 'Gum Care',
    filter_root_canal: 'Root Canal',
    filter_pediatric: 'Pediatric',
    results_count: '{n} clinics available',
    empty_title: 'No results found',
    empty_sub: 'Try a different search term or specialty',
    empty_no_clinics: 'No clinics yet',
    empty_no_clinics_sub: 'Be the first to create your clinic page',
    theme_toggle_label: 'Toggle theme',
    lang_toggle_label: 'العربية',

    auth_back: 'Back to home',
    auth_heading: 'Doctor sign in',
    auth_subheading: 'Manage your clinic and bookings',
    auth_google: 'Continue with Google',
    auth_divider: 'or sign in with email',
    auth_email_label: 'Email',
    auth_email_placeholder: 'you@example.com',
    auth_password_label: 'Password',
    auth_password_placeholder: 'Enter your password',
    auth_forgot: 'Forgot password?',
    auth_submit: 'Sign in',
    auth_submitting: 'Signing in...',
    auth_hint: 'First time? Sign in with Google to create your account automatically.',
    auth_error_generic: 'Something went wrong. Please try again.',
    auth_error_invalid: 'Incorrect email or password.',
    auth_error_fields: 'Please fill in both fields.',
    auth_reset_sent: 'Password reset email sent. Check your inbox.',

    dash_hero_title: 'Build your clinic page',
    dash_hero_title_accent: 'in seconds',
    dash_hero_sub: 'Describe yourself and your clinic — AI fills in the rest',
    dash_ai_placeholder: 'I am a dentist specializing in orthodontics, working in...',
    dash_ai_button: 'Generate my page'
  },
  ar: {
    dir: 'rtl',
    nav_create: 'أنشئ عيادتي',
    nav_dashboard: 'لوحة التحكم',
    search_placeholder: 'ابحث عن طبيب، تخصص، أو عيادة...',
    hero_title: 'احجز موعدك',
    hero_title_accent: 'في ثوانٍ',
    hero_sub: 'تصفح عيادات موثوقة واحجز فوراً — بدون تسجيل',
    filter_all: 'الكل',
    filter_general: 'عام',
    filter_orthodontics: 'تقويم',
    filter_implants: 'زراعة',
    filter_cosmetic: 'تجميل',
    filter_gum: 'لثة',
    filter_root_canal: 'عصب',
    filter_pediatric: 'أطفال',
    results_count: '{n} عيادة متاحة',
    empty_title: 'لا توجد نتائج',
    empty_sub: 'جرّب كلمة بحث مختلفة أو تخصصاً آخر',
    empty_no_clinics: 'لا توجد عيادات بعد',
    empty_no_clinics_sub: 'كن أول من ينشئ صفحة عيادته',
    theme_toggle_label: 'تبديل المظهر',
    lang_toggle_label: 'English',

    auth_back: 'العودة للرئيسية',
    auth_heading: 'تسجيل دخول الطبيب',
    auth_subheading: 'أدر عيادتك وحجوزاتك',
    auth_google: 'المتابعة بحساب Google',
    auth_divider: 'أو سجّل دخول بالإيميل',
    auth_email_label: 'البريد الإلكتروني',
    auth_email_placeholder: 'you@example.com',
    auth_password_label: 'كلمة المرور',
    auth_password_placeholder: 'أدخل كلمة المرور',
    auth_forgot: 'نسيت كلمة المرور؟',
    auth_submit: 'تسجيل الدخول',
    auth_submitting: 'جارٍ تسجيل الدخول...',
    auth_hint: 'أول مرة؟ سجّل دخول بـ Google لإنشاء حسابك تلقائياً.',
    auth_error_generic: 'حدث خطأ ما. حاول مجدداً.',
    auth_error_invalid: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    auth_error_fields: 'الرجاء تعبئة الحقلين.',
    auth_reset_sent: 'تم إرسال رابط إعادة تعيين كلمة المرور. تحقق من بريدك الإلكتروني.',

    dash_hero_title: 'ابنِ صفحة عيادتك',
    dash_hero_title_accent: 'في ثوانٍ',
    dash_hero_sub: 'اكتب عن نفسك وعيادتك — والذكاء الاصطناعي يكمل الباقي',
    dash_ai_placeholder: 'أنا طبيب أسنان متخصص في التقويم، أعمل في...',
    dash_ai_button: 'ولّد صفحتي'
  }
};

const STORAGE_KEY = 'platform_lang';
const DEFAULT_LANG = 'en';

let currentLang = localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG;

export function getLang() {
  return currentLang;
}

export function t(key, vars = {}) {
  let str = DICT[currentLang]?.[key] ?? DICT[DEFAULT_LANG][key] ?? key;
  Object.entries(vars).forEach(([k, v]) => {
    str = str.replace(`{${k}}`, v);
  });
  return str;
}

export function setLang(lang) {
  if (!DICT[lang]) return;
  currentLang = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  applyLangToDOM();
}

export function toggleLang() {
  setLang(currentLang === 'en' ? 'ar' : 'en');
}

/**
 * يطبّق الترجمة على كل عنصر فيه data-i18n
 * ويحدّث dir/lang على <html>
 */
export function applyLangToDOM() {
  const dir = DICT[currentLang].dir;
  document.documentElement.lang = currentLang;
  document.documentElement.dir  = dir;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    el.textContent = t(key);
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });

  document.querySelectorAll('[data-i18n-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  });

  // تحديث نص زر تبديل اللغة نفسه
  document.querySelectorAll('[data-lang-toggle]').forEach(el => {
    el.textContent = t('lang_toggle_label');
  });
}

export function initI18n() {
  applyLangToDOM();
}
