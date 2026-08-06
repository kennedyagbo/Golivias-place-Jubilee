const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readFileSync } = require('fs');

const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const dataPath = path.join(dataDir, 'store.json');
const seedDataPath = path.join(__dirname, 'data', 'store.json');
const uploadsDir = path.join(dataDir, 'uploads');
const sessions = new Map();
const MAX_BODY_SIZE = 2 * 1024 * 1024;
fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dataPath) && fs.existsSync(seedDataPath)) fs.copyFileSync(seedDataPath, dataPath);
fs.mkdirSync(uploadsDir, { recursive: true });

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function isAdmin(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function publicStore(store) {
  return {
    products: store.products || [],
    categories: store.categories || [],
    promotions: (store.promotions || []).filter(promo => promo.active),
    reviews: (store.reviews || []).filter(review => review.isApproved),
    siteContent: store.siteContent || {},
    settings: store.settings || {}
  };
}

function readStore() {
  try {
    return JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch (error) {
    return {
      products: [],
      orders: [],
      categories: [],
      promotions: [],
      reviews: [],
      customers: [],
      siteContent: {
        heroText: 'GOLIVIA’S PLACE — Fresh pastries & snacks delivered fast in Makurdi',
        aboutText: "Welcome to Golivia's Place — fresh pastries, snacks, and celebration cakes made daily.",
        businessHours: 'Mon-Sun 8:00 AM - 9:00 PM',
        heroImage: '',
        sections: []
      },
      settings: {
        restaurantName: "Golivia's Place",
        phone: '09043474647',
        email: 'goliviaresources2010@gmail.com',
        address: 'Makurdi, Benue State',
        currency: 'NGN',
        deliveryFee: 500,
        minimumOrder: 10000,
        taxPercentage: 0,
        isOpen: true
      },
      adminProfile: {
        name: 'Admin',
        email: 'goliviaresources2010@gmail.com',
        phone: '+23409043474647'
      },
      notifications: []
    };
  }
}

function writeStore(next) {
  fs.writeFileSync(dataPath, JSON.stringify(next, null, 2));
}

function readJsonBody(req, callback) {
  let body = '';
  let tooLarge = false;
  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_BODY_SIZE) tooLarge = true;
  });
  req.on('end', () => {
    try {
      if (tooLarge) throw new Error('Request body is too large');
      callback(null, JSON.parse(body || '{}'));
    } catch (error) {
      callback(error);
    }
  });
  req.on('error', callback);
}

