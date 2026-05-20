// Codes promo Stripe (Coupons + Promotion Codes) — créés/listés/désactivés depuis l'admin.
// La create-checkout.js Talseume a déjà allow_promotion_codes:true → tout code créé ici est utilisable au checkout.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { validateAdminToken } = require('./admin-auth');

const H = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (ev) => {
  if (ev.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H };
  if (!validateAdminToken(ev)) return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'unauthorized' }) };

  const action = (ev.queryStringParameters || {}).action;
  const id = (ev.queryStringParameters || {}).id;

  try {
    if (action === 'list' || ev.httpMethod === 'GET') {
      const promos = await stripe.promotionCodes.list({ limit: 50, expand: ['data.coupon'] });
      const out = promos.data.map(p => ({
        id: p.id,
        code: p.code,
        active: p.active,
        max_redemptions: p.max_redemptions,
        times_redeemed: p.times_redeemed,
        expires_at: p.expires_at ? new Date(p.expires_at * 1000).toISOString() : null,
        coupon: {
          id: p.coupon.id,
          name: p.coupon.name,
          percent_off: p.coupon.percent_off,
          amount_off: p.coupon.amount_off,
          currency: p.coupon.currency,
          duration: p.coupon.duration,
          duration_in_months: p.coupon.duration_in_months,
          max_redemptions: p.coupon.max_redemptions
        },
        created_at: new Date(p.created * 1000).toISOString()
      }));
      return { statusCode: 200, headers: H, body: JSON.stringify({ promos: out }) };
    }

    if (action === 'create' || ev.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(ev.body || '{}'); } catch { return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'invalid_json' }) }; }
      const { code, percentOff, amountOff, maxRedemptions, expiresAt, name, oncePerCustomer } = body;
      if (!code) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'code_required' }) };
      if (!percentOff && !amountOff) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'discount_required' }) };

      const couponParams = { duration: 'once' };
      if (name) couponParams.name = name;
      if (percentOff) couponParams.percent_off = parseFloat(percentOff);
      if (amountOff) { couponParams.amount_off = Math.round(parseFloat(amountOff) * 100); couponParams.currency = 'eur'; }
      const coupon = await stripe.coupons.create(couponParams);

      const promoParams = { coupon: coupon.id, code: code.toUpperCase() };
      if (maxRedemptions) promoParams.max_redemptions = parseInt(maxRedemptions, 10);
      if (expiresAt) promoParams.expires_at = Math.floor(new Date(expiresAt).getTime() / 1000);
      if (oncePerCustomer) promoParams.restrictions = { first_time_transaction: false };
      const promo = await stripe.promotionCodes.create(promoParams);

      return { statusCode: 200, headers: H, body: JSON.stringify({ id: promo.id, code: promo.code, coupon_id: coupon.id }) };
    }

    if (action === 'deactivate' || ev.httpMethod === 'DELETE') {
      if (!id) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'id_required' }) };
      const promo = await stripe.promotionCodes.update(id, { active: false });
      return { statusCode: 200, headers: H, body: JSON.stringify({ id: promo.id, active: promo.active }) };
    }

    if (action === 'reactivate') {
      if (!id) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'id_required' }) };
      const promo = await stripe.promotionCodes.update(id, { active: true });
      return { statusCode: 200, headers: H, body: JSON.stringify({ id: promo.id, active: promo.active }) };
    }

    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'action_unknown' }) };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message, type: err.type, code: err.code }) };
  }
};
