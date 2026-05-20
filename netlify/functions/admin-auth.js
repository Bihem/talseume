// Auth admin Talseume — valide le mot de passe + retourne un token signé (HMAC, expiry 12h)
// Env vars requises sur Netlify : ADMIN_PASSWORD + ADMIN_SECRET (string random 32+ chars)
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const TTL_MS = 12 * 3600 * 1000; // 12h

function signToken(role) {
  const exp = Date.now() + TTL_MS;
  const payload = `${role}:${exp}`;
  const sig = crypto.createHmac('sha256', process.env.ADMIN_SECRET || 'change-me').update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };

  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_SECRET) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_misconfigured', detail: 'ADMIN_PASSWORD ou ADMIN_SECRET non défini' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }; }
  const password = body.password || '';

  // Délai random anti-timing attack (50-150ms)
  await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

  if (!crypto.timingSafeEqual(Buffer.from(password.padEnd(64).slice(0, 64)), Buffer.from(process.env.ADMIN_PASSWORD.padEnd(64).slice(0, 64)))) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'invalid_password' }) };
  }

  const token = signToken('admin');
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ token, expiresAt: Date.now() + TTL_MS }) };
};

// Helper exporté pour les autres fonctions admin
exports.validateAdminToken = function (event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const idx = decoded.lastIndexOf(':');
    if (idx < 0) return false;
    const payload = decoded.slice(0, idx);
    const sig = decoded.slice(idx + 1);
    const [role, expStr] = payload.split(':');
    if (role !== 'admin') return false;
    const exp = parseInt(expStr, 10);
    if (!exp || exp < Date.now()) return false;
    const expectedSig = crypto.createHmac('sha256', process.env.ADMIN_SECRET || 'change-me').update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch { return false; }
};
