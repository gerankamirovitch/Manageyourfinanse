# Akysaya

Personal finance tracker: income and expenses with notes, your own categories, monthly budgets per category, recurring payments (subscriptions, loans, utilities) that are added automatically, month-by-month dashboard with a six-month chart, search and filters in history, bank statement import (CSV), budgeting tips, currency and crypto rates, custom themes, and JSON backups.

The background is a live WebGL fluid simulation; the interface uses glass cards, gradient accents and custom dropdowns. The mouse cursor is left untouched.

Flask + SQLite backend with a single-page frontend.

## Run

```bash
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000 and create an account.

## Structure

| Path | Purpose |
|---|---|
| `app.py` | Flask server: page + JSON API (`/api/*`), migrations, captcha, rate limits, email reminders |
| `templates/index.html` | Markup of all pages (welcome, login, register, dashboard, history, add, settings, privacy policy, terms of use) |
| `static/css/app.css` | Base styles |
| `static/css/design.css` | Visual layer: glass cards, gradients, dropdowns, animations |
| `static/js/app.js` | Frontend logic (router, API calls, charts, history, budgets, recurring payments, CSV import) |
| `static/js/fluid.js` | Live WebGL fluid background (pauses when a custom background image is set; CSS fallback without WebGL) |
| `static/js/dropdown.js` | Accessible custom dropdowns on top of native `<select>` (keyboard, screen readers, forms keep working) |
| `static/js/fx.js` | Scroll progress, reveal-on-scroll, card spotlight, magnetic buttons, film grain |
| `static/js/theme-boot.js` | Applies the saved theme before first paint |
| `static/vendor/` | Chart.js 4.4.1 (vendored, integrity checked) |
| `database.db` | SQLite data (created automatically if missing) |
| `instance/secret_key` | Session key generated on first run (do not commit) |

## Environment variables (optional)

| Variable | Meaning |
|---|---|
| `FLASK_SECRET` | Session key. Required when `FLASK_ENV=production` |
| `FLASK_ENV=production` | Secure cookies, HSTS, HTTPS redirect, waitress server |
| `HOST`, `PORT` | Bind address, default `127.0.0.1:5000` |
| `DB_PATH` | Path to the SQLite file |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS` | SMTP for rent reminders and overspend alerts |
| `TRUST_PROXY=1` | Trust one reverse proxy for client IP and scheme |
| `LEGAL_OWNER` | Operator name shown in the privacy policy and terms (set before going public) |
| `LEGAL_EMAIL` | Contact email shown in the privacy policy and terms |

## Features in detail

- **Categories.** Every account starts with the standard set and can add up to 40 categories per type or delete them. Old transactions keep the name of a deleted category.
- **Budgets.** A monthly limit per expense category; the dashboard shows progress, the amount left and an overspend warning.
- **Recurring payments.** Title, amount, category and day of month. A payment is added as a transaction on its day (31 moves to the last day of short months), missed months are caught up once, pause and resume do not backfill. Payments due in the next 14 days are listed on the dashboard; with SMTP configured, an email reminder goes out 3 days before.
- **Months.** Switch between months, compare with the previous month and see income vs expenses for the last six months.
- **History.** Edit any transaction, add a note, search by category or note (case-insensitive, Cyrillic included), filter by type, category and dates, load more by pages.
- **CSV import.** Delimiter, header, date and amount columns (signed or separate debit/credit) are detected automatically and can be changed; UTF-8 and Windows-1251 files are supported. Categories are guessed from the bank category or description. Preview first, then import; repeated imports skip duplicates. The file itself is not stored.

## Privacy policy and terms

Both documents are pages of the app (`/#privacy`, `/#terms`, also `/privacy` and `/terms`). Registration requires accepting them; the acceptance date and document version (`TERMS_VERSION` in `app.py`) are stored per user. When you change the texts, update `TERMS_VERSION`. The texts are a starting template, not legal advice: have them reviewed before launch.

Users can export their data and delete their account (with password confirmation) in Settings.

## Security notes

Reviewed against OWASP Top 10 (2025) on 2026-11-13.

- Passwords hashed with Werkzeug (scrypt). Login limits: 5 failures / 5 min per IP and 10 failures / 15 min per account.
- Captcha: a distorted image rendered on the server (Pillow). The answer is kept only in server memory (the cookie holds a random id), is single-use and expires after 10 minutes. Forms also carry a hidden honeypot field.
- Server-side sessions: the cookie holds a random token, the database stores its SHA-256 hash; logout revokes it. New token on every login (no session fixation).
- State-changing API calls require the `X-Requested-With: akysaya` header and a matching `Origin` (CSRF). No CORS.
- Strict CSP (`script-src 'self'`, `connect-src 'self'`, no inline scripts, no third-party scripts), `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, HSTS and HTTPS redirect in production. The `Server` header doesn't reveal versions.
- Every input is type-checked; malformed JSON returns 4xx, never 500. All SQL is parameterized; every query is scoped to the current user.
- Debugger is off by default and refuses to run on a non-loopback host.
- Security events (logins, failures, lockouts, CSRF rejects, deletions, imports, account deletions, 500s) go to `logs/security.log` (rotated, no passwords).
- Dependencies are pinned in `requirements.txt` and were checked against the OSV database.
- The old shared demo account (`demo` with its published password) is deleted automatically on startup.
- New endpoints (categories, budgets, recurring payments, transaction edits, CSV import) are scoped to the current user, type-checked and covered by the same CSRF, rate-limit and fuzzing checks.

## License

Licensed under the [Apache License 2.0](LICENSE). Chart.js in `static/vendor/` is MIT-licensed (see `static/vendor/chart.js-LICENSE.md`).

## На русском

Учёт личных финансов на Flask и SQLite. Запуск: `pip install -r requirements.txt`, затем `python app.py`, адрес http://127.0.0.1:5000. Данные хранятся на сервере в `database.db`. Вход и регистрация защищены капчей-картинкой. На сайте есть политика конфиденциальности и условия использования; перед публикацией укажите `LEGAL_OWNER` и `LEGAL_EMAIL` и покажите тексты юристу. В настройках можно скачать копию данных и удалить аккаунт. Есть свои категории, бюджеты по категориям, регулярные платежи с автодобавлением, выбор месяца с графиком за полгода, редактирование и поиск операций, импорт CSV-выписки из банка. Фон — живая WebGL-симуляция. Лицензия: Apache-2.0.
