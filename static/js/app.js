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
    prevTotals: { income: 0, expenses: 0, balance: 0 },
    categories: [],
    budgets: [],
    series: [],
    upcoming: [],
    categoryItems: [],
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
            window.AkysayaFluid?.pause();      // своя картинка вместо живого фона
        } else {
            body.style.backgroundImage = '';
            body.classList.remove('custom-bg-active');
            window.AkysayaFluid?.resume();
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
const PROTECTED = ['dashboard', 'history', 'add', 'settings', 'recurring'];
const router = {
    routes: ['welcome', 'login', 'register', 'dashboard', 'history', 'add', 'settings', 'recurring', 'privacy', 'terms'],
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

        window.AkysayaDropdown?.closeAll();
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
        if (page === 'recurring') recurringPage.init();
        window.AkysayaFx?.pageShown(page);
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
            ${link('recurring', 'Платежи')}
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
        state.budgets = [];
        state.series = [];
        state.upcoming = [];
        dashboard.month = null;
        historyPage.items = [];
        recurringPage.items = [];
    },
    async afterLogin(user, message) {
        this.clearUserState();
        state.user = user;
        await this.loadProfile();
        await categories.load();
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
        categories.load();
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

// ==================== CHARTS ====================
const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function monthLabel(ym, short = false) {
    const [y, m] = String(ym).split('-').map(Number);
    if (!y || !m) return ym;
    if (short) return `${MONTHS_SHORT[m - 1]} ${String(y).slice(2)}`;
    const name = MONTHS_RU[m - 1];
    return name.charAt(0).toUpperCase() + name.slice(1) + ' ' + y;
}
function shiftMonth(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const idx = y * 12 + (m - 1) + delta;
    return `${Math.floor(idx / 12)}-${String(idx % 12 + 1).padStart(2, '0')}`;
}
function compactMoney(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' млн';
    if (a >= 1e4) return Math.round(v / 1e3) + ' тыс';
    if (a >= 1e3) return (v / 1e3).toFixed(1).replace('.', ',').replace(',0', '') + ' тыс';
    return String(Math.round(v));
}
const CHART_TOOLTIP = {
    backgroundColor: 'rgba(9,12,30,0.95)', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1,
    titleFont: { family: 'Inter', size: 13 }, bodyFont: { family: 'JetBrains Mono', size: 12 }, padding: 12, cornerRadius: 12,
};

const expensesChart = {
    instance: null,
    COLORS: ['#6a5bff', '#ff4ecd', '#41f0d1', '#ffca16', '#3b9eff', '#ff9592', '#baa7ff', '#63e0a4', '#ff6465'],
    render(entries) {
        const canvas = $('#expensesChart');
        if (typeof Chart === 'undefined') { canvas.style.display = 'none'; return; }
        const labels = entries.map(e => e[0]);
        const data = entries.map(e => e[1]);
        $('#chartEmpty').textContent = labels.length
            ? 'Диаграмма показывает соотношение трат по категориям за выбранный месяц.'
            : 'В этом месяце расходов пока нет.';
        if (labels.length === 0) {
            if (this.instance) { this.instance.destroy(); this.instance = null; }
            canvas.style.display = 'none';
            return;
        }
        canvas.style.display = 'block';
        const colors = labels.map((_, i) => this.COLORS[i % this.COLORS.length]);
        if (this.instance) {
            this.instance.data.labels = labels;
            this.instance.data.datasets[0].data = data;
            this.instance.data.datasets[0].backgroundColor = colors;
            this.instance.update();
            return;
        }
        this.instance = new Chart(canvas, {
            type: 'doughnut',
            data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: 'rgba(6,8,20,0.9)', borderWidth: 2, hoverOffset: 12 }] },
            options: {
                responsive: true, maintainAspectRatio: false, cutout: '62%',
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#98a0c5', font: { family: 'JetBrains Mono', size: 11 }, padding: 16, usePointStyle: true } },
                    tooltip: {
                        ...CHART_TOOLTIP,
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

const monthsChart = {
    instance: null,
    render(series) {
        const canvas = $('#monthsChart');
        if (typeof Chart === 'undefined' || !series.length) return;
        const labels = series.map(s => monthLabel(s.month, true));
        const income = series.map(s => s.income);
        const expenses = series.map(s => s.expenses);
        if (this.instance) {
            this.instance.data.labels = labels;
            this.instance.data.datasets[0].data = income;
            this.instance.data.datasets[1].data = expenses;
            this.instance.update();
            return;
        }
        const ctx = canvas.getContext('2d');
        const grad = (a, b) => { const g = ctx.createLinearGradient(0, 0, 0, 260); g.addColorStop(0, a); g.addColorStop(1, b); return g; };
        this.instance = new Chart(canvas, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { label: 'Доходы', data: income, backgroundColor: grad('rgba(65,240,209,0.95)', 'rgba(65,240,209,0.25)'), borderRadius: 8, maxBarThickness: 26 },
                    { label: 'Расходы', data: expenses, backgroundColor: grad('rgba(255,78,205,0.95)', 'rgba(106,91,255,0.3)'), borderRadius: 8, maxBarThickness: 26 },
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: '#98a0c5', font: { family: 'JetBrains Mono', size: 11 }, usePointStyle: true, padding: 16 } },
                    tooltip: { ...CHART_TOOLTIP, callbacks: { label: (c) => ` ${c.dataset.label}: ${formatMoney(c.raw)}` } },
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#98a0c5', font: { family: 'JetBrains Mono', size: 11 } } },
                    y: { grid: { color: 'rgba(255,255,255,0.06)' }, border: { display: false }, ticks: { color: '#5c6488', font: { family: 'JetBrains Mono', size: 10 }, callback: (v) => compactMoney(v) } },
                }
            }
        });
    }
};

