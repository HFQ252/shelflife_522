// script.js - 商品保质期管理系统 v3.2.0
// 修复版 - 解决登录后功能失效问题

const API_BASE_URL = window.location.origin;

const STORAGE_KEYS = {
    REMEMBER_ME: 'product_expiry_remember_me',
    SAVED_USERNAME: 'product_expiry_username',
    SAVED_PASSWORD: 'product_expiry_password',
    VIEW_HISTORY: 'view_history',
    LOW_DATA_MODE: 'lowDataMode'
};

// ========== 全局变量 ==========
let currentImageData = null;
let currentImageMime = null;
let html5QrCode = null;
let currentScanCallback = null;
let autoSaveTimer = null;
let isAutoSaveScheduled = false;
let cancelAutoSaveFlag = false;
let authCheckerInterval = null;
let isShowingLoginAlert = false;
let appInitialized = false;
let currentUserRole = null;
let currentUser = null;
let lastAuthCheck = 0;
const AUTH_CHECK_INTERVAL = 300000;
let lowDataMode = localStorage.getItem(STORAGE_KEYS.LOW_DATA_MODE) === 'true';
let viewHistory = [];
let pendingRequests = new Map();
let progressBar = null;
let currentPage = 1;
let pageSize = 20;
let totalPages = 1;
let currentSearchKeyword = '';
let currentCategoryFilter = 'all';
let currentSortField = 'remaining_days';
let currentSortOrder = 'asc';
let isLoadingMore = false;
let hasMoreData = true;
let notificationPermission = false;
let isDeletingInProgress = false;
let animationTimeout = null;
let pendingDeleteItem = null;
let autoSaveCountdownTimer = null;

// 模态框变量
let confirmModal = null;
let duplicateModal = null;
let scannerModal = null;
let imagePreviewModal = null;
let resetPasswordModal = null;
let validityModal = null;
let editCodeModal = null;
let changePwdModal = null;
let verifyPasswordModal = null;
let currentSelectedItem = null;
let deleteType = '';
let duplicateCheckResult = null;
let isEditingProduct = false;
let currentEditingSku = '';

// 加载视图历史
try {
    const savedHistory = localStorage.getItem(STORAGE_KEYS.VIEW_HISTORY);
    if (savedHistory) {
        viewHistory = JSON.parse(savedHistory);
        if (!Array.isArray(viewHistory)) viewHistory = [];
    }
} catch (e) {
    viewHistory = [];
}

// ========== LRU图片缓存（限制大小防内存泄漏） ==========
class LRUCache {
    constructor(limit = 50) {
        this.limit = limit;
        this.cache = new Map();
    }
    
    get(key) {
        if (!this.cache.has(key)) return null;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }
    
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.limit) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }
    
    clear() {
        this.cache.clear();
    }
}

const imageCache = new LRUCache(30);


// 缓存管理器
class DataCache {
    constructor() {
        this.products = null;
        this.records = null;
        this.expiring = null;
        this.lastFetch = { products: 0, records: 0, expiring: 0 };
        this.cacheDuration = 15 * 60 * 1000;
    }

    isValid(cacheKey) {
        const lastFetch = this.lastFetch[cacheKey];
        if (!lastFetch) return false;
        return (Date.now() - lastFetch) < this.cacheDuration;
    }

    async getProducts(forceRefresh = false) {
        if (!forceRefresh && this.isValid('products') && this.products) {
            return this.products;
        }
        this.products = await apiRequest('/api/products');
        if (this.products) {
            this.products.sort((a, b) => a.sku.localeCompare(b.sku));
        } else {
            this.products = [];
        }
        this.lastFetch.products = Date.now();
        return this.products;
    }

    async getRecords(forceRefresh = false) {
        if (!forceRefresh && this.isValid('records') && this.records) {
            return this.records;
        }
        this.records = await apiRequest('/api/records');
        if (this.records) {
            this.records.forEach(r => {
                r.remaining_days = calculateRemainingDaysLocal(r.production_date, r.shelf_life);
            });
            this.records.sort((a, b) => a.remaining_days - b.remaining_days);
        } else {
            this.records = [];
        }
        this.lastFetch.records = Date.now();
        return this.records;
    }

    async getExpiring(forceRefresh = false) {
        if (!forceRefresh && this.isValid('expiring') && this.expiring) {
            return this.expiring;
        }
        const records = await this.getRecords(forceRefresh);
        this.expiring = records.filter(r => {
            const remaining = r.remaining_days;
            const reminder = r.reminder_days || 0;
            return remaining <= reminder;
        });
        this.lastFetch.expiring = Date.now();
        return this.expiring;
    }

    clear() {
        this.products = null;
        this.records = null;
        this.expiring = null;
        this.lastFetch = { products: 0, records: 0, expiring: 0 };
        imageCache.clear();
    }
}

const dataCache = new DataCache();

// ========== 北京时间日期工具函数 ==========
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

window.formatDateLocal = function(date) {
    if (!date) return '-';
    if (!(date instanceof Date)) date = new Date(date);
    if (isNaN(date.getTime())) return '-';
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

window.calculateRemainingDaysLocal = function(productionDate, shelfLife) {
    try {
        const prodDate = createBJDate(productionDate);
        if (!prodDate) return 0;
        const expiryDate = new Date(prodDate);
        expiryDate.setUTCDate(prodDate.getUTCDate() + shelfLife);
        const today = getBJToday();
        const diffTime = expiryDate.getTime() - today.getTime();
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    } catch(e) {
        console.error('日期计算错误:', e);
        return 0;
    }
};

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ========== 进度条 ==========
function showProgress(percent) {
    if (!progressBar) {
        progressBar = document.getElementById('progressBar');
    }
    if (progressBar) {
        progressBar.style.width = `${percent}%`;
        if (percent >= 100) {
            setTimeout(() => { if(progressBar) progressBar.style.width = '0%'; }, 500);
        }
    }
}

// ========== 震动反馈 ==========
function vibrate(pattern = 50) {
    if ('vibrate' in navigator && !lowDataMode && navigator.vibrate) {
        navigator.vibrate(pattern);
    }
}

// ========== 防抖函数 ==========
function debounce(func, wait, immediate = false) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            timeout = null;
            if (!immediate) func(...args);
        };
        const callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func(...args);
    };
}

// ========== API请求（增强版 - 带重试和会话刷新） ==========
async function tryRefreshSession() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/extend`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
        return response.ok;
    } catch (e) {
        console.log('会话刷新失败:', e);
        return false;
    }
}

async function apiRequest(endpoint, method = 'GET', data = null, timeout = 30000, retries = 2) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const options = { 
        method, 
        headers: { 'Content-Type': 'application/json' }, 
        credentials: 'include', 
        signal: controller.signal 
    };
    if (data) options.body = JSON.stringify(data);
    
    for (let i = 0; i <= retries; i++) {
        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
            clearTimeout(timeoutId);
            
            if (response.status === 401) { 
                // 尝试刷新会话
                const refreshed = await tryRefreshSession();
                if (refreshed && i < retries) {
                    console.log('会话已刷新，重试请求...');
                    continue;
                }
                await checkAuth(true); 
                throw new Error('未授权，请重新登录');
            }
            
            if (response.status === 204) return null;
            const responseText = await response.text();
            let result = responseText ? JSON.parse(responseText) : null;
            if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
            return result;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('请求超时，请检查网络');
            }
            if (i === retries) {
                console.error('API请求错误:', error);
                if (error.message && !error.message.includes('未授权')) {
                    showAlert(`请求失败: ${error.message}`, 'danger');
                }
                throw error;
            }
            // 等待后重试
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
}

async function getProductLocation(sku) {
    try {
        const product = await apiRequest(`/api/products/${sku}`);
        return product?.location || null;
    } catch (error) { 
        return null; 
    }
}

async function getProductImageUrl(sku) {
    // 先检查缓存
    const cached = imageCache.get(sku);
    if (cached) return cached;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/images/${sku}`, { credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            if (data && data.image_data) {
                imageCache.set(sku, data.image_data);
                return data.image_data;
            }
        }
    } catch (error) {
        console.log('加载图片失败:', error);
    }
    return null;

}

// ========== 图片保存和删除函数 ==========
async function saveProductImage(sku) {
    if (!currentImageData) {
        console.log('没有图片数据');
        return false;
    }
    
    console.log('保存图片, SKU:', sku, '图片大小:', currentImageData.length);
    
    try {
        const result = await apiRequest(`/api/images/${sku}`, 'POST', { 
            imageData: currentImageData, 
            imageMime: currentImageMime || 'image/jpeg' 
        });
        console.log('图片保存响应:', result);
        return true;
    } catch (error) {
        console.error('保存图片失败:', error);
        return false;
    }
}

async function deleteProductImage(sku) {
    try {
        await apiRequest(`/api/images/${sku}`, 'DELETE');
        return true;
    } catch (error) {
        console.error('删除图片失败:', error);
        return false;
    }
}

async function loadProductImage(sku) {
    try {
        const data = await apiRequest(`/api/images/${sku}`);
        if (data && data.image_data) {
            currentImageData = data.image_data;
            currentImageMime = data.image_mime;
            const container = document.getElementById('imagePreviewContainer');
            if (container) {
                container.innerHTML = `<img src="${currentImageData}" class="image-preview" style="max-width:100%;max-height:150px;border-radius:8px;">`;
            }
            const removeBtn = document.getElementById('removeImageBtn');
            if (removeBtn) removeBtn.style.display = 'inline-block';
            return true;
        }
    } catch (error) {
        console.log('加载图片失败:', error);
    }
    return false;
}

// ========== 修复 addNewProduct 函数 ==========
async function addNewProduct() {
    const newSkuElem = document.getElementById('newSku');
    const newNameElem = document.getElementById('newName');
    const newShelfLifeElem = document.getElementById('newShelfLife');
    const newReminderDaysElem = document.getElementById('newReminderDays');
    const newLocationElem = document.getElementById('newLocation');
    const categorySelect = document.getElementById('newCategory');
    
    // 获取值并去除前后空格
    const sku = newSkuElem?.value?.trim();
    const name = newNameElem?.value?.trim();
    const shelfLife = parseInt(newShelfLifeElem?.value?.trim());
    const reminderDays = parseInt(newReminderDaysElem?.value?.trim());
    const location = newLocationElem?.value?.trim();
    const category = categorySelect?.value || '其他';
    
    // 详细验证
    if (!sku) {
        showAlert('请输入SKU编码', 'warning');
        newSkuElem?.focus();
        return;
    }
    
    if (!/^\d{5}$/.test(sku)) {
        showAlert('SKU必须为5位数字编码（如：12345）', 'warning');
        newSkuElem?.focus();
        return;
    }
    
    if (!name) {
        showAlert('请输入商品名称', 'warning');
        newNameElem?.focus();
        return;
    }
    
    if (!shelfLife || isNaN(shelfLife) || shelfLife < 1) {
        showAlert('请输入有效的保质期天数（至少1天）', 'warning');
        newShelfLifeElem?.focus();
        return;
    }
    
    if (shelfLife > 3650) {
        showAlert('保质期天数不能超过3650天（约10年）', 'warning');
        newShelfLifeElem?.focus();
        return;
    }
    
    if (isNaN(reminderDays) || reminderDays < 0) {
        showAlert('临期提醒天数不能为负数', 'warning');
        newReminderDaysElem?.focus();
        return;
    }
    
    if (reminderDays > shelfLife) {
        showAlert('临期提醒天数不能大于保质期天数', 'warning');
        newReminderDaysElem?.focus();
        return;
    }
    
    if (!location) {
        showAlert('请输入存放库位', 'warning');
        newLocationElem?.focus();
        return;
    }
    
    const product = {
        sku: sku,
        name: name,
        shelf_life: shelfLife,
        reminder_days: reminderDays,
        location: location,
        category: category
    };
    
    // 禁用按钮防止重复提交
    const addBtn = document.getElementById('addProductBtn');
    const originalText = addBtn?.innerHTML;
    if (addBtn) {
        addBtn.disabled = true;
        addBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 添加中...';
    }
    
    try {
        console.log('添加商品请求:', product);
        const result = await apiRequest('/api/products', 'POST', product);
        console.log('添加商品响应:', result);
        
        // 保存图片（如果有）- 修复点：确保在商品添加成功后执行
        if (currentImageData) {
            showQuickToast('正在上传图片...', 'info');
            const saveResult = await saveProductImage(sku);
            if (saveResult) {
                showQuickToast('图片上传成功', 'success');
            } else {
                showAlert('图片上传失败，但商品已添加', 'warning');
            }
        }
        
        showQuickToast('商品已成功添加到数据库', 'success');
        
        // 清空表单
        if (newSkuElem) newSkuElem.value = '';
        if (newNameElem) newNameElem.value = '';
        if (newShelfLifeElem) newShelfLifeElem.value = '';
        if (newReminderDaysElem) newReminderDaysElem.value = '';
        if (newLocationElem) newLocationElem.value = '';
        if (categorySelect) categorySelect.value = '其他';
        
        // 清空图片
        currentImageData = null;
        currentImageMime = null;
        const imagePreviewContainer = document.getElementById('imagePreviewContainer');
        const removeImageBtn = document.getElementById('removeImageBtn');
        if (imagePreviewContainer) imagePreviewContainer.innerHTML = '';
        if (removeImageBtn) removeImageBtn.style.display = 'none';
        
        // 清空搜索框
        const searchSkuElem = document.getElementById('searchSku');
        if (searchSkuElem) searchSkuElem.value = '';
        
        // 刷新商品数据库表格
        dataCache.clear();
        await renderProductDatabaseTable(true);
        
    } catch (error) {
        console.error('添加商品失败:', error);
        let errorMsg = error.message;
        if (errorMsg.includes('SQLITE_CONSTRAINT') || errorMsg.includes('UNIQUE')) {
            errorMsg = `SKU "${sku}" 已存在，请使用不同的SKU编码`;
        }
        showAlert(`添加失败: ${errorMsg}`, 'danger');
    } finally {
        if (addBtn) {
            addBtn.disabled = false;
            addBtn.innerHTML = originalText || '<i class="bi bi-check-circle"></i> 添加商品';
        }
    }
}

// ========== 图片上传功能修复 ==========
function setupImageUpload() {
    const imageUploadArea = document.getElementById('imageUploadArea');
    const productImageInput = document.getElementById('productImageInput');
    const imagePreviewContainer = document.getElementById('imagePreviewContainer');
    const removeImageBtn = document.getElementById('removeImageBtn');
    
    if (!imageUploadArea) return;
    
    // 移除旧事件，防止重复绑定
    const newArea = imageUploadArea.cloneNode(true);
    imageUploadArea.parentNode.replaceChild(newArea, imageUploadArea);
    
    // 点击上传区域触发文件选择
    newArea.addEventListener('click', (e) => {
        // 防止点击内部元素时重复触发
        if (e.target === newArea || e.target.closest('.image-upload-area')) {
            if (productImageInput) productImageInput.click();
        }
    });
    
    // 拖拽上传
    newArea.addEventListener('dragover', (e) => { 
        e.preventDefault(); 
        newArea.classList.add('drag-over'); 
    });
    
    newArea.addEventListener('dragleave', () => { 
        newArea.classList.remove('drag-over'); 
    });
    
    newArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        newArea.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
            await handleImageFile(file);
        } else {
            showAlert('请拖拽图片文件', 'warning');
        }
    });
    
    // 修复：文件选择器事件绑定
    if (productImageInput) {
        // 移除旧的事件监听器
        const newFileInput = productImageInput.cloneNode(true);
        productImageInput.parentNode.replaceChild(newFileInput, productImageInput);
        
        // 绑定 change 事件
        newFileInput.addEventListener('change', async (e) => {
            console.log('文件选择器触发:', e.target.files);
            if (e.target.files && e.target.files.length > 0) {
                const file = e.target.files[0];
                if (file && file.type.startsWith('image/')) {
                    await handleImageFile(file);
                } else {
                    showAlert('请选择图片文件', 'warning');
                }
            }
            // 清空 input 值，以便再次选择同一个文件时可以重新触发
            newFileInput.value = '';
        });
    }
    
    // 删除图片按钮
    if (removeImageBtn) {
        const newRemoveBtn = removeImageBtn.cloneNode(true);
        removeImageBtn.parentNode.replaceChild(newRemoveBtn, removeImageBtn);
        newRemoveBtn.addEventListener('click', () => {
            currentImageData = null;
            currentImageMime = null;
            const container = document.getElementById('imagePreviewContainer');
            if (container) container.innerHTML = '';
            newRemoveBtn.style.display = 'none';
            // 同时清空文件选择器的值
            const fileInput = document.getElementById('productImageInput');
            if (fileInput) fileInput.value = '';
            showQuickToast('图片已删除', 'info');
        });
    }
}

