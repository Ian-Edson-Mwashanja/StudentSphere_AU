// Pages every role uses: notifications + settings
import { api } from './api.js';
import { esc, $, $$, ago, toast, field, pwField, bindPw, formData, emptyBox } from './ui.js';

export async function notificationsPage(main) {
  const list = await api('/notifications');
  const draw = (items) => {
    main.innerHTML = `<div class="wrap"><div class="eyebrow">Updates</div><h1 class="page-title">Notifications</h1>
      <p class="sub">Important account, academic, and recommendation updates.</p>
      <button class="btn" id="readall" style="margin-bottom:16px">✓ Mark all as read</button>
      <div class="card">${items.length ? items.map((n) => `<div class="list-row ${n.is_read ? '' : 'unread'}"><div class="ic">✉</div>
        <div class="grow"><b>${esc(n.title)}</b><small>${esc(n.body)}</small><br><small>${ago(n.created_at)}</small></div>
        ${n.link ? `<a class="btn sm" href="#${esc(n.link)}" data-read="${n.id}">Open →</a>` : ''}${n.is_read ? '' : '<i class="badge-dot" style="position:static"></i>'}</div>`).join('') : emptyBox('No notifications yet.')}</div></div>`;
    $$('[data-read]', main).forEach((a) => a.addEventListener('click', () => api('/notifications/' + a.dataset.read + '/read', { method: 'PUT' }).catch(() => {})));
    $('#readall', main).addEventListener('click', async () => {
      await api('/notifications/read-all', { method: 'POST' });
      draw(items.map((n) => ({ ...n, is_read: 1 }))); const d = $('#dot'); if (d) d.hidden = true;
    });
  };
  draw(list);
}

export async function settingsPage(main, { user }) {
  const s = await api('/me/settings');
  main.innerHTML = `<div class="wrap"><div class="eyebrow">Account</div><h1 class="page-title">Settings</h1>
    <p class="sub">Manage notifications and your password.</p>
    <div class="grid g2">
      <div class="card"><h3 style="margin-bottom:6px">Notifications</h3>
        <div class="switch"><div><b>Email notifications</b><br><small style="color:#6b6b6b">Updates on requests and approvals.</small></div><input type="checkbox" id="s1" ${s.email_notifications ? 'checked' : ''}></div>
        <div class="switch"><div><b>Deadline reminders</b><br><small style="color:#6b6b6b">Receive reminders before request deadlines.</small></div><input type="checkbox" id="s2" ${s.deadline_reminders ? 'checked' : ''}></div>
        <p class="hint" style="margin-top:14px">Signed in as ${esc(user.email)} (${esc(user.university_id)})</p></div>
      <div class="card"><h3 style="margin-bottom:6px">Password & security</h3>
        <form id="pwf">${pwField('Current password', 'current')}${pwField('New password', 'next')}
        <p class="hint">At least 8 characters, with a number.</p><div id="pmsg"></div>
        <button class="btn red" style="margin-top:12px">Update password</button></form></div></div></div>`;
  bindPw(main);
  const save = async () => {
    try { await api('/me/settings', { method: 'PUT', body: { email_notifications: $('#s1', main).checked, deadline_reminders: $('#s2', main).checked } }); toast('Settings saved'); }
    catch (e) { toast(e.message, true); }
  };
  $('#s1', main).addEventListener('change', save); $('#s2', main).addEventListener('change', save);
  $('#pwf', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/me/password', { method: 'PUT', body: formData(e.target) }); $('#pmsg', main).innerHTML = '<div class="msg ok">Password updated.</div>'; e.target.reset(); }
    catch (err) { $('#pmsg', main).innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
  });
}
