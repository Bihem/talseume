// Étiquette adresse expédition format 10x15 cm (standard étiquette transporteur).
// Pas de tracking auto (pas d'API Mondial Relay/Colissimo branchée pour l'instant)
// — c'est une étiquette d'adresse "à coller" sur le colis.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { validateAdminToken } = require('./admin-auth');

const H = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const FROM = {
  brand: 'TALSEUME',
  name: 'Mes-Rêves Bouzanga',
  address: '44c Allée Robillard',
  zipCity: '93320 Les Pavillons-sous-Bois',
  country: 'FRANCE',
  phone: '06 — sur demande'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H };
  if (!validateAdminToken(event)) return { statusCode: 401, headers: H, body: 'unauthorized' };

  const orderId = (event.queryStringParameters || {}).orderId;
  if (!orderId) return { statusCode: 400, headers: H, body: 'orderId requis' };

  try {
    const s = await stripe.checkout.sessions.retrieve(orderId);
    const customer = s.customer_details || {};
    const addr = customer.address || {};
    const orderNum = s.id.slice(-8).toUpperCase();
    const name = customer.name || `${customer.first_name||''} ${customer.last_name||''}`.trim() || 'Client';

    // 10×15 cm portrait (283.46 × 425.20 points à 72 DPI)
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([283.46, 425.20]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const black = rgb(0.04, 0.04, 0.04);
    const grey = rgb(0.45, 0.45, 0.45);
    const line = rgb(0, 0, 0);
    const W = 283.46;
    const txt = (s, x, y, opts={}) => page.drawText(s, { x, y, font: opts.bold ? bold : font, size: opts.size || 9, color: opts.color || black });

    // Cadre
    page.drawRectangle({ x: 8, y: 8, width: W - 16, height: 425.20 - 16, borderColor: line, borderWidth: 1 });

    // Expéditeur (haut)
    let y = 400;
    txt('EXPÉDITEUR', 20, y, { bold: true, size: 7, color: grey });
    y -= 12;
    txt(FROM.brand, 20, y, { bold: true, size: 11 });
    y -= 12;
    txt(FROM.name, 20, y, { size: 9 });
    y -= 11;
    txt(FROM.address, 20, y, { size: 9 });
    y -= 11;
    txt(FROM.zipCity, 20, y, { size: 9 });
    y -= 11;
    txt(FROM.country, 20, y, { size: 9 });

    // Séparateur
    page.drawLine({ start: { x: 20, y: y - 18 }, end: { x: W - 20, y: y - 18 }, thickness: 1, color: line });

    // Destinataire (gros, milieu)
    y = 280;
    txt('DESTINATAIRE', 20, y, { bold: true, size: 7, color: grey });
    y -= 18;
    txt(name, 20, y, { bold: true, size: 14 });
    y -= 18;
    if (addr.line1) { txt(addr.line1, 20, y, { size: 12 }); y -= 16; }
    if (addr.line2) { txt(addr.line2, 20, y, { size: 11 }); y -= 14; }
    txt(`${addr.postal_code || ''} ${addr.city || ''}`.trim(), 20, y, { bold: true, size: 14 });
    y -= 18;
    txt(addr.country || 'FRANCE', 20, y, { bold: true, size: 13 });

    // Footer commande
    page.drawLine({ start: { x: 20, y: 80 }, end: { x: W - 20, y: 80 }, thickness: 0.5, color: rgb(0.7,0.7,0.7) });
    txt(`Commande #${orderNum}`, 20, 60, { bold: true, size: 11 });
    txt(new Date(s.created * 1000).toLocaleDateString('fr-FR'), 20, 46, { size: 9, color: grey });
    if (s.shipping_options?.[0]?.shipping_rate_data?.display_name) {
      txt(s.shipping_options[0].shipping_rate_data.display_name, 20, 32, { size: 8, color: grey });
    }
    // QR placeholder — on peut générer via API si besoin
    txt('Talseume · talseume.com · contact@talseume.com', 20, 18, { size: 7, color: grey });

    const pdfBytes = await pdf.save();
    return {
      statusCode: 200,
      headers: Object.assign({}, H, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="etiquette-${orderNum}.pdf"`
      }),
      body: Buffer.from(pdfBytes).toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