async function handleImageFile(file) {
    console.log('处理图片文件:', file.name, file.size);
    
    if (file.size > 10 * 1024 * 1024) { 
        showAlert('图片大小不能超过10MB', 'warning'); 
        return; 
    }
    if (!file.type.startsWith('image/')) { 
        showAlert('请选择图片文件', 'warning'); 
        return; 
    }
    
    showQuickToast('正在压缩图片...', 'info');
    
    try {
        const compressedDataUrl = await compressImage(file, 800, 800, 0.75);
        const compressedSize = Math.round((compressedDataUrl.length * 0.75) / 1024);
        const originalSizeKB = Math.round(file.size / 1024);
        
        console.log('压缩完成, 原始大小:', originalSizeKB, 'KB, 压缩后:', compressedSize, 'KB');
        
        currentImageData = compressedDataUrl;
        currentImageMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        
        const container = document.getElementById('imagePreviewContainer');
        const removeBtn = document.getElementById('removeImageBtn');
        
        if (container) {
            container.innerHTML = `<img src="${currentImageData}" class="image-preview" alt="预览" style="max-width:100%;max-height:150px;border-radius:8px;margin-top:10px;"><small class="d-block mt-1 text-muted">${escapeHtml(file.name)} (${originalSizeKB}KB → ${compressedSize}KB)</small>`;
        }
        if (removeBtn) removeBtn.style.display = 'inline-block';
        
        showQuickToast('图片已压缩，点击"添加商品"时会上传', 'success');
        
    } catch (error) {
        console.error('图片压缩失败:', error);
        showAlert('图片处理失败，请重试', 'danger');
    }
}

// ========== 修复 updateProduct 函数 ==========
async function updateProduct() {
    if (!currentEditingSku) {
        showAlert('请先查询要编辑的商品', 'warning');
        return;
    }
    
    const newNameElem = document.getElementById('newName');
    const newShelfLifeElem = document.getElementById('newShelfLife');
    const newReminderDaysElem = document.getElementById('newReminderDays');
    const newLocationElem = document.getElementById('newLocation');
    const categorySelect = document.getElementById('newCategory');
    
    const name = newNameElem?.value?.trim();
    const shelfLife = parseInt(newShelfLifeElem?.value?.trim());
    const reminderDays = parseInt(newReminderDaysElem?.value?.trim());
    const location = newLocationElem?.value?.trim();
    const category = categorySelect?.value || '其他';
    
    // 验证
    if (!name) {
        showAlert('请输入商品名称', 'warning');
        newNameElem?.focus();
        return;
    }
    
    if (!shelfLife || isNaN(shelfLife) || shelfLife < 1) {
        showAlert('请输入有效的保质期天数', 'warning');
        newShelfLifeElem?.focus();
        return;
    }
    
    if (isNaN(reminderDays) || reminderDays < 0) {
        showAlert('请输入有效的提醒天数', 'warning');
        newReminderDaysElem?.focus();
        return;
    }
    
    if (reminderDays > shelfLife) {
        showAlert('临期提醒天数不能大于保质期天数', 'warning');
        newReminderDaysElem?.focus();
        return;
    }
    
    if (!location) {
        showAlert('请输入存放库位', 'warning');
        newLocationElem?.focus();
        return;
    }
    
    const updateBtn = document.getElementById('updateProductBtn');
    const originalText = updateBtn?.innerHTML;
    if (updateBtn) {
        updateBtn.disabled = true;
        updateBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 更新中...';
    }
    
    try {
        await apiRequest(`/api/products/${currentEditingSku}`, 'PUT', { 
            name, 
            shelf_life: shelfLife, 
            reminder_days: reminderDays, 
            location, 
            category 
        });
        
        // 保存或删除图片 - 修复点
        if (currentImageData) {
            showQuickToast('正在上传图片...', 'info');
            await saveProductImage(currentEditingSku);
        } else {
            // 如果没有图片数据，删除已有图片
            await deleteProductImage(currentEditingSku);
        }
        
        showQuickToast('商品信息已更新', 'success');
        dataCache.clear();
        
        // 重置编辑状态
        isEditingProduct = false;
        currentEditingSku = '';
        
        // 清空表单
        const newSkuElem = document.getElementById('newSku');
        const addProductBtnElem = document.getElementById('addProductBtn');
        const updateProductBtnElem = document.getElementById('updateProductBtn');
        const searchSkuElem = document.getElementById('searchSku');
        const imagePreviewContainer = document.getElementById('imagePreviewContainer');
        const removeImageBtn = document.getElementById('removeImageBtn');
        
        if (newSkuElem) {
            newSkuElem.readOnly = false;
            newSkuElem.value = '';
        }
        if (newNameElem) newNameElem.value = '';
        if (newShelfLifeElem) newShelfLifeElem.value = '';
        if (newReminderDaysElem) newReminderDaysElem.value = '';
        if (newLocationElem) newLocationElem.value = '';
        if (searchSkuElem) searchSkuElem.value = '';
        if (categorySelect) categorySelect.value = '其他';
        if (imagePreviewContainer) imagePreviewContainer.innerHTML = '';
        if (removeImageBtn) removeImageBtn.style.display = 'none';
        if (addProductBtnElem) addProductBtnElem.classList.remove('d-none');
        if (updateProductBtnElem) updateProductBtnElem.classList.add('d-none');
        
        currentImageData = null;
        currentImageMime = null;
        
        await renderProductDatabaseTable(true);
        await renderExpiringTable(true);
        await renderAllTable(true);
        
    } catch (error) {
        console.error('更新商品失败:', error);
        showAlert(`更新失败: ${error.message}`, 'danger');
    } finally {
        if (updateBtn) {
            updateBtn.disabled = false;
            updateBtn.innerHTML = originalText || '<i class="bi bi-pencil"></i> 更新商品';
        }
    }
}

// ========== 修复 searchProduct 函数 ==========
async function searchProduct() {
    const searchSkuElem = document.getElementById('searchSku');
    const newSkuElem = document.getElementById('newSku');
    const newNameElem = document.getElementById('newName');
    const newShelfLifeElem = document.getElementById('newShelfLife');
    const newReminderDaysElem = document.getElementById('newReminderDays');
    const newLocationElem = document.getElementById('newLocation');
    const addProductBtnElem = document.getElementById('addProductBtn');
    const updateProductBtnElem = document.getElementById('updateProductBtn');
    const categorySelect = document.getElementById('newCategory');
    
    const sku = searchSkuElem?.value?.trim();
    
    if (!sku) {
        showAlert('请输入5位SKU编码', 'warning');
        searchSkuElem?.focus();
        return;
    }
    
    if (sku.length !== 5 || !/^\d{5}$/.test(sku)) {
        showAlert('SKU必须为5位数字编码', 'warning');
        searchSkuElem?.focus();
        return;
    }
    
    // 显示加载状态
    const searchBtn = document.getElementById('searchBtn');
    const originalText = searchBtn?.innerHTML;
    if (searchBtn) {
        searchBtn.disabled = true;
        searchBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    }
    
    try {
        const product = await apiRequest(`/api/products/${sku}`);
        
        if (product && product.sku) {
            // 找到了商品，填充表单进行编辑
            if (newSkuElem) newSkuElem.value = product.sku;
            if (newNameElem) newNameElem.value = product.name;
            if (newShelfLifeElem) newShelfLifeElem.value = product.shelf_life;
            if (newReminderDaysElem) newReminderDaysElem.value = product.reminder_days;
            if (newLocationElem) newLocationElem.value = product.location;
            if (categorySelect) categorySelect.value = product.category || '其他';
            
            isEditingProduct = true;
            currentEditingSku = sku;
            
            if (newSkuElem) newSkuElem.readOnly = true;
            if (addProductBtnElem) addProductBtnElem.classList.add('d-none');
            if (updateProductBtnElem) updateProductBtnElem.classList.remove('d-none');
            
            // 加载图片
            await loadProductImage(sku);
            
            showQuickToast(`已加载商品: ${product.name}`, 'success');
        } else {
            // 没找到商品，可以添加新商品
            if (newSkuElem) newSkuElem.value = sku;
            if (newNameElem) newNameElem.value = '';
            if (newShelfLifeElem) newShelfLifeElem.value = '';
            if (newReminderDaysElem) newReminderDaysElem.value = '';
            if (newLocationElem) newLocationElem.value = '';
            if (categorySelect) categorySelect.value = '其他';
            
            isEditingProduct = false;
            currentEditingSku = '';
            
            if (newSkuElem) newSkuElem.readOnly = false;
            if (addProductBtnElem) addProductBtnElem.classList.remove('d-none');
            if (updateProductBtnElem) updateProductBtnElem.classList.add('d-none');
            
            // 清空图片
            currentImageData = null;
            currentImageMime = null;
            const imagePreviewContainer = document.getElementById('imagePreviewContainer');
            const removeImageBtn = document.getElementById('removeImageBtn');
            if (imagePreviewContainer) imagePreviewContainer.innerHTML = '';
            if (removeImageBtn) removeImageBtn.style.display = 'none';
            
            if (newNameElem) newNameElem.focus();
            showAlert(`SKU "${sku}" 不存在，请填写信息后添加`, 'info');
        }
    } catch (error) {
        console.error('查询商品失败:', error);
        showAlert(`查询失败: ${error.message}`, 'danger');
    } finally {
        if (searchBtn) {
            searchBtn.disabled = false;
            searchBtn.innerHTML = originalText || '<i class="bi bi-search"></i> 查询';
        }
    }
}

// ========== 图片压缩 ==========
async function compressImage(file, maxWidth = 800, maxHeight = 800, quality = 0.75) {
    return new Promise((resolve, reject) => {
        if (file.size < 200 * 1024) {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let width = img.width, height = img.height;
                if (width > maxWidth || height > maxHeight) {
                    const ratio = Math.min(maxWidth / width, maxHeight / height);
                    width = Math.floor(width * ratio);
                    height = Math.floor(height * ratio);
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const outputFormat = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                canvas.toBlob((blob) => {
                    const reader2 = new FileReader();
                    reader2.onload = () => resolve(reader2.result);
                    reader2.onerror = reject;
                    reader2.readAsDataURL(blob);
                }, outputFormat, quality);
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ========== 快速提示 ==========
function showQuickToast(message, type = 'info') {
    const types = { info: 'alert-info', success: 'alert-success', warning: 'alert-warning', danger: 'alert-danger' };
    const existing = document.querySelector('.quick-toast');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = `quick-toast ${types[type]}`;
    div.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:1070;min-width:200px;text-align:center;padding:8px 16px;font-size:14px;border-radius:20px;box-shadow:0 2px 10px rgba(0,0,0,0.2);pointer-events:none;background:rgba(0,0,0,0.8);color:white;';
    const icon = type === 'success' ? 'bi-check-circle' : type === 'danger' ? 'bi-exclamation-triangle' : 'bi-info-circle';
    div.innerHTML = `<i class="bi ${icon} me-1"></i> ${escapeHtml(message)}`;
    document.body.appendChild(div);
    setTimeout(() => {
        if (div && div.remove) {
            div.style.animation = 'fadeOutDown 0.2s ease';
            setTimeout(() => div.remove(), 200);
        }
    }, 2000);
}

function showAlert(message, type = 'info') {
    const types = { info: 'alert-info', success: 'alert-success', warning: 'alert-warning', danger: 'alert-danger' };
    const existing = document.querySelector('.global-alert');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = `alert ${types[type]} alert-dismissible fade show global-alert`;
    div.style.cssText = 'z-index:1060;animation:slideDown 0.3s ease;position:fixed;top:10px;left:50%;transform:translateX(-50%);min-width:300px;max-width:90%;';
    div.innerHTML = `<div class="d-flex align-items-center"><div class="flex-grow-1">${escapeHtml(message)}</div><button type="button" class="btn-close ms-2" data-bs-dismiss="alert"></button></div>`;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), type === 'danger' ? 8000 : 5000);
}

// ========== 登录认证（修复版） ==========
function saveLogin(username, password, remember) {
    if (remember) {
        localStorage.setItem(STORAGE_KEYS.REMEMBER_ME, 'true');
        localStorage.setItem(STORAGE_KEYS.SAVED_USERNAME, username);
        localStorage.setItem(STORAGE_KEYS.SAVED_PASSWORD, password);
    } else {
        clearSavedLogin();
    }
}

function clearSavedLogin() {
    localStorage.removeItem(STORAGE_KEYS.REMEMBER_ME);
    localStorage.removeItem(STORAGE_KEYS.SAVED_USERNAME);
    localStorage.removeItem(STORAGE_KEYS.SAVED_PASSWORD);
}

function loadSavedUsername() {
    const rememberMe = localStorage.getItem(STORAGE_KEYS.REMEMBER_ME) === 'true';
    if (rememberMe) {
        const savedUsername = localStorage.getItem(STORAGE_KEYS.SAVED_USERNAME);
        if (savedUsername) {
            const usernameInput = document.getElementById('loginUsername');
            if (usernameInput) usernameInput.value = savedUsername;
            const rememberCheckbox = document.getElementById('rememberMe');
            if (rememberCheckbox) rememberCheckbox.checked = true;
            const passwordInput = document.getElementById('loginPassword');
            if (passwordInput && localStorage.getItem(STORAGE_KEYS.SAVED_PASSWORD)) {
                passwordInput.value = localStorage.getItem(STORAGE_KEYS.SAVED_PASSWORD);
            }
        }
    }
}

async function tryAutoLogin() {
    const rememberMe = localStorage.getItem(STORAGE_KEYS.REMEMBER_ME) === 'true';
    if (!rememberMe) return false;
    const savedUsername = localStorage.getItem(STORAGE_KEYS.SAVED_USERNAME);
    const savedPassword = localStorage.getItem(STORAGE_KEYS.SAVED_PASSWORD);
    if (!savedUsername || !savedPassword) return false;
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ username: savedUsername, password: savedPassword })
        });
        const result = await response.json();
        if (response.ok && result.success) {
            currentUser = result.user;
            currentUserRole = result.user.role;
            showMainApp(result.user);
            return true;
        } else {
            clearSavedLogin();
            return false;
        }
    } catch (error) { 
        console.log('自动登录失败:', error);
        return false; 
    }
}

function startAuthChecker() {
    if (authCheckerInterval) clearInterval(authCheckerInterval);
    authCheckerInterval = setInterval(() => checkAuth(false), AUTH_CHECK_INTERVAL);
}

function stopAuthChecker() {
    if (authCheckerInterval) { 
        clearInterval(authCheckerInterval); 
        authCheckerInterval = null; 
    }
}

// ========== 扫码功能修复 ==========
async function startScanner(callback) {
    if (!callback) return;
    currentScanCallback = callback;
    
    // 确保 Html5Qrcode 库已加载
    if (typeof Html5Qrcode === 'undefined') {
        showAlert('扫码库加载中，请稍后重试', 'warning');
        return;
    }
    
    try {
        // 清理旧实例
        if (html5QrCode) { 
            try { 
                await html5QrCode.stop(); 
                await html5QrCode.clear();
            } catch(e) { 
                console.log('停止扫码器失败:', e);
            } 
            html5QrCode = null;
        }
        
        const readerElement = document.getElementById('qr-reader');
        if (!readerElement) {
            showAlert('扫码器容器不存在', 'danger');
            return;
        }
        
        // 清空容器
        readerElement.innerHTML = '';
        
        html5QrCode = new Html5Qrcode("qr-reader");
        await html5QrCode.start(
            { facingMode: "environment" },
            { 
                fps: 10, 
                qrbox: { width: 250, height: 250 }, 
                aspectRatio: 1.0,
                showTorchButtonIfSupported: true,
                rememberLastUsedCamera: true
            },
            (decodedText) => {
                if (currentScanCallback) {
                    currentScanCallback(decodedText);
                }
                stopScanner();
                const modal = document.getElementById('scannerModal');
                if (modal && window.scannerModal) {
                    window.scannerModal.hide();
                }
                vibrate(50);
            },
            (errorMessage) => { 
                // 静默处理扫描中的错误
                if (errorMessage && !errorMessage.includes('No MultiFormat') && !errorMessage.includes('NotFoundException')) {
                    console.log("扫码中:", errorMessage); 
                }
            }
        );
    } catch (err) {
        console.error("启动扫码失败:", err);
        showAlert("无法启动摄像头，请检查权限设置", "danger");
    }
}

function stopScanner() {
    if (html5QrCode) { 
        html5QrCode.stop().catch(e => console.log('停止扫码器错误:', e));
        setTimeout(() => {
            if (html5QrCode) {
                html5QrCode.clear().catch(e => console.log('清理扫码器错误:', e));
                html5QrCode = null;
            }
        }, 100);
    }
}

