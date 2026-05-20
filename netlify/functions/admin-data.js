// Lecture/écriture des fichiers /data/*.json via GitHub Contents API.
// Persiste tout ce qui n'est pas dans Stripe : drops, calendrier contenu, notes clients, stock supplémentaire.
//
// Auth admin obligatoire (Bearer token HMAC validé par admin-auth.validateAdminToken).
// Env vars requises : GITHUB_TOKEN (scope:repo), GITHUB_REPO (ex "Bihem/talseume"), ADMIN_SECRET.

const https = require('https');
const { validateAdminToken } = require('./admin-auth');

const ALLOWED_FILES = [
  'drops','calendar','client-notes',
  'products-stock','products-overrides',
  'recent-events','webhook-logs',
  'invoice-counter','invoice-ledger',
  'returns','restock-alerts',
  'collections','reviews',
  'support-tickets','tracking-config','shipments'
];

const CORS = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Content-Type': 'application/json'
};

function githubReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'talseume-admin',
        'Content-Type': 'application/json'
      }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const json = buf ? JSON.parse(buf) : {};
          if (res.statusCode >= 400) {
            return reject(new Error(`GitHub ${res.statusCode}: ${json.message || buf.slice(0,160)}`));
          }
          resolve({ status: res.statusCode, body: json });
        } catch (e) { reject(new Error('parse ' + e.message + ' / ' + buf.slice(0,160))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getFile(filename) {
  const repo = process.env.GITHUB_REPO;
  const path = `repos/${repo}/contents/data/${filename}.json`;
  try {
    const r = await githubReq('GET', `/${path}`);
    const content = Buffer.from(r.body.content, 'base64').toString('utf8');
    return { sha: r.body.sha, json: JSON.parse(content) };
  } catch (e) {
    if (/404/.test(e.message)) return { sha: null, json: null };
    throw e;
  }
}

async function putFile(filename, json, message) {
  const repo = process.env.GITHUB_REPO;
  const existing = await getFile(filename);
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const body = {
    message: message || `admin-data: update ${filename}`,
    content,
    committer: { name: 'Talseume Admin', email: 'admin@talseume.com' }
  };
  if (existing.sha) body.sha = existing.sha;
  const r = await githubReq('PUT', `/repos/${repo}/contents/data/${filename}.json`, body);
  return { sha: r.body.content?.sha, commitSha: r.body.commit?.sha };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };

  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_misconfigured', detail: 'GITHUB_TOKEN ou GITHUB_REPO manquant' }) };
  }

  const { file } = event.queryStringParameters || {};
  if (!file || !ALLOWED_FILES.includes(file)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'bad_file', allowed: ALLOWED_FILES }) };
  }

  try {
    if (event.httpMethod === 'GET') {
      const r = await getFile(file);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ file, sha: r.sha, data: r.json }) };
    }
    if (event.httpMethod === 'PUT') {
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) }; }
      const { data, message } = payload;
      if (!data || typeof data !== 'object') return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'data_required' }) };
      const r = await putFile(file, data, message);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ file, ...r }) };
    }
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
