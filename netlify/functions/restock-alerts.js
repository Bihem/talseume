// Restock alerts + waitlist drops.
//
// POST (public)  : { email, pid, size?, dropId?, productTitle, productUrl }
//   → ajoute à /data/restock-alerts.json
//
// GET (admin)    : liste tous les alerts
//
// POST ?action=notify (admin) : { pid, size? } OU { dropId }
//   → envoie restock_available email à tous les abonnés concernés
//   → marque comme notified
//
// DELETE (admin) : ?id=...  retire un alert

const https = require('https');
const crypto = require('crypto');
const { validateAdminToken } = require('./admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

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

const rid = () => 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const isEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function loadAlerts() {
  const r = await getFile('restock-alerts');
  const data = (r.body && r.body.data) || { alerts: [] };
  if (!Array.isArray(data.alerts)) data.alerts = [];
  return data;
}
const saveAlerts = (d, msg) => putFile('restock-alerts', d, msg);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  const qs = event.queryStringParameters || {};

  try {
    // ── POST public : ajouter un alert ──
    if (event.httpMethod === 'POST' && !qs.action) {
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }; }
      const { email, pid, size, dropId, productTitle, productUrl } = payload;
      if (!email || !isEmail(email)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_email' }) };
      if (!pid && !dropId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'pid_or_dropId_required' }) };

      const data = await loadAlerts();
      // Anti-doublon
      const dup = data.alerts.find(a =>
        a.email.toLowerCase() === email.toLowerCase() &&
        a.pid === (pid || null) &&
        a.size === (size || null) &&
        a.dropId === (dropId || null) &&
        a.status === 'pending'
      );
      if (dup) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, duplicate: true, id: dup.id }) };

      const alert = {
        id: rid(),
        email: email.toLowerCase(),
        pid: pid || null,
        size: size || null,
        dropId: dropId || null,
        productTitle: productTitle || null,
        productUrl: productUrl || null,
        status: 'pending',
        createdAt: Date.now()
      };
      data.alerts.unshift(alert);
      await saveAlerts(data, `restock-alert: + ${alert.email} · ${pid || dropId}`);
      return { statusCode: 201, headers: CORS, body: JSON.stringify({ ok: true, id: alert.id }) };
    }

    // ── POST ?action=notify : admin déclenche notifs ──
    if (event.httpMethod === 'POST' && qs.action === 'notify') {
      if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }; }
      const { pid, size, dropId } = payload;

      const data = await loadAlerts();
      const targets = data.alerts.filter(a =>
        a.status === 'pending' && (
          (dropId && a.dropId === dropId) ||
          (pid && a.pid === pid && (!size || !a.size || a.size === size))
        )
      );

      let sent = 0;
      for (const a of targets) {
        const res = await callOwn('/.netlify/functions/send-email', {
          template: 'restock_available',
          to: a.email,
          productTitle: a.productTitle || (a.dropId ? 'Drop Talseume' : 'Article'),
          productUrl: a.productUrl || 'https://talseume.com',
          size: a.size
        });
        if (res.body?.sent) { sent++; a.status = 'notified'; a.notifiedAt = Date.now(); }
      }
      await saveAlerts(data, `restock notify ${pid || dropId} ×${sent}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, targeted: targets.length, sent }) };
    }

    // ── GET admin ──
    if (event.httpMethod === 'GET') {
      if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
      const data = await loadAlerts();
      return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
    }

    // ── DELETE admin ──
    if (event.httpMethod === 'DELETE') {
      if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };
      const { id } = qs;
      if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id_required' }) };
      const data = await loadAlerts();
      data.alerts = data.alerts.filter(a => a.id !== id);
      await saveAlerts(data, `restock-alert: - ${id}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
