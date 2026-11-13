"""Akysaya — учёт личных финансов.

Flask-сервер отдаёт одностраничный интерфейс (templates/index.html) и JSON API
под /api/*. Данные хранятся в SQLite (database.db рядом с этим файлом).

Запуск:  python app.py   →   http://127.0.0.1:5000
"""
import base64
import calendar
import csv
import hashlib
import hmac
import io
import math
import json
import logging
import os
import re
import secrets
import smtplib
import sqlite3
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from logging.handlers import RotatingFileHandler
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from functools import wraps
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from flask import Flask, g, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

# ============================================================
#  Конфигурация
# ============================================================
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = os.environ.get('DB_PATH', str(BASE_DIR / 'database.db'))
IS_PROD = os.environ.get('FLASK_ENV') == 'production'
# Отладчик Werkzeug позволяет выполнять код на сервере, поэтому по умолчанию он выключен
# и в production не включается никогда.
DEBUG = os.environ.get('FLASK_DEBUG') == '1' and not IS_PROD
TRUST_PROXY = os.environ.get('TRUST_PROXY') == '1'

EMAIL_HOST = os.environ.get('EMAIL_HOST', 'smtp.gmail.com')
EMAIL_PORT = int(os.environ.get('EMAIL_PORT', 587))
EMAIL_USER = os.environ.get('EMAIL_USER', '')
EMAIL_PASS = os.environ.get('EMAIL_PASS', '')

# Реквизиты для политики конфиденциальности и условий использования.
LEGAL_OWNER = os.environ.get('LEGAL_OWNER', '').strip()
LEGAL_EMAIL = os.environ.get('LEGAL_EMAIL', '').strip()

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('akysaya')

# Журнал событий безопасности: входы, отказы, блокировки, удаления. Пароли не пишутся.
(BASE_DIR / 'logs').mkdir(exist_ok=True)
security_log = logging.getLogger('akysaya.security')
security_log.setLevel(logging.INFO)
if not security_log.handlers:
    _handler = RotatingFileHandler(BASE_DIR / 'logs' / 'security.log', maxBytes=1_000_000,
                                   backupCount=5, encoding='utf-8')
    _handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    security_log.addHandler(_handler)


def audit(event, level=logging.INFO, **fields):
    """Одна строка на событие. repr() экранирует переводы строк — защита от подделки записей."""
    details = ' '.join(f'{k}={str(v)[:80]!r}' for k, v in fields.items())
    security_log.log(level, '%s ip=%r %s', event, client_ip() if request else '-', details)


def load_secret_key():
    """Ключ сессий: из FLASK_SECRET, иначе — сгенерированный и сохранённый в instance/.

    Сохранённый ключ переживает перезапуск, поэтому пользователей не разлогинивает.
    """
    key = os.environ.get('FLASK_SECRET')
    if key:
        return key
    if IS_PROD:
        raise RuntimeError('В production обязательно задайте переменную FLASK_SECRET.')
    path = BASE_DIR / 'instance' / 'secret_key'
    if path.exists():
        return path.read_text(encoding='utf-8').strip()
    path.parent.mkdir(exist_ok=True)
    key = secrets.token_hex(32)
    path.write_text(key, encoding='utf-8')
    return key


app = Flask(__name__)
if TRUST_PROXY:
    # За nginx/Caddy: берём реальный IP и схему (https) из заголовков одного доверенного прокси.
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.secret_key = load_secret_key()
app.json.ensure_ascii = False
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=IS_PROD,
    SESSION_COOKIE_NAME='akysaya_session',
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAX_CONTENT_LENGTH=5 * 1024 * 1024,
    TEMPLATES_AUTO_RELOAD=DEBUG,
)

# ============================================================
#  Справочники
# ============================================================
INCOME_CATEGORIES = ['Зарплата', 'Фриланс', 'Подарки', 'Другое']
EXPENSE_CATEGORIES = ['Еда', 'Транспорт', 'Развлечения', 'Одежда', 'Жилье', 'Подарки', 'Другое']
CATEGORIES = {'income': INCOME_CATEGORIES, 'expense': EXPENSE_CATEGORIES}

ACCENTS = {'violet', 'blue', 'green', 'amber', 'crimson'}
MAX_AMOUNT = 1_000_000_000_000
DEFAULT_GOAL = 5000.0
DATE_FMT = '%Y-%m-%d %H:%M:%S'
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

MAX_TX_PER_USER = 100_000     # защита от заполнения диска одним аккаунтом
TERMS_VERSION = '2026-11-13'  # дата редакции политики и условий; при изменении текста обновить
# Старая версия создавала общий аккаунт demo с паролем Demo1234, опубликованным в README.
_LEGACY_DEMO = ('demo', 'Demo1234')

SESSION_TTL_REMEMBER = 30 * 24 * 3600
SESSION_TTL_DEFAULT = 24 * 3600

# ============================================================
#  База данных
# ============================================================
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    # Встроенный lower() в SQLite понимает только латиницу; для поиска по-русски нужен свой.
    conn.create_function('lower_u', 1, lambda v: v.lower() if isinstance(v, str) else v, deterministic=True)
    return conn


def get_db():
    if 'db' not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def init_db():
    conn = connect()
    try:
        conn.execute('PRAGMA journal_mode = WAL')
        conn.execute('''CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            salary REAL DEFAULT 0,
            rent_expense REAL DEFAULT 0,
            salary_day INTEGER DEFAULT 1,
            rent_day INTEGER DEFAULT 1,
            financial_goal REAL DEFAULT 5000
        )''')
        conn.execute('''CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            amount REAL NOT NULL,
            category TEXT NOT NULL,
            date TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )''')
        # Миграция старых баз: добавляем недостающие колонки, ничего не удаляя.
        existing = {row[1] for row in conn.execute('PRAGMA table_info(users)')}
        for column, col_type in {
            'email': 'TEXT',
            'last_notifications': 'TEXT',
            'financial_goal': 'REAL DEFAULT 5000',
            'theme': 'TEXT',
            'terms_accepted_at': 'TEXT',
            'terms_version': 'TEXT',
        }.items():
            if column not in existing:
                conn.execute(f'ALTER TABLE users ADD COLUMN {column} {col_type}')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date)')
        # Серверные сессии: в куке только случайный токен, в базе — его хеш.
        # Выход удаляет запись, и украденная кука перестаёт работать.
        conn.execute('''CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )''')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)')
        if 'note' not in {row[1] for row in conn.execute('PRAGMA table_info(transactions)')}:
            conn.execute('ALTER TABLE transactions ADD COLUMN note TEXT')
        conn.execute('''CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            UNIQUE (user_id, type, name),
            FOREIGN KEY (user_id) REFERENCES users (id)
        )''')
        conn.execute('''CREATE TABLE IF NOT EXISTS budgets (
            user_id INTEGER NOT NULL,
            category TEXT NOT NULL,
            amount REAL NOT NULL,
            PRIMARY KEY (user_id, category),
            FOREIGN KEY (user_id) REFERENCES users (id)
        )''')
        conn.execute('''CREATE TABLE IF NOT EXISTS recurring (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            amount REAL NOT NULL,
            category TEXT NOT NULL,
            day INTEGER NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            start_month TEXT NOT NULL,
            last_applied TEXT,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )''')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring(user_id)')
        remove_legacy_demo(conn)
        conn.commit()
    finally:
        conn.close()


def delete_user(conn, user_id):
    for table in ('sessions', 'transactions', 'categories', 'budgets', 'recurring'):
        conn.execute(f'DELETE FROM {table} WHERE user_id = ?', (user_id,))
    conn.execute('DELETE FROM users WHERE id = ?', (user_id,))


def remove_legacy_demo(conn):
    """Демо-режим убран. Удаляем общий аккаунт, только если у него всё ещё публичный пароль."""
    row = conn.execute('SELECT id, password FROM users WHERE username = ?', (_LEGACY_DEMO[0],)).fetchone()
    if row and check_password_hash(row['password'], _LEGACY_DEMO[1]):
        delete_user(conn, row['id'])
        log.info('Удалён старый демо-аккаунт с публичным паролем.')


init_db()

# ============================================================
#  Общие помощники
# ============================================================
def api_error(message, status=400):
    return jsonify(error=message), status


def json_body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def text(value, max_len=256):
    """Строка из JSON или пустая строка: списки, объекты и числа не пролезут дальше."""
    return value[:max_len] if isinstance(value, str) else ''


