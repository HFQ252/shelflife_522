const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 8080;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// 启用压缩
app.use(compression());

// 北京时间工具函数
function createBJDate(dateStr) {
    if (!dateStr) return null;
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 8, 0, 0));
}

function getBJToday() {
    const now = new Date();
    const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const year = bjTime.getUTCFullYear();
    const month = bjTime.getUTCMonth();
    const day = bjTime.getUTCDate();
    return new Date(Date.UTC(year, month, day));
}

function calculateRemainingDaysBJ(productionDateStr, shelfLife) {
    const prodDate = createBJDate(productionDateStr);
    if (!prodDate) return 0;
    const expiryDate = new Date(prodDate);
    expiryDate.setUTCDate(prodDate.getUTCDate() + shelfLife);
    const today = getBJToday();
    const diffTime = expiryDate.getTime() - today.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// 安全中间件
if (!process.env.ZEABUR && IS_PRODUCTION) {
  try {
    const rateLimit = require('express-rate-limit');
    const helmet = require('helmet');
    app.use(helmet({ contentSecurityPolicy: false }));
    const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: '请求过于频繁，请稍后再试' } });
    app.use('/api/', limiter);
  } catch (e) { console.log('⚠️ 安全中间件加载跳过'); }
}

app.use(cors({ origin: true, credentials: true }));

// JSON解析
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '.')));

// 会话配置
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'product-expiration-secret-key-v3',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    path: '/'
  },
  rolling: true,
  name: 'sessionId',
  proxy: true
};

if (process.env.ZEABUR) {
    app.set('trust proxy', 1);
}

app.use(session(sessionConfig));

// 请求日志
app.use((req, res, next) => {
  if (!IS_PRODUCTION && req.url !== '/favicon.ico' && !req.url.startsWith('/api/auth/check')) {
    console.log(`📨 ${new Date().toISOString().slice(0, 19)} ${req.method} ${req.url}`);
  }
  next();
});

// 健康检查
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() }));

const getClientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || req.ip;

// 认证中间件
const authenticate = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: '未授权，请先登录' });
  }
  
  try {
    const user = await db.getUserById(req.session.userId);
    if (!user) {
      req.session.destroy();
      return res.status(401).json({ error: '用户不存在，请重新登录' });
    }
    next();
  } catch (error) {
    console.error('认证中间件错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
};

const authenticateAdmin = async (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: '未授权，请先登录' });
  const user = await db.getUserById(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
};

// ========== 认证API ==========
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, email, authCode } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    if (!authCode) return res.status(400).json({ error: '请输入授权码' });
    if (username.length < 3 || username.length > 20) return res.status(400).json({ error: '用户名长度应在3-20字符之间' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: '用户名只能包含字母、数字和下划线' });
    if (password.length < 6) return res.status(400).json({ error: '密码长度不能少于6位' });
    const result = await db.createUser(username, password, email || '', authCode);
    if (!result.success) return res.status(409).json({ error: result.error });
    res.json({ success: true, message: '注册成功', userId: result.id });
  } catch (error) { console.error('注册错误:', error); res.status(500).json({ error: '注册失败' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    const result = await db.authenticateUser(username, password, getClientIp(req));
    if (!result.success) return res.status(401).json({ error: result.error });
    
    req.session.userId = result.user.id;
    req.session.username = result.user.username;
    req.session.role = result.user.role;
    req.session.loginTime = new Date();
    
    req.session.save((err) => {
      if (err) {
        console.error('Session保存错误:', err);
        return res.status(500).json({ error: '登录失败，请重试' });
      }
      
      let expiryWarning = null;
      if (result.user.valid_until) {
        const validUntil = new Date(result.user.valid_until);
        const daysRemaining = Math.ceil((validUntil - new Date()) / (1000 * 60 * 60 * 24));
        if (daysRemaining <= 30 && daysRemaining > 0) expiryWarning = `您的账号将在 ${daysRemaining} 天后过期，请联系管理员续期`;
        else if (daysRemaining <= 0) expiryWarning = `您的账号已过期，请联系管理员续期`;
      }
      res.json({ success: true, message: '登录成功', user: { ...result.user, expiryWarning } });
    });
  } catch (error) { console.error('登录错误:', error); res.status(500).json({ error: '登录失败' }); }
});

