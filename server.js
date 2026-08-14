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

function adminData(store) {
  // Credential hashes must never be returned to the browser, even to an
  // authenticated administrator.
  const { adminCredentials, ...data } = store;
  return data;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    passwordHash: crypto.scryptSync(password, salt, 64).toString('hex')
  };
}

function passwordsMatch(password, credentials) {
  if (!credentials || !credentials.salt || !credentials.passwordHash) return false;
  const candidate = crypto.scryptSync(password, credentials.salt, 64);
  const stored = Buffer.from(credentials.passwordHash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function verifyAdminPassword(password, store) {
  if (store.adminCredentials) return passwordsMatch(password, store.adminCredentials);
  if (!ADMIN_PASSWORD) return false;
  const expected = String(ADMIN_PASSWORD);
  return password.length === expected.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(expected));
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

function categoryIdFromName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function normalisePromotion(payload, existing = {}) {
  const code = String(payload.code ?? existing.code ?? '').trim().toUpperCase();
  const name = String(payload.name ?? existing.name ?? '').trim();
  const type = String(payload.type ?? existing.type ?? 'PERCENT').trim().toUpperCase();
  const value = Number(payload.value ?? existing.value ?? 0);
  const minOrder = Math.max(0, Number(payload.minOrder ?? existing.minOrder ?? 0) || 0);
  const maxUsesInput = payload.maxUses ?? existing.maxUses ?? null;
  const maxUses = maxUsesInput === '' || maxUsesInput === null || maxUsesInput === undefined ? null : Math.floor(Number(maxUsesInput));
  const expiresAtInput = payload.expiresAt ?? existing.expiresAt ?? null;
  const expiryDate = expiresAtInput ? new Date(expiresAtInput) : null;
  const expiresAt = expiryDate && !Number.isNaN(expiryDate.getTime()) ? expiryDate.toISOString() : null;

  if (!name || !/^[A-Z0-9_-]{3,30}$/.test(code)) throw new Error('Enter a name and a promo code using 3-30 letters, numbers, hyphens, or underscores');
  if (!['PERCENT', 'FIXED', 'FREE_DELIVERY'].includes(type)) throw new Error('Promotion type is invalid');
  if (!Number.isFinite(value) || value < 0 || (type !== 'FREE_DELIVERY' && value <= 0)) throw new Error('Enter a valid promotion value');
  if (type === 'PERCENT' && value > 100) throw new Error('Percentage discounts cannot exceed 100%');
  if (maxUses !== null && (!Number.isFinite(maxUses) || maxUses < 1)) throw new Error('Usage limit must be at least 1');
  if (expiresAtInput && !expiresAt) throw new Error('Expiry date is invalid');

  return { ...existing, name, code, type, value: type === 'FREE_DELIVERY' ? 0 : value, minOrder, maxUses, expiresAt, active: payload.active ?? existing.active ?? true, usedCount: Number(existing.usedCount) || 0 };
}

function evaluatePromotion(store, code, subtotal) {
  if (!code) return { promotion: null, discount: 0, freeDelivery: false };
  const promotion = (store.promotions || []).find(item => item.code === String(code).trim().toUpperCase());
  if (!promotion) throw new Error('Promo code not found');
  if (!promotion.active) throw new Error('This promo code is inactive');
  if (promotion.expiresAt && new Date(promotion.expiresAt) < new Date()) throw new Error('This promo code has expired');
  if (promotion.maxUses !== null && promotion.maxUses !== undefined && Number(promotion.usedCount || 0) >= Number(promotion.maxUses)) throw new Error('This promo code has reached its usage limit');
  if (subtotal < Number(promotion.minOrder || 0)) throw new Error(`This promo code requires a minimum order of ₦${Number(promotion.minOrder || 0).toLocaleString()}`);
  const discount = promotion.type === 'PERCENT' ? Math.round(subtotal * Number(promotion.value) / 100) : promotion.type === 'FIXED' ? Math.min(subtotal, Number(promotion.value)) : 0;
  return { promotion, discount, freeDelivery: promotion.type === 'FREE_DELIVERY' };
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

  if (pathname === '/api/promotions/validate' && req.method === 'POST') {
    readJsonBody(req, (error, payload) => {
      if (error) return sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
      const store = readStore();
      const productMap = new Map((store.products || []).map(product => [product.id, product]));
      const items = Array.isArray(payload.items) ? payload.items : [];
      const subtotal = items.reduce((sum, item) => {
        const product = productMap.get(item?.id);
        const quantity = Math.max(0, Math.floor(Number(item?.qty) || 0));
        return sum + (product && product.isAvailable !== false ? Number(product.price || 0) * quantity : 0);
      }, 0);
      try {
        const result = evaluatePromotion(store, payload.code, subtotal);
        sendJson(res, 200, { success: true, promotion: result.promotion, subtotal, discount: result.discount, freeDelivery: result.freeDelivery });
      } catch (promoError) {
        sendJson(res, 400, { success: false, error: promoError.message });
      }
    });
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
        const store = readStore();
        if (!ADMIN_PASSWORD && !store.adminCredentials) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Admin login is not configured' }));
          return;
        }
        const supplied = String(payload.password || '');
        const success = verifyAdminPassword(supplied, store);
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
    res.end(JSON.stringify(adminData(readStore())));
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
        const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
        if (!allowedTypes.has(payload.contentType)) {
          sendJson(res, 400, { success: false, error: 'Please upload a JPG, PNG, WEBP, or GIF image' });
          return;
        }
        const buffer = Buffer.from(payload.data || '', 'base64');
        if (!buffer.length || buffer.length > 1024 * 1024) {
          sendJson(res, 400, { success: false, error: 'Image must be smaller than 1 MB' });
          return;
        }
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
        const qty = Math.max(1, Math.floor(Number(item.qty)));
        if (!product || product.isAvailable === false) return null;
        if (Number.isFinite(Number(product.stock)) && qty > Number(product.stock)) return null;
        return { id: product.id, name: product.name, price: Number(product.price) || 0, qty };
      }).filter(Boolean);
      if (!normalizedItems.length || normalizedItems.length !== items.length) {
        sendJson(res, 400, { success: false, error: 'One or more selected items are unavailable or out of stock' });
        return;
      }
      const subtotal = normalizedItems.reduce((total, item) => total + item.price * item.qty, 0);
      const deliveryType = payload.delivery?.type === 'delivery' ? 'delivery' : 'pickup';
      const requestedDeliveryFee = deliveryType === 'delivery' ? Math.max(0, Number(payload.delivery?.fee) || 0) : 0;
      let promoResult;
      try {
        promoResult = evaluatePromotion(store, payload.promo, subtotal);
      } catch (promoError) {
        sendJson(res, 400, { success: false, error: promoError.message });
        return;
      }
      const deliveryFee = promoResult.freeDelivery ? 0 : requestedDeliveryFee;
      const total = Math.max(0, subtotal - promoResult.discount + deliveryFee);
      const order = {
        id: `GLV-${Date.now().toString(36).toUpperCase()}`,
        orderNumber: `GLV-${Date.now().toString(36).toUpperCase()}`,
        items: normalizedItems,
        customer: { ...payload.customer, name, phone },
        delivery: { ...(payload.delivery || {}), type: deliveryType, fee: deliveryFee },
        payment: 'bank-transfer',
        promo: promoResult.promotion ? promoResult.promotion.code : null,
        subtotal,
        discount: promoResult.discount,
        total,
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
      if (promoResult.promotion) {
        store.promotions = store.promotions.map(promotion => promotion.id === promoResult.promotion.id
          ? { ...promotion, usedCount: Number(promotion.usedCount || 0) + 1 }
          : promotion);
      }
      store.products = (store.products || []).map(product => {
        const purchased = normalizedItems.find(item => item.id === product.id);
        return purchased && Number.isFinite(Number(product.stock)) ? { ...product, stock: Math.max(0, Number(product.stock) - purchased.qty) } : product;
      });
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
      const name = String(payload.name || '').trim();
      const category = String(payload.category || '').trim();
      const price = Number(payload.price);
      const image = String(payload.image || '').trim();
      if (!name || !category || !image || !Number.isFinite(price) || price < 0) {
        sendJson(res, 400, { success: false, error: 'Name, category, image, and a valid price are required' });
        return;
      }
      const store = readStore();
      const product = {
        id: `prod-${Date.now()}`,
        name,
        category,
        price,
        image,
        desc: String(payload.desc || ''),
        stock: Math.max(0, Number(payload.stock) || 0),
        isAvailable: payload.isAvailable !== false,
        bestSeller: false,
        special: false
      };
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
      const name = String(payload.name || '').trim();
      const id = categoryIdFromName(name);
      const store = readStore();
      if (!id) {
        sendJson(res, 400, { success: false, error: 'Category name is required' });
        return;
      }
      if ((store.categories || []).some(category => category.id === id || category.name.toLowerCase() === name.toLowerCase())) {
        sendJson(res, 409, { success: false, error: 'That category already exists' });
        return;
      }
      const category = { id, name };
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
      let promotion;
      try {
        promotion = { id: `promo-${Date.now()}`, ...normalisePromotion(payload) };
      } catch (promoError) {
        sendJson(res, 400, { success: false, error: promoError.message });
        return;
      }
      if ((store.promotions || []).some(item => item.code === promotion.code)) {
        sendJson(res, 409, { success: false, error: 'That promo code already exists' });
        return;
      }
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
      const current = (store.promotions || []).find(promo => promo.id === promoId || promo.code === promoId);
      if (!current) return sendJson(res, 404, { success: false, error: 'Promotion not found' });
      let updated;
      try {
        updated = normalisePromotion(payload, current);
      } catch (promoError) {
        return sendJson(res, 400, { success: false, error: promoError.message });
      }
      if ((store.promotions || []).some(promo => promo.id !== current.id && promo.code === updated.code)) {
        return sendJson(res, 409, { success: false, error: 'That promo code already exists' });
      }
      store.promotions = store.promotions.map(promo => promo.id === current.id ? updated : promo);
      writeStore(store);
      sendJson(res, 200, { success: true, promotion: updated });
    });
    return;
  }

  if (pathname.startsWith('/api/admin/promotions/') && req.method === 'DELETE') {
    const store = readStore();
    const promoId = pathname.split('/').pop();
    const before = (store.promotions || []).length;
    store.promotions = (store.promotions || []).filter(promo => promo.id !== promoId && promo.code !== promoId);
    if (store.promotions.length === before) return sendJson(res, 404, { success: false, error: 'Promotion not found' });
    writeStore(store);
    sendJson(res, 200, { success: true });
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
      const { password, currentPassword, ...profile } = payload;
      store.adminProfile = { ...store.adminProfile, ...profile };
      writeStore(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname === '/api/admin/password' && req.method === 'PUT') {
    readJsonBody(req, (error, payload) => {
      if (error) return sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
      const currentPassword = String(payload.currentPassword || '');
      const newPassword = String(payload.newPassword || '');
      if (!currentPassword || !newPassword) {
        return sendJson(res, 400, { success: false, error: 'Your current password and a new password are required' });
      }
      if (newPassword.length < 8) {
        return sendJson(res, 400, { success: false, error: 'New password must be at least 8 characters' });
      }
      const store = readStore();
      if (!verifyAdminPassword(currentPassword, store)) {
        return sendJson(res, 401, { success: false, error: 'Current password is incorrect' });
      }
      store.adminCredentials = hashPassword(newPassword);
      writeStore(store);
      // A password change invalidates every active administrator session.
      sessions.clear();
      sendJson(res, 200, { success: true, requiresReauthentication: true });
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
