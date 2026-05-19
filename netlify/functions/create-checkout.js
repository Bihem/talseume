const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Modes de paiement. Chaque mode doit être activé dans Stripe Dashboard
// (Settings → Payment methods) AVANT d'être ajouté ici, sinon la function échoue.
// - card : Visa, MC, AmEx, CB. Apple Pay et Google Pay s'affichent AUTO selon le navigateur du client (rien à activer en plus).
// - klarna : paiement en 3x sans frais — actif chez Talseume.
// À activer dans Stripe Dashboard puis décommenter :
// - 'paypal'      → https://dashboard.stripe.com/settings/payment_methods (PayPal Connect)
// - 'link'        → souvent activé par défaut, sinon dashboard Payment methods
// - 'sepa_debit'  → activable dashboard Payment methods (prélèvement SEPA)
const PAYMENT_METHODS = ['card', 'klarna'];

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
