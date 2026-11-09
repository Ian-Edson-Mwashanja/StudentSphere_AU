import { api, store } from './api.js';
import { esc, $, $$, bindPw, field, select, pwField, formData } from './ui.js';

const heroBand = `<section style="background:#0a0a0a;color:#fff;margin-top:40px;padding:50px 20px"><div class="wrap">
  <div class="eyebrow" style="color:#ff8a9b">LEARN · BUILD · GROW</div>
  <h2 style="font-size:clamp(30px,6vw,52px);max-width:640px">Your academic journey. Connected.</h2></div></section>`;

function roleSeg(roles, current) {
  return `<div class="seg" id="roles">${roles.map(([k, l, i]) => `<button type="button" data-r="${k}" class="${k === current ? 'on' : ''}">${i} ${l}</button>`).join('')}</div>`;
}

export function loginPage(main) {
  let role = 'student';
  main.innerHTML = `<div class="wrap"><div class="auth-wrap"><div class="auth-card">
    <div class="eyebrow">StudentSphere access</div><h1>Welcome back!</h1>
    <p class="sub" style="margin-bottom:10px">Choose your role and sign in to your university workspace.</p>
    <div id="msg"></div>
    <form id="f"><label>Continue as</label>${roleSeg([['student', 'Student', '👤'], ['lecturer', 'Lecturer', '📖'], ['admin', 'Admin', '⚙️']], role)}
      ${field('Email or Student/Staff ID', 'identifier', { req: true, ph: 'Email or university ID' })}
      ${pwField('Password', 'password', 'Enter your password')}
      <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0">
        <label class="checkline"><input type="checkbox" name="remember" checked /> Remember me</label>
        <a href="#/login" id="forgot" style="font-size:13px">Forgot password?</a></div>
      <button class="btn red block" id="go">Log in →</button></form>
    <p class="center" style="margin-top:18px;font-size:14px;color:#6b6b6b">Don't have an account? <a href="#/signup">Sign up</a></p>
  </div><p class="auth-foot">StudentSphere · Your Academic Journey. Connected.</p></div></div>${heroBand}`;
  bindPw(main);
  $$('#roles button', main).forEach((b) => b.addEventListener('click', () => {
    role = b.dataset.r; $$('#roles button', main).forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#forgot', main).addEventListener('click', (e) => { e.preventDefault(); location.hash = '#/forgot-password'; });
  $('#f', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target); const btn = $('#go', main);
    btn.disabled = true; $('#msg', main).innerHTML = '';
    try {
      const r = await api('/auth/login', { method: 'POST', body: { role, identifier: d.identifier, password: d.password } });
      store.setToken(r.token, !!d.remember); store.user = r.user;
      $('#msg', main).innerHTML = '<div class="msg ok">✓ Login successful. Opening your dashboard…</div>';
      const next = sessionStorage.getItem('ss_next'); sessionStorage.removeItem('ss_next');
      setTimeout(() => { location.hash = next && next.startsWith(`#/${r.user.role}/`) ? next : `#/${r.user.role}/dashboard`; }, 400);
    } catch (err) { $('#msg', main).innerHTML = `<div class="msg err">${esc(err.message)}</div>`; btn.disabled = false; }
  });
}

export function forgotPasswordPage(main) {
  main.innerHTML = `<div class="wrap"><div class="auth-wrap"><div class="auth-card">
    <div class="eyebrow">Account recovery</div><h1>Forgot your password?</h1>
    <p class="sub" style="margin-bottom:18px">Enter the university email address linked to your StudentSphere account. We will send you a secure reset link.</p>
    <div id="msg"></div>
    <form id="forgot-form">${field('University email', 'email', { req: true, type: 'email', ph: 'name@africau.edu' })}
      <button class="btn red block" id="forgot-submit">Send reset link →</button></form>
    <p class="center" style="margin-top:18px;font-size:14px;color:#6b6b6b"><a href="#/login">← Back to login</a></p>
  </div><p class="auth-foot">StudentSphere · Your Academic Journey. Connected.</p></div></div>`;

  $('#forgot-form', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#forgot-submit', main);
    const email = formData(e.target).email;
    btn.disabled = true; btn.textContent = 'Sending…'; $('#msg', main).innerHTML = '';
    try {
      const result = await api('/auth/forgot-password', { method: 'POST', body: { email } });
      const devLink = result.resetUrl
        ? `<p style="margin-top:12px"><strong>Local development link:</strong><br><a href="${esc(result.resetUrl)}">Open password reset page</a></p>`
        : '';
      $('#msg', main).innerHTML = `<div class="msg ok">${esc(result.message)}${devLink}</div>`;
      e.target.reset();
    } catch (err) {
      $('#msg', main).innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
    } finally { btn.disabled = false; btn.textContent = 'Send reset link →'; }
  });
}

export function resetPasswordPage(main, token) {
  main.innerHTML = `<div class="wrap"><div class="auth-wrap"><div class="auth-card">
    <div class="eyebrow">Secure account recovery</div><h1>Set a new password</h1>
    <p class="sub" style="margin-bottom:18px">Choose a new password with at least 8 characters and one number.</p>
    <div id="msg"></div>
    <form id="reset-form">${pwField('New password', 'password', 'Enter a new password')}
      ${pwField('Confirm new password', 'confirm', 'Repeat your new password')}
      <button class="btn red block" id="reset-submit">Update password →</button></form>
    <p class="center" style="margin-top:18px;font-size:14px;color:#6b6b6b"><a href="#/login">Back to login</a></p>
  </div><p class="auth-foot">StudentSphere · Your Academic Journey. Connected.</p></div></div>`;
  bindPw(main);

  $('#reset-form', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target); const btn = $('#reset-submit', main);
    if (d.password !== d.confirm) {
      $('#msg', main).innerHTML = '<div class="msg err">The passwords do not match.</div>';
      return;
    }
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      $('#msg', main).innerHTML = '<div class="msg err">This password reset link is invalid. Request a new link.</div>';
      return;
    }
    btn.disabled = true; btn.textContent = 'Updating…'; $('#msg', main).innerHTML = '';
    try {
      const result = await api('/auth/reset-password', { method: 'POST', body: { token, password: d.password } });
      $('#msg', main).innerHTML = `<div class="msg ok">${esc(result.message)} <a href="#/login">Log in now</a>.</div>`;
      e.target.reset();
      e.target.hidden = true;
    } catch (err) {
      $('#msg', main).innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Update password →';
    }
  });
}

