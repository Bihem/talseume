// Reviews / avis produits.
//
// POST (public)        : { orderId, email, pid, rating (1-5), title, body, fit? }
//   → vérifie session Stripe + email, crée review dans /data/reviews.json (status:pending)
//
// GET (public)         : ?pid=xxx → liste reviews publiées pour un produit
// GET (admin)          : ?all=1 → liste TOUTES les reviews (modération)
//
// PATCH (admin)        : { id, status: 'published'|'rejected' }

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');
const crypto = require('crypto');
const { validateAdminToken } = require('./admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Content-Type': 'application/json'
};

function signInternalToken() {
  const exp = Date.now() + 60_000;
  const payload = `admin:${exp}`;
  const sig = crypto.createHmac('sha256', process.env.ADMIN_SECRET || 'change-me').update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}
function callOwn(path, payload, method = 'POST') {
  const token = signInternalToken();
  const body = payload ? JSON.stringify(payload) : null;
  return new Promise(resolve => {
    const opts = { hostname: 'talseume.com', path, method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on('error', e => resolve({ error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}
const getFile = (f) => callOwn(`/.netlify/functions/admin-data?file=${f}`, null, 'GET');
const putFile = (f, data, message) => callOwn(`/.netlify/functions/admin-data?file=${f}`, { data, message }, 'PUT');

const rid = () => 'rv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

async function loadReviews() {
  const r = await getFile('reviews');
  const data = (r.body && r.body.data) || { reviews: [] };
  if (!Array.isArray(data.reviews)) data.reviews = [];
  return data;
}
const saveReviews = (d, msg) => putFile('reviews', d, msg);

function publicShape(r) {
  return {
    id: r.id, pid: r.pid, rating: r.rating, title: r.title, body: r.body, fit: r.fit,
    firstName: r.firstName || (r.email || '').split('@')[0],
    createdAt: r.createdAt, verified: true
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  const qs = event.queryStringParameters || {};

  try {
    // ── POST public ──
    if (event.httpMethod === 'POST') {
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }; }
      const { orderId, email, pid, rating, title, body, fit } = payload;
      if (!orderId || !email || !pid || !rating) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'fields_required' }) };
      }
      const ratingN = Number(rating);
      if (!(ratingN >= 1 && ratingN <= 5)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_rating' }) };

      // Vérif Stripe + email match + commande payée
      let session;
      try { session = await stripe.checkout.sessions.retrieve(orderId, { expand: ['line_items'] }); }
      catch { return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'order_not_found' }) }; }
      if (session.payment_status !== 'paid') return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'order_not_paid' }) };
      const sessionEmail = (session.customer_details?.email || '').toLowerCase();
      if (sessionEmail !== email.toLowerCase()) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'email_mismatch' }) };

      const data = await loadReviews();
      // 1 review max par (orderId, pid)
      const dup = data.reviews.find(r => r.orderId === orderId && r.pid === pid);
      if (dup) return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'already_reviewed' }) };

      const review = {
        id: rid(),
        orderId,
        pid: String(pid),
        email: email.toLowerCase(),
        firstName: (session.customer_details?.name || '').split(' ')[0] || '',
        rating: ratingN,
        title: String(title || '').slice(0, 100),
        body: String(body || '').slice(0, 1500),
        fit: fit ? String(fit).slice(0, 30) : null,
        status: 'pending',
        createdAt: Date.now()
      };
      data.reviews.unshift(review);
      await saveReviews(data, `review: + ${review.id} (pending)`);
      return { statusCode: 201, headers: CORS, body: JSON.stringify({ ok: true, id: review.id }) };
    }

    // ── GET public ?pid=xxx ──
    if (event.httpMethod === 'GET' && !qs.all) {
      if (!qs.pid) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'pid_required' }) };
      const data = await loadReviews();
      const list = data.reviews.filter(r => r.pid === qs.pid && r.status === 'published').map(publicShape);
      const avg = list.length ? Math.round((list.reduce((s, r) => s + r.rating, 0) / list.length) * 10) / 10 : null;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ pid: qs.pid, count: list.length, average: avg, reviews: list }) };
    }

    // ── GET admin ?all=1 ──
    if (event.httpMethod === 'GET' && qs.all) {
      if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
      const data = await loadReviews();
      return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
    }

    // ── PATCH admin (modération) ──
    if (event.httpMethod === 'PATCH') {
      if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }; }
      const { id, status, adminReply } = payload;
      if (!id || !['published', 'rejected', 'pending'].includes(status)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'bad_params' }) };
      }
      const data = await loadReviews();
      const r = data.reviews.find(x => x.id === id);
      if (!r) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'not_found' }) };
      r.status = status;
      if (adminReply !== undefined) r.adminReply = String(adminReply).slice(0, 800);
      r.moderatedAt = Date.now();
      await saveReviews(data, `review ${id}: ${status}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, review: r }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
