import { api, openFile } from './api.js';
import { esc, $, $$, fmtDate, ago, toast, modal, field, area, formData, emptyBox, statusTag, showLetter, verifiedBadge, fileList, bindFiles, REASON_LABEL } from './ui.js';
import { notificationsPage, settingsPage } from './shared.js';

const stat = (label, n, note = '', red = false) => `<div class="card stat"><small>${label}</small><div class="n ${red ? 'red' : ''}">${n ?? '—'}</div><span>${note}</span></div>`;
const head = (eyebrow, title, sub = '') => `<div class="eyebrow">${eyebrow}</div><h1 class="page-title">${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}`;
const greet = (n) => { const p = n.split(' '); return /^(Dr|Prof)\./.test(p[0]) ? p[0] + ' ' + p[p.length - 1] : p[0]; };

// ------------------------------------------------------------------ dashboard
async function dashboard(main, { user }) {
  const d = await api('/dashboard');
  main.innerHTML = `<div class="wrap"><div class="hero"><div><div class="eyebrow">Lecturer workspace</div><h1>Welcome back, ${esc(greet(user.full_name))}</h1>
    <p>Review student requests, verify achievements, and provide thoughtful recommendations.</p></div>
    <div class="hero-actions"><a class="btn white" href="#/lecturer/requests">Recommendation requests →</a><a class="btn ghost-w" href="#/lecturer/achievements">Verify achievements</a></div></div>
    <div class="grid g3">${stat('Total assigned students', d.assigned, 'Assigned by the administrator')}${stat('Pending recommendation requests', d.pending_recs, 'Waiting for you', true)}${stat('Completed recommendations', d.completed_recs, 'Letters submitted')}
    ${stat('Pending achievement verifications', d.pending_ach, 'Need your review', true)}${stat('Verified achievements', d.verified_ach, 'Verified by you')}</div>
    <div class="section-head"><div><div class="eyebrow">Needs attention</div><h2>Requests requiring action</h2></div><a href="#/lecturer/students">Search students →</a></div>
    <div class="table-wrap"><table><thead><tr><th>Type</th><th>Item</th><th>Student</th><th>Status</th><th>Received</th><th></th></tr></thead><tbody>
    ${d.attention.map((x) => `<tr><td>${x.type}</td><td><b>${esc(x.title)}</b></td><td>${esc(x.student)}</td><td>${statusTag(x.status)}</td><td>${fmtDate(x.date)}</td><td><a href="#${x.link}">Open →</a></td></tr>`).join('') || `<tr><td colspan="6">${emptyBox('Nothing waiting for you.')}</td></tr>`}</tbody></table></div>
    <div class="section-head"><div><div class="eyebrow">Recent</div><h2>Recent activity</h2></div></div>
    <div class="card">${d.recent.length ? d.recent.map((n) => `<div class="list-row"><div class="ic">✉</div><div class="grow"><b>${esc(n.title)}</b><small>${esc(n.body)}</small></div>${n.link ? `<a href="#${n.link}">Open</a>` : ''}<small>${ago(n.created_at)}</small></div>`).join('') : emptyBox('No activity yet.')}</div></div>`;
}

// ------------------------------------------------------------------ my profile
async function profile(main) {
  const p = await api('/me/profile'); const u = p.user, pr = p.profile;
  main.innerHTML = `<div class="wrap">${head('Lecturer', 'My profile', 'Students can see this information when they choose a lecturer.')}
    <div class="card"><form id="pf"><div class="row2">${field('Full name', 'full_name', { value: u.full_name, req: true })}${field('Headline', 'headline', { value: pr.headline })}</div>
      <div class="row2">${field('Faculty or department', 'faculty', { value: u.faculty })}${field('Phone', 'phone', { value: pr.phone })}</div>
      ${field('Area of specialisation', 'specialisation', { value: u.specialisation })}${area('About', 'about', { value: pr.about })}${field('Location', 'location', { value: pr.location })}
      <div class="modal-actions"><button class="btn red">Save changes ✓</button></div></form></div></div>`;
  $('#pf', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/me/profile', { method: 'PUT', body: formData(e.target) }); toast('Profile saved'); } catch (er) { toast(er.message, true); }
  });
}

