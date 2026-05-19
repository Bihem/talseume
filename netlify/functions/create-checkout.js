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
      phone_number_collection: { enabled: true },
      allow_promotion_codes: true,
      custom_text: {
        submit: { message: 'Livraison offerte dès 80€ · Retours sous 14 jours' },
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
