// Injection SEO côté product.html — JSON-LD Product + meta OG dynamiques.
// À include en fin de <body> de product.html : <script src="/product-seo.js" defer></script>
//
// Lit window.PRODUCT (objet déjà construit côté product.html) ou les data-attrs DOM si absent.
// Fetch les reviews publiées via /.netlify/functions/reviews?pid=… et ajoute aggregateRating.

(async function () {
  // Trouve le produit courant : window.PRODUCT > data-pid > URL ?id=
  const url = new URL(location.href);
  const pid = window.PRODUCT?.pid || document.body.dataset.pid || url.searchParams.get('id');
  if (!pid) return;

  const p = window.PRODUCT || {};
  const title = p.title || document.title.replace(' — TALSEUME', '');
  const desc = p.description || document.querySelector('meta[name="description"]')?.content || '';
  const price = p.price || Number(document.querySelector('[data-price]')?.dataset.price) || null;
  const image = p.image || document.querySelector('meta[property="og:image"]')?.content || `https://talseume.com/images/products/${pid}/01.webp`;
  const inStock = p.inStock !== false;

  // Reviews aggregate
  let aggregateRating = null;
  try {
    const r = await fetch(`/.netlify/functions/reviews?pid=${encodeURIComponent(pid)}`);
    const d = await r.json();
    if (d.count >= 1) {
      aggregateRating = { '@type': 'AggregateRating', ratingValue: d.average, reviewCount: d.count, bestRating: 5, worstRating: 1 };
    }
  } catch {}

  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: title,
    image: Array.isArray(image) ? image : [image],
    description: desc,
    sku: pid,
    brand: { '@type': 'Brand', name: 'Talseume' },
    offers: {
      '@type': 'Offer',
      url: `https://talseume.com/product.html?id=${pid}`,
      priceCurrency: 'EUR',
      price: price ? String(price) : '0',
      availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: 'Talseume' }
    }
  };
  if (aggregateRating) ld.aggregateRating = aggregateRating;

  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.id = 'ld-product';
  script.textContent = JSON.stringify(ld);
  document.head.appendChild(script);

  // Meta OG / Twitter (idempotent : ne pas dupliquer si déjà présents)
  const setMeta = (selector, attr, key, value) => {
    let el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.setAttribute('content', value);
  };
  setMeta('meta[property="og:type"]', 'property', 'og:type', 'product');
  setMeta('meta[property="og:title"]', 'property', 'og:title', `${title} — TALSEUME`);
  setMeta('meta[property="og:description"]', 'property', 'og:description', desc);
  setMeta('meta[property="og:image"]', 'property', 'og:image', image);
  setMeta('meta[property="og:url"]', 'property', 'og:url', `https://talseume.com/product.html?id=${pid}`);
  setMeta('meta[property="product:price:amount"]', 'property', 'product:price:amount', String(price || ''));
  setMeta('meta[property="product:price:currency"]', 'property', 'product:price:currency', 'EUR');
  setMeta('meta[name="twitter:card"]', 'name', 'twitter:card', 'summary_large_image');
  setMeta('meta[name="twitter:title"]', 'name', 'twitter:title', `${title} — TALSEUME`);
  setMeta('meta[name="twitter:description"]', 'name', 'twitter:description', desc);
  setMeta('meta[name="twitter:image"]', 'name', 'twitter:image', image);
})();