// 绑定扫码按钮事件 - 修复版
function bindScanButtons() {
    const scanSkuBtn = document.getElementById('scanSkuBtn');
    const scanSearchSkuBtn = document.getElementById('scanSearchSkuBtn');
    const scanNewSkuBtn = document.getElementById('scanNewSkuBtn');
    const scanLocationBtn = document.getElementById('scanLocationBtn');
    
    if (scanSkuBtn) {
        scanSkuBtn.onclick = () => {
            startScanner((result) => {
                const skuInput = document.getElementById('skuInput');
                if (skuInput) {
                    const last5 = extractLast5Digits(result);
                    skuInput.value = last5;
                    showQuickToast(`已识别: ${last5}`, 'success');
                    lookupProductWithExistingDates();
                    // 自动聚焦生产日期
                    setTimeout(() => {
                        const prodDate = document.getElementById('productionDate');
                        if (prodDate && !prodDate.disabled) prodDate.focus();
                    }, 300);
                }
            });
            if (window.scannerModal) window.scannerModal.show();
        };
    }
    
    if (scanSearchSkuBtn) {
        scanSearchSkuBtn.onclick = () => {
            startScanner((result) => {
                const searchSku = document.getElementById('searchSku');
                if (searchSku) {
                    const last5 = extractLast5Digits(result);
                    searchSku.value = last5;
                    showQuickToast(`已识别: ${last5}`, 'success');
                    searchProduct();
                }
            });
            if (window.scannerModal) window.scannerModal.show();
        };
    }
    
    if (scanNewSkuBtn) {
        scanNewSkuBtn.onclick = () => {
            startScanner((result) => {
                const newSku = document.getElementById('newSku');
                if (newSku) {
                    const last5 = extractLast5Digits(result);
                    newSku.value = last5;
                    showQuickToast(`已识别: ${last5}`, 'success');
                    document.getElementById('newName')?.focus();
                }
            });
            if (window.scannerModal) window.scannerModal.show();
        };
    }
    
    if (scanLocationBtn) {
        scanLocationBtn.onclick = () => {
            startScanner((result) => {
                const locationInput = document.getElementById('newLocation');
                if (locationInput) {
                    locationInput.value = result;
                    showQuickToast(`库位已填写: ${result}`, 'success');
                }
            });
            if (window.scannerModal) window.scannerModal.show();
        };
    }

    // 停止扫描按钮事件
        const stopScannerBtn = document.getElementById('stopScannerBtn');
        if (stopScannerBtn) {
            stopScannerBtn.addEventListener('click', () => {
                if (window.scannerModal) window.scannerModal.hide();
                stopScanner();
            });
        }

}

// 添加 extractLast5Digits 函数（如果缺失）
function extractLast5Digits(barcode) {
    const numbers = String(barcode).replace(/[^0-9]/g, '');
    return numbers.length >= 5 ? numbers.slice(-5) : numbers.padStart(5, '0');
}



async function checkAuth(force = false) {
    // 如果已经显示登录界面，不再重复检查
    const loginContainer = document.getElementById('login-container');
    if (loginContainer && !loginContainer.classList.contains('d-none')) {
        return false;
    }
    
    const now = Date.now();
    if (!force && (now - lastAuthCheck) < 30000) return true;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/check`, { 
            credentials: 'include', 
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache' }
        });
        
        if (!response.ok) {
            console.warn('Auth check response not OK:', response.status);
            return false;
        }
        
        const result = await response.json();
        lastAuthCheck = now;
        
        if (result.isLoggedIn && result.user) {
            isShowingLoginAlert = false;
            currentUserRole = result.user.role;
            currentUser = result.user;
            
            // 同步到界面
            const currentUsernameSpan = document.getElementById('current-username');
            if (currentUsernameSpan) currentUsernameSpan.textContent = result.user.username;
            
            showMainApp(result.user);
            
            const expiryWarningBar = document.getElementById('expiryWarningBar');
            const expiryWarningText = document.getElementById('expiryWarningText');
            if (expiryWarningBar && expiryWarningText) {
                if (result.user.expiryWarning) {
                    expiryWarningText.textContent = result.user.expiryWarning;
                    expiryWarningBar.style.display = 'block';
                } else {
                    expiryWarningBar.style.display = 'none';
                }
            }
            
            const bottomAdminTab = document.querySelector('.bottom-nav .nav-item[data-tab="admin"]');
            if (bottomAdminTab) {
                bottomAdminTab.style.display = (result.user.role === 'admin') ? 'flex' : 'none';
            }
            return true;
        } else {
            const autoLoggedIn = await tryAutoLogin();
            if (autoLoggedIn) {
                return true;
            }
            
            // 只在强制检查且未显示登录界面时弹出提示
            if (force && !isShowingLoginAlert) {
                isShowingLoginAlert = true;
                showAlert('登录已过期，请重新登录', 'warning');
            }
            showLogin();
            return false;
        }
    } catch (error) {
        console.error('Auth check error:', error);
        // 网络错误时不强制登出
        if (error.name === 'TypeError' || error.message?.includes('fetch')) {
            console.log('网络连接问题，保持当前状态');
            return true;
        }
        showLogin();
        return false;
    }
}

function showLogin() {
    // 停止认证检查器
    stopAuthChecker();
    
    const loginContainer = document.getElementById('login-container');
    const mainApp = document.getElementById('main-app');
    const bottomNav = document.getElementById('bottomNav');
    
    if (loginContainer) loginContainer.classList.remove('d-none');
    if (mainApp) mainApp.classList.add('d-none');
    if (bottomNav) bottomNav.style.display = 'none';
    
    currentUserRole = null;
    currentUser = null;
    isShowingLoginAlert = false;
    
    // 清空密码输入框
    const passwordInput = document.getElementById('loginPassword');
    if (passwordInput) passwordInput.value = '';
}

function showMainApp(user) {
    const loginContainer = document.getElementById('login-container');
    const mainApp = document.getElementById('main-app');
    const bottomNav = document.getElementById('bottomNav');
    const currentUsernameSpan = document.getElementById('current-username');
    
    if (loginContainer) loginContainer.classList.add('d-none');
    if (mainApp) mainApp.classList.remove('d-none');
    if (bottomNav) bottomNav.style.display = 'flex';
    if (currentUsernameSpan) currentUsernameSpan.textContent = user.username;
    
    currentUserRole = user.role;
    currentUser = user;
    
    if (!appInitialized) {
        initMainApp();
    } else {
        // 已初始化，刷新数据
        refreshAllData();
    }
}

// ========== 登录/注册函数 ==========
async function login() {
    const usernameInput = document.getElementById('loginUsername');
    const passwordInput = document.getElementById('loginPassword');
    const rememberCheckbox = document.getElementById('rememberMe');
    
    const username = usernameInput?.value.trim();
    const password = passwordInput?.value.trim();
    const rememberMe = rememberCheckbox?.checked || false;
    
    if (!username || !password) { 
        showAlert('请输入用户名和密码', 'warning'); 
        return; 
    }
    
    const loginBtnElem = document.getElementById('loginBtn');
    if (!loginBtnElem) return;
    const originalText = loginBtnElem.innerHTML;
    loginBtnElem.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 登录中...';
    loginBtnElem.disabled = true;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            credentials: 'include',
            body: JSON.stringify({ username, password })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '登录失败');
        
        saveLogin(username, password, rememberMe);
        currentUser = result.user;
        currentUserRole = result.user.role;
        showMainApp(result.user);
        showAlert('登录成功', 'success');
        if (passwordInput) passwordInput.value = '';
        
        // 启动认证检查器
        startAuthChecker();
    } catch (error) { 
        showAlert(`登录失败: ${error.message}`, 'danger'); 
        clearSavedLogin();
    } finally {
        loginBtnElem.innerHTML = originalText;
        loginBtnElem.disabled = false;
    }
}

async function register() {
    const usernameInput = document.getElementById('registerUsername');
    const passwordInput = document.getElementById('registerPassword');
    const confirmInput = document.getElementById('registerConfirmPassword');
    const authCodeInput = document.getElementById('registerAuthCode');
    
    const username = usernameInput?.value.trim();
    const password = passwordInput?.value.trim();
    const confirm = confirmInput?.value.trim();
    const authCode = authCodeInput?.value.trim();
    
    if (!username || !password) { 
        showAlert('用户名和密码不能为空', 'warning'); 
        return; 
    }
    if (username.length < 3 || username.length > 20) { 
        showAlert('用户名长度应在3-20字符之间', 'warning'); 
        return; 
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        showAlert('用户名只能包含字母、数字和下划线', 'warning');
        return;
    }
    if (password.length < 6) { 
        showAlert('密码长度不能少于6位', 'warning'); 
        return; 
    }
    if (password !== confirm) { 
        showAlert('两次输入的密码不一致', 'warning'); 
        return; 
    }
    if (!authCode) { 
        showAlert('请输入授权码', 'warning'); 
        return; 
    }
    if (authCode.length !== 8) { 
        showAlert('授权码应为8位', 'warning'); 
        return; 
    }
    
    const btn = document.getElementById('registerBtn');
    if (!btn) return;
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 注册中...';
    btn.disabled = true;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email: '', authCode })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '注册失败');
        showAlert('注册成功，请登录', 'success');
        if (usernameInput) usernameInput.value = '';
        if (passwordInput) passwordInput.value = '';
        if (confirmInput) confirmInput.value = '';
        if (authCodeInput) authCodeInput.value = '';
        
        const loginTab = document.getElementById('login-tab');
        if (loginTab) loginTab.click();
        const loginUsername = document.getElementById('loginUsername');
        if (loginUsername) loginUsername.value = username;
        const loginPassword = document.getElementById('loginPassword');
        if (loginPassword) loginPassword.focus();
    } catch (error) {
        let msg = error.message;
        if (msg.includes('授权码')) msg = '授权码无效或已过期';
        if (msg.includes('用户名已存在')) msg = '该用户名已被注册';
        showAlert(`注册失败: ${msg}`, 'danger');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
    
}

async function logout() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/logout`, { 
            method: 'POST', 
            credentials: 'include' 
        });
        const result = await response.json();
        
        // 清空缓存
        dataCache.clear();
        
        // 停止认证检查器
        stopAuthChecker();
        
        // 显示登录界面
        showLogin();
        
        showAlert('已成功登出', 'success');
        
    } catch (error) { 
        console.error('登出错误:', error);
        stopAuthChecker(); 
        showLogin(); 
        showAlert('登出成功', 'info');
    }
}

