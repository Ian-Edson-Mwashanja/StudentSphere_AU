import { api, openFile } from './api.js';
import { esc, $, $$, fmtDate, ago, toast, modal, emptyBox, statusTag, downloadFile, area, verifiedBadge, fileList, bindFiles, REASON_LABEL } from './ui.js';
import { notificationsPage, settingsPage } from './shared.js';

const stat = (label, n, note = '', red = false) => `<div class="card stat"><small>${label}</small><div class="n ${red ? 'red' : ''}">${n ?? 'â€”'}</div><span>${note}</span></div>`;
const head = (eyebrow, title, sub = '') => `<div class="eyebrow">${eyebrow}</div><h1 class="page-title">${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}`;

async function dashboard(main) {
  const [d, recs] = await Promise.all([api('/dashboard'), api('/recommendations')]);
  main.innerHTML = `<div class="wrap"><div class="hero"><div><div class="eyebrow">System administration</div><h1>Welcome back, Admin</h1>
    <p>Approve accounts, manage academic records and keep recommendation requests moving.</p></div><a class="btn white" href="#/admin/approvals">Review approvals â†’</a></div>
    <div class="grid g3">${stat('Total users', d.users, 'Students, lecturers, admins')}${stat('Awaiting approval', d.awaiting, 'New registrations', true)}${stat('Recommendation requests', d.recs, 'All time')}${stat('Achievements awaiting verification', d.ach_pending, d.ach_unassigned ? d.ach_unassigned + ' without a lecturer' : 'All routed to a lecturer')}</div>
    <div class="section-head"><div><div class="eyebrow">Monitoring</div><h2>Needs attention</h2></div></div>
    <div class="card"><div class="list-row"><b class="grow" style="color:var(--red);font-size:28px">${d.overdue}</b><span style="color:#6b6b6b">Overdue requests</span></div>
      <div class="list-row"><b class="grow" style="color:var(--red);font-size:28px">${d.ageing}</b><span style="color:#6b6b6b">Pending more than 10 days</span></div></div>
    <div class="section-head"><div><div class="eyebrow">Latest</div><h2>Recent requests</h2></div><a href="#/admin/recommendations">See all â†’</a></div>
    ${recTable(recs.slice(0, 5))}</div>`;
}

function recTable(recs) {
  return `<div class="table-wrap"><table><thead><tr><th>Ref</th><th>Student</th><th>Lecturer</th><th>Status</th><th>Age</th></tr></thead><tbody>
    ${recs.map((r) => `<tr><td>${r.ref}</td><td><b>${esc(r.student_name)}</b></td><td>${esc(r.lecturer_name)}</td><td>${statusTag(r.status)}</td><td>${r.age_days} days</td></tr>`).join('') || `<tr><td colspan="5">${emptyBox('No requests yet.')}</td></tr>`}</tbody></table></div>`;
}

