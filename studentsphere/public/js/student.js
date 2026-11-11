import { api, openFile } from './api.js';
import { esc, $, $$, fmtDate, ago, toast, modal, field, area, select, formData, emptyBox, statusTag, showLetter, initials, verifiedBadge, readFiles, fileList, bindFiles, REASON_LABEL } from './ui.js';
import { notificationsPage, settingsPage } from './shared.js';

const stat = (label, n, note = '', red = false) => `<div class="card stat"><small>${label}</small><div class="n ${red ? 'red' : ''}">${n ?? '—'}</div><span>${note}</span></div>`;
const head = (eyebrow, title, sub = '') => `<div class="eyebrow">${eyebrow}</div><h1 class="page-title">${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}`;

const asArray = (value) => {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
};

async function dashboard(main, { user }) {
  const d = await api('/dashboard');
  const first = user.full_name.split(' ')[0];
  const quick = [['profile', '👤', 'About me'], ['performance', '📊', 'Academic performance'], ['achievements', '🏅', 'Achievements'], ['projects', '💻', 'Projects'], ['recommendations', '📄', 'Recommendations'], ['edit-profile', '✏️', 'Edit profile']];
  main.innerHTML = `<div class="wrap">
    <div class="hero"><div><div class="eyebrow">Student workspace</div><h1>Welcome back, ${esc(first)}</h1>
      <p>Keep your profile current, track your results and request recommendation letters from your lecturers.</p></div>
      <div class="hero-actions"><a class="btn white" href="#/student/profile">View profile</a><a class="btn ghost-w" href="#/student/recommendations">Request a letter</a></div></div>
    <div class="grid g3">${stat('CGPA', d.cgpa, 'Cumulative average', true)}${stat('Projects', d.projects, 'In your portfolio')}${stat('Achievements', d.achievements, `${d.verified} verified by lecturers`)}${stat('Letters ready', d.recs_ready, `${d.recs_total} requested in total`)}</div>
    ${d.needs_action ? `<div class="msg err" style="margin-top:14px">⚠ ${d.needs_action} item(s) need your response: a lecturer asked for more information or evidence. <a href="#/student/achievements">Achievements</a> · <a href="#/student/recommendations">Recommendations</a></div>` : ''}
    <div class="section-head"><div><div class="eyebrow">Recent</div><h2>Activity & achievements</h2></div></div>
    <div class="card">${d.recent.length ? d.recent.map((n) => `<div class="list-row"><div class="ic">✓</div><div class="grow"><b>${esc(n.title)}</b><small>${esc(n.body)}</small></div><small>${ago(n.created_at)}</small></div>`).join('') : emptyBox('No activity yet.')}</div>
    <div class="section-head"><div><div class="eyebrow">Explore your portfolio</div><h2>Quick links</h2></div></div>
    <div class="grid g3">${quick.map(([k, i, l]) => `<a class="card" href="#/student/${k}" style="color:inherit"><div class="ic" style="font-size:22px">${i}</div><b style="display:block;margin-top:8px">${l}</b><small style="color:#6b6b6b">Open →</small></a>`).join('')}</div></div>`;
}