// ========== 左滑删除 ==========
async function performSwipeDelete(item, cardElement) {
    if (isDeletingInProgress) return;
    isDeletingInProgress = true;
    vibrate(50);
    
    // 获取卡片元素
    const targetCard = cardElement || event?.target?.closest('.expiring-card');
    if (!targetCard) {
        isDeletingInProgress = false;
        return;
    }
    
    // 保存SKU和生产日期用于删除
    const sku = item.sku;
    const productionDate = item.production_date;
    const productName = item.name;
    
    // 播放滑出动画
    targetCard.style.transition = 'transform 0.25s ease-out';
    targetCard.style.transform = 'translateX(-100%)';
    targetCard.style.opacity = '0';
    
    await new Promise(resolve => setTimeout(resolve, 250));
    
    // 从DOM中移除卡片
    if (targetCard.remove) targetCard.remove();
    
    try {
        // 发送删除请求
        await apiRequest(`/api/records/${encodeURIComponent(sku)}/${encodeURIComponent(productionDate)}`, 'DELETE');
        
        // 更新内存缓存
        if (dataCache.records) {
            dataCache.records = dataCache.records.filter(r => !(r.sku === sku && r.production_date === productionDate));
            dataCache.expiring = dataCache.records.filter(r => calculateRemainingDaysLocal(r.production_date, r.shelf_life) <= (r.reminder_days || 0));
            dataCache.lastFetch.records = Date.now();
            dataCache.lastFetch.expiring = Date.now();
        }
        
        // 更新计数徽章
        updateExpiringBadge();
        
        // 更新临期标签页的计数
        const expiringTab = document.getElementById('expiring-tab');
        if (expiringTab) {
            const existingBadge = expiringTab.querySelector('.expiry-count-badge');
            if (existingBadge) existingBadge.remove();
            const newExpiringCount = dataCache.expiring?.length || 0;
            if (newExpiringCount > 0) {
                const badge = document.createElement('span');
                badge.className = 'badge bg-danger ms-1 expiry-count-badge';
                badge.textContent = newExpiringCount;
                expiringTab.appendChild(badge);
            }
        }
        
        showQuickToast(`已下架: ${productName}`, 'success');
        
        // 检查是否还有卡片，如果没有显示空状态
        const container = targetCard.parentElement;
        if (container && container.children.length === 0) {
            if (window.innerWidth <= 768) {
                container.innerHTML = '<div class="text-center py-5 text-muted"><i class="bi bi-check-circle" style="font-size:2rem;"></i><p class="mt-2">暂无临期商品</p></div>';
            }
        }
        
    } catch (error) {
        console.error('删除失败:', error);
        showQuickToast(`删除失败: ${error.message}`, 'danger');
        // 删除失败时重新渲染该页面
        await renderExpiringTable(true);
        await renderAllTable(true);
    } finally {
        setTimeout(() => { isDeletingInProgress = false; }, 300);
    }
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initSwipeToDelete() {
    if (window.innerWidth > 768) return;
    const cardsContainer = document.getElementById('expiringCards');
    const allCardsContainer = document.getElementById('allCards');
    
    const setupSwipeForContainer = (container) => {
        if (!container) return;
        let localTouchStartX = 0, localTouchStartY = 0, localTouchCard = null, localTouchStartTime = 0, isSwiping = false;
        
        container.addEventListener('touchstart', (e) => {
            const card = e.target.closest('.expiring-card');
            document.querySelectorAll('.expiring-card.swiping').forEach(c => {
                if (c !== card) {
                    c.classList.remove('swiping');
                    const inner = c.querySelector('.card-inner');
                    if (inner) { 
                        inner.style.transform = ''; 
                        inner.style.transition = ''; 
                    }
                }
            });
            if (!card) return;
            localTouchStartX = e.touches[0].clientX;
            localTouchStartY = e.touches[0].clientY;
            localTouchCard = card;
            localTouchStartTime = Date.now();
            isSwiping = false;
            card.dataset.swiping = 'false';
            const inner = card.querySelector('.card-inner');
            if (inner) inner.style.transition = 'transform 0.05s linear';
        }, { passive: true });
        
        container.addEventListener('touchmove', (e) => {
            if (!localTouchCard) return;
            const deltaX = e.touches[0].clientX - localTouchStartX;
            const deltaY = e.touches[0].clientY - localTouchStartY;
            if (Math.abs(deltaX) > Math.abs(deltaY) && deltaX < 0) {
                e.preventDefault();
                isSwiping = true;
                const inner = localTouchCard.querySelector('.card-inner');
                if (inner) {
                    const translateX = Math.max(-60, deltaX);
                    inner.style.transform = `translateX(${translateX}px)`;
                    const opacity = Math.min(1, Math.abs(deltaX) / 40);
                    localTouchCard.style.setProperty('--delete-opacity', opacity);
                }
            } else if (Math.abs(deltaX) > Math.abs(deltaY) && deltaX > 15) {
                const inner = localTouchCard.querySelector('.card-inner');
                if (inner) { 
                    inner.style.transform = ''; 
                    inner.style.transition = 'transform 0.15s ease-out'; 
                }
                localTouchCard.classList.remove('swiping');
                localTouchCard = null;
            }
        }, { passive: false });
        
        container.addEventListener('touchend', (e) => {
            if (!localTouchCard) {
                document.querySelectorAll('.expiring-card.swiping').forEach(c => {
                    c.classList.remove('swiping');
                    const inner = c.querySelector('.card-inner');
                    if (inner) { 
                        inner.style.transform = ''; 
                        inner.style.transition = ''; 
                    }
                });
                return;
            }
            const deltaX = e.changedTouches[0].clientX - localTouchStartX;
            const deltaTime = Date.now() - localTouchStartTime;
            const inner = localTouchCard.querySelector('.card-inner');
            if (isSwiping && deltaX < -50 && deltaTime < 300) {
                const deleteBtn = localTouchCard.querySelector('.delete-record-btn');
                if (deleteBtn && !isDeletingInProgress) {
                    const sku = deleteBtn.getAttribute('data-sku');
                    const productionDateVal = deleteBtn.getAttribute('data-production-date');
                    const name = deleteBtn.getAttribute('data-name');
                    const shelfLifeVal = parseInt(deleteBtn.getAttribute('data-shelf-life') || 0);
                    const reminderDaysVal = parseInt(deleteBtn.getAttribute('data-reminder-days') || 0);
                    const location = deleteBtn.getAttribute('data-location');
                    const item = { sku, name, production_date: productionDateVal, shelf_life: shelfLifeVal, reminder_days: reminderDaysVal, location };
                    if (inner) { 
                        inner.style.transform = ''; 
                        inner.style.transition = ''; 
                    }
                    localTouchCard.classList.remove('swiping');
                    performSwipeDelete(item, localTouchCard);
                }
            } else {
                if (inner) {
                    inner.style.transform = '';
                    inner.style.transition = 'transform 0.2s ease-out';
                    setTimeout(() => { if (inner) inner.style.transition = ''; }, 200);
                }
                localTouchCard.classList.remove('swiping');
            }
            localTouchCard = null;
            isSwiping = false;
        });
    };
    
    setupSwipeForContainer(cardsContainer);
    setupSwipeForContainer(allCardsContainer);
}

// ========== 删除确认 ==========
// ========== 删除确认（修复版） ==========
function showDeleteConfirm(item, type) {
    window._pendingDeleteElements = null;
    window._pendingDelete = null;
    currentSelectedItem = item;
    deleteType = type;
    
    const modalTitle = document.getElementById('modalTitle');
    const modalBodyElem = document.getElementById('modalBody');
    
    if (type === 'record') {
        const expiryDateVal = new Date(createBJDate(item.production_date));
        expiryDateVal.setUTCDate(expiryDateVal.getUTCDate() + item.shelf_life);
        const remainingDaysVal = calculateRemainingDaysLocal(item.production_date, item.shelf_life);
        let statusBadge = remainingDaysVal <= 0 ? '<span class="badge bg-danger">已过期</span>' : (remainingDaysVal <= (item.reminder_days || 0) ? '<span class="badge bg-warning text-dark">临期</span>' : '<span class="badge bg-success">正常</span>');
        if (modalTitle) modalTitle.textContent = '下架商品确认';
        if (modalBodyElem) modalBodyElem.innerHTML = `<div class="alert alert-danger">
            <h5><i class="bi bi-exclamation-triangle"></i> 确定要下架这个商品吗？</h5>
            <div class="border-top my-3"></div>
            <table class="table table-borderless">
                <tr><td><strong>商品名称：</strong></td><td>${escapeHtml(item.name)}</td></tr>
                <tr><td><strong>SKU编码：</strong></td><td><code>${escapeHtml(item.sku)}</code></td></tr>
                <tr><td><strong>存放库位：</strong></td><td><span class="badge bg-info">${escapeHtml(item.location || '默认位置')}</span></td></tr>
                <tr><td><strong>生产日期：</strong></td><td>${escapeHtml(item.production_date)}</td></tr>
                <tr><td><strong>到期日期：</strong></td><td>${formatDateLocal(expiryDateVal)}</td></tr>
                <tr><td><strong>剩余天数：</strong></td><td>${remainingDaysVal > 0 ? remainingDaysVal : 0}天 ${statusBadge}</td></tr>
            </table>
            <div class="alert alert-warning mt-2"><i class="bi bi-info-circle"></i> 删除后无法恢复，请确认该商品已处理完毕。</div>
        </div>`;
    } else if (type === 'product') {
        if (modalTitle) modalTitle.textContent = '删除商品确认';
        if (modalBodyElem) modalBodyElem.innerHTML = `<div class="alert alert-danger">
            <h5><i class="bi bi-exclamation-triangle"></i> 确定要删除这个商品吗？</h5>
            <div class="border-top my-3"></div>
            <table class="table table-borderless">
                <tr><td><strong>商品名称：</strong></td><td><strong>${escapeHtml(item.name)}</strong></td></tr>
                <tr><td><strong>SKU编码：</strong></td><td><code>${escapeHtml(item.sku)}</code></td></tr>
                <tr><td><strong>保质期：</strong></td><td>${item.shelf_life}天</td></tr>
                <tr><td><strong>临期提醒：</strong></td><td>${item.reminder_days}天</td></tr>
                <tr><td><strong>存放库位：</strong></td><td>${escapeHtml(item.location || '默认位置')}</td></tr>
            </table>
            <div class="alert alert-warning mt-2"><i class="bi bi-info-circle"></i> 删除后无法恢复，库存中已有的该商品记录不会自动删除。</div>
        </div>`;
    }
    
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    if (confirmDeleteBtn) {
        const newBtn = confirmDeleteBtn.cloneNode(true);
        confirmDeleteBtn.parentNode.replaceChild(newBtn, confirmDeleteBtn);
        newBtn.addEventListener('click', function(e) { 
            e.preventDefault(); 
            e.stopPropagation(); 
            if (window.confirmModal) window.confirmModal.hide(); 
            setTimeout(() => deleteItemWithAnimation(), 100); 
        });
    }
    if (window.confirmModal) window.confirmModal.show();
}

async function deleteItemWithAnimation() {
    const itemToDelete = currentSelectedItem, typeToDelete = deleteType;
    if (!itemToDelete) { 
        if (window.confirmModal) window.confirmModal.hide(); 
        cleanupModalBackdrops(); 
        return; 
    }
    if (window.confirmModal) { 
        window.confirmModal.hide(); 
        await new Promise(resolve => setTimeout(resolve, 150)); 
        cleanupModalBackdrops(); 
    }
    
    try {
        if (typeToDelete === 'record') {
            await apiRequest(`/api/records/${encodeURIComponent(itemToDelete.sku)}/${encodeURIComponent(itemToDelete.production_date)}`, 'DELETE');
            
            // 强制清空缓存，重新获取数据
            dataCache.records = null;
            dataCache.expiring = null;
            dataCache.lastFetch = { products: 0, records: 0, expiring: 0 };
            
            await renderExpiringTable(true);
            await renderAllTable(true);
            await updateExpiryCount();
            await updateExpiryWarning();
            updateExpiringBadge();
            showQuickToast('库存记录已删除', 'success');
        } else if (typeToDelete === 'product') {
            await apiRequest(`/api/products/${encodeURIComponent(itemToDelete.sku)}`, 'DELETE');
            showQuickToast('商品已从数据库删除', 'success');
            dataCache.clear();
            await renderProductDatabaseTable(true);
            await renderExpiringTable(true);
            await renderAllTable(true);
            await updateExpiryCount();
            await updateExpiryWarning();
            updateExpiringBadge();
        }
    } catch (error) {
        console.error('删除失败:', error);
        showAlert(`删除失败: ${error.message}`, 'danger');
        await renderExpiringTable(true);
        await renderAllTable(true);
        if (typeToDelete === 'product') await renderProductDatabaseTable(true);
    } finally {
        currentSelectedItem = null;
        deleteType = '';
        window._pendingDelete = null;
        window._pendingDeleteElements = null;
        if (animationTimeout) clearTimeout(animationTimeout);
        animationTimeout = null;
    }
}

function cleanupModalBackdrops() {
    const backdrops = document.querySelectorAll('.modal-backdrop');
    backdrops.forEach(backdrop => backdrop.remove());
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
}

// ========== UI渲染函数 ==========
function showTableLoading(tableId, show = true, message = '加载中...') {
    const tableBody = document.getElementById(tableId);
    if (!tableBody) return;
    if (show) {
        const originalHtml = tableBody.innerHTML;
        tableBody.setAttribute('data-original-html', originalHtml);
        tableBody.innerHTML = `<tr class="table-loading-row"><td colspan="9" class="text-center py-5"><div class="spinner-border text-primary" role="status" style="width:2rem;height:2rem;"><span class="visually-hidden">加载中...</span></div><div class="mt-2 text-muted">${escapeHtml(message)}</div></tr>`;
    } else {
        const originalHtml = tableBody.getAttribute('data-original-html');
        if (originalHtml && originalHtml !== '') { 
            tableBody.innerHTML = originalHtml; 
            tableBody.removeAttribute('data-original-html'); 
        } else if (tableBody.children.length === 1 && tableBody.children[0]?.classList?.contains('table-loading-row')) {
            tableBody.innerHTML = '';
        }
    }
}

async function updateExpiryWarning() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/check`, { credentials: 'include' });
        const result = await response.json();
        const expiryWarningBar = document.getElementById('expiryWarningBar');
        const expiryWarningText = document.getElementById('expiryWarningText');
        if (result.isLoggedIn && result.user?.expiryWarning && expiryWarningBar && expiryWarningText) {
            expiryWarningText.textContent = result.user.expiryWarning;
            expiryWarningBar.style.display = 'block';
        } else if (expiryWarningBar) {
            expiryWarningBar.style.display = 'none';
        }
    } catch(e) {
        console.log('更新过期警告失败:', e);
    }
}

async function updateExpiryCount() {
    try {
        // 从缓存获取最新数据（已更新）
        const expiringCount = dataCache.expiring?.length || 0;
        
        // 更新底部导航栏的徽章
        const expiringBadge = document.getElementById('expiringBadge');
        if (expiringBadge) {
            if (expiringCount > 0) {
                expiringBadge.textContent = expiringCount > 99 ? '99+' : expiringCount;
                expiringBadge.style.display = 'inline-block';
            } else {
                expiringBadge.style.display = 'none';
            }
        }
        
        // 更新临期标签页的计数徽章
        const expiringTab = document.getElementById('expiring-tab');
        if (expiringTab) {
            const existingBadge = expiringTab.querySelector('.expiry-count-badge');
            if (existingBadge) existingBadge.remove();
            if (expiringCount > 0) {
                const badge = document.createElement('span');
                badge.className = 'badge bg-danger ms-1 expiry-count-badge';
                badge.textContent = expiringCount;
                expiringTab.appendChild(badge);
            }
        }
    } catch(e) {
        console.log('更新过期计数失败:', e);
    }
}

function updateExpiringBadge() {
    const badge = document.getElementById('expiringBadge');
    if (!badge) return;
    const expiringCount = dataCache.expiring?.length || 0;
    if (expiringCount > 0) {
        badge.textContent = expiringCount > 99 ? '99+' : expiringCount;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

async function renderExpiringTable(forceRefresh = false) {
    const expiringCards = document.getElementById('expiringCards');
    const expiringTableElem = document.getElementById('expiringTable');
    
    if (window.innerWidth <= 768) {
        if (expiringCards) expiringCards.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div><div class="mt-2">加载中...</div></div>';
    } else {
        showTableLoading('expiringTable', true, '加载临期商品...');
    }
    
    try {
        let expiringRecords = await dataCache.getExpiring(forceRefresh);
        
        // 获取所有产品的类别映射
        const products = await dataCache.getProducts();
        const skuToCategory = new Map();
        products.forEach(p => skuToCategory.set(p.sku, p.category || '其他'));
        
        // 为每条记录添加类别
        for (const record of expiringRecords) {
            record.category = skuToCategory.get(record.sku) || '其他';
        }
        
        // 分类筛选
        if (currentCategoryFilter !== 'all') {
            expiringRecords = expiringRecords.filter(record => record.category === currentCategoryFilter);
        }
        
        if (window.innerWidth <= 768) { 
            if (expiringCards) expiringCards.innerHTML = ''; 
        } else { 
            if (expiringTableElem) expiringTableElem.innerHTML = ''; 
        }
        
        if (!expiringRecords || expiringRecords.length === 0) {
            if (window.innerWidth <= 768) { 
                if (expiringCards) expiringCards.innerHTML = '<div class="text-center py-5 text-muted"><i class="bi bi-check-circle" style="font-size:2rem;"></i><p class="mt-2">暂无临期商品</p></div>'; 
            } else { 
                if (expiringTableElem) expiringTableElem.innerHTML = '<tr><td colspan="8" class="text-center py-4">暂无临期商品</td></tr>'; 
            }
            updateExpiringBadge();
            return;
        }
        
        await updateExpiryCount();
        
        // 预加载图片
        for (const record of expiringRecords.slice(0, 10)) {
            getProductImageUrl(record.sku).catch(() => {});
        }
        
        for (const record of expiringRecords) {
            const remainingDaysVal = record.remaining_days;
            const expiryDateVal = new Date(createBJDate(record.production_date));
            expiryDateVal.setUTCDate(expiryDateVal.getUTCDate() + record.shelf_life);
            const imageUrl = await getProductImageUrl(record.sku);
            
            if (window.innerWidth <= 768 && expiringCards) {
                const card = document.createElement('div');
                card.className = `expiring-card ${remainingDaysVal <= 0 ? 'danger' : 'warning'}`;
                card.setAttribute('data-sku', record.sku);
                card.setAttribute('data-production-date', record.production_date);
                
                // 生成缩略图HTML
                let thumbnailHtml = '';
                if (!lowDataMode && imageUrl) {
                    thumbnailHtml = `<img src="${escapeHtml(imageUrl)}" class="card-thumbnail" onclick="event.stopPropagation(); showImagePreview('${escapeHtml(imageUrl)}')" alt="${escapeHtml(record.name)}" loading="lazy">`;
                } else if (!lowDataMode) {
                    thumbnailHtml = '<div class="card-thumbnail" style="width:40px;height:40px;background:#f0f0f0;border-radius:6px;display:flex;align-items:center;justify-content:center;"><i class="bi bi-image" style="font-size:1.2rem;color:#999;"></i></div>';
                }
                
                card.innerHTML = `
                    <div class="card-inner">
                        <div class="card-header-row">
                            <span class="card-sku">${escapeHtml(record.sku)}</span>
                            <span class="card-status ${remainingDaysVal <= 0 ? 'status-danger-bg' : 'status-warning-bg'}">${remainingDaysVal <= 0 ? '已过期' : '临期'}</span>
                        </div>
                        <div class="card-info-item name-row">
                            ${thumbnailHtml}
                            <span class="card-name-text">${escapeHtml(record.name)}</span>
                            <span class="card-category">${escapeHtml(record.category)}</span>
                        </div>
                        <div class="card-body-grid">
                            <div class="card-info-item">
                                <div class="card-info-label">📦 库位</div>
                                <div class="card-info-value location-value">${escapeHtml(record.location || '默认位置')}</div>
                            </div>
                            <div class="card-info-item">
                                <div class="card-info-label">⏳ 剩余</div>
                                <div class="card-info-value days-value">${remainingDaysVal > 0 ? remainingDaysVal : 0}<span class="days-unit">天</span></div>
                            </div>
                            <div class="card-info-item">
                                <div class="card-info-label">📅 生产日期</div>
                                <div class="card-info-value date-value">${escapeHtml(record.production_date)}</div>
                            </div>
                            <div class="card-info-item">
                                <div class="card-info-label">⚠️ 到期日期</div>
                                <div class="card-info-value date-value">${formatDateLocal(expiryDateVal)}</div>
                            </div>
                        </div>
                        <button class="delete-record-btn d-none" data-sku="${escapeHtml(record.sku)}" data-name="${escapeHtml(record.name)}" data-production-date="${escapeHtml(record.production_date)}" data-shelf-life="${record.shelf_life}" data-reminder-days="${record.reminder_days}" data-location="${escapeHtml(record.location || '默认位置')}"></button>
                        <div class="swipe-hint"><i class="bi bi-arrow-left-short"></i><span>左滑删除</span></div>
                    </div>
                `;
                expiringCards.appendChild(card);
            } else if (expiringTableElem) {
                let imageHtml = '<span class="text-muted">无图</span>';
                if (!lowDataMode && imageUrl) {
                    imageHtml = `<img src="${escapeHtml(imageUrl)}" class="product-image-sm" onclick="showImagePreview('${escapeHtml(imageUrl)}')" style="width:40px;height:40px;object-fit:cover;border-radius:6px;cursor:pointer" alt="${escapeHtml(record.name)}" loading="lazy">`;
                }
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${imageHtml}</td>
                    <td>${escapeHtml(record.sku)}</td>
                    <td>${escapeHtml(record.name)}</td>
                    <td>${escapeHtml(record.location || '默认位置')}</td>
                    <td>${escapeHtml(record.production_date)}</td>
                    <td>${formatDateLocal(expiryDateVal)}</td>
                    <td>${remainingDaysVal > 0 ? remainingDaysVal : 0}</td>
                    <td class="${remainingDaysVal <= 0 ? 'text-danger' : 'text-warning'}">${remainingDaysVal <= 0 ? '已过期' : '临期'}</td>
                `;
                expiringTableElem.appendChild(row);
            }
        }
        
        // 绑定左滑删除事件
        initSwipeToDelete();
        
    } catch (error) {
        console.error('渲染临期商品错误:', error);
        if (window.innerWidth <= 768) { 
            if (expiringCards) expiringCards.innerHTML = '<div class="text-center py-5 text-danger">加载失败，请刷新重试</div>'; 
        } else { 
            if (expiringTableElem) expiringTableElem.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-danger">加载失败，请刷新重试</td></tr>'; 
        }
    }
}

