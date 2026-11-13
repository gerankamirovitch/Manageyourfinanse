// Применяет сохранённую тему до первой отрисовки страницы,
// чтобы после обновления не мелькал стандартный фон и цвет.
(function () {
    'use strict';
    var ACCENTS = ['violet', 'blue', 'green', 'amber', 'crimson'];
    var theme = {};
    try { theme = JSON.parse(localStorage.getItem('akysaya_theme') || '{}') || {}; } catch (e) { theme = {}; }
    var body = document.body;
    body.setAttribute('data-accent', ACCENTS.indexOf(theme.accent) >= 0 ? theme.accent : 'violet');
    var overlay = Number(theme.overlay);
    body.style.setProperty('--bg-overlay-opacity', isFinite(overlay) ? Math.min(Math.max(overlay, 0), 0.9) : 0.55);
    if (typeof theme.bgUrl === 'string' && /^https:\/\//i.test(theme.bgUrl)) {
        body.style.backgroundImage = 'url("' + theme.bgUrl.replace(/["\\\n\r]/g, encodeURIComponent) + '")';
        body.classList.add('custom-bg-active');
    }
})();