async function profile(main, { user }) {
  const p = await api('/me/profile');
  const pr = p.profile || {}, u = p.user || {};
  const skills = asArray(pr.skills);
  const achievements = asArray(p.achievements);
  const projects = asArray(p.projects);
  const sec = (id, num, label, title, body) => `<section class="psec" id="sec-${id}"><div class="eyebrow">${num} / ${label}</div><h2>${title}</h2>${body}</section>`;
  main.innerHTML = `<div class="wrap print-area">
    <div class="prof-hero"><div class="big-av">${esc(initials(u.full_name))}</div>
      <div style="flex:1;min-width:220px"><div class="eyebrow" style="color:#ff8a9b">${esc(u.programme || 'Student')} · ${esc(u.year_of_study || '')}</div>
      <h1>${esc(u.full_name)}</h1><p>${esc(pr.headline || '')}</p><p style="font-size:13px;margin-top:4px">${esc(u.university_id)} · ${esc(u.faculty || '')}</p>
      <div class="hero-actions no-print" style="margin-top:16px"><a class="btn white sm" href="#/student/edit-profile">✏ Edit profile</a><button class="btn dark sm" id="cv" style="border-color:#444">⬇ Download CV</button><a class="btn ghost-w sm" href="#/student/recommendations">Recommendation</a></div></div></div>
    <div class="tabs no-print">${[['about', 'About Me'], ['skills', 'Skills'], ['education', 'Education'], ['ach', 'Achievements'], ['projects', 'Projects'], ['contact', 'Contact']].map(([k, l]) => `<button data-s="${k}">${l}</button>`).join('')}</div>
    ${sec('about', '01', 'About me', 'Curious by nature.<br>Driven by possibility.', `<p style="max-width:680px;color:#444">${esc(pr.about || 'Tell people about yourself in Edit profile.')}</p>`)}
    ${sec('skills', '02', 'Skills', 'What I work with', `<div class="chips">${skills.length ? skills.map((s) => `<span class="chip">${esc(s)}</span>`).join('') : emptyBox('No skills added yet.')}</div>`)}
    ${sec('education', '03', 'Education', 'Education & experience', `<div class="grid g2"><div class="card accent"><small style="color:#6b6b6b">PROGRAMME</small><h3 style="margin:6px 0">${esc(u.programme || '—')}</h3><p>${esc(u.faculty || '')}</p><p>${esc(u.year_of_study || '')} · CGPA <b>${p.cgpa ?? '—'}</b></p></div>
      <div class="card"><small style="color:#6b6b6b">EXPERIENCE</small><p style="margin-top:8px">${esc(pr.experience || 'No experience added yet.')}</p></div></div>`)}
    ${sec('ach', '04', 'Achievements', 'Recognition', achievements.length ? achievements.map((a) => `<div class="card" style="margin-bottom:12px"><div class="eyebrow">${esc(a.category || 'Achievement')}</div><h3>${esc(a.title)} ${verifiedBadge(a)}</h3><p style="color:#6b6b6b">${esc(a.description || '')}</p>${a.status !== 'verified' ? `<p class="no-print" style="margin-top:6px">${statusTag(a.status)}</p>` : ''}</div>`).join('') : emptyBox('No achievements yet.'))}
    ${sec('projects', '05', 'Selected work', 'Featured projects', projects.length ? projects.map((x, i) => `<div class="proj"><div class="pv">PROJECT PREVIEW<br>0${i + 1}</div><div class="pb"><div class="eyebrow">Academic project</div><h3>${esc(x.title)}</h3><p style="color:#555">${esc(x.description || '')}</p>
      <div class="chips" style="margin:10px 0">${String(x.tech || '').split(',').filter((t) => t.trim()).map((t) => `<span class="chip" style="font-size:12px">${esc(t.trim())}</span>`).join('')}</div>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">View project →</a>` : ''}</div></div>`).join('') : emptyBox('No projects yet.'))}
    ${sec('contact', '06', 'Get in touch', 'Let’s build something meaningful.', `<p style="color:#555;margin-bottom:12px">I’m open to student collaborations, practical learning opportunities, and conversations.</p>
      <p>📧 ${esc(u.email)}${pr.phone ? ` · 📞 ${esc(pr.phone)}` : ''}${pr.location ? ` · 📍 ${esc(pr.location)}` : ''}</p>
      <p>${pr.github ? `<a href="${esc(pr.github)}" target="_blank" rel="noopener">GitHub</a> ` : ''}${pr.linkedin ? `<a href="${esc(pr.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</p>`)}
  </div>`;
  $$('.tabs button', main).forEach((b) => b.addEventListener('click', () => $('#sec-' + b.dataset.s, main).scrollIntoView({ behavior: 'smooth' })));
  $('#cv', main).addEventListener('click', () => window.print());
}

async function performance(main) {
  const p = await api('/me/profile');
  const results = asArray(p.results);
  main.innerHTML = `<div class="wrap">${head('Academic', 'Academic performance', 'Your GPA by year of study. Results are imported by the administration.')}
    <div class="grid g3" style="margin-bottom:16px">${stat('Cumulative GPA', p.cgpa, 'Completed years', true)}${stat('Years recorded', results.length)}</div>
    <div class="table-wrap"><table><thead><tr><th>Year</th><th>Academic year</th><th>GPA</th><th>Standing</th></tr></thead><tbody>
    ${results.map((r) => `<tr><td><b>${esc(r.year_label)}</b></td><td>${esc(r.academic_year)}</td><td><b>${r.gpa?.toFixed ? r.gpa.toFixed(2) : '—'}</b></td><td><span class="tag">${esc(r.standing || '')}</span></td></tr>`).join('') || `<tr><td colspan="4">${emptyBox('No results recorded yet.')}</td></tr>`}</tbody></table></div></div>`;
}


async function achievements(main) {
  const draw = async (banner = '') => {
    const [p, opts, lecs] = await Promise.all([api('/me/profile'), api('/achievement-options'), api('/lecturers')]);
    const achievements = asArray(p.achievements);
    main.innerHTML = `<div class="wrap">${head('Portfolio', 'Achievements', 'Awards, leadership roles and milestones. Every achievement is checked by a lecturer before it can show a Verified badge.')}
      ${banner ? `<div class="msg ok">${esc(banner)}</div>` : ''}
      <button class="btn red" id="add" style="margin-bottom:16px">＋ Add achievement</button>
      ${achievements.length ? achievements.map((a) => `<div class="card" style="margin-bottom:12px">
        <div class="list-row" style="border:0;padding:0;align-items:flex-start"><div class="grow">
          <div class="eyebrow">${esc(a.category || 'Achievement')}${a.date_obtained ? ' · ' + fmtDate(a.date_obtained) : a.year ? ' · ' + esc(a.year) : ''}</div>
          <h3 style="font-size:22px">${esc(a.title)} ${verifiedBadge(a)}</h3>
          ${a.organisation ? `<small>${esc(a.organisation)}</small>` : ''}
          <p style="color:#555;margin:6px 0">${esc(a.description || '')}</p>
          <p>${statusTag(a.status)} ${a.lecturer_name ? `<small>Reviewer: ${esc(a.lecturer_name)}</small>` : ''}</p>
          ${a.status === 'rejected' ? `<div class="msg err"><b>Not verified — ${esc(REASON_LABEL[a.reason_code] || '')}.</b> ${esc(a.reviewer_comment || '')}</div>` : ''}
          ${a.status === 'evidence_required' ? `<div class="msg err"><b>Your lecturer needs more evidence:</b> ${esc(a.evidence_request || '')}<br><button class="btn red sm" style="margin-top:8px" data-resp="${a.id}">Respond with evidence</button></div>` : ''}
          ${a.status === 'verified' && a.reviewer_comment ? `<div class="msg ok">${esc(a.reviewer_comment)}</div>` : ''}
          <div>${fileList(a.files)}</div></div>
          <button class="btn sm" data-del="${a.id}">Delete</button></div></div>`).join('') : `<div class="card">${emptyBox('No achievements yet.')}</div>`}</div>`;
    bindFiles(main, openFile);

    $('#add', main).addEventListener('click', () => {
      const m = modal(`<h2>Add achievement</h2><p class="sub" style="margin-bottom:0">It will be sent to a lecturer for verification. You cannot verify it yourself.</p>
        <form>${field('Achievement title', 'title', { req: true })}
        <div class="row2">${select('Category', 'category', opts.categories, { req: true })}${field('Date obtained', 'date_obtained', { type: 'date', req: true })}</div>
        ${field('Organisation or institution', 'organisation', { ph: 'Who awarded or organised it?' })}${area('Description', 'description', { req: true })}
        ${select('Lecturer to verify', 'lecturer_id', lecs.map((l) => [l.id, l.full_name + (l.assigned ? ' (your lecturer)' : '')]), { req: true, value: lecs[0]?.id })}
        <label>Supporting certificate or document (PDF, PNG or JPG, up to 3 files, 4 MB each)</label><input type="file" name="cert" accept=".pdf,.png,.jpg,.jpeg" multiple />
        ${area('Additional evidence (optional)', 'evidence_note', { ph: 'Links, names of people who can confirm, other proof…' })}
        <label>Additional evidence files (optional)</label><input type="file" name="extra" accept=".pdf,.png,.jpg,.jpeg" multiple />
        <div id="fmsg"></div><div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn red" id="sub">Submit for verification</button></div></form>`);
      $('form', m.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('#sub', m.el); btn.disabled = true; btn.textContent = 'Submitting…';
        try {
          const d = formData(e.target); delete d.cert; delete d.extra;
          const files = [...await readFiles(e.target.elements.cert, 'certificate'), ...await readFiles(e.target.elements.extra, 'additional')];
          const r = await api('/me/achievements', { method: 'POST', body: { ...d, files } });
          m.close(); toast('Achievement submitted'); draw(r.message);
        } catch (er) { $('#fmsg', m.el).innerHTML = `<div class="msg err">${esc(er.message)}</div>`; btn.disabled = false; btn.textContent = 'Submit for verification'; }
      });
    });
    $$('[data-resp]', main).forEach((b) => b.addEventListener('click', () => {
      const m = modal(`<h2>Respond with evidence</h2><form>${area('Message to your lecturer', 'message', { ph: 'Explain or add links' })}
        <label>Additional files (PDF, PNG or JPG)</label><input type="file" name="extra" accept=".pdf,.png,.jpg,.jpeg" multiple /><div id="fmsg"></div>
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn red">Send</button></div></form>`);
      $('form', m.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const files = await readFiles(e.target.elements.extra, 'additional');
          await api(`/me/achievements/${b.dataset.resp}/evidence`, { method: 'PUT', body: { message: formData(e.target).message, files } });
          m.close(); toast('Sent to your lecturer'); draw('Your response was sent. The lecturer will review it again.');
        } catch (er) { $('#fmsg', m.el).innerHTML = `<div class="msg err">${esc(er.message)}</div>`; }
      });
    }));
    $$('[data-del]', main).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Delete this achievement and its files?')) return; await api('/me/achievements/' + b.dataset.del, { method: 'DELETE' }); draw(); }));
  };
  await draw();
}