// ========== 继续 script.js - 渲染函数 ==========

async function renderAllTable(forceRefresh = false) {
    const allTableElem = document.getElementById('allTable');
    const allCards = document.getElementById('allCards');
    
    if (window.innerWidth <= 768) {
        if (allCards) allCards.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div><div class="mt-2">加载中...</div></div>';
    } else {
        showTableLoading('allTable', true, '加载商品列表...');
    }
    
    try {
        const records = await dataCache.getRecords(forceRefresh);
        
        // 获取所有产品的类别映射
        const products = await dataCache.getProducts();
        const skuToCategory = new Map();
        products.forEach(p => skuToCategory.set(p.sku, p.category || '其他'));
        
        // 为每条记录添加类别
        for (const record of records) {
            record.category = skuToCategory.get(record.sku) || '其他';
        }
        
        if (window.innerWidth <= 768) { 
            if (allCards) allCards.innerHTML = ''; 
        } else { 
            if (allTableElem) allTableElem.innerHTML = ''; 
        }
        
        if (!records || records.length === 0) {
            if (window.innerWidth <= 768) { 
                if (allCards) allCards.innerHTML = '<div class="text-center py-5 text-muted"><i class="bi bi-box" style="font-size:2rem;"></i><p class="mt-2">暂无库存商品</p></div>';
            } else { 
                if (allTableElem) allTableElem.innerHTML = '<tr><td colspan="8" class="text-center py-4">📦 暂无库存商品</div>';
            }
            return;
        }
        
        // 预加载图片
        for (const record of records.slice(0, 10)) {
            getProductImageUrl(record.sku).catch(() => {});
        }
        
        for (const record of records) {
            const remainingDaysVal = record.remaining_days;
            const reminderDaysVal = record.reminder_days || 0;
            let statusClass, statusText, cardClass, statusBgClass;
            if (remainingDaysVal <= 0) { 
                statusClass = 'text-danger'; 
                statusText = '已过期'; 
                cardClass = 'danger'; 
                statusBgClass = 'status-danger-bg'; 
            } else if (remainingDaysVal <= reminderDaysVal) { 
                statusClass = 'text-warning'; 
                statusText = '临期'; 
                cardClass = 'warning'; 
                statusBgClass = 'status-warning-bg'; 
            } else { 
                statusClass = 'text-success'; 
                statusText = '正常'; 
                cardClass = 'normal'; 
                statusBgClass = 'status-normal-bg'; 
            }
            
            const expiryDateVal = new Date(createBJDate(record.production_date));
            expiryDateVal.setUTCDate(expiryDateVal.getUTCDate() + record.shelf_life);
            const imageUrl = await getProductImageUrl(record.sku);
            
            if (window.innerWidth <= 768 && allCards) {
                const card = document.createElement('div');
                card.className = `expiring-card ${cardClass}`;
                card.setAttribute('data-sku', record.sku);
                card.setAttribute('data-production-date', record.production_date);
                
                // 生成缩略图HTML
                let thumbnailHtml = '';
                if (!lowDataMode && imageUrl) {
                    thumbnailHtml = `<img src="${escapeHtml(imageUrl)}" class="card-thumbnail" onclick="event.stopPropagation(); showImagePreview('${escapeHtml(imageUrl)}')" alt="${escapeHtml(record.name)}" loading="lazy">`;
                } else if (!lowDataMode) {
                    thumbnailHtml = '<div class="card-thumbnail" style="width:40px;height:40px;background:#f0f0f0;border-radius:6px;display:flex;align-items:center;justify-content:center;"><i class="bi bi-image" style="font-size:1.2rem;color:#999;"></i></div>';
                }
                
                card.innerHTML = `
                    <div class="card-inner">
                        <div class="card-header-row">
                            <span class="card-sku">${escapeHtml(record.sku)}</span>
                            <span class="card-status ${statusBgClass}">${statusText}</span>
                        </div>
                        <div class="card-info-item name-row">
                            ${thumbnailHtml}
                            <span class="card-name-text">${escapeHtml(record.name)}</span>
                            <span class="card-category">${escapeHtml(record.category)}</span>
                        </div>
                        <div class="card-body-grid">
                            <div class="card-info-item">
                                <div class="card-info-label">📦 库位</div>
                                <div class="card-info-value location-value">${escapeHtml(record.location || '默认位置')}</div>
                            </div>
                            <div class="card-info-item">
                                <div class="card-info-label">⏳ 剩余</div>
                                <div class="card-info-value days-value">${remainingDaysVal > 0 ? remainingDaysVal : 0}<span class="days-unit">天</span></div>
                            </div>
                            <div class="card-info-item">
                                <div class="card-info-label">📅 生产日期</div>
                                <div class="card-info-value date-value">${record.production_date}</div>
                            </div>
                            <div class="card-info-item">
                                <div class="card-info-label">⚠️ 到期日期</div>
                                <div class="card-info-value date-value">${formatDateLocal(expiryDateVal)}</div>
                            </div>
                        </div>
                        <button class="delete-record-btn d-none" data-sku="${escapeHtml(record.sku)}" data-name="${escapeHtml(record.name)}" data-production-date="${record.production_date}" data-shelf-life="${record.shelf_life}" data-reminder-days="${record.reminder_days}" data-location="${escapeHtml(record.location || '默认位置')}"></button>
                        <div class="swipe-hint"><i class="bi bi-arrow-left-short"></i><span>左滑删除</span></div>
                    </div>
                `;
                allCards.appendChild(card);
            } else if (allTableElem) {
                let imageHtml = '<span class="text-muted">无图</span>';
                if (!lowDataMode && imageUrl) {
                    imageHtml = `<img src="${escapeHtml(imageUrl)}" class="product-image-sm" onclick="showImagePreview('${escapeHtml(imageUrl)}')" style="width:40px;height:40px;object-fit:cover;border-radius:6px;cursor:pointer" alt="${escapeHtml(record.name)}" loading="lazy">`;
                }
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${imageHtml}</td>
                    <td>${escapeHtml(record.sku)}</div>
                    <td>${escapeHtml(record.name)}</div>
                    <td>${escapeHtml(record.location || '默认位置')}</div>
                    <td>${record.production_date}</div>
                    <td>${formatDateLocal(expiryDateVal)}</div>
                    <td>${remainingDaysVal > 0 ? remainingDaysVal : 0}${remainingDaysVal > 0 && remainingDaysVal <= reminderDaysVal ? '<span class="badge bg-warning ms-1">临期</span>' : ''}</div>
                    <td class="${statusClass}">${statusText}</div>
                `;
                allTableElem.appendChild(row);
            }
        }
        
        // 绑定左滑删除事件
        initSwipeToDelete();
        
    } catch (error) {
        console.error('渲染所有商品错误:', error);
        if (window.innerWidth <= 768) { 
            if (allCards) allCards.innerHTML = '<div class="text-center py-5 text-danger">加载失败，请刷新重试</div>';
        } else { 
            if (allTableElem) allTableElem.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-danger">加载失败，请刷新重试</div>';
        }
    }
}
async function renderProductDatabaseTable(forceRefresh = false) {
    const tableBody = document.getElementById('productDatabaseTable');
    if (!tableBody) return;
    
    tableBody.innerHTML = `<tr><td colspan="8" class="text-center py-5"><div class="spinner-border text-primary" role="status"></div><div class="mt-2">加载商品数据库...</div></td></tr>`;
    
    try {
        const products = await dataCache.getProducts(forceRefresh);
        tableBody.innerHTML = '';
        
        if (!products || products.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="8" class="text-center py-4">暂无商品数据</td></tr>';
            return;
        }
        
        const sortedProducts = [...products].sort((a, b) => a.sku.localeCompare(b.sku));
        
        for (const product of sortedProducts) {
            let imageHtml = '<span class="text-muted">无图</span>';
            if (!lowDataMode) {
                try {
                    const imageData = await getProductImageUrl(product.sku);
                    if (imageData) {
                        imageHtml = `<img src="${imageData}" class="product-image" onclick="showImagePreview('${imageData}')" style="width:40px;height:40px;object-fit:cover;border-radius:8px;cursor:pointer" loading="lazy">`;
                    }
                } catch(e) {}
            }
            
            const row = document.createElement('tr');
            row.style.verticalAlign = 'middle';
            row.innerHTML = `
                <td style="width:50px;vertical-align:middle;">${imageHtml}</td>
                <td style="vertical-align:middle;">${escapeHtml(product.sku)}</td>
                <td style="vertical-align:middle;">${escapeHtml(product.name)}</td>
                <td style="vertical-align:middle;text-align:center;">${product.shelf_life}</td>
                <td style="vertical-align:middle;text-align:center;">${product.reminder_days}</td>
                <td style="vertical-align:middle;">${escapeHtml(product.location)}</td>
                <td style="vertical-align:middle;">${escapeHtml(product.category || '其他')}</td>
                <td style="vertical-align:middle;white-space:nowrap;">
                    <button class="btn btn-sm btn-warning edit-product-btn me-1" data-sku="${escapeHtml(product.sku)}"><i class="bi bi-pencil"></i> 编辑</button>
                    <button class="btn btn-sm btn-danger delete-product-btn" data-sku="${escapeHtml(product.sku)}" data-name="${escapeHtml(product.name)}" data-shelf-life="${product.shelf_life}" data-reminder-days="${product.reminder_days}" data-location="${escapeHtml(product.location)}"><i class="bi bi-trash"></i> 删除</button>
                </td>
            `;
            tableBody.appendChild(row);
        }
        
        // 绑定编辑和删除按钮事件
        document.querySelectorAll('.edit-product-btn').forEach(btn => {
            btn.removeEventListener('click', handleEditProduct);
            btn.addEventListener('click', handleEditProduct);
        });
        document.querySelectorAll('.delete-product-btn').forEach(btn => {
            btn.removeEventListener('click', handleDeleteProduct);
            btn.addEventListener('click', handleDeleteProduct);
        });
        
    } catch (error) {
        console.error('加载商品数据库失败:', error);
        tableBody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-danger">加载失败，请刷新重试</td></tr>';
    }
}

// 添加 handleRestoreRegret 函数
async function handleRestoreRegret(e) {
    const btn = e.currentTarget;
    const id = btn.getAttribute('data-id');
    
    if (confirm('确定要恢复这个商品吗？')) {
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
        
        try {
            await apiRequest(`/api/deleted-records/${id}/restore`, 'POST');
            showQuickToast('恢复成功', 'success');
            
            // 清空缓存
            dataCache.records = null;
            dataCache.expiring = null;
            dataCache.products = null;
            
            // 重新加载数据（静默刷新，不显示加载动画）
            await renderExpiringTable(true);
            await renderAllTable(true);
            await renderRegretTable(true);
            
            // 更新计数徽章
            updateExpiringBadge();
            
            // 更新临期标签页计数
            const expiringTab = document.getElementById('expiring-tab');
            if (expiringTab) {
                const existingBadge = expiringTab.querySelector('.expiry-count-badge');
                if (existingBadge) existingBadge.remove();
                const expiringCount = dataCache.expiring?.length || 0;
                if (expiringCount > 0) {
                    const badge = document.createElement('span');
                    badge.className = 'badge bg-danger ms-1 expiry-count-badge';
                    badge.textContent = expiringCount;
                    expiringTab.appendChild(badge);
                }
            }
            
        } catch (error) { 
            showAlert(`恢复失败: ${error.message}`, 'danger');
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
}
async function handleDeleteRegret(e) {
    const btn = e.currentTarget;
    const id = btn.getAttribute('data-id');
    if (confirm('确定要永久删除这条记录吗？此操作不可恢复！')) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
        try {
            await apiRequest(`/api/deleted-records/${id}`, 'DELETE');
            showQuickToast('已永久删除', 'success');
            await renderRegretTable(true);
        } catch (error) { 
            showAlert(`删除失败: ${error.message}`, 'danger');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-trash"></i> 永久删除';
        }
    }
}
// ========== 后悔药渲染 - 手机端只显示卡片 ==========
async function renderRegretTable(forceRefresh = false) {
    const regretTable = document.getElementById('regretTable');
    const regretCards = document.getElementById('regretCards');
    
    // PC端隐藏卡片，显示表格；手机端隐藏表格，显示卡片
    const isMobile = window.innerWidth <= 768;
    
    if (regretTable) {
        regretTable.style.display = isMobile ? 'none' : '';
    }
    if (regretCards) {
        regretCards.style.display = isMobile ? 'block' : 'none';
    }
    
    if (!isMobile && regretTable) {
        regretTable.innerHTML = '';
    }
    if (regretCards) {
        regretCards.innerHTML = '';
    }
    
    try {
        const records = await apiRequest('/api/deleted-records');
        
        if (!records || records.length === 0) {
            if (!isMobile && regretTable) {
                regretTable.innerHTML = '<tr><td colspan="6" class="text-center py-4">暂无删除记录</div>';
            }
            if (regretCards) {
                regretCards.innerHTML = '<div class="text-center py-5 text-muted"><i class="bi bi-clock-history" style="font-size:2rem;"></i><p class="mt-2">暂无删除记录</p></div>';
            }
            return;
        }
        
        for (const record of records) {
            const expiryDate = new Date(createBJDate(record.production_date));
            expiryDate.setUTCDate(expiryDate.getUTCDate() + record.shelf_life);
            const deletedAt = new Date(record.deleted_at);
            
            // PC端表格
            if (!isMobile && regretTable) {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${escapeHtml(record.name)}</div>
                    <td>${escapeHtml(record.sku)}</div>
                    <td>${record.production_date}</div>
                    <td>${formatDateLocal(expiryDate)}</div>
                    <td>${deletedAt.toLocaleString()}</div>
                    <td>
                        <button class="btn btn-sm btn-success restore-regret-btn me-1" data-id="${record.id}"><i class="bi bi-arrow-repeat"></i> 恢复</button>
                        <button class="btn btn-sm btn-danger delete-regret-btn" data-id="${record.id}"><i class="bi bi-trash"></i> 永久删除</button>
                    </div>
                `;
                regretTable.appendChild(row);
            }
            
            // 手机端卡片
            if (regretCards) {
                const card = document.createElement('div');
                card.className = 'expiring-card normal regret-card';
                card.style.marginBottom = '12px';
                card.innerHTML = `
                    <div class="card-inner" style="padding: 14px;">
                        <div class="card-header-row" style="display:flex;justify-content:space-between;margin-bottom:12px;">
                            <span class="card-sku" style="background:#f8f9fa;padding:4px 10px;border-radius:20px;font-size:0.9rem;">${escapeHtml(record.sku)}</span>
                            <span class="card-status status-normal-bg" style="background:#6c757d;color:white;padding:4px 10px;border-radius:20px;font-size:0.75rem;">已删除</span>
                        </div>

                        <div class="card-info-item" style="margin-bottom:12px;">
                            <div class="card-info-label" style="font-size:0.7rem;color:#6c757d;">商品名称</div>
                            <div class="card-info-value name-value" style="font-size:1rem;font-weight:600;">${escapeHtml(record.name)}</div>
                        <div class="card-body-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
                            <div class="card-info-item">
                                <div class="card-info-label" style="font-size:0.65rem;color:#6c757d;">📅 生产日期</div>
                                <div class="card-info-value date-value" style="font-size:0.85rem;">${record.production_date}</div>
                            </div>
                            <div class="card-info-item">
                                <div class="card-info-label" style="font-size:0.65rem;color:#6c757d;">⚠️ 到期日期</div>
                                <div class="card-info-value date-value" style="font-size:0.85rem;">${formatDateLocal(expiryDate)}</div>
                            </div>
                            <div class="card-info-item">
                                <div class="card-info-label" style="font-size:0.65rem;color:#6c757d;">🗑️ 删除时间</div>
                                <div class="card-info-value date-value" style="font-size:0.75rem;">${deletedAt.toLocaleString()}</div>
                            </div>
                        </div>
                        <div class="card-footer-row" style="display:flex;gap:8px;justify-content:flex-end;">
                            <button class="btn btn-sm btn-success restore-regret-btn" data-id="${record.id}" style="min-height:36px;"><i class="bi bi-arrow-repeat"></i> 恢复</button>
                            <button class="btn btn-sm btn-danger delete-regret-btn" data-id="${record.id}" style="min-height:36px;"><i class="bi bi-trash"></i> 永久删除</button>
                        </div>
                    </div>
                `;
                regretCards.appendChild(card);
            }
        }
        
        // 绑定恢复和删除按钮事件
        document.querySelectorAll('.restore-regret-btn').forEach(btn => {
            btn.removeEventListener('click', handleRestoreRegret);
            btn.addEventListener('click', handleRestoreRegret);
        });
        document.querySelectorAll('.delete-regret-btn').forEach(btn => {
            btn.removeEventListener('click', handleDeleteRegret);
            btn.addEventListener('click', handleDeleteRegret);
        });
        
    } catch (error) {
        console.error('加载后悔药失败:', error);
        if (regretTable) regretTable.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-danger">加载失败</div>';
        if (regretCards) regretCards.innerHTML = '<div class="text-center py-5 text-danger">加载失败，请刷新重试</div>';
    }
}



