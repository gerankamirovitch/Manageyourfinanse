/* Эффекты оформления по мотивам Desktop/01-landing. Указатель мыши не меняется. */
(function () {
'use strict';
const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];
const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const FINE = window.matchMedia('(pointer: fine)').matches;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

if (RM) document.documentElement.classList.add('rm');

/* Зерно плёнки, сгенерированное в браузере (без картинок). */
(function grain() {
    const el = $('#grain');
    if (!el) return;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const d = g.createImageData(128, 128);
    for (let i = 0; i < d.data.length; i += 4) {
        const v = Math.random() * 255 | 0;
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
        d.data[i + 3] = 20;
    }
    g.putImageData(d, 0, 0);
    el.style.backgroundImage = `url(${c.toDataURL()})`;
})();

/* Полоса прогресса прокрутки и «стеклянная» навигация после прокрутки. */
const prog = $('#prog');
const nav = $('#navbar');
let ticking = false;
function onScroll() {
    ticking = false;
    const y = window.scrollY;
    const h = document.documentElement.scrollHeight - window.innerHeight;
    if (prog) prog.style.transform = `scaleX(${h > 0 ? clamp(y / h, 0, 1) : 0})`;
    nav?.classList.toggle('is-scrolled', y > 8);
    litManifesto();
}
window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });

/* Появление блоков при прокрутке. Скрытые страницы SPA «не пересекаются»,
   поэтому блоки появятся, когда страницу откроют. */
const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }
}, { threshold: 0.08 });
function observeReveals(root = document) {
    $$('[data-reveal]:not(.in)', root).forEach(el => (RM ? el.classList.add('in') : io.observe(el)));
}

/* Манифест: слова загораются по мере прокрутки. */
const mani = $('#maniP');
let maniWords = [];
if (mani) {
    mani.innerHTML = mani.textContent.trim().split(/\s+/).map(w => {
        const acc = w.charAt(0) === '*';
        const word = (acc ? w.slice(1) : w).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        return `<span class="w${acc ? ' acc' : ''}">${word}</span>`;
    }).join(' ');
    maniWords = $$('.w', mani);
}
let maniLit = -1;
function litManifesto() {
    if (!mani || !mani.offsetParent) return;
    if (RM) { maniWords.forEach(w => w.classList.add('on')); return; }
    const r = mani.getBoundingClientRect();
    const p = clamp((window.innerHeight * 0.85 - r.top) / (window.innerHeight * 0.6), 0, 1);
    const n = Math.round(p * maniWords.length);
    if (n !== maniLit) { maniLit = n; maniWords.forEach((w, i) => w.classList.toggle('on', i < n)); }
}

/* Счётчики на приветственной странице. */
function runCounters(root = document) {
    $$('[data-count]:not(.counted)', root).forEach(el => {
        el.classList.add('counted');
        const to = Number(el.dataset.count);
        const suffix = el.dataset.suffix || '';
        if (RM) { el.textContent = to + suffix; return; }
        const t0 = performance.now();
        (function tick(now) {
            const p = clamp((now - t0) / 1400, 0, 1), e = 1 - Math.pow(1 - p, 3);
            el.textContent = Math.round(to * e) + suffix;
            if (p < 1) requestAnimationFrame(tick);
        })(t0);
    });
}

/* Подсветка карточек за мышью, «магнитные» кнопки и наклон карточек на главной. */
if (FINE && !RM) {
    document.addEventListener('pointermove', (e) => {
        const card = e.target.closest?.('.card, .feature-card-welcome, .stat-tile');
        if (!card) return;
        const r = card.getBoundingClientRect();
        card.style.setProperty('--gx', ((e.clientX - r.left) / r.width * 100) + '%');
        card.style.setProperty('--gy', ((e.clientY - r.top) / r.height * 100) + '%');
    }, { passive: true });

    document.addEventListener('pointermove', (e) => {
        const el = e.target.closest?.('[data-magnetic]');
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = (e.clientX - r.left) / r.width - 0.5, dy = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `translate(${dx * 10}px, ${dy * 7}px)`;
    }, { passive: true });
    document.addEventListener('pointerout', (e) => {
        const el = e.target.closest?.('[data-magnetic]');
        if (el && !el.contains(e.relatedTarget)) el.style.transform = '';
    });

    document.addEventListener('pointermove', (e) => {
        const card = e.target.closest?.('[data-tilt]');
        if (!card) return;
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        card.style.transition = 'transform .1s';
        card.style.transform = `perspective(900px) rotateX(${(py - 0.5) * -7}deg) rotateY(${(px - 0.5) * 7}deg)`;
    }, { passive: true });
    document.addEventListener('pointerout', (e) => {
        const card = e.target.closest?.('[data-tilt]');
        if (card && !card.contains(e.relatedTarget)) {
            card.style.transition = 'transform .6s cubic-bezier(.19,1,.22,1)';
            card.style.transform = '';
        }
    });
}

/* Вызывается роутером при каждом показе страницы. */
window.AkysayaFx = {
    pageShown(page) {
        const el = document.getElementById('page-' + page);
        if (!el) return;
        observeReveals(el);
        runCounters(el);
        maniLit = -1;
        requestAnimationFrame(onScroll);
    },
    observeReveals,
};

function ready() {
    document.body.classList.add('ready');
    observeReveals();
    onScroll();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
else ready();
})();