app.post('/api/auth/logout', (req, res) => { 
  req.session.destroy((err) => {
    if (err) console.error('登出错误:', err);
    res.json({ success: true, message: '已登出' });
  }); 
});

app.post('/api/auth/extend', authenticate, (req, res) => { 
  req.session.touch();
  req.session.save((err) => {
    if (err) console.error('延长会话错误:', err);
    res.json({ success: true, message: '会话已延长' });
  });
});

app.get('/api/auth/check', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  
  if (!req.session || !req.session.userId) {
    return res.json({ isLoggedIn: false });
  }
  
  try {
    const user = await db.getUserById(req.session.userId);
    if (!user) { 
      req.session.destroy(); 
      return res.json({ isLoggedIn: false }); 
    }
    
    let expiryWarning = null;
    if (user.valid_until) {
      const validUntil = new Date(user.valid_until);
      const daysRemaining = Math.ceil((validUntil - new Date()) / (1000 * 60 * 60 * 24));
      if (daysRemaining <= 30 && daysRemaining > 0) expiryWarning = `您的账号将在 ${daysRemaining} 天后过期`;
      else if (daysRemaining <= 0) expiryWarning = `您的账号已过期，请联系管理员续期`;
    }
    
    res.json({ 
      isLoggedIn: true, 
      user: { 
        id: req.session.userId, 
        username: req.session.username, 
        role: req.session.role,
        expiryWarning 
      }, 
      loginTime: req.session.loginTime 
    });
  } catch (error) {
    console.error('Auth check error:', error);
    res.status(500).json({ isLoggedIn: false, error: '服务器错误' });
  }
});

// ========== 管理员 API ==========
app.get('/api/admin/users', authenticateAdmin, async (req, res) => { 
    try { 
        res.json(await db.getAllUsers()); 
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    } 
});

app.post('/api/admin/users/:userId/reset-password', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: '新密码长度不能少于6位' });
        }
        const user = await db.getUserById(userId);
        if (!user) return res.status(404).json({ error: '用户不存在' });
        await db.resetUserPassword(userId, newPassword);
        await db.addAdminLog(req.session.userId, req.session.username, 'reset_password', user.username, '重置密码', getClientIp(req));
        res.json({ success: true, message: `已重置用户 ${user.username} 的密码` });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

