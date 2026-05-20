// Workflow retours / échanges.
//
// Endpoints :
//   POST /.netlify/functions/returns  (public)
//     body: { orderId, email, reason, items: [{ pid, size, qty, action: 'refund'|'exchange', newSize? }] }
//     → vérifie la session Stripe + email, crée une demande dans /data/returns.json (status: 'demande')
//        + envoie return_accepted email avec adresse retour
//
//   GET /.netlify/functions/returns  (admin)
//     → liste toutes les demandes
//
//   PATCH /.netlify/functions/returns  (admin)
//     body: { id, status: 'accepte'|'recu'|'rembourse'|'refuse', refundAmount? }
//     → met à jour le statut + déclenche emails + actions (refund Stripe + restock)

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

async function loadReturns() {
  const r = await getFile('returns');
  const data = (r.body && r.body.data) || { returns: [] };
  if (!Array.isArray(data.returns)) data.returns = [];
  return data;
}
async function saveReturns(data, msg) { return putFile('returns', data, msg); }

function rid() { return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Restock : appelle l'API stock (réincrémente)
async function restockItems(items) {
  if (!items || !items.length) return { updated: 0 };
  const r = await getFile('products-stock');
  const current = (r.body && r.body.data) || { stock: {} };
  if (!current.stock) current.stock = {};
  let updated = 0;
  for (const it of items) {
    if (!it.pid || !it.size) continue;
    if (!current.stock[it.pid]) current.stock[it.pid] = {};
    const before = Number(current.stock[it.pid][it.size] || 0);
    current.stock[it.pid][it.size] = before + Number(it.qty || 1);
    updated++;
  }
  if (updated) await putFile('products-stock', current, `returns restock ×${updated}`);
  return { updated };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  try {
    // ── POST : demande de retour côté client (PUBLIC, vérif via email + Stripe) ──
    if (event.httpMethod === 'POST') {
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }; }
      const { orderId, email, reason, items } = payload;
      if (!orderId || !email || !reason || !items || !items.length) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'fields_required', need: ['orderId', 'email', 'reason', 'items'] }) };
      }

      // Vérif session existe + email correspond
      let session;
      try { session = await stripe.checkout.sessions.retrieve(orderId); }
      catch { return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'order_not_found' }) }; }

      const sessionEmail = session.customer_details?.email || '';
      if (sessionEmail.toLowerCase() !== email.toLowerCase()) {
        return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'email_mismatch' }) };
      }
      if (session.payment_status !== 'paid') {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'order_not_paid' }) };
      }

      // Délai légal 14 jours art. L221-18 conso
      const orderAge = (Date.now() - session.created * 1000) / (1000 * 60 * 60 * 24);
      if (orderAge > 30) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'return_window_expired', detail: 'Délai de retour dépassé (30 jours).' }) };
      }

      // Anti-doublon
      const data = await loadReturns();
      const dup = data.returns.find(r => r.orderId === orderId && r.status !== 'refuse' && r.status !== 'rembourse');
      if (dup) {
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'return_already_exists', returnId: dup.id, status: dup.status }) };
      }

      const ret = {
        id: rid(),
        orderId,
        orderNum: orderId.slice(-8).toUpperCase(),
        email,
        firstName: (session.customer_details?.name || '').split(' ')[0] || '',
        reason: String(reason).slice(0, 500),
        items: items.map(i => ({
          pid: String(i.pid || ''),
          size: String(i.size || ''),
          qty: Number(i.qty || 1),
          action: i.action === 'exchange' ? 'exchange' : 'refund',
          newSize: i.newSize ? String(i.newSize) : null
        })),
        status: 'demande',
        history: [{ ts: Date.now(), status: 'demande', note: 'Demande client' }],
        createdAt: Date.now(),
        amount: (session.amount_total || 0) / 100
      };

      data.returns.unshift(ret);
      await saveReturns(data, `return: + ${ret.id}`);

      // Email "demande reçue, voici l'adresse de retour"
      await callOwn('/.netlify/functions/send-email', { template: 'return_accepted', orderId });

      return { statusCode: 201, headers: CORS, body: JSON.stringify({ ok: true, id: ret.id, status: ret.status }) };
    }

    // ── GET : admin liste ──
    if (event.httpMethod === 'GET') {
      if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
      const data = await loadReturns();
      return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
    }

    // ── PATCH : admin update statut ──
    if (event.httpMethod === 'PATCH') {
      if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }; }
      const { id, status, refundAmount, note } = payload;
      const allowed = ['accepte', 'recu', 'rembourse', 'echange', 'refuse'];
      if (!id || !allowed.includes(status)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'bad_params', allowedStatus: allowed }) };
      }

      const data = await loadReturns();
      const ret = data.returns.find(r => r.id === id);
      if (!ret) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'not_found' }) };

      ret.status = status;
      ret.history.push({ ts: Date.now(), status, note: note || '' });

      // Actions selon statut
      if (status === 'recu') {
        // Email "ton retour est arrivé"
        await callOwn('/.netlify/functions/send-email', { template: 'return_received', orderId: ret.orderId });
        // Restock immédiat (les articles physiques sont là)
        const restockRes = await restockItems(ret.items);
        ret.history.push({ ts: Date.now(), status: 'stock_restocked', note: `${restockRes.updated} variante(s)` });
      }

      if (status === 'rembourse') {
        // Refund Stripe
        try {
          const session = await stripe.checkout.sessions.retrieve(ret.orderId);
          const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
          if (piId) {
            const refund = await stripe.refunds.create({
              payment_intent: piId,
              amount: refundAmount ? Math.round(refundAmount * 100) : undefined,
              reason: 'requested_by_customer',
              metadata: { return_id: ret.id }
            });
            ret.history.push({ ts: Date.now(), status: 'refund_created', note: `Stripe refund ${refund.id} · ${(refund.amount/100).toFixed(2)} €` });
            // L'email refund_notification est envoyé automatiquement par le webhook charge.refunded
          }
        } catch (e) {
          ret.history.push({ ts: Date.now(), status: 'refund_error', note: e.message });
        }
      }

      await saveReturns(data, `return ${id}: ${status}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, return: ret }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