async function projects(main) {
  const draw = async () => {
    const p = await api('/me/profile');
    const projects = asArray(p.projects);
    main.innerHTML = `<div class="wrap">${head('Portfolio', 'Projects', 'Show what you have built.')}
      <button class="btn red" id="add" style="margin-bottom:16px">＋ Add project</button>
      ${projects.length ? projects.map((x, i) => `<div class="proj"><div class="pv">PROJECT PREVIEW<br>0${i + 1}</div><div class="pb"><h3>${esc(x.title)}</h3><p style="color:#555">${esc(x.description || '')}</p><p class="small" style="margin:8px 0">${esc(x.tech || '')}</p>
        ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">View project →</a> ` : ''}<button class="btn sm" data-del="${x.id}" style="margin-left:8px">Delete</button></div></div>`).join('') : `<div class="card">${emptyBox('No projects yet.')}</div>`}</div>`;
    $('#add', main).addEventListener('click', () => {
      const m = modal(`<h2>Add project</h2><form>${field('Title', 'title', { req: true })}${area('Description', 'description')}${field('Technologies', 'tech', { ph: 'HTML5, CSS3, JavaScript' })}${field('Link (optional)', 'url', { ph: 'https://…' })}
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn red">Save</button></div></form>`);
      $('form', m.el).addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/me/projects', { method: 'POST', body: formData(e.target) }); m.close(); toast('Project added'); draw(); } catch (er) { toast(er.message, true); } });
    });
    $$('[data-del]', main).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Delete this project?')) return; await api('/me/projects/' + b.dataset.del, { method: 'DELETE' }); draw(); }));
  };
  await draw();
}

