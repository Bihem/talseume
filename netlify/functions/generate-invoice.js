// Génère une facture PDF Talseume depuis une session Stripe Checkout.
// Format A4 portrait, conforme art. 289 CGI (mentions obligatoires FR).
// Franchise TVA art. 293 B → "TVA non applicable".

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { validateAdminToken } = require('./admin-auth');

const H = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const SELLER = {
  brand: 'TALSEUME',
  legal: 'EI BOUZANGA Mes-Rêves',
  address: '44c Allée Robillard',
  zipCity: '93320 Les Pavillons-sous-Bois',
  siret: '519 495 758 00038',
  rcs: 'RCS Bobigny 519 495 758',
  iban: 'FR76 1695 8000 0197 8135 2569 203',
  bic: 'QNTOFRP1XXX',
  email: 'contact@talseume.com',
  web: 'talseume.com',
  tvaNote: 'TVA non applicable, art. 293 B du CGI'
};

const centsToEur = n => (n || 0) / 100;
const fmtEur = n => (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €';

// ────────────────────────────────────────────────────────────────────────────
// Numérotation séquentielle TS-YYYY-NNNNN persistée sur GitHub.
// /data/invoice-counter.json : { year: 2026, lastNumber: 0 }
// /data/invoice-ledger.json  : { ledger: { <stripeSessionId>: "TS-2026-00001", ... } }
// Si la commande est re-facturée, on retourne le numéro déjà attribué (jamais 2 numéros pour 1 commande).
// ────────────────────────────────────────────────────────────────────────────
function signInternalToken() {
  const exp = Date.now() + 60_000;
  const payload = `admin:${exp}`;
  const sig = crypto.createHmac('sha256', process.env.ADMIN_SECRET || 'change-me').update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}
function callOwn(path, payload, method = 'POST') {
  const token = signInternalToken();
  const body = payload ? JSON.stringify(payload) : null;
  return new Promise(resolve => {
    const opts = { hostname: 'talseume.com', path, method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on('error', e => resolve({ error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}
const getFile = (f) => callOwn(`/.netlify/functions/admin-data?file=${f}`, null, 'GET');
const putFile = (f, data, message) => callOwn(`/.netlify/functions/admin-data?file=${f}`, { data, message }, 'PUT');

async function assignInvoiceNumber(sessionId) {
  // 1. Check ledger
  const ledgerRes = await getFile('invoice-ledger');
  const ledger = (ledgerRes.body && ledgerRes.body.data && ledgerRes.body.data.ledger) || {};
  if (ledger[sessionId]) return ledger[sessionId];

  // 2. Lire compteur, incrémenter, écrire compteur + ledger
  const counterRes = await getFile('invoice-counter');
  const year = new Date().getFullYear();
  let counter = (counterRes.body && counterRes.body.data) || { year, lastNumber: 0 };
  if (counter.year !== year) counter = { year, lastNumber: 0 };
  counter.lastNumber += 1;
  const padded = String(counter.lastNumber).padStart(5, '0');
  const invoiceNum = `TS-${year}-${padded}`;
  ledger[sessionId] = invoiceNum;

  await putFile('invoice-counter', counter, `invoice: assign ${invoiceNum}`);
  await putFile('invoice-ledger', { ledger }, `invoice ledger: + ${invoiceNum}`);
  return invoiceNum;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H };
  // Auth admin OU passage via webhook (signed query param) — pour l'instant admin only
  if (!validateAdminToken(event)) return { statusCode: 401, headers: H, body: 'unauthorized' };

  const orderId = (event.queryStringParameters || {}).orderId;
  if (!orderId) return { statusCode: 400, headers: H, body: 'orderId requis' };

  try {
    const s = await stripe.checkout.sessions.retrieve(orderId, {
      expand: ['line_items', 'line_items.data.price.product', 'payment_intent']
    });
    const items = (s.line_items?.data || []).map(li => ({
      title: li.description || li.price?.product?.name || 'Article',
      qty: li.quantity,
      unit: centsToEur((li.amount_subtotal || 0) / li.quantity),
      total: centsToEur(li.amount_subtotal || 0)
    }));
    const subtotal = items.reduce((s, i) => s + i.total, 0);
    const shipping = centsToEur((s.shipping_cost?.amount_total) || ((s.amount_total || 0) - (s.amount_subtotal || 0)));
    const total = centsToEur(s.amount_total || 0);
    const customer = s.customer_details || {};
    const addr = customer.address || {};
    const orderNum = s.id.slice(-8).toUpperCase();
    const orderDate = new Date(s.created * 1000);
    const dateStr = orderDate.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });

    // Numéro de facture séquentiel persisté (réutilisé si déjà attribué)
    let invoiceNum;
    try { invoiceNum = await assignInvoiceNumber(s.id); }
    catch (e) { invoiceNum = `TS-${new Date().getFullYear()}-${orderNum}`; } // fallback non-séquentiel si GitHub HS

    // ── PDF ──
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595.28, 841.89]); // A4
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const black = rgb(0.04, 0.04, 0.04);
    const grey = rgb(0.45, 0.45, 0.45);
    const line = rgb(0.85, 0.85, 0.85);
    const W = 595.28;
    let y = 800;

    const text = (str, x, yy, opts = {}) => page.drawText(str, {
      x, y: yy, font: opts.bold ? bold : font, size: opts.size || 10, color: opts.color || black
    });
    const hr = (yy) => page.drawLine({ start: { x: 40, y: yy }, end: { x: W - 40, y: yy }, thickness: 0.5, color: line });

    // Header
    text('TALSEUME', 40, y, { bold: true, size: 22 });
    text('Original Clothing', 40, y - 18, { size: 9, color: grey });
    text('Facture', W - 40 - 60, y, { bold: true, size: 16 });
    text(`N° ${invoiceNum}`, W - 40 - 130, y - 18, { size: 10, color: grey });
    text(dateStr, W - 40 - 130, y - 32, { size: 9, color: grey });
    text(`Commande #${orderNum}`, W - 40 - 130, y - 46, { size: 8, color: grey });
    y -= 60;
    hr(y);
    y -= 20;

    // Vendeur / Client (2 colonnes)
    text('VENDEUR', 40, y, { bold: true, size: 8, color: grey });
    text('CLIENT', W / 2 + 10, y, { bold: true, size: 8, color: grey });
    y -= 16;
    let yL = y, yR = y;
    [SELLER.brand, SELLER.legal, SELLER.address, SELLER.zipCity, '', `SIRET ${SELLER.siret}`, SELLER.rcs, SELLER.tvaNote, '', SELLER.email].forEach(l => {
      if (l) text(l, 40, yL, { size: 9, color: l === SELLER.tvaNote ? grey : black });
      yL -= 13;
    });
    const cName = customer.name || `${(customer.first_name||'')} ${(customer.last_name||'')}`.trim() || '—';
    [cName, addr.line1 || '', addr.line2 || '', `${addr.postal_code || ''} ${addr.city || ''}`.trim(), addr.country || 'FR', '', customer.email || ''].forEach(l => {
      if (l) text(l, W / 2 + 10, yR, { size: 9 });
      yR -= 13;
    });
    y = Math.min(yL, yR) - 14;
    hr(y);
    y -= 22;

    // Articles header
    text('Article', 40, y, { bold: true, size: 8, color: grey });
    text('Qté', 360, y, { bold: true, size: 8, color: grey });
    text('PU HT', 410, y, { bold: true, size: 8, color: grey });
    text('Total HT', W - 40 - 50, y, { bold: true, size: 8, color: grey });
    y -= 8;
    hr(y);
    y -= 14;

    items.forEach(it => {
      text(it.title.slice(0, 50), 40, y, { size: 10 });
      text(String(it.qty), 360, y, { size: 10 });
      text(fmtEur(it.unit), 410, y, { size: 10 });
      text(fmtEur(it.total), W - 40 - 60, y, { size: 10 });
      y -= 18;
    });
    y -= 6;
    hr(y);
    y -= 18;

    // Totaux
    const totalsX = 360;
    text('Sous-total', totalsX, y, { size: 10, color: grey });
    text(fmtEur(subtotal), W - 40 - 60, y, { size: 10 });
    y -= 16;
    text('Livraison', totalsX, y, { size: 10, color: grey });
    text(shipping > 0 ? fmtEur(shipping) : 'Offerte', W - 40 - 60, y, { size: 10 });
    y -= 16;
    text('TVA', totalsX, y, { size: 10, color: grey });
    text('—', W - 40 - 60, y, { size: 10 });
    y -= 8;
    hr(y);
    y -= 18;
    text('TOTAL TTC', totalsX, y, { bold: true, size: 12 });
    text(fmtEur(total), W - 40 - 80, y, { bold: true, size: 14 });
    y -= 24;

    // Bas de page : conditions + IBAN + statut paiement
    hr(y);
    y -= 16;
    text('Paiement', 40, y, { bold: true, size: 9, color: grey });
    y -= 13;
    const paymentStatusLbl = s.payment_status === 'paid' ? `Réglée le ${dateStr} via Stripe` : 'En attente de règlement';
    text(paymentStatusLbl, 40, y, { size: 9 });
    y -= 16;
    text(`IBAN ${SELLER.iban}  ·  BIC ${SELLER.bic}`, 40, y, { size: 8, color: grey });
    y -= 24;
    text(SELLER.tvaNote, 40, y, { size: 8, color: grey });
    y -= 11;
    text('Délai de paiement : à réception. Pas d\'escompte pour règlement anticipé. Pénalité 10,40 € + 3× taux légal en cas de retard (art. L.441-10 et L.441-11 C. com.).', 40, y, { size: 7, color: grey });
    y -= 11;
    text(`Talseume · ${SELLER.address}, ${SELLER.zipCity} · ${SELLER.web}`, 40, 30, { size: 7, color: grey });

    const pdfBytes = await pdf.save();
    return {
      statusCode: 200,
      headers: Object.assign({}, H, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${invoiceNum}.pdf"`
      }),
      body: Buffer.from(pdfBytes).toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
