// Small UI helpers shared by all pages
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const initials = (n) => String(n || '?').replace(/^(Dr\.|Prof\.)\s*/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

const parse = (s) => (s ? new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z') : null);
export const fmtDate = (s) => { const d = parse(s) || (s ? new Date(s) : null); return d && !isNaN(d) ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; };
export function ago(s) {
  const d = parse(s); if (!d) return '';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'Just now'; if (m < 60) return m + ' minutes ago';
  const h = Math.round(m / 60); if (h < 24) return h + ' hours ago';
  const dd = Math.round(h / 24); return dd === 1 ? 'Yesterday' : dd + ' days ago';
}

export function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3500);
}

const STATUS = {
  pending: ['warn', 'Pending'], under_review: ['red', 'Under review'], approved: ['ok', 'Approved'], declined: ['red', 'Declined'],
  more_info: ['warn', 'More information required'], completed: ['ok', 'Completed'], active: ['ok', 'Active'], suspended: ['red', 'Suspended'],
  pending_verification: ['warn', 'Pending verification'], verified: ['ok', '✓ Verified'], rejected: ['red', 'Rejected'],
  evidence_required: ['warn', 'Additional evidence required']
};
export const statusTag = (s) => { const [c, l] = STATUS[s] || ['', s]; return `<span class="tag ${c}">${l}</span>`; };

export function modal(html) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close));
  return { el: bg.firstElementChild, close };
}

export const field = (label, name, o = {}) => `<div><label>${esc(label)}${o.req ? ' <span class="req">*</span>' : ''}</label>
  <input name="${name}" type="${o.type || 'text'}" value="${esc(o.value ?? '')}" placeholder="${esc(o.ph || '')}" ${o.req ? 'required' : ''} ${o.min ? `min="${o.min}"` : ''}></div>`;
export const area = (label, name, o = {}) => `<div><label>${esc(label)}${o.req ? ' <span class="req">*</span>' : ''}</label>
  <textarea name="${name}" placeholder="${esc(o.ph || '')}" ${o.req ? 'required' : ''}>${esc(o.value ?? '')}</textarea></div>`;
export const select = (label, name, options, o = {}) => `<div><label>${esc(label)}${o.req ? ' <span class="req">*</span>' : ''}</label>
  <select name="${name}" ${o.req ? 'required' : ''}><option value="">Select an option</option>${options.map((x) => {
    const [v, t] = Array.isArray(x) ? x : [x, x];
    return `<option value="${esc(v)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(t)}</option>`;
  }).join('')}</select></div>`;
export const formData = (form) => Object.fromEntries(new FormData(form).entries());

// show/hide password buttons
export function bindPw(root) {
  $$('.pw', root).forEach((w) => {
    const input = $('input', w), btn = $('button', w);
    btn.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; });
  });
}
export const pwField = (label, name, ph = '') => `<div><label>${label} <span class="req">*</span></label>
  <div class="pw"><input name="${name}" type="password" placeholder="${esc(ph)}" required><button type="button" aria-label="Show password">👁</button></div></div>`;

export const emptyBox = (t) => `<div class="empty">${esc(t)}</div>`;

export function downloadFile(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

// Recommendation letter viewer (used by student, lecturer and admin)
export function showLetter(rec) {
  const date = fmtDate(rec.completed_at || new Date().toISOString());
  const m = modal(`<div class="print-area">
    <div class="letter-head"><div class="au-mark">AU</div><div><b>Africa University</b><br><small style="color:#6b6b6b">Investing in Africa's Future</small></div></div>
    <div class="letter"><b>${esc(date)}</b>

<b>RE: Recommendation for ${esc(rec.student_name)} — ${esc(rec.purpose)}</b>

To whom it may concern,

${esc(rec.letter || 'This letter has not been written yet.')}

Sincerely,
<b>${esc(rec.lecturer_name)}</b>
Africa University</div></div>
    <div class="modal-actions no-print"><button class="btn" data-close>Close</button><button class="btn red" id="print-letter">Print / Save as PDF</button></div>`);
  $('#print-letter', m.el).addEventListener('click', () => window.print());
}

// Green badge that is ONLY shown for achievements a lecturer has verified
export const verifiedBadge = (a) => (a.status === 'verified' ? '<span class="tag ok" title="Verified by a lecturer">✓ VERIFIED</span>' : '');

// Read a chosen file as base64 for upload
export const fileToPayload = (file, kind) => new Promise((resolve, reject) => {
  if (file.size > 4 * 1024 * 1024) return reject(new Error(`"${file.name}" is larger than 4 MB`));
  const r = new FileReader();
  r.onload = () => resolve({ name: file.name, data: String(r.result).split(',')[1], kind });
  r.onerror = () => reject(new Error('Could not read ' + file.name));
  r.readAsDataURL(file);
});
export const readFiles = (input, kind) => Promise.all([...(input?.files || [])].map((f) => fileToPayload(f, kind)));

// List of evidence files with "open" buttons (call bindFiles(root) after inserting)
export const fileList = (files) => (files && files.length
  ? files.map((f) => `<button type="button" class="btn sm" data-file="${f.id}" style="margin:3px 6px 3px 0">📎 ${esc(f.original_name)} <small>(${f.kind === 'additional' ? 'additional' : 'certificate'})</small></button>`).join('')
  : '<span class="small">No files attached.</span>');
export function bindFiles(root, openFile) {
  $$('[data-file]', root).forEach((b) => b.addEventListener('click', async () => {
    try { await openFile(b.dataset.file); } catch (e) { toast(e.message, true); }
  }));
}

export const REASON_LABEL = { insufficient_evidence: 'Insufficient evidence', inaccurate_information: 'Inaccurate information', not_relevant: 'Not relevant', guideline_violation: 'Against university guidelines', other: 'Other' };
