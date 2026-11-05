// StudentSphere front end: shell (header, drawer, footer) + hash router
import { api, store } from './api.js';
import { esc, $, $$, initials } from './ui.js';
import { loginPage, signupPage } from './auth.js';
import { studentPages } from './student.js';
import { lecturerPages } from './lecturer.js';
import { adminPages } from './admin.js';
import { adminExtra, lecturerExtra, studentExtra } from './academics.js';
Object.assign(adminPages, adminExtra); Object.assign(lecturerPages, lecturerExtra); Object.assign(studentPages, studentExtra);

const NAV = {
  student: [['dashboard', 'Dashboard', '🏠'], ['profile', 'My profile', '👤'], ['performance', 'Academic performance', '📊'], ['results', 'My results', '🎓'], ['achievements', 'Achievements', '🏅'],
    ['projects', 'Projects', '💻'], ['recommendations', 'Recommendations', '📄'], ['notifications', 'Notifications', '🔔'], ['edit-profile', 'Edit profile', '✏️'], ['settings', 'Settings', '⚙️']],
  lecturer: [['dashboard', 'Dashboard', '🏠'], ['profile', 'My profile', '👤'], ['students', 'Student profiles', '👥'], ['requests', 'Recommendation requests', '📄'],
    ['achievements', 'Achievement verification', '🏅'], ['completed', 'Completed recommendations', '✅'], ['marks', 'Course marks', '📝'], ['notifications', 'Notifications', '🔔'], ['settings', 'Settings', '⚙️']],
  admin: [['dashboard', 'Dashboard', '📊'], ['users', 'User management', '👥'], ['approvals', 'Account approvals', '✅'], ['students', 'Students', '🎓'],
    ['lecturers', 'Lecturers', '📚'], ['assignments', 'Lecturer assignments', '🔗'], ['roster', 'Student list', '📋'], ['records', 'Academic records', '🗂'], ['faculties', 'Faculties & departments', '🏛'], ['courses', 'Courses', '📘'], ['results', 'Results & GPA', '🧮'], ['recommendations', 'Recommendations', '📄'],
    ['achievements', 'Achievement verification', '🏅'], ['reports', 'Reports', '📈'], ['emails', 'Email log', '✉️'], ['audit', 'Audit trail', '🧾'],
    ['notifications', 'Notifications', '🔔'], ['settings', 'Settings', '⚙️']]
};
const PAGES = { student: studentPages, lecturer: lecturerPages, admin: adminPages };
const FOOT = { student: ['dashboard', 'profile', 'recommendations'], lecturer: ['dashboard', 'students', 'requests'], admin: ['dashboard', 'users', 'reports'] };
const FOOT_LABEL = { dashboard: 'Dashboard', profile: 'Profile', recommendations: 'Recommendations', students: 'Students', requests: 'Recommendations', users: 'Users', reports: 'Monitoring' };

const brand = `<a class="brand" href="#/" style="color:inherit">
  <img src="/img/logo.png" alt="Africa University" onerror="this.outerHTML='<div class=&quot;au-mark&quot;>AU</div>'" />
  <div><b>Africa University</b><small>Investing in Africa's Future</small></div></a>`;
const ssLogo = `<div class="ss-logo"><div class="dot"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/></svg></div>
  <div><b>StudentSphere</b><small style="display:block;color:#6b6b6b;font-size:11px">Your Academic Journey. Connected.</small></div></div>`;
const footer = (links = '') => `<footer><div class="wrap"><div class="f-row"><div class="ss-logo"><div class="dot" style="background:var(--red)">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg></div>
  <div><b>StudentSphere</b><small style="display:block;color:#9a9a9a;font-size:11px">Your Academic Journey. Connected.</small></div></div><nav>${links}</nav></div>
  <div class="f-bot"><span>© ${new Date().getFullYear()} StudentSphere. University project prototype.</span>
  <span>Created for Africa University by Ian Edson Mwashanja, Tariro Tekwa, Deborah Amos, Rick Gove, Ashleigh Gopo.</span></div></div></footer>`;