def to_number(value, *, minimum=0.0, maximum=MAX_AMOUNT):
    """Число в заданных пределах или ValueError (для любого мусора на входе)."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError
    if number != number or number < minimum or number > maximum:  # NaN, ±inf и границы
        raise ValueError
    return round(number, 2)


def to_day(value):
    day = to_number(value, minimum=1, maximum=31)
    if day != int(day):
        raise ValueError
    return int(day)


def iso(dt_text):
    """'2026-07-01 17:56:49' → '2026-07-01T17:56:49' (одинаково читается всеми браузерами)."""
    return dt_text.replace(' ', 'T', 1) if dt_text else dt_text


def month_start(today=None):
    today = today or date.today()
    return today.replace(day=1).strftime('%Y-%m-%d')


def client_ip():
    # С TRUST_PROXY=1 ProxyFix уже подставил реальный адрес из X-Forwarded-For.
    return request.remote_addr or 'unknown'


def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def current_user():
    """(id, username) по серверной сессии или None. Любая ошибка = нет доступа (fail closed)."""
    if 'auth_user' in g:
        return g.auth_user
    g.auth_user = None
    token = session.get('sid')
    if isinstance(token, str) and token:
        row = get_db().execute('''SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
                                  WHERE s.token_hash = ? AND s.expires_at > ?''',
                               (_token_hash(token), time.time())).fetchone()
        if row:
            g.auth_user = row
        else:
            session.clear()
    return g.auth_user


def current_user_id():
    user = current_user()
    return user['id'] if user else None


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user:
            return api_error('Сессия истекла. Войдите снова.', 401)
        g.user_id = user['id']
        return view(*args, **kwargs)
    return wrapper


# ============================================================
#  Защита: CSRF, заголовки, ограничение попыток
# ============================================================
@app.before_request
def force_https():
    # В production весь сайт только по HTTPS (защита от перехвата и SSL stripping).
    if IS_PROD and not request.is_secure and os.environ.get('FORCE_HTTPS', '1') == '1':
        if request.method in ('GET', 'HEAD'):
            return app.redirect(request.url.replace('http://', 'https://', 1), 308)
        return api_error('Используйте HTTPS.', 403)


@app.before_request
def csrf_guard():
    # Изменяющие запросы к API принимаются только из нашего фронтенда:
    # нестандартный заголовок нельзя отправить с чужого сайта без CORS, а CORS мы не разрешаем.
    # Дополнительно сверяем Origin, если браузер его прислал.
    if request.path.startswith('/api/') and request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('Origin')
        if request.headers.get('X-Requested-With') != 'akysaya' or (origin and origin != request.host_url.rstrip('/')):
            audit('csrf_rejected', logging.WARNING, path=request.path, origin=origin)
            return api_error('Запрос отклонён.', 403)


CSP = '; '.join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


@app.after_request
def security_headers(resp):
    resp.headers.setdefault('Content-Security-Policy', CSP)
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    resp.headers.setdefault('X-Frame-Options', 'DENY')
    resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    resp.headers.setdefault('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    resp.headers.setdefault('Cross-Origin-Opener-Policy', 'same-origin')
    if request.path.startswith('/api/'):
        resp.headers['Cache-Control'] = 'no-store'
    if IS_PROD:
        resp.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    return resp


# Ограничения: по IP (5 неудач за 5 минут) и по аккаунту (10 неудач за 15 минут —
# против подбора пароля с множества адресов).
LIMITS = {'ip': (5, 300), 'user': (10, 900)}
_MAX_TRACKED = 50_000
_attempts = OrderedDict()
_attempts_lock = threading.Lock()


def rate_limited(key, kind='ip'):
    limit, window = LIMITS[kind]
    now = time.time()
    with _attempts_lock:
        recent = [t for t in _attempts.get(key, ()) if now - t < window]
        if recent:
            _attempts[key] = recent
            _attempts.move_to_end(key)
        else:
            _attempts.pop(key, None)
        return len(recent) >= limit


def record_attempt(key):
    with _attempts_lock:
        _attempts.setdefault(key, []).append(time.time())
        _attempts.move_to_end(key)
        # Вытесняем самые давние записи, а не сбрасываем всё: при наплыве запросов
        # счётчики активных атак не обнуляются (fail closed).
        while len(_attempts) > _MAX_TRACKED:
            _attempts.popitem(last=False)


def user_key(username):
    return 'user:' + username.strip().lower()


# Хеш-заглушка: проверяем пароль даже для несуществующего логина,
# чтобы по времени ответа нельзя было узнать, есть ли такой пользователь.
_DUMMY_HASH = generate_password_hash(secrets.token_hex(16))


# ---------- Капча: картинка с искажённым текстом, рисуется на сервере ----------
# Ответ хранится только на сервере (в куке лишь случайный id), проверяется один раз
# и живёт 10 минут. Его нельзя прочитать из куки или повторить со старой кукой.
CAPTCHA_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'   # без похожих 0/O, 1/I/L
CAPTCHA_LEN = 5
CAPTCHA_TTL = 600
CAPTCHA_SIZE = (200, 70)
_CAPTCHA_MAX = 20_000
_captchas = OrderedDict()        # id -> (форма, HMAC ответа, срок)
_captcha_lock = threading.Lock()
_CAPTCHA_KEY = secrets.token_bytes(32)
_CAPTCHA_BG = (14, 14, 20)
_CAPTCHA_COLORS = [(186, 167, 255), (112, 184, 255), (99, 224, 164), (255, 214, 10),
                   (255, 149, 146), (236, 236, 240)]


def _captcha_digest(answer):
    return hmac.new(_CAPTCHA_KEY, answer.encode(), hashlib.sha256).digest()


def _captcha_font(size):
    try:
        return ImageFont.load_default(size=size)
    except (TypeError, OSError):   # Pillow без FreeType
        return ImageFont.load_default()


def render_captcha(answer):
    """PNG: символы разного размера и наклона, волновое искажение, линии и шум."""
    rnd = secrets.SystemRandom()
    width, height = CAPTCHA_SIZE
    img = Image.new('RGB', (width, height), _CAPTCHA_BG)
    draw = ImageDraw.Draw(img)
    for _ in range(160):
        shade = rnd.randint(40, 90)
        draw.point((rnd.randrange(width), rnd.randrange(height)), fill=(shade, shade, shade + 20))

    x = rnd.uniform(10, 20)
    step = (width - 34) / CAPTCHA_LEN
    for ch in answer:
        tile = Image.new('RGBA', (60, 70), (0, 0, 0, 0))
        color = rnd.choice(_CAPTCHA_COLORS) + (255,)
        ImageDraw.Draw(tile).text((12, 4), ch, font=_captcha_font(rnd.randint(34, 42)), fill=color,
                                  stroke_width=1, stroke_fill=color)
        tile = tile.rotate(rnd.uniform(-28, 28), resample=Image.BICUBIC)
        img.paste(tile, (int(x) - 10, rnd.randint(-2, 6)), tile)
        x += step + rnd.uniform(-4, 3)

    # Волна: сдвигаем столбцы пикселей по синусоиде.
    amp, period, phase = rnd.uniform(3, 5), rnd.uniform(45, 75), rnd.uniform(0, math.tau)
    wavy = Image.new('RGB', (width, height), _CAPTCHA_BG)
    for col in range(width):
        shift = int(amp * math.sin(col / period * math.tau + phase))
        wavy.paste(img.crop((col, 0, col + 1, height)), (col, shift))
    draw = ImageDraw.Draw(wavy)
    for _ in range(3):  # линии поверх текста
        points = [(width * i // 4, rnd.randint(8, height - 8)) for i in range(5)]
        draw.line(points, fill=rnd.choice(_CAPTCHA_COLORS), width=rnd.randint(1, 2))
    for _ in range(25):
        px, py = rnd.randrange(width), rnd.randrange(height)
        draw.ellipse((px, py, px + 2, py + 2), fill=rnd.choice(_CAPTCHA_COLORS))
    wavy = wavy.filter(ImageFilter.SMOOTH)

    buf = io.BytesIO()
    wavy.save(buf, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def new_captcha(kind):
    answer = ''.join(secrets.choice(CAPTCHA_ALPHABET) for _ in range(CAPTCHA_LEN))
    captcha_id = secrets.token_urlsafe(16)
    now = time.time()
    with _captcha_lock:
        old = session.get(f'captcha_{kind}')
        if isinstance(old, str):
            _captchas.pop(old, None)
        _captchas[captcha_id] = (kind, _captcha_digest(answer), now + CAPTCHA_TTL)
        # Просроченные лежат в начале очереди; при переполнении вытесняем самые старые.
        while _captchas and (len(_captchas) > _CAPTCHA_MAX or next(iter(_captchas.values()))[2] <= now):
            _captchas.popitem(last=False)
    session[f'captcha_{kind}'] = captcha_id
    return render_captcha(answer)


def captcha_ok(kind, answer):
    captcha_id = session.pop(f'captcha_{kind}', None)
    if not isinstance(captcha_id, str):
        return False
    with _captcha_lock:
        entry = _captchas.pop(captcha_id, None)   # одноразовая: удаляем при любой попытке
    if not entry or entry[0] != kind or entry[2] < time.time():
        return False
    given = text(answer, 16).strip().upper().replace(' ', '')
    return hmac.compare_digest(entry[1], _captcha_digest(given))


def password_problem(password):
    if len(password) < 8:
        return 'Пароль должен содержать минимум 8 символов.'
    if len(password) > 128:
        return 'Пароль слишком длинный.'
    if not re.search(r'[A-ZА-ЯЁ]', password):
        return 'Пароль должен содержать хотя бы одну заглавную букву.'
    if not re.search(r'\d', password):
        return 'Пароль должен содержать хотя бы одну цифру.'
    return None


# ============================================================
#  Сериализация
# ============================================================
SETTINGS_COLUMNS = 'salary, rent_expense, salary_day, rent_day, email, financial_goal'


def settings_dict(row):
    return {
        'salary': row['salary'] or 0,
        'rent_expense': row['rent_expense'] or 0,
        'salary_day': row['salary_day'] or 1,
        'rent_day': row['rent_day'] or 1,
        'email': row['email'] or '',
        'financial_goal': row['financial_goal'] if row['financial_goal'] is not None else DEFAULT_GOAL,
    }


def theme_dict(raw):
    try:
        theme = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        return None
    return theme if isinstance(theme, dict) else None


def tx_dict(row):
    return {
        'id': row['id'],
        'type': row['type'],
        'amount': row['amount'],
        'category': row['category'],
        'date': iso(row['date']),
        'note': row['note'] or '',
    }


def start_session(user, remember):
    """Новый случайный токен на каждый вход (защита от фиксации сессии)."""
    conn = get_db()
    now = time.time()
    old = session.get('sid')
    if isinstance(old, str):
        conn.execute('DELETE FROM sessions WHERE token_hash = ?', (_token_hash(old),))
    conn.execute('DELETE FROM sessions WHERE expires_at <= ?', (now,))
    token = secrets.token_urlsafe(32)
    ttl = SESSION_TTL_REMEMBER if remember else SESSION_TTL_DEFAULT
    conn.execute('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
                 (_token_hash(token), user['id'], now, now + ttl))
    conn.commit()
    session.clear()
    session.permanent = bool(remember)
    session['sid'] = token
    g.pop('auth_user', None)


def end_session():
    token = session.get('sid')
    if isinstance(token, str):
        conn = get_db()
        conn.execute('DELETE FROM sessions WHERE token_hash = ?', (_token_hash(token),))
        conn.commit()
    session.clear()
    g.pop('auth_user', None)


# ============================================================
#  Страница
# ============================================================
@app.get('/')
def index():
    return render_template('index.html', legal_owner=LEGAL_OWNER, legal_email=LEGAL_EMAIL,
                           terms_version_human=datetime.strptime(TERMS_VERSION, '%Y-%m-%d').strftime('%d.%m.%Y'),
                           year=date.today().year)


# Старые адреса из серверной версии ведут в соответствующие разделы SPA.
for _old, _page in {'welcome': 'welcome', 'login': 'login', 'register': 'register',
                    'dashboard': 'dashboard', 'history': 'history', 'add': 'add',
                    'settings': 'settings', 'privacy': 'privacy', 'terms': 'terms'}.items():
    app.add_url_rule(f'/{_old}', f'legacy_{_old}',
                     (lambda p: lambda: app.redirect(f'/#{p}'))(_page))


# ============================================================
#  API: авторизация
# ============================================================
@app.get('/api/me')
def api_me():
    user_id = current_user_id()
    if not user_id:
        return jsonify(user=None)
    row = get_db().execute(f'SELECT id, username, theme, {SETTINGS_COLUMNS} FROM users WHERE id = ?',
                           (user_id,)).fetchone()
    return jsonify(user={'id': row['id'], 'username': row['username']},
                   settings=settings_dict(row), theme=theme_dict(row['theme']))


@app.get('/api/captcha/<kind>')
def api_captcha(kind):
    if kind not in ('login', 'register'):
        return api_error('Неизвестная форма.', 404)
    return jsonify(image=new_captcha(kind))


@app.post('/api/login')
def api_login():
    ip = client_ip()
    if rate_limited(f'auth:{ip}'):
        return api_error('Слишком много попыток. Подождите 5 минут.', 429)
    data = json_body()
    if data.get('website'):  # скрытое поле-ловушка: человек его не видит и не заполняет
        record_attempt(f'auth:{ip}')
        audit('login_honeypot', logging.WARNING)
        return api_error('Запрос отклонён.', 400)
    if not captcha_ok('login', data.get('captcha')):
        record_attempt(f'auth:{ip}')
        audit('login_bad_captcha', logging.WARNING)
        return api_error('Неверный код с картинки. Введите новый.')

    username = text(data.get('username'), 64).strip()
    password = text(data.get('password'), 256)
    if rate_limited(user_key(username), 'user'):
        audit('login_account_locked', logging.WARNING, username=username)
        return api_error('Слишком много попыток для этого аккаунта. Подождите 15 минут.', 429)

    user = get_db().execute('SELECT id, username, password FROM users WHERE username = ?',
                            (username,)).fetchone()
    valid = check_password_hash(user['password'] if user else _DUMMY_HASH, password)
    if not user or not valid:
        record_attempt(f'auth:{ip}')
        record_attempt(user_key(username))
        audit('login_failed', logging.WARNING, username=username)
        return api_error('Неверное имя пользователя или пароль.', 401)

    start_session(user, data.get('remember') is True)
    audit('login_ok', user_id=user['id'])
    return jsonify(user={'id': user['id'], 'username': user['username']})


@app.post('/api/register')
def api_register():
    ip = client_ip()
    if rate_limited(f'auth:{ip}'):
        return api_error('Слишком много попыток. Подождите 5 минут.', 429)
    data = json_body()
    if data.get('website'):
        record_attempt(f'auth:{ip}')
        audit('register_honeypot', logging.WARNING)
        return api_error('Запрос отклонён.', 400)
    if not captcha_ok('register', data.get('captcha')):
        record_attempt(f'auth:{ip}')
        audit('register_bad_captcha', logging.WARNING)
        return api_error('Неверный код с картинки. Введите новый.')
    if data.get('accept_terms') is not True:
        return api_error('Чтобы создать аккаунт, примите условия использования и политику конфиденциальности.')

    username = text(data.get('username'), 64).strip()
    password = text(data.get('password'), 256)
    if not 3 <= len(username) <= 32:
        return api_error('Имя пользователя должно быть от 3 до 32 символов.')
    if any(ch.isspace() for ch in username) or any(ord(ch) < 32 for ch in username):
        return api_error('Имя пользователя не должно содержать пробелов.')
    problem = password_problem(password)
    if problem:
        return api_error(problem)
    if password != text(data.get('confirm_password'), 256):
        return api_error('Пароли не совпадают.')

    conn = get_db()
    try:
        cur = conn.execute('''INSERT INTO users (username, password, financial_goal, terms_accepted_at, terms_version)
                              VALUES (?, ?, ?, ?, ?)''',
                           (username, generate_password_hash(password), DEFAULT_GOAL,
                            datetime.now().strftime(DATE_FMT), TERMS_VERSION))
        conn.commit()
    except sqlite3.IntegrityError:
        record_attempt(f'auth:{ip}')
        return api_error('Это имя пользователя уже занято.', 409)

    record_attempt(f'auth:{ip}')  # ограничиваем и массовую регистрацию с одного адреса
    start_session({'id': cur.lastrowid, 'username': username}, remember=True)
    audit('register_ok', user_id=cur.lastrowid, username=username)
    return jsonify(user={'id': cur.lastrowid, 'username': username}), 201


@app.post('/api/logout')
def api_logout():
    user_id = current_user_id()
    end_session()
    if user_id:
        audit('logout', user_id=user_id)
    return jsonify(ok=True)


@app.delete('/api/account')
@login_required
def api_account_delete():
    """Удаление аккаунта и всех данных. Нужен текущий пароль (защита от чужого открытого браузера)."""
    ip = client_ip()
    if rate_limited(f'auth:{ip}'):
        return api_error('Слишком много попыток. Подождите 5 минут.', 429)
    conn = get_db()
    row = conn.execute('SELECT password FROM users WHERE id = ?', (g.user_id,)).fetchone()
    if not row or not check_password_hash(row['password'], text(json_body().get('password'), 256)):
        record_attempt(f'auth:{ip}')
        audit('account_delete_bad_password', logging.WARNING, user_id=g.user_id)
        return api_error('Неверный пароль.', 403)
    delete_user(conn, g.user_id)
    conn.commit()
    audit('account_deleted', user_id=g.user_id)
    session.clear()
    g.pop('auth_user', None)
    return jsonify(ok=True)


# ============================================================
#  API: настройки, цель, тема
# ============================================================
@app.get('/api/settings')
@login_required
def api_settings_get():
    row = get_db().execute(f'SELECT {SETTINGS_COLUMNS} FROM users WHERE id = ?', (g.user_id,)).fetchone()
    return jsonify(settings=settings_dict(row))


@app.put('/api/settings')
@login_required
def api_settings_put():
    data = json_body()
    try:
        salary = to_number(data.get('salary') or 0)
        rent = to_number(data.get('rent_expense') or 0)
        salary_day = to_day(data.get('salary_day') or 1)
        rent_day = to_day(data.get('rent_day') or 1)
    except (TypeError, ValueError):
        return api_error('Проверьте корректность чисел: суммы ≥ 0, дни от 1 до 31.')
    email = text(data.get('email'), 300).strip()
    if email and (len(email) > 254 or not EMAIL_RE.match(email)):
        return api_error('Некорректный email.')

    conn = get_db()
    conn.execute('''UPDATE users SET salary = ?, rent_expense = ?, salary_day = ?, rent_day = ?, email = ?
                    WHERE id = ?''', (salary, rent, salary_day, rent_day, email or None, g.user_id))
    conn.commit()
    return api_settings_get()


@app.put('/api/goal')
@login_required
def api_goal():
    try:
        goal = to_number(json_body().get('goal'))
    except (TypeError, ValueError):
        return api_error('Некорректное значение цели.')
    conn = get_db()
    conn.execute('UPDATE users SET financial_goal = ? WHERE id = ?', (goal, g.user_id))
    conn.commit()
    return jsonify(goal=goal)


def clean_theme(data):
    bg = text(data.get('bgUrl'), 4096).strip()
    if bg and (len(bg) > 2048 or not re.match(r'^https://[^\s"\'\\<>()]+$', bg, re.I)):
        raise ValueError('Ссылка должна начинаться с https:// и быть не длиннее 2048 символов.')
    try:
        overlay = to_number(data.get('overlay', 0.55), minimum=0.0, maximum=0.9)
    except ValueError:
        overlay = 0.55
    accent = text(data.get('accent'), 16)
    return {'bgUrl': bg, 'overlay': overlay, 'accent': accent if accent in ACCENTS else 'violet'}


@app.put('/api/theme')
@login_required
def api_theme():
    data = json_body()
    try:
        theme = None if data.get('reset') else clean_theme(data)
    except ValueError as exc:
        return api_error(str(exc))
    conn = get_db()
    conn.execute('UPDATE users SET theme = ? WHERE id = ?',
                 (json.dumps(theme, ensure_ascii=False) if theme else None, g.user_id))
    conn.commit()
    return jsonify(theme=theme)


# ============================================================
#  Категории пользователя
# ============================================================
TX_TYPES = ('income', 'expense')
MAX_CATEGORIES = 40           # на один тип операций
MAX_RECURRING = 100
MAX_BUDGETS = 60
MAX_NOTE = 200
MONTH_RE = re.compile(r'^(\d{4})-(0[1-9]|1[0-2])$')
DAY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def clean_name(value, max_len=32):
    """Название категории или платежа: обрезанные пробелы, без управляющих символов."""
    name = ' '.join(text(value, 400).split())[:max_len]
    if not name or any(ord(ch) < 32 for ch in name):
        raise ValueError
    return name


def clean_note(value):
    return ' '.join(text(value, 1000).split())[:MAX_NOTE]


def ensure_categories(conn, user_id):
    """У нового пользователя (и у старых аккаунтов) создаём стандартный набор категорий."""
    if not conn.execute('SELECT 1 FROM categories WHERE user_id = ? LIMIT 1', (user_id,)).fetchone():
        conn.executemany('INSERT OR IGNORE INTO categories (user_id, type, name) VALUES (?, ?, ?)',
                         [(user_id, t, n) for t, names in CATEGORIES.items() for n in names])
        conn.commit()


def user_categories(conn, user_id):
    ensure_categories(conn, user_id)
    rows = conn.execute('SELECT id, type, name FROM categories WHERE user_id = ? ORDER BY id',
                        (user_id,)).fetchall()
    return {
        'income': [r['name'] for r in rows if r['type'] == 'income'],
        'expense': [r['name'] for r in rows if r['type'] == 'expense'],
        'items': [{'id': r['id'], 'type': r['type'], 'name': r['name']} for r in rows],
    }


def add_category(conn, user_id, tx_type, name):
    """True, если категория уже есть или создана; False, если достигнут лимит."""
    ensure_categories(conn, user_id)
    if conn.execute('SELECT 1 FROM categories WHERE user_id = ? AND type = ? AND name = ?',
                    (user_id, tx_type, name)).fetchone():
        return True
    count = conn.execute('SELECT COUNT(*) FROM categories WHERE user_id = ? AND type = ?',
                         (user_id, tx_type)).fetchone()[0]
    if count >= MAX_CATEGORIES:
        return False
    conn.execute('INSERT INTO categories (user_id, type, name) VALUES (?, ?, ?)', (user_id, tx_type, name))
    return True


@app.get('/api/categories')
def api_categories():
    user_id = current_user_id()
    if not user_id:
        return jsonify(income=CATEGORIES['income'], expense=CATEGORIES['expense'], items=[])
    return jsonify(user_categories(get_db(), user_id))


@app.post('/api/categories')
@login_required
def api_categories_add():
    data = json_body()
    tx_type = text(data.get('type'), 16)
    if tx_type not in TX_TYPES:
        return api_error('Некорректный тип операции.')
    try:
        name = clean_name(data.get('name'))
    except ValueError:
        return api_error('Название категории: от 1 до 32 символов.')
    conn = get_db()
    ensure_categories(conn, g.user_id)
    if conn.execute('SELECT 1 FROM categories WHERE user_id = ? AND type = ? AND lower_u(name) = ?',
                    (g.user_id, tx_type, name.lower())).fetchone():
        return api_error('Такая категория уже есть.', 409)
    if not add_category(conn, g.user_id, tx_type, name):
        return api_error(f'Можно создать не больше {MAX_CATEGORIES} категорий одного типа.', 409)
    conn.commit()
    return jsonify(user_categories(conn, g.user_id)), 201


@app.delete('/api/categories/<int:cat_id>')
@login_required
def api_categories_delete(cat_id):
    conn = get_db()
    row = conn.execute('SELECT type, name FROM categories WHERE id = ? AND user_id = ?',
                       (cat_id, g.user_id)).fetchone()
    if not row:
        return api_error('Категория не найдена.', 404)
    left = conn.execute('SELECT COUNT(*) FROM categories WHERE user_id = ? AND type = ?',
                        (g.user_id, row['type'])).fetchone()[0]
    if left <= 1:
        return api_error('Нужна хотя бы одна категория этого типа.', 409)
    if conn.execute('SELECT 1 FROM recurring WHERE user_id = ? AND type = ? AND category = ? LIMIT 1',
                    (g.user_id, row['type'], row['name'])).fetchone():
        return api_error('Категория используется в регулярном платеже. Сначала измените или удалите платёж.', 409)
    conn.execute('DELETE FROM categories WHERE id = ?', (cat_id,))
    if row['type'] == 'expense':
        conn.execute('DELETE FROM budgets WHERE user_id = ? AND category = ?', (g.user_id, row['name']))
    conn.commit()
    # Старые операции сохраняют название категории — история не меняется.
    return jsonify(user_categories(conn, g.user_id))


# ============================================================
#  Месяцы
# ============================================================
def parse_month(value):
    raw = text(value, 7)
    if not raw:
        return date.today().strftime('%Y-%m')
    m = MONTH_RE.match(raw)
    if not m or not 2000 <= int(m.group(1)) <= date.today().year + 1:
        raise ValueError
    return raw


def shift_month(month, delta):
    year, mon = int(month[:4]), int(month[5:7])
    index = year * 12 + (mon - 1) + delta
    return f'{index // 12:04d}-{index % 12 + 1:02d}'


def month_bounds(month):
    return f'{month}-01', f'{shift_month(month, 1)}-01'


def month_summary(conn, user_id, month=None):
    start, end = month_bounds(month or date.today().strftime('%Y-%m'))
    totals = conn.execute('''
        SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
               COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expenses
        FROM transactions WHERE user_id = ? AND date >= ? AND date < ?''', (user_id, start, end)).fetchone()
    categories = conn.execute('''
        SELECT category, SUM(amount) AS total FROM transactions
        WHERE user_id = ? AND type = 'expense' AND date >= ? AND date < ?
        GROUP BY category ORDER BY total DESC''', (user_id, start, end)).fetchall()
    income, expenses = round(totals['income'], 2), round(totals['expenses'], 2)
    return {
        'income': income,
        'expenses': expenses,
        'balance': round(income - expenses, 2),
        'categories': [[r['category'], round(r['total'], 2)] for r in categories],
    }


# ============================================================
#  Регулярные платежи
# ============================================================
def recurring_start_month(day, today=None):
    """Если день платежа в этом месяце ещё не прошёл — начинаем с этого месяца, иначе со следующего."""
    today = today or date.today()
    this_month = today.strftime('%Y-%m')
    due = date(today.year, today.month, min(day, calendar.monthrange(today.year, today.month)[1]))
    return this_month if due >= today else shift_month(this_month, 1)


def apply_recurring(conn, user_id):
    """Добавляет операции по регулярным платежам, срок которых наступил. Повторно не добавляет."""
    today = date.today()
    current = today.strftime('%Y-%m')
    rows = conn.execute('SELECT * FROM recurring WHERE user_id = ? AND active = 1', (user_id,)).fetchall()
    if not rows:
        return 0
    count = conn.execute('SELECT COUNT(*) FROM transactions WHERE user_id = ?', (user_id,)).fetchone()[0]
    added = 0
    for rec in rows:
        month = shift_month(rec['last_applied'], 1) if rec['last_applied'] else rec['start_month']
        last = rec['last_applied']
        for _ in range(24):  # не больше двух лет «догоняющих» платежей за раз
            if month > current or count >= MAX_TX_PER_USER:
                break
            year, mon = int(month[:4]), int(month[5:7])
            due = date(year, mon, min(rec['day'], calendar.monthrange(year, mon)[1]))
            if due > today:
                break
            # Условие на прошлое значение защищает от двойного добавления при параллельных запросах.
            cur = conn.execute('UPDATE recurring SET last_applied = ? WHERE id = ? AND last_applied IS ?',
                               (month, rec['id'], last))
            if cur.rowcount == 0:
                break
            conn.execute('''INSERT INTO transactions (user_id, type, amount, category, date, note)
                            VALUES (?, ?, ?, ?, ?, ?)''',
                         (user_id, rec['type'], rec['amount'], rec['category'], f'{due:%Y-%m-%d} 09:00:00',
                          rec['title']))
            last, month = month, shift_month(month, 1)
            count += 1
            added += 1
    if added:
        conn.commit()
    return added


def recurring_dict(row, today=None):
    today = today or date.today()
    due = next_due(int(row['day']), today)
    if row['last_applied'] and row['last_applied'] >= due.strftime('%Y-%m'):
        nxt = shift_month(due.strftime('%Y-%m'), 1)
        due = next_due(int(row['day']), date(int(nxt[:4]), int(nxt[5:7]), 1))
    return {
        'id': row['id'], 'type': row['type'], 'title': row['title'], 'amount': row['amount'],
        'category': row['category'], 'day': row['day'], 'active': bool(row['active']),
        'next_due': due.isoformat() if row['active'] else None,
    }


def read_recurring_payload(conn, user_id, data, *, create_category=False):
    tx_type = text(data.get('type'), 16)
    if tx_type not in TX_TYPES:
        raise ValueError('Некорректный тип операции.')
    try:
        title = clean_name(data.get('title'), 60)
    except ValueError:
        raise ValueError('Название платежа: от 1 до 60 символов.')
    try:
        amount = to_number(data.get('amount'), minimum=0.01)
    except ValueError:
        raise ValueError('Сумма должна быть больше нуля.')
    try:
        day = to_day(data.get('day'))
    except ValueError:
        raise ValueError('День платежа — число от 1 до 31.')
    try:
        category = clean_name(data.get('category'))
    except ValueError:
        raise ValueError('Некорректная категория.')
    if category not in user_categories(conn, user_id)[tx_type]:
        if not (create_category and add_category(conn, user_id, tx_type, category)):
            raise ValueError('Некорректная категория.')
    return tx_type, title, amount, category, day


def upcoming_payments(conn, user_id, days=14):
    today = date.today()
    out = []
    for row in conn.execute('SELECT * FROM recurring WHERE user_id = ? AND active = 1', (user_id,)):
        item = recurring_dict(row, today)
        left = (date.fromisoformat(item['next_due']) - today).days
        if 0 < left <= days:
            out.append({**item, 'days_left': left})
    return sorted(out, key=lambda x: x['next_due'])


@app.get('/api/recurring')
@login_required
def api_recurring():
    conn = get_db()
    apply_recurring(conn, g.user_id)
    rows = conn.execute('SELECT * FROM recurring WHERE user_id = ? ORDER BY active DESC, day, id',
                        (g.user_id,)).fetchall()
    return jsonify(recurring=[recurring_dict(r) for r in rows])


@app.post('/api/recurring')
@login_required
def api_recurring_add():
    conn = get_db()
    try:
        tx_type, title, amount, category, day = read_recurring_payload(conn, g.user_id, json_body())
    except ValueError as exc:
        return api_error(str(exc))
    if conn.execute('SELECT COUNT(*) FROM recurring WHERE user_id = ?', (g.user_id,)).fetchone()[0] >= MAX_RECURRING:
        return api_error(f'Можно создать не больше {MAX_RECURRING} регулярных платежей.', 409)
    cur = conn.execute('''INSERT INTO recurring (user_id, type, title, amount, category, day, active, start_month)
                          VALUES (?, ?, ?, ?, ?, ?, 1, ?)''',
                       (g.user_id, tx_type, title, amount, category, day, recurring_start_month(day)))
    conn.commit()
    apply_recurring(conn, g.user_id)
    row = conn.execute('SELECT * FROM recurring WHERE id = ?', (cur.lastrowid,)).fetchone()
    return jsonify(recurring=recurring_dict(row)), 201


@app.put('/api/recurring/<int:rec_id>')
@login_required
def api_recurring_update(rec_id):
    conn = get_db()
    row = conn.execute('SELECT * FROM recurring WHERE id = ? AND user_id = ?', (rec_id, g.user_id)).fetchone()
    if not row:
        return api_error('Платёж не найден.', 404)
    data = json_body()
    if set(data) == {'active'}:  # только включить/выключить
        active = data.get('active') is True
        start = row['start_month']
        if active and not row['active']:
            # После паузы не добавляем пропущенные месяцы задним числом.
            start = recurring_start_month(row['day'])
            conn.execute('UPDATE recurring SET last_applied = ? WHERE id = ?', (shift_month(start, -1), rec_id))
        conn.execute('UPDATE recurring SET active = ?, start_month = ? WHERE id = ?', (int(active), start, rec_id))
    else:
        try:
            tx_type, title, amount, category, day = read_recurring_payload(conn, g.user_id, data)
        except ValueError as exc:
            return api_error(str(exc))
        conn.execute('''UPDATE recurring SET type = ?, title = ?, amount = ?, category = ?, day = ?
                        WHERE id = ?''', (tx_type, title, amount, category, day, rec_id))
    conn.commit()
    apply_recurring(conn, g.user_id)
    return jsonify(recurring=recurring_dict(conn.execute('SELECT * FROM recurring WHERE id = ?', (rec_id,)).fetchone()))


@app.delete('/api/recurring/<int:rec_id>')
@login_required
def api_recurring_delete(rec_id):
    conn = get_db()
    cur = conn.execute('DELETE FROM recurring WHERE id = ? AND user_id = ?', (rec_id, g.user_id))
    conn.commit()
    if cur.rowcount == 0:
        return api_error('Платёж не найден.', 404)
    return jsonify(ok=True)


# ============================================================
#  Бюджеты по категориям
# ============================================================
def user_budgets(conn, user_id):
    return {r['category']: r['amount'] for r in conn.execute(
        'SELECT category, amount FROM budgets WHERE user_id = ? ORDER BY category', (user_id,))}


@app.get('/api/budgets')
@login_required
def api_budgets():
    return jsonify(budgets=user_budgets(get_db(), g.user_id))


@app.put('/api/budgets')
@login_required
def api_budgets_put():
    """Тело: {"budgets": {"Еда": 15000, "Транспорт": 0}}. Ноль или пусто — бюджет убрать."""
    items = json_body().get('budgets')
    if not isinstance(items, dict) or len(items) > MAX_BUDGETS:
        return api_error('Некорректные данные бюджетов.')
    conn = get_db()
    allowed = set(user_categories(conn, g.user_id)['expense'])
    for name, value in items.items():
        if name not in allowed:
            return api_error(f'Нет такой категории расходов: {name[:32]}.')
        try:
            amount = to_number(value or 0)
        except ValueError:
            return api_error(f'Некорректная сумма бюджета для «{name}».')
        if amount > 0:
            conn.execute('''INSERT INTO budgets (user_id, category, amount) VALUES (?, ?, ?)
                            ON CONFLICT(user_id, category) DO UPDATE SET amount = excluded.amount''',
                         (g.user_id, name, amount))
        else:
            conn.execute('DELETE FROM budgets WHERE user_id = ? AND category = ?', (g.user_id, name))
    conn.commit()
    return jsonify(budgets=user_budgets(conn, g.user_id))


# ============================================================
#  API: дашборд и операции
# ============================================================
@app.get('/api/dashboard')
@login_required
def api_dashboard():
    try:
        month = parse_month(request.args.get('month'))
    except ValueError:
        return api_error('Некорректный месяц.')
    conn = get_db()
    apply_recurring(conn, g.user_id)
    summary = month_summary(conn, g.user_id, month)
    prev = month_summary(conn, g.user_id, shift_month(month, -1))

    # Доходы и расходы за 6 месяцев, заканчивая выбранным.
    first = shift_month(month, -5)
    series = {shift_month(first, i): {'income': 0.0, 'expenses': 0.0} for i in range(6)}
    for r in conn.execute('''SELECT substr(date, 1, 7) AS ym, type, SUM(amount) AS total FROM transactions
                             WHERE user_id = ? AND date >= ? AND date < ? GROUP BY ym, type''',
                          (g.user_id, f'{first}-01', month_bounds(month)[1])):
        if r['ym'] in series:
            series[r['ym']]['income' if r['type'] == 'income' else 'expenses'] = round(r['total'], 2)

    spent = dict(summary['categories'])
    budgets = [{'category': cat, 'amount': amount, 'spent': round(spent.get(cat, 0), 2),
                'percent': round(spent.get(cat, 0) / amount * 100, 1) if amount else 0}
               for cat, amount in user_budgets(conn, g.user_id).items()]
    budgets.sort(key=lambda b: -b['percent'])

    today_month = date.today().strftime('%Y-%m')
    months = {today_month, month}
    months.update(r[0] for r in conn.execute(
        'SELECT DISTINCT substr(date, 1, 7) FROM transactions WHERE user_id = ? ORDER BY 1 DESC LIMIT 36',
        (g.user_id,)))
    row = conn.execute(f'SELECT {SETTINGS_COLUMNS} FROM users WHERE id = ?', (g.user_id,)).fetchone()
    schedule_notifications(g.user_id)
    return jsonify(totals={k: summary[k] for k in ('income', 'expenses', 'balance')},
                   prev={k: prev[k] for k in ('income', 'expenses', 'balance')},
                   categories=summary['categories'], budgets=budgets,
                   series=[{'month': m, **v} for m, v in series.items()],
                   upcoming=upcoming_payments(conn, g.user_id),
                   months=sorted((m for m in months if m <= max(today_month, month)), reverse=True),
                   settings=settings_dict(row), month=month, current_month=today_month)


def like_pattern(query):
    escaped = query.lower().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    return f'%{escaped}%'


@app.get('/api/transactions')
@login_required
def api_transactions():
    args = request.args
    try:
        limit = min(max(int(args.get('limit', 100)), 1), 1000)
        offset = min(max(int(args.get('offset', 0)), 0), 10_000_000)
    except ValueError:
        limit, offset = 100, 0
    conn = get_db()
    apply_recurring(conn, g.user_id)

    where, params = ['user_id = ?'], [g.user_id]
    query = text(args.get('q'), 100).strip()
    if query:
        where.append("(lower_u(category) LIKE ? ESCAPE '\\' OR lower_u(COALESCE(note, '')) LIKE ? ESCAPE '\\')")
        params += [like_pattern(query)] * 2
    tx_type = text(args.get('type'), 16)
    if tx_type in TX_TYPES:
        where.append('type = ?')
        params.append(tx_type)
    category = text(args.get('category'), 64)
    if category:
        where.append('category = ?')
        params.append(category)
    for key, op, suffix in (('from', '>=', ''), ('to', '<=', ' 23:59:59')):
        value = text(args.get(key), 10)
        if value and DAY_RE.match(value):
            where.append(f'date {op} ?')
            params.append(value + suffix)
    cond = ' AND '.join(where)

    rows = conn.execute(f'''SELECT id, type, amount, category, date, note FROM transactions WHERE {cond}
                            ORDER BY date DESC, id DESC LIMIT ? OFFSET ?''', (*params, limit, offset)).fetchall()
    stats = conn.execute(f'''SELECT COUNT(*) AS n,
                                    COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
                                    COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expenses
                             FROM transactions WHERE {cond}''', params).fetchone()
    return jsonify(transactions=[tx_dict(r) for r in rows], total=stats['n'],
                   sum_income=round(stats['income'], 2), sum_expense=round(stats['expenses'], 2),
                   has_more=offset + len(rows) < stats['n'])


def parse_tx_date(value, keep=None):
    """'YYYY-MM-DD' → строка даты для БД. Сегодняшний день получает текущее время.

    При редактировании (keep) тот же день сохраняет исходное время операции.
    """
    now = datetime.now()
    if not value:
        if keep:
            return keep
        return now.strftime(DATE_FMT)
    if keep and value[:10] == keep[:10]:
        return keep
    day = datetime.strptime(str(value)[:10], '%Y-%m-%d').date()
    if day > now.date() + timedelta(days=1) or day.year < 2000:
        raise ValueError
    if day == now.date():
        return now.strftime(DATE_FMT)
    return f'{day:%Y-%m-%d} 12:00:00'


def read_tx_payload(conn, user_id, data, original=None):
    tx_type = text(data.get('type'), 16)
    category = text(data.get('category'), 64)
    if tx_type not in TX_TYPES:
        raise ValueError('Некорректный тип операции.')
    keeps_old = bool(original) and original['type'] == tx_type and original['category'] == category
    if category not in user_categories(conn, user_id)[tx_type] and not keeps_old:
        raise ValueError('Некорректная категория.')
    try:
        amount = to_number(data.get('amount'), minimum=0.01)
    except ValueError:
        raise ValueError('Сумма должна быть больше нуля.')
    try:
        tx_date = parse_tx_date(text(data.get('date'), 32), keep=original['date'] if original else None)
    except (TypeError, ValueError):
        raise ValueError('Некорректная дата.')
    return tx_type, amount, category, tx_date, clean_note(data.get('note'))


def tx_row(conn, tx_id):
    return conn.execute('SELECT id, type, amount, category, date, note FROM transactions WHERE id = ?',
                        (tx_id,)).fetchone()


@app.post('/api/transactions')
@login_required
def api_transactions_add():
    conn = get_db()
    try:
        values = read_tx_payload(conn, g.user_id, json_body())
    except ValueError as exc:
        return api_error(str(exc))
    count = conn.execute('SELECT COUNT(*) FROM transactions WHERE user_id = ?', (g.user_id,)).fetchone()[0]
    if count >= MAX_TX_PER_USER:
        return api_error('Достигнут лимит количества операций для этого аккаунта.', 409)
    cur = conn.execute('INSERT INTO transactions (user_id, type, amount, category, date, note) VALUES (?, ?, ?, ?, ?, ?)',
                       (g.user_id, *values))
    conn.commit()
    return jsonify(transaction=tx_dict(tx_row(conn, cur.lastrowid))), 201


@app.put('/api/transactions/<int:tx_id>')
@login_required
def api_transactions_update(tx_id):
    conn = get_db()
    original = conn.execute('SELECT type, category, date FROM transactions WHERE id = ? AND user_id = ?',
                            (tx_id, g.user_id)).fetchone()
    if not original:
        audit('tx_update_denied', logging.WARNING, user_id=g.user_id, tx_id=tx_id)
        return api_error('Операция не найдена.', 404)
    try:
        values = read_tx_payload(conn, g.user_id, json_body(), original)
    except ValueError as exc:
        return api_error(str(exc))
    conn.execute('''UPDATE transactions SET type = ?, amount = ?, category = ?, date = ?, note = ?
                    WHERE id = ? AND user_id = ?''', (*values, tx_id, g.user_id))
    conn.commit()
    return jsonify(transaction=tx_dict(tx_row(conn, tx_id)))


@app.delete('/api/transactions/<int:tx_id>')
@login_required
def api_transactions_delete(tx_id):
    conn = get_db()
    cur = conn.execute('DELETE FROM transactions WHERE id = ? AND user_id = ?', (tx_id, g.user_id))
    conn.commit()
    if cur.rowcount == 0:
        audit('tx_delete_denied', logging.WARNING, user_id=g.user_id, tx_id=tx_id)
        return api_error('Операция не найдена.', 404)
    audit('tx_deleted', user_id=g.user_id, tx_id=tx_id)
    return jsonify(ok=True)


# ============================================================
#  API: резервная копия
# ============================================================
@app.get('/api/export')
@login_required
def api_export():
    conn = get_db()
    user = conn.execute(f'SELECT username, theme, {SETTINGS_COLUMNS} FROM users WHERE id = ?',
                        (g.user_id,)).fetchone()
    rows = conn.execute('SELECT id, type, amount, category, date, note FROM transactions WHERE user_id = ? ORDER BY date',
                        (g.user_id,)).fetchall()
    cats = user_categories(conn, g.user_id)['items']
    recurring = conn.execute('SELECT * FROM recurring WHERE user_id = ? ORDER BY id', (g.user_id,)).fetchall()
    return jsonify(app='akysaya', version=3, exported_at=datetime.now().isoformat(timespec='seconds'),
                   username=user['username'], settings=settings_dict(user), theme=theme_dict(user['theme']),
                   categories=[{'type': c['type'], 'name': c['name']} for c in cats],
                   budgets=user_budgets(conn, g.user_id),
                   recurring=[{'type': r['type'], 'title': r['title'], 'amount': r['amount'],
                               'category': r['category'], 'day': r['day'], 'active': bool(r['active'])}
                              for r in recurring],
                   transactions=[tx_dict(r) for r in rows])


def normalize_import_date(value):
    raw = text(value, 40).strip()
    for fmt in ('%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%dT%H:%M:%S', DATE_FMT, '%Y-%m-%d'):
        try:
            return datetime.strptime(raw, fmt).strftime(DATE_FMT)
        except ValueError:
            continue
    raise ValueError


def pick_import_payload(data, username):
    """Возвращает (settings, transactions, theme) из копии новой (v2/v3) или старой браузерной (v1) версии."""
    if data.get('version') in (2, 3) and isinstance(data.get('transactions'), list):
        return data.get('settings'), data['transactions'], data.get('theme')

    users, txs = data.get('users'), data.get('transactions')
    if not isinstance(users, list) or not isinstance(txs, list):
        raise ValueError('Файл не похож на резервную копию Akysaya.')
    # В копиях старой браузерной версии был встроенный пользователь demo, его пропускаем.
    candidates = [u for u in users if isinstance(u, dict) and u.get('username') != _LEGACY_DEMO[0]]
    match = next((u for u in candidates if u.get('username') == username), None)
    if match is None and len(candidates) == 1:
        match = candidates[0]
    if match is None:
        raise ValueError('В копии несколько пользователей, и ни один не совпадает с вашим логином.')
    uid = match.get('id')
    settings = (data.get('settings') or {}).get(str(uid)) if isinstance(data.get('settings'), dict) else None
    return settings, [t for t in txs if isinstance(t, dict) and t.get('user_id') == uid], data.get('theme')


def restore_extras(conn, user_id, data):
    """Категории, бюджеты и регулярные платежи из копии версии 3."""
    cats = data.get('categories')
    if isinstance(cats, list):
        for c in cats[:MAX_CATEGORIES * 2]:
            if isinstance(c, dict) and text(c.get('type'), 16) in TX_TYPES:
                try:
                    add_category(conn, user_id, c['type'], clean_name(c.get('name')))
                except ValueError:
                    continue
    budgets = data.get('budgets')
    if isinstance(budgets, dict):
        allowed = set(user_categories(conn, user_id)['expense'])
        for name, value in list(budgets.items())[:MAX_BUDGETS]:
            try:
                amount = to_number(value)
            except ValueError:
                continue
            if name in allowed and amount > 0:
                conn.execute('''INSERT INTO budgets (user_id, category, amount) VALUES (?, ?, ?)
                                ON CONFLICT(user_id, category) DO UPDATE SET amount = excluded.amount''',
                             (user_id, name, amount))
    recurring = data.get('recurring')
    if isinstance(recurring, list):
        have = {(r['type'], r['title'], r['amount'], r['day']) for r in conn.execute(
            'SELECT type, title, amount, day FROM recurring WHERE user_id = ?', (user_id,))}
        for r in recurring[:MAX_RECURRING]:
            if not isinstance(r, dict) or len(have) >= MAX_RECURRING:
                continue
            try:
                tx_type, title, amount, category, day = read_recurring_payload(conn, user_id, r, create_category=True)
            except ValueError:
                continue
            if (tx_type, title, amount, day) in have:
                continue
            have.add((tx_type, title, amount, day))
            # Восстановленный платёж начинает работать с ближайшей даты, без операций задним числом.
            conn.execute('''INSERT INTO recurring (user_id, type, title, amount, category, day, active, start_month)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                         (user_id, tx_type, title, amount, category, day, int(r.get('active') is not False),
                          recurring_start_month(day)))


@app.post('/api/import')
@login_required
def api_import():
    data = json_body()
    conn = get_db()
    username = conn.execute('SELECT username FROM users WHERE id = ?', (g.user_id,)).fetchone()['username']
    try:
        settings, txs, theme = pick_import_payload(data, username)
    except ValueError as exc:
        return api_error(str(exc))

    if data.get('version') == 3:
        restore_extras(conn, g.user_id, data)
    cats = user_categories(conn, g.user_id)
    known = {t: set(cats[t]) for t in TX_TYPES}
    existing = {(r['type'], round(r['amount'], 2), r['category'], r['date']) for r in conn.execute(
        'SELECT type, amount, category, date FROM transactions WHERE user_id = ?', (g.user_id,))}
    rows, skipped = [], 0
    room = max(0, MAX_TX_PER_USER - len(existing))
    for t in txs[:50_000]:
        if len(rows) >= room:
            skipped += 1
            continue
        try:
            tx_type = text(t.get('type'), 16)
            if tx_type not in TX_TYPES:
                raise ValueError
            category = clean_name(t.get('category'))
            key = (tx_type, to_number(t.get('amount'), minimum=0.01), category,
                   normalize_import_date(t.get('date')))
            note = clean_note(t.get('note'))
        except (TypeError, ValueError, AttributeError):
            skipped += 1
            continue
        if key in existing:
            skipped += 1
            continue
        if category not in known[tx_type]:
            if not add_category(conn, g.user_id, tx_type, category):
                skipped += 1
                continue
            known[tx_type].add(category)
        existing.add(key)
        rows.append((g.user_id, *key, note))
    conn.executemany('INSERT INTO transactions (user_id, type, amount, category, date, note) VALUES (?, ?, ?, ?, ?, ?)',
                     rows)

    if isinstance(settings, dict):
        try:
            conn.execute('''UPDATE users SET salary = ?, rent_expense = ?, salary_day = ?, rent_day = ?,
                            financial_goal = ? WHERE id = ?''',
                         (to_number(settings.get('salary') or 0), to_number(settings.get('rent_expense') or 0),
                          to_day(settings.get('salary_day') or 1), to_day(settings.get('rent_day') or 1),
                          to_number(settings.get('financial_goal') or DEFAULT_GOAL), g.user_id))
        except (TypeError, ValueError):
            pass
    if isinstance(theme, dict) and theme:
        try:
            conn.execute('UPDATE users SET theme = ? WHERE id = ?',
                         (json.dumps(clean_theme(theme), ensure_ascii=False), g.user_id))
        except ValueError:
            pass
    conn.commit()
    audit('import', user_id=g.user_id, imported=len(rows), skipped=skipped)
    return jsonify(imported=len(rows), skipped=skipped)


# ============================================================
#  API: импорт банковской выписки (CSV)
# ============================================================
CSV_MAX_ROWS = 20_000
CSV_MAPPING_KEYS = ('date', 'amount', 'debit', 'credit', 'description', 'category')
CSV_DATE_FORMATS = ('%d.%m.%Y %H:%M:%S', '%d.%m.%Y %H:%M', '%d.%m.%Y', '%d.%m.%y',
                    '%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d',
                    '%d/%m/%Y %H:%M:%S', '%d/%m/%Y', '%d-%m-%Y')
CSV_SKIP_WORDS = ('остаток', 'комисс', 'кешбэк', 'кэшбэк', 'баланс', 'бонус')
# Подсказки для автоматического выбора категории по описанию операции или категории банка.
CATEGORY_KEYWORDS = {
    'expense': [
        ('Еда', ('пятероч', 'пятёроч', 'магнит', 'перекрест', 'лента', 'ашан', 'вкусвилл', 'дикси', 'окей',
                 'продукт', 'супермаркет', 'кафе', 'ресторан', 'фастфуд', 'макдоналдс', 'вкусно и точка', 'kfc',
                 'бургер', 'burger', 'столов', 'пекарн', 'самокат', 'яндекс еда', 'яндекс.еда', 'delivery',
                 'сбермаркет', 'купер', 'азбука вкуса', 'кофе', 'coffee', 'food')),
        ('Транспорт', ('такси', 'taxi', 'uber', 'bolt', 'метро', 'автобус', 'транспорт', 'ржд', 'аэрофлот',
                       'авиа', 'азс', 'топливо', 'бензин', 'лукойл', 'газпромнефть', 'роснефть', 'парковк',
                       'каршеринг', 'делимобиль', 'тройка', 'электрич')),
        ('Развлечения', ('кино', 'netflix', 'spotify', 'steam', 'playstation', 'xbox', 'яндекс плюс', 'okko',
                         'кинопоиск', 'иви', 'театр', 'концерт', 'развлечен', 'хобби', 'игр', 'бар ', 'клуб')),
        ('Одежда', ('одежд', 'обув', 'zara', 'uniqlo', 'lamoda', 'ламода', 'спортмастер', 'gloria jeans')),
        ('Жилье', ('жкх', 'коммунал', 'квартплат', 'аренд', 'ипотек', 'электроэнерг', 'мосэнерго',
                   'водоканал', 'интернет', 'ростелеком', 'связь', 'мтс', 'билайн', 'мегафон', 'теле2', 'домофон')),
        ('Подарки', ('подар', 'цвет', 'flowers')),
    ],
    'income': [
        ('Зарплата', ('зарплат', 'заработн', 'аванс', 'оклад', 'salary', 'премия')),
        ('Фриланс', ('фриланс', 'гонорар', 'freelance', 'самозанят', 'upwork')),
        ('Подарки', ('подар', 'gift')),
    ],
}


class CsvMappingError(ValueError):
    pass


def parse_csv_date(raw):
    s = ' '.join(str(raw).split()).rstrip('Z')
    if not s:
        raise ValueError
    for fmt in CSV_DATE_FORMATS:
        try:
            dt = datetime.strptime(s, fmt)
        except ValueError:
            continue
        if dt.year < 2000 or dt > datetime.now() + timedelta(days=1):
            raise ValueError
        return dt.strftime(DATE_FMT) if '%H' in fmt else dt.strftime('%Y-%m-%d') + ' 12:00:00'
    if len(s) > 19:  # 2026-11-02T10:00:00.000+03:00 и подобные
        return parse_csv_date(s[:19])
    raise ValueError


def is_csv_date(raw):
    try:
        parse_csv_date(raw)
        return True
    except ValueError:
        return False


def parse_csv_amount(raw):
    s = str(raw).strip().replace('−', '-').replace('–', '-')
    if not s or ':' in s:
        raise ValueError
    negative = s.startswith('(') and s.endswith(')')
    s = re.sub(r'[^\d,.\-+]', '', s)       # пробелы, неразрывные пробелы, ₽, RUB
    if not re.search(r'\d', s):
        raise ValueError
    if ',' in s and '.' in s:
        s = s.replace('.', '').replace(',', '.') if s.rfind(',') > s.rfind('.') else s.replace(',', '')
    elif ',' in s:
        s = s.replace(',', '.')
    value = float(s)
    if not math.isfinite(value):
        raise ValueError
    return -abs(value) if negative else value


def optional_amount(raw):
    return abs(parse_csv_amount(raw)) if str(raw).strip() else 0.0


def sniff_delimiter(sample):
    lines = [ln for ln in sample.splitlines()[:15] if ln.strip()]
    best, best_score = ';', 0
    for delim in (';', '\t', ',', '|'):
        counts = [ln.count(delim) for ln in lines]
        score = min(counts) if counts else 0
        if score > best_score:
            best, best_score = delim, score
    return best


def read_statement(csv_text):
    s = csv_text.lstrip('﻿')
    if not s.strip():
        raise ValueError('Файл пуст.')
    delim = sniff_delimiter(s[:20_000])
    try:
        rows = []
        for r in csv.reader(io.StringIO(s), delimiter=delim):
            if any(c.strip() for c in r):
                rows.append(r)
            if len(rows) > CSV_MAX_ROWS + 1:
                raise ValueError(f'Слишком много строк: максимум {CSV_MAX_ROWS}.')
    except csv.Error:
        raise ValueError('Не удалось разобрать CSV-файл.')
    if not rows:
        raise ValueError('Файл пуст.')
    width = min(max(len(r) for r in rows), 60)
    header = not any(is_csv_date(c) for c in rows[0])
    if header:
        cols = [(rows[0][i].strip()[:40] if i < len(rows[0]) else '') or f'Столбец {i + 1}' for i in range(width)]
    else:
        cols = [f'Столбец {i + 1}' for i in range(width)]
    return delim, header, cols, rows[1:] if header else rows


def guess_mapping(cols, header, data):
    low = [c.lower() for c in cols]

    def find(keys):
        for key in keys:
            for i, name in enumerate(low):
                if key in name and not any(w in name for w in CSV_SKIP_WORDS):
                    return i
        return None

    m = dict.fromkeys(CSV_MAPPING_KEYS)
    if header:
        m['date'] = find(('дата операции', 'дата и время', 'дата транзакции', 'дата платежа', 'дата', 'date', 'время'))
        m['debit'] = find(('расход', 'списани', 'дебет', 'debit', 'withdraw'))
        m['credit'] = find(('приход', 'поступлен', 'зачислен', 'кредит', 'credit', 'deposit'))
        if m['debit'] is None or m['credit'] is None:
            m['debit'] = m['credit'] = None
            m['amount'] = find(('сумма операции', 'сумма в валюте счета', 'сумма платежа', 'сумма', 'amount'))
        m['category'] = find(('категория', 'category'))
        m['description'] = find(('описание', 'назначение', 'детали', 'комментарий', 'получатель', 'контрагент',
                                 'merchant', 'description', 'наименование'))
    sample = data[:20]
    if m['date'] is None and sample:
        m['date'] = next((i for i, c in enumerate(sample[0]) if is_csv_date(c)), None)
    if m['amount'] is None and m['debit'] is None and sample:
        for i in range(len(cols)):
            if i == m['date']:
                continue
            try:
                parse_csv_amount(sample[0][i])
                m['amount'] = i
                break
            except (ValueError, IndexError):
                continue
    if m['description'] is None and sample:
        used = {v for v in m.values() if v is not None}
        lengths = {i: sum(len(r[i]) for r in sample if i < len(r)) for i in range(len(cols)) if i not in used}
        if lengths:
            best = max(lengths, key=lengths.get)
            m['description'] = best if lengths[best] else None
    return m


def col_index(value, width):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < width:
        return None
    return value


def pick_category(tx_type, hint, note, names):
    by_lower = {n.lower(): n for n in names}
    if hint and hint.lower() in by_lower:
        return by_lower[hint.lower()]
    haystack = f' {hint} {note} '.lower()
    for cat, keys in CATEGORY_KEYWORDS[tx_type]:
        if cat in names and any(k in haystack for k in keys):
            return cat
    return 'Другое' if 'Другое' in names else names[-1]


def convert_rows(data, m, invert, categories):
    split = m['debit'] is not None and m['credit'] is not None
    if m['date'] is None or (m['amount'] is None and not split):
        raise CsvMappingError('Укажите, в каких столбцах дата и сумма.')
    out = []
    for r in data:
        def cell(i):
            return r[i].strip() if i is not None and i < len(r) else ''
        try:
            tx_date = parse_csv_date(cell(m['date']))
            if split:
                debit, credit = optional_amount(cell(m['debit'])), optional_amount(cell(m['credit']))
                if bool(debit) == bool(credit):
                    raise ValueError
                tx_type, amount = ('expense', debit) if debit else ('income', credit)
            else:
                value = parse_csv_amount(cell(m['amount']))
                if invert:
                    value = -value
                if value == 0:
                    raise ValueError
                tx_type, amount = ('income' if value > 0 else 'expense'), abs(value)
            amount = to_number(amount, minimum=0.01)
        except (ValueError, IndexError):
            continue
        note = clean_note(cell(m['description']))
        out.append({'date': tx_date, 'type': tx_type, 'amount': amount, 'note': note,
                    'category': pick_category(tx_type, cell(m['category'])[:64], note, categories[tx_type])})
    return out


@app.post('/api/import/csv')
@login_required
def api_import_csv():
    """Сначала предпросмотр (dry_run, по умолчанию), затем импорт с тем же сопоставлением столбцов."""
    data = json_body()
    csv_text = data.get('csv')
    if not isinstance(csv_text, str):
        return api_error('Не получен текст выписки.')
    dry_run = data.get('dry_run') is not False
    conn = get_db()
    try:
        delim, header, cols, rows = read_statement(csv_text)
    except ValueError as exc:
        return api_error(str(exc))
    mapping = guess_mapping(cols, header, rows)
    given = data.get('mapping')
    if isinstance(given, dict):
        for key in CSV_MAPPING_KEYS:
            if key in given:
                mapping[key] = col_index(given[key], len(cols))
    meta = {'columns': cols, 'mapping': mapping, 'header': header,
            'delimiter': {'\t': 'tab'}.get(delim, delim), 'sample': [r[:len(cols)] for r in rows[:3]]}
    try:
        items = convert_rows(rows, mapping, data.get('invert') is True, user_categories(conn, g.user_id))
    except CsvMappingError as exc:
        if dry_run:
            return jsonify(**meta, problem=str(exc), preview=[],
                           stats={'rows': len(rows), 'ok': 0, 'duplicates': 0, 'skipped': len(rows),
                                  'income': 0, 'expense': 0})
        return api_error(str(exc))

    existing = {(r['type'], round(r['amount'], 2), r['date']) for r in conn.execute(
        'SELECT type, amount, date FROM transactions WHERE user_id = ?', (g.user_id,))}
    fresh, duplicates = [], 0
    for it in items:
        key = (it['type'], it['amount'], it['date'])
        if key in existing:
            duplicates += 1
            continue
        existing.add(key)
        fresh.append(it)
    skipped = len(rows) - len(items)
    if dry_run:
        return jsonify(**meta, problem=None, preview=fresh[:8], stats={
            'rows': len(rows), 'ok': len(fresh), 'duplicates': duplicates, 'skipped': skipped,
            'income': round(sum(i['amount'] for i in fresh if i['type'] == 'income'), 2),
            'expense': round(sum(i['amount'] for i in fresh if i['type'] == 'expense'), 2)})

    room = max(0, MAX_TX_PER_USER - len(existing) + len(fresh))
    batch = fresh[:room]
    conn.executemany('INSERT INTO transactions (user_id, type, amount, category, date, note) VALUES (?, ?, ?, ?, ?, ?)',
                     [(g.user_id, i['type'], i['amount'], i['category'], i['date'], i['note']) for i in batch])
    conn.commit()
    audit('import_csv', user_id=g.user_id, imported=len(batch), duplicates=duplicates, skipped=skipped)
    return jsonify(imported=len(batch), duplicates=duplicates, skipped=skipped + len(fresh) - len(batch))


# ============================================================
#  API: курсы валют и криптовалют (общий кэш на сервере)
# ============================================================
RATES_TTL = 300
FALLBACK_CURRENCY = {'USD': 1, 'EUR': 0.93, 'GBP': 0.79, 'JPY': 150.25, 'CNY': 7.18, 'RUB': 92.50}
FALLBACK_CRYPTO = {'BTC': 45000, 'ETH': 2500, 'BNB': 320, 'XRP': 0.65, 'ADA': 0.48}
_rates = {'currency': None, 'crypto': None, 'ts': 0.0, 'refreshing': False}
_rates_lock = threading.Lock()
_http = requests.Session()
_http.headers['User-Agent'] = 'Akysaya/2.0'


def _fetch_currency():
    data = _http.get('https://api.exchangerate-api.com/v4/latest/USD', timeout=3).json()['rates']
    return {code: float(data.get(code, FALLBACK_CURRENCY[code])) for code in FALLBACK_CURRENCY}


def _fetch_crypto():
    ids = {'BTC': 'bitcoin', 'ETH': 'ethereum', 'BNB': 'binancecoin', 'XRP': 'ripple', 'ADA': 'cardano'}
    data = _http.get('https://api.coingecko.com/api/v3/simple/price',
                     params={'ids': ','.join(ids.values()), 'vs_currencies': 'usd'}, timeout=3).json()
    return {code: float(data[name]['usd']) for code, name in ids.items()}


def refresh_rates():
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {'currency': pool.submit(_fetch_currency), 'crypto': pool.submit(_fetch_crypto)}
        for name, future in futures.items():
            try:
                value = future.result()
                with _rates_lock:
                    _rates[name] = value
            except Exception as exc:  # сеть, формат ответа, лимиты API
                log.warning('Не удалось обновить курсы (%s): %s', name, exc)
    with _rates_lock:
        _rates['ts'] = time.time()
        _rates['refreshing'] = False


@app.get('/api/rates')
def api_rates():
    with _rates_lock:
        fresh = time.time() - _rates['ts'] < RATES_TTL
        empty = _rates['ts'] == 0
        start_bg = not fresh and not empty and not _rates['refreshing']
        if start_bg:
            _rates['refreshing'] = True
    if empty:
        refresh_rates()                      # первый запрос: ждём (до ~3 с)
    elif start_bg:
        threading.Thread(target=refresh_rates, daemon=True).start()  # остальные: отвечаем сразу
    with _rates_lock:
        return jsonify(currency=_rates['currency'] or FALLBACK_CURRENCY,
                       crypto=_rates['crypto'] or FALLBACK_CRYPTO,
                       live={'currency': bool(_rates['currency']), 'crypto': bool(_rates['crypto'])},
                       updated=int(_rates['ts']))


# ============================================================
#  Email-уведомления (аренда и перерасход)
# ============================================================
_notify_checked = {}
_notify_lock = threading.Lock()


def send_email(to_email, subject, body):
    if not (to_email and EMAIL_USER and EMAIL_PASS):
        return False
    try:
        msg = EmailMessage()
        msg['From'], msg['To'], msg['Subject'] = EMAIL_USER, to_email, subject
        msg.set_content(body)
        with smtplib.SMTP(EMAIL_HOST, EMAIL_PORT, timeout=10) as server:
            server.starttls()
            server.login(EMAIL_USER, EMAIL_PASS)
            server.send_message(msg)
        return True
    except Exception as exc:
        log.error('Не удалось отправить письмо: %s', exc)
        return False


def next_due(day_of_month, today):
    """Ближайшая дата платежа (сегодня или позже) с учётом длины месяца."""
    year, month = today.year, today.month
    for _ in range(2):
        due = date(year, month, min(day_of_month, calendar.monthrange(year, month)[1]))
        if due >= today:
            return due
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return due


def check_notifications(user_id):
    conn = connect()
    try:
        user = conn.execute(f'SELECT {SETTINGS_COLUMNS}, last_notifications FROM users WHERE id = ?',
                            (user_id,)).fetchone()
        if not user or not user['email']:
            return
        try:
            sent = json.loads(user['last_notifications'] or '{}')
        except ValueError:
            sent = {}
        today = date.today()
        changed = False

        if user['rent_expense'] and user['rent_day']:
            due = next_due(int(user['rent_day']), today)
            if 0 < (due - today).days <= 3 and sent.get('rent') != due.isoformat():
                if send_email(user['email'], 'Напоминание: скоро оплата аренды',
                              f'Привет! Оплата аренды {user["rent_expense"]:,.0f} ₽ назначена на '
                              f'{due:%d.%m.%Y}.\n\n— Akysaya'.replace(',', ' ')):
                    sent['rent'] = due.isoformat()
                    changed = True

        # Напоминания о регулярных платежах (подписки, кредиты, коммуналка) за 3 дня.
        reminders = 0
        for rec in conn.execute('SELECT id, title, amount, day FROM recurring WHERE user_id = ? AND active = 1',
                                (user_id,)).fetchall():
            due = next_due(int(rec['day']), today)
            key = f'rec{rec["id"]}'
            if reminders < 5 and 0 < (due - today).days <= 3 and sent.get(key) != due.isoformat():
                if send_email(user['email'], f'Напоминание: скоро платёж «{rec["title"]}»',
                              f'Привет! Платёж «{rec["title"]}» на {rec["amount"]:,.0f} ₽ назначен на '
                              f'{due:%d.%m.%Y}. Akysaya добавит его в операции автоматически.\n\n— Akysaya'
                              .replace(',', ' ')):
                    sent[key] = due.isoformat()
                    changed = True
                    reminders += 1

        summary = month_summary(conn, user_id)
        base = max(summary['income'], user['salary'] or 0)
        month = today.strftime('%Y-%m')
        if base > 0 and summary['expenses'] > base and sent.get('overspend') != month:
            if send_email(user['email'], 'Akysaya: расходы превысили доход',
                          f'Расходы за этот месяц ({summary["expenses"]:,.0f} ₽) превысили доход '
                          f'({base:,.0f} ₽). Загляните в дашборд, чтобы понять, где можно сэкономить.'
                          .replace(',', ' ')):
                sent['overspend'] = month
                changed = True

        if changed:
            conn.execute('UPDATE users SET last_notifications = ? WHERE id = ?', (json.dumps(sent), user_id))
            conn.commit()
    except Exception as exc:
        log.error('Ошибка проверки уведомлений: %s', exc)
    finally:
        conn.close()


def schedule_notifications(user_id):
    """Не чаще раза в час на пользователя и в фоне — дашборд не ждёт SMTP."""
    if not (EMAIL_USER and EMAIL_PASS):
        return
    now = time.time()
    with _notify_lock:
        if now - _notify_checked.get(user_id, 0) < 3600:
            return
        _notify_checked[user_id] = now
    threading.Thread(target=check_notifications, args=(user_id,), daemon=True).start()


# ============================================================
#  Ошибки
# ============================================================
@app.errorhandler(404)
def not_found(_exc):
    if request.path.startswith('/api/'):
        return api_error('Не найдено.', 404)
    return app.redirect('/')


@app.errorhandler(405)
def method_not_allowed(_exc):
    return api_error('Метод не поддерживается.', 405)


@app.errorhandler(413)
def too_large(_exc):
    return api_error('Файл слишком большой (максимум 5 МБ).', 413)


@app.errorhandler(500)
def server_error(_exc):
    # Подробности (traceback) Flask пишет в серверный лог, пользователь видит только общий текст.
    audit('server_error', logging.ERROR, path=request.path, method=request.method)
    return api_error('Внутренняя ошибка сервера.', 500)


if __name__ == '__main__':
    host = os.environ.get('HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', 5000))
    if DEBUG and host not in ('127.0.0.1', 'localhost', '::1'):
        raise SystemExit('FLASK_DEBUG=1 разрешён только на 127.0.0.1: отладчик даёт выполнить код на сервере.')
    print(f'\n  Akysaya запущена: http://{host}:{port}\n')
    if IS_PROD:
        try:
            from waitress import serve  # production-сервер вместо встроенного сервера разработки
        except ImportError:
            raise SystemExit('Для production установите waitress: pip install waitress')
        serve(app, host=host, port=port, ident='Akysaya')
    else:
        from werkzeug.serving import WSGIRequestHandler

        class QuietHandler(WSGIRequestHandler):
            # Заголовок Server без версий Werkzeug и Python.
            server_version = 'Akysaya'
            sys_version = ''

            def version_string(self):
                return 'Akysaya'

        app.run(debug=DEBUG, threaded=True, host=host, port=port, request_handler=QuietHandler)
