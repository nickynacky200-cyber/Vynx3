if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => initPush())
      .catch((err) => console.warn('SW registration failed', err));
  });
}

// Chrome/Android fire this instead of showing their own install banner, so
// we can show our own prompt (an in-page banner + the ⬇️ button on
// Profile) at a moment that makes sense in-app rather than a random
// browser-chrome interruption.
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  document.querySelectorAll('.install-app-btn').forEach((btn) => btn.classList.remove('hidden'));
  showInstallBanner();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  document.querySelectorAll('.install-app-btn').forEach((btn) => btn.classList.add('hidden'));
  hideInstallBanner();
  localStorage.removeItem('vynx_install_dismissed_at');
});

// Call this from a button's onclick to trigger the native install prompt.
// No-ops safely (and hides the button) on iOS Safari, which has no
// beforeinstallprompt — there, "Add to Home Screen" is a manual Share
// menu action instead.
async function promptInstallApp() {
  if (!deferredInstallPrompt) return;
  hideInstallBanner();
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
}

// A dismissible banner (not just the small Profile-page button) so the
// install option is actually visible where people land, per the request
// for something that "pops up" rather than a hidden icon. Re-appears
// after a week if dismissed, since a one-time permanent dismissal would
// bury the option entirely for someone who just wasn't ready yet.
function showInstallBanner() {
  if (document.getElementById('pwaInstallBanner')) return;
  if (window.matchMedia('(display-mode: standalone)').matches) return; // already installed

  const dismissedAt = Number(localStorage.getItem('vynx_install_dismissed_at') || 0);
  if (Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000) return;

  const banner = document.createElement('div');
  banner.id = 'pwaInstallBanner';
  banner.className = 'pwa-install-banner';
  banner.innerHTML = `
    <span class="pwa-install-banner-icon">${typeof Icon !== 'undefined' ? Icon.svg('install', 18) : ''}</span>
    <span class="pwa-install-banner-text">Install Vynx for the full-screen app experience</span>
    <button class="pwa-install-banner-install">Install</button>
    <button class="pwa-install-banner-close" aria-label="Dismiss">${typeof Icon !== 'undefined' ? Icon.svg('x', 14) : '\u2715'}</button>
  `;
  document.body.appendChild(banner);
  banner.querySelector('.pwa-install-banner-install').addEventListener('click', promptInstallApp);
  banner.querySelector('.pwa-install-banner-close').addEventListener('click', () => {
    localStorage.setItem('vynx_install_dismissed_at', String(Date.now()));
    hideInstallBanner();
  });
}

function hideInstallBanner() {
  document.getElementById('pwaInstallBanner')?.remove();
}

// --- Web Push: ask permission and subscribe once someone's logged in ---
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function initPush() {
  if (!('PushManager' in window) || !('Notification' in window)) return; // not supported (e.g. iOS < 16.4)
  if (typeof Api === 'undefined') return;

  const firebaseUser = await Api.ready();
  if (!firebaseUser) return; // only subscribe once logged in

  // Don't interrupt with the permission prompt on every single page load —
  // only ask if we haven't asked (or the person hasn't decided) yet.
  if (Notification.permission === 'denied') return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) return; // already subscribed on this device

    if (Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
    }

    const keyRes = await fetch('/api/push/public-key');
    const { publicKey } = await keyRes.json();
    if (!publicKey) return; // server hasn't configured VAPID keys yet

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await Api.call('/users/me/push-subscribe', { method: 'POST', body: subscription.toJSON() });
  } catch (err) {
    console.warn('Push subscription failed', err);
  }
}