async function recommendations(main, { user }) {
  const draw = async () => {
    const [recs, lecs] = await Promise.all([api('/recommendations'), api('/lecturers')]);
    const ready = recs.filter((r) => r.status === 'completed' && r.letter);
    main.innerHTML = `<div class="wrap">${head('Academic support', 'Recommendation letters', 'Request a recommendation from a lecturer and track each step. You are notified in the system and by email whenever the lecturer acts.')}
      <div class="card" style="margin-bottom:16px"><div class="list-row" style="border:0;padding:0"><div class="ic">📄</div><div class="grow"><b>Need help?</b><small>Ask your programme office about official approval.</small></div></div></div>
      ${ready.map((r) => `<div class="card accent" style="margin-bottom:12px"><div class="list-row" style="border:0;padding:0"><div class="grow"><div class="eyebrow">Available letter</div><h3 style="font-size:24px">Academic recommendation</h3>
        <small>Prepared for ${esc(user.full_name)} by ${esc(r.lecturer_name)} · ${esc(r.purpose)}</small></div><span class="tag ok">✓ Ready</span><button class="btn red sm" data-view="${r.id}">View / download</button></div></div>`).join('')}
      <div class="section-head"><div><div class="eyebrow">New request</div><h2>Request a letter</h2></div></div>
      <div class="card"><form id="rf"><div class="row2">${select('Lecturer', 'lecturer_id', lecs.map((l) => [l.id, l.full_name + (l.assigned ? ' (your lecturer)' : '')]), { req: true, value: lecs[0]?.id })}
        ${select('Purpose', 'purpose', ['Scholarship', 'Internship', 'Employment', 'Postgraduate Studies', 'Other'], { req: true })}</div>
        ${field('Deadline', 'deadline', { type: 'date' })}${area('Message to lecturer', 'message', { ph: 'Explain what the letter is for and anything you want highlighted.' })}
        <button class="btn red" style="margin-top:14px">Send request →</button></form></div>
      <div class="section-head"><div><div class="eyebrow">Tracking</div><h2>Your requests</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>Ref</th><th>Lecturer</th><th>Purpose</th><th>Deadline</th><th>Status</th><th></th></tr></thead><tbody>
      ${recs.map((r) => `<tr><td>${r.ref}</td><td>${esc(r.lecturer_name)}</td><td>${esc(r.purpose)}</td><td>${fmtDate(r.deadline)}</td>
        <td>${statusTag(r.status)}${r.status === 'declined' && r.decline_reason ? `<br><small style="color:#a30d25">${esc(r.decline_reason)}</small>` : ''}${r.status === 'more_info' && r.info_request ? `<br><small style="color:#a30d25">${esc(r.info_request)}</small>` : ''}${r.status === 'completed' && !r.letter ? '<br><small>Letter was sent to the university and is not released for download.</small>' : ''}</td>
        <td>${r.status === 'completed' && r.letter ? `<button class="link-btn" data-view="${r.id}">View letter →</button>` : r.status === 'more_info' ? `<button class="link-btn" data-info="${r.id}">Add info →</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6">${emptyBox('No requests yet.')}</td></tr>`}</tbody></table></div></div>`;
    $('#rf', main).addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/recommendations', { method: 'POST', body: formData(e.target) }); toast('Request sent. Your lecturer has been emailed.'); draw(); } catch (er) { toast(er.message, true); }
    });
    $$('[data-view]', main).forEach((b) => b.addEventListener('click', () => showLetter(recs.find((r) => r.id == b.dataset.view))));
    $$('[data-info]', main).forEach((b) => b.addEventListener('click', () => {
      const r = recs.find((x) => x.id == b.dataset.info);
      const m = modal(`<h2>Add more information</h2><p class="sub"><b>Your lecturer asked:</b> ${esc(r.info_request || '')}</p><form>${area('Your reply', 'message', { req: true })}
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn red">Send</button></div></form>`);
      $('form', m.el).addEventListener('submit', async (e) => { e.preventDefault(); try { await api(`/recommendations/${b.dataset.info}/info`, { method: 'PUT', body: formData(e.target) }); m.close(); toast('Information sent'); draw(); } catch (er) { toast(er.message, true); } });
    }));
  };
  await draw();
}

