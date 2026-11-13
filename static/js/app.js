'use strict';

// ==================== UTILITIES ====================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// localStorage используется только для удобств конкретного браузера
// (тема до входа, курсы, выбранная валюта). Данные — на сервере.
const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

const moneyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
function formatMoney(n, currency = '₽') {
    return moneyFmt.format(Math.round((Number(n) || 0) * 100) / 100) + ' ' + currency;
}

const _lastAnimated = {};
function animateValue(el, id, to, currency) {
    const from = _lastAnimated[id] ?? 0;
    _lastAnimated[id] = to;
    if (from === to) { el.textContent = formatMoney(to, currency); return; }
    const duration = 450;
    const start = performance.now();
    function frame(now) {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = formatMoney(from + (to - from) * eased, currency);
        if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

function formatDate(d) {
    return new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function localISODate(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Экранирование HTML — защита от XSS при выводе пользовательских данных
function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// ==================== API ====================
class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: { 'X-Requested-With': 'akysaya', 'Accept': 'application/json' }, credentials: 'same-origin' };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    let res;
    try {
        res = await fetch(path, opts);
    } catch (e) {
        throw new ApiError('Нет связи с сервером. Проверьте, что приложение запущено.', 0);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) {
        if (res.status === 401 && state.user && !path.startsWith('/api/login')) {
            state.user = null;
            router.navigate('login');
        }
        throw new ApiError(data?.error || `Ошибка сервера (${res.status})`, res.status);
    }
    return data;
}

// Блокирует кнопку отправки, пока идёт запрос — защита от двойных кликов.
async function withBusy(form, fn) {
    const btn = form?.querySelector('button[type="submit"]');
    if (btn?.getAttribute('aria-busy') === 'true') return;
    btn?.setAttribute('aria-busy', 'true');
    try { return await fn(); }
    finally { btn?.removeAttribute('aria-busy'); }
}

const DEFAULT_SETTINGS = { salary: 0, rent_expense: 0, salary_day: 1, rent_day: 1, email: '', financial_goal: 5000 };

const state = {
    user: null,
    settings: { ...DEFAULT_SETTINGS },
    totals: { income: 0, expenses: 0, balance: 0 },
    categories: [],
    categoryMap: {
        income: ['Зарплата', 'Фриланс', 'Подарки', 'Другое'],
        expense: ['Еда', 'Транспорт', 'Развлечения', 'Одежда', 'Жилье', 'Подарки', 'Другое'],
    },
};

// ==================== TOAST ====================
const toast = {
    show(msg, type = 'info') {
        const container = $('#toastContainer');
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        const icons = { success: '✓', error: '✕', info: 'ℹ' };
        const icon = document.createElement('span');
        icon.textContent = icons[type] || 'ℹ';
        const text = document.createElement('span');
        text.textContent = msg;
        el.append(icon, text);
        container.appendChild(el);
        setTimeout(() => {
            el.style.animation = 'toastOut 200ms ease-out forwards';
            setTimeout(() => el.remove(), 200);
        }, 3000);
    }
};

// ==================== CONFETTI ====================
const confetti = {
    canvas: null,
    ctx: null,
    particles: [],
    running: false,
    stopTimer: null,
    init() {
        this.canvas = $('#confetti-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.resize();
        window.addEventListener('resize', () => this.resize());
    },
    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    },
    celebrate(message) {
        if (message) toast.show(message, 'success');
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const colors = ['#9281f7', '#3b9eff', '#3ad389', '#ff9592', '#ffca16', '#baa7ff'];
        for (let i = 0; i < 100; i++) {
            this.particles.push({
                x: Math.random() * this.canvas.width,
                y: -10,
                vx: (Math.random() - 0.5) * 4,
                vy: Math.random() * 3 + 2,
                size: Math.random() * 4 + 2,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rotSpeed: (Math.random() - 0.5) * 10,
                opacity: 1,
            });
        }
        if (!this.running) {
            this.running = true;
            requestAnimationFrame(() => this.animate());
        }
        clearTimeout(this.stopTimer);
        this.stopTimer = setTimeout(() => {
            this.particles = [];
            this.running = false;
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }, 4000);
    },
    animate() {
        if (!this.running) return;
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        for (const p of this.particles) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.05;
            p.rotation += p.rotSpeed;
            p.opacity -= 0.003;
            if (p.opacity <= 0) continue;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rotation * Math.PI) / 180);
            ctx.globalAlpha = p.opacity;
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
            ctx.restore();
        }
        this.particles = this.particles.filter(p => p.opacity > 0 && p.y < this.canvas.height + 20);
        if (this.particles.length > 0) requestAnimationFrame(() => this.animate());
        else this.running = false;
    }
};

