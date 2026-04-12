// VIGIL Trust Score — Polymarket Content Script
// Detects wallet addresses on Polymarket profile pages and injects trust badges.

const VIGIL_API = 'https://vigil-trust-api.onrender.com/v1/polymarket';
const VIGIL_SITE = 'https://vigil-trust-api.onrender.com/polymarket';
const CACHE = new Map();     // wallet → score data
const INJECTED = new WeakSet(); // elements already badged

// Extract wallet from Polymarket URL patterns
function getWalletFromUrl() {
  const path = window.location.pathname;
  // /profile/0x... or /portfolio/0x...
  const match = path.match(/\/(profile|portfolio)\/(0x[a-fA-F0-9]{40})/);
  if (match) return match[2].toLowerCase();
  return null;
}

// Extract wallet from page content (profile pages show wallet address)
function findWalletOnPage() {
  // Look for wallet addresses in the page text
  const walletRegex = /0x[a-fA-F0-9]{40}/g;
  const bodyText = document.body.innerText;
  const matches = bodyText.match(walletRegex);
  if (matches && matches.length > 0) return matches[0].toLowerCase();
  return null;
}

// Fetch VIGIL score for a wallet
async function fetchVigilScore(wallet) {
  if (CACHE.has(wallet)) return CACHE.get(wallet);

  try {
    const res = await fetch(`${VIGIL_API}/${wallet}`);
    if (!res.ok) return null;
    const data = await res.json();
    CACHE.set(wallet, data);
    return data;
  } catch (e) {
    console.warn('[VIGIL] Score fetch failed:', e.message);
    return null;
  }
}

// Create the badge HTML
function createBadge(data, wallet) {
  const wrapper = document.createElement('div');
  wrapper.className = 'vigil-badge-wrapper';

  const grade = data.trustGrade || 'F';
  const score = data.trustScore ?? 0;
  const tier = data.trustTier || 'UNKNOWN';

  // Main badge
  const badge = document.createElement('a');
  badge.className = `vigil-badge vigil-badge-${grade}`;
  badge.href = `${VIGIL_SITE}/${wallet}`;
  badge.target = '_blank';
  badge.rel = 'noopener';
  badge.innerHTML = `
    <span class="vigil-grade-circle">${grade}</span>
    <span class="vigil-score-text">VIGIL ${score}/100</span>
  `;

  // Tooltip card
  const tooltip = document.createElement('div');
  tooltip.className = 'vigil-tooltip';

  const pnl = data.totalPnl || 0;
  const pnlStr = pnl >= 0 ? `+$${Math.round(pnl).toLocaleString()}` : `-$${Math.round(Math.abs(pnl)).toLocaleString()}`;
  const resolved = data.resolvedBets || 0;
  const liveEdge = data.liveEdge ?? '-';
  const calibration = data.calibration ?? '-';

  // Build flag HTML
  const flagsHtml = (data.flags || []).slice(0, 3).map(f =>
    `<div class="vigil-flag vigil-flag-red">\u26A0 ${f.length > 60 ? f.slice(0, 57) + '...' : f}</div>`
  ).join('');
  const greenHtml = (data.greenFlags || []).slice(0, 2).map(f =>
    `<div class="vigil-flag vigil-flag-green">\u2713 ${f.length > 60 ? f.slice(0, 57) + '...' : f}</div>`
  ).join('');

  tooltip.innerHTML = `
    <div class="vigil-tooltip-header">VIGIL Trust Score: ${grade} / ${score}</div>
    <div class="vigil-tooltip-row"><span class="vigil-tooltip-label">Tier</span><span class="vigil-tooltip-val">${tier}</span></div>
    <div class="vigil-tooltip-row"><span class="vigil-tooltip-label">PnL</span><span class="vigil-tooltip-val" style="color:${pnl >= 0 ? '#10b981' : '#ef4444'}">${pnlStr}</span></div>
    <div class="vigil-tooltip-row"><span class="vigil-tooltip-label">Resolved Bets</span><span class="vigil-tooltip-val">${resolved}</span></div>
    <div class="vigil-tooltip-row"><span class="vigil-tooltip-label">Calibration</span><span class="vigil-tooltip-val">${calibration}/100</span></div>
    <div class="vigil-tooltip-row"><span class="vigil-tooltip-label">Live Edge</span><span class="vigil-tooltip-val">${liveEdge}/100</span></div>
    ${(flagsHtml || greenHtml) ? `<div class="vigil-tooltip-flags">${greenHtml}${flagsHtml}</div>` : ''}
    <a class="vigil-tooltip-cta" href="${VIGIL_SITE}/${wallet}" target="_blank" rel="noopener">View Full Scorecard \u2192</a>
  `;

  wrapper.appendChild(badge);
  wrapper.appendChild(tooltip);
  return wrapper;
}

// Find the best injection point on Polymarket profile pages
function findInjectionPoint() {
  // Look for username/display name headers on profile pages
  // Polymarket uses various layouts — try common selectors
  const selectors = [
    'h1', 'h2',
    '[class*="ProfileHeader"]',
    '[class*="username"]',
    '[class*="displayName"]',
    '[class*="profile"] h1',
    '[class*="profile"] h2',
    '[data-testid*="profile"]',
  ];

  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el.textContent.trim().length > 0 && el.textContent.trim().length < 50) {
        if (!INJECTED.has(el)) return el;
      }
    }
  }
  return null;
}

// Main injection logic
async function injectVigilBadge() {
  const wallet = getWalletFromUrl() || findWalletOnPage();
  if (!wallet) return;

  const injectionPoint = findInjectionPoint();
  if (!injectionPoint) return;
  if (INJECTED.has(injectionPoint)) return;

  INJECTED.add(injectionPoint);

  // Show loading badge immediately
  const loadingBadge = document.createElement('span');
  loadingBadge.className = 'vigil-badge vigil-badge-loading';
  loadingBadge.textContent = 'VIGIL ...';
  injectionPoint.appendChild(loadingBadge);

  // Fetch real score
  const data = await fetchVigilScore(wallet);
  loadingBadge.remove();

  if (data) {
    const badge = createBadge(data, wallet);
    injectionPoint.appendChild(badge);
  }
}

// Run on page load and on SPA navigation (Polymarket is a React SPA)
function init() {
  injectVigilBadge();

  // Re-check on URL changes (SPA navigation)
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Small delay for React to render new page
      setTimeout(injectVigilBadge, 1500);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// Wait for page to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
