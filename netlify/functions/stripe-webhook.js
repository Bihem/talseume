// Webhook Stripe — déclenché à chaque event (checkout.session.completed surtout).
// Sur paiement confirmé → log dans /data/recent-events.json + envoie auto le mail "order_confirmation".
//
// Config Stripe Dashboard :
//   1. dashboard.stripe.com/webhooks → Add endpoint
//   2. URL : https://talseume.com/.netlify/functions/stripe-webhook
//   3. Events : checkout.session.completed
//   4. Copier le "Signing secret" (whsec_...) → netlify env:set STRIPE_WEBHOOK_SECRET "whsec_..."
//
// Sans STRIPE_WEBHOOK_SECRET, la function accepte les events SANS vérif (mode dev/dormant)
// — production : poser le secret.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');

const H = { 'Content-Type': 'application/json' };

// Helpers pour appeler nos propres functions internes (pas via HTTPS, on est sur Netlify)
// On utilise l'API HTTPS publique pour rester découplé — passe par notre token interne (généré inline).
const crypto = require('crypto');
function signInternalToken() {
  const exp = Date.now() + 60_000; // 1 min
  const payload = `admin:${exp}`;
  const sig = crypto.createHmac('sha256', process.env.ADMIN_SECRET || 'change-me').update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}
function callOwn(path, payload) {
  const token = signInternalToken();
  const body = JSON.stringify(payload);
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'talseume.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let stripeEvent;
  try {
    if (secret && sig) {
      stripeEvent = stripe.webhooks.constructEvent(event.body, sig, secret);
    } else {
      // Mode dormant : pas de secret = on parse en confiance (à n'utiliser qu'en test)
      stripeEvent = JSON.parse(event.body);
    }
  } catch (err) {
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'webhook_signature_invalid', detail: err.message }) };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const orderId = session.id;
        const email = session.customer_details?.email;
        const total = (session.amount_total || 0) / 100;
        const orderNum = orderId.slice(-8).toUpperCase();

        // 1. Envoie mail de confirmation (si Brevo configuré)
        const emailRes = await callOwn('/.netlify/functions/send-email', { template: 'order_confirmation', orderId });

        // 2. Log l'event pour notif live admin
        // (admin va poll /data/recent-events.json toutes les 30s pour détecter les nouveaux)
        const eventLog = {
          ts: Date.now(),
          type: 'order_paid',
          orderId,
          orderNum,
          email,
          amount: total,
          emailSent: emailRes.body?.sent === true
        };
        // Append au log (lit + push + write)
        try {
          const r = await callOwnGet('/.netlify/functions/admin-data?file=recent-events');
          let arr = (r && r.body && r.body.data && r.body.data.events) || [];
          if (!Array.isArray(arr)) arr = [];
          arr.unshift(eventLog);
          arr = arr.slice(0, 50); // garde 50 derniers events
          await callOwn('/.netlify/functions/admin-data?file=recent-events', { data: { events: arr }, message: `webhook: ${eventLog.type} ${orderNum}` });
        } catch (e) { /* silence — l'event est traité quand même */ }

        return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, orderNum, emailSent: emailRes.body?.sent }) };
      }
      case 'charge.refunded':
      case 'payment_intent.payment_failed':
        // Log seulement, pas d'action auto pour l'instant
        return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, type: stripeEvent.type }) };
      default:
        return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, type: stripeEvent.type, handled: false }) };
    }
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};

function callOwnGet(path) {
  const token = signInternalToken();
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'talseume.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.end();
  });
}