app.post('/api/admin/users/:userId/validity', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { validUntil } = req.body;
        if (!validUntil) return res.status(400).json({ error: '请指定有效期' });
        const user = await db.getUserById(userId);
        if (!user) return res.status(404).json({ error: '用户不存在' });
        await db.updateUserValidity(userId, validUntil);
        await db.addAdminLog(req.session.userId, req.session.username, 'update_validity', user.username, `更新有效期至 ${validUntil}`, getClientIp(req));
        res.json({ success: true, message: `已更新用户 ${user.username} 的有效期` });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

app.delete('/api/admin/users/:userId', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        if (parseInt(userId) === req.session.userId) {
            return res.status(400).json({ error: '不能删除自己的账户' });
        }
        const user = await db.getUserById(userId);
        if (!user) return res.status(404).json({ error: '用户不存在' });
        if (user.role === 'admin') return res.status(403).json({ error: '不能删除管理员账户' });
        await db.deleteUser(userId);
        await db.addAdminLog(req.session.userId, req.session.username, 'delete_user', user.username, '删除用户', getClientIp(req));
        res.json({ success: true, message: `已删除用户 ${user.username}` });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

// ========== 授权码管理 ==========
app.get('/api/admin/auth-codes', authenticateAdmin, async (req, res) => { 
    try { 
        res.json(await db.getAllAuthCodes()); 
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    } 
});

app.post('/api/admin/auth-codes', authenticateAdmin, async (req, res) => {
    try {
        const { validUntil } = req.body;
        if (!validUntil) return res.status(400).json({ error: '请指定有效期' });
        const code = await db.createAuthCode(req.session.userId, validUntil);
        await db.addAdminLog(req.session.userId, req.session.username, 'create_auth_code', null, `创建授权码: ${code} 有效期至 ${validUntil}`, getClientIp(req));
        res.json({ success: true, code, validUntil });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

app.put('/api/admin/auth-codes/:codeId', authenticateAdmin, async (req, res) => {
    try {
        const { codeId } = req.params;
        const { validUntil, status } = req.body;
        await db.updateAuthCode(codeId, validUntil, status);
        await db.addAdminLog(req.session.userId, req.session.username, 'update_auth_code', null, `更新授权码ID: ${codeId}`, getClientIp(req));
        res.json({ success: true });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

// ========== 操作日志 API ==========
// 获取管理员操作日志
app.get('/api/admin/logs', authenticateAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 200;
        const logs = await db.getAdminLogs(limit);
        res.json(logs);
    } catch (error) {
        console.error('获取日志错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 获取用户操作日志（管理员查看所有用户）
app.get('/api/admin/user-logs', authenticateAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const offset = parseInt(req.query.offset) || 0;
        const logs = await db.all(`
            SELECT * FROM user_action_logs 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `, [limit, offset]);
        res.json(logs);
    } catch (error) {
        console.error('获取用户日志错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== 商品管理 ==========
app.get('/api/products', authenticate, async (req, res) => { try { res.json(await db.getAllProducts(req.session.userId)); } catch (error) { res.status(500).json({ error: error.message }); } });
app.get('/api/products/global/:sku', authenticate, async (req, res) => { 
  try { 
    const product = await db.getProductBySkuGlobal(req.params.sku);
    res.json(product || null);
  } catch (error) { res.status(500).json({ error: error.message }); } 
});
app.get('/api/products/:sku', authenticate, async (req, res) => { try { res.json(await db.getProductBySku(req.session.userId, req.params.sku) || null); } catch (error) { res.status(500).json({ error: error.message }); } });
app.post('/api/products', authenticate, async (req, res) => {
  try {
    const product = req.body;
    if (!product.sku || !product.name || !product.shelf_life || !product.reminder_days || !product.location) return res.status(400).json({ error: '缺少必要字段' });
    if (!/^\d{5}$/.test(product.sku)) return res.status(400).json({ error: 'SKU必须为5位数字编码' });
    if (product.shelf_life <= 0 || product.shelf_life > 3650) return res.status(400).json({ error: '保质期天数必须在1-3650之间' });
    if (product.reminder_days < 0) return res.status(400).json({ error: '临期提醒天数不能为负数' });
    if (product.reminder_days > product.shelf_life) return res.status(400).json({ error: '临期提醒天数不能大于保质期天数' });
    const result = await db.addProduct(req.session.userId, product);
    await db.addUserActionLog(req.session.userId, req.session.username, 'add', 'product', product.sku, `添加商品: ${product.name}`, getClientIp(req), req.headers['user-agent']);
    res.json({ success: true, id: result.id, message: '商品已成功添加到数据库' });
  } catch (error) { if (error.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ error: `SKU "${req.body.sku}" 已存在` }); res.status(500).json({ error: error.message }); }
});
app.put('/api/products/:sku', authenticate, async (req, res) => {
  try {
    const product = req.body;
    if (parseInt(product.reminder_days) > parseInt(product.shelf_life)) return res.status(400).json({ error: '临期提醒天数不能大于保质期天数' });
    await db.updateProduct(req.session.userId, req.params.sku, product);
    await db.addUserActionLog(req.session.userId, req.session.username, 'update', 'product', req.params.sku, `更新商品: ${product.name}`, getClientIp(req), req.headers['user-agent']);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.delete('/api/products/:sku', authenticate, async (req, res) => {
  try {
    await db.deleteProduct(req.session.userId, req.params.sku);
    await db.addUserActionLog(req.session.userId, req.session.username, 'delete', 'product', req.params.sku, `删除商品`, getClientIp(req), req.headers['user-agent']);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ========== 库存记录 ==========
app.get('/api/records', authenticate, async (req, res) => { try { res.json(await db.getAllProductRecords(req.session.userId)); } catch (error) { res.status(500).json({ error: error.message }); } });
app.get('/api/records/by-sku/:sku', authenticate, async (req, res) => { try { res.json(await db.getRecordsBySku(req.session.userId, req.params.sku)); } catch (error) { res.status(500).json({ error: error.message }); } });
app.post('/api/records', authenticate, async (req, res) => {
  try {
    const record = req.body;
    if (!record.sku || !record.production_date || !record.shelf_life) return res.status(400).json({ error: '缺少必要字段' });
    const result = await db.addProductRecord(req.session.userId, record);
    await db.addUserActionLog(req.session.userId, req.session.username, 'add', 'record', `${record.sku}|${record.production_date}`, `添加库存: ${record.name}`, getClientIp(req), req.headers['user-agent']);
    res.json({ success: true, id: result.id });
  } catch (error) { if (error.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ error: '相同SKU和生产日期的记录已存在' }); res.status(500).json({ error: error.message }); }
});
app.delete('/api/records/:sku/:productionDate', authenticate, async (req, res) => {
  try {
    await db.deleteProductRecord(req.session.userId, req.params.sku, req.params.productionDate);
    await db.addUserActionLog(req.session.userId, req.session.username, 'delete', 'record', `${req.params.sku}|${req.params.productionDate}`, `删除库存记录`, getClientIp(req), req.headers['user-agent']);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ========== 图片管理 ==========
app.get('/api/images/:sku', authenticate, async (req, res) => { try { res.json(await db.getProductImage(req.params.sku) || null); } catch (error) { res.status(500).json({ error: error.message }); } });
app.post('/api/images/:sku', authenticate, async (req, res) => {
  try {
    let { imageData, imageMime } = req.body;
    if (imageData && imageData.length > 8 * 1024 * 1024) return res.status(400).json({ error: '图片过大，请压缩后上传' });
    await db.saveProductImage(req.params.sku, imageData, imageMime);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.delete('/api/images/:sku', authenticate, async (req, res) => { try { await db.deleteProductImage(req.params.sku); res.json({ success: true }); } catch (error) { res.status(500).json({ error: error.message }); } });

// ========== 后悔药 ==========
app.get('/api/deleted-records', authenticate, async (req, res) => { try { res.json(await db.getDeletedRecords(req.session.userId)); } catch (error) { res.status(500).json({ error: error.message }); } });
app.post('/api/deleted-records/:id/restore', authenticate, async (req, res) => {
  try {
    const result = await db.restoreDeletedRecord(req.session.userId, req.params.id);
    if (!result.success) return res.status(400).json({ error: result.error });
    await db.addUserActionLog(req.session.userId, req.session.username, 'restore', 'deleted_record', req.params.id, '恢复删除记录', getClientIp(req), req.headers['user-agent']);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.delete('/api/deleted-records', authenticate, async (req, res) => { try { await db.clearDeletedRecords(req.session.userId); res.json({ success: true }); } catch (error) { res.status(500).json({ error: error.message }); } });
app.delete('/api/deleted-records/:id', authenticate, async (req, res) => { try { await db.deleteDeletedRecord(req.session.userId, req.params.id); res.json({ success: true }); } catch (error) { res.status(500).json({ error: error.message }); } });

// ========== 导入导出 ==========
app.get('/api/export', authenticate, async (req, res) => {
  try {
    const data = await db.exportUserProducts(req.session.userId);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=export_${req.session.username}_${new Date().toISOString().split('T')[0]}.json`);
    res.json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/import', authenticate, async (req, res) => {
  try {
    const { products, records } = req.body;
    if ((!products || products.length === 0) && (!records || records.length === 0)) return res.status(400).json({ error: '没有可导入的数据' });
    const results = await db.importUserProducts(req.session.userId, products || [], records || []);
    await db.addUserActionLog(req.session.userId, req.session.username, 'import', 'data', null, `导入数据: 商品${results.productsAdded}个, 库存${results.recordsAdded}条`, getClientIp(req), req.headers['user-agent']);
    res.json({ success: true, results });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/reset', authenticate, async (req, res) => {
  try {
    const result = await db.resetUserData(req.session.userId);
    await db.addUserActionLog(req.session.userId, req.session.username, 'reset', 'data', null, '清空所有数据', getClientIp(req), req.headers['user-agent']);
    res.json({ success: true, message: result.message });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ========== 密码管理 ==========
app.post('/api/user/verify-password', authenticate, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: '请输入密码' });
    
    const bcrypt = require('bcryptjs');
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    
    const isValid = bcrypt.compareSync(password, user.password);
    if (!isValid) return res.status(401).json({ valid: false, error: '密码错误' });
    
    res.json({ valid: true });
  } catch (error) { 
    console.error('密码验证错误:', error);
    res.status(500).json({ error: error.message }); 
  }
});

app.post('/api/user/change-password', authenticate, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写完整信息' });
    if (newPassword.length < 6) return res.status(400).json({ error: '新密码长度至少6位' });
    
    const bcrypt = require('bcryptjs');
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    
    const isValid = bcrypt.compareSync(oldPassword, user.password);
    if (!isValid) return res.status(401).json({ error: '当前密码错误' });
    
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    await db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.session.userId]);
    
    await db.addUserActionLog(req.session.userId, req.session.username, 'change_password', 'user', null, '修改密码', getClientIp(req), req.headers['user-agent']);
    res.json({ success: true, message: '密码修改成功，请重新登录' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ========== 静态文件 ==========
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(path.join(__dirname, '.')));
app.use((req, res) => { if (!req.path.startsWith('/api/')) res.sendFile(path.join(__dirname, 'index.html')); else res.status(404).json({ error: '接口不存在' }); });

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  const message = IS_PRODUCTION ? '服务器内部错误' : err.message;
  res.status(500).json({ error: message });
});

// ========== 定时任务 ==========
let isCleanupRunning = false;
let isNotificationRunning = false;

const scheduleCleanup = () => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const msUntilMidnight = Math.max(tomorrow - now, 60000);
  
  setTimeout(async () => {
    if (isCleanupRunning) {
      console.log('⚠️ 清理任务已在运行，跳过');
      scheduleCleanup();
      return;
    }
    
    isCleanupRunning = true;
    try {
      await db.run('DELETE FROM deleted_records WHERE restored_at IS NULL AND deleted_at < datetime("now", "-7 days")');
      console.log('✅ 已清理过期删除记录');
    } catch (error) {
      console.error('❌ 清理删除记录失败:', error);
    } finally {
      isCleanupRunning = false;
      scheduleCleanup();
    }
  }, msUntilMidnight);
};

scheduleCleanup();

// 优雅关闭
process.on('SIGINT', async () => { 
  console.log('\n🛑 正在关闭服务器...'); 
  await db.close(); 
  process.exit(0); 
});
process.on('SIGTERM', async () => { 
  console.log('\n🛑 收到终止信号，正在关闭...'); 
  await db.close(); 
  process.exit(0); 
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📱 访问地址: http://localhost:${PORT}`);
  console.log(`🔐 管理员: admin / admin123`);
  console.log(`🌍 环境: ${IS_PRODUCTION ? '生产' : '开发'}`);
});

module.exports = app;