// Generic user table used by Users, Students, Lecturers and Approvals
function userPage({ eyebrow, title, sub, role = '', status = '', filters = true, quick = false }) {
  return async (main) => {
    main.innerHTML = `<div class="wrap">${head(eyebrow, title, sub)}
      ${filters ? `<div class="tools"><input id="q" placeholder="Search name, email or ID" />
        ${role ? '' : '<select id="r"><option value="">All roles</option><option value="student">Students</option><option value="lecturer">Lecturers</option><option value="admin">Admins</option></select>'}
        ${status ? '' : '<select id="s"><option value="">All statuses</option><option value="active">Active</option><option value="pending">Pending</option><option value="suspended">Suspended</option></select>'}</div>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>University ID</th><th>Status</th><th>Actions</th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
    const load = async () => {
      const qs = new URLSearchParams({ role: role || ($('#r', main)?.value || ''), status: status || ($('#s', main)?.value || ''), q: $('#q', main)?.value || '' });
      const users = await api('/admin/users?' + qs);
      $('#tb', main).innerHTML = users.map((u) => `<tr><td><b>${esc(u.full_name)}</b><br><small style="color:#6b6b6b">${esc(u.email)}</small></td><td style="text-transform:capitalize">${u.role}</td><td>${esc(u.university_id)}</td><td>${statusTag(u.status)}</td>
        <td>${quick ? `<button class="btn red sm" data-ok="${u.id}">Approve</button> <button class="btn sm" data-no="${u.id}">Reject</button>` : `<button class="link-btn" data-m="${u.id}">Manage â†’</button>`}</td></tr>`).join('') || `<tr><td colspan="5">${emptyBox('Nothing here.')}</td></tr>`;
      $$('[data-ok]', main).forEach((b) => b.addEventListener('click', async () => { await act(b.dataset.ok, 'active'); load(); }));
      $$('[data-no]', main).forEach((b) => b.addEventListener('click', async () => {
        const reason = prompt('Reason for rejecting this registration (it is emailed to the person):'); if (reason === null) return;
        try { await api(`/admin/users/${b.dataset.no}/reject`, { method: 'POST', body: { reason } }); toast('Registration rejected and the person was emailed'); load(); } catch (e) { toast(e.message, true); }
      }));
      $$('[data-m]', main).forEach((b) => b.addEventListener('click', () => {
        const u = users.find((x) => x.id == b.dataset.m);
        const m = modal(`<h2>${esc(u.full_name)}</h2><p class="small">${esc(u.email)} Â· ${esc(u.university_id)} Â· ${u.role}</p>
          <p style="margin:10px 0">${esc([u.faculty, u.programme, u.year_of_study, u.specialisation].filter(Boolean).join(' Â· ') || 'No academic details.')}</p><p>Status: ${statusTag(u.status)} Â· Registered ${fmtDate(u.created_at)}</p>
          <div class="modal-actions"><button class="btn" data-close>Close</button>${u.status !== 'active' ? '<button class="btn red" data-s="active">Approve / activate</button>' : '<button class="btn" data-s="suspended">Suspend</button>'}<button class="btn dark" data-del>Delete</button></div>`);
        $$('[data-s]', m.el).forEach((x) => x.addEventListener('click', async () => { await act(u.id, x.dataset.s); m.close(); load(); }));
        $('[data-del]', m.el).addEventListener('click', async () => { if (!confirm('Delete this account permanently?')) return; try { await api('/admin/users/' + u.id, { method: 'DELETE' }); m.close(); toast('Account deleted'); load(); } catch (e) { toast(e.message, true); } });
      }));
    };
    const act = async (id, status) => { try { await api('/admin/users/' + id, { method: 'PUT', body: { status } }); toast('Account updated'); } catch (e) { toast(e.message, true); } };
    ['q', 'r', 's'].forEach((id) => $('#' + id, main)?.addEventListener('input', load));
    load();
  };
}

const loadSheetJs = () => window.XLSX ? Promise.resolve(window.XLSX) : new Promise((ok, no) => {
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  s.onload = () => ok(window.XLSX);
  s.onerror = () => no(new Error('Could not load the Excel reader. Save the sheet as CSV and upload that instead.'));
  document.head.appendChild(s);
});