// ========== 商品操作函数 ==========
function handleEditProduct(e) {
    const btn = e.currentTarget;
    const sku = btn.getAttribute('data-sku');
    const addTab = document.getElementById('add-tab');
    if (addTab && window.bootstrap) {
        const tabTrigger = new window.bootstrap.Tab(addTab);
        tabTrigger.show();
    }
    setTimeout(() => {
        const searchSkuElem = document.getElementById('searchSku');
        const searchBtnElem = document.getElementById('searchBtn');
        if (searchSkuElem) searchSkuElem.value = sku;
        if (searchBtnElem) searchBtnElem.click();
    }, 100);
}

function handleDeleteProduct(e) {
    const btn = e.currentTarget;
    const product = {
        sku: btn.getAttribute('data-sku'),
        name: btn.getAttribute('data-name'),
        shelf_life: parseInt(btn.getAttribute('data-shelf-life')),
        reminder_days: parseInt(btn.getAttribute('data-reminder-days')),
        location: btn.getAttribute('data-location')
    };
    showDeleteConfirm(product, 'product');
}

// ========== 管理员函数 ==========
async function loadUsers() {

     // 普通用户不能查看用户列表
    if (currentUserRole !== 'admin') return;
    try {
        const users = await apiRequest('/api/admin/users');
        const tbody = document.getElementById('usersTable');
        if (!tbody) return;
        tbody.innerHTML = '';
        for (const user of users) {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${user.id}</td>
                <td>${escapeHtml(user.username)}</td>
                <td>${user.role === 'admin' ? '<span class="badge bg-danger">管理员</span>' : '<span class="badge bg-secondary">普通用户</span>'}</td>
                <td>${user.created_at?.slice(0,10) || '-'}</td>
                <td>${user.last_login?.slice(0,10) || '-'}</td>
                <td>${user.valid_until || '永久'}${user.valid_until && new Date(user.valid_until) < new Date() ? '<span class="badge bg-danger ms-1">已过期</span>' : ''}</td>
                <td>${user.role !== 'admin' ? '<button class="btn btn-sm btn-warning me-1" onclick="window.showResetPasswordModal(' + user.id + ', \'' + escapeHtml(user.username) + '\')"><i class="bi bi-key"></i> 重置密码</button><button class="btn btn-sm btn-info me-1" onclick="window.showValidityModal(' + user.id + ', \'' + (user.valid_until || '') + '\')"><i class="bi bi-calendar"></i> 续期</button><button class="btn btn-sm btn-danger" onclick="window.deleteUser(' + user.id + ', \'' + escapeHtml(user.username) + '\')"><i class="bi bi-trash"></i> 删除</button>' : '<span class="text-muted">-</span>'}</td>
            `;
            tbody.appendChild(row);
        }
    } catch (error) { 
        console.error('加载用户失败:', error); 
    }
}

async function loadAuthCodes() {
    // 普通用户不能查看授权码
    if (currentUserRole !== 'admin') return;
    try {
        const codes = await apiRequest('/api/admin/auth-codes');
        const tbody = document.getElementById('codesTable');
        if (!tbody) return;
        tbody.innerHTML = '';
        for (const code of codes) {
            const statusBadge = code.status === 'active' ? '<span class="badge bg-success">有效</span>' : (code.status === 'used' ? '<span class="badge bg-secondary">已使用</span>' : '<span class="badge bg-danger">已失效</span>');
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><code>${escapeHtml(code.code)}</code></td>
                <td>${code.created_by_name || '-'}</td>
                <td>${code.valid_until}</td>
                <td>${statusBadge}</td>
                <td>${code.used_by_name || '-'}</td>
                <td>${code.status === 'active' ? `<button class="btn btn-sm btn-warning" onclick="window.editAuthCode(${code.id}, '${code.valid_until}')"><i class="bi bi-pencil"></i> 编辑</button>` : '-'}</td>
            `;
            tbody.appendChild(row);
        }
    } catch (error) { 
        console.error('加载授权码失败:', error); 
    }
}

async function loadLogs() {
    // 普通用户不能查看日志
    if (currentUserRole !== 'admin') return;
    try {
        const logs = await apiRequest('/api/admin/logs');
        const tbody = document.getElementById('logsTable');
        if (!tbody) return;
        tbody.innerHTML = '';
        for (const log of logs.slice(0, 100)) {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${log.created_at?.slice(0,19) || '-'}</td>
                <td>${log.admin_name || '-'}</td>
                <td>${log.action}</td>
                <td>${log.target_user || '-'}</td>
                <td>${log.details || '-'}</td>
            `;
            tbody.appendChild(row);
        }
    } catch (error) { 
        console.error('加载日志失败:', error); 
    }
}

async function generateAuthCode() {
    const validUntil = document.getElementById('newCodeValidUntil')?.value;
    if (!validUntil) { 
        showAlert('请选择有效期', 'warning'); 
        return; 
    }
    try {
        const result = await apiRequest('/api/admin/auth-codes', 'POST', { validUntil });
        const resultDiv = document.getElementById('newCodeResult');
        if (resultDiv) {
            resultDiv.innerHTML = `<i class="bi bi-key"></i> 新授权码: <code>${escapeHtml(result.code)}</code><br>有效期至: ${result.validUntil}<br><button class="btn btn-sm btn-outline-primary mt-2" onclick="window.copyToClipboard('${result.code}')"><i class="bi bi-copy"></i> 复制</button>`;
            resultDiv.style.display = 'block';
        }
        await loadAuthCodes();
        setTimeout(() => { if (resultDiv) resultDiv.style.display = 'none'; }, 10000);
    } catch (error) { 
        showAlert(`生成失败: ${error.message}`, 'danger'); 
    }
}

async function confirmResetPassword() {
    const userId = document.getElementById('resetUserId')?.value;
    const newPassword = document.getElementById('resetNewPassword')?.value;
    const confirmPassword = document.getElementById('resetConfirmPassword')?.value;
    if (!newPassword || newPassword.length < 6) { 
        showAlert('密码长度不能少于6位', 'warning'); 
        return; 
    }
    if (newPassword !== confirmPassword) { 
        showAlert('两次输入的密码不一致', 'warning'); 
        return; 
    }
    try {
        await apiRequest(`/api/admin/users/${userId}/reset-password`, 'POST', { newPassword });
        showAlert('密码已重置', 'success');
        if (window.resetPasswordModal) window.resetPasswordModal.hide();
    } catch (error) { 
        showAlert(`重置失败: ${error.message}`, 'danger'); 
    }
}

async function confirmValidity() {
    const userId = document.getElementById('validityUserId')?.value;
    const validUntil = document.getElementById('validityDate')?.value;
    if (!validUntil) { 
        showAlert('请选择有效期', 'warning'); 
        return; 
    }
    try {
        await apiRequest(`/api/admin/users/${userId}/validity`, 'POST', { validUntil });
        showAlert('有效期已更新', 'success');
        if (window.validityModal) window.validityModal.hide();
        await loadUsers();
    } catch (error) { 
        showAlert(`更新失败: ${error.message}`, 'danger'); 
    }
}

async function confirmEditCode() {
    const codeId = document.getElementById('editCodeId')?.value;
    const validUntil = document.getElementById('editCodeValidUntil')?.value;
    const status = document.getElementById('editCodeStatus')?.value;
    try {
        await apiRequest(`/api/admin/auth-codes/${codeId}`, 'PUT', { validUntil, status });
        showAlert('授权码已更新', 'success');
        if (window.editCodeModal) window.editCodeModal.hide();
        await loadAuthCodes();
    } catch (error) { 
        showAlert(`更新失败: ${error.message}`, 'danger'); 
    }
}

async function exportData() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/export`, { credentials: 'include' });
        if (!response.ok) throw new Error('导出失败');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `export_${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showAlert('数据导出成功', 'success');
    } catch (error) { 
        showAlert(`导出失败: ${error.message}`, 'danger'); 
    }
}

function importData() {
    const fileInput = document.getElementById('importFileInput');
    if (fileInput) fileInput.click();
    if (fileInput) {
        fileInput.onchange = async function(e) {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const result = await apiRequest('/api/import', 'POST', data);
                showAlert(`导入成功: 商品新增${result.results.productsAdded}个，更新${result.results.productsUpdated}个，库存新增${result.results.recordsAdded}条`, 'success');
                dataCache.clear();
                await renderProductDatabaseTable(true);
                await renderAllTable(true);
            } catch (error) { 
                showAlert(`导入失败: ${error.message}`, 'danger'); 
            }
            fileInput.value = '';
        };
    }
}

// ========== 初始化函数 ==========
function initBottomNav() {
    const bottomNav = document.getElementById('bottomNav');
    const navItems = document.querySelectorAll('.bottom-nav .nav-item');
    if (bottomNav) bottomNav.style.display = 'flex';
    
    const tabContents = ['home', 'expiring', 'all', 'add', 'data', 'regret', 'admin'];
    tabContents.forEach(tab => {
        const element = document.getElementById(tab);
        if (element) element.classList.add('d-none');
    });
    document.getElementById('home')?.classList.remove('d-none');
    
    navItems.forEach(item => {
        item.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const tabName = item.getAttribute('data-tab');
            if (!tabName) return;
            vibrate(20);
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            tabContents.forEach(tab => {
                const el = document.getElementById(tab);
                if (el) el.classList.add('d-none');
            });
            const selectedTab = document.getElementById(tabName);
            if (selectedTab) selectedTab.classList.remove('d-none');
            switch (tabName) {
                case 'expiring': await renderExpiringTable(false); break;
                case 'all': await renderAllTable(false); break;
                case 'regret': await renderRegretTable(false); break;
                case 'add': await renderProductDatabaseTable(false); break;
               
               case 'admin': 
                        if (currentUserRole === 'admin') { 
                            await loadUsers(); 
                            await loadAuthCodes(); 
                            await loadLogs(); 
                        } else {
                            // 普通用户：只显示导入导出面板
                            document.querySelectorAll('.admin-panel').forEach(panel => {
                                panel.style.display = 'none';
                            });
                            const importExportPanel = document.getElementById('admin-import-export');
                            if (importExportPanel) importExportPanel.style.display = 'block';
                            
                            // 隐藏管理员其他标签页按钮
                            document.querySelectorAll('[data-admin-tab]').forEach(tab => {
                                if (tab.getAttribute('data-admin-tab') !== 'import-export') {
                                    tab.style.display = 'none';
                                }
                            });
                        }
                        break;
                                
            
            }
        });
    });
}

function initLowDataMode() {
    const toggleBtn = document.getElementById('lowDataToggle');
    if (!toggleBtn) return;
    
    // 从 localStorage 读取状态
    lowDataMode = localStorage.getItem(STORAGE_KEYS.LOW_DATA_MODE) === 'true';
    
    if (lowDataMode) {
        document.body.classList.add('low-data-mode');
        toggleBtn.innerHTML = '<i class="bi bi-image"></i>'; // 无图模式图标
    } else {
        document.body.classList.remove('low-data-mode');
        toggleBtn.innerHTML = '<i class="bi bi-images"></i>'; // 正常模式图标
    }
    
    toggleBtn.addEventListener('click', () => {
        lowDataMode = !lowDataMode;
        localStorage.setItem(STORAGE_KEYS.LOW_DATA_MODE, lowDataMode);
        if (lowDataMode) {
            document.body.classList.add('low-data-mode');
            toggleBtn.innerHTML = '<i class="bi bi-image"></i>';
            showQuickToast('无图模式已开启，图片已屏蔽', 'info');
        } else {
            document.body.classList.remove('low-data-mode');
            toggleBtn.innerHTML = '<i class="bi bi-images"></i>';
            showQuickToast('无图模式已关闭', 'info');
            refreshAllData();
        }
        vibrate(30);
    });
}
function initCategoryFilter() {
    const filters = document.querySelectorAll('.category-filter');
    filters.forEach(btn => {
        btn.removeEventListener('click', handleCategoryFilter);
        btn.addEventListener('click', handleCategoryFilter);
    });
}

async function handleCategoryFilter(e) {
    const btn = e.currentTarget;
    const category = btn.getAttribute('data-category');
    document.querySelectorAll('.category-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentCategoryFilter = category;
    await renderExpiringTable(true);
}

function initTouchFeedback() {
    const clickableElements = document.querySelectorAll('.btn, .nav-item, .expiring-card, button, [data-tab]');
    clickableElements.forEach(el => {
        el.addEventListener('touchstart', () => { el.style.opacity = '0.7'; }, { passive: true });
        el.addEventListener('touchend', () => { el.style.opacity = ''; });
        el.addEventListener('touchcancel', () => { el.style.opacity = ''; });
    });
}

function showTimezoneInfo() {
    setTimeout(() => {
        const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const now = new Date();
        const utcOffset = -now.getTimezoneOffset() / 60;
        const offsetSign = utcOffset >= 0 ? '+' : '-';
        let footer = document.querySelector('.timezone-footer');
        if (!footer) {
            footer = document.createElement('div');
            footer.className = 'timezone-footer';
            footer.style.cssText = 'text-align:center;font-size:11px;color:#999;margin-top:20px;padding:10px;';
            document.body.appendChild(footer);
        }
        footer.innerHTML = `本地时区: ${userTimezone} (UTC${offsetSign}${Math.abs(utcOffset)}:00) | 服务器: UTC+8 | 左滑卡片快速下架`;
    }, 500);
}

async function refreshAllData() {
    dataCache.clear();
    await renderExpiringTable(true);
    await renderAllTable(true);
    await renderProductDatabaseTable(true);
    showQuickToast('刷新完成', 'success');
}

// ========== 自动保存计时器（3秒倒计时） ==========
function startAutoSaveTimer() {
    // 清除之前的计时器
    if (autoSaveCountdownTimer) {
        clearInterval(autoSaveCountdownTimer);
        autoSaveCountdownTimer = null;
    }
    
    const productionDateElem = document.getElementById('productionDate');
    const skuInputElem = document.getElementById('skuInput');
    const productNameElem = document.getElementById('productName');
    
    // 检查是否有必要字段 - 必须有生产日期才启动自动保存
    if (!productionDateElem?.value || !skuInputElem?.value || !productNameElem?.value) {
        return;
    }
    
    // 显示自动保存提示
    const timerDiv = document.getElementById('autoSaveTimer');
    const secondsSpan = document.getElementById('timerSeconds');
    if (timerDiv && secondsSpan) {
        timerDiv.style.display = 'flex';
        timerDiv.style.alignItems = 'center';
        timerDiv.style.justifyContent = 'center';
        let seconds = 3;
        secondsSpan.textContent = seconds;
        
        autoSaveCountdownTimer = setInterval(() => {
            seconds--;
            if (seconds >= 0) {
                secondsSpan.textContent = seconds;
            } else {
                clearInterval(autoSaveCountdownTimer);
                autoSaveCountdownTimer = null;
                timerDiv.style.display = 'none';
                // 自动保存
                autoSaveProductRecord();
            }
        }, 1000);
    }
}

function cancelAutoSaveTimer() {
    if (autoSaveCountdownTimer) {
        clearInterval(autoSaveCountdownTimer);
        autoSaveCountdownTimer = null;
    }
    const timerDiv = document.getElementById('autoSaveTimer');
    if (timerDiv) timerDiv.style.display = 'none';
}

async function autoSaveProductRecord() {
    const skuInputElem = document.getElementById('skuInput');
    const productionDateElem = document.getElementById('productionDate');
    const productNameElem = document.getElementById('productName');
    const shelfLifeElem = document.getElementById('shelfLife');
    const reminderDaysElem = document.getElementById('reminderDays');
    
    const sku = skuInputElem?.value?.trim();
    const prodDate = productionDateElem?.value;
    
    if (!sku || sku.length !== 5) return;
    if (!prodDate) return;
    if (!productNameElem?.value) return;
    
    const prodDateObj = createBJDate(prodDate);
    const today = getBJToday();
    if (prodDateObj > today) return;
    
    try {
        // 检查重复
        const records = await apiRequest(`/api/records/by-sku/${sku}`);
        const duplicate = records.find(r => r.production_date === prodDate);
        if (duplicate) {
            showQuickToast('该商品已存在，未重复添加', 'warning');
            return;
        }
        
        const loc = await getProductLocation(sku);
        const record = { 
            sku, 
            name: productNameElem.value, 
            production_date: prodDate, 
            shelf_life: parseInt(shelfLifeElem.value), 
            reminder_days: parseInt(reminderDaysElem.value), 
            location: loc || '默认位置' 
        };
        
        await apiRequest('/api/records', 'POST', record);
        showQuickToast('商品已自动保存', 'success');
        dataCache.clear();
        
        // 清空表单，准备下一个商品
        if (skuInputElem) skuInputElem.value = '';
        clearForm();
        if (skuInputElem) skuInputElem.focus();
        
        await renderExpiringTable(true);
        await renderAllTable(true);
        
    } catch (error) { 
        console.error('自动保存失败:', error);
        if (!error.message?.includes('已存在')) {
            showQuickToast('自动保存失败，请手动保存', 'danger');
        }
    }
}

// 暴露取消自动保存函数供HTML调用
window.cancelAutoSave = function() {
    cancelAutoSaveTimer();
    showQuickToast('已取消自动保存', 'info');
};

// ========== 修复 lookupProductWithExistingDates - 添加更好的未找到提示 ==========
// ========== 修复 SKU 未找到弹窗函数 ==========
async function lookupProductWithExistingDates() {
    const skuInputElem = document.getElementById('skuInput');
    const productNameElem = document.getElementById('productName');
    const shelfLifeElem = document.getElementById('shelfLife');
    const reminderDaysElem = document.getElementById('reminderDays');
    const productLocationElem = document.getElementById('productLocation');
    const productionDateElem = document.getElementById('productionDate');
    
    if (!skuInputElem) return;
    const sku = skuInputElem.value.trim();
    if (sku.length !== 5) { 
        clearForm(); 
        return; 
    }
    
    try {
        const product = await apiRequest(`/api/products/global/${sku}`);
        if (product && product.sku) {
            if (productNameElem) productNameElem.value = product.name;
            if (shelfLifeElem) shelfLifeElem.value = product.shelf_life;
            if (reminderDaysElem) reminderDaysElem.value = product.reminder_days;
            if (productLocationElem) productLocationElem.textContent = product.location || '默认位置';
            if (productionDateElem) {
                productionDateElem.disabled = false;
                const today = getBJToday();
                productionDateElem.value = formatDateLocal(today);
                setTimeout(() => {
                    productionDateElem.focus();
                    if (window.innerWidth <= 768 && productionDateElem.showPicker) {
                        try {
                            productionDateElem.showPicker();
                        } catch(e) {
                            console.log('无法自动打开日期选择器:', e);
                        }
                    }
                }, 100);
            }
            calculateDates();
            showQuickToast(`已找到商品：${product.name}`, 'success');
            // 注意：这里不调用 startAutoSaveTimer()，让 calculateDates 中的日期选择后再触发
        } else {
            clearForm();
            showSkuNotFoundDialog(sku);
        }
    } catch (error) {
        console.error('查询商品失败:', error);
        clearForm();
        showSkuNotFoundDialog(sku);
    }
}

// SKU未找到弹窗函数 - 修复版
function showSkuNotFoundDialog(sku) {
    const notFoundSkuSpan = document.getElementById('notFoundSku');
    if (notFoundSkuSpan) {
        notFoundSkuSpan.textContent = sku;
    }
    
    let modal = document.getElementById('skuNotFoundModal');
    if (!modal) {
        const modalHtml = `
            <div class="modal fade" id="skuNotFoundModal" tabindex="-1" data-bs-backdrop="static">
                <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content">
                        <div class="modal-header bg-warning">
                            <h5 class="modal-title"><i class="bi bi-exclamation-triangle"></i> SKU未找到</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <p>SKU编码 <code id="notFoundSku"></code> 不存在于商品库中。</p>
                            <p>请先添加该商品，然后再录入库存。</p>
                            <hr>
                            <div class="d-flex gap-2 justify-content-center">
                                <button class="btn btn-primary" id="goToAddProductBtn">
                                    <i class="bi bi-plus-circle"></i> 前往添加商品
                                </button>
                                <button class="btn btn-secondary" id="reinputSkuBtn">
                                    <i class="bi bi-arrow-repeat"></i> 重新输入
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        modal = document.getElementById('skuNotFoundModal');
    }
    
    // 每次显示弹窗前重新绑定按钮事件（确保使用最新的DOM）
    const goToAddBtn = document.getElementById('goToAddProductBtn');
    const reinputBtn = document.getElementById('reinputSkuBtn');
    const modalEl = modal;
    
    if (goToAddBtn) {
        // 移除旧事件，防止重复绑定
        const newGoToAddBtn = goToAddBtn.cloneNode(true);
        goToAddBtn.parentNode.replaceChild(newGoToAddBtn, goToAddBtn);
        
        newGoToAddBtn.onclick = () => {
            // 关闭弹窗
            const bsModal = bootstrap.Modal.getInstance(modalEl);
            if (bsModal) bsModal.hide();
            
            // 切换到"新增商品"标签页（注意：标签页ID是 "add"）
            const addTab = document.getElementById('add');
            const addNavItem = document.querySelector('.bottom-nav .nav-item[data-tab="add"]');
            
            if (addNavItem) {
                // 触发底部导航栏的点击事件
                addNavItem.click();
            }
            
            // 延迟一下确保标签页切换完成，然后填充SKU
            setTimeout(() => {
                const newSkuInput = document.getElementById('newSku');
                if (newSkuInput) {
                    newSkuInput.value = sku;
                    newSkuInput.focus();
                }
                // 同时清空首页的SKU输入框
                const skuInput = document.getElementById('skuInput');
                if (skuInput) {
                    skuInput.value = '';
                }
            }, 100);
        };
    }
    
    if (reinputBtn) {
        // 移除旧事件，防止重复绑定
        const newReinputBtn = reinputBtn.cloneNode(true);
        reinputBtn.parentNode.replaceChild(newReinputBtn, reinputBtn);
        
        newReinputBtn.onclick = () => {
            // 关闭弹窗
            const bsModal = bootstrap.Modal.getInstance(modalEl);
            if (bsModal) bsModal.hide();
            
            // 清空首页SKU输入框并聚焦
            const skuInput = document.getElementById('skuInput');
            if (skuInput) {
                skuInput.value = '';
                skuInput.focus();
            }
        };
    }
    
    // 显示弹窗
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();
}

