const https = require('https');

const SHOP = 'talseumeclothing.myshopify.com';
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const VER = '2024-04';

function shopGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SHOP,
      path: `/admin/api/${VER}${path}`,
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Accept': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse: ' + d.slice(0,120))); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function shopWrite(method, path, data) {
  return new Promise((resolve, reject) => {
    const isDel = method === 'DELETE';
    const body = isDel ? null : JSON.stringify(data || {});
    const headers = { 'X-Shopify-Access-Token': TOKEN, 'Accept': 'application/json' };
    if (!isDel) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = https.request({
      hostname: SHOP, path: `/admin/api/${VER}${path}`, method, headers
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (!d.trim()) { resolve({ success: true }); return; }
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse: ' + d.slice(0,120))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const { validateAdminToken } = require('./admin-auth');

exports.handler = async (ev) => {
  const H = {
    'Access-Control-Allow-Origin': 'https://talseume.com',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (ev.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H };
  if (!validateAdminToken(ev)) return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'unauthorized' }) };
  if (!TOKEN) return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'SHOPIFY_ACCESS_TOKEN non configuré dans Netlify' }) };

  const { action, id, status } = ev.queryStringParameters || {};

  try {
    switch (action) {

      case 'stats': {
        const [oRes, cCount, pCount] = await Promise.all([
          shopGet('/orders.json?status=any&limit=250&fields=id,order_number,created_at,total_price,financial_status,fulfillment_status,line_items,customer,currency'),
          shopGet('/customers/count.json'),
          shopGet('/products/count.json'),
        ]);

        const orders = oRes.orders || [];
        const now = Date.now();
        const todayMs = new Date(new Date().toDateString()).getTime();
        const monthMs = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
        const paid = orders.filter(o => o.financial_status === 'paid');
        const totalCA = paid.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
        const todayPaid = paid.filter(o => new Date(o.created_at).getTime() >= todayMs);
        const monthPaid = paid.filter(o => new Date(o.created_at).getTime() >= monthMs);
        const pending = orders.filter(o => o.financial_status === 'pending').length;
        const unfulfilled = orders.filter(o => o.financial_status === 'paid' && !o.fulfillment_status).length;

        // 30-day chart data
        const chart = [];
        for (let i = 29; i >= 0; i--) {
          const ds = new Date(now - i * 86400000);
          const start = new Date(ds.getFullYear(), ds.getMonth(), ds.getDate()).getTime();
          const end = start + 86400000;
          const day = paid.filter(o => { const t = new Date(o.created_at).getTime(); return t >= start && t < end; });
          chart.push({ d: ds.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }), v: day.reduce((s, o) => s + parseFloat(o.total_price || 0), 0), n: day.length });
        }

        // Top produits
        const ps = {};
        paid.forEach(o => (o.line_items || []).forEach(i => {
          if (!ps[i.title]) ps[i.title] = { qty: 0, rev: 0 };
          ps[i.title].qty += i.quantity;
          ps[i.title].rev += parseFloat(i.price || 0) * i.quantity;
        }));
        const top = Object.entries(ps).sort((a, b) => b[1].rev - a[1].rev).slice(0, 5).map(([name, d]) => ({ name, qty: d.qty, rev: d.rev }));

        return {
          statusCode: 200, headers: H, body: JSON.stringify({
            total: { amount: totalCA, count: paid.length },
            today: { amount: todayPaid.reduce((s, o) => s + parseFloat(o.total_price || 0), 0), count: todayPaid.length },
            month: { amount: monthPaid.reduce((s, o) => s + parseFloat(o.total_price || 0), 0), count: monthPaid.length },
            pending, unfulfilled,
            avg: paid.length ? totalCA / paid.length : 0,
            customers: cCount.count || 0,
            products: pCount.count || 0,
            chart, top,
          })
        };
      }

      case 'orders': {
        const s = status || 'any';
        const data = await shopGet(`/orders.json?status=${s}&limit=250`);
        return { statusCode: 200, headers: H, body: JSON.stringify(data.orders || []) };
      }

      case 'order': {
        const data = await shopGet(`/orders/${id}.json`);
        return { statusCode: 200, headers: H, body: JSON.stringify(data.order || {}) };
      }

      case 'products': {
        const data = await shopGet('/products.json?limit=250');
        return { statusCode: 200, headers: H, body: JSON.stringify(data.products || []) };
      }

      case 'customers': {
        const data = await shopGet('/customers.json?limit=250');
        return { statusCode: 200, headers: H, body: JSON.stringify(data.customers || []) };
      }

      case 'product': {
        const data = await shopGet(`/products/${id}.json`);
        return { statusCode: 200, headers: H, body: JSON.stringify(data.product || {}) };
      }

      case 'update_product': {
        const body = JSON.parse(ev.body || '{}');
        const result = await shopWrite('PUT', `/products/${id}.json`, { product: body });
        return { statusCode: 200, headers: H, body: JSON.stringify(result.product || result) };
      }

      case 'locations': {
        const data = await shopGet('/locations.json');
        return { statusCode: 200, headers: H, body: JSON.stringify(data.locations || []) };
      }

      case 'set_inventory': {
        const { inventory_item_id, location_id, available } = JSON.parse(ev.body || '{}');
        const result = await shopWrite('POST', '/inventory_levels/set.json', { inventory_item_id, location_id, available });
        return { statusCode: 200, headers: H, body: JSON.stringify(result) };
      }

      case 'discounts': {
        const rulesData = await shopGet('/price_rules.json?limit=250');
        const rules = rulesData.price_rules || [];
        const withCodes = await Promise.all(rules.slice(0, 50).map(async rule => {
          try {
            const c = await shopGet(`/price_rules/${rule.id}/discount_codes.json?limit=5`);
            rule.codes = c.discount_codes || [];
          } catch { rule.codes = []; }
          return rule;
        }));
        return { statusCode: 200, headers: H, body: JSON.stringify(withCodes) };
      }

      case 'create_discount': {
        const { price_rule, code } = JSON.parse(ev.body || '{}');
        const ruleResult = await shopWrite('POST', '/price_rules.json', { price_rule });
        const ruleId = ruleResult.price_rule?.id;
        if (!ruleId) return { statusCode: 400, headers: H, body: JSON.stringify(ruleResult) };
        const codeResult = await shopWrite('POST', `/price_rules/${ruleId}/discount_codes.json`, { discount_code: { code } });
        return { statusCode: 200, headers: H, body: JSON.stringify({ price_rule: ruleResult.price_rule, discount_code: codeResult.discount_code }) };
      }

      case 'update_discount': {
        const body = JSON.parse(ev.body || '{}');
        const result = await shopWrite('PUT', `/price_rules/${id}.json`, { price_rule: body });
        return { statusCode: 200, headers: H, body: JSON.stringify(result.price_rule || result) };
      }

      case 'delete_discount': {
        await shopWrite('DELETE', `/price_rules/${id}.json`);
        return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
      }

      default:
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Action inconnue: ' + action }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
