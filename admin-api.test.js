const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_PORT = 9124;

function request(method, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: TEST_PORT, path: pathName, method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('storefront is public and admin operations require a signed-in session', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golivia-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_PASSWORD: 'test-admin-password' },
    stdio: 'ignore'
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 400));
    const home = await request('GET', '/');
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Golivia's Place/);

    const storefront = await request('GET', '/api/storefront');
    assert.equal(storefront.statusCode, 200);
    assert.ok(JSON.parse(storefront.body).products.length > 0);

    assert.equal((await request('GET', '/api/admin/data')).statusCode, 401);
    const login = await request('POST', '/api/admin/login', { password: 'test-admin-password' });
    assert.equal(login.statusCode, 200);
    const token = JSON.parse(login.body).token;
    const auth = { Authorization: `Bearer ${token}` };
    const adminData = await request('GET', '/api/admin/data', undefined, auth);
    assert.equal(adminData.statusCode, 200);
    assert.equal(Object.hasOwn(JSON.parse(adminData.body), 'adminCredentials'), false);

    const upload = await request('POST', '/api/admin/upload', { fileName: 'image.png', contentType: 'image/png', data: Buffer.from('small test image').toString('base64') }, auth);
    assert.equal(upload.statusCode, 200);
    const imageUrl = JSON.parse(upload.body).url;
    assert.match(imageUrl, /^\/uploads\//);

    const product = await request('POST', '/api/admin/products', { name: 'Test Dish', category: 'pastries', price: 1200, image: imageUrl }, auth);
    assert.equal(product.statusCode, 200);
    assert.equal(JSON.parse(product.body).product.category, 'pastries');

    const order = await request('POST', '/api/admin/orders', { customer: { name: 'Real Customer', phone: '08000000000' }, items: [{ id: 'meat-pie', qty: 2 }], total: 2000 });
    assert.equal(order.statusCode, 200);
    assert.equal(JSON.parse(order.body).order.paymentStatus, 'PENDING');

    const orderId = JSON.parse(order.body).order.id;
    assert.equal((await request('PUT', `/api/admin/orders/${orderId}`, { status: 'COMPLETED', paymentStatus: 'PAID' }, auth)).statusCode, 200);

    const productId = JSON.parse(product.body).product.id;
    assert.equal((await request('PUT', `/api/admin/products/${productId}`, { isAvailable: false }, auth)).statusCode, 200);
    assert.equal((await request('DELETE', `/api/admin/products/${productId}`, undefined, auth)).statusCode, 200);

    const category = await request('POST', '/api/admin/categories', { name: 'Test Category' }, auth);
    assert.equal(category.statusCode, 200);
    const categoryId = JSON.parse(category.body).category.id;
    assert.equal((await request('DELETE', `/api/admin/categories/${categoryId}`, undefined, auth)).statusCode, 200);

    const promotion = await request('POST', '/api/admin/promotions', { code: 'TEST10', name: 'Test promotion', value: 10, active: true }, auth);
    assert.equal(promotion.statusCode, 200);
    const promotionId = JSON.parse(promotion.body).promotion.id;
    assert.equal((await request('PUT', `/api/admin/promotions/${promotionId}`, { active: false }, auth)).statusCode, 200);
    const storePath = path.join(dataDir, 'store.json');
    const testStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    testStore.reviews.push({ id: 'test-review', userName: 'Test Customer', rating: 5, comment: 'Excellent', isApproved: false });
    fs.writeFileSync(storePath, JSON.stringify(testStore));
    assert.equal((await request('PUT', '/api/admin/reviews/test-review', { isApproved: true }, auth)).statusCode, 200);
    assert.equal(JSON.parse((await request('GET', '/api/admin/data', undefined, auth)).body).reviews.find(review => review.id === 'test-review').isApproved, true);

    assert.equal((await request('PUT', '/api/admin/content', { heroText: 'Updated hero' }, auth)).statusCode, 200);
    assert.equal((await request('PUT', '/api/admin/settings', { isOpen: false, deliveryFee: 250 }, auth)).statusCode, 200);
    assert.equal((await request('PUT', '/api/admin/profile', { name: 'Updated Admin', email: 'admin@example.com', phone: '08000000001' }, auth)).statusCode, 200);

    assert.equal((await request('PUT', '/api/admin/password', { currentPassword: 'wrong-password', newPassword: 'new-admin-password' }, auth)).statusCode, 401);
    assert.equal((await request('PUT', '/api/admin/password', { currentPassword: 'test-admin-password', newPassword: 'short' }, auth)).statusCode, 400);
    const passwordChange = await request('PUT', '/api/admin/password', { currentPassword: 'test-admin-password', newPassword: 'new-admin-password' }, auth);
    assert.equal(passwordChange.statusCode, 200);
    assert.equal(JSON.parse(passwordChange.body).requiresReauthentication, true);
    assert.equal((await request('GET', '/api/admin/data', undefined, auth)).statusCode, 401);
    assert.equal((await request('POST', '/api/admin/login', { password: 'test-admin-password' })).statusCode, 401);
    assert.equal((await request('POST', '/api/admin/login', { password: 'new-admin-password' })).statusCode, 200);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
