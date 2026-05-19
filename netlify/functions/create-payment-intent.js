const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Crée un PaymentIntent pour un achat immédiat (Apple Pay / Google Pay / Express).
// Utilisé par l'Express Checkout Element sur la page produit.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { amount, productName, productImage } = JSON.parse(event.body);
    if (!amount || amount < 0.5) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Montant invalide' }) };
    }

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      description: `Talseume — ${productName || 'commande'}`,
      statement_descriptor_suffix: 'TALSEUME',
      shipping: undefined, // Apple Pay sheet collecte lui-même l'adresse
      metadata: {
        product: productName || '',
        image: productImage || '',
        source: 'express-checkout',
      },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientSecret: intent.client_secret }),
    };
  } catch (err) {
    console.error('PaymentIntent error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