// ------------------------------------------------------------------ student summary (read-only)
function summary(b, { files = true } = {}) {
  const u = b.user, pr = b.profile;
  return `<div class="grid g2" style="margin:12px 0"><div class="card" style="box-shadow:none"><small style="color:#6b6b6b">PROGRAMME</small><p><b>${esc(u.programme || '—')}</b></p><p>${esc(u.faculty || '')} · ${esc(u.year_of_study || '')}</p><p>${esc(u.university_id)}</p></div>
    <div class="card" style="box-shadow:none"><small style="color:#6b6b6b">CGPA</small><div style="font-size:34px;font-weight:800;color:var(--red)">${b.cgpa ?? '—'}</div></div></div>
    <div class="table-wrap" style="margin-bottom:12px"><table style="min-width:0"><thead><tr><th>Year</th><th>Academic year</th><th>GPA</th><th>Standing</th></tr></thead><tbody>
      ${b.results.map((r) => `<tr><td>${esc(r.year_label)}</td><td>${esc(r.academic_year)}</td><td><b>${r.gpa}</b></td><td>${esc(r.standing || '')}</td></tr>`).join('') || '<tr><td colspan="4">No results recorded.</td></tr>'}</tbody></table></div>
    ${pr.about ? `<p style="color:#444;margin-bottom:10px">${esc(pr.about)}</p>` : ''}
    <p><b>Skills:</b> ${pr.skills.map(esc).join(', ') || '—'}</p>
    <p><b>Projects:</b> ${b.projects.map((p) => esc(p.title)).join(', ') || '—'}</p>
    <div style="margin-top:8px"><b>Achievements:</b>${b.achievements.length ? b.achievements.map((a) => `<div style="padding:8px 0;border-bottom:1px solid var(--line)">${esc(a.title)} <small>(${esc(a.category || '')})</small> ${verifiedBadge(a)} ${a.status !== 'verified' ? statusTag(a.status) : ''}
      ${files && a.files.length ? '<div>' + fileList(a.files) + '</div>' : ''}</div>`).join('') : ' —'}</div>`;
}

