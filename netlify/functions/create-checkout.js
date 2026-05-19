const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Modes de paiement. Chaque mode doit être activé dans Stripe Dashboard
// (Settings → Payment methods) AVANT d'être ajouté ici.
// - card        : Visa, MC, AmEx, CB. Apple Pay et Google Pay AUTO selon le navigateur.
// - klarna      : paiement en 3x sans frais.
// - link        : portefeuille Stripe 1-click, déjà actif sur le compte.
// - amazon_pay  : paiement via compte Amazon, déjà actif (premium).
// - revolut_pay : paiement Revolut, déjà actif (premium, populaire en EU).
// À activer dans Stripe Dashboard puis décommenter :
// - 'paypal'     → https://dashboard.stripe.com/settings/payment_methods
// - 'sepa_debit' → idem (prélèvement SEPA pour gros paniers)
const PAYMENT_METHODS = ['card', 'klarna', 'link', 'amazon_pay', 'revolut_pay'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { items, successUrl, cancelUrl } = JSON.parse(event.body);

    const lineItems = items.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: {
          name: `${item.name} — ${item.variant}`,
          images: item.img ? [item.img] : [],
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.qty,
    }));

    // Livraison gratuite à partir de 80 € (Mondial Relay + Colissimo standard).
    // Colissimo Signature reste payant pour préserver la marge sur les options premium.
    const itemsTotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    const freeShipping = itemsTotal >= 80;

    const shippingOptions = [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: freeShipping ? 0 : 490, currency: 'eur' },
          display_name: freeShipping
            ? 'Mondial Relay — Point relais (offert)'
            : 'Mondial Relay — Point relais',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 2 },
            maximum: { unit: 'business_day', value: 4 },
          },
        },
      },
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: freeShipping ? 0 : 590, currency: 'eur' },
          display_name: freeShipping
            ? 'Colissimo Domicile (offert)'
            : 'Colissimo Domicile',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 2 },
            maximum: { unit: 'business_day', value: 3 },
          },
        },
      },
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 790, currency: 'eur' },
          display_name: 'Colissimo Signature — Domicile sécurisé',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 2 },
            maximum: { unit: 'business_day', value: 3 },
          },
        },
      },
    ];

    const session = await stripe.checkout.sessions.create({
      payment_method_types: PAYMENT_METHODS,
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl || 'https://talseume.com?commande=ok',
      cancel_url: cancelUrl || 'https://talseume.com',
      locale: 'fr',
      billing_address_collection: 'required',
      shipping_address_collection: {
        allowed_countries: ['FR', 'BE', 'CH', 'LU', 'MC', 'DE', 'IT', 'ES', 'PT', 'NL', 'AT', 'IE'],
      },
      shipping_options: shippingOptions,
      phone_number_collection: { enabled: true },
      allow_promotion_codes: true,
      custom_fields: [
        {
          key: 'mondial_relay_point',
          label: {
            type: 'custom',
            custom: 'Code point relais Mondial Relay (si applicable)',
          },
          type: 'text',
          optional: true,
        },
      ],
      custom_text: {
        submit: {
          message: freeShipping
            ? '🎁 Livraison offerte (≥ 80 €) · Retours sous 14 jours'
            : 'Livraison offerte dès 80 € · Retours sous 14 jours',
        },
        shipping_address: {
          message: 'Pour Mondial Relay, indique aussi ton code point relais ci-dessous (optionnel).',
        },
      },
      payment_intent_data: {
        description: 'Commande Talseume',
        statement_descriptor_suffix: 'TALSEUME',
      },
      consent_collection: {
        terms_of_service: 'required',
      },
    });

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