function sanitizeFileName(fileName) {
  const ext = path.extname(fileName || '.bin') || '.bin';
  const base = path.basename(fileName, ext).replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || 'upload';
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${base}${ext}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (pathname === '/api/storefront' && req.method === 'GET') {
    sendJson(res, 200, publicStore(readStore()));
    return;
  }

  if (pathname === '/api/admin/login') {
    if (req.method === 'POST') {
      readJsonBody(req, (error, payload) => {
        if (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
          return;
        }
        if (!ADMIN_PASSWORD) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Admin login is not configured' }));
          return;
        }
        const supplied = String(payload.password || '');
        const expected = String(ADMIN_PASSWORD);
        const success = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
        if (!success) return sendJson(res, 401, { success: false });
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + (8 * 60 * 60 * 1000));
        sendJson(res, 200, { success: true, token });
      });
      return;
    }
  }

  const isPublicOrderRequest = pathname === '/api/admin/orders' && req.method === 'POST';
  if (pathname.startsWith('/api/admin/') && !isPublicOrderRequest && !isAdmin(req)) {
    sendJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  if (pathname === '/api/admin/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readStore()));
    return;
  }

  if (pathname === '/api/admin/upload' && req.method === 'POST') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      try {
        const buffer = Buffer.from(payload.data || '', 'base64');
        const fileName = sanitizeFileName(payload.fileName || 'upload');
        const filePath = path.join(uploadsDir, fileName);
        fs.writeFileSync(filePath, buffer);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: `/uploads/${fileName}` }));
      } catch (uploadError) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Upload failed' }));
      }
    });
    return;
  }

  if (pathname === '/api/admin/orders' && req.method === 'POST') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const name = String(payload.customer?.name || '').trim();
      const phone = String(payload.customer?.phone || '').trim();
      const items = Array.isArray(payload.items) ? payload.items.filter(item => item && Number(item.qty) > 0) : [];
      if (!name || !phone || !items.length) {
        sendJson(res, 400, { success: false, error: 'Customer name, phone number, and at least one item are required' });
        return;
      }
      const store = readStore();
      const products = new Map((store.products || []).map(product => [product.id, product]));
      const normalizedItems = items.map(item => {
        const product = products.get(item.id);
        return product ? { id: product.id, name: product.name, price: Number(product.price) || 0, qty: Math.max(1, Math.floor(Number(item.qty))) } : null;
      }).filter(Boolean);
      if (!normalizedItems.length) {
        sendJson(res, 400, { success: false, error: 'Your selected items are no longer available' });
        return;
      }
      const subtotal = normalizedItems.reduce((total, item) => total + item.price * item.qty, 0);
      const order = {
        id: `GLV-${Date.now().toString(36).toUpperCase()}`,
        orderNumber: `GLV-${Date.now().toString(36).toUpperCase()}`,
        items: normalizedItems,
        customer: { ...payload.customer, name, phone },
        delivery: payload.delivery || { type: 'pickup', fee: 0 },
        payment: 'bank-transfer',
        promo: payload.promo || null,
        subtotal,
        discount: Math.max(0, Number(payload.discount) || 0),
        total: Math.max(0, Number(payload.total) || subtotal),
        notes: String(payload.notes || '').slice(0, 1000),
        status: 'NEW',
        paymentStatus: 'PENDING',
        createdAt: new Date().toISOString(),
        timestamp: new Date().toISOString()
      };
      store.orders = [...store.orders, order];
      const customerIndex = (store.customers || []).findIndex(customer => customer.phone === phone);
      if (customerIndex >= 0) {
        const customer = store.customers[customerIndex];
        store.customers[customerIndex] = { ...customer, name, totalOrders: (customer.totalOrders || 0) + 1, totalSpent: (customer.totalSpent || 0) + order.total, lastOrder: order.createdAt };
      } else {
        store.customers = [...(store.customers || []), { id: `cust-${Date.now()}`, name, phone, email: String(payload.customer?.email || ''), totalOrders: 1, totalSpent: order.total, lastOrder: order.createdAt }];
      }
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, order }));
    });
    return;
  }

  if (pathname.startsWith('/api/admin/orders/') && req.method === 'PUT') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const store = readStore();
      const orderId = pathname.split('/').pop();
      store.orders = store.orders.map(order => order.id === orderId ? { ...order, ...payload } : order);
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname === '/api/admin/products' && req.method === 'POST') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const store = readStore();
      const product = { id: `prod-${Date.now()}`, ...payload, isAvailable: payload.isAvailable !== false };
      store.products = [...store.products, product];
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, product }));
    });
    return;
  }

  if (pathname.startsWith('/api/admin/products/') && req.method === 'PUT') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const store = readStore();
      const productId = pathname.split('/').pop();
      store.products = store.products.map(product => product.id === productId ? { ...product, ...payload } : product);
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname.startsWith('/api/admin/products/') && req.method === 'DELETE') {
    const store = readStore();
    const productId = pathname.split('/').pop();
    store.products = store.products.filter(product => product.id !== productId);
    writeStore(store);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (pathname === '/api/admin/categories' && req.method === 'POST') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const store = readStore();
      const category = { id: `cat-${Date.now()}`, name: payload.name };
      store.categories = [...store.categories, category];
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, category }));
    });
    return;
  }

  if (pathname.startsWith('/api/admin/categories/') && req.method === 'DELETE') {
    const store = readStore();
    const categoryId = pathname.split('/').pop();
    store.categories = store.categories.filter(category => category.id !== categoryId && category.name !== categoryId);
    writeStore(store);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (pathname === '/api/admin/promotions' && req.method === 'POST') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const store = readStore();
      const promotion = { id: `promo-${Date.now()}`, ...payload };
      store.promotions = [...store.promotions, promotion];
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, promotion }));
    });
    return;
  }

  if (pathname.startsWith('/api/admin/promotions/') && req.method === 'PUT') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const store = readStore();
      const promoId = pathname.split('/').pop();
      store.promotions = store.promotions.map(promo => promo.id === promoId || promo.code === promoId ? { ...promo, ...payload } : promo);
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname.startsWith('/api/admin/reviews/') && req.method === 'PUT') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const store = readStore();
      const reviewId = pathname.split('/').pop();
      store.reviews = store.reviews.map(review => review.id === reviewId ? { ...review, ...payload } : review);
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname === '/api/admin/content' && req.method === 'PUT') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const store = readStore();
      store.siteContent = { ...store.siteContent, ...payload };
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname === '/api/admin/settings' && req.method === 'PUT') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const store = readStore();
      store.settings = { ...store.settings, ...payload };
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname === '/api/admin/profile' && req.method === 'PUT') {
    readJsonBody(req, (error, payload) => {
      if (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const store = readStore();
      store.adminProfile = { ...store.adminProfile, ...payload };
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    const safePath = path.join(uploadsDir, path.basename(pathname));
    if (fs.existsSync(safePath)) {
      const extname = String(path.extname(safePath)).toLowerCase();
      const contentType = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp'
      }[extname] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(safePath));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(__dirname, '.' + requestedPath);
  if (!filePath.startsWith(__dirname + path.sep) && filePath !== path.join(__dirname, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  }[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n', 'utf-8');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log('Server running at http://' + HOST + ':' + PORT + '/');
});