async function roster(main) {
  main.innerHTML = `<div class="wrap">${head('Student list', 'Student list', 'View the official student roster. This page is read-only.')}
    <div id="stats" class="grid g3" style="margin-bottom:16px"></div>
    <div class="tools"><input id="q" placeholder="Search name, ID or programme" /></div>
    <div class="table-wrap"><table><thead><tr><th>Student</th><th>ID</th><th>Programme</th><th>Year</th><th>Account</th></tr></thead><tbody id="tb"></tbody></table></div></div>`;

  const load = async () => {
    try {
      const d = await api('/admin/roster?q=' + encodeURIComponent($('#q', main).value));

      $('#stats', main).innerHTML =
        stat('On the list', d.total, 'Existing roster records') +
        stat('Registered', d.registered, 'Already have an account') +
        stat('Not yet registered', d.total - d.registered, 'Waiting to sign up', true);

      $('#tb', main).innerHTML = d.rows.map((r) => `<tr>
        <td><b>${esc(r.full_name)}</b><br><small style="color:#6b6b6b">${esc(r.email || 'no email on the list')}</small></td>
        <td>${esc(r.university_id)}</td>
        <td>${esc(r.programme || '—')}</td>
        <td>${esc(r.year_of_study || '—')}</td>
        <td>${r.registered ? '<span class="tag ok">Registered</span>' : '<span class="tag">Not yet</span>'}</td>
      </tr>`).join('') || `<tr><td colspan="5">${emptyBox('No students found.')}</td></tr>`;
    } catch (e) {
      $('#tb', main).innerHTML = `<tr><td colspan="5">${emptyBox('Unable to load the student list. Please try again.')}</td></tr>`;
      toast(e.message, true);
    }
  };

  let t;
  $('#q', main).addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(load, 250);
  });

  await load();
}
async function records(main) {
  const draw = async () => {
    const d = await api('/admin/records');
    main.innerHTML = `<div class="wrap">${head('Academic data', 'Academic records', 'Manage programmes, academic years, GPA, CGPA, and student record imports.')}
      <button class="btn red" id="imp" style="margin-bottom:16px">â¬‡ Import records</button>
      <div class="grid g3" style="margin-bottom:16px">${stat('Faculties', d.faculties, 'Recorded on accounts')}${stat('Programmes', d.programmes, 'Recorded on accounts')}${stat('Result rows', d.rows.length, 'Imported + seeded')}</div>
      <div class="table-wrap"><table><thead><tr><th>Student</th><th>ID</th><th>Programme</th><th>Year</th><th>Academic year</th><th>GPA</th><th>Standing</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr><td><b>${esc(r.full_name)}</b></td><td>${esc(r.university_id)}</td><td>${esc(r.programme || '')}</td><td>${esc(r.year_label)}</td><td>${esc(r.academic_year)}</td><td>${r.gpa}</td><td>${esc(r.standing || '')}</td></tr>`).join('') || `<tr><td colspan="7">${emptyBox('No records.')}</td></tr>`}</tbody></table></div></div>`;
    $('#imp', main).addEventListener('click', () => {
      const m = modal(`<h2>Import records</h2><p class="sub">Paste CSV or choose a file. Columns: <code>university_id, year_label, academic_year, gpa, standing</code></p>
        <input type="file" id="file" accept=".csv,text/csv" />${area('CSV data', 'csv', { ph: 'AU-SE-2025-0142,Year 3,2025,3.7,Dean\'s list' })}<div id="res"></div>
        <div class="modal-actions"><button class="btn" data-close>Close</button><button class="btn red" id="run">Import</button></div>`);
      $('#file', m.el).addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) $('textarea', m.el).value = await f.text(); });
      $('#run', m.el).addEventListener('click', async () => {
        try {
          const r = await api('/admin/import', { method: 'POST', body: { csv: $('textarea', m.el).value } });
          $('#res', m.el).innerHTML = `<div class="msg ok">Imported ${r.imported} row(s).</div>${r.warnings.map((w) => `<div class="msg err">${esc(w)}</div>`).join('')}`;
          if (r.imported) draw();
        } catch (e) { toast(e.message, true); }
      });
    });
  };
  await draw();
}

async function recommendations(main) {
  const recs = await api('/recommendations');
  main.innerHTML = `<div class="wrap">${head('Monitoring', 'Recommendation requests', 'Track every request across the university and spot delays.')}${recTable(recs)}</div>`;
}

async function reports(main) {
  const r = await api('/admin/reports');
  main.innerHTML = `<div class="wrap">${head('System insights', 'Reports', 'Review account, academic, and recommendation activity across StudentSphere.')}
    <button class="btn" id="exp" style="margin-bottom:16px">â¬‡ Export report</button>
    <div class="grid g3">${stat('Users', r.users_total, `${r.students} students Â· ${r.lecturers} lecturers`, true)}${stat('Profile completion', r.profile_completion + '%', 'Students with an About section')}${stat('Average CGPA', r.avg_cgpa, 'Across completed years')}
    ${stat('Pending accounts', r.pending_accounts, 'Awaiting approval')}${stat('Letters completed', r.recs_completed, `of ${r.recs_total} requests Â· ${r.recs_declined} declined`)}${stat('Letters still open', r.recs_open, 'Not yet submitted')}
    ${stat('Achievements verified', r.achievements_verified, `of ${r.achievements_total} submitted`)}${stat('Awaiting verification', r.achievements_awaiting, `${r.achievements_rejected} rejected`)}${stat('Emails', r.emails_sent, `${r.emails_failed} failed`)}</div></div>`;
  $('#exp', main).addEventListener('click', () => downloadFile('studentsphere-report.csv', 'metric,value\n' + Object.entries(r).map(([k, v]) => `${k},${v ?? ''}`).join('\n')));
}

async function achievements(main) {
  const draw = async () => {
    const filter = $('#flt', main)?.value || '';
    const response = await api('/achievements' + (filter ? '?status=' + filter : ''));
    const rows = Array.isArray(response) ? response : (response.achievements || []);
    main.innerHTML = `<div class="wrap">${head('Monitoring', 'Achievement verification', 'Read-only overview. Only the assigned lecturer can verify or reject an achievement.')}
      <div class="tools"><select id="flt"><option value="">All statuses</option>${['pending_verification', 'under_review', 'evidence_required', 'verified', 'rejected'].map((x) => `<option value="${x}" ${x === filter ? 'selected' : ''}>${x.replace(/_/g, ' ')}</option>`).join('')}</select></div>
      <div class="table-wrap"><table><thead><tr><th>Student</th><th>Title</th><th>Category</th><th>Lecturer</th><th>Submitted</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((a) => `<tr><td><b>${esc(a.student_name)}</b><br><small>${esc(a.student_uid)}</small></td><td>${esc(a.title)}</td><td>${esc(a.category || '')}</td><td>${esc(a.lecturer_name || 'âš  none')}</td><td>${fmtDate(a.created_at)}</td><td>${statusTag(a.status)}</td><td><button class="link-btn" data-id="${a.id}">Details â†’</button></td></tr>`).join('') || `<tr><td colspan="7">${emptyBox('Nothing here.')}</td></tr>`}</tbody></table></div></div>`;
    $('#flt', main).addEventListener('change', draw);
    $$('[data-id]', main).forEach((b) => b.addEventListener('click', async () => {
      const d = await api('/achievements/' + b.dataset.id); const a = d.achievement;
      const m = modal(`<h2>${esc(a.title)} ${verifiedBadge(a)}</h2><p>${statusTag(a.status)}</p><p class="small">${esc(d.student.full_name)} Â· ${esc(d.student.university_id)} Â· Lecturer: ${esc(a.lecturer_name || 'none')}</p>
        <p style="margin:10px 0">${esc(a.description || '')}</p><p class="small">${esc(a.organisation || '')} Â· obtained ${fmtDate(a.date_obtained)}</p>
        ${a.reviewer_comment ? `<div class="msg ok">${esc(REASON_LABEL[a.reason_code] || '')} ${esc(a.reviewer_comment)}</div>` : ''}<div>${fileList(a.files)}</div>
        ${d.history.map((h) => `<p class="small" style="margin:6px 0">${fmtDate(h.created_at)} Â· ${esc(h.lecturer_name || 'student')} Â· ${esc(h.action.replace(/_/g, ' '))}${h.comments ? ' â€” ' + esc(h.comments) : ''}</p>`).join('')}
        <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
      bindFiles(m.el, openFile);
    }));
  };
  await draw();
}

