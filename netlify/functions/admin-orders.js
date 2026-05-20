const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { validateAdminToken } = require('./admin-auth');

const H = {
  'Access-Control-Allow-Origin': 'https://talseume.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

const PRODUCTS = [
  {id:'sweat-oversize',title:'Sweat Talseume Oversize',price:'90.00',variants:[{price:'90.00',inventory_quantity:50}],images:[{src:'images/products/SWEAT-TALSEUME-ROUGE-A-CAPUCHE.jpg'}],status:'active'},
  {id:'tshirt-oversize',title:'Tee-Shirt Talseume Oversize',price:'60.00',variants:[{price:'60.00',inventory_quantity:80}],images:[{src:'images/products/tee-shirt-talseume-noir-oversise.jpg'}],status:'active'},
  {id:'sweat-bikelife',title:'Sweat Tls × Bikelife',price:'68.99',variants:[{price:'68.99',inventory_quantity:30}],images:[{src:'images/products/sweat-talseume-bikelife-devant.jpg'}],status:'active'},
  {id:'tshirt-manches-longues',title:'T-Shirt Manches Longues',price:'75.00',variants:[{price:'75.00',inventory_quantity:40}],images:[{src:'images/products/tshirt-talseume-mancheslongue-creme.jpg'}],status:'active'},
  {id:'veste-coach',title:'Veste Coach Unisexe',price:'90.00',variants:[{price:'90.00',inventory_quantity:20}],images:[{src:'images/products/Coach-Jacket-By-talseumecopie2.jpg'}],status:'active'},
  {id:'veste-coach-ultra',title:'Veste Coach Ultra',price:'90.00',variants:[{price:'90.00',inventory_quantity:15}],images:[{src:'images/products/Jacket-By-TALSEUMENWAR.jpg'}],status:'active'},
  {id:'debardeur-femme',title:'Débardeur Talseume Femme',price:'45.00',variants:[{price:'45.00',inventory_quantity:35}],images:[{src:'images/products/debardeur-femme-talseume-090.jpg'}],status:'active'},
  {id:'tshirt-femme',title:'T-shirt Talseume Femme',price:'55.00',variants:[{price:'55.00',inventory_quantity:45}],images:[{src:'images/products/tshirt-femme-talseume-009.jpg'}],status:'active'},
  {id:'cagoule',title:'Cagoule Talseume',price:'35.00',variants:[{price:'35.00',inventory_quantity:25}],images:[{src:'images/products/IMG_7578.jpg'}],status:'active'},
  {id:'sport-beanie',title:'Sport Beanie',price:'17.99',variants:[{price:'17.99',inventory_quantity:60}],images:[{src:'images/products/Bonnet_talseume.jpg'}],status:'active'},
  {id:'casquette-trucker',title:'Casquette Trucker',price:'19.99',variants:[{price:'19.99',inventory_quantity:55}],images:[{src:'images/products/IMG_7199.png'}],status:'active'},
  {id:'talseume-bag',title:'Talseume Bag',price:'25.99',variants:[{price:'25.99',inventory_quantity:40}],images:[{src:'images/products/sactalseume.jpg'}],status:'active'},
];

function centsToEur(n) { return (n || 0) / 100; }

function mapSession(s) {
  const name = s.customer_details?.name || '';
  const parts = name.trim().split(' ');
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';
  const items = (s.line_items?.data || []).map(li => ({
    title: li.description || li.price?.product?.name || 'Article',
    variant_title: '',
    quantity: li.quantity,
    price: String(centsToEur(li.amount_subtotal / li.quantity))
  }));
  const addr = s.customer_details?.address;
  return {
    id: s.id,
    order_number: s.id.slice(-8).toUpperCase(),
    created_at: new Date(s.created * 1000).toISOString(),
    total_price: String(centsToEur(s.amount_total)),
    subtotal_price: String(centsToEur(s.amount_subtotal || s.amount_total)),
    financial_status: s.payment_status === 'paid' ? 'paid' : 'pending',
    fulfillment_status: null,
    customer: { first_name: firstName, last_name: lastName, email: s.customer_details?.email || '' },
    shipping_address: addr ? { address1: addr.line1 || '', address2: addr.line2 || '', zip: addr.postal_code || '', city: addr.city || '', country: addr.country || '' } : null,
    line_items: items,
    note: null
  };
}

exports.handler = async (ev) => {
  if (ev.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H };
  if (!validateAdminToken(ev)) return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'unauthorized' }) };
  const { action, id } = ev.queryStringParameters || {};

  try {
    if (action === 'stats') {
      const now = Math.floor(Date.now() / 1000);
      const dayStart = Math.floor(new Date(new Date().toDateString()).getTime() / 1000);
      const monthStart = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);

      const sessions = await stripe.checkout.sessions.list({ limit: 100, expand: ['data.line_items'] });
      const paid = sessions.data.filter(s => s.payment_status === 'paid');
      const today = paid.filter(s => s.created >= dayStart);
      const month = paid.filter(s => s.created >= monthStart);
      const pending = sessions.data.filter(s => s.payment_status === 'unpaid').length;

      const totalEur = paid.reduce((s, o) => s + centsToEur(o.amount_total), 0);
      const avg = paid.length ? totalEur / paid.length : 0;

      // 30-day chart
      const chart = [];
      for (let i = 29; i >= 0; i--) {
        const ds = new Date(Date.now() - i * 86400000);
        const start = Math.floor(new Date(ds.getFullYear(), ds.getMonth(), ds.getDate()).getTime() / 1000);
        const end = start + 86400;
        const day = paid.filter(s => s.created >= start && s.created < end);
        chart.push({
          d: ds.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }),
          v: day.reduce((s, o) => s + centsToEur(o.amount_total), 0),
          n: day.length
        });
      }

      // Top products
      const ps = {};
      paid.forEach(s => (s.line_items?.data || []).forEach(li => {
        const name = li.description || li.price?.product?.name || 'Article';
        if (!ps[name]) ps[name] = { qty: 0, rev: 0 };
        ps[name].qty += li.quantity;
        ps[name].rev += centsToEur(li.amount_subtotal);
      }));
      const top = Object.entries(ps).sort((a, b) => b[1].rev - a[1].rev).slice(0, 5).map(([name, d]) => ({ name, qty: d.qty, rev: d.rev }));

      return {
        statusCode: 200, headers: H, body: JSON.stringify({
          total: { amount: totalEur, count: paid.length },
          today: { amount: today.reduce((s, o) => s + centsToEur(o.amount_total), 0), count: today.length },
          month: { amount: month.reduce((s, o) => s + centsToEur(o.amount_total), 0), count: month.length },
          pending, avg,
          customers: [...new Set(paid.map(s => s.customer_details?.email).filter(Boolean))].length,
          products: PRODUCTS.length,
          unfulfilled: 0,
          chart, top
        })
      };
    }

    if (action === 'orders') {
      const sessions = await stripe.checkout.sessions.list({ limit: 100, expand: ['data.line_items'] });
      return { statusCode: 200, headers: H, body: JSON.stringify(sessions.data.map(mapSession)) };
    }

    if (action === 'order') {
      const s = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items', 'line_items.data.price.product'] });
      return { statusCode: 200, headers: H, body: JSON.stringify(mapSession(s)) };
    }

    if (action === 'refund') {
      const s = await stripe.checkout.sessions.retrieve(id);
      if (!s.payment_intent) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Aucun paiement associé' }) };
      const refund = await stripe.refunds.create({ payment_intent: s.payment_intent, reason: 'requested_by_customer' });
      return { statusCode: 200, headers: H, body: JSON.stringify(refund) };
    }

    if (action === 'products') {
      return { statusCode: 200, headers: H, body: JSON.stringify(PRODUCTS) };
    }

    if (action === 'customers') {
      const sessions = await stripe.checkout.sessions.list({ limit: 100 });
      const paid = sessions.data.filter(s => s.payment_status === 'paid');
      const map = {};
      paid.forEach(s => {
        const email = s.customer_details?.email;
        if (!email) return;
        if (!map[email]) {
          const name = s.customer_details?.name || '';
          const parts = name.trim().split(' ');
          map[email] = { email, first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '', orders_count: 0, total_spent: 0, created_at: new Date(s.created * 1000).toISOString() };
        }
        map[email].orders_count++;
        map[email].total_spent += centsToEur(s.amount_total);
      });
      const customers = Object.values(map).sort((a, b) => b.total_spent - a.total_spent);
      return { statusCode: 200, headers: H, body: JSON.stringify(customers) };
    }

    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Action inconnue' }) };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