// ==================== DASHBOARD ====================
const ACHIEVEMENTS = [10000, 50000, 100000, 500000, 1000000];
const warnedBudgets = new Set();
const dashboard = {
    currencyRates: { USD: 1, EUR: 0.93, GBP: 0.79, JPY: 150.25, CNY: 7.18, RUB: 92.50 },
    cryptoRates: { BTC: 45000, ETH: 2500, BNB: 320, XRP: 0.65, ADA: 0.48 },
    clockStarted: false,
    RATES_TTL_MS: 5 * 60 * 1000,
    month: null,          // null — текущий месяц
    current: null,
    months: [],
    seq: 0,
    async init() {
        this.startClock();
        this.renderAll();
        this.loadRatesFromCache();
        this.fetchRates();
        await this.load();
    },
    async load() {
        const seq = ++this.seq;
        try {
            const data = await api('/api/dashboard' + (this.month ? `?month=${encodeURIComponent(this.month)}` : ''));
            if (seq !== this.seq) return;
            state.totals = data.totals;
            state.prevTotals = data.prev;
            state.categories = data.categories;
            state.budgets = data.budgets;
            state.series = data.series;
            state.upcoming = data.upcoming;
            state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
            this.month = data.month;
            this.current = data.current_month;
            this.months = data.months;
            $('#lastUpdated').textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            if (router.current === 'dashboard') {
                this.renderMonthSelect();
                this.renderAll();
                if (this.isCurrent()) { this.checkAchievements(); this.budgetWarnings(); }
            }
        } catch (e) {
            if (e.status !== 401) toast.show(e.message, 'error');
        }
    },
    isCurrent() { return !this.month || this.month === this.current; },
    renderMonthSelect() {
        const sel = $('#monthSelect');
        sel.innerHTML = this.months.map(m => `<option value="${esc(m)}">${esc(monthLabel(m))}</option>`).join('');
        sel.value = this.month;
        $('#monthNext').disabled = this.month >= this.current;
        const period = this.isCurrent() ? 'За текущий месяц' : 'За ' + monthLabel(this.month).toLowerCase();
        $$('.stat-period').forEach((el, i) => { el.textContent = i === 2 ? 'Остаток за месяц' : period; });
    },
    shift(delta) {
        const next = shiftMonth(this.month || this.current, delta);
        if (this.current && next > this.current) return;
        this.month = next;
        this.load();
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
        monthsChart.render(state.series || []);
        this.renderBudgets();
        this.renderUpcoming();
    },
    renderDelta(el, cur, prev, upIsGood) {
        if (!prev && !cur) { el.textContent = ''; el.className = 'delta'; return; }
        const diff = cur - prev;
        const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
        const pct = prev ? ` (${sign}${Math.abs(diff / Math.abs(prev) * 100).toFixed(0)}%)` : '';
        el.textContent = `${sign}${formatMoney(Math.abs(diff))}${pct} к прошлому месяцу`;
        el.className = 'delta' + (diff === 0 ? '' : (diff > 0) === upIsGood ? ' good' : ' bad');
    },
    renderStats() {
        const totals = state.totals;
        const goal = Number(state.settings.financial_goal) || 0;
        animateValue($('#statIncome'), 'income', totals.income);
        animateValue($('#statExpenses'), 'expenses', totals.expenses);
        animateValue($('#statBalance'), 'balance', totals.balance);
        $('#statGoal').textContent = formatMoney(goal);
        const prev = state.prevTotals || { income: 0, expenses: 0, balance: 0 };
        this.renderDelta($('#deltaIncome'), totals.income, prev.income, true);
        this.renderDelta($('#deltaExpenses'), totals.expenses, prev.expenses, false);
        this.renderDelta($('#deltaBalance'), totals.balance, prev.balance, true);

        const progress = goal > 0 ? Math.max(0, Math.min((totals.balance / goal) * 100, 100)) : 0;
        $('#goalProgressBar').style.width = progress + '%';
        $('#goalProgressText').textContent = progress.toFixed(0) + '% выполнено';

        const advice = this.generateAdvice(totals.income, totals.expenses, state.categories);
        const adviceCard = $('#aiAdviceCard');
        if (advice.length > 0) {
            adviceCard.classList.remove('hidden');
            $('#aiAdviceList').innerHTML = advice.map(a => `
                <div class="flex items-start gap-8 mb-12" style="padding: 12px; border-radius: 12px; background: rgba(255,255,255,0.025);">
                    <span class="status-dot ${a.type === 'warning' ? 'amber' : a.type === 'danger' ? 'red' : 'green'}" style="margin-top: 6px; flex-shrink: 0;"></span>
                    <span class="body-sm" style="color: var(--color-bone-white);">${esc(a.text)}</span>
                </div>
            `).join('');
        } else {
            adviceCard.classList.add('hidden');
        }

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
    renderBudgets() {
        const list = $('#budgetList');
        const items = state.budgets || [];
        if (!items.length) {
            list.innerHTML = '<p class="body-sm text-muted">Бюджетов пока нет. Нажмите «Настроить», чтобы задать лимит на месяц, например «Еда — 15 000 ₽».</p>';
            return;
        }
        list.innerHTML = items.map(b => {
            const pct = Math.min(b.percent, 100);
            const cls = b.percent > 100 ? 'over' : b.percent >= 80 ? 'warn' : 'grad';
            const note = b.percent > 100
                ? `<span class="budget-note text-red">Перерасход ${formatMoney(b.spent - b.amount)}</span>`
                : `<span class="budget-note text-muted">Осталось ${formatMoney(b.amount - b.spent)}</span>`;
            return `
                <div class="budget-row">
                    <div class="flex justify-between items-center gap-8">
                        <span class="body-sm" style="color: var(--color-white);">${esc(b.category)}</span>
                        <span class="mono caption">${formatMoney(b.spent)} / ${formatMoney(b.amount)}</span>
                    </div>
                    <div class="progress" role="progressbar" aria-label="${esc(b.category)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}">
                        <div class="progress-bar ${cls}" style="width: ${pct}%"></div>
                    </div>
                    <div class="flex justify-between mt-4">${note}<span class="budget-note text-iron">${Math.round(b.percent)}%</span></div>
                </div>`;
        }).join('');
    },
    budgetWarnings() {
        let shown = 0;
        for (const b of state.budgets || []) {
            const key = `${this.month}:${b.category}`;
            if (b.percent > 100 && !warnedBudgets.has(key) && shown < 2) {
                warnedBudgets.add(key);
                shown++;
                toast.show(`Бюджет «${b.category}» превышен на ${formatMoney(b.spent - b.amount)}`, 'error');
            }
        }
    },
    renderUpcoming() {
        const list = $('#upcomingList');
        const items = state.upcoming || [];
        if (!items.length) {
            list.innerHTML = '<p class="body-sm text-muted">В ближайшие две недели платежей нет. <a href="#recurring" class="text-violet" data-nav="recurring">Добавить подписку или кредит</a></p>';
            return;
        }
        list.innerHTML = items.map(u => `
            <div class="list-row">
                <div>
                    <span class="body-sm" style="color: var(--color-white);">${esc(u.title)}</span>
                    <span class="pill mt-4 ${u.days_left <= 3 ? 'soon' : ''}">${esc(dueLabel(u.next_due, u.days_left))}</span>
                </div>
                <span class="mono body-sm ${u.type === 'income' ? 'text-green' : 'text-red'}">${u.type === 'income' ? '+' : '−'}${formatMoney(u.amount)}</span>
            </div>`).join('');
    },
    generateAdvice(income, expenses, categories) {
        const advice = [];
        const s = state.settings;
        const totalSpent = categories.reduce((a, [, v]) => a + v, 0);
        const over = (state.budgets || []).filter(b => b.percent > 100);
        if (over.length) advice.push({ type: 'danger', text: `Превышен бюджет: ${over.map(b => b.category).join(', ')}. Посмотрите, что можно отложить до следующего месяца.` });
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
        } else if (s.salary > 0 && income === 0 && this.isCurrent()) {
            advice.push({ type: 'warning', text: `В этом месяце ещё нет доходов. Зарплата (${formatMoney(s.salary)}) ожидается ${s.salary_day}-го числа. Её можно сделать регулярным платежом.` });
        } else if (!s.salary && categories.length === 0) {
            advice.push({ type: 'success', text: 'Начните с настроек: укажите зарплату и аренду, затем добавьте операции или загрузите выписку из банка.' });
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
        $('#currencyRatesList').innerHTML = currencies.filter(c => c !== base).map(c => {
            const val = baseRate / (this.currencyRates[c] || 1);
            const decimals = val < 1 ? 4 : 2;
            return `
                <div class="currency-row">
                    <span class="currency-code">1 ${c}</span>
                    <span class="currency-value mono">${val.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${base}</span>
                </div>`;
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
                </div>`;
        }).join('');
    },
    openGoalModal() {
        $('#goalInput').value = state.settings.financial_goal || 5000;
        modal.open('#goalModal', '#goalInput');
    },
    closeGoalModal() { modal.close('#goalModal'); },
    async saveGoal() {
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

function dueLabel(iso, daysLeft) {
    const d = new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    if (daysLeft === 1) return `завтра, ${d}`;
    if (daysLeft != null && daysLeft <= 14) return `через ${daysLeft} дн., ${d}`;
    return d;
}

// ==================== MODALS ====================
const modal = {
    lastFocus: null,
    open(sel, focusSel) {
        this.lastFocus = document.activeElement;
        $(sel).classList.add('open');
        setTimeout(() => (focusSel ? $(focusSel) : $(sel).querySelector('input:not([type=hidden]), button'))?.focus(), 60);
    },
    close(sel) {
        window.AkysayaDropdown?.closeAll();
        $(sel).classList.remove('open');
        this.lastFocus?.focus?.();
    },
    closeAll() {
        window.AkysayaDropdown?.closeAll();
        $$('.modal-overlay.open').forEach(m => m.classList.remove('open'));
        if (confirmDialog.resolve) confirmDialog.answer(false);
    }
};

const confirmDialog = {
    resolve: null,
    ask(text, title = 'Подтвердите действие', yes = 'Удалить') {
        $('#confirmTitle').textContent = title;
        $('#confirmText').textContent = text;
        $('[data-action="confirm-yes"]').textContent = yes;
        modal.open('#confirmModal');
        return new Promise(res => { this.resolve = res; });
    },
    answer(yes) {
        $('#confirmModal').classList.remove('open');
        const r = this.resolve;
        this.resolve = null;
        r?.(yes);
    }
};

// ==================== CATEGORIES ====================
function fillCategorySelect(select, type, { placeholder = 'Выберите категорию...', keep = null } = {}) {
    const prev = keep ?? select.value;
    const cats = [...(state.categoryMap[type] || [])];
    if (keep && !cats.includes(keep)) cats.push(keep);   // операция в удалённой категории
    select.innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '')
        + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    select.value = cats.includes(prev) ? prev : '';
}

const categories = {
    apply(data) {
        state.categoryMap = { income: data.income || [], expense: data.expense || [] };
        state.categoryItems = data.items || [];
    },
    async load() {
        try { this.apply(await api('/api/categories')); } catch (e) { /* остаются стандартные */ }
    },
    renderSettings() {
        const chip = (c) => `<span class="cat-chip">${esc(c.name)}<button type="button" data-action="cat-delete" data-arg="${Number(c.id)}" aria-label="Удалить категорию ${esc(c.name)}" title="Удалить">✕</button></span>`;
        $('#catExpense').innerHTML = state.categoryItems.filter(c => c.type === 'expense').map(chip).join('');
        $('#catIncome').innerHTML = state.categoryItems.filter(c => c.type === 'income').map(chip).join('');
    },
    async add(form) {
        const name = form.name.value.trim();
        if (!name) return;
        try {
            this.apply(await api('/api/categories', { method: 'POST', body: { type: form.type.value, name } }));
        } catch (e) { toast.show(e.message, 'error'); return; }
        form.name.value = '';
        this.renderSettings();
        toast.show(`Категория «${name}» добавлена.`, 'success');
    },
    async remove(id) {
        const item = state.categoryItems.find(c => c.id === Number(id));
        if (!item) return;
        const ok = await confirmDialog.ask(`Категория «${item.name}» исчезнет из списков. Старые операции сохранят её название, бюджет по ней удалится.`, 'Удалить категорию?');
        if (!ok) return;
        try {
            this.apply(await api(`/api/categories/${Number(id)}`, { method: 'DELETE' }));
        } catch (e) { toast.show(e.message, 'error'); return; }
        this.renderSettings();
        toast.show('Категория удалена.', 'info');
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
        fillCategorySelect($('#txCategory'), type);
    },
    async add(form) {
        if (!state.user) { router.navigate('login'); return; }
        const fd = new FormData(form);
        const type = fd.get('type');
        const amount = parseFloat(fd.get('amount'));
        const category = fd.get('category');
        const date = fd.get('date');
        const note = String(fd.get('note') || '').trim();
        if (!type || !(amount > 0) || !category) {
            toast.show('Заполните все поля корректно.', 'error');
            return;
        }
        try {
            await api('/api/transactions', { method: 'POST', body: { type, amount, category, date, note } });
        } catch (e) {
            toast.show(e.message, 'error');
            return;
        }
        form.reset();
        $('#typeIncome').checked = true;
        $('#txDate').value = localISODate();
        this.fillCategories();
        toast.show('Операция успешно добавлена!', 'success');
        if (Math.random() < 0.33) setTimeout(() => confetti.celebrate('🎉 Отличный день для накоплений!'), 500);
        dashboard.month = date ? date.slice(0, 7) : null;   // показываем месяц добавленной операции
        router.navigate('dashboard');
    },
    openEdit(id) {
        const t = historyPage.items.find(x => x.id === Number(id));
        if (!t) return;
        const form = $('#txEditForm');
        form.id.value = t.id;
        form.querySelector(`input[name="type"][value="${t.type}"]`).checked = true;
        form.amount.value = t.amount;
        form.date.value = t.date.slice(0, 10);
        form.date.max = localISODate();
        form.note.value = t.note || '';
        fillCategorySelect($('#editCategory'), t.type, { keep: t.category });
        modal.open('#txModal', '#editAmount');
    },
    async saveEdit(form) {
        const fd = new FormData(form);
        const body = {
            type: fd.get('type'), amount: parseFloat(fd.get('amount')), category: fd.get('category'),
            date: fd.get('date'), note: String(fd.get('note') || '').trim(),
        };
        if (!body.type || !(body.amount > 0) || !body.category) { toast.show('Заполните все поля корректно.', 'error'); return; }
        try {
            await api(`/api/transactions/${Number(fd.get('id'))}`, { method: 'PUT', body });
        } catch (e) { toast.show(e.message, 'error'); return; }
        modal.close('#txModal');
        toast.show('Операция изменена.', 'success');
        historyPage.reload();
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
        row?.classList.add('row-removing');
        setTimeout(() => historyPage.reload(), 200);
        toast.show('Операция удалена.', 'info');
    }
};

// ==================== HISTORY PAGE ====================
const historyPage = {
    items: [],
    PAGE: 100,
    seq: 0,
    timer: null,
    filters() {
        const f = $('#filtersForm');
        return { q: f.q.value.trim(), type: f.type.value, category: f.category.value, from: f.from.value, to: f.to.value };
    },
    hasFilters() { return Object.values(this.filters()).some(Boolean); },
    init() {
        this.fillCategoryFilter();
        this.reload();
    },
    fillCategoryFilter() {
        const type = $('#fType').value;
        const names = type ? state.categoryMap[type] || [] : [...new Set([...state.categoryMap.expense, ...state.categoryMap.income])];
        const sel = $('#fCategory');
        const prev = sel.value;
        sel.innerHTML = '<option value="">Все категории</option>' + names.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
        sel.value = names.includes(prev) ? prev : '';
    },
    schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.reload(), 250);
    },
    reset() {
        $('#filtersForm').reset();
        this.fillCategoryFilter();
        this.reload();
    },
    reload() { return this.load(false); },
    more() { return this.load(true); },
    async load(append) {
        const seq = ++this.seq;
        const params = new URLSearchParams({ limit: this.PAGE, offset: append ? this.items.length : 0 });
        for (const [k, v] of Object.entries(this.filters())) if (v) params.set(k, v);
        let data;
        try {
            data = await api('/api/transactions?' + params.toString());
        } catch (e) {
            if (e.status !== 401) toast.show(e.message, 'error');
            return;
        }
        if (seq !== this.seq || router.current !== 'history') return;
        this.items = append ? this.items.concat(data.transactions) : data.transactions;
        const empty = data.total === 0;
        $('#historyCard').classList.toggle('hidden', empty);
        $('#historyEmpty').classList.toggle('hidden', !empty);
        $('#historyEmptyTitle').textContent = this.hasFilters() ? 'Ничего не найдено' : 'У вас ещё нет операций';
        $('#historyEmptyText').textContent = this.hasFilters()
            ? 'Попробуйте изменить поиск или сбросить фильтры.'
            : 'Добавьте первую операцию или загрузите выписку из банка.';
        $('#historyTableBody').innerHTML = this.items.map(t => this.rowHtml(t)).join('');
        $('#loadMore').classList.toggle('hidden', !data.has_more);
        $('#filterSum').innerHTML = empty ? '' : `
            <span>Найдено: <b class="text-violet">${data.total}</b></span>
            <span>Доходы: <b class="text-green">${formatMoney(data.sum_income)}</b></span>
            <span>Расходы: <b class="text-red">${formatMoney(data.sum_expense)}</b></span>`;
    },
    rowHtml(t) {
        const income = t.type === 'income';
        return `
            <tr>
                <td class="mono">${esc(formatDate(t.date))}</td>
                <td><span class="badge ${income ? 'badge-green' : 'badge-red'}">${income ? '↑ Доход' : '↓ Расход'}</span></td>
                <td><span class="text-violet">#</span> ${esc(t.category)}${t.note ? `<span class="tx-note" title="${esc(t.note)}">${esc(t.note)}</span>` : ''}</td>
                <td class="text-right mono ${income ? 'text-green' : 'text-red'}"><strong>${formatMoney(t.amount)}</strong></td>
                <td class="text-right">
                    <span class="row-actions">
                        <button type="button" class="icon-btn" data-action="tx-edit" data-arg="${Number(t.id)}" title="Изменить" aria-label="Изменить операцию">✎</button>
                        <button type="button" class="icon-btn" data-action="tx-delete" data-arg="${Number(t.id)}" title="Удалить" aria-label="Удалить операцию">✕</button>
                    </span>
                </td>
            </tr>`;
    }
};

// ==================== RECURRING ====================
const recurringPage = {
    items: [],
    init() {
        this.fillCategories();
        this.load();
    },
    form() { return $('#recurringForm'); },
    fillCategories(keep = null) {
        const type = this.form().querySelector('input[name="type"]:checked')?.value || 'expense';
        fillCategorySelect($('#recCategory'), type, { keep });
    },
    async load() {
        let data;
        try { data = await api('/api/recurring'); } catch (e) { if (e.status !== 401) toast.show(e.message, 'error'); return; }
        this.items = data.recurring;
        if (router.current === 'recurring') this.render();
    },
    render() {
        $('#recurringEmpty').classList.toggle('hidden', this.items.length > 0);
        $('#recurringList').innerHTML = this.items.map(r => `
            <div class="list-row" style="${r.active ? '' : 'opacity:.55'}">
                <div style="min-width:0">
                    <div class="body-sm" style="color: var(--color-white);">${esc(r.title)}</div>
                    <div class="flex gap-8 flex-wrap mt-4">
                        <span class="pill">${esc(r.category)}</span>
                        <span class="pill">каждое ${Number(r.day)}-е</span>
                        <span class="pill ${r.active ? '' : 'soon'}">${r.active ? 'следующий: ' + esc(dueLabel(r.next_due)) : 'на паузе'}</span>
                    </div>
                </div>
                <div class="flex items-center gap-8" style="flex-shrink:0">
                    <span class="mono body-sm ${r.type === 'income' ? 'text-green' : 'text-red'}">${r.type === 'income' ? '+' : '−'}${formatMoney(r.amount)}</span>
                    <button type="button" class="btn btn-sm" data-action="rec-toggle" data-arg="${Number(r.id)}">${r.active ? 'Пауза' : 'Включить'}</button>
                    <button type="button" class="icon-btn" data-action="rec-edit" data-arg="${Number(r.id)}" title="Изменить" aria-label="Изменить платёж">✎</button>
                    <button type="button" class="icon-btn" data-action="rec-delete" data-arg="${Number(r.id)}" title="Удалить" aria-label="Удалить платёж">✕</button>
                </div>
            </div>`).join('');
    },
    async save(form) {
        const fd = new FormData(form);
        const id = fd.get('id');
        const body = {
            type: fd.get('type'), title: String(fd.get('title') || '').trim(), amount: parseFloat(fd.get('amount')),
            category: fd.get('category'), day: parseInt(fd.get('day'), 10),
        };
        try {
            await api(id ? `/api/recurring/${Number(id)}` : '/api/recurring', { method: id ? 'PUT' : 'POST', body });
        } catch (e) { toast.show(e.message, 'error'); return; }
        toast.show(id ? 'Платёж изменён.' : `Платёж «${body.title}» добавлен.`, 'success');
        this.cancelEdit();
        this.load();
    },
    edit(id) {
        const r = this.items.find(x => x.id === Number(id));
        if (!r) return;
        const form = this.form();
        form.querySelector(`input[name="type"][value="${r.type}"]`).checked = true;
        $('#recId').value = r.id;
        form.title.value = r.title;
        form.amount.value = r.amount;
        form.day.value = r.day;
        this.fillCategories(r.category);
        $('#recFormTitle').textContent = 'Изменить платёж';
        $('#recCancel').classList.remove('hidden');
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        form.title.focus({ preventScroll: true });
    },
    cancelEdit() {
        const form = this.form();
        form.reset();
        $('#recId').value = '';
        $('#recFormTitle').textContent = 'Новый платёж';
        $('#recCancel').classList.add('hidden');
        this.fillCategories();
    },
    async toggle(id) {
        const r = this.items.find(x => x.id === Number(id));
        if (!r) return;
        try { await api(`/api/recurring/${r.id}`, { method: 'PUT', body: { active: !r.active } }); }
        catch (e) { toast.show(e.message, 'error'); return; }
        toast.show(r.active ? 'Платёж на паузе.' : 'Платёж снова работает.', 'info');
        this.load();
    },
    async remove(id) {
        const r = this.items.find(x => x.id === Number(id));
        if (!r) return;
        const ok = await confirmDialog.ask(`Платёж «${r.title}» перестанет добавляться. Уже добавленные операции останутся в истории.`, 'Удалить платёж?');
        if (!ok) return;
        try { await api(`/api/recurring/${r.id}`, { method: 'DELETE' }); }
        catch (e) { toast.show(e.message, 'error'); return; }
        toast.show('Платёж удалён.', 'info');
        this.load();
    }
};

// ==================== BUDGETS ====================
const budgetsUI = {
    async open() {
        let current = {};
        try { current = (await api('/api/budgets')).budgets; } catch (e) { toast.show(e.message, 'error'); return; }
        $('#budgetInputs').innerHTML = (state.categoryMap.expense || []).map((cat, i) => `
            <div class="flex items-center justify-between gap-16 mb-12">
                <label class="body-sm" for="budget_${i}" style="color: var(--color-white);">${esc(cat)}</label>
                <input class="input" style="max-width: 180px;" type="number" min="0" step="100" id="budget_${i}"
                       data-cat="${esc(cat)}" value="${current[cat] != null ? Number(current[cat]) : ''}" placeholder="Без лимита">
            </div>`).join('');
        modal.open('#budgetModal', '#budget_0');
    },
    async save(form) {
        const budgets = {};
        for (const input of form.querySelectorAll('input[data-cat]')) {
            const v = input.value === '' ? 0 : parseFloat(input.value);
            if (!(v >= 0)) { toast.show(`Проверьте сумму для «${input.dataset.cat}».`, 'error'); input.focus(); return; }
            budgets[input.dataset.cat] = v;
        }
        try { await api('/api/budgets', { method: 'PUT', body: { budgets } }); }
        catch (e) { toast.show(e.message, 'error'); return; }
        modal.close('#budgetModal');
        toast.show('Бюджеты сохранены.', 'success');
        dashboard.load();
    }
};

// ==================== CSV IMPORT ====================
const csvImport = {
    text: '',
    name: '',
    mapping: null,
    open() {
        this.reset();
        modal.open('#csvModal', '#csvDrop');
    },
    close() { modal.close('#csvModal'); },
    reset() {
        this.text = '';
        this.mapping = null;
        $('#csvFile').value = '';
        $('#csvInvert').checked = false;
        $('#csvStep1').classList.remove('hidden');
        $('#csvStep2').classList.add('hidden');
    },
    async readFile(file) {
        if (!file) return;
        if (file.size > 4.5 * 1024 * 1024) { toast.show('Файл слишком большой (максимум 4,5 МБ).', 'error'); return; }
        const buf = await file.arrayBuffer();
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
        catch (e) { text = new TextDecoder('windows-1251').decode(buf); }   // старые выгрузки банков
        this.text = text;
        this.name = file.name;
        this.mapping = null;
        await this.preview();
    },
    body(dryRun) {
        return { csv: this.text, mapping: this.mapping || undefined, invert: $('#csvInvert').checked, dry_run: dryRun };
    },
    async preview() {
        let data;
        try { data = await api('/api/import/csv', { method: 'POST', body: this.body(true) }); }
        catch (e) { toast.show(e.message, 'error'); return; }
        this.mapping = data.mapping;
        this.renderMapping(data.columns, data.mapping, data.sample || []);
        const st = data.stats;
        const delim = data.delimiter === 'tab' ? 'табуляция' : `«${data.delimiter}»`;
        $('#csvFileName').textContent = `${this.name} · строк: ${st.rows} · разделитель ${delim}${data.header ? '' : ' · без заголовка'}`;
        $('#csvStats').innerHTML = `
            <div><b class="text-grad">${st.ok}</b><span>к импорту</span></div>
            <div><b>${st.duplicates}</b><span>уже есть</span></div>
            <div><b>${st.skipped}</b><span>пропущено</span></div>
            <div><b class="text-green" style="font-size:16px">+${formatMoney(st.income)}</b><b class="text-red" style="font-size:16px">−${formatMoney(st.expense)}</b></div>`;
        const problem = $('#csvProblem');
        problem.textContent = data.problem || (st.ok === 0 && st.rows ? 'Нет новых операций для импорта. Проверьте столбцы или знак сумм.' : '');
        problem.classList.toggle('hidden', !problem.textContent);
        $('#csvPreview').innerHTML = data.preview.map(p => `
            <tr>
                <td class="mono">${esc(formatDate(p.date.replace(' ', 'T')))}</td>
                <td><span class="badge ${p.type === 'income' ? 'badge-green' : 'badge-red'}">${p.type === 'income' ? '↑ Доход' : '↓ Расход'}</span></td>
                <td>${esc(p.category)}</td>
                <td><span class="tx-note" style="margin:0" title="${esc(p.note)}">${esc(p.note) || '—'}</span></td>
                <td class="text-right mono ${p.type === 'income' ? 'text-green' : 'text-red'}">${formatMoney(p.amount)}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="text-muted body-sm">Предпросмотр появится, когда будут выбраны дата и сумма.</td></tr>';
        $('#csvCommit').disabled = st.ok === 0;
        $('#csvCommit').textContent = st.ok ? `Импортировать ${st.ok}` : 'Импортировать';
        $('#csvStep1').classList.add('hidden');
        $('#csvStep2').classList.remove('hidden');
    },
    renderMapping(cols, mapping, sample) {
        $$('[data-map]').forEach(sel => {
            const key = sel.dataset.map;
            sel.innerHTML = '<option value="">— нет —</option>' + cols.map((c, i) => {
                const peek = sample[0] && sample[0][i] ? ` · ${String(sample[0][i]).trim().slice(0, 22)}` : '';
                return `<option value="${i}">${esc(c + peek)}</option>`;
            }).join('');
            sel.value = mapping[key] == null ? '' : String(mapping[key]);
        });
    },
    onMapChange(sel) {
        this.mapping = { ...(this.mapping || {}), [sel.dataset.map]: sel.value === '' ? null : Number(sel.value) };
        if (sel.dataset.map === 'amount' && sel.value !== '') this.mapping.debit = this.mapping.credit = null;
        if ((sel.dataset.map === 'debit' || sel.dataset.map === 'credit') && sel.value !== '') this.mapping.amount = null;
        this.preview();
    },
    async commit(btn) {
        if (btn.getAttribute('aria-busy') === 'true') return;
        btn.setAttribute('aria-busy', 'true');
        try {
            const res = await api('/api/import/csv', { method: 'POST', body: this.body(false) });
            toast.show(`Импортировано операций: ${res.imported}` + (res.duplicates ? `, уже были: ${res.duplicates}` : ''), 'success');
            this.close();
            if (router.current === 'history') historyPage.reload();
            if (router.current === 'dashboard') dashboard.load();
        } catch (e) {
            toast.show(e.message, 'error');
        } finally {
            btn.removeAttribute('aria-busy');
        }
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
        categories.renderSettings();
        categories.load().then(() => { if (router.current === 'settings') categories.renderSettings(); });
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
    'modal-close': (arg) => modal.close(arg),
    'confirm-yes': () => confirmDialog.answer(true),
    'confirm-no': () => confirmDialog.answer(false),
    'theme-reset': () => theming.resetUI(),
    'backup-export': () => backup.export(),
    'month-prev': () => dashboard.shift(-1),
    'month-next': () => dashboard.shift(1),
    'budget-open': () => budgetsUI.open(),
    'tx-edit': (arg) => transactions.openEdit(arg),
    'tx-delete': (arg, el) => transactions.remove(arg, el),
    'history-more': () => historyPage.more(),
    'filters-reset': () => historyPage.reset(),
    'rec-edit': (arg) => recurringPage.edit(arg),
    'rec-toggle': (arg) => recurringPage.toggle(arg),
    'rec-delete': (arg) => recurringPage.remove(arg),
    'rec-cancel': () => recurringPage.cancelEdit(),
    'cat-delete': (arg) => categories.remove(arg),
    'csv-open': () => csvImport.open(),
    'csv-close': () => csvImport.close(),
    'csv-reset': () => csvImport.reset(),
    'csv-commit': (arg, el) => csvImport.commit(el),
};

const forms = {
    'login': (f) => auth.login(f),
    'register': (f) => auth.register(f),
    'add-tx': (f) => transactions.add(f),
    'tx-edit': (f) => transactions.saveEdit(f),
    'settings': (f) => settings.save(f),
    'theme': (f) => theming.save(f),
    'goal': (f) => dashboard.saveGoal(f),
    'budgets': (f) => budgetsUI.save(f),
    'recurring': (f) => recurringPage.save(f),
    'category-add': (f) => categories.add(f),
    'filters': () => historyPage.reload(),
    'delete-account': (f) => auth.deleteAccount(f),
};

function wireEvents() {
    document.addEventListener('click', (e) => {
        const nav = e.target.closest('[data-nav]');
        if (nav) { e.preventDefault(); modal.closeAll(); router.navigate(nav.dataset.nav); return; }
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
        if (e.key === 'Escape' && !window.AkysayaDropdown?.isOpen()) modal.closeAll();
    });

    document.addEventListener('change', (e) => {
        if (e.target.matches?.('[data-map]')) csvImport.onMapChange(e.target);
    });

    $('#regPassword').addEventListener('input', (e) => { auth.checkPasswordStrength(e.target.value); auth.checkPasswordMatch(); });
    $('#regConfirm').addEventListener('input', () => auth.checkPasswordMatch());
    $('#themeOverlay').addEventListener('input', (e) => { $('#overlayVal').textContent = e.target.value + '%'; });
    $('#baseCurrency').addEventListener('change', () => dashboard.updateCurrencyRates());
    $('#monthSelect').addEventListener('change', (e) => { dashboard.month = e.target.value; dashboard.load(); });
    $('#backupFile').addEventListener('change', (e) => backup.import(e));
    $$('#addTransactionForm input[name="type"]').forEach(r => r.addEventListener('change', () => transactions.fillCategories()));
    $$('#txEditForm input[name="type"]').forEach(r => r.addEventListener('change', () => fillCategorySelect($('#editCategory'), r.value)));
    $$('#recurringForm input[name="type"]').forEach(r => r.addEventListener('change', () => recurringPage.fillCategories()));

    $('#fQ').addEventListener('input', () => historyPage.schedule());
    $('#fType').addEventListener('change', () => { historyPage.fillCategoryFilter(); historyPage.reload(); });
    ['#fCategory', '#fFrom', '#fTo'].forEach(sel => $(sel).addEventListener('change', () => historyPage.reload()));

    const drop = $('#csvDrop');
    $('#csvFile').addEventListener('change', (e) => csvImport.readFile(e.target.files[0]));
    $('#csvInvert').addEventListener('change', () => csvImport.preview());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#csvFile').click(); } });
    drop.tabIndex = 0;
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
    drop.addEventListener('drop', (e) => csvImport.readFile(e.dataTransfer.files[0]));

    window.addEventListener('hashchange', () => router.render(location.hash.slice(1)));
    // Вернулись на вкладку — обновим цифры (данные могли поменяться на другом устройстве).
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && router.current === 'dashboard' && state.user) dashboard.load();
    });
}

// ==================== INIT ====================
async function boot() {
    confetti.init();
    wireEvents();
    window.AkysayaDropdown?.enhanceAll();
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
    await categories.load();
    router.render(location.hash.slice(1));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
