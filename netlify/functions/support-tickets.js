// Support tickets — formulaire contact + inbox admin.
//
// POST (public) : { name, email, subject, message, orderId?, category? }
//   → crée /data/support-tickets.json entry + envoie un mail de confirm au client + notif owner
//
// GET (admin)   : liste
//
// PATCH (admin) : { id, status: 'open'|'pending_customer'|'resolved', adminReply? }
//   → si adminReply : envoie un mail au client avec la réponse

const https = require('https');
const crypto = require('crypto');
const { validateAdminToken } = require('./admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Content-Type': 'application/json'
};

const BRAND_FROM = { email: 'contact@talseume.com', name: 'Talseume' };

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

function brevoSend(payload) {
  return new Promise((resolve, reject) => {
    if (!process.env.BREVO_API_KEY) return resolve({ skipped: true });
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { res.statusCode >= 400 ? reject(new Error(`Brevo ${res.statusCode}: ${buf.slice(0,160)}`)) : resolve(JSON.parse(buf || '{}')); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const rid = () => 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const isEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function loadTickets() {
  const r = await getFile('support-tickets');
  const d = (r.body && r.body.data) || { tickets: [] };
  if (!Array.isArray(d.tickets)) d.tickets = [];
  return d;
}
const saveTickets = (d, msg) => putFile('support-tickets', d, msg);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  try {
    // ── POST public : nouveau ticket ──
    if (event.httpMethod === 'POST') {
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }; }
      const { name, email, subject, message, orderId, category } = payload;
      if (!email || !isEmail(email)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_email' }) };
      if (!subject || !message) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'subject_and_message_required' }) };

      // Anti-spam basique : message trop court ou trop long
      if (message.length < 10 || message.length > 5000) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_message_length' }) };

      const data = await loadTickets();
      const ticket = {
        id: rid(),
        name: String(name || '').slice(0, 100),
        email: email.toLowerCase(),
        subject: String(subject).slice(0, 200),
        message: String(message).slice(0, 5000),
        orderId: orderId || null,
        category: category || 'general',
        status: 'open',
        messages: [{ ts: Date.now(), from: 'customer', body: String(message).slice(0, 5000) }],
        createdAt: Date.now()
      };
      data.tickets.unshift(ticket);
      data.tickets = data.tickets.slice(0, 500); // garde 500 derniers
      await saveTickets(data, `support: + ${ticket.id} (${ticket.category})`);

      // Confirmation client + notif owner
      try {
        await brevoSend({
          sender: BRAND_FROM, to: [{ email: ticket.email, name: ticket.name || email }],
          subject: `Bien reçu — ${ticket.subject}`,
          htmlContent: `<p>Bonjour ${ticket.name || ''},</p><p>J'ai bien reçu ton message. Je te réponds sous 24-48h ouvrées.</p><blockquote style="border-left:3px solid #ddd;padding-left:12px;color:#666">${ticket.message.replace(/\n/g, '<br>')}</blockquote><p>— Mes-Rêves, Talseume</p>`,
          replyTo: BRAND_FROM
        });
        await brevoSend({
          sender: BRAND_FROM, to: [{ email: 'talseumeclothes@gmail.com', name: 'Talseume' }],
          subject: `[Ticket ${ticket.id}] ${ticket.subject}`,
          htmlContent: `<p><strong>De :</strong> ${ticket.name} (${ticket.email})</p>${ticket.orderId ? `<p><strong>Commande :</strong> ${ticket.orderId}</p>` : ''}<p><strong>Catégorie :</strong> ${ticket.category}</p><hr>${ticket.message.replace(/\n/g, '<br>')}<hr><p style="font-size:12px;color:#999">→ Voir dans l'admin <a href="https://talseume.com/admin.html#tickets">talseume.com/admin</a></p>`,
          replyTo: { email: ticket.email, name: ticket.name || ticket.email }
        });
      } catch {}

      return { statusCode: 201, headers: CORS, body: JSON.stringify({ ok: true, id: ticket.id }) };
    }

    // ── GET admin ──
    if (event.httpMethod === 'GET') {
      if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
      const data = await loadTickets();
      return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
    }

    // ── PATCH admin (statut + réponse) ──
    if (event.httpMethod === 'PATCH') {
      if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }; }
      const { id, status, adminReply } = payload;
      const allowed = ['open', 'pending_customer', 'resolved'];
      if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id_required' }) };

      const data = await loadTickets();
      const t = data.tickets.find(x => x.id === id);
      if (!t) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'not_found' }) };

      if (status && allowed.includes(status)) t.status = status;

      if (adminReply) {
        t.messages.push({ ts: Date.now(), from: 'admin', body: String(adminReply).slice(0, 5000) });
        if (!status) t.status = 'pending_customer';
        // Mail au client avec la réponse
        try {
          await brevoSend({
            sender: BRAND_FROM, to: [{ email: t.email, name: t.name || t.email }],
            subject: `Réponse — ${t.subject}`,
            htmlContent: `<p>Bonjour ${t.name || ''},</p>${adminReply.replace(/\n/g, '<br>')}<hr><p style="font-size:12px;color:#999">Réponds à ce mail pour continuer la conversation.</p><p>— Mes-Rêves, Talseume</p>`,
            replyTo: BRAND_FROM
          });
        } catch {}
      }

      await saveTickets(data, `support ${id}: ${t.status}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, ticket: t }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
