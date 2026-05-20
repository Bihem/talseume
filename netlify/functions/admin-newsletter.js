// Liste des abonnés newsletter (Netlify Forms).
// Requiert NETLIFY_ACCESS_TOKEN (PAT) + NETLIFY_SITE_ID. À configurer plus tard si besoin.
// Sans ces vars, renvoie un état "not_configured" avec lien vers le dashboard.

const https = require('https');
const { validateAdminToken } = require('./admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

function netlifyApi(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.netlify.com',
      path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.NETLIFY_ACCESS_TOKEN}`,
        'Accept': 'application/json',
        'User-Agent': 'talseume-admin'
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const json = buf ? JSON.parse(buf) : {};
          if (res.statusCode >= 400) return reject(new Error(`Netlify ${res.statusCode}: ${json.message || buf.slice(0,160)}`));
          resolve(json);
        } catch (e) { reject(new Error('parse ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (!validateAdminToken(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'unauthorized' }) };

  if (!process.env.NETLIFY_ACCESS_TOKEN || !process.env.NETLIFY_SITE_ID) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        configured: false,
        message: 'Pour activer la liste des abonnés en temps réel, ajoute NETLIFY_ACCESS_TOKEN et NETLIFY_SITE_ID dans les env vars Netlify.',
        dashboardUrl: 'https://app.netlify.com/projects/talseume/forms'
      })
    };
  }

  try {
    const forms = await netlifyApi(`/api/v1/sites/${process.env.NETLIFY_SITE_ID}/forms`);
    const nlForm = forms.find(f => f.name === 'newsletter');
    if (!nlForm) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ configured: true, total: 0, subs: [], message: 'Aucun formulaire "newsletter" trouvé.' }) };
    }
    const subs = await netlifyApi(`/api/v1/forms/${nlForm.id}/submissions?per_page=200`);
    const list = subs.map(s => ({
      email: s.data?.email || '',
      consent: !!s.data?.consent,
      createdAt: s.created_at,
      site: s.site_url || ''
    })).filter(s => s.email);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ configured: true, total: list.length, subs: list }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
