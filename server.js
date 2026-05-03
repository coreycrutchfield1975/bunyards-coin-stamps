require('dotenv').config();
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

// ── Cloudinary config ────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

function uploadToCloudinary(buffer, folder='bunyards') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image', transformation: [{ quality: 'auto', fetch_format: 'auto' }] },
      (err, result) => err ? reject(err) : resolve(result.secure_url)
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}
const nodemailer = require('nodemailer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const app = express();

// ── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || '', { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(e => console.error('MongoDB error:', e));

// ── Schemas ──────────────────────────────────────────────────────────────────
const productSchema = new mongoose.Schema({
  title: String,
  description: String,
  category: { type: String, enum: ['Coins','Stamps','Currency','Tokens','Supplies'] },
  subcategory: String,
  price: Number,
  stock: { type: Number, default: 1 },
  shipping: { type: String, enum: ['both','ship-only','pickup-only'], default: 'both' },
  shippingCost: { type: Number, default: 5.00 },
  images: [String],
  featured: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
  stripeSessionId: String,
  items: Array,
  customer: Object,
  shipping: String,
  total: Number,
  status: { type: String, default: 'paid' },
  createdAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);
const Order = mongoose.model('Order', orderSchema);

// ── Multer (image uploads — memory only, Cloudinary handles storage) ──────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ── Middleware ───────────────────────────────────────────────────────────────
// Stripe webhook MUST come before express.json
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const sess = event.data.object;
    const meta = sess.metadata || {};
    const items = JSON.parse(meta.items || '[]');
    const order = new Order({
      stripeSessionId: sess.id,
      items,
      customer: { name: sess.customer_details?.name, email: sess.customer_details?.email, address: sess.customer_details?.address },
      shipping: meta.shippingMethod,
      total: sess.amount_total / 100,
      status: 'paid'
    });
    await order.save();
    // Decrement stock
    for (const item of items) {
      await Product.findByIdAndUpdate(item.id, { $inc: { stock: -1 } });
    }
    // Email Dale
    await sendOrderEmail(order);
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'bunyards-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin login ──────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const hash = process.env.ADMIN_PASSWORD_HASH || '';
  let valid = false;
  if (hash) {
    valid = await bcrypt.compare(password, hash);
  } else {
    valid = password === (process.env.ADMIN_PASSWORD || 'BunyardsAdmin2024');
  }
  if (valid) {
    req.session.isAdmin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true, redirect: '/' });
});

// ── Trading Rows API ─────────────────────────────────────────────────────────
app.get('/api/trading/rows', async (req, res) => {
  try {
    const db = client.db('bunyards');
    const doc = await db.collection('trading_rows').findOne({ _id: 'rows' });
    res.json({ rows: doc ? doc.rows : [] });
  } catch(e) { res.json({ rows: [] }); }
});

app.post('/api/trading/rows', requireAdmin, async (req, res) => {
  try {
    const db = client.db('bunyards');
    await db.collection('trading_rows').updateOne(
      { _id: 'rows' },
      { $set: { rows: req.body.rows, updated: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/check', (req, res) => {
  res.json({ admin: !!req.session?.isAdmin });
});

// ── Products API (public) ────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  const { category, search, featured } = req.query;
  const filter = { active: true, stock: { $gt: 0 } };
  if (category && category !== 'All') filter.category = category;
  if (featured === 'true') filter.featured = true;
  if (search) filter.$or = [
    { title: { $regex: search, $options: 'i' } },
    { description: { $regex: search, $options: 'i' } },
    { subcategory: { $regex: search, $options: 'i' } }
  ];
  const products = await Product.find(filter).sort({ featured: -1, createdAt: -1 });
  res.json(products);
});

app.get('/api/products/:id', async (req, res) => {
  const p = await Product.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// ── Products API (admin) ─────────────────────────────────────────────────────
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  const products = await Product.find().sort({ createdAt: -1 });
  res.json(products);
});

app.post('/api/admin/products', requireAdmin, upload.array('images', 5), async (req, res) => {
  const { title, description, category, subcategory, price, stock, shipping, shippingCost, featured } = req.body;
  const images = await Promise.all((req.files || []).map(f => uploadToCloudinary(f.buffer)));
  const product = new Product({
    title, description, category, subcategory,
    price: parseFloat(price),
    stock: parseInt(stock) || 1,
    shipping: shipping || 'both',
    shippingCost: parseFloat(shippingCost) || 5.00,
    images,
    featured: featured === 'true' || featured === 'on',
    active: true
  });
  await product.save();
  res.json(product);
});

app.put('/api/admin/products/:id', requireAdmin, upload.array('images', 5), async (req, res) => {
  const { title, description, category, subcategory, price, stock, shipping, shippingCost, featured, active, removeImages } = req.body;
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  const newImages = await Promise.all((req.files || []).map(f => uploadToCloudinary(f.buffer)));
  let images = product.images;
  if (removeImages) {
    const toRemove = Array.isArray(removeImages) ? removeImages : [removeImages];
    images = images.filter(img => !toRemove.includes(img));
  }
  images = [...images, ...newImages];
  Object.assign(product, {
    title, description, category, subcategory,
    price: parseFloat(price),
    stock: parseInt(stock),
    shipping,
    shippingCost: parseFloat(shippingCost),
    images,
    featured: featured === 'true' || featured === 'on',
    active: active === 'true' || active === 'on'
  });
  await product.save();
  res.json(product);
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// ── Orders API (admin) ───────────────────────────────────────────────────────
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

app.put('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const order = await Order.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
  res.json(order);
});

// ── Stripe Checkout ──────────────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  const { items, shippingMethod } = req.body; // items: [{id, qty}], shippingMethod: 'ship'|'pickup'
  if (!items || !items.length) return res.status(400).json({ error: 'No items' });

  const lineItems = [];
  const itemMeta = [];
  let shippingTotal = 0;

  for (const { id, qty } of items) {
    const p = await Product.findById(id);
    if (!p || !p.active || p.stock < 1) return res.status(400).json({ error: `${p?.title || 'Item'} is unavailable` });
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: p.title, images: p.images?.[0] ? [p.images[0]] : [] },
        unit_amount: Math.round(p.price * 100)
      },
      quantity: qty || 1
    });
    itemMeta.push({ id, title: p.title, price: p.price, qty: qty || 1 });
    if (shippingMethod === 'ship') shippingTotal += p.shippingCost;
  }

  if (shippingMethod === 'ship' && shippingTotal > 0) {
    lineItems.push({
      price_data: { currency: 'usd', product_data: { name: 'Shipping & Handling' }, unit_amount: Math.round(shippingTotal * 100) },
      quantity: 1
    });
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: lineItems,
    mode: 'payment',
    success_url: `${process.env.APP_URL || 'https://bunyardscoins.com'}/shop.html?success=1`,
    cancel_url: `${process.env.APP_URL || 'https://bunyardscoins.com'}/shop.html?cancelled=1`,
    metadata: { items: JSON.stringify(itemMeta), shippingMethod },
    shipping_address_collection: shippingMethod === 'ship' ? { allowed_countries: ['US'] } : undefined
  });

  res.json({ url: session.url });
});

