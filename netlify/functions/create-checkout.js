const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
      payment_method_types: ['card', 'klarna'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl || 'https://talseume.fr?commande=ok',
      cancel_url: cancelUrl || 'https://talseume.fr',
      locale: 'fr',
      shipping_address_collection: {
        allowed_countries: ['FR', 'BE', 'CH', 'LU', 'MC'],
      },
      phone_number_collection: { enabled: true },
      custom_text: {
        submit: { message: 'Livraison offerte dès 80€ · Retours gratuits 30 jours' },
      },
      payment_intent_data: {
        description: 'Commande Talseume',
      },
    });

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
