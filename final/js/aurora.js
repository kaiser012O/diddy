/**
 * Aurora — Canvas 2D background, theme-aware (no React/WebGL deps)
 *
 * Usage:
 *   <div id="aurora-bg" class="aurora-container"></div>
 *   import { mountAurora } from './aurora.js';
 *   mountAurora('aurora-bg');
 */

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c+c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(c1, c2, t) {
  return [c1[0]+(c2[0]-c1[0])*t, c1[1]+(c2[1]-c1[1])*t, c1[2]+(c2[2]-c1[2])*t];
}

function rampColor(stops, factor) {
  const n = stops.length;
  const scaled = factor * (n - 1);
  const idx = Math.min(Math.floor(scaled), n - 2);
  const t = scaled - idx;
  return lerpColor(stops[idx], stops[idx+1], t);
}

function noise2D(x, y, seed=0) {
  const n = Math.sin(x*12.9898 + y*78.233 + seed*37.719) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1;
}

function smoothNoise(x, y, seed) {
  const ix=Math.floor(x), iy=Math.floor(y), fx=x-ix, fy=y-iy;
  const a=noise2D(ix,iy,seed), b=noise2D(ix+1,iy,seed);
  const c=noise2D(ix,iy+1,seed), d=noise2D(ix+1,iy+1,seed);
  const ux=fx*fx*(3-2*fx), uy=fy*fy*(3-2*fy);
  return a*(1-ux)*(1-uy)+b*ux*(1-uy)+c*(1-ux)*uy+d*ux*uy;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x-e0)/(e1-e0), 0), 1);
  return t*t*(3-2*t);
}

// ألوان حسب الثيم — أخضر طبي بكثافة مختلفة لكل وضع
function getThemeColors() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  return theme === 'dark'
    ? ['#0d2e24', '#2d8a6e', '#3ea884']   // dark: عميق → أخضر مشرق
    : ['#d7ede5', '#6cb8a0', '#2d8a6e'];  // light: فاتح جداً → أخضر متوسط
}

export function mountAurora(containerId, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) { console.warn(`[Aurora] #${containerId} not found`); return () => {}; }

  const { amplitude = 0.9, blend = 0.5, speed = 0.6 } = opts;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let stopsRgb = getThemeColors().map(hexToRgb);
  let width=0, height=0, dpr=Math.min(window.devicePixelRatio||1, 2), cols=0;

  function resize() {
    width  = container.offsetWidth;
    height = container.offsetHeight;
    canvas.width  = width*dpr; canvas.height = height*dpr;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    cols = Math.max(60, Math.min(160, Math.floor(width/6)));
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // إعادة تحميل الألوان عند تبديل الثيم
  function onThemeChange() { stopsRgb = getThemeColors().map(hexToRgb); }
  document.addEventListener('themechange', onThemeChange);

  let rafId = 0, t = 0;
  let isVisible = true; // 🔒 PERF FIX: paused while the hero is scrolled out of view

  // Scrolling the aurora out of view used to keep costing a full canvas
  // redraw (with a blur filter, no less) 60 times a second for no visual
  // benefit at all — a real contributor to the "heavy scroll" feeling on
  // longer dashboard pages. Pausing/resuming the RAF loop via visibility
  // costs nothing when the hero IS visible and eliminates the cost
  // entirely once the user scrolls past it.
  const visibilityObserver = new IntersectionObserver(
    (entries) => { isVisible = entries[0]?.isIntersecting ?? true; },
    { threshold: 0 }
  );
  visibilityObserver.observe(container);

  function draw() {
    if (!isVisible) {
      rafId = requestAnimationFrame(draw);
      return;
    }

    ctx.clearRect(0, 0, width, height);

    // Soft blur turns the hard-edged per-column rectangles into one
    // continuous, glowing wave instead of a "staircase" of bars — this is
    // what actually reads as "smooth" rather than the underlying math.
    ctx.filter = `blur(${Math.max(8, width * 0.012)}px)`;

    const colWidth = width / cols;

    // The wave's resting line sits at the vertical MIDDLE of whatever
    // container it's mounted in, and gently rises/falls around it — this
    // keeps it visually centered whether the hero is short (dashboard,
    // just a search bar) or tall (index, title+subtitle+search+filters),
    // instead of the old formula which anchored near the bottom and grew
    // upward (making it look "too high" in short containers).
    const midY = height * 0.5;
    const waveSpan = height * 0.32 * amplitude; // how far it swings from the midline

    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1);
      const [r, g, b] = rampColor(stopsRgb, u);
      const n = smoothNoise(u * 1.4 + t * 0.1, t * 0.22, 1);

      // Soft-saturating curve (tanh) instead of a hard Math.min clamp —
      // peaks round off gracefully instead of hitting a flat, clipped top.
      const eased = Math.tanh(n * 1.1);
      const bandTop = midY - eased * waveSpan;
      const bandHeight = height - bandTop;

      const grad = ctx.createLinearGradient(0, bandTop, 0, height);
      const midPoint = 0.20;
      for (let s = 0; s <= 1; s += 0.25) {
        const intensity = 0.6 * (s + midPoint);
        const alpha = smoothstep(midPoint-blend*0.5, midPoint+blend*0.5, intensity) * 0.45;
        grad.addColorStop(s, `rgba(${r|0},${g|0},${b|0},${Math.max(0,Math.min(alpha,0.5))})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(i*colWidth, bandTop, colWidth+1, bandHeight);
    }

    ctx.filter = 'none';

    t += 0.008 * speed;
    rafId = requestAnimationFrame(draw);
  }

  rafId = requestAnimationFrame(draw);

  return function unmount() {
    cancelAnimationFrame(rafId);
    ro.disconnect();
    visibilityObserver.disconnect();
    document.removeEventListener('themechange', onThemeChange);
    container.removeChild(canvas);
  };
}
