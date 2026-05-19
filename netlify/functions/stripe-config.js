// Expose la clé publique Stripe (sûr — pk_live_ est public par design).
exports.handler = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
  },
  body: JSON.stringify({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null }),
});
