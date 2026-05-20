// Envoi d'emails via Brevo (ex-Sendinblue) — API REST simple, gratuit jusqu'à 300/jour.
// 3 templates inline : order_confirmation, order_shipped, review_request.
// Si BREVO_API_KEY pas défini → log et renvoie "not_configured" (mode dormant).

const https = require('https');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { validateAdminToken } = require('./admin-auth');

const H = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const BRAND_FROM = { email: 'contact@talseume.com', name: 'Talseume' };

const TEMPLATES = {
  order_confirmation: (ctx) => ({
    subject: `Ta commande Talseume #${ctx.orderNum} est confirmée`,
    html: emailLayout(`
      <h1 style="font-size:24px;margin:0 0 16px;font-weight:500;letter-spacing:-.01em">Merci ${ctx.firstName || ''} 👋</h1>
      <p style="margin:0 0 16px">Ta commande <strong>#${ctx.orderNum}</strong> est confirmée. On la prépare et on t'envoie un mail dès qu'elle part.</p>
      ${itemsTable(ctx.items, ctx.total)}
      <p style="margin:24px 0 8px;color:#666;font-size:13px">Une question ? Réponds à ce mail, c'est moi qui lis (Mes-Rêves).</p>
      <p style="margin:16px 0;font-size:12px;color:#999">La facture est disponible sur demande.</p>
    `)
  }),
  order_shipped: (ctx) => ({
    subject: `Ta commande #${ctx.orderNum} est en route`,
    html: emailLayout(`
      <h1 style="font-size:24px;margin:0 0 16px;font-weight:500;letter-spacing:-.01em">C'est parti ${ctx.firstName || ''}</h1>
      <p style="margin:0 0 16px">Ta commande <strong>#${ctx.orderNum}</strong> vient d'être confiée au transporteur. Tu devrais la recevoir sous 2-4 jours ouvrés.</p>
      ${ctx.tracking ? `<p style="margin:0 0 16px"><strong>Numéro de suivi :</strong> <code>${ctx.tracking}</code></p>` : ''}
      <p style="margin:0 0 16px;color:#666;font-size:13px">Si tu rencontres un souci à la livraison, écris-moi directement.</p>
    `)
  }),
  review_request: (ctx) => ({
    subject: 'Ton avis sur Talseume ?',
    html: emailLayout(`
      <h1 style="font-size:24px;margin:0 0 16px;font-weight:500;letter-spacing:-.01em">Comment c'est passé ${ctx.firstName || ''} ?</h1>
      <p style="margin:0 0 16px">Tu as reçu ta commande Talseume il y a quelques jours. Ton retour compte énormément pour moi — bons et moins bons.</p>
      <p style="margin:0 0 16px">Laisse ton avis ici : <a href="https://talseume.com/avis?cmd=${ctx.orderNum}" style="color:#0A0A0A;border-bottom:1px solid #0A0A0A">talseume.com/avis</a> — 30 secondes, ça m'aide énormément.</p>
      <p style="margin:0 0 16px;color:#666;font-size:13px">Merci de ton soutien aux premières heures du projet.</p>
    `)
  }),
  refund_notification: (ctx) => ({
    subject: `Remboursement confirmé · commande #${ctx.orderNum}`,
    html: emailLayout(`
      <h1 style="font-size:24px;margin:0 0 16px;font-weight:500;letter-spacing:-.01em">Remboursement effectué</h1>
      <p style="margin:0 0 16px">Ta commande <strong>#${ctx.orderNum}</strong> a été remboursée${ctx.fullRefund ? ' intégralement' : ' partiellement'} : <strong>${fmtEur(ctx.refundAmount)}</strong>.</p>
      <p style="margin:0 0 16px">Le montant apparaît sur ton moyen de paiement sous 5 à 10 jours ouvrés selon ta banque.</p>
      <p style="margin:0 0 8px;color:#666;font-size:13px">Une question ? Réponds à ce mail.</p>
    `)
  }),
  return_received: (ctx) => ({
    subject: `Ton retour est arrivé · commande #${ctx.orderNum}`,
    html: emailLayout(`
      <h1 style="font-size:24px;margin:0 0 16px;font-weight:500;letter-spacing:-.01em">Bien reçu</h1>
      <p style="margin:0 0 16px">J'ai réceptionné ton colis retour pour la commande <strong>#${ctx.orderNum}</strong>. Je contrôle l'état et te recontacte sous 48h.</p>
      <p style="margin:0 0 16px;color:#666;font-size:13px">Si tu as choisi un échange, je prépare la nouvelle taille. Sinon le remboursement part dès validation.</p>
    `)
  }),
  return_accepted: (ctx) => ({
    subject: `Demande de retour acceptée · #${ctx.orderNum}`,
    html: emailLayout(`
      <h1 style="font-size:24px;margin:0 0 16px;font-weight:500;letter-spacing:-.01em">Retour accepté</h1>
      <p style="margin:0 0 16px">Ta demande pour la commande <strong>#${ctx.orderNum}</strong> est validée. Renvoie le colis à l'adresse ci-dessous sous 14 jours :</p>
      <p style="margin:0 0 16px;padding:14px;background:#f6f6f6;border-radius:8px;font-size:13px">
        Talseume — Retours<br>
        44c Allée Robillard<br>
        93320 Les Pavillons-sous-Bois<br>
        France
      </p>
      <p style="margin:0 0 16px;color:#666;font-size:13px">Garde le numéro de suivi. Les frais de retour sont à ta charge sauf produit défectueux.</p>
    `)
  }),
  restock_available: (ctx) => ({
    subject: `${ctx.productTitle || 'Ton article'} est de nouveau dispo`,
    html: emailLayout(`
      <h1 style="font-size:24px;margin:0 0 16px;font-weight:500;letter-spacing:-.01em">Bonne nouvelle</h1>
      <p style="margin:0 0 16px"><strong>${ctx.productTitle}</strong>${ctx.size ? ` taille <strong>${ctx.size}</strong>` : ''} est revenu en stock.</p>
      <p style="margin:0 0 16px">Les stocks sont limités — file directement sur la fiche produit :</p>
      <p style="margin:0 0 16px"><a href="${ctx.productUrl}" style="display:inline-block;background:#0A0A0A;color:#fff;padding:14px 28px;text-decoration:none;font-size:13px;letter-spacing:.18em;text-transform:uppercase">Acheter</a></p>
    `)
  })
};