function clearForm() {
    const productNameElem = document.getElementById('productName');
    const shelfLifeElem = document.getElementById('shelfLife');
    const reminderDaysElem = document.getElementById('reminderDays');
    const productLocationElem = document.getElementById('productLocation');
    const productionDateElem = document.getElementById('productionDate');
    
    if (productNameElem) productNameElem.value = '';
    if (shelfLifeElem) shelfLifeElem.value = '';
    if (reminderDaysElem) reminderDaysElem.value = '';
    if (productLocationElem) productLocationElem.textContent = '-';
    if (productionDateElem) {
        productionDateElem.value = '';
        productionDateElem.disabled = true;
    }
    clearResults();
}

function clearResults() {
    const expiryDateElem = document.getElementById('expiryDate');
    const reminderDateElem = document.getElementById('reminderDate');
    const remainingDaysElem = document.getElementById('remainingDays');
    const statusIndicatorElem = document.getElementById('statusIndicator');
    
    if (expiryDateElem) expiryDateElem.textContent = '-';
    if (reminderDateElem) reminderDateElem.textContent = '-';
    if (remainingDaysElem) remainingDaysElem.textContent = '-';
    if (statusIndicatorElem) statusIndicatorElem.innerHTML = '';
}

// 修复 calculateDates 函数 - 删除重复代码
function calculateDates() {
    const productionDateElem = document.getElementById('productionDate');
    const shelfLifeElem = document.getElementById('shelfLife');
    const reminderDaysElem = document.getElementById('reminderDays');
    const expiryDateElem = document.getElementById('expiryDate');
    const reminderDateElem = document.getElementById('reminderDate');
    const remainingDaysElem = document.getElementById('remainingDays');
    const statusIndicatorElem = document.getElementById('statusIndicator');
    
    if (!productionDateElem?.value || !shelfLifeElem?.value) return;
    try {
        const prodDateStr = productionDateElem.value;
        const shelfLifeDays = parseInt(shelfLifeElem.value) || 0;
        const reminderDaysValue = parseInt(reminderDaysElem?.value) || 0;
        if (shelfLifeDays <= 0) { clearResults(); return; }
        const prodDate = createBJDate(prodDateStr);
        const expiryDateVal = new Date(prodDate);
        expiryDateVal.setUTCDate(prodDate.getUTCDate() + shelfLifeDays);
        const reminderDateVal = new Date(expiryDateVal);
        reminderDateVal.setUTCDate(expiryDateVal.getUTCDate() - reminderDaysValue);
        const today = getBJToday();
        const remainingDaysValue = Math.ceil((expiryDateVal.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (expiryDateElem) expiryDateElem.textContent = formatDateLocal(expiryDateVal);
        if (reminderDateElem) reminderDateElem.textContent = formatDateLocal(reminderDateVal);
        if (remainingDaysElem) remainingDaysElem.textContent = remainingDaysValue > 0 ? `${remainingDaysValue}天` : '已过期';
        if (statusIndicatorElem) {
            if (remainingDaysValue <= 0) {
                statusIndicatorElem.innerHTML = `<div class="text-center text-danger"><i class="bi bi-exclamation-triangle"></i> 已过期</div>`;
            } else if (remainingDaysValue <= reminderDaysValue) {
                statusIndicatorElem.innerHTML = `<div class="text-center text-warning"><i class="bi bi-exclamation-triangle"></i> 临期</div>`;
            } else {
                statusIndicatorElem.innerHTML = `<div class="text-center text-success"><i class="bi bi-check-circle"></i> 正常</div>`;
            }
        }
        
        // 生产日期选择后，重置并启动自动保存计时器（只有这里有生产日期变更）
        cancelAutoSaveTimer();
        startAutoSaveTimer();
        
    } catch(e) { 
        console.error('日期计算错误:', e); 
        clearResults(); 
    }
}

async function saveProductRecord(isManual = true) {
    const skuInputElem = document.getElementById('skuInput');
    const productionDateElem = document.getElementById('productionDate');
    const productNameElem = document.getElementById('productName');
    const shelfLifeElem = document.getElementById('shelfLife');
    const reminderDaysElem = document.getElementById('reminderDays');
    
    const sku = skuInputElem?.value.trim();
    const prodDate = productionDateElem?.value;
    if (!sku || sku.length !== 5) { if (isManual) showAlert('请输入有效的5位SKU编码', 'warning'); return; }
    if (!prodDate) { if (isManual) showAlert('请选择生产日期', 'warning'); return; }
    const prodDateObj = createBJDate(prodDate);
    const today = getBJToday();
    if (prodDateObj > today) { if (isManual) showAlert('生产日期不能是未来日期', 'warning'); return; }
    if (!productNameElem?.value) { if (isManual) showAlert('请先查询商品信息', 'warning'); return; }
    
    try {
        const records = await apiRequest(`/api/records/by-sku/${sku}`);
        const duplicate = records.find(r => r.production_date === prodDate);
        if (duplicate) {
            duplicateCheckResult = duplicate;
            const duplicateBody = document.getElementById('duplicateBody');
            if (duplicateBody) duplicateBody.innerHTML = `<div class="alert alert-warning"><h5>发现重复记录</h5><p>相同SKU和生产日期的商品已存在</p><ul><li><strong>商品：</strong>${duplicate.name}</li><li><strong>SKU：</strong>${duplicate.sku}</li><li><strong>生产日期：</strong>${duplicate.production_date}</li></ul><p class="text-danger">是否继续添加？</p></div>`;
            if (window.duplicateModal) window.duplicateModal.show();
            return;
        }
        const loc = await getProductLocation(sku);
        const record = { 
            sku, 
            name: productNameElem.value, 
            production_date: prodDate, 
            shelf_life: parseInt(shelfLifeElem.value), 
            reminder_days: parseInt(reminderDaysElem.value), 
            location: loc || '默认位置' 
        };
        await apiRequest('/api/records', 'POST', record);
        showQuickToast('商品已成功保存', 'success');
        dataCache.clear();
        if (skuInputElem) skuInputElem.value = '';
        clearForm();
        if (skuInputElem) skuInputElem.focus();
        await renderExpiringTable(true);
        await renderAllTable(true);
    } catch (error) { 
        if (isManual) showAlert(`保存失败: ${error.message}`, 'danger'); 
    }
}

// ========== 主初始化函数 ==========
async function initMainApp() 
{
    if (appInitialized) return;
    appInitialized = true;
    
    // 初始化模态框
    const confirmModalElem = document.getElementById('confirmModal');
    const duplicateModalElem = document.getElementById('duplicateModal');
    const scannerModalElem = document.getElementById('scannerModal');
    const imagePreviewModalElem = document.getElementById('imagePreviewModal');
    const resetPasswordModalElem = document.getElementById('resetPasswordModal');
    const validityModalElem = document.getElementById('validityModal');
    const editCodeModalElem = document.getElementById('editCodeModal');
    const changePwdModalElem = document.getElementById('changePwdModal');
    const verifyPasswordModalElem = document.getElementById('verifyPasswordModal');
    const toggleBtn = document.getElementById('lowDataToggle');
    if (toggleBtn) {
        if (lowDataMode) {
            toggleBtn.innerHTML = '<i class="bi bi-image"></i>';
        } else {
            toggleBtn.innerHTML = '<i class="bi bi-images"></i>';
        }
    }
    // 新增：初始化图片上传
    setupImageUpload();
    
    // 新增：绑定扫码按钮
    bindScanButtons();
    
    // 新增：初始化后悔药响应式
    window.addEventListener('resize', () => {
        renderRegretTable(true);
    });
    
    if (confirmModalElem && window.bootstrap) {
        window.confirmModal = new window.bootstrap.Modal(confirmModalElem);
        confirmModalElem.addEventListener('hidden.bs.modal', cleanupModalBackdrops);
    }
    if (duplicateModalElem && window.bootstrap) window.duplicateModal = new window.bootstrap.Modal(duplicateModalElem);
    if (scannerModalElem && window.bootstrap) window.scannerModal = new window.bootstrap.Modal(scannerModalElem);
    if (imagePreviewModalElem && window.bootstrap) window.imagePreviewModal = new window.bootstrap.Modal(imagePreviewModalElem);
    if (resetPasswordModalElem && window.bootstrap) window.resetPasswordModal = new window.bootstrap.Modal(resetPasswordModalElem);
    if (validityModalElem && window.bootstrap) window.validityModal = new window.bootstrap.Modal(validityModalElem);
    if (editCodeModalElem && window.bootstrap) window.editCodeModal = new window.bootstrap.Modal(editCodeModalElem);
    if (changePwdModalElem && window.bootstrap) window.changePwdModal = new window.bootstrap.Modal(changePwdModalElem);
    if (verifyPasswordModalElem && window.bootstrap) window.verifyPasswordModal = new window.bootstrap.Modal(verifyPasswordModalElem);
    
    const today = getBJToday();
    const minDate = new Date(today);
    minDate.setUTCFullYear(today.getUTCFullYear() - 2);
    const productionDateElem = document.getElementById('productionDate');
    if (productionDateElem) {
        productionDateElem.min = formatDateLocal(minDate);
        productionDateElem.max = formatDateLocal(today);
    }
    
    initBottomNav();
    initLowDataMode();
    initTouchFeedback();
    initCategoryFilter();
    initSwipeToDelete();
    showTimezoneInfo();
    
    showQuickToast('系统已就绪', 'info');
    
    try {
            await renderExpiringTable(false);
            await renderAllTable(false);
            await renderProductDatabaseTable();
            if (currentUserRole === 'admin') 
                { 
                    await loadUsers(); 
                    await loadAuthCodes(); 
                    await loadLogs(); 
                }
            updateExpiringBadge();

        } 
            catch (error) 
                { 
                    console.error('初始化错误:', error); 
                }
    
    setTimeout(() => {
        const skuInputElem = document.getElementById('skuInput');
        if (skuInputElem) skuInputElem.focus();
    }, 100);
    startAuthChecker();

    // 控制普通用户的界面元素
    // ========== 权限控制 ==========
    if (currentUserRole !== 'admin') {
        // 普通用户：保留管理入口，但限制内容（只显示导入导出）
        const adminNavItem = document.querySelector('.bottom-nav .nav-item[data-tab="admin"]');
        if (adminNavItem) adminNavItem.style.display = 'flex';
        
        // 隐藏管理员专属的标签页按钮（除了导入导出）
        const adminTabs = document.querySelectorAll('[data-admin-tab]');
        adminTabs.forEach(tab => {
            const tabName = tab.getAttribute('data-admin-tab');
            if (tabName !== 'import-export') {
                tab.style.display = 'none';
            }
        });
        
        // 隐藏非导入导出的面板
        const adminPanels = document.querySelectorAll('.admin-panel');
        adminPanels.forEach(panel => {
            if (panel.id !== 'admin-import-export') {
                panel.style.display = 'none';
            } else {
                panel.style.display = 'block';
            }
        });
    }
    
}
// 绑定全局函数
window.confirmDuplicate = function() { 
    if (window.duplicateModal) window.duplicateModal.hide();
    if (duplicateCheckResult) {
        const record = { ...duplicateCheckResult };
        apiRequest('/api/records', 'POST', record).then(async () => {
            showQuickToast('商品已保存', 'success');
            dataCache.clear();
            const skuInputElem = document.getElementById('skuInput');
            if (skuInputElem) skuInputElem.value = '';
            clearForm();
            if (skuInputElem) skuInputElem.focus();
            await renderExpiringTable(true);
            await renderAllTable(true);
        }).catch(e => showAlert(`保存失败: ${e.message}`, 'danger'));
    }
    duplicateCheckResult = null;
};

window.cancelDuplicate = function() { 
    if (window.duplicateModal) window.duplicateModal.hide(); 
    duplicateCheckResult = null; 
};

window.showResetPasswordModal = function(userId, username) {
    const resetUserId = document.getElementById('resetUserId');
    const resetNewPassword = document.getElementById('resetNewPassword');
    const resetConfirmPassword = document.getElementById('resetConfirmPassword');
    if (resetUserId) resetUserId.value = userId;
    if (resetNewPassword) resetNewPassword.value = '';
    if (resetConfirmPassword) resetConfirmPassword.value = '';
    if (window.resetPasswordModal) window.resetPasswordModal.show();
};

window.showValidityModal = function(userId, currentValidUntil) {
    const validityUserId = document.getElementById('validityUserId');
    const validityDate = document.getElementById('validityDate');
    if (validityUserId) validityUserId.value = userId;
    const defaultDate = currentValidUntil || (() => { let d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString().split('T')[0]; })();
    if (validityDate) validityDate.value = defaultDate;
    if (window.validityModal) window.validityModal.show();
};

window.editAuthCode = function(codeId, validUntil) {
    const editCodeId = document.getElementById('editCodeId');
    const editCodeValidUntil = document.getElementById('editCodeValidUntil');
    const editCodeStatus = document.getElementById('editCodeStatus');
    if (editCodeId) editCodeId.value = codeId;
    if (editCodeValidUntil) editCodeValidUntil.value = validUntil;
    if (editCodeStatus) editCodeStatus.value = 'active';
    if (window.editCodeModal) window.editCodeModal.show();
};

window.deleteUser = async function(userId, username) {
    if (confirm(`确定要删除用户 "${username}" 吗？此操作不可恢复！`)) {
        try {
            await apiRequest(`/api/admin/users/${userId}`, 'DELETE');
            showAlert(`用户 ${username} 已删除`, 'success');
            await loadUsers();
        } catch (error) { 
            showAlert(`删除失败: ${error.message}`, 'danger'); 
        }
    }
};

window.copyToClipboard = function(text) {
    navigator.clipboard.writeText(text).then(() => {
        showQuickToast('已复制到剪贴板', 'success');
    }).catch(() => {
        showAlert('复制失败', 'danger');
    });
};

window.showImagePreview = function(imageUrl) {
    const previewImage = document.getElementById('previewImage');
    if (previewImage) previewImage.src = imageUrl;
    if (window.imagePreviewModal) window.imagePreviewModal.show();
};

// DOMContentLoaded 事件绑定
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOMContentLoaded - 初始化应用');
    
     // ========== 新增：同步无图模式图标 ==========
    const lowDataMode = localStorage.getItem(STORAGE_KEYS.LOW_DATA_MODE) === 'true';
    const toggleBtn = document.getElementById('lowDataToggle');
    if (toggleBtn) {
        if (lowDataMode) {
            toggleBtn.innerHTML = '<i class="bi bi-image"></i>';
        } else {
            toggleBtn.innerHTML = '<i class="bi bi-images"></i>';
        }
    }
    // ========== 新增结束 ==========

    // 绑定登录按钮
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) {
        const newLoginBtn = loginBtn.cloneNode(true);
        loginBtn.parentNode.replaceChild(newLoginBtn, loginBtn);
        newLoginBtn.addEventListener('click', function(e) {
            e.preventDefault();
            login();
        });
    }
    
    // 绑定注册按钮
    const registerBtn = document.getElementById('registerBtn');
    if (registerBtn) {
        const newRegisterBtn = registerBtn.cloneNode(true);
        registerBtn.parentNode.replaceChild(newRegisterBtn, registerBtn);
        newRegisterBtn.addEventListener('click', function(e) {
            e.preventDefault();
            register();
        });
    }
    
    
    // 绑定登出按钮
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        const newLogoutBtn = logoutBtn.cloneNode(true);
        logoutBtn.parentNode.replaceChild(newLogoutBtn, logoutBtn);
        newLogoutBtn.addEventListener('click', function(e) {
            e.preventDefault();
            logout();
        });
    }
    
    // 绑定SKU输入查询
    const skuInput = document.getElementById('skuInput');
    if (skuInput) {
        skuInput.addEventListener('input', debounce(lookupProductWithExistingDates, 500));
    }
    
    // 绑定生产日期变化
    const productionDate = document.getElementById('productionDate');
    if (productionDate) {
        productionDate.addEventListener('change', calculateDates);
    }
    
    // 绑定保存按钮
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => saveProductRecord(true));
    }
    
    // 绑定查询按钮
    const searchBtn = document.getElementById('searchBtn');
    if (searchBtn) {
        searchBtn.addEventListener('click', searchProduct);
    }
    
    // 绑定添加商品按钮
    const addProductBtn = document.getElementById('addProductBtn');
    if (addProductBtn) {
        addProductBtn.addEventListener('click', addNewProduct);
    }
    
    // 绑定更新商品按钮
    const updateProductBtn = document.getElementById('updateProductBtn');
    if (updateProductBtn) {
        updateProductBtn.addEventListener('click', updateProduct);
    }
    
    // ========== 管理员面板按钮绑定 ==========
    
    // 绑定管理员标签页切换
    const adminTabs = document.querySelectorAll('[data-admin-tab]');
    adminTabs.forEach(tab => {
        tab.addEventListener('click', function() {
            const tabName = this.getAttribute('data-admin-tab');
            document.querySelectorAll('.admin-panel').forEach(panel => {
                panel.style.display = 'none';
            });
            const targetPanel = document.getElementById(`admin-${tabName}`);
            if (targetPanel) targetPanel.style.display = 'block';
            adminTabs.forEach(t => t.classList.remove('active'));
            this.classList.add('active');
        });
    });
    
    // 绑定刷新用户按钮
    const refreshUsersBtn = document.getElementById('refreshUsersBtn');
    if (refreshUsersBtn) {
        refreshUsersBtn.addEventListener('click', () => loadUsers());
    }
    
    // 绑定刷新授权码按钮
    const refreshCodesBtn = document.getElementById('refreshCodesBtn');
    if (refreshCodesBtn) {
        refreshCodesBtn.addEventListener('click', () => loadAuthCodes());
    }
    
    // 绑定刷新日志按钮
    const refreshLogsBtn = document.getElementById('refreshLogsBtn');
    if (refreshLogsBtn) {
        refreshLogsBtn.addEventListener('click', () => loadLogs());
    }
    
    // 绑定生成授权码按钮
    const generateCodeBtn = document.getElementById('generateCodeBtn');
    if (generateCodeBtn) {
        generateCodeBtn.addEventListener('click', () => generateAuthCode());
    }
    
    // 绑定导出数据按钮（管理员）
    const exportDataBtn = document.getElementById('exportDataBtn');
    if (exportDataBtn) {
        exportDataBtn.addEventListener('click', () => exportData());
    }
    
    // 绑定导入数据按钮（管理员）
    const importDataBtn = document.getElementById('importDataBtn');
    if (importDataBtn) {
        importDataBtn.addEventListener('click', () => importData());
    }
    
    // 绑定导出用户数据按钮
    const exportUserDataBtn = document.getElementById('exportUserDataBtn');
    if (exportUserDataBtn) {
        exportUserDataBtn.addEventListener('click', () => exportUserData());
    }
    
    // 绑定导入用户数据按钮
    const importUserDataBtn = document.getElementById('importUserDataBtn');
    if (importUserDataBtn) {
        importUserDataBtn.addEventListener('click', () => importUserData());
    }
    
    // 绑定清空用户数据按钮
    const resetUserDataBtn = document.getElementById('resetUserDataBtn');
    if (resetUserDataBtn) {
        resetUserDataBtn.addEventListener('click', () => showVerifyPasswordForReset());
    }
    
    // 绑定修改密码按钮
    const changePwdBtn = document.getElementById('changePwdBtn');
    if (changePwdBtn) {
        changePwdBtn.addEventListener('click', () => showChangePasswordModal());
    }
    
    // 绑定确认修改密码按钮
    const confirmChangePwdBtn = document.getElementById('confirmChangePwdBtn');
    if (confirmChangePwdBtn) {
        confirmChangePwdBtn.addEventListener('click', () => changePassword());
    }
    
    // 绑定确认清空数据按钮
    const confirmVerifyResetBtn = document.getElementById('confirmVerifyResetBtn');
    if (confirmVerifyResetBtn) {
        confirmVerifyResetBtn.addEventListener('click', () => verifyAndResetData());
    }
    
    // 绑定后悔药清空全部按钮
    const clearAllRegretBtn = document.getElementById('clearAllRegretBtn');
    if (clearAllRegretBtn) {
        clearAllRegretBtn.addEventListener('click', async () => {
            if (confirm('确定要清空所有已删除记录吗？此操作不可恢复！')) {
                try {
                    await apiRequest('/api/deleted-records', 'DELETE');
                    showQuickToast('已清空所有删除记录', 'success');
                    await renderRegretTable(true);
                } catch (error) {
                    showAlert(`清空失败: ${error.message}`, 'danger');
                }
            }
        });
    }
    
    // 绑定刷新后悔药按钮
    const refreshRegretBtn = document.getElementById('refreshRegretBtn');
    if (refreshRegretBtn) {
        refreshRegretBtn.addEventListener('click', () => renderRegretTable(true));
    }
    
    // 加载保存的用户名
    loadSavedUsername();
    
    // 检查登录状态
    checkAuth(true);
});