async function assignments(main) {
  const draw = async () => {
    const d = await api('/admin/assignments');
    main.innerHTML = `<div class="wrap">${head('Administration', 'Lecturer assignments', 'Assign each student to the lecturers who can see their profile and verify their achievements. The primary lecturer receives new achievements by default.')}
      <div class="table-wrap"><table><thead><tr><th>Student</th><th>Assigned lecturers</th><th>Add lecturer</th></tr></thead><tbody>
      ${d.students.map((s) => `<tr><td><b>${esc(s.full_name)}</b><br><small>${esc(s.university_id)} Â· ${esc(s.programme || '')}</small></td>
        <td>${s.assignments.map((a) => `<span class="chip" style="margin:2px">${esc(a.lecturer_name)}${a.is_primary ? ' â˜…' : ''} <button class="link-btn" data-rm="${a.id}" title="Remove">âœ•</button></span>`).join('') || '<small>None</small>'}</td>
        <td><div style="display:flex;gap:6px"><select data-sel="${s.id}"><option value="">Chooseâ€¦</option>${d.lecturers.map((l) => `<option value="${l.id}">${esc(l.full_name)}</option>`).join('')}</select>
          <label class="checkline" style="margin:0;white-space:nowrap"><input type="checkbox" data-pri="${s.id}" /> primary</label><button class="btn sm red" data-add="${s.id}">Assign</button></div></td></tr>`).join('') || `<tr><td colspan="3">${emptyBox('No active students.')}</td></tr>`}</tbody></table></div></div>`;
    $$('[data-add]', main).forEach((b) => b.addEventListener('click', async () => {
      const lecturer_id = $(`[data-sel="${b.dataset.add}"]`, main).value; if (!lecturer_id) return toast('Choose a lecturer first', true);
      try { await api('/admin/assignments', { method: 'POST', body: { student_id: b.dataset.add, lecturer_id, is_primary: $(`[data-pri="${b.dataset.add}"]`, main).checked } }); toast('Assigned'); draw(); } catch (e) { toast(e.message, true); }
    }));
    $$('[data-rm]', main).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Remove this assignment?')) return; await api('/admin/assignments/' + b.dataset.rm, { method: 'DELETE' }); draw(); }));
  };
  await draw();
}