async function editProfile(main) {
  const p = await api('/me/profile'); const u = p.user || {}, pr = p.profile || {};
  const skills = asArray(pr.skills);
  main.innerHTML = `<div class="wrap"><a href="#/student/profile">← Back to profile</a><div class="eyebrow" style="margin-top:14px">Profile settings</div><h1 class="page-title">Edit your profile</h1>
    <p class="sub">Keep your academic and professional information up to date.</p><div class="card"><form id="ef">
    <div class="row2">${field('Full name', 'full_name', { value: u.full_name, req: true })}${field('Headline', 'headline', { value: pr.headline, ph: 'e.g. Software Engineering student' })}</div>
    ${area('About me', 'about', { value: pr.about })}${field('Skills (comma separated)', 'skills', { value: skills.join(', '), ph: 'HTML, CSS, JavaScript' })}
    <div class="row2">${field('Faculty', 'faculty', { value: u.faculty })}${field('Programme', 'programme', { value: u.programme })}</div>
    <div class="row2">${select('Year of study', 'year_of_study', ['Year 1', 'Year 2', 'Year 3', 'Year 4', 'Postgraduate'], { value: u.year_of_study })}${field('Phone', 'phone', { value: pr.phone })}</div>
    <div class="row2">${field('Location', 'location', { value: pr.location })}${field('GitHub link', 'github', { value: pr.github, ph: 'https://github.com/…' })}</div>
    ${field('LinkedIn link', 'linkedin', { value: pr.linkedin })}${area('Experience', 'experience', { value: pr.experience })}
    <div class="modal-actions"><a class="btn" href="#/student/profile">Cancel</a><button class="btn red">Save changes ✓</button></div></form></div></div>`;
  $('#ef', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/me/profile', { method: 'PUT', body: formData(e.target) }); toast('Profile saved'); location.hash = '#/student/profile'; }
    catch (er) { toast(er.message, true); }
  });
}

export const studentPages = { dashboard, profile, performance, achievements, projects, recommendations, notifications: notificationsPage, 'edit-profile': editProfile, settings: settingsPage };