const app = $('#app');

async function currentUser() {
  if (store.user) return store.user;
  if (!store.token) return null;
  try { store.user = (await api('/me')).user; } catch (e) { store.setToken(null); store.user = null; }
  return store.user;
}

export function logout() {
  store.setToken(null); store.user = null; location.hash = '#/login';
}

function publicShell() {
  app.dataset.shell = 'public';
  app.innerHTML = `<header class="topbar"><div class="wrap">${brand}<div class="top-right">${ssLogo}
    <div class="nav-links"><a href="#/login" class="btn sm" style="border:0">Log in</a><a href="#/signup" class="btn sm">Sign up</a></div></div></div></header>
    <main id="main"></main>${footer()}`;
  return $('#main');
}

function userShell(user) {
  const key = 'user-' + user.role + '-' + user.id;
  if (app.dataset.shell === key) return $('#main');
  app.dataset.shell = key;
  const items = NAV[user.role].map(([k, label, ico]) =>
    `<a class="item" data-k="${k}" href="#/${user.role}/${k}"><span class="ico">${ico}</span>${label}</a>`).join('');
  const roleLabel = { student: 'Student Portal', lecturer: 'Lecturer Portal', admin: 'Admin Portal' }[user.role];
  const flinks = FOOT[user.role].map((k) => `<a href="#/${user.role}/${k}">${FOOT_LABEL[k]}</a>`).join('');
  app.innerHTML = `<header class="topbar"><div class="wrap">${brand}<div class="top-right">${ssLogo}
      <span class="pill">${user.role}</span><button class="icon-btn" id="menu-btn" aria-label="Menu">☰<i class="badge-dot" id="dot" hidden></i></button></div></div></header>
    <div class="drawer-bg" id="dbg"></div>
    <aside class="drawer" id="drawer"><div class="who"><div class="avatar">${esc(initials(user.full_name))}</div><div><b>${esc(user.full_name)}</b><small>${roleLabel}</small></div></div>
      ${items}<div class="sp"></div><button class="item" id="logout"><span class="ico">🚪</span>Log out</button></aside>
    <main id="main"></main>${footer(flinks)}`;
  const toggle = (open) => { $('#drawer').classList.toggle('open', open); $('#dbg').classList.toggle('open', open); };
  $('#menu-btn').addEventListener('click', () => toggle(!$('#drawer').classList.contains('open')));
  $('#dbg').addEventListener('click', () => toggle(false));
  $$('#drawer a.item').forEach((a) => a.addEventListener('click', () => toggle(false)));
  $('#logout').addEventListener('click', logout);
  return $('#main');
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const user = await currentUser();
  window.scrollTo(0, 0);

  if (!user) {
    if (parts[0] && !['login', 'signup'].includes(parts[0])) sessionStorage.setItem('ss_next', location.hash);
    const main = publicShell();
    return (parts[0] === 'signup' ? signupPage : loginPage)(main);
  }
  if (parts[0] !== user.role) { location.hash = `#/${user.role}/dashboard`; return; }
  const param = parts[2] || null;

  const main = userShell(user);
  const pageKey = parts[1] || 'dashboard';
  const navKey = pageKey === 'student' ? 'students' : pageKey;
  $$('#drawer a.item').forEach((a) => a.classList.toggle('active', a.dataset.k === navKey));
  const page = PAGES[user.role][pageKey];
  if (!page) { location.hash = `#/${user.role}/dashboard`; return; }
  main.innerHTML = '<div class="wrap"><div class="empty">Loading…</div></div>';
  try { await page(main, { user, param }); } catch (e) {
    main.innerHTML = `<div class="wrap"><div class="msg err">${esc(e.message)}</div></div>`;
  }
  api('/notifications').then((n) => { const d = $('#dot'); if (d) d.hidden = !n.some((x) => !x.is_read); }).catch(() => {});
}

window.addEventListener('hashchange', route);
route();