async function emails(main) {
  const draw = async () => {
    const d = await api('/admin/emails');
    const dev = d.mode !== 'smtp';
    main.innerHTML = `<div class="wrap">${head('Notifications', 'Email log', 'Every email StudentSphere creates is recorded here.')}
      <div class="msg ${dev ? 'err' : 'ok'}">${dev ? '<b>DEV mode:</b> no real emails are sent. Click a row to preview exactly what would be delivered. To send real email, set the SMTP settings in your .env file (see README).' : '<b>SMTP mode:</b> emails are sent through your mail server.'} Links in emails point to <code>${esc(d.app_url)}</code>.</div>
      <button class="btn" id="test" style="margin-bottom:14px">Send a test email to me</button>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>
      ${d.rows.map((e) => `<tr style="cursor:pointer" data-id="${e.id}"><td>${fmtDate(e.created_at)}<br><small>${ago(e.created_at)}</small></td><td>${esc(e.to_email)}</td><td>${esc(e.subject)}</td><td><span class="tag ${e.status === 'sent' ? 'ok' : e.status === 'failed' ? 'red' : ''}">${esc(e.status)}</span>${e.error ? `<br><small style="color:#a30d25">${esc(e.error)}</small>` : ''}</td></tr>`).join('') || `<tr><td colspan="4">${emptyBox('No emails yet.')}</td></tr>`}</tbody></table></div></div>`;
    $('#test', main).addEventListener('click', async () => { try { await api('/admin/email-test', { method: 'POST' }); toast('Test email created'); setTimeout(draw, 800); } catch (e) { toast(e.message, true); } });
    $$('tr[data-id]', main).forEach((tr) => tr.addEventListener('click', async () => {
      const e = await api('/admin/emails/' + tr.dataset.id);
      const m = modal(`<h2>${esc(e.subject)}</h2><p class="small">To: ${esc(e.to_email)} Â· ${esc(e.status)}</p><iframe sandbox style="width:100%;height:520px;border:1px solid #e8e8ea;border-radius:12px;margin-top:10px"></iframe><div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
      $('iframe', m.el).srcdoc = e.body_html || '';
    }));
  };
  await draw();
}

async function audit(main) {
  const rows = await api('/admin/audit');
  main.innerHTML = `<div class="wrap">${head('Security', 'Audit trail', 'Important actions: who did what, to which student, when, and why.')}
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Student</th><th>Decision</th><th>Reason / comment</th></tr></thead><tbody>
    ${rows.map((g) => `<tr><td>${fmtDate(g.created_at)}<br><small>${ago(g.created_at)}</small></td><td>${esc(g.actor_name || 'System')}<br><small>${esc(g.actor_role || '')}</small></td><td>${esc(g.action)}</td><td>${esc(g.student_name || 'â€”')}</td><td>${g.decision ? statusTag(g.decision) : 'â€”'}</td><td>${esc(g.comments || '')}</td></tr>`).join('') || `<tr><td colspan="6">${emptyBox('No activity recorded.')}</td></tr>`}</tbody></table></div></div>`;
}

export const adminPages = {
  dashboard,
  users: userPage({ eyebrow: 'Administration', title: 'User management', sub: 'Search, approve, suspend or remove accounts.' }),
  approvals: userPage({ eyebrow: 'Administration', title: 'Account approvals', sub: 'New registrations wait here until you approve them.', status: 'pending', quick: true, filters: false }),
  students: userPage({ eyebrow: 'Directory', title: 'Students', sub: 'All student accounts.', role: 'student' }),
  lecturers: userPage({ eyebrow: 'Directory', title: 'Lecturers', sub: 'All lecturer accounts.', role: 'lecturer' }),
  assignments, roster, records, recommendations, achievements, reports, emails, audit, notifications: notificationsPage, settings: settingsPage
};