// ── Email ────────────────────────────────────────────────────────────────────
async function sendOrderEmail(order) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
  });
  const itemList = order.items.map(i => `<li>${i.title} x${i.qty} — $${i.price.toFixed(2)}</li>`).join('');
  await transporter.sendMail({
    from: `"Bunyards Shop" <${process.env.GMAIL_USER}>`,
    to: process.env.DEALER_EMAIL || process.env.GMAIL_USER,
    subject: `🛒 New Order — $${order.total.toFixed(2)}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
        <div style="background:#9B1C1C;color:#fff;padding:20px;text-align:center">
          <h2 style="margin:0;font-family:serif">Bunyards Coin & Stamps</h2>
          <div style="color:#e8b84b;font-size:14px">New Order Received</div>
        </div>
        <div style="padding:24px;background:#FAF6F0">
          <p><strong>Customer:</strong> ${order.customer?.name || 'N/A'}</p>
          <p><strong>Email:</strong> ${order.customer?.email || 'N/A'}</p>
          <p><strong>Fulfillment:</strong> ${order.shipping === 'ship' ? '📦 Ship' : '🏪 Local Pickup'}</p>
          <p><strong>Items:</strong></p>
          <ul>${itemList}</ul>
          <p style="font-size:18px"><strong>Total: $${order.total.toFixed(2)}</strong></p>
          ${order.customer?.address ? `<p><strong>Ship To:</strong><br>${order.customer.address.line1}, ${order.customer.address.city}, ${order.customer.address.state} ${order.customer.address.postal_code}</p>` : ''}
          <hr>
          <p style="font-size:12px;color:#888">Log in to your admin panel to update order status.</p>
        </div>
      </div>`
  });
}

// ── Page routes ──────────────────────────────────────────────────────────────

// METALS PROXY — Yahoo Finance, 5-min cache
const metalsCache = {};
const METALS_TTL = 5 * 60 * 1000;
const YAHOO_MAP = { XAU:'GC=F', XAG:'SI=F' };