// ==================== THEMING ====================
// Тема хранится в localStorage (применяется ещё до отрисовки — см. theme-boot.js)
// и в аккаунте на сервере, поэтому не сбрасывается ни при обновлении, ни на другом устройстве.
const theming = {
    KEY: 'akysaya_theme',
    DEFAULT: { bgUrl: '', overlay: 0.55, accent: 'violet' },
    ACCENTS: ['violet', 'blue', 'green', 'amber', 'crimson'],
    get() {
        return { ...this.DEFAULT, ...LS.get(this.KEY, {}) };
    },
    apply(t) {
        const body = document.body;
        body.setAttribute('data-accent', this.ACCENTS.includes(t.accent) ? t.accent : 'violet');
        body.style.setProperty('--bg-overlay-opacity', t.overlay ?? 0.55);
        if (t.bgUrl && /^https:\/\//i.test(t.bgUrl)) {
            body.style.backgroundImage = `url("${t.bgUrl.replace(/["\\\n\r]/g, encodeURIComponent)}")`;
            body.classList.add('custom-bg-active');
        } else {
            body.style.backgroundImage = '';
            body.classList.remove('custom-bg-active');
        }
    },
    // Тема из аккаунта важнее локальной: так она «приезжает» на новое устройство.
    adoptServerTheme(theme) {
        if (!theme) return;
        LS.set(this.KEY, theme);
        this.apply(this.get());
    },
    async save(form) {
        const accentInput = form.querySelector('input[name="accent"]:checked');
        const t = {
            bgUrl: ($('#themeBgUrl').value || '').trim(),
            overlay: parseInt($('#themeOverlay').value, 10) / 100,
            accent: accentInput ? accentInput.value : 'violet',
        };
        if (t.bgUrl && !/^https:\/\//i.test(t.bgUrl)) {
            toast.show('Ссылка должна начинаться с https://', 'error');
            return;
        }
        LS.set(this.KEY, t);
        this.apply(t);
        if (state.user) {
            try { await api('/api/theme', { method: 'PUT', body: t }); }
            catch (e) { toast.show('Тема применена, но не сохранена в аккаунте: ' + e.message, 'error'); return; }
        }
        toast.show('Тема применена и сохранена!', 'success');
    },
    async resetUI() {
        LS.del(this.KEY);
        this.apply(this.DEFAULT);
        this.loadIntoForm();
        if (state.user) {
            try { await api('/api/theme', { method: 'PUT', body: { reset: true } }); } catch (e) { /* локально уже сброшено */ }
        }
        toast.show('Тема сброшена по умолчанию.', 'info');
    },
    loadIntoForm() {
        const t = this.get();
        $('#themeBgUrl').value = t.bgUrl || '';
        const pct = Math.round((t.overlay ?? 0.55) * 100);
        $('#themeOverlay').value = pct;
        $('#overlayVal').textContent = pct + '%';
        const accentInput = document.querySelector(`input[name="accent"][value="${this.ACCENTS.includes(t.accent) ? t.accent : 'violet'}"]`);
        if (accentInput) accentInput.checked = true;
    }
};

// ==================== DATA BACKUP (export/import) ====================
const backup = {
    async export() {
        try {
            const data = await api('/api/export');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `akysaya-backup-${localISODate()}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast.show('Резервная копия скачана.', 'success');
        } catch (e) {
            toast.show(e.message, 'error');
        }
    },
    import(e) {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { toast.show('Файл слишком большой (максимум 5 МБ).', 'error'); return; }
        const reader = new FileReader();
        reader.onload = async () => {
            let data;
            try { data = JSON.parse(reader.result); }
            catch (err) { toast.show('Не удалось прочитать файл резервной копии.', 'error'); return; }
            try {
                const res = await api('/api/import', { method: 'POST', body: data });
                const me = await api('/api/me');
                if (me.user) {
                    state.settings = { ...DEFAULT_SETTINGS, ...me.settings };
                    theming.adoptServerTheme(me.theme);
                    settings.init();
                }
                toast.show(`Восстановлено операций: ${res.imported}` + (res.skipped ? `, пропущено: ${res.skipped}` : ''), 'success');
            } catch (err) {
                toast.show(err.message, 'error');
            }
        };
        reader.readAsText(file);
    }
};

// ==================== ROUTER ====================
const PROTECTED = ['dashboard', 'history', 'add', 'settings'];
const router = {
    routes: ['welcome', 'login', 'register', 'dashboard', 'history', 'add', 'settings', 'privacy', 'terms'],
    current: null,
    resolve(page) {
        if (!this.routes.includes(page)) page = state.user ? 'dashboard' : 'welcome';
        if (PROTECTED.includes(page) && !state.user) return 'login';
        if (['login', 'register', 'welcome'].includes(page) && state.user) return 'dashboard';
        return page;
    },
    // Переход через hash — работает кнопка «Назад» в браузере.
    navigate(page) {
        page = this.resolve(page);
        if (location.hash.slice(1) !== page) location.hash = page;
        else this.render(page);
    },
    render(page) {
        page = this.resolve(page);
        if (location.hash.slice(1) !== page) history.replaceState(null, '', '#' + page);

        if (this.current !== page) {
            $$('.page').forEach(p => p.classList.remove('active'));
            const target = $(`#page-${page}`);
            if (target) target.classList.add('active');
            window.scrollTo(0, 0);
            this.current = page;
        }
        this.updateNavbar(page);

        if (page === 'dashboard') dashboard.init();
        if (page === 'history') historyPage.init();
        if (page === 'settings') settings.init();
        if (page === 'add') transactions.initForm();
        if (page === 'login') auth.initCaptcha('login');
        if (page === 'register') auth.initCaptcha('register');
    },
    updateNavbar(page) {
        const navLinks = $('#navLinks');
        const user = state.user;
        if (!user) {
            navLinks.innerHTML = `
                <button class="nav-link" data-nav="login">Вход</button>
                <button class="nav-link btn btn-sm btn-primary" data-nav="register">Регистрация</button>
            `;
            return;
        }
        const link = (p, label) => `<button class="nav-link" data-nav="${p}"${p === page ? ' aria-current="page" style="color:var(--color-white);background:rgba(255,255,255,0.04);"' : ''}>${label}</button>`;
        navLinks.innerHTML = `
            ${link('dashboard', 'Дашборд')}
            ${link('history', 'История')}
            ${link('settings', 'Настройки')}
            <span class="nav-link mono text-violet" style="cursor:default;">${esc(user.username)}</span>
            <button class="nav-link btn btn-sm" data-action="logout">Выйти</button>
        `;
    }
};

