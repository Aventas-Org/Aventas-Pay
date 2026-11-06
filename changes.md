\# ROUND 4: Motion system + remaining fixes (AventasPay)



Attach `aventaspay-motion-demo.html` as the \*\*motion reference\*\*. It is a visual and behavioral spec for animations only. Do NOT copy its fake data, its layout, or its placeholder pages. Keep our real app, routes, data and the Round 1-3 design intact (tokens: --bg #0A0A0B, --surface #111113, --raised #18181B, --border #27272A, --bone #E9E6DF, --muted #8A8A93, --accent #7DD3FC, --ok #22C55E, --warn #F5B700, --bad #EF4444; fonts Space Grotesk / Inter / JetBrains Mono / Syncopate).



Work in this order: PART A (fixes) first, then PART B (animations). After each part, list what you changed. Do not refactor anything not listed.



\---



\## PART A: FIXES (do first)



1\. \*\*Demo data gating.\*\* All seed/demo rows (Priya Sharma etc.) must only be created when `DEMO\_MODE=true`. Default is false. In production mode the dashboard, orders, transactions, emails and analytics must start empty and show proper empty states.

2\. \*\*PUBLIC\_BASE\_URL.\*\* Add env var `PUBLIC\_BASE\_URL`. Use it for every pay link, QR link and redirect we generate. Never build URLs from the request Host header. Refuse to start if it is unset when `DEMO\_MODE` is false.

3\. \*\*Single status function.\*\* One backend function `status\_bucket(order)` returns exactly one of: success, pending, review, failed, expired. Every page (dashboard cards, donut, tables, filters, tabs, badges) must use it. Colors: success=ok, pending=warn, review=accent, failed/expired=bad.

4\. \*\*UTR uniqueness.\*\* Add a UNIQUE constraint on UTR (ignore empty). A duplicate UTR submission goes to Manual Review with a clear reason, never auto-approves.

5\. \*\*Revenue.\*\* Revenue and "collected" numbers come only from verified/success transactions. Never from pending, review or failed.

6\. \*\*Expiry.\*\* `expires\_at = created\_at + TTL` is stored once. Display and logic read that field only. Expired orders cannot be marked paid except by explicit manual review approval.

7\. \*\*Amount matching.\*\* Keep the paise-offset hold with a grace window after expiry so a late payment can still match.

8\. \*\*Login lockout.\*\* After 5 failed admin logins from one IP, lock for 15 minutes. Return the same generic error either way. Log attempts.

9\. \*\*ALLOW\_DB\_RESET.\*\* Enforce on the backend. If the env flag is not true, the reset endpoint returns 403 regardless of what the UI sends. Hide the button in the UI when disabled.

10\. \*\*Email sender allowlist.\*\* Only accept bank emails from an allowlisted From address AND where the Authentication-Results header shows dkim=pass (or spf=pass). Put both in config: `BANK\_FROM\_ALLOWLIST` and `REQUIRE\_DKIM`. Use placeholders for now. I will supply the real values. Do not hardcode guesses.

11\. \*\*Keep from earlier rounds:\*\* no example.com redirects visible, drawer works on mobile, times display correctly.



\---



\## PART B: MOTION SYSTEM



\### Global rules (apply to everything)

\- Animate ONLY `transform` and `opacity` (plus stroke-dashoffset on SVG and width/height for the progress bars where needed). Never animate layout properties on large areas.

\- Define CSS variables once: `--ease-out: cubic-bezier(.22,1,.36,1)`, `--ease-spring: cubic-bezier(.34,1.56,.64,1)`, `--dur-fast: 150ms`, `--dur: 280ms`, `--dur-slow: 600ms`.

\- Typical durations: hover/press 120-180ms, panels/drawers 280-350ms, page enter 400-500ms, hero draw-ins up to 900ms. Nothing blocks input.

\- \*\*`@media (prefers-reduced-motion: reduce)`\*\*: disable all keyframes, count-ups, parallax, particles and marching stripes. Show final states instantly. Keep only simple opacity fades.

\- Pause infinite animations (stripes, pulses, scan line) when the tab is hidden (`document.hidden`) or the element is offscreen (IntersectionObserver).

\- No animation libraries unless already in the project. Plain CSS + small vanilla JS (requestAnimationFrame for count-ups).

\- Build one shared `motion.js` + `motion.css` and reuse helpers (`countUp`, `staggerIn`, `toast`, `drawer`). Do not duplicate per page.



\### Login page

\- \*\*A1 Logo draw-in:\*\* the AV mark strokes draw in via stroke-dashoffset (\~900ms), then fills. The AVENTAS wordmark reveals letter by letter (40ms stagger, slight rise + fade).

\- \*\*A2 Hazard stripe:\*\* the yellow/black stripe band marches slowly and continuously (translateX loop, \~12s per cycle, linear). Subtle, pauses offscreen.

\- \*\*A4 Sign-in button:\*\* disabled until the key field is non-empty. When enabled it does a small spring "pop" (scale 1 to 1.04 to 1). On submit show an inline spinner and keep the button width stable. On wrong key, the card shakes horizontally (\~400ms) and the error line fades in.



\### Admin shell

\- \*\*A3 Card spotlight:\*\* stat cards and panels get a soft radial glow that follows the cursor (CSS vars --mx/--my set on pointermove, throttled via rAF). Desktop pointer devices only (`@media (hover:hover)`).

\- \*\*A5 Sidebar indicator:\*\* one active-indicator element that slides (translateY) between nav items rather than each item toggling its own highlight.

\- \*\*A6 Sidebar collapse:\*\* collapsing animates width + label fade; icons stay put; tooltips appear on hover when collapsed.

\- \*\*A7 Page enter stagger:\*\* on route change, direct children of the page fade-up (opacity 0 to 1, translateY 8px to 0), 40ms stagger, max 8 items.



\### Dashboard

\- \*\*A8 Count-up:\*\* stat numbers count up from 0 on first view (\~900ms, ease-out, tabular-nums so width does not jitter, INR formatting preserved). On live update the number flashes briefly (accent tint for 600ms) and animates from old to new value instead of jumping.

\- \*\*A9 Bar chart:\*\* bars grow from the baseline with a stagger on load. When the range (7d/30d/90d) changes, bars morph to the new heights rather than re-mounting. Hover shows a tooltip with a small fade/rise.

\- \*\*A10 Donut:\*\* segments draw in via stroke-dashoffset, keeping the gaps. Updates animate between values on live changes. Colors follow the status map.

\- \*\*A11 Live feed:\*\* new activity rows slide in from the top (translateY -12px, fade), pushing the others down smoothly. Max \~8 visible; the oldest fades out.

\- \*\*A12 Status dots:\*\* pending dots pulse (soft ring expanding and fading, 1.8s loop). Success dots do not pulse. Failed/expired are static.

\- \*\*A13 Segmented controls:\*\* the selected pill slides between options (single indicator element, 250ms ease-out).



\### Orders / Transactions / Emails tables

\- \*\*A14 Rows:\*\* rows stagger-fade in on load (30ms each, cap at the first 12). Hover lifts the row background and shows a thin accent bar on the left edge. The selected row keeps the bar. New rows from live updates flash the warn/accent tint once.

\- \*\*A15 Drawer:\*\* slides in from the right (translateX 100% to 0, 320ms ease-out) with a scrim that fades and blurs the background (backdrop-filter blur \~4px, drop the blur on low-power/mobile if janky). Esc and scrim click close it. Focus is trapped while open. Same shared component for orders, transactions and emails. Mobile: full-width sheet.

\- \*\*A16 Timeline:\*\* inside the drawer, timeline steps fill in sequentially (connector line grows, dot pops, 120ms between steps).



\### Manual Review

\- \*\*A17 Chat:\*\* typing indicator (three dots bouncing) appears before each incoming message; bubbles pop in (scale .96 to 1 + fade). Respect the real message timestamps.

\- \*\*A18 UTR mismatch warning:\*\* the warning banner drops in from above, does one short horizontal shake, then holds a faint warn-colored glow. Approve is a two-step confirm (button morphs into "Confirm approve" with a 3s timeout back).



\### Customer pay page

\- \*\*A19 QR:\*\* the QR modules wave in diagonally (opacity stagger from the top-left corner), then a thin scan line sweeps once top to bottom. Idle: scan line repeats every \~6s, subtle. Keep the QR fully scannable. Animate a wrapper/overlay, never distort the QR itself. Contrast must stay high.

\- \*\*A20 Countdown:\*\* a progress bar shrinks with time left. Below 60s it turns --bad and the digits pulse gently once per second.

\- \*\*A21 Success:\*\* a circular checkmark draws itself (stroke-dashoffset), then a short particle burst (about 16 small particles, 700ms, canvas or absolutely positioned spans, auto-cleaned). Then the amount and UTR fade up.

\- \*\*A22 Expired:\*\* the clock icon does a quick shake then settles. The message fades in. The QR dims/blurs slightly.

\- \*\*A25 Back to merchant:\*\* the button has a fill that sweeps left to right over the auto-redirect countdown (e.g. 5s). Clicking skips immediately. The redirect target comes from the order's configured return URL, validated against allowed merchant domains.



\### Global components

\- \*\*A23 Toasts:\*\* stack bottom-right (bottom-center on mobile). Slide up + fade in, auto-dismiss in 4s with a thin progress line, swipe/click to dismiss, max 3 stacked. Icons follow the status colors.

\- \*\*A24 Settings toggles + unsaved bar:\*\* toggles use a spring thumb slide. When any setting changes, a sticky "Unsaved changes" bar slides up from the bottom with Discard / Save. Save shows a spinner then collapses with a success toast. Discard reverts the controls with a quick reverse transition.



\---



\## ACCEPTANCE CHECKLIST (verify each before saying done)

\- \[ ] Production mode (DEMO\_MODE unset) shows no fake data anywhere and proper empty states.

\- \[ ] Every number on every page agrees (one status function, one revenue rule).

\- \[ ] Lighthouse/Performance: no layout-shift from animations, no jank scrolling the tables, and animations idle at near-zero CPU when the tab is hidden.

\- \[ ] `prefers-reduced-motion` turns everything off cleanly (test via devtools emulation).

\- \[ ] QR is still scannable during and after A19.

\- \[ ] Drawer: Esc closes, focus trapped, mobile full-width.

\- \[ ] Wrong key shake works, empty key keeps the button disabled.

\- \[ ] A1-A25 each present where listed. Report any you skipped and why.

\- \[ ] Nothing outside this list was changed.



At the end, give me a short list of: what changed, what you skipped, and any decisions you need from me (especially the bank From address and DKIM/SPF settings).