app.get('/api/metals/:sym', async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const cached = metalsCache[sym];
  if (cached && Date.now() - cached.ts < METALS_TTL) return res.json(cached.data);
  const yticker = YAHOO_MAP[sym];
  if (!yticker) return res.status(400).json({ error: 'Unknown symbol' });
  try {
    const yr = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yticker}?interval=1m&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!yr.ok) throw new Error(`Yahoo ${yr.status}`);
    const yj = await yr.json();
    const price = yj?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!price) throw new Error('No price in response');
    const data = { symbol: sym, price: parseFloat(price.toFixed(2)), currency: 'USD' };
    metalsCache[sym] = { data, ts: Date.now() };
    res.json(data);
  } catch(e) {
    console.log(`[metals] ERROR ${sym}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/shop', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/shop.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/product/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'product.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));
app.get('/admin-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html')));
app.get('/admin.html', (req, res) => res.redirect('/#admin'));
app.get('/trading', (req, res) => res.sendFile(path.join(__dirname, 'public', 'trading.html')));
app.get('/trading.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'trading.html')));
app.get('/trading-tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'trading-tv.html')));
app.get('/trading-tv.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'trading-tv.html')));


// ══════════════════════════════════════════
// QR PHOTO UPLOAD SESSION ROUTES
// ══════════════════════════════════════════
const crypto = require('crypto');
const qrSessions = {}; // token -> { image: base64, created: timestamp }

// Clean up sessions older than 10 minutes
setInterval(() => {
  const now = Date.now();
  Object.keys(qrSessions).forEach(k => {
    if (now - qrSessions[k].created > 600000) delete qrSessions[k];
  });
}, 60000);

// Create a new QR session token
app.post('/api/qr/session', requireAdmin, (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  qrSessions[token] = { image: null, created: Date.now() };
  const uploadUrl = `${process.env.APP_URL || ''}/qr-upload?token=${token}`;
  res.json({ token, uploadUrl });
});

// Mobile phone polls this to upload the photo
app.post('/api/qr/upload/:token', uploadMem.single('photo'), (req, res) => {
  const { token } = req.params;
  if (!qrSessions[token]) return res.status(404).json({ error: 'Session expired or invalid' });
  if (!req.file) return res.status(400).json({ error: 'No photo received' });
  const b64 = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  qrSessions[token].image = b64;
  res.json({ success: true });
});

// Desktop polls this to check if photo arrived
app.get('/api/qr/poll/:token', requireAdmin, (req, res) => {
  const { token } = req.params;
  if (!qrSessions[token]) return res.json({ status: 'expired' });
  if (qrSessions[token].image) {
    const img = qrSessions[token].image;
    delete qrSessions[token]; // one-time use
    return res.json({ status: 'ready', image: img });
  }
  res.json({ status: 'waiting' });
});

// Mobile upload page
app.get('/qr-upload', (req, res) => {
  const token = req.query.token || '';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Bunyards — ID Photo Upload</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.logo{font-size:22px;font-weight:800;color:#f59e0b;margin-bottom:6px;text-align:center}
.sub{font-size:12px;color:#64748b;margin-bottom:32px;text-align:center}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px;width:100%;max-width:360px;text-align:center}
h2{font-size:17px;font-weight:700;margin-bottom:8px}
p{font-size:13px;color:#94a3b8;line-height:1.6;margin-bottom:24px}
.cam-btn{display:block;width:100%;padding:16px;background:linear-gradient(135deg,#f59e0b,#d97706);border:none;border-radius:12px;color:#000;font-size:16px;font-weight:800;cursor:pointer;margin-bottom:12px;transition:.15s}
.cam-btn:active{opacity:.8}
.file-btn{display:block;width:100%;padding:14px;background:transparent;border:2px solid #334155;border-radius:12px;color:#94a3b8;font-size:14px;font-weight:600;cursor:pointer;transition:.15s}
.file-btn:active{background:#1e293b}
input[type=file]{display:none}
.preview{width:100%;border-radius:10px;margin:16px 0;display:none}
.status{padding:14px;border-radius:10px;font-size:14px;font-weight:700;margin-top:14px;display:none}
.ok{background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.3);color:#4ade80}
.err{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#f87171}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid #334155;border-top-color:#f59e0b;border-radius:50%;animation:sp .7s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="logo">🏛️ Bunyards</div>
<div class="sub">Coin &amp; Stamps · Poplar Bluff, MO</div>
<div class="card">
  <h2>📷 ID Photo Upload</h2>
  <p>Take a photo of the customer's ID. It will appear instantly on the desktop.</p>
  <button class="cam-btn" onclick="document.getElementById('cam-input').click()">📸 Open Camera</button>
  <button class="file-btn" onclick="document.getElementById('file-input').click()">🖼️ Choose from Gallery</button>
  <input type="file" id="cam-input" accept="image/*" capture="environment">
  <input type="file" id="file-input" accept="image/*">
  <img id="preview" class="preview">
  <div id="status" class="status"></div>
</div>
<script>
const TOKEN = '${token}';
function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('preview').src = e.target.result;
    document.getElementById('preview').style.display = 'block';
    uploadPhoto(file);
  };
  reader.readAsDataURL(file);
}
document.getElementById('cam-input').onchange = e => handleFile(e.target.files[0]);
document.getElementById('file-input').onchange = e => handleFile(e.target.files[0]);
async function uploadPhoto(file) {
  const st = document.getElementById('status');
  st.className = 'status'; st.style.display = 'block';
  st.innerHTML = '<span class="spinner"></span> Uploading…';
  try {
    const fd = new FormData();
    fd.append('photo', file);
    const r = await fetch('/api/qr/upload/${token}', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.success) {
      st.className = 'status ok';
      st.innerHTML = '✅ Photo sent! You can close this page.';
    } else {
      st.className = 'status err';
      st.innerHTML = '❌ ' + (d.error || 'Upload failed');
    }
  } catch(e) {
    st.className = 'status err';
    st.innerHTML = '❌ Network error. Try again.';
  }
}
</script>
</body>
</html>`);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bunyards running on port ${PORT}`));