// ========== 用户数据导出导入函数 ==========
async function exportUserData() {
    try {
        showAlert('正在导出数据...', 'info');
        const response = await fetch(`${API_BASE_URL}/api/export`, { 
            credentials: 'include',
            headers: { 'Cache-Control': 'no-cache' }
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '导出失败');
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mydata_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showAlert('数据导出成功', 'success');
    } catch (error) { 
        showAlert(`导出失败: ${error.message}`, 'danger'); 
    }
}

function importUserData() {
    const fileInput = document.getElementById('importUserFileInput');
    if (fileInput) fileInput.click();
    if (fileInput) {
        // 移除旧事件，防止重复绑定
        const newFileInput = fileInput.cloneNode(true);
        fileInput.parentNode.replaceChild(newFileInput, fileInput);
        
        newFileInput.onchange = async function(e) {
            const file = e.target.files[0];
            if (!file) return;
            showAlert('正在导入数据...', 'info');
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const result = await apiRequest('/api/import', 'POST', data);
                showAlert(`导入成功: 商品新增${result.results.productsAdded}个，更新${result.results.productsUpdated}个，库存新增${result.results.recordsAdded}条`, 'success');
                dataCache.clear();
                await renderProductDatabaseTable(true);
                await renderAllTable(true);
                await renderExpiringTable(true);
            } catch (error) { 
                showAlert(`导入失败: ${error.message}`, 'danger'); 
            }
            newFileInput.value = '';
        };
    }
}

// ========== 修改密码函数 ==========
async function changePassword() {
    const oldPassword = document.getElementById('oldPassword')?.value;
    const newPassword = document.getElementById('newPassword')?.value;
    const confirmNewPassword = document.getElementById('confirmNewPassword')?.value;
    
    if (!oldPassword || !newPassword) { 
        showAlert('请填写完整信息', 'warning'); 
        return; 
    }
    if (newPassword.length < 6) { 
        showAlert('新密码长度至少6位', 'warning'); 
        return; 
    }
    if (newPassword !== confirmNewPassword) { 
        showAlert('两次输入的新密码不一致', 'warning'); 
        return; 
    }
    
    try {
        await apiRequest('/api/user/change-password', 'POST', { oldPassword, newPassword });
        showAlert('密码修改成功，请重新登录', 'success');
        if (window.changePwdModal) window.changePwdModal.hide();
        setTimeout(() => logout(), 2000);
    } catch (error) { 
        showAlert(`修改失败: ${error.message}`, 'danger'); 
    }
}

// ========== 清空数据验证函数 ==========
function showVerifyPasswordForReset() {
    const passwordInput = document.getElementById('verifyPassword');
    if (passwordInput) passwordInput.value = '';
    if (window.verifyPasswordModal) window.verifyPasswordModal.show();
}

async function verifyAndResetData() {
    const password = document.getElementById('verifyPassword')?.value;
    if (!password) { 
        showAlert('请输入登录密码', 'warning'); 
        return; 
    }
    
    const confirmBtn = document.getElementById('confirmVerifyResetBtn');
    const originalText = confirmBtn?.innerHTML;
    if (confirmBtn) { 
        confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 验证中...'; 
        confirmBtn.disabled = true; 
    }
    
    try {
        const result = await apiRequest('/api/user/verify-password', 'POST', { password });
        if (result.valid) { 
            if (window.verifyPasswordModal) window.verifyPasswordModal.hide(); 
            await executeResetData(); 
        } else { 
            showAlert('密码错误，无法执行清空操作', 'danger'); 
        }
    } catch (error) { 
        showAlert(`验证失败: ${error.message}`, 'danger'); 
    } finally { 
        if (confirmBtn) { 
            confirmBtn.innerHTML = originalText; 
            confirmBtn.disabled = false; 
        } 
        const passwordInput = document.getElementById('verifyPassword'); 
        if (passwordInput) passwordInput.value = ''; 
    }
}

async function executeResetData() {
    try {
        showAlert('正在清空数据...', 'info');
        const result = await apiRequest('/api/reset', 'POST');
        showAlert(result.message || '数据已清空', 'success');
        dataCache.clear();
        await renderProductDatabaseTable(true);
        await renderAllTable(true);
        await renderExpiringTable(true);
        
        // 清空表单
        const newSkuElem = document.getElementById('newSku');
        const newNameElem = document.getElementById('newName');
        const newShelfLifeElem = document.getElementById('newShelfLife');
        const newReminderDaysElem = document.getElementById('newReminderDays');
        const newLocationElem = document.getElementById('newLocation');
        const searchSkuElem = document.getElementById('searchSku');
        
        if (newSkuElem) newSkuElem.value = '';
        if (newNameElem) newNameElem.value = '';
        if (newShelfLifeElem) newShelfLifeElem.value = '';
        if (newReminderDaysElem) newReminderDaysElem.value = '';
        if (newLocationElem) newLocationElem.value = '';
        if (searchSkuElem) searchSkuElem.value = '';
    } catch (error) { 
        showAlert(`清空失败: ${error.message}`, 'danger'); 
    }
}

function showChangePasswordModal() {
    const oldPassword = document.getElementById('oldPassword');
    const newPassword = document.getElementById('newPassword');
    const confirmNewPassword = document.getElementById('confirmNewPassword');
    if (oldPassword) oldPassword.value = '';
    if (newPassword) newPassword.value = '';
    if (confirmNewPassword) confirmNewPassword.value = '';
    if (window.changePwdModal) window.changePwdModal.show();
}

// 暴露全局函数
window.login = login;
window.register = register;
window.logout = logout;
window.generateAuthCode = generateAuthCode;
window.confirmResetPassword = confirmResetPassword;
window.confirmValidity = confirmValidity;
window.confirmEditCode = confirmEditCode;
window.exportData = exportData;
window.importData = importData;
window.showChangePasswordModal = function() {
    if (window.changePwdModal) window.changePwdModal.show();
};

