// AventasPay - Unified Vanilla JS Motion Controller (Round 4)
// Lightweight helpers: countUp, spotlight, toast, visibility listener, and nav slider.
// Plain JS, requestAnimationFrame, zero heavy animation libraries.

/**
 * Checks if the user prefers reduced motion
 */
export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Animates a numeric element or value from `from` to `to` using cubic ease-out
 */
export function countUp(el, to, options = {}) {
  if (!el) return;
  const {
    duration = 900,
    decimals = 0,
    prefix = '',
    suffix = '',
    formatFn = null,
  } = options;

  const target = Number(to) || 0;
  if (prefersReducedMotion()) {
    el.textContent = formatFn
      ? formatFn(target)
      : `${prefix}${target.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`;
    el._currentVal = target;
    return;
  }

  const from = typeof el._currentVal === 'number' ? el._currentVal : 0;
  el._currentVal = target;

  const animId = (el._countAnimId = (el._countAnimId || 0) + 1);
  const startTime = performance.now();

  function tick(currentTime) {
    if (el._countAnimId !== animId) return;
    const progress = Math.min(1, (currentTime - startTime) / duration);
    // Cubic ease-out: 1 - Math.pow(1 - progress, 3)
    const ease = 1 - Math.pow(1 - progress, 3);
    const currentVal = from + (target - from) * ease;

    if (formatFn) {
      el.textContent = formatFn(currentVal);
    } else {
      el.textContent = `${prefix}${currentVal.toLocaleString('en-IN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}${suffix}`;
    }

    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      // Ensure exact final number
      if (formatFn) {
        el.textContent = formatFn(target);
      } else {
        el.textContent = `${prefix}${target.toLocaleString('en-IN', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })}${suffix}`;
      }
    }
  }

  requestAnimationFrame(tick);
}

/**
 * Initializes Card Spotlight glow following mouse pointer (Rule A3)
 * Desktop pointer devices only via hover:hover, throttled via rAF
 */
export function initSpotlight() {
  if (typeof window === 'undefined') return () => {};
  if (!window.matchMedia('(hover: hover)').matches) return () => {};

  let ticking = false;
  let activeEvent = null;

  function onPointerMove(e) {
    activeEvent = e;
    if (!ticking) {
      requestAnimationFrame(() => {
        if (!activeEvent) return;
        const targetCard = activeEvent.target.closest && activeEvent.target.closest('.motion-card-spotlight, .stat-card, .card');
        if (targetCard) {
          const rect = targetCard.getBoundingClientRect();
          targetCard.style.setProperty('--mx', `${activeEvent.clientX - rect.left}px`);
          targetCard.style.setProperty('--my', `${activeEvent.clientY - rect.top}px`);
        }
        ticking = false;
      });
      ticking = true;
    }
  }

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  return () => {
    document.removeEventListener('pointermove', onPointerMove);
  };
}

/**
 * Global Page Visibility Listener (Performance Rule)
 * Pauses infinite animations when tab is hidden or backgrounded
 */
export function initVisibilityListener() {
  if (typeof document === 'undefined') return () => {};

  function handleVisibilityChange() {
    if (document.hidden) {
      document.body.classList.add('tab-hidden');
    } else {
      document.body.classList.remove('tab-hidden');
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  handleVisibilityChange();

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

/**
 * Global Toast System (Rule A23)
 * Stacks bottom-right, auto-dismisses in 4s, click/swipe to dismiss, max 3 stacked.
 */
let toastContainer = null;
const activeToasts = [];
const MAX_TOASTS = 3;

function getToastContainer() {
  if (!toastContainer) {
    toastContainer = document.getElementById('motionToastContainer');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'motionToastContainer';
      document.body.appendChild(toastContainer);
    }
  }
  return toastContainer;
}

export function showMotionToast(message, tone = 'ok', iconHtml = '') {
  if (typeof document === 'undefined') return;
  const container = getToastContainer();

  // Enforce max 3 stacked toasts
  if (activeToasts.length >= MAX_TOASTS) {
    const oldest = activeToasts.shift();
    if (oldest && oldest.el) {
      oldest.el.classList.add('toast-dismissing');
      setTimeout(() => oldest.el.remove(), 250);
    }
  }

  const toastEl = document.createElement('div');
  toastEl.className = 'motion-toast';

  let toneColor = 'var(--ok)';
  if (tone === 'warn') toneColor = 'var(--warn)';
  if (tone === 'bad') toneColor = 'var(--bad)';
  if (tone === 'review' || tone === 'accent') toneColor = 'var(--accent)';

  toastEl.innerHTML = `
    <span style="display:inline-flex;color:${toneColor};flex:none;">${iconHtml || '●'}</span>
    <span style="flex:1;min-width:0;line-height:1.35;">${message}</span>
  `;

  const dismiss = () => {
    const idx = activeToasts.findIndex((t) => t.el === toastEl);
    if (idx !== -1) activeToasts.splice(idx, 1);
    toastEl.classList.add('toast-dismissing');
    setTimeout(() => toastEl.remove(), 250);
  };

  toastEl.onclick = dismiss;

  const timer = setTimeout(dismiss, 4000);
  activeToasts.push({ el: toastEl, timer });

  container.appendChild(toastEl);
}

/**
 * Updates sliding active nav indicator (Rule A5)
 */
export function updateNavIndicator(navContainer, activeLinkEl, indicatorEl) {
  if (!navContainer || !activeLinkEl || !indicatorEl) return;
  const top = activeLinkEl.offsetTop;
  indicatorEl.style.transform = `translateY(${top}px)`;
  indicatorEl.style.opacity = '1';
}

/**
 * Updates sliding pill indicator for segmented tabs (Rule A13)
 */
export function updateSegmentedPill(tabsContainer, activeTabEl, pillEl) {
  if (!tabsContainer || !activeTabEl || !pillEl) return;
  const left = activeTabEl.offsetLeft;
  const width = activeTabEl.offsetWidth;
  pillEl.style.width = `${width}px`;
  pillEl.style.transform = `translateX(${left}px)`;
  pillEl.style.opacity = '1';
}
