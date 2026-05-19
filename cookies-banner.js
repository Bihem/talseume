/* ════════════════════════════════════════════════════════════════
   Talseume — Bannière cookies (CNIL-compliant)
   Auto-injection du markup, consentement granulaire persisté.
   API publique : window.tlsCookieConsent
     .get()        → renvoie {essentials, analytics, marketing, ts} | null
     .acceptAll()  → coche tout
     .refuseAll()  → ne coche que les essentiels
     .openPrefs()  → ouvre le modal granulaire
     .savePrefs()  → enregistre depuis l'UI du modal
     .reset()      → efface le choix (rouvre la bannière)
   Évènement : document.addEventListener('tls-consent-update', e => e.detail)
   ════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  var STORAGE_KEY = 'tls-cookies-v2';

  var BANNER_HTML =
    '<div id="tls-cookie-banner" role="dialog" aria-label="Consentement aux cookies">' +
      '<div class="tls-cb-text">' +
        '<strong>Cookies</strong>' +
        '<p>Talseume utilise des cookies pour mesurer l\'audience et améliorer ton expérience. Tu peux accepter, refuser ou personnaliser. Plus d\'infos dans notre <a href="/cookies.html">politique cookies</a>.</p>' +
      '</div>' +
      '<div class="tls-cb-actions">' +
        '<button type="button" class="tls-cb-btn" data-action="refuse">Tout refuser</button>' +
        '<button type="button" class="tls-cb-btn" data-action="prefs">Personnaliser</button>' +
        '<button type="button" class="tls-cb-btn is-primary" data-action="accept">Tout accepter</button>' +
      '</div>' +
    '</div>';

  var PREFS_HTML =
    '<div id="tls-cookie-prefs" role="dialog" aria-modal="true" aria-label="Préférences cookies">' +
      '<div class="tls-cp-backdrop" data-action="close-prefs"></div>' +
      '<div class="tls-cp-modal">' +
        '<button type="button" class="tls-cp-close" data-action="close-prefs" aria-label="Fermer">×</button>' +
        '<h3>Préférences cookies</h3>' +
        '<p>Choisis les finalités pour lesquelles tu nous autorises à utiliser des cookies. Tu peux modifier ton choix à tout moment depuis la page <a href="/cookies.html">Cookies</a>.</p>' +
        '<div class="tls-cp-cat">' +
          '<div class="tls-cp-cat-header">' +
            '<strong>Essentiels</strong>' +
            '<span class="tls-cp-locked">Toujours actifs</span>' +
          '</div>' +
          '<p>Nécessaires au fonctionnement du site (panier, favoris, mémorisation du consentement). Ne peuvent pas être désactivés.</p>' +
        '</div>' +
        '<div class="tls-cp-cat">' +
          '<div class="tls-cp-cat-header">' +
            '<strong>Mesure d\'audience</strong>' +
            '<label class="tls-cp-switch"><input type="checkbox" data-pref="analytics" aria-label="Activer la mesure d\'audience"><span class="tls-cp-slider"></span></label>' +
          '</div>' +
          '<p>Statistiques anonymes (pages vues, parcours) pour comprendre comment le site est utilisé et l\'améliorer.</p>' +
        '</div>' +
        '<div class="tls-cp-cat">' +
          '<div class="tls-cp-cat-header">' +
            '<strong>Marketing &amp; personnalisation</strong>' +
            '<label class="tls-cp-switch"><input type="checkbox" data-pref="marketing" aria-label="Activer le marketing"><span class="tls-cp-slider"></span></label>' +
          '</div>' +
          '<p>Personnalisation de l\'expérience et publicité ciblée sur d\'autres sites (Meta, Google Ads).</p>' +
        '</div>' +
        '<div class="tls-cp-actions">' +
          '<button type="button" class="tls-cb-btn" data-action="refuse">Tout refuser</button>' +
          '<button type="button" class="tls-cb-btn is-primary" data-action="save-prefs">Enregistrer mes choix</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  function readStorage(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }
  function writeStorage(prefs){
    var data = {
      essentials: true,
      analytics: !!prefs.analytics,
      marketing: !!prefs.marketing,
      ts: Date.now()
    };
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }catch(e){}
    document.dispatchEvent(new CustomEvent('tls-consent-update', {detail: data}));
    return data;
  }

  function showBanner(){
    var b = document.getElementById('tls-cookie-banner');
    if(!b) return;
    b.style.display = 'grid';
    requestAnimationFrame(function(){ b.classList.add('show'); });
  }
  function hideBanner(){
    var b = document.getElementById('tls-cookie-banner');
    if(!b) return;
    b.classList.remove('show');
    setTimeout(function(){ b.style.display = 'none'; }, 400);
  }
  function openPrefs(){
    var cur = readStorage() || {analytics:false, marketing:false};
    document.querySelectorAll('#tls-cookie-prefs input[data-pref]').forEach(function(i){
      i.checked = !!cur[i.dataset.pref];
    });
    var m = document.getElementById('tls-cookie-prefs');
    if(!m) return;
    m.classList.add('show');
    document.body.style.overflow = 'hidden';
  }
  function closePrefs(){
    var m = document.getElementById('tls-cookie-prefs');
    if(!m) return;
    m.classList.remove('show');
    document.body.style.overflow = '';
  }

  var api = {
    get: readStorage,
    acceptAll: function(){
      writeStorage({analytics:true, marketing:true});
      hideBanner(); closePrefs();
    },
    refuseAll: function(){
      writeStorage({analytics:false, marketing:false});
      hideBanner(); closePrefs();
    },
    openPrefs: openPrefs,
    closePrefs: closePrefs,
    savePrefs: function(){
      var prefs = {};
      document.querySelectorAll('#tls-cookie-prefs input[data-pref]').forEach(function(i){
        prefs[i.dataset.pref] = i.checked;
      });
      writeStorage(prefs);
      hideBanner();
      closePrefs();
    },
    reset: function(){
      try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
      showBanner();
    }
  };

  function init(){
    // Nettoyer ancienne bannière inline si encore présente
    var legacy = document.getElementById('cookie-wrap');
    if(legacy) legacy.remove();
    try{ localStorage.removeItem('tls-cookies'); }catch(e){}

    // Injecter le markup (une seule fois)
    if(!document.getElementById('tls-cookie-banner')){
      var wrap = document.createElement('div');
      wrap.innerHTML = BANNER_HTML + PREFS_HTML;
      while(wrap.firstChild) document.body.appendChild(wrap.firstChild);
    }

    // Event delegation
    document.addEventListener('click', function(e){
      var t = e.target.closest('[data-action]');
      if(!t) return;
      var action = t.dataset.action;
      if(action === 'accept') api.acceptAll();
      else if(action === 'refuse') api.refuseAll();
      else if(action === 'prefs') api.openPrefs();
      else if(action === 'save-prefs') api.savePrefs();
      else if(action === 'close-prefs') api.closePrefs();
      else if(action === 'open-cookie-prefs'){ e.preventDefault(); api.openPrefs(); }
      else if(action === 'reset-cookies'){ e.preventDefault(); api.reset(); }
    });

    // Close on ESC
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape'){
        var m = document.getElementById('tls-cookie-prefs');
        if(m && m.classList.contains('show')) api.closePrefs();
      }
    });

    // Show banner if no consent yet
    if(!readStorage()){
      showBanner();
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  }else{
    init();
  }

  window.tlsCookieConsent = api;
})();
