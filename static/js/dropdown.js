/* Красивые выпадающие списки поверх обычного <select>.
   Нативный select остаётся в форме (FormData, value, required, события change),
   а пользователь видит кнопку и стеклянную панель с вариантами. */
(function () {
'use strict';

const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const protoIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
const CHEVRON = '<svg class="dd-chev" viewBox="0 0 12 8" width="12" height="8" aria-hidden="true"><path d="M1 1.5L6 6.5L11 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let uid = 0;
let openDd = null;

class Dropdown {
    constructor(select) {
        this.select = select;
        this.id = 'dd' + (++uid);
        this.active = -1;
        this.typed = '';
        this.typedAt = 0;

        const wrap = document.createElement('span');
        wrap.className = 'dd';
        if (select.style.width) wrap.style.width = select.style.width;
        if (select.style.minWidth) wrap.style.minWidth = select.style.minWidth;
        select.style.width = '';
        select.style.minWidth = '';
        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(select);
        select.classList.add('dd-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dd-btn ' + [...select.classList].filter(c => c !== 'dd-native').join(' ');
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-controls', this.id);
        const label = select.getAttribute('aria-label') || this.findLabel();
        if (label) btn.setAttribute('aria-label', label);
        btn.innerHTML = '<span class="dd-label"></span>' + CHEVRON;
        wrap.appendChild(btn);
        this.wrap = wrap;
        this.btn = btn;
        this.labelEl = btn.querySelector('.dd-label');

        const panel = document.createElement('div');
        panel.className = 'dd-panel';
        panel.id = this.id;
        panel.setAttribute('role', 'listbox');
        if (label) panel.setAttribute('aria-label', label);
        this.panel = panel;

        // Программное select.value = ... тоже обновляет подпись.
        const self = this;
        Object.defineProperty(select, 'value', {
            configurable: true,
            get() { return proto.get.call(this); },
            set(v) { proto.set.call(this, v); self.sync(); },
        });
        Object.defineProperty(select, 'selectedIndex', {
            configurable: true,
            get() { return protoIndex.get.call(this); },
            set(v) { protoIndex.set.call(this, v); self.sync(); },
        });
        new MutationObserver(() => { this.sync(); if (openDd === this) this.renderOptions(); })
            .observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'label'] });
        select.addEventListener('change', () => this.sync());
        select.addEventListener('focus', () => btn.focus());   // клик по <label for> и подсказка браузера о required
        select.form?.addEventListener('reset', () => setTimeout(() => this.sync()));

        btn.addEventListener('click', () => (openDd === this ? this.close() : this.open()));
        btn.addEventListener('keydown', (e) => this.onKey(e));
        panel.addEventListener('mousedown', (e) => e.preventDefault());   // фокус остаётся на кнопке
        panel.addEventListener('click', (e) => {
            const opt = e.target.closest('.dd-opt');
            if (opt && !opt.classList.contains('is-disabled')) this.choose(Number(opt.dataset.index));
        });
        panel.addEventListener('mousemove', (e) => {
            const opt = e.target.closest('.dd-opt');
            if (opt) this.setActive(Number(opt.dataset.index), false);
        });
        this.sync();
    }

    findLabel() {
        if (this.select.id) {
            const l = document.querySelector(`label[for="${this.select.id}"]`);
            if (l) return l.textContent.trim();
        }
        const prev = this.select.closest('div')?.querySelector('label');
        return prev ? prev.textContent.trim() : '';
    }

    options() { return [...this.select.options]; }

    sync() {
        const opt = this.select.options[protoIndex.get.call(this.select)];
        this.labelEl.textContent = opt ? opt.textContent : '';
        this.btn.classList.toggle('is-placeholder', !opt || opt.value === '');
        this.btn.disabled = this.select.disabled;
    }

    renderOptions() {
        const current = protoIndex.get.call(this.select);
        this.panel.innerHTML = '';
        this.options().forEach((o, i) => {
            if (o.hidden) return;
            const el = document.createElement('div');
            el.className = 'dd-opt';
            el.id = `${this.id}-o${i}`;
            el.dataset.index = i;
            el.setAttribute('role', 'option');
            el.setAttribute('aria-selected', String(i === current));
            const disabled = o.disabled || (o.value === '' && this.select.required);
            if (disabled) { el.classList.add('is-disabled'); el.setAttribute('aria-disabled', 'true'); }
            if (i === current) el.classList.add('is-selected');
            el.textContent = o.textContent;
            this.panel.appendChild(el);
        });
    }

    open() {
        if (this.select.disabled) return;
        if (openDd && openDd !== this) openDd.close();
        this.renderOptions();
        document.body.appendChild(this.panel);
        this.position();
        openDd = this;
        this.btn.setAttribute('aria-expanded', 'true');
        this.wrap.classList.add('is-open');
        requestAnimationFrame(() => this.panel.classList.add('is-open'));
        this.setActive(protoIndex.get.call(this.select), true);
    }

    close(focus = false) {
        if (openDd !== this) return;
        openDd = null;
        this.btn.setAttribute('aria-expanded', 'false');
        this.btn.removeAttribute('aria-activedescendant');
        this.wrap.classList.remove('is-open');
        this.panel.classList.remove('is-open');
        this.panel.remove();
        if (focus) this.btn.focus();
    }

    position() {
        const r = this.btn.getBoundingClientRect();
        const below = window.innerHeight - r.bottom;
        const height = Math.min(300, this.panel.scrollHeight || 300);
        const up = below < height + 16 && r.top > below;
        Object.assign(this.panel.style, {
            left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 180) - 8)) + 'px',
            minWidth: r.width + 'px',
            top: up ? '' : (r.bottom + 6) + 'px',
            bottom: up ? (window.innerHeight - r.top + 6) + 'px' : '',
        });
        this.panel.classList.toggle('is-up', up);
    }

    enabledIndexes() {
        return [...this.panel.querySelectorAll('.dd-opt:not(.is-disabled)')].map(el => Number(el.dataset.index));
    }

    setActive(index, scroll) {
        this.panel.querySelectorAll('.dd-opt.is-active').forEach(el => el.classList.remove('is-active'));
        const el = this.panel.querySelector(`.dd-opt[data-index="${index}"]`);
        this.active = el ? index : -1;
        if (!el) return;
        el.classList.add('is-active');
        this.btn.setAttribute('aria-activedescendant', el.id);
        if (scroll) el.scrollIntoView({ block: 'nearest' });
    }

    move(delta) {
        const list = this.enabledIndexes();
        if (!list.length) return;
        let pos = list.indexOf(this.active);
        pos = pos === -1 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, pos + delta));
        this.setActive(list[pos], true);
    }

    choose(index) {
        const before = protoIndex.get.call(this.select);
        protoIndex.set.call(this.select, index);
        this.sync();
        this.close(true);
        if (before !== index) {
            this.select.dispatchEvent(new Event('input', { bubbles: true }));
            this.select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    typeAhead(ch) {
        const now = Date.now();
        this.typed = now - this.typedAt > 700 ? ch : this.typed + ch;
        this.typedAt = now;
        const opts = this.options();
        const hit = opts.findIndex(o => !o.disabled && o.value !== '' && o.textContent.toLowerCase().startsWith(this.typed));
        if (hit === -1) return;
        if (openDd === this) this.setActive(hit, true);
        else this.choose(hit);
    }

    onKey(e) {
        const isOpen = openDd === this;
        switch (e.key) {
            case 'ArrowDown':
            case 'ArrowUp':
                e.preventDefault();
                if (!isOpen) this.open();
                else this.move(e.key === 'ArrowDown' ? 1 : -1);
                break;
            case 'Home':
            case 'End':
                if (!isOpen) return;
                e.preventDefault();
                this.move(e.key === 'Home' ? -1e6 : 1e6);
                break;
            case 'Enter':
            case ' ':
                if (e.key === ' ' && this.typed && Date.now() - this.typedAt < 700) { e.preventDefault(); this.typeAhead(' '); break; }
                e.preventDefault();
                if (!isOpen) this.open();
                else if (this.active >= 0) this.choose(this.active);
                break;
            case 'Escape':
                if (isOpen) { e.preventDefault(); e.stopPropagation(); this.close(true); }
                break;
            case 'Tab':
                if (isOpen) this.close();
                break;
            default:
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) this.typeAhead(e.key.toLowerCase());
        }
    }
}

document.addEventListener('mousedown', (e) => {
    if (openDd && !openDd.wrap.contains(e.target) && !openDd.panel.contains(e.target)) openDd.close();
}, true);
window.addEventListener('resize', () => openDd?.close());
document.addEventListener('scroll', (e) => {
    if (openDd && !openDd.panel.contains(e.target)) openDd.position();
}, true);

function enhance(select) {
    if (select._dd || select.multiple || select.size > 1) return select._dd;
    select._dd = new Dropdown(select);
    return select._dd;
}

window.AkysayaDropdown = {
    enhanceAll(root = document) { root.querySelectorAll('select').forEach(enhance); },
    enhance,
    closeAll() { openDd?.close(); },
    isOpen() { return !!openDd; },
};
})();
