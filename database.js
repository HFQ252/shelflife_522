const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// 重试装饰器 - 解决SQLite并发锁定问题
async function withRetry(fn, retries = 3, delay = 100) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if ((err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED') && i < retries - 1) {
        await new Promise(r => setTimeout(r, delay * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

// 北京时间日期工具函数（UTC+8）
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

function formatBJDate(date) {
    if (!date) return '';
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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

// 允许排序的字段白名单（防止SQL注入）
const ALLOWED_SORT_FIELDS = new Set(['remaining_days', 'name', 'sku', 'production_date']);
const ALLOWED_SORT_ORDERS = new Set(['asc', 'desc']);

class Database {
  constructor() {
    const dbDir = process.env.DATABASE_DIR || (process.env.ZEABUR ? '/data' : './data');
    
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      if (!IS_PRODUCTION) console.log(`📁 创建数据库目录: ${dbDir}`);
    }
    
    const dbPath = path.join(dbDir, 'product_expiry.db');
    if (!IS_PRODUCTION) console.log(`📊 数据库路径: ${dbPath}`);
    
    this.db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('❌ 数据库连接错误:', err.message);
      } else {
        this.db.run("PRAGMA busy_timeout = 30000");
        this.db.run("PRAGMA journal_mode = WAL");
        this.db.run("PRAGMA synchronous = NORMAL");
        this.db.run("PRAGMA cache_size = -20000");
        this.db.run("PRAGMA temp_store = MEMORY");
        if (!IS_PRODUCTION) console.log('✅ 已连接到SQLite数据库');
        this.initializeDatabase();
      }
    });
  }

  async run(sql, params = []) {
    return withRetry(() => {
      return new Promise((resolve, reject) => {
        this.db.run(sql, params, function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, changes: this.changes });
        });
      });
    });
  }

  async get(sql, params = []) {
    return withRetry(() => {
      return new Promise((resolve, reject) => {
        this.db.get(sql, params, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    });
  }

  async all(sql, params = []) {
    return withRetry(() => {
      return new Promise((resolve, reject) => {
        this.db.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    });
  }

  async transaction(callback) {
    return withRetry(async () => {
      await this.run('BEGIN TRANSACTION');
      try {
        const result = await callback();
        await this.run('COMMIT');
        return result;
      } catch (error) {
        await this.run('ROLLBACK');
        throw error;
      }
    });
  }

  async initializeDatabase() {
    try {
      await this.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          email TEXT,
          role TEXT DEFAULT 'user',
          password_failures INTEGER DEFAULT 0,
          locked_until TIMESTAMP,
          valid_until DATE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_login TIMESTAMP
        )
      `);

      await this.run(`
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          sku TEXT NOT NULL,
          name TEXT NOT NULL,
          shelf_life INTEGER NOT NULL,
          reminder_days INTEGER NOT NULL,
          location TEXT NOT NULL,
          category TEXT DEFAULT '其他',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          UNIQUE(user_id, sku)
        )
      `);

      try {
        await this.run('ALTER TABLE products ADD COLUMN category TEXT DEFAULT "其他"');
      } catch(e) { }

      await this.run(`
        CREATE TABLE IF NOT EXISTS product_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          sku TEXT NOT NULL,
          name TEXT NOT NULL,
          production_date DATE NOT NULL,
          shelf_life INTEGER NOT NULL,
          reminder_days INTEGER NOT NULL,
          location TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          UNIQUE(user_id, sku, production_date)
        )
      `);

      await this.run(`
        CREATE TABLE IF NOT EXISTS product_images (
          sku TEXT PRIMARY KEY,
          image_data TEXT,
          image_mime TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await this.run(`
        CREATE TABLE IF NOT EXISTS auth_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL,
          created_by INTEGER NOT NULL,
          valid_until DATE NOT NULL,
          status TEXT DEFAULT 'active',
          used_by INTEGER,
          used_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users (id)
        )
      `);

      await this.run(`
        CREATE TABLE IF NOT EXISTS admin_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id INTEGER,
          admin_name TEXT,
          action TEXT,
          target_user TEXT,
          details TEXT,
          ip_address TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await this.run(`
        CREATE TABLE IF NOT EXISTS deleted_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          sku TEXT NOT NULL,
          name TEXT NOT NULL,
          production_date DATE NOT NULL,
          shelf_life INTEGER NOT NULL,
          reminder_days INTEGER NOT NULL,
          location TEXT NOT NULL,
          category TEXT DEFAULT '其他',
          deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          restored_at TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      await this.run(`
        CREATE TABLE IF NOT EXISTS user_preferences (
          user_id INTEGER PRIMARY KEY,
          category_filter TEXT DEFAULT 'all',
          sort_field TEXT DEFAULT 'remaining_days',
          sort_order TEXT DEFAULT 'asc',
          page_size INTEGER DEFAULT 20,
          notification_enabled INTEGER DEFAULT 1,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      await this.run(`
        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          type TEXT DEFAULT 'info',
          is_read INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      await this.run(`
        CREATE TABLE IF NOT EXISTS user_action_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          details TEXT,
          ip_address TEXT,
          user_agent TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `);

      // 优化索引
      await this.run('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_users_valid ON users(valid_until)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_products_user_sku ON products(user_id, sku)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_products_user_category ON products(user_id, category)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_records_user_sku ON product_records(user_id, sku)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_records_user_production ON product_records(user_id, production_date)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_records_production ON product_records(production_date)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_auth_codes_code ON auth_codes(code)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_auth_codes_status ON auth_codes(status)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_deleted_user_date ON deleted_records(user_id, deleted_at)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_logs_user_created ON user_action_logs(user_id, created_at)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read)');

      if (!IS_PRODUCTION) console.log('✅ 数据库表初始化完成');

      const adminExists = await this.get('SELECT id FROM users WHERE username = ?', ['admin']);
      if (!adminExists) {
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        const validUntil = new Date();
        validUntil.setFullYear(validUntil.getFullYear() + 99);
        await this.run(
          'INSERT INTO users (username, password, email, role, valid_until) VALUES (?, ?, ?, ?, ?)',
          ['admin', hashedPassword, 'admin@example.com', 'admin', validUntil.toISOString().split('T')[0]]
        );
        if (!IS_PRODUCTION) {
          console.log('✅ 创建默认管理员账户: admin / admin123');
        }
      }

    } catch (error) {
      console.error('❌ 数据库初始化错误:', error);
    }
  }

  // ========== 用户管理 ==========
  async createUser(username, password, email = '', authCode = null, validUntil = null) {
    if (authCode) {
      const codeValid = await this.verifyAuthCode(authCode);
      if (!codeValid) {
        return { success: false, error: '授权码无效或已过期' };
      }
    }
    
    const hashedPassword = bcrypt.hashSync(password, 10);
    let expiryDate = validUntil;
    if (!expiryDate) {
      expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + 6);
      expiryDate = expiryDate.toISOString().split('T')[0];
    }
    
    try {
      const result = await this.run(
        'INSERT INTO users (username, password, email, role, valid_until, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [username, hashedPassword, email, 'user', expiryDate]
      );
      
      if (authCode) {
        await this.run(
          'UPDATE auth_codes SET status = ?, used_by = ?, used_at = CURRENT_TIMESTAMP WHERE code = ?',
          ['used', result.id, authCode]
        );
      }
      
      return { success: true, id: result.id };
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT') {
        return { success: false, error: '用户名已存在' };
      }
      throw error;
    }
  }

  async authenticateUser(username, password, ip = null) {
    try {
      const user = await this.get('SELECT * FROM users WHERE username = ?', [username]);
      if (!user) return { success: false, error: '用户不存在' };

      if (user.locked_until) {
        const lockedUntil = new Date(user.locked_until);
        if (lockedUntil > new Date()) {
          const remainingMinutes = Math.ceil((lockedUntil - new Date()) / 60000);
          return { success: false, error: `账户已锁定，请${remainingMinutes}分钟后再试` };
        } else {
          await this.run('UPDATE users SET password_failures = 0, locked_until = NULL WHERE id = ?', [user.id]);
        }
      }

      if (user.role !== 'admin' && user.valid_until) {
        const validUntil = new Date(user.valid_until);
        if (validUntil < new Date()) {
          return { success: false, error: '账号已过期，请联系管理员续期' };
        }
      }

      const isValid = bcrypt.compareSync(password, user.password);
      
      if (!isValid) {
        const newFailures = (user.password_failures || 0) + 1;
        let lockedUntil = null;
        
        if (newFailures >= 5) {
          lockedUntil = new Date();
          lockedUntil.setMinutes(lockedUntil.getMinutes() + 30);
          await this.run(
            'UPDATE users SET password_failures = ?, locked_until = ? WHERE id = ?',
            [newFailures, lockedUntil.toISOString(), user.id]
          );
          return { success: false, error: '密码错误次数过多，账户已锁定30分钟' };
        }
        
        await this.run('UPDATE users SET password_failures = ? WHERE id = ?', [newFailures, user.id]);
        return { success: false, error: `密码错误，还剩${5 - newFailures}次尝试机会` };
      }

      await this.run(
        'UPDATE users SET password_failures = 0, last_login = CURRENT_TIMESTAMP WHERE id = ?',
        [user.id]
      );

      if (user.role === 'admin' && ip) {
        await this.addAdminLog(user.id, user.username, 'login', null, `管理员登录 IP: ${ip}`, ip);
      }

      delete user.password;
      return { success: true, user };
    } catch (error) {
      throw error;
    }
  }

  async getUserById(id) {
    return this.get('SELECT id, username, email, role, created_at, last_login, valid_until FROM users WHERE id = ?', [id]);
  }

  async getAllUsers() {
    return this.all('SELECT id, username, email, role, created_at, last_login, valid_until, password_failures FROM users ORDER BY id');
  }

  async updateUserValidity(userId, validUntil) {
    return this.run('UPDATE users SET valid_until = ? WHERE id = ?', [validUntil, userId]);
  }

  async resetUserPassword(userId, newPassword) {
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    return this.run('UPDATE users SET password = ?, password_failures = 0, locked_until = NULL WHERE id = ?', [hashedPassword, userId]);
  }

  async deleteUser(userId) {
    return this.transaction(async () => {
      await this.run('DELETE FROM products WHERE user_id = ?', [userId]);
      await this.run('DELETE FROM product_records WHERE user_id = ?', [userId]);
      await this.run('DELETE FROM deleted_records WHERE user_id = ?', [userId]);
      await this.run('DELETE FROM user_preferences WHERE user_id = ?', [userId]);
      await this.run('DELETE FROM notifications WHERE user_id = ?', [userId]);
      await this.run('DELETE FROM user_action_logs WHERE user_id = ?', [userId]);
      return await this.run('DELETE FROM users WHERE id = ? AND role != "admin"', [userId]);
    });
  }

  // ========== 授权码管理 ==========
  generateAuthCode() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  async createAuthCode(adminId, validUntil) {
    const code = this.generateAuthCode();
    await this.run(
      'INSERT INTO auth_codes (code, created_by, valid_until, status) VALUES (?, ?, ?, ?)',
      [code, adminId, validUntil, 'active']
    );
    return code;
  }

  async getAllAuthCodes() {
    return this.all(`
      SELECT ac.*, u.username as created_by_name, u2.username as used_by_name
      FROM auth_codes ac
      LEFT JOIN users u ON ac.created_by = u.id
      LEFT JOIN users u2 ON ac.used_by = u2.id
      ORDER BY ac.created_at DESC
    `);
  }

  async updateAuthCode(codeId, validUntil, status = null) {
    let sql = 'UPDATE auth_codes SET valid_until = ?';
    const params = [validUntil];
    if (status) {
      sql += ', status = ?';
      params.push(status);
    }
    sql += ' WHERE id = ?';
    params.push(codeId);
    return this.run(sql, params);
  }

  async deleteAuthCode(codeId) {
    return this.run('DELETE FROM auth_codes WHERE id = ? AND status = "active"', [codeId]);
  }

  async verifyAuthCode(code) {
    const result = await this.get(
      'SELECT * FROM auth_codes WHERE code = ? AND status = "active" AND valid_until >= date("now")',
      [code]
    );
    return result !== undefined;
  }

  // ========== 日志管理 ==========
  async addAdminLog(adminId, adminName, action, targetUser, details, ipAddress = null) {
    return this.run(
      'INSERT INTO admin_logs (admin_id, admin_name, action, target_user, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
      [adminId, adminName, action, targetUser, details, ipAddress]
    );
  }

  async getAdminLogs(limit = 100) {
    return this.all('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT ?', [limit]);
  }

  // ========== 用户操作日志 ==========
  async addUserActionLog(userId, username, action, targetType, targetId, details, ip, userAgent) {
    return this.run(
      `INSERT INTO user_action_logs (user_id, username, action, target_type, target_id, details, ip_address, user_agent) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, username, action, targetType, targetId, details, ip, userAgent]
    );
  }

  async getUserActionLogs(userId, limit = 100, offset = 0) {
    return this.all(
      `SELECT * FROM user_action_logs 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
  }

  // ========== 用户偏好 ==========
  async getUserPreference(userId) {
    let pref = await this.get('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
    if (!pref) {
      await this.run(
        `INSERT INTO user_preferences (user_id, category_filter, sort_field, sort_order, page_size, notification_enabled) 
         VALUES (?, 'all', 'remaining_days', 'asc', 20, 1)`,
        [userId]
      );
      pref = await this.get('SELECT * FROM user_preferences WHERE user_id = ?', [userId]);
    }
    return pref;
  }

  async updateUserPreference(userId, preferences) {
    const { category_filter, sort_field, sort_order, page_size, notification_enabled } = preferences;
    return this.run(
      `UPDATE user_preferences 
       SET category_filter = COALESCE(?, category_filter),
           sort_field = COALESCE(?, sort_field),
           sort_order = COALESCE(?, sort_order),
           page_size = COALESCE(?, page_size),
           notification_enabled = COALESCE(?, notification_enabled),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`,
      [category_filter, sort_field, sort_order, page_size, notification_enabled, userId]
    );
  }

  // ========== 通知管理 ==========
  async addNotification(userId, title, message, type = 'info') {
    return this.run(
      `INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)`,
      [userId, title, message, type]
    );
  }

  async getUnreadNotifications(userId) {
    return this.all(
      `SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC`,
      [userId]
    );
  }

  async markNotificationRead(notificationId) {
    return this.run('UPDATE notifications SET is_read = 1 WHERE id = ?', [notificationId]);
  }

  // ========== 后悔药管理 ==========
  async addToDeletedRecords(userId, record) {
    const { sku, name, production_date, shelf_life, reminder_days, location, category = '其他' } = record;
    return this.run(
      `INSERT INTO deleted_records (user_id, sku, name, production_date, shelf_life, reminder_days, location, category, deleted_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [userId, sku, name, production_date, shelf_life, reminder_days, location, category]
    );
  }

  async getDeletedRecords(userId) {
    return this.all(
      'SELECT * FROM deleted_records WHERE user_id = ? AND restored_at IS NULL ORDER BY deleted_at DESC LIMIT 100',
      [userId]
    );
  }

  async restoreDeletedRecord(userId, recordId) {
    return this.transaction(async () => {
      const deleted = await this.get('SELECT * FROM deleted_records WHERE id = ? AND user_id = ?', [recordId, userId]);
      if (!deleted) return { success: false, error: '记录不存在' };
      
      const existing = await this.get(
        'SELECT id FROM product_records WHERE user_id = ? AND sku = ? AND production_date = ?',
        [userId, deleted.sku, deleted.production_date]
      );
      
      if (existing) {
        return { success: false, error: '该商品记录已存在，无法恢复' };
      }
      
      await this.run(
        `INSERT INTO product_records (user_id, sku, name, production_date, shelf_life, reminder_days, location) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, deleted.sku, deleted.name, deleted.production_date, deleted.shelf_life, deleted.reminder_days, deleted.location]
      );
      
      await this.run('UPDATE deleted_records SET restored_at = CURRENT_TIMESTAMP WHERE id = ?', [recordId]);
      return { success: true };
    });
  }

  async clearDeletedRecords(userId) {
    return this.run('DELETE FROM deleted_records WHERE user_id = ?', [userId]);
  }

  async deleteDeletedRecord(userId, recordId) {
    return this.run('DELETE FROM deleted_records WHERE id = ? AND user_id = ?', [recordId, userId]);
  }

  async cleanOldDeletedRecords(userId) {
    return this.run(
      'DELETE FROM deleted_records WHERE user_id = ? AND deleted_at < datetime("now", "-7 days")',
      [userId]
    );
  }

  // ========== 商品管理 ==========
  async getAllProducts(userId) {
    return this.all('SELECT * FROM products WHERE user_id = ? ORDER BY sku', [userId]);
  }

  async getProductBySku(userId, sku) {
    return this.get('SELECT * FROM products WHERE user_id = ? AND sku = ?', [userId, sku]);
  }

  async getProductBySkuGlobal(sku) {
    return this.get('SELECT sku, name, shelf_life, reminder_days, location, category FROM products WHERE sku = ? LIMIT 1', [sku]);
  }

  async addProduct(userId, product) {
    const { sku, name, shelf_life, reminder_days, location, category = '其他' } = product;
    return this.run(
      'INSERT INTO products (user_id, sku, name, shelf_life, reminder_days, location, category) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, sku, name, shelf_life, reminder_days, location, category]
    );
  }

  async updateProduct(userId, sku, product) {
    const { name, shelf_life, reminder_days, location, category = '其他' } = product;
    return this.run(
      'UPDATE products SET name = ?, shelf_life = ?, reminder_days = ?, location = ?, category = ? WHERE user_id = ? AND sku = ?',
      [name, shelf_life, reminder_days, location, category, userId, sku]
    );
  }

  async deleteProduct(userId, sku) {
    return this.transaction(async () => {
      const records = await this.all('SELECT * FROM product_records WHERE user_id = ? AND sku = ?', [userId, sku]);
      if (records.length > 0) {
        for (const record of records) {
          await this.addToDeletedRecords(userId, record);
        }
        await this.run('DELETE FROM product_records WHERE user_id = ? AND sku = ?', [userId, sku]);
      }
      return await this.run('DELETE FROM products WHERE user_id = ? AND sku = ?', [userId, sku]);
    });
  }

  // ========== 商品图片 ==========
  async saveProductImage(sku, imageData, imageMime) {
    return this.run(
      `INSERT INTO product_images (sku, image_data, image_mime, updated_at) 
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(sku) DO UPDATE SET 
         image_data = excluded.image_data,
         image_mime = excluded.image_mime,
         updated_at = CURRENT_TIMESTAMP`,
      [sku, imageData, imageMime]
    );
  }

  async getProductImage(sku) {
    return this.get('SELECT image_data, image_mime FROM product_images WHERE sku = ?', [sku]);
  }

  async deleteProductImage(sku) {
    return this.run('DELETE FROM product_images WHERE sku = ?', [sku]);
  }

  // ========== 库存记录管理 ==========
  async getAllProductRecords(userId) {
    const records = await this.all(`
      SELECT * FROM product_records 
      WHERE user_id = ? 
      ORDER BY 
        CASE 
          WHEN date(production_date, '+' || shelf_life || ' days') < date('now', '+8 hours') THEN 0
          WHEN date(production_date, '+' || shelf_life || ' days') <= date('now', '+8 hours', '+' || reminder_days || ' days') THEN 1
          ELSE 2
        END,
        date(production_date, '+' || shelf_life || ' days') ASC
    `, [userId]);
    
    for (const record of records) {
      record.remaining_days = calculateRemainingDaysBJ(record.production_date, record.shelf_life);
    }
    
    return records;
  }

  async getRecordsBySku(userId, sku) {
    const records = await this.all('SELECT * FROM product_records WHERE user_id = ? AND sku = ?', [userId, sku]);
    for (const record of records) {
      record.remaining_days = calculateRemainingDaysBJ(record.production_date, record.shelf_life);
    }
    return records;
  }

  async getExpiringProducts(userId) {
    const records = await this.all(`
      SELECT * FROM product_records 
      WHERE user_id = ?
      ORDER BY date(production_date, '+' || shelf_life || ' days') ASC
    `, [userId]);
    
    const expiring = [];
    for (const record of records) {
      const remainingDays = calculateRemainingDaysBJ(record.production_date, record.shelf_life);
      record.remaining_days = remainingDays;
      if (remainingDays <= record.reminder_days) {
        expiring.push(record);
      }
    }
    
    return expiring;
  }

  async addProductRecord(userId, record) {
    const { sku, name, production_date, shelf_life, reminder_days, location } = record;
    return this.run(
      `INSERT INTO product_records 
       (user_id, sku, name, production_date, shelf_life, reminder_days, location) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, sku, name, production_date, shelf_life, reminder_days, location]
    );
  }

  async deleteProductRecord(userId, sku, productionDate) {
    return this.transaction(async () => {
      const record = await this.get(
        'SELECT * FROM product_records WHERE user_id = ? AND sku = ? AND production_date = ?',
        [userId, sku, productionDate]
      );
      if (record) {
        await this.addToDeletedRecords(userId, record);
      }
      return await this.run(
        'DELETE FROM product_records WHERE user_id = ? AND sku = ? AND production_date = ?',
        [userId, sku, productionDate]
      );
    });
  }

  // ========== 分页查询 ==========
  async getProductRecordsPaginated(userId, page = 1, pageSize = 20, search = '', category = 'all', sortField = 'remaining_days', sortOrder = 'asc') {
    if (!ALLOWED_SORT_FIELDS.has(sortField)) {
      sortField = 'remaining_days';
    }
    if (!ALLOWED_SORT_ORDERS.has(sortOrder.toLowerCase())) {
      sortOrder = 'asc';
    }
    
    const offset = (page - 1) * pageSize;
    
    // 获取用户的所有商品分类映射
    const products = await this.getAllProducts(userId);
    const skuToCategory = new Map();
    products.forEach(p => skuToCategory.set(p.sku, p.category || '其他'));
    
    let whereClause = 'user_id = ?';
    const params = [userId];
    
    if (search) {
      whereClause += ' AND (name LIKE ? OR sku LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    const countResult = await this.get(
      `SELECT COUNT(*) as total FROM product_records WHERE ${whereClause}`,
      params
    );
    
    let orderClause = '';
    if (sortField === 'remaining_days') {
      orderClause = `ORDER BY 
        CASE 
          WHEN date(production_date, '+' || shelf_life || ' days') < date('now', '+8 hours') THEN 0
          WHEN date(production_date, '+' || shelf_life || ' days') <= date('now', '+8 hours', '+' || reminder_days || ' days') THEN 1
          ELSE 2
        END ${sortOrder === 'desc' ? 'DESC' : 'ASC'}`;
    } else if (sortField === 'name') {
      orderClause = `ORDER BY name ${sortOrder === 'desc' ? 'DESC' : 'ASC'}`;
    } else if (sortField === 'sku') {
      orderClause = `ORDER BY sku ${sortOrder === 'desc' ? 'DESC' : 'ASC'}`;
    } else {
      orderClause = `ORDER BY production_date ${sortOrder === 'desc' ? 'DESC' : 'ASC'}`;
    }
    
    let records = await this.all(
      `SELECT * FROM product_records 
       WHERE ${whereClause}
       ${orderClause}
       LIMIT ? OFFSET ?`,
      [...params, pageSize * 2, offset] // 多取一些用于分类过滤
    );
    
    for (const record of records) {
      record.remaining_days = calculateRemainingDaysBJ(record.production_date, record.shelf_life);
      record.category = skuToCategory.get(record.sku) || '其他';
    }
    
    // 分类过滤
    if (category !== 'all') {
      records = records.filter(r => r.category === category);
    }
    
    // 限制返回数量
    records = records.slice(0, pageSize);
    
    return {
      records,
      total: countResult?.total || 0,
      page,
      pageSize,
      totalPages: Math.ceil((countResult?.total || 0) / pageSize)
    };
  }

  // ========== 搜索商品 ==========
  async searchProducts(userId, keyword, category = 'all', limit = 50) {
    let sql = 'SELECT * FROM products WHERE user_id = ?';
    const params = [userId];
    
    if (keyword) {
      sql += ' AND (name LIKE ? OR sku LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    
    if (category !== 'all') {
      sql += ' AND category = ?';
      params.push(category);
    }
    
    sql += ' ORDER BY sku LIMIT ?';
    params.push(limit);
    
    return this.all(sql, params);
  }

  // ========== 批量操作 ==========
  async batchDeleteRecords(userId, items) {
    return this.transaction(async () => {
      let deletedCount = 0;
      for (const item of items) {
        const records = await this.getRecordsBySku(userId, item.sku);
        const record = records.find(r => r.production_date === item.production_date);
        if (record) {
          await this.addToDeletedRecords(userId, record);
          await this.deleteProductRecord(userId, item.sku, item.production_date);
          deletedCount++;
        }
      }
      return deletedCount;
    });
  }

  // ========== 导入导出 ==========
  async exportUserProducts(userId) {
    const products = await this.all('SELECT sku, name, shelf_life, reminder_days, location, category FROM products WHERE user_id = ?', [userId]);
    const records = await this.all('SELECT sku, name, production_date, shelf_life, reminder_days, location FROM product_records WHERE user_id = ?', [userId]);
    return { products, records, exportDate: new Date().toISOString(), version: '3.2.0' };
  }

  async importUserProducts(userId, products, records) {
    return this.transaction(async () => {
      const results = { productsAdded: 0, productsUpdated: 0, recordsAdded: 0, recordsSkipped: 0 };
      
      const existingProducts = await this.getAllProducts(userId);
      const existingSkuSet = new Set(existingProducts.map(p => p.sku));
      
      for (const product of products) {
        try {
          const existing = await this.get('SELECT id FROM products WHERE user_id = ? AND sku = ?', [userId, product.sku]);
          if (existing) {
            await this.run(
              'UPDATE products SET name = ?, shelf_life = ?, reminder_days = ?, location = ?, category = ? WHERE user_id = ? AND sku = ?',
              [product.name, product.shelf_life, product.reminder_days, product.location, product.category || '其他', userId, product.sku]
            );
            results.productsUpdated++;
            existingSkuSet.add(product.sku);
          } else {
            await this.run(
              'INSERT INTO products (user_id, sku, name, shelf_life, reminder_days, location, category) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [userId, product.sku, product.name, product.shelf_life, product.reminder_days, product.location, product.category || '其他']
            );
            results.productsAdded++;
            existingSkuSet.add(product.sku);
          }
        } catch (error) {
          console.error('导入商品失败:', error);
        }
      }
      
      for (const record of records) {
        if (!existingSkuSet.has(record.sku)) {
          results.recordsSkipped++;
          continue;
        }
        try {
          await this.run(
            `INSERT INTO product_records (user_id, sku, name, production_date, shelf_life, reminder_days, location) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, record.sku, record.name, record.production_date, record.shelf_life, record.reminder_days, record.location]
          );
          results.recordsAdded++;
        } catch (error) {
          if (error.code === 'SQLITE_CONSTRAINT') {
            results.recordsSkipped++;
          } else {
            console.error('导入库存记录失败:', error);
          }
        }
      }
      
      return results;
    });
  }

  async resetUserData(userId) {
    return this.transaction(async () => {
      await this.run('DELETE FROM products WHERE user_id = ?', [userId]);
      await this.run('DELETE FROM product_records WHERE user_id = ?', [userId]);
      await this.run('DELETE FROM deleted_records WHERE user_id = ?', [userId]);
      return { success: true, message: '用户数据已重置' };
    });
  }

  async cleanExpiredRecords(userId) {
    const todayBJ = formatBJDate(getBJToday());
    return this.run(
      'DELETE FROM product_records WHERE user_id = ? AND date(production_date, "+" || shelf_life || " days") < ?',
      [userId, todayBJ]
    );
  }

  close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else {
          if (!IS_PRODUCTION) console.log('✅ 数据库连接已关闭');
          resolve();
        }
      });
    });
  }
}

const db = new Database();
module.exports = db;