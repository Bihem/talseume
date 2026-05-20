// Tracking marketing centralisé · gating RGPD via cookies-banner.
// À include dans <head> de chaque page : <script src="/tracking.js" defer></script>
//
// Charge la config depuis /data/tracking-config.json puis active les pixels SEULEMENT après consentement.
// Écoute l'événement tls-consent-update (émis par cookies-banner.js).

(function () {
  const HOST = 'https://talseume.com';
  let config = null;
  let loaded = { meta: false, tiktok: false, ga4: false, googleAds: false };

  async function loadConfig() {
    if (config) return config;
    try {
      const res = await fetch('/data/tracking-config.json', { cache: 'no-store' });
      config = await res.json();
    } catch {
      config = { enabled: false };
    }
    return config;
  }

  function consentGranted(category) {
    const c = window.tlsCookieConsent;
    if (!c) return false;
    return c.has ? c.has(category) : (c[category] === true);
  }

  function activateMeta(id) {
    if (loaded.meta || !id) return;
    loaded.meta = true;
    !function (f, b, e, v) { if (f.fbq) return; const n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; const t = b.createElement(e); t.async = !0; t.src = v; const s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s) }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', id);
    window.fbq('track', 'PageView');
  }

  function activateTikTok(id) {
    if (loaded.tiktok || !id) return;
    loaded.tiktok = true;
    !function (w, d, t) { w.TiktokAnalyticsObject = t; const ttq = w[t] = w[t] || []; ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent']; ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } }; for (let i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]); ttq.instance = function (t) { const e = ttq._i[t] || []; for (let n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e }; ttq.load = function (e, n) { const r = 'https://analytics.tiktok.com/i18n/pixel/events.js'; ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r; ttq._t = ttq._t || {}; ttq._t[e] = +new Date; ttq._o = ttq._o || {}; ttq._o[e] = n || {}; const o = document.createElement('script'); o.type = 'text/javascript'; o.async = !0; o.src = r + '?sdkid=' + e + '&lib=' + t; const a = document.getElementsByTagName('script')[0]; a.parentNode.insertBefore(o, a) }; ttq.load(id); ttq.page(); }(window, document, 'ttq');
  }

  function activateGA4(id) {
    if (loaded.ga4 || !id) return;
    loaded.ga4 = true;
    const s = document.createElement('script');
    s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id, { anonymize_ip: true });
  }

  function activateGoogleAds(id) {
    if (loaded.googleAds || !id) return;
    loaded.googleAds = true;
    // Si GA4 déjà chargé, gtag réutilise le même script
    if (!window.gtag) {
      const s = document.createElement('script');
      s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
      document.head.appendChild(s);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
    }
    window.gtag('config', id);
  }

  async function apply() {
    const c = await loadConfig();
    if (!c.enabled) return;

    // Catégorie statistiques (GA4) vs marketing (Meta, TikTok, Google Ads)
    if (consentGranted('analytics') && c.ga4Id) activateGA4(c.ga4Id);
    if (consentGranted('marketing')) {
      if (c.metaPixelId) activateMeta(c.metaPixelId);
      if (c.tiktokPixelId) activateTikTok(c.tiktokPixelId);
      if (c.googleAdsId) activateGoogleAds(c.googleAdsId);
    }
  }

  // Trigger initial + sur changement de consentement
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
  window.addEventListener('tls-consent-update', apply);

  // Helper public pour tracker des events depuis le code (purchase, add_to_cart, etc.)
  window.tlsTrack = function (eventName, params) {
    params = params || {};
    if (window.fbq) window.fbq('track', eventName, params);
    if (window.ttq) window.ttq.track(eventName, params);
    if (window.gtag) window.gtag('event', eventName, params);
  };
})();
