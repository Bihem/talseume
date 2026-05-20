// Sitemap.xml généré dynamiquement à partir des produits + drops + pages CMS.
// Route via netlify.toml : /sitemap.xml → cette fonction.

const https = require('https');
const crypto = require('crypto');

const STATIC_PAGES = [
  { loc: '/', changefreq: 'weekly', priority: 1.0 },
  { loc: '/blog.html', changefreq: 'monthly', priority: 0.7 },
  { loc: '/contact.html', changefreq: 'yearly', priority: 0.6 },
  { loc: '/faq.html', changefreq: 'monthly', priority: 0.7 },
  { loc: '/guide-tailles.html', changefreq: 'yearly', priority: 0.6 },
  { loc: '/livraison-retours.html', changefreq: 'yearly', priority: 0.6 },
  { loc: '/suivi-commande.html', changefreq: 'yearly', priority: 0.5 },
  { loc: '/favoris.html', changefreq: 'yearly', priority: 0.4 },
  { loc: '/retour.html', changefreq: 'yearly', priority: 0.4 },
  { loc: '/avis.html', changefreq: 'yearly', priority: 0.4 },
  { loc: '/cgv.html', changefreq: 'yearly', priority: 0.3 },
  { loc: '/confidentialite.html', changefreq: 'yearly', priority: 0.3 },
  { loc: '/cookies.html', changefreq: 'yearly', priority: 0.3 },
  { loc: '/mentions-legales.html', changefreq: 'yearly', priority: 0.3 }
];

const DEFAULT_PRODUCTS = [
  'sweat-talseume-oversize','sweat-bikelife','tee-shirt-oversize','tshirt-manches-longues',
  'veste-coach','debardeur-femme','tshirt-femme','cagoule','sport-beanie','casquette-trucker','talseume-bag'
];

function signInternalToken() {
  const exp = Date.now() + 60_000;
  const payload = `admin:${exp}`;
  const sig = crypto.createHmac('sha256', process.env.ADMIN_SECRET || 'change-me').update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}
function callOwn(path) {
  const token = signInternalToken();
  return new Promise(resolve => {
    const req = https.request({ hostname: 'talseume.com', path, method: 'GET', headers: { 'Authorization': `Bearer ${token}` } }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on('error', () => resolve({ error: true }));
    req.end();
  });
}

exports.handler = async () => {
  // Récupère overrides (pour trouver tous les produits actuels) + drops
  let products = DEFAULT_PRODUCTS.slice();
  let drops = [];
  let collections = [];
  try {
    const ov = await callOwn('/.netlify/functions/admin-data?file=products-overrides');
    const overrides = (ov.body && ov.body.data && ov.body.data.overrides) || {};
    const ids = Object.keys(overrides);
    if (ids.length) products = [...new Set([...products, ...ids])];
  } catch {}
  try {
    const d = await callOwn('/.netlify/functions/admin-data?file=drops');
    drops = ((d.body && d.body.data && d.body.data.drops) || []).filter(x => x.status === 'live');
  } catch {}
  try {
    const c = await callOwn('/.netlify/functions/admin-data?file=collections');
    collections = ((c.body && c.body.data && c.body.data.collections) || []);
  } catch {}

  const today = new Date().toISOString().slice(0, 10);
  const urls = [];

  STATIC_PAGES.forEach(p => urls.push({ loc: `https://talseume.com${p.loc}`, lastmod: today, changefreq: p.changefreq, priority: p.priority }));
  products.forEach(id => urls.push({ loc: `https://talseume.com/product.html?id=${id}`, lastmod: today, changefreq: 'weekly', priority: 0.9 }));
  drops.forEach(d => d.slug && urls.push({ loc: `https://talseume.com/drop/${d.slug}`, lastmod: today, changefreq: 'daily', priority: 0.95 }));
  collections.forEach(c => c.slug && urls.push({ loc: `https://talseume.com/collection/${c.slug}`, lastmod: today, changefreq: 'weekly', priority: 0.8 }));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    body: xml
  };
};