// ==================== AUTH ====================
const auth = {
    async initCaptcha(type, focus = false) {
        // id в разметке: loginCaptcha* и regCaptcha*
        const prefix = type === 'register' ? 'reg' : 'login';
        const img = $(`#${prefix}CaptchaImg`);
        const input = $(`#${prefix}Captcha`);
        input.value = '';
        img.setAttribute('aria-busy', 'true');
        try {
            const data = await api(`/api/captcha/${type}`);
            if (typeof data.image === 'string' && data.image.startsWith('data:image/png;base64,')) img.src = data.image;
            img.alt = 'Код проверки: 5 латинских букв и цифр';
        } catch (e) {
            img.removeAttribute('src');
            img.alt = 'Не удалось загрузить код. Нажмите ↻.';
            toast.show(e.message, 'error');
        } finally {
            img.removeAttribute('aria-busy');
        }
        if (focus) input.focus();
    },
    togglePassword(id, btn) {
        const input = $(`#${id}`);
        input.type = input.type === 'password' ? 'text' : 'password';
        btn.textContent = input.type === 'password' ? '👁' : '🙈';
        btn.setAttribute('aria-label', input.type === 'password' ? 'Показать' : 'Скрыть');
    },
    checkPasswordStrength(pw) {
        let strength = 0;
        const hasUpper = /[A-ZА-ЯЁ]/.test(pw);
        const hasDigit = /\d/.test(pw);
        if (pw.length >= 8) strength += 33;
        if (hasUpper) strength += 33;
        if (hasDigit) strength += 34;

        const fill = $('#strengthFill');
        const text = $('#strengthText');
        fill.style.width = strength + '%';

        if (!pw) {
            text.textContent = '';
        } else if (strength < 50) {
            fill.className = 'strength-fill strength-weak';
            text.textContent = 'Слабый пароль';
            text.style.color = 'var(--color-alarm-red)';
        } else if (strength < 90) {
            fill.className = 'strength-fill strength-medium';
            text.textContent = 'Средний пароль';
            text.style.color = 'var(--color-amber)';
        } else {
            fill.className = 'strength-fill strength-strong';
            text.textContent = 'Надёжный пароль';
            text.style.color = 'var(--color-pulse-green)';
        }

        $('#ruleLength').className = pw.length >= 8 ? 'valid' : 'invalid';
        $('#ruleUpper').className = hasUpper ? 'valid' : 'invalid';
        $('#ruleNumber').className = hasDigit ? 'valid' : 'invalid';
    },
    checkPasswordMatch() {
        const pw = $('#regPassword').value;
        const cf = $('#regConfirm').value;
        const msg = $('#matchMessage');
        if (!cf) { msg.innerHTML = ''; return; }
        msg.innerHTML = pw === cf
            ? '<span class="text-green">✓ Пароли совпадают</span>'
            : '<span class="text-red">✕ Пароли не совпадают</span>';
    },
    clearUserState() {
        state.settings = { ...DEFAULT_SETTINGS };
        state.totals = { income: 0, expenses: 0, balance: 0 };
        state.categories = [];
    },
    async afterLogin(user, message) {
        this.clearUserState();
        state.user = user;
        await this.loadProfile();
        toast.show(message, 'success');
        router.navigate('dashboard');
    },
    async loadProfile() {
        const me = await api('/api/me');
        state.user = me.user;
        if (me.user) {
            state.settings = { ...DEFAULT_SETTINGS, ...me.settings };
            theming.adoptServerTheme(me.theme);
        }
        return me;
    },
    async login(form) {
        const fd = new FormData(form);
        const username = String(fd.get('username')).trim();
        try {
            const data = await api('/api/login', {
                method: 'POST',
                body: {
                    username, password: fd.get('password'), remember: !!fd.get('remember'),
                    captcha: $('#loginCaptcha').value.trim(), website: String(fd.get('website') || ''),
                },
            });
            if (fd.get('remember')) LS.set('akysaya_remember', username);
            else LS.del('akysaya_remember');
            form.querySelector('#loginPassword').value = '';
            await this.afterLogin(data.user, 'Вход выполнен успешно!');
        } catch (e) {
            toast.show(e.message, 'error');
            this.initCaptcha('login');
        }
    },
    async register(form) {
        const fd = new FormData(form);
        const username = String(fd.get('username')).trim();
        const password = String(fd.get('password'));
        const confirm = String(fd.get('confirm_password'));

        // Быстрая проверка в браузере; окончательная — на сервере.
        let problem = null;
        if (username.length < 3 || username.length > 32) problem = 'Имя пользователя должно быть от 3 до 32 символов.';
        else if (password.length < 8) problem = 'Пароль должен содержать минимум 8 символов.';
        else if (!/[A-ZА-ЯЁ]/.test(password)) problem = 'Пароль должен содержать хотя бы одну заглавную букву.';
        else if (!/\d/.test(password)) problem = 'Пароль должен содержать хотя бы одну цифру.';
        else if (password !== confirm) problem = 'Пароли не совпадают.';
        else if (!fd.get('accept_terms')) problem = 'Примите условия использования и политику конфиденциальности.';
        if (problem) { toast.show(problem, 'error'); return; }

        try {
            const data = await api('/api/register', {
                method: 'POST',
                body: {
                    username, password, confirm_password: confirm, captcha: $('#regCaptcha').value.trim(),
                    accept_terms: !!fd.get('accept_terms'), website: String(fd.get('website') || ''),
                },
            });
            form.reset();
            this.checkPasswordStrength('');
            $('#matchMessage').innerHTML = '';
            await this.afterLogin(data.user, 'Аккаунт создан! Укажите зарплату и расходы в настройках.');
        } catch (e) {
            toast.show(e.message, 'error');
            this.initCaptcha('register');
        }
    },
    async logout() {
        try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* всё равно выходим локально */ }
        state.user = null;
        this.clearUserState();
        toast.show('Вы вышли из аккаунта.', 'info');
        router.navigate('welcome');
    },
    async deleteAccount(form) {
        const password = form.querySelector('#deletePassword').value;
        if (!password) return;
        const ok = await confirmDialog.ask('Аккаунт, все операции и настройки будут удалены навсегда. Восстановить их будет нельзя.', 'Удалить аккаунт?');
        if (!ok) return;
        try {
            await api('/api/account', { method: 'DELETE', body: { password } });
        } catch (e) {
            toast.show(e.message, 'error');
            return;
        }
        form.reset();
        const id = state.user?.id;
        state.user = null;
        this.clearUserState();
        // Убираем следы аккаунта из этого браузера.
        LS.del('akysaya_remember');
        LS.del(theming.KEY);
        theming.apply(theming.DEFAULT);
        try {
            Object.keys(localStorage).filter(k => k.startsWith('achievement_') && k.endsWith(`_${id}`)).forEach(k => LS.del(k));
        } catch (e) { /* ignore */ }
        toast.show('Аккаунт удалён.', 'info');
        router.navigate('welcome');
    },
};