function emailLayout(inner) {
  return `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAFAF7;font-family:Helvetica,Arial,sans-serif;color:#0A0A0A">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7;padding:32px 16px">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #E8E6E1;border-radius:12px;padding:40px;max-width:560px">
          <tr><td style="padding-bottom:24px;border-bottom:1px solid #E8E6E1"><strong style="font-size:18px;letter-spacing:.04em">TALSEUME</strong><br><span style="font-size:10px;color:#999;letter-spacing:.18em;text-transform:uppercase">Original Clothing</span></td></tr>
          <tr><td style="padding:24px 0;line-height:1.6;font-size:14px">${inner}</td></tr>
          <tr><td style="padding-top:24px;border-top:1px solid #E8E6E1;font-size:11px;color:#999"><a href="https://talseume.com" style="color:#0A0A0A;text-decoration:none">talseume.com</a> · <a href="mailto:contact@talseume.com" style="color:#0A0A0A;text-decoration:none">contact@talseume.com</a></td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

function itemsTable(items, total) {
  if (!items || !items.length) return '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E8E6E1;border-bottom:1px solid #E8E6E1;margin:16px 0;padding:12px 0">
    ${items.map(i => `<tr><td style="padding:6px 0;font-size:13px">${i.title}</td><td style="padding:6px 0;font-size:13px;text-align:right;color:#666">${i.qty}× ${fmtEur(i.price)}</td></tr>`).join('')}
    <tr><td colspan="2" style="padding-top:12px;border-top:1px solid #E8E6E1;font-weight:600">Total <span style="float:right">${fmtEur(total)}</span></td></tr>
  </table>`;
}
function fmtEur(n){ return (Math.round((n||0)*100)/100).toFixed(2).replace('.',',')+' €'; }

function brevoSend(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Brevo ${res.statusCode}: ${buf.slice(0,160)}`));
        try { resolve(JSON.parse(buf)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H };
  if (!validateAdminToken(event)) return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'unauthorized' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'invalid_json' }) }; }
  const { template, orderId, tracking, refundAmount, fullRefund, to, productTitle, productUrl, size, firstName: rawFirst } = body;

  if (!template || !TEMPLATES[template]) {
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'template_unknown', allowed: Object.keys(TEMPLATES) }) };
  }

  // Templates standalone (sans orderId Stripe) : restock_available
  if (template === 'restock_available') {
    if (!to || !productTitle || !productUrl) {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'restock_requires_to_productTitle_productUrl' }) };
    }
    const ctx = { productTitle, productUrl, size: size || null, firstName: rawFirst || '' };
    const { subject, html } = TEMPLATES[template](ctx);
    if (!process.env.BREVO_API_KEY) {
      return { statusCode: 200, headers: H, body: JSON.stringify({ sent: false, configured: false, preview: { to, subject } }) };
    }
    await brevoSend({ sender: BRAND_FROM, to: [{ email: to }], subject, htmlContent: html, replyTo: BRAND_FROM });
    return { statusCode: 200, headers: H, body: JSON.stringify({ sent: true, to, template }) };
  }

  if (!orderId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'orderId_required' }) };

  try {
    const s = await stripe.checkout.sessions.retrieve(orderId, { expand: ['line_items'] });
    const customer = s.customer_details || {};
    const email = customer.email;
    if (!email) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'no_email_on_session' }) };

    const firstName = (customer.name || '').split(' ')[0] || '';
    const ctx = {
      orderNum: s.id.slice(-8).toUpperCase(),
      firstName,
      total: (s.amount_total || 0) / 100,
      items: (s.line_items?.data || []).map(li => ({
        title: li.description || li.price?.product?.name || 'Article',
        qty: li.quantity,
        price: ((li.amount_subtotal || 0) / li.quantity) / 100
      })),
      tracking: tracking || null,
      refundAmount: refundAmount || 0,
      fullRefund: fullRefund === true || fullRefund === undefined
    };

    const { subject, html } = TEMPLATES[template](ctx);

    if (!process.env.BREVO_API_KEY) {
      return {
        statusCode: 200, headers: H,
        body: JSON.stringify({
          sent: false, configured: false,
          message: 'BREVO_API_KEY non défini · pas envoyé. Pour activer : créer un compte gratuit sur brevo.com, copier la clé API v3, puis netlify env:set BREVO_API_KEY "xkeysib-…"',
          preview: { to: email, subject }
        })
      };
    }

    await brevoSend({
      sender: BRAND_FROM,
      to: [{ email, name: firstName || email }],
      subject,
      htmlContent: html,
      replyTo: BRAND_FROM
    });

    return { statusCode: 200, headers: H, body: JSON.stringify({ sent: true, to: email, template }) };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