// ------------------------------------------------------------------ student directory + full profile
async function students(main) {
  const list = await api('/students');
  const draw = (q = '') => {
    const rows = list.filter((s) => (s.full_name + (s.programme || '') + s.university_id).toLowerCase().includes(q.toLowerCase()));
    $('#tb', main).innerHTML = rows.map((s) => `<tr><td><b>${esc(s.full_name)}</b></td><td>${esc(s.university_id)}</td><td>${esc(s.programme || '—')}</td><td>${esc(s.year_of_study || '—')}</td><td><b>${s.cgpa ?? '—'}</b></td><td><a href="#/lecturer/student/${s.id}">Open profile →</a></td></tr>`).join('') || `<tr><td colspan="6">${emptyBox('No students found.')}</td></tr>`;
  };
  main.innerHTML = `<div class="wrap">${head('Directory', 'Student profiles', 'Students assigned to you, or who have sent you a request or achievement.')}
    <div class="tools"><input id="q" placeholder="Search by name, programme or ID" /></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Student ID</th><th>Programme</th><th>Year</th><th>CGPA</th><th></th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
  draw(); $('#q', main).addEventListener('input', (e) => draw(e.target.value));
}

async function studentProfile(main, { param }) {
  const b = await api(`/students/${param}/profile`);
  const u = b.user, pr = b.profile;
  main.innerHTML = `<div class="wrap"><a href="#/lecturer/students">← Back to students</a>
    <div class="prof-hero" style="margin-top:14px"><div class="big-av">${esc(u.full_name.split(' ').slice(0, 2).map((w) => w[0]).join(''))}</div>
      <div><div class="eyebrow" style="color:#ff8a9b">${esc(u.programme || 'Student')} · ${esc(u.year_of_study || '')}</div><h1>${esc(u.full_name)}</h1><p>${esc(pr.headline || '')}</p><p style="font-size:13px">${esc(u.university_id)} · ${esc(u.faculty || '')} · ${esc(u.email)}</p></div></div>
    <div class="section-head"><div><div class="eyebrow">Overview</div><h2>Academic summary</h2></div></div>
    <div class="card">${summary(b)}</div>
    <div class="section-head"><div><div class="eyebrow">Experience</div><h2>Experience & projects</h2></div></div>
    <div class="card"><p>${esc(pr.experience || 'No experience added.')}</p></div>
    ${b.projects.map((x, i) => `<div class="proj" style="margin-top:12px"><div class="pv">PROJECT<br>0${i + 1}</div><div class="pb"><h3>${esc(x.title)}</h3><p style="color:#555">${esc(x.description || '')}</p><p class="small">${esc(x.tech || '')}</p>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">View project →</a>` : ''}</div></div>`).join('')}</div>`;
  bindFiles(main, openFile);
}

// ------------------------------------------------------------------ recommendation management
function template(b, rec) {
  const u = b.user, first = u.full_name.split(' ')[0];
  const ach = b.achievements.find((a) => a.status === 'verified');
  return `I am pleased to recommend ${u.full_name}, a ${u.year_of_study || ''} ${u.programme || ''} student at Africa University, for ${rec.purpose.toLowerCase()}.

${first} holds a cumulative GPA of ${b.cgpa ?? 'n/a'} and has shown ${ach ? 'verified achievement, including ' + ach.title : 'a strong commitment to their studies'}. ${first} works well with others, takes initiative, and responds constructively to feedback.

I recommend ${first} without reservation and would be glad to provide further information on request.`;
}

async function openRequest(recId, refresh) {
  let rec = (await api('/recommendations')).find((r) => r.id == recId);
  if (!rec) return toast('That request was not found', true);
  if (rec.status === 'pending') { await api('/recommendations/' + rec.id, { method: 'PUT', body: { action: 'start_review' } }); rec.status = 'under_review'; refresh && refresh(); }
  const b = await api(`/students/${rec.student_id}/profile`);
  const m = modal('<div id="rv"></div>'); m.el.style.maxWidth = '860px';
  const act = async (action, body = {}) => {
    try {
      await api('/recommendations/' + rec.id, { method: 'PUT', body: { action, ...body } });
      rec = (await api('/recommendations')).find((r) => r.id == rec.id); render(); refresh && refresh();
      toast({ approve: 'Approved. The student was notified.', decline: 'Declined. The student was notified.', more_info: 'Request sent to the student.', save_draft: 'Draft saved', submit: 'Letter submitted. The student was notified.' }[action] || 'Updated');
    } catch (e) { toast(e.message, true); }
  };
  const render = () => {
    const el = $('#rv', m.el);
    const open = ['pending', 'under_review'].includes(rec.status);
    el.innerHTML = `<div class="eyebrow">${rec.ref} · ${statusTag(rec.status)}</div><h2>${esc(b.user.full_name)} — ${esc(rec.purpose)}</h2>
      <p class="small">Submitted ${fmtDate(rec.created_at)} · Deadline ${fmtDate(rec.deadline)} · <a href="#/lecturer/student/${b.user.id}" id="full">Open complete profile →</a></p>
      ${summary(b)}
      <div class="card" style="box-shadow:none;margin:12px 0"><small style="color:#6b6b6b">STUDENT'S REASON FOR REQUESTING</small><p style="white-space:pre-wrap">${esc(rec.message || 'No message.')}</p></div>
      ${open ? `<div class="modal-actions" style="justify-content:flex-start"><button class="btn red" id="a-ok">✓ Approve request</button><button class="btn" id="a-info">Request more information</button><button class="btn dark" id="a-no">Decline request</button></div><div id="panel"></div>` : ''}
      ${rec.status === 'more_info' ? `<div class="msg ok">Waiting for the student to reply to: ${esc(rec.info_request || '')}</div>` : ''}
      ${rec.status === 'approved' ? `<h3 style="margin-top:8px">Write the recommendation letter</h3><form id="lf">${area('Letter', 'letter', { value: rec.letter || template(b, rec) })}
        <label class="checkline" style="margin:10px 0"><input type="checkbox" name="release" checked /> Let the student view and download this letter (uncheck if university policy says it must stay confidential)</label>
        <div class="modal-actions"><button type="button" class="btn" data-close>Close</button><button type="button" class="btn" id="a-no">Decline instead</button><button type="button" class="btn" id="a-draft">Save draft</button><button type="button" class="btn red" id="a-sub">Submit letter ✓</button></div></form><div id="panel"></div>` : ''}
      ${['completed', 'declined'].includes(rec.status) ? `<div class="msg ok">This request is ${rec.status}.</div><div class="modal-actions"><button class="btn" data-close>Close</button></div>` : ''}
      ${open ? '<div class="modal-actions"><button class="btn" data-close>Close</button></div>' : ''}`;
    $$('[data-close]', el).forEach((x) => x.addEventListener('click', m.close));
    $('#full', el)?.addEventListener('click', m.close);
    bindFiles(el, openFile);
    const panel = (title, ph, key, label, run) => {
      $('#panel', el).innerHTML = `<div class="card" style="box-shadow:none;margin-top:12px"><b>${title}</b>${area('', 'txt', { ph })}<button class="btn red sm" id="go">${label}</button></div>`;
      $('#go', el).addEventListener('click', () => run($('#panel textarea', el).value));
    };
    $('#a-ok', el)?.addEventListener('click', () => act('approve'));
    $('#a-info', el)?.addEventListener('click', () => panel('What information do you need from the student?', 'e.g. Which organisation is this for?', 'note', 'Send to student', (v) => act('more_info', { note: v })));
    $('#a-no', el)?.addEventListener('click', () => panel('Reason for declining (shown to the student)', 'Explain why you cannot provide this recommendation…', 'reason', 'Decline request', (v) => act('decline', { reason: v })));
    const lf = $('#lf', el);
    if (lf) {
      $('#a-draft', el).addEventListener('click', () => act('save_draft', { letter: lf.letter.value }));
      $('#a-sub', el).addEventListener('click', () => { if (confirm('Submit this letter? The student will be notified.')) act('submit', { letter: lf.letter.value, release: lf.release.checked }); });
    }
  };
  render();
}

async function requests(main, { param }) {
  const draw = async () => {
    const recs = (await api('/recommendations')).filter((r) => !['completed', 'declined'].includes(r.status));
    main.innerHTML = `<div class="wrap">${head('Recommendation management', 'Recommendation requests', 'Open a request to review the student, then approve, decline, or ask for more information.')}
      <div class="table-wrap"><table><thead><tr><th>Ref</th><th>Student</th><th>Programme</th><th>Purpose</th><th>Deadline</th><th>Status</th><th></th></tr></thead><tbody>
      ${recs.map((r) => `<tr><td>${r.ref}</td><td><b>${esc(r.student_name)}</b></td><td>${esc(r.student_programme || '')}</td><td>${esc(r.purpose)}</td><td>${fmtDate(r.deadline)}</td><td>${statusTag(r.status)}</td><td><button class="link-btn" data-id="${r.id}">Open →</button></td></tr>`).join('') || `<tr><td colspan="7">${emptyBox('No open requests. 🎉')}</td></tr>`}</tbody></table></div></div>`;
    $$('[data-id]', main).forEach((btn) => btn.addEventListener('click', () => openRequest(btn.dataset.id, draw)));
  };
  await draw();
  if (param) openRequest(param, draw);
}

async function completed(main) {
  const recs = (await api('/recommendations')).filter((r) => ['completed', 'declined'].includes(r.status));
  main.innerHTML = `<div class="wrap">${head('Recommendation management', 'Completed recommendations', 'Letters you have submitted and requests you declined.')}
    <div class="table-wrap"><table><thead><tr><th>Student</th><th>Programme</th><th>Purpose</th><th>Deadline</th><th>Status</th><th>Action</th></tr></thead><tbody>
    ${recs.map((r) => `<tr><td><b>${esc(r.student_name)}</b></td><td>${esc(r.student_programme || '')}</td><td>${esc(r.purpose)}</td><td>${fmtDate(r.deadline)}</td><td>${statusTag(r.status)}${r.decline_reason ? `<br><small>${esc(r.decline_reason)}</small>` : ''}</td>
      <td>${r.status === 'completed' ? `<button class="link-btn" data-id="${r.id}">View letter →</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6">${emptyBox('Nothing here yet.')}</td></tr>`}</tbody></table></div></div>`;
  $$('[data-id]', main).forEach((b) => b.addEventListener('click', () => showLetter(recs.find((r) => r.id == b.dataset.id))));
}

// ------------------------------------------------------------------ achievement verification
async function openAchievement(id, refresh) {
  let d = await api('/achievements/' + id);
  if (d.achievement.status === 'pending_verification') {
    await api(`/achievements/${id}/review`, { method: 'PUT', body: { action: 'start_review' } }); d = await api('/achievements/' + id); refresh && refresh();
  }
  const m = modal('<div id="av"></div>'); m.el.style.maxWidth = '860px';
  const act = async (body, okMsg) => {
    try { await api(`/achievements/${id}/review`, { method: 'PUT', body }); d = await api('/achievements/' + id); render(); refresh && refresh(); toast(okMsg); }
    catch (e) { toast(e.message, true); }
  };
  const render = () => {
    const a = d.achievement, s = d.student, el = $('#av', m.el);
    const deciding = ['pending_verification', 'under_review'].includes(a.status);
    el.innerHTML = `<div class="eyebrow">Achievement verification</div><h2>${esc(a.title)} ${verifiedBadge(a)}</h2><p>${statusTag(a.status)}</p>
      <div class="grid g2" style="margin:12px 0"><div class="card" style="box-shadow:none"><small style="color:#6b6b6b">STUDENT</small><p><b>${esc(s.full_name)}</b></p><p>${esc(s.university_id)} · ${esc(s.programme || '')}</p><p>${esc(s.faculty || '')} · CGPA ${d.cgpa ?? '—'}</p><a href="#/lecturer/student/${s.id}" id="full">Open complete profile →</a></div>
        <div class="card" style="box-shadow:none"><small style="color:#6b6b6b">ACHIEVEMENT</small><p><b>${esc(a.category || '')}</b></p><p>Organisation: ${esc(a.organisation || '—')}</p><p>Date obtained: ${fmtDate(a.date_obtained)}</p><p>Submitted: ${fmtDate(a.created_at)}</p></div></div>
      <div class="card" style="box-shadow:none;margin-bottom:12px"><small style="color:#6b6b6b">DESCRIPTION</small><p style="white-space:pre-wrap">${esc(a.description || '—')}</p></div>
      ${a.evidence_note ? `<div class="card" style="box-shadow:none;margin-bottom:12px"><small style="color:#6b6b6b">ADDITIONAL EVIDENCE FROM STUDENT</small><p style="white-space:pre-wrap">${esc(a.evidence_note)}</p></div>` : ''}
      ${a.student_response ? `<div class="card" style="box-shadow:none;margin-bottom:12px"><small style="color:#6b6b6b">STUDENT'S REPLY TO YOUR EVIDENCE REQUEST</small><p style="white-space:pre-wrap">${esc(a.student_response)}</p></div>` : ''}
      <div style="margin-bottom:12px"><b>Uploaded certificate and evidence</b><div style="margin-top:6px">${fileList(a.files)}</div></div>
      ${d.history.length ? `<details style="margin-bottom:12px"><summary><b>History</b></summary>${d.history.map((h) => `<p class="small" style="margin:6px 0">${fmtDate(h.created_at)} · ${esc(h.action.replace(/_/g, ' '))}${h.decision ? ' → ' + esc(h.decision.replace(/_/g, ' ')) : ''}${h.comments ? ' — ' + esc(h.comments) : ''}</p>`).join('')}</details>` : ''}
      ${deciding ? `<div class="msg ok" style="background:#f6f6f7;border-color:#e4e4e7;color:#333">Decide using <b>evidence, accuracy, relevance and university guidelines</b> — not personal opinion. Check that the certificate is genuine, the description is accurate, and the evidence is sufficient. Rejections need a reason.</div>
        <div class="modal-actions" style="justify-content:flex-start"><button class="btn red" id="v-ok">✓ Verify achievement</button><button class="btn" id="v-ev">Request additional evidence</button><button class="btn dark" id="v-no">Reject achievement</button></div><div id="panel"></div>` : ''}
      ${a.status === 'evidence_required' ? `<div class="msg ok">Waiting for the student. You asked: ${esc(a.evidence_request || '')}</div>` : ''}
      ${a.status === 'rejected' ? `<div class="msg err">Rejected — ${esc(REASON_LABEL[a.reason_code] || '')}: ${esc(a.reviewer_comment || '')}</div>` : ''}
      ${a.status === 'verified' ? `<div class="msg ok">Verified${a.reviewer_comment ? ': ' + esc(a.reviewer_comment) : ''}</div>` : ''}
      <div class="modal-actions"><button class="btn" data-close>Close</button></div>`;
    $$('[data-close]', el).forEach((x) => x.addEventListener('click', m.close));
    $('#full', el)?.addEventListener('click', m.close);
    bindFiles(el, openFile);
    const panel = (html, run, label) => {
      $('#panel', el).innerHTML = `<div class="card" style="box-shadow:none;margin-top:12px">${html}<button class="btn red sm" id="go" style="margin-top:10px">${label}</button></div>`;
      $('#go', el).addEventListener('click', run);
    };
    const txt = () => $('#panel textarea', el).value;
    $('#v-ok', el)?.addEventListener('click', () => panel(area('Comment (optional)', 'c', { ph: 'e.g. Confirmed with the organiser.' }), () => act({ action: 'verify', comment: txt() }, 'Verified. The student was notified.'), 'Confirm verification'));
    $('#v-ev', el)?.addEventListener('click', () => panel(area('What evidence or clarification do you need?', 'c', { ph: 'e.g. Please upload the full certificate showing the organiser’s signature.' }), () => act({ action: 'request_evidence', comment: txt() }, 'Request sent to the student.'), 'Send request'));
    $('#v-no', el)?.addEventListener('click', () => panel(`<label>Reason for rejection <span class="req">*</span></label><select id="rc">${Object.entries(REASON_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>${area('Explanation (shown to the student)', 'c', { ph: 'Explain what is wrong, based on the evidence…' })}`,
      () => act({ action: 'reject', reason_code: $('#rc', el).value, comment: txt() }, 'Rejected. The student was notified.'), 'Confirm rejection'));
  };
  render();
}

async function achievements(main, { param }) {
  const draw = async () => {
    const filter = $('#flt', main)?.value || '';
    const rows = await api('/achievements' + (filter ? '?status=' + filter : ''));
    main.innerHTML = `<div class="wrap">${head('Verification', 'Achievement verification', 'Achievements submitted by students. Only achievements you verify show a Verified badge.')}
      <div class="tools"><select id="flt"><option value="">All statuses</option>${['pending_verification', 'under_review', 'evidence_required', 'verified', 'rejected'].map((s) => `<option value="${s}" ${s === filter ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}</select></div>
      <div class="table-wrap"><table><thead><tr><th>Student name</th><th>Student ID</th><th>Achievement title</th><th>Category</th><th>Date submitted</th><th>Verification status</th><th>Action</th></tr></thead><tbody>
      ${rows.map((a) => `<tr><td><b>${esc(a.student_name)}</b></td><td>${esc(a.student_uid)}</td><td>${esc(a.title)}</td><td>${esc(a.category || '')}</td><td>${fmtDate(a.created_at)}</td><td>${statusTag(a.status)}</td><td><button class="link-btn" data-id="${a.id}">View details →</button></td></tr>`).join('') || `<tr><td colspan="7">${emptyBox('No achievements to verify.')}</td></tr>`}</tbody></table></div></div>`;
    $('#flt', main).addEventListener('change', draw);
    $$('[data-id]', main).forEach((b) => b.addEventListener('click', () => openAchievement(b.dataset.id, draw)));
  };
  await draw();
  if (param) openAchievement(param, draw);
}

export const lecturerPages = { dashboard, profile, students, student: studentProfile, requests, achievements, completed, notifications: notificationsPage, settings: settingsPage };