// ==================== CHART ====================
const expensesChart = {
    instance: null,
    COLORS: ['#9281f7', '#3b9eff', '#3ad389', '#ff9592', '#ffca16', '#baa7ff', '#70b8ff', '#ff6465', '#ffd60a'],
    render(entries) {
        const canvas = $('#expensesChart');
        if (typeof Chart === 'undefined') { canvas.style.display = 'none'; return; }
        const labels = entries.map(e => e[0]);
        const data = entries.map(e => e[1]);
        if (labels.length === 0) {
            if (this.instance) { this.instance.destroy(); this.instance = null; }
            canvas.style.display = 'none';
            return;
        }
        canvas.style.display = 'block';
        const colors = labels.map((_, i) => this.COLORS[i % this.COLORS.length]);

        // Обновляем существующий график вместо пересоздания — без мерцания, с плавной анимацией.
        if (this.instance) {
            this.instance.data.labels = labels;
            this.instance.data.datasets[0].data = data;
            this.instance.data.datasets[0].backgroundColor = colors;
            this.instance.update();
            return;
        }
        this.instance = new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels,
                datasets: [{ data, backgroundColor: colors, borderColor: '#000000', borderWidth: 2, hoverOffset: 12 }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: '#a1a4a5', font: { family: 'JetBrains Mono', size: 11 }, padding: 16, usePointStyle: true }
                    },
                    tooltip: {
                        backgroundColor: '#000000',
                        borderColor: '#292d30',
                        borderWidth: 1,
                        titleFont: { family: 'Inter', size: 13 },
                        bodyFont: { family: 'JetBrains Mono', size: 12 },
                        padding: 12,
                        callbacks: {
                            label: (c) => {
                                const total = c.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = total ? (c.raw / total * 100).toFixed(1) : 0;
                                return ` ${c.label}: ${formatMoney(c.raw)} (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }
};

// ==================== DASHBOARD ====================
const ACHIEVEMENTS = [10000, 50000, 100000, 500000, 1000000];
const dashboard = {
    currencyRates: { USD: 1, EUR: 0.93, GBP: 0.79, JPY: 150.25, CNY: 7.18, RUB: 92.50 },
    cryptoRates: { BTC: 45000, ETH: 2500, BNB: 320, XRP: 0.65, ADA: 0.48 },
    clockStarted: false,
    RATES_TTL_MS: 5 * 60 * 1000,
    async init() {
        this.startClock();
        // Мгновенно показываем то, что уже есть, затем подтягиваем свежие данные.
        this.renderAll();
        this.loadRatesFromCache();
        this.fetchRates();
        try {
            const data = await api('/api/dashboard');
            state.totals = data.totals;
            state.categories = data.categories;
            state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
            $('#lastUpdated').textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            if (router.current === 'dashboard') {
                this.renderAll();
                this.checkAchievements();
            }
        } catch (e) {
            if (e.status !== 401) toast.show(e.message, 'error');
        }
    },
    startClock() {
        this.updateDateTime();
        if (this.clockStarted) return;
        this.clockStarted = true;
        setInterval(() => { if (router.current === 'dashboard' && !document.hidden) this.updateDateTime(); }, 1000);
    },
    updateDateTime() {
        const now = new Date();
        $('#dashDate').textContent = now.toLocaleDateString('ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        $('#dashTime').textContent = now.toLocaleTimeString('ru-RU');
    },
    renderAll() {
        this.renderStats();
        expensesChart.render(state.categories);
    },
    renderStats() {
        const totals = state.totals;
        const goal = Number(state.settings.financial_goal) || 0;

        animateValue($('#statIncome'), 'income', totals.income);
        animateValue($('#statExpenses'), 'expenses', totals.expenses);
        animateValue($('#statBalance'), 'balance', totals.balance);
        $('#statGoal').textContent = formatMoney(goal);

        const progress = goal > 0 ? Math.max(0, Math.min((totals.balance / goal) * 100, 100)) : 0;
        $('#goalProgressBar').style.width = progress + '%';
        $('#goalProgressText').textContent = progress.toFixed(0) + '% выполнено';

        // Советы
        const advice = this.generateAdvice(totals.income, totals.expenses, state.categories);
        const adviceCard = $('#aiAdviceCard');
        if (advice.length > 0) {
            adviceCard.classList.remove('hidden');
            $('#aiAdviceList').innerHTML = advice.map(a => `
                <div class="flex items-start gap-8 mb-12" style="padding: 12px; border-radius: var(--radius-sm); background: rgba(255,255,255,0.02);">
                    <span class="status-dot ${a.type === 'warning' ? 'amber' : a.type === 'danger' ? 'red' : 'green'}" style="margin-top: 6px; flex-shrink: 0;"></span>
                    <span class="body-sm" style="color: var(--color-bone-white);">${esc(a.text)}</span>
                </div>
            `).join('');
        } else {
            adviceCard.classList.add('hidden');
        }

        // Траты по категориям — от больших сумм к меньшим (сортирует сервер)
        const catCard = $('#categoryDetailsCard');
        if (state.categories.length > 0) {
            catCard.classList.remove('hidden');
            const total = state.categories.reduce((a, [, v]) => a + v, 0);
            $('#categoryTableBody').innerHTML = state.categories.map(([cat, amount]) => `
                <tr>
                    <td><span class="text-violet mono">#</span> ${esc(cat)}</td>
                    <td class="text-right mono">${formatMoney(amount)} <span class="text-iron caption">${total ? Math.round(amount / total * 100) : 0}%</span></td>
                </tr>
            `).join('');
        } else {
            catCard.classList.add('hidden');
        }
    },
    generateAdvice(income, expenses, categories) {
        const advice = [];
        const s = state.settings;
        const totalSpent = categories.reduce((a, [, v]) => a + v, 0);

        if (categories.length > 0 && totalSpent > 0) {
            const [maxCat, maxVal] = categories[0];
            const pct = maxVal / totalSpent * 100;
            if (pct > 40) advice.push({ type: 'warning', text: `Больше всего вы тратите на ${maxCat} (${pct.toFixed(1)}%). Подумайте об оптимизации.` });
        }

        if (s.rent_expense > 0 && income > 0) {
            const rentPct = s.rent_expense / income * 100;
            if (rentPct > 40) advice.push({ type: 'danger', text: `Аренда составляет ${rentPct.toFixed(1)}% от доходов` });
            else if (rentPct > 30) advice.push({ type: 'warning', text: `Аренда ${rentPct.toFixed(1)}% от доходов` });
        }

        if (income > 0) {
            const savingsRate = (income - expenses) / income * 100;
            if (savingsRate < 10) advice.push({ type: 'warning', text: `Сберегайте больше! Сейчас откладываете ${savingsRate.toFixed(1)}%` });
            else advice.push({ type: 'success', text: `Отлично! Сберегаете ${savingsRate.toFixed(1)}% доходов` });
        } else if (s.salary > 0 && income === 0) {
            advice.push({ type: 'warning', text: `В этом месяце ещё нет доходов. Зарплата (${formatMoney(s.salary)}) ожидается ${s.salary_day}-го числа — добавьте её как операцию, когда получите.` });
        } else if (!s.salary && categories.length === 0) {
            advice.push({ type: 'success', text: 'Начните с настроек: укажите зарплату и аренду, затем добавьте первые операции — здесь появятся подсказки.' });
        }

        return advice.slice(0, 3);
    },
    loadRatesFromCache() {
        const cached = LS.get('akysaya_rates', null);
        if (cached?.currency) this.currencyRates = cached.currency;
        if (cached?.crypto) this.cryptoRates = cached.crypto;
        const base = LS.get('akysaya_base_currency', 'RUB');
        if ([...$('#baseCurrency').options].some(o => o.value === base)) $('#baseCurrency').value = base;
        this.updateCurrencyRates();
    },
    async fetchRates() {
        const cached = LS.get('akysaya_rates', null);
        if (cached && Date.now() - cached.ts < this.RATES_TTL_MS) return;
        try {
            const data = await api('/api/rates');
            this.currencyRates = data.currency;
            this.cryptoRates = data.crypto;
            if (data.live?.currency || data.live?.crypto) {
                LS.set('akysaya_rates', { ts: Date.now(), currency: data.currency, crypto: data.crypto });
            }
            this.updateCurrencyRates();
        } catch (e) { /* остаются значения из кэша или по умолчанию */ }
    },
    updateCurrencyRates() {
        LS.set('akysaya_base_currency', $('#baseCurrency').value);
        this.loadCurrencyRates();
        this.loadCryptoRates();
    },
    loadCurrencyRates() {
        const base = $('#baseCurrency').value;
        const baseRate = this.currencyRates[base] || 1;
        const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'RUB'];
        // Сколько единиц базовой валюты стоит 1 единица валюты из списка.
        $('#currencyRatesList').innerHTML = currencies.filter(c => c !== base).map(c => {
            const val = baseRate / (this.currencyRates[c] || 1);
            const decimals = val < 1 ? 4 : 2;
            return `
                <div class="currency-row">
                    <span class="currency-code">1 ${c}</span>
                    <span class="currency-value mono">${val.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${base}</span>
                </div>
            `;
        }).join('');
    },
    loadCryptoRates() {
        const cryptos = ['BTC', 'ETH', 'BNB', 'XRP', 'ADA'];
        $('#cryptoRatesList').innerHTML = cryptos.map(code => {
            const usd = this.cryptoRates[code] || 0;
            const digits = usd < 10 ? 2 : 0;
            return `
                <div class="currency-row">
                    <span class="currency-code">${code}</span>
                    <span class="currency-value mono">$${usd.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</span>
                </div>
            `;
        }).join('');
    },
    openGoalModal() {
        $('#goalInput').value = state.settings.financial_goal || 5000;
        modal.open('#goalModal', '#goalInput');
    },
    closeGoalModal() {
        modal.close('#goalModal');
    },
    async saveGoal(form) {
        const goal = parseFloat($('#goalInput').value);
        if (!(goal >= 0)) { toast.show('Введите цель — число от 0.', 'error'); return; }
        try {
            const data = await api('/api/goal', { method: 'PUT', body: { goal } });
            state.settings.financial_goal = data.goal;
            this.closeGoalModal();
            this.renderStats();
            toast.show('Цель сохранена!', 'success');
            this.checkAchievementsGoal(data.goal);
        } catch (e) {
            toast.show(e.message, 'error');
        }
    },
    // Флаги «уже праздновали» хранятся в браузере: это лишь анимация, не данные.
    checkAchievements() {
        for (const a of ACHIEVEMENTS) {
            if (state.totals.balance >= a) {
                const key = `achievement_${a}_${state.user.id}`;
                if (!LS.get(key)) {
                    LS.set(key, true);
                    confetti.celebrate(`🎉 Достигнута цель в ${a.toLocaleString('ru-RU')} ₽!`);
                }
            }
        }
    },
    checkAchievementsGoal(goal) {
        for (const a of ACHIEVEMENTS) {
            if (goal >= a) {
                const key = `achievement_goal_${a}_${state.user.id}`;
                if (!LS.get(key)) {
                    LS.set(key, true);
                    setTimeout(() => confetti.celebrate(`🎉 Цель установлена: ${a.toLocaleString('ru-RU')} ₽!`), 300);
                }
            }
        }
    }
};

// ==================== MODALS ====================
const modal = {
    lastFocus: null,
    open(sel, focusSel) {
        this.lastFocus = document.activeElement;
        $(sel).classList.add('open');
        setTimeout(() => (focusSel ? $(focusSel) : $(sel).querySelector('button'))?.focus(), 50);
    },
    close(sel) {
        $(sel).classList.remove('open');
        this.lastFocus?.focus?.();
    },
    closeAll() {
        $$('.modal-overlay.open').forEach(m => m.classList.remove('open'));
        if (confirmDialog.resolve) confirmDialog.answer(false);
    }
};

const confirmDialog = {
    resolve: null,
    ask(text, title = 'Подтвердите действие') {
        $('#confirmTitle').textContent = title;
        $('#confirmText').textContent = text;
        modal.open('#confirmModal');
        return new Promise(res => { this.resolve = res; });
    },
    answer(yes) {
        modal.close('#confirmModal');
        const r = this.resolve;
        this.resolve = null;
        r?.(yes);
    }
};

// ==================== TRANSACTIONS ====================
const transactions = {
    initForm() {
        const date = $('#txDate');
        date.max = localISODate();
        if (!date.value) date.value = localISODate();
        this.fillCategories();
    },
    fillCategories() {
        const type = document.querySelector('#addTransactionForm input[name="type"]:checked')?.value || 'income';
        const select = $('#txCategory');
        const prev = select.value;
        const cats = state.categoryMap[type] || [];
        select.innerHTML = '<option value="">Выберите категорию...</option>'
            + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
        if (cats.includes(prev)) select.value = prev;
    },
    async add(form) {
        if (!state.user) { router.navigate('login'); return; }
        const fd = new FormData(form);
        const type = fd.get('type');
        const amount = parseFloat(fd.get('amount'));
        const category = fd.get('category');
        const date = fd.get('date');

        if (!type || !(amount > 0) || !category) {
            toast.show('Заполните все поля корректно.', 'error');
            return;
        }
        try {
            await api('/api/transactions', { method: 'POST', body: { type, amount, category, date } });
        } catch (e) {
            toast.show(e.message, 'error');
            return;
        }
        form.reset();
        $('#typeIncome').checked = true;
        $('#txDate').value = localISODate();
        this.fillCategories();
        toast.show('Операция успешно добавлена!', 'success');

        if (Math.random() < 0.33) {
            setTimeout(() => confetti.celebrate('🎉 Отличный день для накоплений!'), 500);
        }
        router.navigate('dashboard');
    },
    async remove(id, btn) {
        const ok = await confirmDialog.ask('Операция будет удалена без возможности восстановления. Продолжить?', 'Удалить операцию?');
        if (!ok) return;
        try {
            await api(`/api/transactions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch (e) {
            toast.show(e.message, 'error');
            return;
        }
        const row = btn.closest('tr');
        row.classList.add('row-removing');
        setTimeout(() => {
            row.remove();
            if (!$('#historyTableBody').children.length) historyPage.showEmpty(true);
        }, 200);
        toast.show('Операция удалена.', 'info');
    }
};

// ==================== HISTORY PAGE ====================
const historyPage = {
    showEmpty(empty) {
        $('#historyCard').classList.toggle('hidden', empty);
        $('#historyEmpty').classList.toggle('hidden', !empty);
    },
    async init() {
        let data;
        try {
            data = await api('/api/transactions');
        } catch (e) {
            if (e.status !== 401) toast.show(e.message, 'error');
            return;
        }
        if (router.current !== 'history') return;
        const txs = data.transactions;
        if (txs.length === 0) { this.showEmpty(true); return; }
        this.showEmpty(false);

        $('#historyTableBody').innerHTML = txs.map(t => `
            <tr>
                <td class="mono">${esc(formatDate(t.date))}</td>
                <td>
                    <span class="badge ${t.type === 'income' ? 'badge-green' : 'badge-red'}">
                        ${t.type === 'income' ? '↑ Доход' : '↓ Расход'}
                    </span>
                </td>
                <td><span class="text-violet">#</span> ${esc(t.category)}</td>
                <td class="text-right mono ${t.type === 'income' ? 'text-green' : 'text-red'}">
                    <strong>${formatMoney(t.amount)}</strong>
                </td>
                <td class="text-right">
                    <button type="button" class="icon-btn" data-action="tx-delete" data-arg="${Number(t.id)}" title="Удалить" aria-label="Удалить операцию">✕</button>
                </td>
            </tr>
        `).join('');
    }
};

// ==================== SETTINGS ====================
const settings = {
    init() {
        const s = state.settings;
        $('#setSalary').value = s.salary || '';
        $('#setSalaryDay').value = s.salary_day || 1;
        $('#setRent').value = s.rent_expense || '';
        $('#setRentDay').value = s.rent_day || 1;
        $('#setEmail').value = s.email || '';
        theming.loadIntoForm();
    },
    async save(form) {
        if (!state.user) return;
        const fd = new FormData(form);
        try {
            const data = await api('/api/settings', {
                method: 'PUT',
                body: {
                    salary: parseFloat(fd.get('salary')) || 0,
                    salary_day: parseInt(fd.get('salary_day'), 10) || 1,
                    rent_expense: parseFloat(fd.get('rent_expense')) || 0,
                    rent_day: parseInt(fd.get('rent_day'), 10) || 1,
                    email: String(fd.get('email') || '').trim(),
                },
            });
            state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
        } catch (e) {
            toast.show(e.message, 'error');
            return;
        }
        toast.show('Настройки сохранены!', 'success');
        router.navigate('dashboard');
    }
};

// ==================== EVENT WIRING ====================
// Все обработчики подключаются здесь (без inline onclick) — это позволяет строгую CSP.
const actions = {
    'toggle-password': (arg, el) => auth.togglePassword(arg, el),
    'captcha-refresh': (arg) => auth.initCaptcha(arg === 'register' ? 'register' : 'login', true),
    'logout': () => auth.logout(),
    'goal-open': () => dashboard.openGoalModal(),
    'goal-close': () => dashboard.closeGoalModal(),
    'confirm-yes': () => confirmDialog.answer(true),
    'confirm-no': () => confirmDialog.answer(false),
    'theme-reset': () => theming.resetUI(),
    'backup-export': () => backup.export(),
    'tx-delete': (arg, el) => transactions.remove(arg, el),
};

const forms = {
    'login': (f) => auth.login(f),
    'register': (f) => auth.register(f),
    'add-tx': (f) => transactions.add(f),
    'settings': (f) => settings.save(f),
    'theme': (f) => theming.save(f),
    'goal': (f) => dashboard.saveGoal(f),
    'delete-account': (f) => auth.deleteAccount(f),
};

function wireEvents() {
    document.addEventListener('click', (e) => {
        const nav = e.target.closest('[data-nav]');
        if (nav) { e.preventDefault(); router.navigate(nav.dataset.nav); return; }
        const act = e.target.closest('[data-action]');
        if (act && actions[act.dataset.action]) {
            e.preventDefault();
            actions[act.dataset.action](act.dataset.arg, act);
            return;
        }
        // Клик по затемнению вокруг модального окна закрывает его
        if (e.target.classList?.contains('modal-overlay')) modal.closeAll();
    });

    document.addEventListener('submit', (e) => {
        const form = e.target.closest('form[data-form]');
        if (!form || !forms[form.dataset.form]) return;
        e.preventDefault();
        withBusy(form, () => forms[form.dataset.form](form));
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') modal.closeAll();
    });

    $('#regPassword').addEventListener('input', (e) => { auth.checkPasswordStrength(e.target.value); auth.checkPasswordMatch(); });
    $('#regConfirm').addEventListener('input', () => auth.checkPasswordMatch());
    $('#themeOverlay').addEventListener('input', (e) => { $('#overlayVal').textContent = e.target.value + '%'; });
    $('#baseCurrency').addEventListener('change', () => dashboard.updateCurrencyRates());
    $('#backupFile').addEventListener('change', (e) => backup.import(e));
    $$('#addTransactionForm input[name="type"]').forEach(r => r.addEventListener('change', () => transactions.fillCategories()));

    window.addEventListener('hashchange', () => router.render(location.hash.slice(1)));
    // Вернулись на вкладку — обновим цифры (данные могли поменяться на другом устройстве).
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && router.current === 'dashboard' && state.user) dashboard.init();
    });
}

// ==================== INIT ====================
async function boot() {
    confetti.init();
    wireEvents();
    // AI-помощник убран: стираем сохранённые в браузере ключи OpenRouter.
    try { Object.keys(localStorage).filter(k => k.startsWith('akysaya_ai_')).forEach(k => LS.del(k)); } catch (e) { /* ignore */ }

    const remembered = LS.get('akysaya_remember', '');
    if (remembered) {
        const input = $('#loginForm input[name="username"]');
        if (input) input.value = remembered;
        const cb = $('#loginRemember');
        if (cb) cb.checked = true;
    }

    try {
        await auth.loadProfile();
    } catch (e) {
        toast.show(e.message, 'error');
    }
    api('/api/categories').then(map => { state.categoryMap = map; }).catch(() => {});
    router.render(location.hash.slice(1));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
