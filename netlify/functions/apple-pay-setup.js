// Diagnostic + setup automatique du domain Apple Pay côté Stripe.
// Liste les domaines enregistrés, ajoute talseume.com s'il manque, force la validation.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const TARGET_DOMAIN = 'talseume.com';

exports.handler = async () => {
  try {
    // 1. Lister les domaines actuels (Payment Method Domains API — nouvelle)
    const list = await stripe.paymentMethodDomains.list({ limit: 100 });
    const existing = list.data.find(d => d.domain_name === TARGET_DOMAIN);

    let domain;
    if (existing) {
      // Si déjà présent, on relance la validation
      domain = await stripe.paymentMethodDomains.validate(existing.id);
    } else {
      // Sinon on le crée (Stripe lance la validation immédiatement)
      domain = await stripe.paymentMethodDomains.create({ domain_name: TARGET_DOMAIN });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: existing ? 're-validated' : 'created',
        id: domain.id,
        domain_name: domain.domain_name,
        enabled: domain.enabled,
        apple_pay: domain.apple_pay,
        google_pay: domain.google_pay,
        link: domain.link,
        paypal: domain.paypal,
      }, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, type: err.type, code: err.code }, null, 2),
    };
  }
};
