// Webhook Stripe — événements reçus depuis Stripe Dashboard.
// Events gérés :
//   - checkout.session.completed : envoie order_confirmation + DÉCRÉMENT stock
//   - charge.refunded            : envoie refund_notification + RÉINCRÉMENTE stock
//   - payment_intent.payment_failed : log seulement
// Chaque event est loggé dans /data/webhook-logs.json (100 derniers).
//
// Config Stripe : dashboard.stripe.com/webhooks → endpoint /.netlify/functions/stripe-webhook
// Events à cocher : checkout.session.completed · charge.refunded · payment_intent.payment_failed
// Secret : netlify env:set STRIPE_WEBHOOK_SECRET "whsec_..."
//
// Sans STRIPE_WEBHOOK_SECRET la function accepte les events SANS vérif (mode dev) — production : secret obligatoire.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');
const crypto = require('crypto');

const H = { 'Content-Type': 'application/json' };

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
    const opts = {
      hostname: 'talseume.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

const getFile = (file) => callOwn(`/.netlify/functions/admin-data?file=${file}`, null, 'GET');
const putFile = (file, data, message) => callOwn(`/.netlify/functions/admin-data?file=${file}`, { data, message }, 'PUT');

// ────────────────────────────────────────────────────────────────────────────
// Stock : décrémente / réincrémente par variante (productId + size).
// products-stock.json schema : { stock: { <pid>: { <size>: number, ... }, ... } }
// ────────────────────────────────────────────────────────────────────────────
async function updateStock(items, direction) {
  // direction: -1 (décrément à l'achat) ou +1 (réincrément au refund)
  if (!items || !items.length) return { updated: 0 };
  const r = await getFile('products-stock');
  const current = (r.body && r.body.data) || { stock: {} };
  if (!current.stock) current.stock = {};
  let updated = 0;
  for (const it of items) {
    if (!it.pid || !it.size) continue;
    if (!current.stock[it.pid]) current.stock[it.pid] = {};
    const before = Number(current.stock[it.pid][it.size] || 0);
    const next = Math.max(0, before + direction * Number(it.qty || 1));
    current.stock[it.pid][it.size] = next;
    updated++;
  }
  if (updated) {
    await putFile('products-stock', current, `webhook stock ${direction < 0 ? 'decrement' : 'increment'} ×${updated}`);
  }
  return { updated };
}

// Parse line_items vers { pid, size, qty } depuis metadata Stripe Price.
function extractStockItems(session) {
  const items = [];
  for (const li of (session.line_items?.data || [])) {
    const md = li.price?.product?.metadata || li.price?.metadata || {};
    const pid = md.pid || md.product_id;
    const size = md.size;
    if (pid && size) items.push({ pid, size, qty: li.quantity || 1, title: li.description });
  }
  return items;
}

async function logEvent(evt) {
  const r = await getFile('webhook-logs');
  let arr = (r.body && r.body.data && r.body.data.events) || [];
  if (!Array.isArray(arr)) arr = [];
  arr.unshift(evt);
  arr = arr.slice(0, 100);
  await putFile('webhook-logs', { events: arr }, `webhook log ${evt.type}`);

  // Bonus : mise à jour recent-events.json pour notif live admin (top 50)
  try {
    const r2 = await getFile('recent-events');
    let arr2 = (r2.body && r2.body.data && r2.body.data.events) || [];
    if (!Array.isArray(arr2)) arr2 = [];
    arr2.unshift(evt);
    arr2 = arr2.slice(0, 50);
    await putFile('recent-events', { events: arr2 }, `live ${evt.type}`);
  } catch {}
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let stripeEvent;
  try {
    if (secret) {
      if (!sig) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'signature_required' }) };
      stripeEvent = stripe.webhooks.constructEvent(event.body, sig, secret);
    } else {
      stripeEvent = JSON.parse(event.body);
    }
  } catch (err) {
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'webhook_signature_invalid', detail: err.message }) };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        // On re-fetch la session pour avoir line_items + metadata price/product
        const sessionMin = stripeEvent.data.object;
        const session = await stripe.checkout.sessions.retrieve(sessionMin.id, {
          expand: ['line_items', 'line_items.data.price.product']
        });
        const orderId = session.id;
        const email = session.customer_details?.email;
        const total = (session.amount_total || 0) / 100;
        const orderNum = orderId.slice(-8).toUpperCase();

        // 1. Email de confirmation
        const emailRes = await callOwn('/.netlify/functions/send-email', { template: 'order_confirmation', orderId });

        // 2. Décrément stock
        const stockItems = extractStockItems(session);
        const stockRes = await updateStock(stockItems, -1).catch(e => ({ error: e.message }));

        // 3. Log
        await logEvent({
          ts: Date.now(),
          type: 'order_paid',
          orderId,
          orderNum,
          email,
          amount: total,
          emailSent: emailRes.body?.sent === true,
          stockDecremented: stockRes.updated || 0,
          items: stockItems.map(i => ({ pid: i.pid, size: i.size, qty: i.qty }))
        });

        return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, orderNum, emailSent: emailRes.body?.sent, stock: stockRes }) };
      }

      case 'charge.refunded': {
        const charge = stripeEvent.data.object;
        const piId = charge.payment_intent;
        // Retrouver la session checkout depuis le payment_intent
        let session = null;
        try {
          const sessions = await stripe.checkout.sessions.list({ payment_intent: piId, limit: 1, expand: ['data.line_items', 'data.line_items.data.price.product'] });
          session = sessions.data[0];
        } catch {}

        const orderId = session?.id;
        const orderNum = orderId ? orderId.slice(-8).toUpperCase() : (charge.id || '').slice(-8).toUpperCase();
        const refundAmount = (charge.amount_refunded || 0) / 100;
        const fullRefund = charge.amount_refunded >= charge.amount;

        // 1. Email refund (si la session existe + on a un email)
        let emailRes = { body: { sent: false } };
        if (orderId) {
          emailRes = await callOwn('/.netlify/functions/send-email', {
            template: 'refund_notification',
            orderId,
            refundAmount,
            fullRefund
          });
        }

        // 2. Réincrément stock seulement si refund total
        let stockRes = { updated: 0 };
        if (session && fullRefund) {
          const stockItems = extractStockItems(session);
          stockRes = await updateStock(stockItems, +1).catch(e => ({ error: e.message }));
        }

        // 3. Log
        await logEvent({
          ts: Date.now(),
          type: fullRefund ? 'order_refunded' : 'order_refunded_partial',
          orderId,
          orderNum,
          amount: refundAmount,
          emailSent: emailRes.body?.sent === true,
          stockIncremented: stockRes.updated || 0
        });

        return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, orderNum, refundAmount, fullRefund, stock: stockRes }) };
      }

      case 'payment_intent.payment_failed': {
        const pi = stripeEvent.data.object;
        await logEvent({
          ts: Date.now(),
          type: 'payment_failed',
          paymentIntentId: pi.id,
          amount: (pi.amount || 0) / 100,
          reason: pi.last_payment_error?.message || 'unknown'
        });
        return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, type: stripeEvent.type }) };
      }

      default:
        return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, type: stripeEvent.type, handled: false }) };
    }
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
