// "Edit details" form (shared by Inventory detail and the Price / Review result screen).
// openEditItem(item, {onResearched?(item)}) -> Promise<updatedItem|null>  (null = closed without saving)
// onResearched runs when the fired item.research call comes back (the item is then in Review).
// Saves with item.edit. With "Re-check sold prices" ticked the server sends the item back to researching;
// this module then fires item.research (not awaited) and the item shows up in Review when it's done.
import { call } from './api.js';
import { emit } from './state.js';
import { h, BigButton, toast, sheet, showError } from './ui.js';

// Same text the server returns as brand_display ("Nike × Off-White").
export function brandDisplay(it) {
  if (!it) return '';
  if (it.brand_display) return it.brand_display;
  const b = String(it.brand || '').trim(), c = String(it.collab || '').trim();
  return c ? (b ? b + ' × ' + c : c) : b;
}

const FIELDS = [
  { key: 'brand', label: 'Brand', max: 60, placeholder: 'e.g. Nike', hint: 'The company name or logo, not a code.' },
  { key: 'collab', label: 'Collab', max: 60, placeholder: 'e.g. Off-White', hint: 'Only for collaborations, like Nike × Off-White.' },
  { key: 'title', label: 'Item name', max: 80, placeholder: 'e.g. Air Max 90 Sneakers' },
  { key: 'size', label: 'Size', max: 30, placeholder: 'e.g. M, 8, 32x30' },
  { key: 'style_code', label: 'Style code', max: 40, placeholder: 'e.g. DD1391-100', hint: 'The style / model number on the tag. Helps find sold prices.' },
];
const RECHECK_KEYS = ['brand', 'collab', 'style_code'];

export function openEditItem(item, opts = {}) {
  return new Promise((resolve) => {
    let result = null;
    const inputs = {};
    const body = h('form', { class: 'ed-form', novalidate: true, onSubmit: (e) => { e.preventDefault(); save(); } });
    const recheck = h('input', { type: 'checkbox', id: 'ed-recheck', 'aria-label': 'Re-check sold prices with these details' });
    let recheckTouched = false;
    recheck.addEventListener('change', () => { recheckTouched = true; });
    const orig = (k) => String(item[k] == null ? '' : item[k]).trim();
    const syncRecheck = () => {
      if (recheckTouched) return;
      recheck.checked = RECHECK_KEYS.some((k) => inputs[k].value.trim() !== orig(k));
    };

    body.appendChild(h('h2', null, 'Edit details'));
    body.appendChild(h('p', { class: 'mute ed-sub' }, item.id));
    for (const f of FIELDS) {
      const el = h('input', { type: 'text', value: orig(f.key), maxlength: f.max, placeholder: f.placeholder,
        autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', autocapitalize: f.key === 'style_code' ? 'characters' : 'words' });
      el.addEventListener('input', syncRecheck);
      inputs[f.key] = el;
      body.appendChild(h('label', { class: 'field' }, h('span', null, f.label), el, f.hint ? h('small', null, f.hint) : null));
    }
    body.appendChild(h('label', { class: 'ed-check', for: 'ed-recheck' }, recheck, h('span', null, 'Re-check sold prices with these details')));
    const saveBtn = BigButton('Save', () => save());
    body.appendChild(saveBtn);
    body.appendChild(h('button', { type: 'submit', hidden: true, tabindex: '-1', 'aria-hidden': 'true' })); // Enter key submits

    const sh = sheet(body, { onClose: () => resolve(result) });

    async function save() {
      if (saveBtn.disabled) return;
      const params = { id: item.id };
      for (const f of FIELDS) {
        const v = inputs[f.key].value.replace(/\s+/g, ' ').trim();
        if (v !== orig(f.key)) params[f.key] = v;
      }
      if (params.title === '') { toast('Give the item a name.', 'error'); inputs.title.focus(); return; }
      const wantRecheck = recheck.checked;
      if (Object.keys(params).length === 1 && !wantRecheck) { sh.close(); return; }
      if (wantRecheck) params.recheck = true;
      saveBtn.disabled = true;
      try {
        const updated = await call('item.edit', params);
        result = updated;
        emit('item:edited', updated);
        if (updated.status === 'researching') {
          toast("Looking up sold prices… it'll be in Review", 'info');
          // Fire and forget, like the Price tab does for research items. The backend sweep is the backstop.
          call('item.research', { id: updated.id })
            .then((r) => { emit('item:edited', r); if (opts.onResearched) opts.onResearched(r); })
            .catch(() => {})
            .finally(() => import('./price.js').then((m) => m.refreshReviewCount && m.refreshReviewCount()).catch(() => {}));
        } else {
          toast('Saved', 'ok');
        }
        sh.close();
      } catch (e) {
        showError(e);
        saveBtn.disabled = false;
      }
    }
  });
}

const css = `
.ed-form h2 { margin: 0; }
.ed-sub { margin: 0 0 12px; }
.ed-form input[type=text] { width: 100%; box-sizing: border-box; }
.ed-check { display: flex; align-items: center; gap: 12px; margin: 4px 0 16px; font-weight: 600; cursor: pointer; min-height: 48px; }
.ed-check input { width: 28px; height: 28px; flex: 0 0 auto; margin: 0; accent-color: var(--accent); }
`;
document.head.appendChild(h('style', { 'data-module': 'edit-item' }, css));
