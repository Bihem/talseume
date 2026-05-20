// Suivi de commande côté client.
// GET ?orderId=cs_xxx&email=foo@bar
// → vérifie session + email, renvoie statut paiement + tracking shipments + état retour si présent.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

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
    req.on('error', e => resolve({ error: e.message }));
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  const { orderId, email } = event.queryStringParameters || {};
  if (!orderId || !email) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'orderId_and_email_required' }) };
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(orderId, { expand: ['line_items', 'payment_intent'] });
    const sessionEmail = (session.customer_details?.email || '').toLowerCase();
    if (sessionEmail !== email.toLowerCase()) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'email_mismatch' }) };
    }

    // Récupère shipment si présent
    const shipRes = await callOwn('/.netlify/functions/admin-data?file=shipments');
    const shipments = (shipRes.body && shipRes.body.data && shipRes.body.data.shipments) || {};
    const shipment = shipments[orderId] || null;

    // État retour
    const retRes = await callOwn('/.netlify/functions/admin-data?file=returns');
    const returns = (retRes.body && retRes.body.data && retRes.body.data.returns) || [];
    const ret = returns.find(r => r.orderId === orderId) || null;

    // Construit la timeline
    const timeline = [];
    timeline.push({ key: 'paid', label: 'Commande confirmée', ts: session.created * 1000, done: session.payment_status === 'paid' });
    timeline.push({ key: 'preparing', label: 'En préparation', ts: session.created * 1000 + 3600_000, done: session.payment_status === 'paid' && !shipment });
    if (shipment) {
      timeline.push({ key: 'shipped', label: 'Expédiée', ts: shipment.shippedAt || Date.now(), done: true, tracking: shipment.tracking, carrier: shipment.carrier });
      timeline.push({ key: 'delivered', label: 'Livrée', ts: shipment.deliveredAt || null, done: !!shipment.deliveredAt });
    }
    if (ret) {
      timeline.push({ key: 'return', label: `Retour : ${ret.status}`, ts: ret.createdAt, done: true, returnId: ret.id });
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        orderNum: session.id.slice(-8).toUpperCase(),
        status: session.payment_status,
        amount: (session.amount_total || 0) / 100,
        currency: session.currency,
        items: (session.line_items?.data || []).map(li => ({
          title: li.description || 'Article',
          qty: li.quantity,
          price: (li.amount_subtotal || 0) / 100
        })),
        customer: {
          name: session.customer_details?.name || '',
          email: session.customer_details?.email,
          address: session.customer_details?.address || null
        },
        timeline,
        shipment,
        return: ret
      })
    };
  } catch (err) {
    if (/No such checkout/i.test(err.message)) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'order_not_found' }) };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
