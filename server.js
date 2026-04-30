require('dotenv').config();
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
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

// ── Multer (image uploads) ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: 'public/uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s/g,'_'))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

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
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'bunyards-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

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
  res.json({ ok: true });
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
  const images = (req.files || []).map(f => '/uploads/' + f.filename);
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
  const newImages = (req.files || []).map(f => '/uploads/' + f.filename);
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
        product_data: { name: p.title, images: p.images?.[0] ? [`${process.env.APP_URL || 'https://bunyardscoins.com'}${p.images[0]}`] : [] },
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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/shop', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/shop.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/product/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'product.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bunyards running on port ${PORT}`));