export function signupPage(main) {
  let role = 'student';
  // Type a student ID -> details from the admin's student list are filled in and locked.
  const wireLookup = () => {
    const idInput = $('[name=university_id]', main); if (!idInput) return;
    const note = document.createElement('p'); note.className = 'hint'; idInput.parentElement.appendChild(note);
    const locked = []; let last = '';
    const unlock = () => locked.splice(0).forEach((el) => { el.readOnly = false; el.style.pointerEvents = ''; el.style.background = ''; el.value = ''; });
    const lock = (name, val) => {
      const el = $(`[name=${name}]`, main); if (!el || !val) return;
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === val)) return;
      el.value = val; el.style.background = '#f4f4f5'; if (el.tagName === 'SELECT') el.style.pointerEvents = 'none'; else el.readOnly = true;
      locked.push(el);
    };
    const check = async () => {
      const id = idInput.value.trim(); if (id === last) return; last = id; unlock(); note.textContent = ''; if (!id) return;
      try {
        const r = await api('/auth/roster?id=' + encodeURIComponent(id));
        if (r.found && r.claimed) note.textContent = 'An account already exists for this ID. Try logging in instead.';
        else if (r.found) {
          ['full_name', 'faculty', 'programme', 'year_of_study'].forEach((k) => lock(k, r[k])); lock('email', r.email_masked);
          note.textContent = '✓ Student ID verified. Your official name, college, programme and year have been filled in.';
        } else note.textContent = r.required ? 'This Student ID is not in the official university list. Check the number or contact the administration.'
          : 'This ID is not in the student list. You can still register; an administrator will check your details.';
      } catch (e) { note.textContent = e.message; }
    };
    idInput.addEventListener('change', check); idInput.addEventListener('blur', check);
  };
  const draw = () => {
    const stu = role === 'student';
    const nameF = field('Full name', 'full_name', { req: true, ph: 'Your full name' });
    const idF = field(stu ? 'Student ID' : 'Staff ID', 'university_id', { req: true, ph: stu ? 'e.g. 250001' : 'e.g. AU-STAFF-042' });
    $('#fields', main).innerHTML = `<div class="row2">${stu ? idF + nameF : nameF + idF}</div>
      <div class="row2">${field('University email', 'email', { req: true, type: 'email', ph: stu ? 'name@student.africau.edu' : 'name@africau.edu' })}
      ${field(stu ? 'College' : 'Faculty or department', 'faculty', { req: true, ph: stu ? 'e.g. College of Engineering and Applied Sciences' : 'e.g. Computer Science' })}</div>
      ${stu ? `<div class="row2">${field('Programme of study', 'programme', { req: true, ph: 'e.g. Software Engineering' })}
        ${select('Year of study', 'year_of_study', ['Year 1', 'Year 2', 'Year 3', 'Year 4', 'Postgraduate'], { req: true })}</div>`
      : field('Area of specialisation', 'specialisation', { req: true, ph: 'e.g. Software Architecture' })}
      <div class="row2">${pwField('Password', 'password', 'Create a password')}${pwField('Confirm password', 'confirm', 'Repeat your password')}</div>
      <p class="hint">At least 8 characters, with a number.</p>`;
    bindPw($('#fields', main));
    if (stu) wireLookup();
  };
  main.innerHTML = `<div class="wrap"><div class="auth-wrap" style="max-width:640px"><div class="auth-card">
    <div class="eyebrow">Create your account</div><h1>Join StudentSphere</h1>
    <p class="sub" style="margin-bottom:10px">Register as a student or lecturer. Your account may require university approval.</p>
    <div id="msg"></div>
    <form id="f"><label>Sign up as</label>${roleSeg([['student', 'Student', '👤'], ['lecturer', 'Lecturer', '📖']], role)}
      <div id="fields"></div>
      <label class="checkline" style="margin:16px 0"><input type="checkbox" name="terms" required /> I agree to the Terms and Conditions.</label>
      <button class="btn red block" id="go">Create account →</button></form>
    <p class="center" style="margin-top:18px;font-size:14px;color:#6b6b6b">Already registered? <a href="#/login">Log in</a></p>
  </div></div></div>`;
  draw();
  $$('#roles button', main).forEach((b) => b.addEventListener('click', () => {
    role = b.dataset.r; $$('#roles button', main).forEach((x) => x.classList.toggle('on', x === b)); draw();
  }));
  $('#f', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target); const btn = $('#go', main);
    if (d.password !== d.confirm) { $('#msg', main).innerHTML = '<div class="msg err">Passwords do not match</div>'; return; }
    btn.disabled = true;
    try {
      const r = await api('/auth/register', { method: 'POST', body: { ...d, role } });
      $('#msg', main).innerHTML = `<div class="msg ok">${esc(r.message)}</div>`; e.target.reset(); draw();
    } catch (err) { $('#msg', main).innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    btn.disabled = false; window.scrollTo(0, 0);
  });
}
