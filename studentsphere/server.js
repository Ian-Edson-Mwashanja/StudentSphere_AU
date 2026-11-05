// StudentSphere API + static file server
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tiny .env loader (no extra package). Real environment variables always win.
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !l.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env file: fine */ }

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { sendMail, mode: mailMode, appUrl } = require('./mailer');
const roster = require('./roster');
const supabaseRoster = require('./supabaseRoster');

const SECRET = process.env.JWT_SECRET || 'change-this-secret-before-deploying';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) { console.error('JWT_SECRET must be set in production.'); process.exit(1); }
// Student-list behaviour (both default to off):
//   REQUIRE_ROSTER=true       only students whose ID is in the uploaded list may register
//   AUTO_APPROVE_ROSTER=true  a student found in the list is activated immediately (no admin approval)
const REQUIRE_ROSTER = String(process.env.REQUIRE_ROSTER).toLowerCase() === 'true';
const AUTO_APPROVE = String(process.env.AUTO_APPROVE_ROSTER).toLowerCase() === 'true';
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
// Behind Render/Netlify the real visitor IP is in X-Forwarded-For. Without this, rate limiting would treat everyone as one person.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.use(cors());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// Achievement uploads arrive as base64 JSON, so those routes get a bigger body limit. Everything else: 1 MB.
const bigJson = express.json({ limit: '20mb' });
app.use('/api/me/achievements', bigJson);
app.use('/api/admin/roster', bigJson);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- helpers
const httpErr = (msg, status = 400) => Object.assign(new Error(msg), { status });
const wrap = (fn) => (req, res) => {
  Promise.resolve().then(() => fn(req, res)).catch((e) => {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Server error' });
  });
};
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const today = () => new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

function auth(...roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return bad(res, 'Please sign in', 401);
    try {
      const payload = jwt.verify(token, SECRET);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
      if (!u || u.status !== 'active') return bad(res, 'Account not active', 401);
      if (roles.length && !roles.includes(u.role)) return bad(res, 'You do not have permission to do that', 403);
      req.user = u;
      next();
    } catch (e) { return bad(res, 'Session expired, please sign in again', 401); }
  };
}

const pub = (u) => u && ({
  id: u.id, role: u.role, full_name: u.full_name, university_id: u.university_id, email: u.email,
  status: u.status, faculty: u.faculty, programme: u.programme, year_of_study: u.year_of_study,
  specialisation: u.specialisation, created_at: u.created_at
});
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);

const notify = (userId, title, body, link = null, type = null) =>
  db.prepare('INSERT INTO notifications (user_id,title,body,link,type) VALUES (?,?,?,?,?)').run(userId, title, body, link, type);

// Audit trail: who did what, to whom, when, with what decision and reason.
function audit(actor, action, { type = null, id = null, student = null, decision = null, comments = null } = {}) {
  db.prepare('INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,student_id,decision,comments) VALUES (?,?,?,?,?,?,?,?)')
    .run(actor ? actor.id : null, actor ? actor.role : null, action, type, id, student, decision, comments);
}

const cgpaOf = (id) =>
  db.prepare("SELECT ROUND(AVG(gpa),2) c FROM results WHERE user_id=? AND gpa IS NOT NULL AND academic_year != 'Projected'").get(id).c;

const ensureExtras = (id) => {
  db.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').run(id);
  db.prepare('INSERT OR IGNORE INTO settings (user_id) VALUES (?)').run(id);
};

// A lecturer may see a student if the student is assigned to them OR has sent them a request/achievement.
const lecturerCanSee = (lecId, stuId) => !!db.prepare(`
  SELECT 1 FROM lecturer_assignments WHERE lecturer_id=? AND student_id=?
  UNION SELECT 1 FROM recommendations WHERE lecturer_id=? AND student_id=?
  UNION SELECT 1 FROM achievements WHERE lecturer_id=? AND user_id=?`).get(lecId, stuId, lecId, stuId, lecId, stuId);

const ACH_STATUSES = ['pending_verification', 'under_review', 'verified', 'rejected', 'evidence_required'];
const REASON_CODES = ['insufficient_evidence', 'inaccurate_information', 'not_relevant', 'guideline_violation', 'other'];
const ACH_CATEGORIES = ['Academic award', 'Certificate', 'Leadership position', 'Competition award', 'Hackathon achievement', 'Research achievement',
  'Community service', 'Professional achievement', 'Training certificate', 'Other extracurricular'];

// ---------------------------------------------------------------- uploads (base64 JSON, validated by file signature)
const MAX_FILE = 4 * 1024 * 1024, MAX_FILES = 3;
function sniff(buf) {
  if (buf.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}
function prepareFiles(files) {
  if (files == null) return [];
  if (!Array.isArray(files) || files.length > MAX_FILES) throw httpErr(`You can attach up to ${MAX_FILES} files at a time`);
  return files.map((f) => {
    const name = String((f && f.name) || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 100);
    const buf = Buffer.from(String((f && f.data) || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) throw httpErr(`"${name}" is empty`);
    if (buf.length > MAX_FILE) throw httpErr(`"${name}" is larger than 4 MB`);
    const mime = sniff(buf);
    if (!mime) throw httpErr(`"${name}" must be a PDF, PNG or JPG file`);
    return { name, buf, mime, kind: f.kind === 'additional' ? 'additional' : 'certificate' };
  });
}
function storeFiles(achId, prepared) {
  for (const f of prepared) {
    const stored = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), f.buf);
    db.prepare('INSERT INTO achievement_files (achievement_id,kind,original_name,stored_name,mime,size) VALUES (?,?,?,?,?,?)')
      .run(achId, f.kind, f.name, stored, f.mime, f.buf.length);
  }
}
function removeFiles(achId) {
  db.prepare('SELECT stored_name FROM achievement_files WHERE achievement_id=?').all(achId).forEach((f) => { try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_name)); } catch (e) { /* already gone */ } });
}

// ---------------------------------------------------------------- profile bundle
const filesOf = (achId) => db.prepare('SELECT id,kind,original_name,mime,size,uploaded_at FROM achievement_files WHERE achievement_id=? ORDER BY id').all(achId);
function achievementsOf(userId) {
  return db.prepare(`SELECT a.*, l.full_name AS lecturer_name FROM achievements a LEFT JOIN users l ON l.id=a.lecturer_id WHERE a.user_id=? ORDER BY a.id DESC`).all(userId)
    .map((a) => ({ ...a, files: filesOf(a.id) }));
}
function profileBundle(id) {
  ensureExtras(id);
  const user = getUser(id);
  if (!user) return null;
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id=?').get(id);
  let skills = [];
  try { skills = JSON.parse(profile.skills || '[]'); } catch (e) { skills = []; }
  return {
    user: pub(user), profile: { ...profile, skills },
    projects: db.prepare('SELECT * FROM projects WHERE user_id=? ORDER BY id').all(id),
    achievements: achievementsOf(id),
    results: db.prepare('SELECT * FROM results WHERE user_id=? ORDER BY id').all(id),
    cgpa: cgpaOf(id)
  };
}

// ---------------------------------------------------------------- emails for every workflow
function mailRecRequest(rec, student, lecturer) {
  return sendMail({
    user: lecturer, template: 'rec_request', subject: 'New Recommendation Request – StudentSphere', related: { type: 'recommendation', id: rec.id },
    heading: 'New recommendation request',
    intro: 'A student has submitted a recommendation letter request through the StudentSphere platform.',
    rows: [['Student Name', student.full_name], ['Student ID', student.university_id], ['Programme', student.programme], ['Faculty', student.faculty],
      ['Purpose', rec.purpose], ['Date submitted', today()], ['Deadline', rec.deadline], ['Message from student', rec.message]],
    paragraphs: ['Please log in to your StudentSphere Lecturer Dashboard to review the request.',
      "You can review the student's academic profile, achievements, skills, projects, and academic performance before making your decision."],
    action: { label: 'Review request', path: `/lecturer/requests/${rec.id}` }
  });
}
function mailRecUpdate(rec, student, lecturer, kind, detail) {
  const map = {
    approved: ['Recommendation Request Approved – StudentSphere', 'Your recommendation request was approved', `${lecturer.full_name} approved your request and will now write your recommendation letter.`],
    declined: ['Recommendation Request Declined – StudentSphere', 'Your recommendation request was declined', `${lecturer.full_name} is unable to provide this recommendation.`],
    more_info: ['More Information Required for Your Recommendation – StudentSphere', 'More information is required', `${lecturer.full_name} needs more information before deciding on your request.`],
    completed: ['Your Recommendation Letter Is Ready – StudentSphere', 'Your recommendation letter is ready', `${lecturer.full_name} has completed your recommendation letter.`]
  }[kind];
  return sendMail({
    user: student, template: 'rec_' + kind, subject: map[0], related: { type: 'recommendation', id: rec.id }, heading: map[1], intro: map[2],
    rows: [['Purpose', rec.purpose], ['Lecturer', lecturer.full_name], [kind === 'declined' ? 'Reason' : kind === 'more_info' ? 'What is needed' : '', detail]],
    paragraphs: kind === 'completed' ? ['Log in to StudentSphere to view your letter, if your lecturer has released it for download.'] : [],
    action: { label: 'Open Recommendations', path: '/student/recommendations' }
  });
}
function mailAchSubmitted(ach, student, lecturer, again = false) {
  return sendMail({
    user: lecturer, template: 'ach_submitted', subject: again ? 'Achievement Evidence Updated – StudentSphere' : 'Student Achievement Verification Required – StudentSphere',
    related: { type: 'achievement', id: ach.id }, heading: again ? 'Student added requested evidence' : 'Achievement verification required',
    intro: again ? 'A student has responded to your request for additional evidence.' : 'A student has submitted a new achievement through the StudentSphere platform.',
    rows: [['Student Name', student.full_name], ['Student ID', student.university_id], ['Achievement Title', ach.title], ['Achievement Category', ach.category], ['Date Submitted', today()]],
    paragraphs: ['The student has submitted this achievement for verification.',
      'Please log in to your StudentSphere Lecturer Dashboard to review the information and supporting documents.'],
    action: { label: 'Review achievement', path: `/lecturer/achievements/${ach.id}` }
  });
}
function mailAchDecision(ach, student, lecturer, kind, comment) {
  const map = {
    verified: ['Achievement Verified – StudentSphere', 'Your achievement has been verified', 'A VERIFIED badge now appears next to this achievement on your profile.'],
    rejected: ['Achievement Not Verified – StudentSphere', 'Your achievement could not be verified', 'The lecturer could not verify this achievement. The reason is shown below.'],
    evidence_required: ['Additional Evidence Required – StudentSphere', 'Additional evidence is required', 'Your lecturer needs more evidence or clarification before this achievement can be verified.']
  }[kind];
  return sendMail({
    user: student, template: 'ach_' + kind, subject: map[0], related: { type: 'achievement', id: ach.id }, heading: map[1], intro: map[2],
    rows: [['Achievement', ach.title], ['Reviewed by', lecturer.full_name], [kind === 'verified' ? 'Comment' : kind === 'rejected' ? 'Reason' : 'What is needed', comment]],
    action: { label: kind === 'evidence_required' ? 'Add evidence' : 'View achievements', path: '/student/achievements' }
  });
}

// ---------------------------------------------------------------- auth
const fails = new Map();
const tooMany = (k) => { const r = fails.get(k); return r && r.n >= 10 && Date.now() - r.t < 15 * 60e3; };
const recordFail = (k) => { const r = fails.get(k); if (!r || Date.now() - r.t >= 15 * 60e3) fails.set(k, { n: 1, t: Date.now() }); else r.n++; };

app.post('/api/auth/register', wrap(async (req, res) => {
  const b = req.body || {};
  if (!['student', 'lecturer'].includes(b.role)) return bad(res, 'Choose Student or Lecturer');

  // For students, the official Supabase roster record overrides all submitted identity details.
  let listed = null;
  if (b.role === 'student') {
    if (REQUIRE_ROSTER && !supabaseRoster.configured()) return bad(res, 'The official student database is not connected yet. Please contact the administrator.', 503);
    const studentId = String(b.university_id || '').trim();
    if (!/^\d{6}$/.test(studentId)) return bad(res, 'Enter your six-digit Student ID.');
    listed = supabaseRoster.configured()
      ? await supabaseRoster.lookupStudent(studentId)
      : db.prepare('SELECT * FROM student_roster WHERE university_id=?').get(studentId);

    if (!listed && REQUIRE_ROSTER) return bad(res, 'Your Student ID was not found in the official student list. Check the ID or contact the administration.');
    if (listed) {
      if (String(listed.status || 'active').toLowerCase() !== 'active') return bad(res, 'This student record is not active. Please contact the university administration.');
      b.university_id = listed.university_id;
      b.full_name = listed.full_name;
      if (listed.email) b.email = listed.email;
      if (listed.faculty || listed.college) b.faculty = listed.faculty || listed.college;
      for (const k of ['programme', 'year_of_study']) if (listed[k]) b[k] = listed[k];
    }
  }

  for (const k of ['full_name', 'university_id', 'email', 'password']) if (!String(b[k] || '').trim()) return bad(res, 'Please fill in all required fields');
  if (b.password.length < 8 || !/\d/.test(b.password)) return bad(res, 'Password needs at least 8 characters and a number');
  if (b.role === 'student' && listed && !String(b.email).toLowerCase().endsWith('@africau.edu')) return bad(res, 'The official student record must contain an @africau.edu email address. Contact the administrator.');
  if (db.prepare('SELECT 1 FROM users WHERE email=? OR university_id=?').get(b.email.trim().toLowerCase(), b.university_id.trim()))
    return bad(res, 'An account with that email or ID already exists');

  const status = listed && AUTO_APPROVE ? 'active' : 'pending';
  const id = db.prepare(`INSERT INTO users (role, full_name, university_id, email, password_hash, status, faculty, programme, year_of_study, specialisation)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    b.role, b.full_name.trim(), b.university_id.trim(), b.email.trim().toLowerCase(), bcrypt.hashSync(b.password, 10), status,
    b.faculty || null, b.programme || null, b.year_of_study || null, b.specialisation || null).lastInsertRowid;
  ensureExtras(id);
  audit({ id, role: b.role }, 'account.registered', { type: 'user', id, student: b.role === 'student' ? id : null, decision: status, comments: listed ? 'Details taken from the official Supabase student roster' : null });
  (status === 'pending' ? db.prepare("SELECT * FROM users WHERE role='admin' AND status='active'").all() : []).forEach((a) => {
    notify(a.id, 'New account awaiting approval', `${b.full_name} registered as a ${b.role}.`, '/admin/approvals', 'account');
    sendMail({
      user: a, template: 'account_pending', subject: 'New Account Awaiting Approval – StudentSphere', related: { type: 'user', id }, heading: 'A new account needs approval',
      intro: `A new ${b.role} has registered on StudentSphere and is waiting for administrator approval.`,
      rows: [['Name', b.full_name], ['Role', b.role], ['University ID', b.university_id], ['Email', b.email], ['College', b.faculty], ['Programme', b.programme], ['Registered', today()]],
      action: { label: 'Review account', path: '/admin/approvals' }
    });
  });
  res.json({ ok: true, from_list: !!listed, active: status === 'active', message: status === 'active'
    ? 'Account created from the official university student list. You can log in now.'
    : 'Your details were verified against the student list. Your account is awaiting administrator approval.' });
}));

// Public sign-up helper. Only a masked email is returned; the complete roster stays on the server.
const lookups = new Map();
app.get('/api/auth/roster', wrap(async (req, res) => {
  const ip = req.ip || '', now = Date.now(), r = lookups.get(ip);
  if (!r || now - r.t > 10 * 60e3) lookups.set(ip, { n: 1, t: now });
  else if (++r.n > 30) return bad(res, 'Too many lookups. Please wait a few minutes.', 429);

  if (REQUIRE_ROSTER && !supabaseRoster.configured()) return bad(res, 'The official student database is not connected yet.', 503);
  const id = String(req.query.id || '').trim();
  if (!/^\d{6}$/.test(id)) return res.json({ found: false, required: REQUIRE_ROSTER, message: 'Enter a six-digit Student ID.' });
  const record = supabaseRoster.configured()
    ? await supabaseRoster.lookupStudent(id)
    : db.prepare('SELECT * FROM student_roster WHERE university_id=?').get(id);
  if (!record || (record.status && String(record.status).toLowerCase() !== 'active'))
    return res.json({ found: false, required: REQUIRE_ROSTER });

  const claimed = Boolean(db.prepare('SELECT 1 FROM users WHERE lower(university_id)=lower(?)').get(record.university_id));
  res.json({
    found: true, claimed,
    full_name: record.full_name,
    faculty: record.faculty || record.college || null,
    programme: record.programme,
    year_of_study: record.year_of_study,
    email_masked: supabaseRoster.maskEmail(record.email) || roster.maskEmail(record.email),
    required: REQUIRE_ROSTER
  });
}));

app.post('/api/auth/login', wrap((req, res) => {
  const { role, identifier, password } = req.body || {};
  if (!identifier || !password) return bad(res, 'Enter your email or ID and password');
  const key = (req.ip || '') + '|' + String(identifier).toLowerCase();
  if (tooMany(key)) return bad(res, 'Too many failed attempts. Please wait 15 minutes and try again.', 429);
  const u = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?) OR university_id=?').get(identifier.trim(), identifier.trim());
  if (!u || !bcrypt.compareSync(password, u.password_hash)) { recordFail(key); return bad(res, 'Incorrect email/ID or password', 401); }
  if (role && u.role !== role) return bad(res, `This account is not a ${role} account. Choose the correct role.`, 401);
  if (u.status === 'pending') return bad(res, 'Your account is awaiting administrator approval', 403);
  if (u.status === 'suspended') return bad(res, 'Your account has been suspended', 403);
  fails.delete(key);
  res.json({ token: jwt.sign({ id: u.id }, SECRET, { expiresIn: '12h' }), user: pub(u) });
}));

app.get('/api/me', auth(), wrap((req, res) => res.json({ user: pub(req.user) })));

app.put('/api/me/password', auth(), wrap((req, res) => {
  const { current, next } = req.body || {};
  if (!bcrypt.compareSync(current || '', req.user.password_hash)) return bad(res, 'Current password is incorrect');
  if (!next || next.length < 8 || !/\d/.test(next)) return bad(res, 'New password needs at least 8 characters and a number');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), req.user.id);
  audit(req.user, 'account.password_changed', { type: 'user', id: req.user.id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- my profile
app.get('/api/me/profile', auth(), wrap((req, res) => res.json(profileBundle(req.user.id))));

app.put('/api/me/profile', auth(), wrap((req, res) => {
  const b = req.body || {};
  ensureExtras(req.user.id);
  db.prepare('UPDATE users SET full_name=COALESCE(?,full_name), faculty=?, programme=?, year_of_study=?, specialisation=? WHERE id=?')
    .run(b.full_name || null, b.faculty ?? req.user.faculty, b.programme ?? req.user.programme,
      b.year_of_study ?? req.user.year_of_study, b.specialisation ?? req.user.specialisation, req.user.id);
  const skills = Array.isArray(b.skills) ? b.skills : String(b.skills || '').split(',').map((s) => s.trim()).filter(Boolean);
  db.prepare('UPDATE profiles SET headline=?, about=?, skills=?, phone=?, location=?, linkedin=?, github=?, experience=? WHERE user_id=?')
    .run(b.headline || '', b.about || '', JSON.stringify(skills), b.phone || '', b.location || '', b.linkedin || '', b.github || '', b.experience || '', req.user.id);
  res.json(profileBundle(req.user.id));
}));

app.post('/api/me/projects', auth('student'), wrap((req, res) => {
  const b = req.body || {};
  if (!b.title) return bad(res, 'Project title is required');
  db.prepare('INSERT INTO projects (user_id,title,description,tech,url) VALUES (?,?,?,?,?)').run(req.user.id, b.title, b.description || '', b.tech || '', b.url || '');
  res.json({ ok: true });
}));
app.delete('/api/me/projects/:id', auth('student'), wrap((req, res) => {
  db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- achievements: student side
app.get('/api/achievement-options', auth(), wrap((req, res) => res.json({ categories: ACH_CATEGORIES, reasons: REASON_CODES })));

function pickLecturer(student, requestedId) {
  if (requestedId) {
    const l = db.prepare("SELECT id FROM users WHERE id=? AND role='lecturer' AND status='active'").get(requestedId);
    if (!l) throw httpErr('The selected lecturer was not found');
    return l.id;
  }
  const a = db.prepare(`SELECT a.lecturer_id id FROM lecturer_assignments a JOIN users u ON u.id=a.lecturer_id
    WHERE a.student_id=? AND u.status='active' ORDER BY a.is_primary DESC, a.id LIMIT 1`).get(student.id);
  if (a) return a.id;
  const f = db.prepare("SELECT id FROM users WHERE role='lecturer' AND status='active' AND faculty=? ORDER BY id LIMIT 1").get(student.faculty);
  if (f) return f.id;
  throw httpErr('No lecturer is available to verify this yet. Please contact the administrator.');
}

app.post('/api/me/achievements', auth('student'), wrap((req, res) => {
  const b = req.body || {};   // NOTE: any "status" sent by the client is ignored on purpose.
  if (!String(b.title || '').trim()) return bad(res, 'Achievement title is required');
  if (!ACH_CATEGORIES.includes(b.category)) return bad(res, 'Choose an achievement category');
  if (!String(b.description || '').trim()) return bad(res, 'Please describe the achievement');
  if (!b.date_obtained) return bad(res, 'Enter the date the achievement was obtained');
  const files = prepareFiles(b.files);
  const lecturerId = pickLecturer(req.user, b.lecturer_id);
  const id = db.prepare(`INSERT INTO achievements (user_id,title,category,description,year,organisation,date_obtained,evidence_note,status,lecturer_id,created_at)
    VALUES (?,?,?,?,?,?,?,?, 'pending_verification', ?, CURRENT_TIMESTAMP)`).run(
    req.user.id, b.title.trim(), b.category, b.description.trim(), String(b.date_obtained).slice(0, 4), b.organisation || '', b.date_obtained, b.evidence_note || '', lecturerId).lastInsertRowid;
  storeFiles(id, files);
  const ach = db.prepare('SELECT * FROM achievements WHERE id=?').get(id);
  const lecturer = getUser(lecturerId);
  notify(lecturerId, 'Achievement verification required', `${req.user.full_name} submitted "${ach.title}" for verification.`, `/lecturer/achievements/${id}`, 'achievement');
  mailAchSubmitted(ach, req.user, lecturer);
  audit(req.user, 'achievement.submitted', { type: 'achievement', id, student: req.user.id, decision: 'pending_verification', comments: ach.title });
  db.prepare('INSERT INTO achievement_verifications (achievement_id,lecturer_id,student_id,action,decision,comments) VALUES (?,?,?,?,?,?)').run(id, lecturerId, req.user.id, 'submitted', 'pending_verification', null);
  res.json({ ok: true, id, message: 'Your achievement has been successfully submitted and is awaiting lecturer verification. You will receive a notification once the review is completed.' });
}));

app.put('/api/me/achievements/:id/evidence', auth('student'), wrap((req, res) => {
  const ach = db.prepare('SELECT * FROM achievements WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!ach) return bad(res, 'Achievement not found', 404);
  if (ach.status !== 'evidence_required') return bad(res, 'No additional evidence has been requested for this achievement', 409);
  const b = req.body || {};
  const files = prepareFiles((b.files || []).map((f) => ({ ...f, kind: 'additional' })));
  if (!String(b.message || '').trim() && !files.length) return bad(res, 'Add a message or attach a file');
  storeFiles(ach.id, files);
  db.prepare("UPDATE achievements SET status='pending_verification', student_response=? WHERE id=?").run(b.message || '', ach.id);
  if (ach.lecturer_id) {
    notify(ach.lecturer_id, 'Student added evidence', `${req.user.full_name} responded about "${ach.title}".`, `/lecturer/achievements/${ach.id}`, 'achievement');
    mailAchSubmitted(ach, req.user, getUser(ach.lecturer_id), true);
  }
  audit(req.user, 'achievement.evidence_added', { type: 'achievement', id: ach.id, student: req.user.id, comments: b.message || null });
  res.json({ ok: true });
}));

app.delete('/api/me/achievements/:id', auth('student'), wrap((req, res) => {
  const ach = db.prepare('SELECT * FROM achievements WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!ach) return bad(res, 'Achievement not found', 404);
  removeFiles(ach.id);
  db.prepare('DELETE FROM achievements WHERE id=?').run(ach.id);
  audit(req.user, 'achievement.deleted', { type: 'achievement', id: ach.id, student: req.user.id, decision: ach.status, comments: ach.title });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- achievements: lecturer / admin side
const ACH_LIST_SQL = `SELECT a.id, a.title, a.category, a.status, a.created_at, a.lecturer_id, a.date_obtained, a.organisation,
    s.id AS student_id, s.full_name AS student_name, s.university_id AS student_uid, l.full_name AS lecturer_name,
    (SELECT COUNT(*) FROM achievement_files f WHERE f.achievement_id=a.id) AS file_count
  FROM achievements a JOIN users s ON s.id=a.user_id LEFT JOIN users l ON l.id=a.lecturer_id`;

app.get('/api/achievements', auth('lecturer', 'admin'), wrap((req, res) => {
  const args = []; let sql = ACH_LIST_SQL + ' WHERE 1=1';
  if (req.user.role === 'lecturer') { sql += ' AND a.lecturer_id=?'; args.push(req.user.id); }
  if (req.query.status && ACH_STATUSES.includes(req.query.status)) { sql += ' AND a.status=?'; args.push(req.query.status); }
  res.json(db.prepare(sql + ' ORDER BY a.id DESC').all(...args));
}));

function loadAchievementFor(user, id) {
  const a = db.prepare('SELECT * FROM achievements WHERE id=?').get(id);
  if (!a) throw httpErr('Achievement not found', 404);
  const ok = user.role === 'admin' || (user.role === 'student' && a.user_id === user.id) || (user.role === 'lecturer' && a.lecturer_id === user.id);
  if (!ok) throw httpErr('You do not have permission to view this achievement', 403);
  return a;
}

app.get('/api/achievements/:id', auth(), wrap((req, res) => {
  const a = loadAchievementFor(req.user, req.params.id);
  const student = getUser(a.user_id);
  res.json({
    achievement: { ...a, files: filesOf(a.id), lecturer_name: a.lecturer_id ? getUser(a.lecturer_id).full_name : null },
    student: pub(student), cgpa: cgpaOf(a.user_id),
    history: db.prepare(`SELECT v.action, v.decision, v.comments, v.created_at, l.full_name AS lecturer_name FROM achievement_verifications v
      LEFT JOIN users l ON l.id=v.lecturer_id WHERE v.achievement_id=? ORDER BY v.id`).all(a.id)
  });
}));

app.put('/api/achievements/:id/review', auth('lecturer'), wrap((req, res) => {
  const a = loadAchievementFor(req.user, req.params.id);   // only the lecturer this achievement was sent to
  const { action, comment, reason_code } = req.body || {};
  const student = getUser(a.user_id);
  const text = String(comment || '').trim();
  if (['verified', 'rejected'].includes(a.status)) return bad(res, 'This achievement has already been decided', 409);
  if (a.status === 'evidence_required' && action !== 'start_review') return bad(res, 'Waiting for the student to provide the requested evidence', 409);

  const record = (act, decision, c, code) => {
    db.prepare('INSERT INTO achievement_verifications (achievement_id,lecturer_id,student_id,action,decision,comments) VALUES (?,?,?,?,?,?)')
      .run(a.id, req.user.id, a.user_id, act, decision, [code, c].filter(Boolean).join(': ') || null);
    audit(req.user, 'achievement.' + act, { type: 'achievement', id: a.id, student: a.user_id, decision, comments: [code, c].filter(Boolean).join(': ') || null });
  };

  if (action === 'start_review') {
    if (a.status === 'pending_verification') { db.prepare("UPDATE achievements SET status='under_review' WHERE id=?").run(a.id); record('review_started', 'under_review'); }
  } else if (action === 'verify') {
    db.prepare("UPDATE achievements SET status='verified', reviewer_comment=?, reason_code=NULL, evidence_request=NULL, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(text || null, a.id);
    record('verify', 'verified', text);
    notify(a.user_id, 'Achievement verified', `"${a.title}" was verified by ${req.user.full_name}.`, '/student/achievements', 'achievement');
    mailAchDecision(a, student, req.user, 'verified', text);
  } else if (action === 'reject') {
    if (!REASON_CODES.includes(reason_code)) return bad(res, 'Choose a reason for rejecting this achievement');
    if (text.length < 10) return bad(res, 'Explain the reason for rejection (at least 10 characters). Rejections must be based on evidence, accuracy, relevance or university guidelines.');
    db.prepare("UPDATE achievements SET status='rejected', reviewer_comment=?, reason_code=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(text, reason_code, a.id);
    record('reject', 'rejected', text, reason_code);
    notify(a.user_id, 'Achievement not verified', `"${a.title}" could not be verified: ${text}`, '/student/achievements', 'achievement');
    mailAchDecision(a, student, req.user, 'rejected', `${reason_code.replace(/_/g, ' ')} — ${text}`);
  } else if (action === 'request_evidence') {
    if (text.length < 10) return bad(res, 'Describe the evidence or clarification you need (at least 10 characters)');
    db.prepare("UPDATE achievements SET status='evidence_required', evidence_request=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(text, a.id);
    record('request_evidence', 'evidence_required', text);
    notify(a.user_id, 'Additional evidence required', `${req.user.full_name} needs more evidence for "${a.title}": ${text}`, '/student/achievements', 'achievement');
    mailAchDecision(a, student, req.user, 'evidence_required', text);
  } else return bad(res, 'Unknown action');
  res.json({ ok: true });
}));

// Authenticated file download (files are NOT in the public folder)
app.get('/api/files/:id', auth(), wrap((req, res) => {
  const f = db.prepare('SELECT * FROM achievement_files WHERE id=?').get(req.params.id);
  if (!f) return bad(res, 'File not found', 404);
  loadAchievementFor(req.user, f.achievement_id);
  const p = path.join(UPLOAD_DIR, f.stored_name);
  if (!fs.existsSync(p)) return bad(res, 'File is missing on the server', 404);
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `inline; filename="${String(f.original_name).replace(/"/g, '')}"`);
  res.sendFile(p);
}));

// ---------------------------------------------------------------- directories
app.get('/api/lecturers', auth(), wrap((req, res) => {
  res.json(db.prepare(`SELECT u.id, u.full_name, u.faculty, u.specialisation,
    EXISTS(SELECT 1 FROM lecturer_assignments a WHERE a.lecturer_id=u.id AND a.student_id=?) AS assigned
    FROM users u WHERE u.role='lecturer' AND u.status='active' ORDER BY assigned DESC, u.full_name`).all(req.user.id));
}));

app.get('/api/students', auth('lecturer', 'admin'), wrap((req, res) => {
  let rows = db.prepare("SELECT * FROM users WHERE role='student' AND status='active' ORDER BY full_name").all();
  if (req.user.role === 'lecturer') rows = rows.filter((u) => lecturerCanSee(req.user.id, u.id));
  res.json(rows.map((u) => ({ ...pub(u), cgpa: cgpaOf(u.id) })));
}));

app.get('/api/students/:id/profile', auth('lecturer', 'admin'), wrap((req, res) => {
  const sid = Number(req.params.id);
  if (req.user.role === 'lecturer' && !lecturerCanSee(req.user.id, sid)) return bad(res, 'This student is not assigned to you and has not sent you a request', 403);
  const b = profileBundle(sid);
  if (!b || b.user.role !== 'student') return bad(res, 'Student not found', 404);
  // A lecturer only sees achievements addressed to them, plus all verified ones (to give context for letters).
  if (req.user.role === 'lecturer') b.achievements = b.achievements.filter((a) => a.lecturer_id === req.user.id || a.status === 'verified');
  res.json(b);
}));

// ---------------------------------------------------------------- recommendations
const RECS_SQL = `
  SELECT r.*, s.full_name AS student_name, s.programme AS student_programme, s.university_id AS student_uid, s.faculty AS student_faculty,
         l.full_name AS lecturer_name,
         CAST(julianday('now') - julianday(r.created_at) AS INTEGER) AS age_days
  FROM recommendations r
  JOIN users s ON s.id = r.student_id
  JOIN users l ON l.id = r.lecturer_id`;

app.get('/api/recommendations', auth(), wrap((req, res) => {
  const u = req.user;
  let rows;
  if (u.role === 'student') rows = db.prepare(RECS_SQL + ' WHERE r.student_id=? ORDER BY r.id DESC').all(u.id);
  else if (u.role === 'lecturer') rows = db.prepare(RECS_SQL + ' WHERE r.lecturer_id=? ORDER BY r.id DESC').all(u.id);
  else rows = db.prepare(RECS_SQL + ' ORDER BY r.id DESC').all();
  res.json(rows.map((r) => {
    const out = { ...r, ref: 'REC-' + (2040 + r.id) };
    // Letters: lecturer (owner) always; student only when completed AND released; admins never see letter text.
    const visible = u.role === 'lecturer' || (u.role === 'student' && r.status === 'completed' && r.release_to_student);
    if (!visible) delete out.letter;
    return out;
  }));
}));

app.post('/api/recommendations', auth('student'), wrap((req, res) => {
  const b = req.body || {};
  if (!b.lecturer_id || !String(b.purpose || '').trim()) return bad(res, 'Choose a lecturer and a purpose');
  const lec = db.prepare("SELECT * FROM users WHERE id=? AND role='lecturer' AND status='active'").get(b.lecturer_id);
  if (!lec) return bad(res, 'Lecturer not found');
  const id = db.prepare('INSERT INTO recommendations (student_id,lecturer_id,purpose,deadline,message) VALUES (?,?,?,?,?)')
    .run(req.user.id, lec.id, b.purpose.trim(), b.deadline || null, b.message || '').lastInsertRowid;
  const rec = db.prepare('SELECT * FROM recommendations WHERE id=?').get(id);
  notify(lec.id, 'New recommendation request', `${req.user.full_name} requested a letter for: ${rec.purpose}.`, `/lecturer/requests/${id}`, 'recommendation');
  mailRecRequest(rec, req.user, lec);
  audit(req.user, 'recommendation.requested', { type: 'recommendation', id, student: req.user.id, decision: 'pending', comments: rec.purpose });
  res.json({ ok: true, id });
}));

const OPEN = ['pending', 'under_review', 'approved'];
app.put('/api/recommendations/:id', auth('lecturer'), wrap((req, res) => {
  const r = db.prepare('SELECT * FROM recommendations WHERE id=?').get(req.params.id);
  if (!r) return bad(res, 'Request not found', 404);
  if (r.lecturer_id !== req.user.id) return bad(res, 'This request was sent to a different lecturer', 403);
  const { action, letter, reason, note, release } = req.body || {};
  const student = getUser(r.student_id);
  const rec = (act, decision, c) => audit(req.user, 'recommendation.' + act, { type: 'recommendation', id: r.id, student: r.student_id, decision, comments: c || null });
  const set = (status, extra = '', ...args) => db.prepare(`UPDATE recommendations SET status=?, updated_at=CURRENT_TIMESTAMP ${extra} WHERE id=?`).run(status, ...args, r.id);

  if (action === 'start_review') {
    if (r.status === 'pending') { set('under_review'); rec('review_started', 'under_review'); }
  } else if (action === 'approve') {
    if (!['pending', 'under_review'].includes(r.status)) return bad(res, 'This request cannot be approved from its current status', 409);
    set('approved'); rec('approved', 'approved');
    notify(r.student_id, 'Recommendation request approved', `${req.user.full_name} approved your request for: ${r.purpose}.`, '/student/recommendations', 'recommendation');
    mailRecUpdate(r, student, req.user, 'approved');
  } else if (action === 'decline') {
    if (!OPEN.includes(r.status)) return bad(res, 'This request can no longer be declined', 409);
    const why = String(reason || '').trim();
    if (why.length < 10) return bad(res, 'Please give a reason for declining (at least 10 characters)');
    set('declined', ', decline_reason=?', why); rec('declined', 'declined', why);
    notify(r.student_id, 'Recommendation request declined', `${req.user.full_name} declined your request: ${why}`, '/student/recommendations', 'recommendation');
    mailRecUpdate(r, student, req.user, 'declined', why);
  } else if (action === 'more_info') {
    if (!['pending', 'under_review'].includes(r.status)) return bad(res, 'More information can only be requested before approving', 409);
    const ask = String(note || '').trim();
    if (ask.length < 10) return bad(res, 'Tell the student what information you need (at least 10 characters)');
    set('more_info', ', info_request=?', ask); rec('more_info_requested', 'more_info', ask);
    notify(r.student_id, 'More information required', `${req.user.full_name} needs more information: ${ask}`, '/student/recommendations', 'recommendation');
    mailRecUpdate(r, student, req.user, 'more_info', ask);
  } else if (action === 'save_draft') {
    if (r.status !== 'approved') return bad(res, 'Approve the request before writing the letter', 409);
    db.prepare('UPDATE recommendations SET letter=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(String(letter || ''), r.id); rec('draft_saved', 'approved');
  } else if (action === 'submit') {
    if (r.status !== 'approved') return bad(res, 'Approve the request before submitting the letter', 409);
    if (!letter || String(letter).trim().length < 30) return bad(res, 'Write the letter before submitting (at least 30 characters)');
    const rel = release === false || release === 0 ? 0 : 1;
    set('completed', ', letter=?, release_to_student=?, completed_at=CURRENT_TIMESTAMP', String(letter), rel);
    rec('completed', 'completed', rel ? 'released to student' : 'not released to student');
    notify(r.student_id, 'Recommendation letter ready', `${req.user.full_name} completed your letter for: ${r.purpose}.`, '/student/recommendations', 'recommendation');
    mailRecUpdate(r, student, req.user, 'completed');
  } else return bad(res, 'Unknown action');
  res.json({ ok: true });
}));

app.put('/api/recommendations/:id/info', auth('student'), wrap((req, res) => {
  const r = db.prepare('SELECT * FROM recommendations WHERE id=? AND student_id=?').get(req.params.id, req.user.id);
  if (!r) return bad(res, 'Request not found', 404);
  if (r.status !== 'more_info') return bad(res, 'No extra information was requested', 409);
  const add = String((req.body || {}).message || '').trim();
  if (!add) return bad(res, 'Write your reply');
  db.prepare("UPDATE recommendations SET message=?, status='pending', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(`${r.message || ''}\n\nStudent update (${today()}): ${add}`.trim(), r.id);
  notify(r.lecturer_id, 'Student added information', `${req.user.full_name} added details to request REC-${2040 + r.id}.`, `/lecturer/requests/${r.id}`, 'recommendation');
  audit(req.user, 'recommendation.info_added', { type: 'recommendation', id: r.id, student: req.user.id, comments: add });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- notifications & settings
app.get('/api/notifications', auth(), wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id));
}));
app.post('/api/notifications/read-all', auth(), wrap((req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
}));
app.put('/api/notifications/:id/read', auth(), wrap((req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
}));
app.get('/api/me/settings', auth(), wrap((req, res) => {
  ensureExtras(req.user.id);
  res.json(db.prepare('SELECT email_notifications, deadline_reminders FROM settings WHERE user_id=?').get(req.user.id));
}));
app.put('/api/me/settings', auth(), wrap((req, res) => {
  ensureExtras(req.user.id);
  const b = req.body || {};
  db.prepare('UPDATE settings SET email_notifications=?, deadline_reminders=? WHERE user_id=?').run(b.email_notifications ? 1 : 0, b.deadline_reminders ? 1 : 0, req.user.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- dashboards
app.get('/api/dashboard', auth(), wrap((req, res) => {
  const u = req.user;
  const recent = db.prepare('SELECT title, body, link, created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 5').all(u.id);
  const c = (sql, ...a) => db.prepare(sql).get(...a).c;
  if (u.role === 'student') {
    const p = profileBundle(u.id);
    const recs = db.prepare('SELECT status FROM recommendations WHERE student_id=?').all(u.id);
    return res.json({
      cgpa: p.cgpa, projects: p.projects.length, achievements: p.achievements.length, skills: p.profile.skills.length,
      verified: p.achievements.filter((a) => a.status === 'verified').length,
      needs_action: p.achievements.filter((a) => a.status === 'evidence_required').length + recs.filter((r) => r.status === 'more_info').length,
      recs_total: recs.length, recs_ready: recs.filter((r) => r.status === 'completed').length, recent
    });
  }
  if (u.role === 'lecturer') {
    const rows = db.prepare('SELECT status, deadline FROM recommendations WHERE lecturer_id=?').all(u.id);
    const open = rows.filter((r) => OPEN.includes(r.status));
    const attention = [
      ...db.prepare(RECS_SQL + " WHERE r.lecturer_id=? AND r.status IN ('pending','under_review','approved') ORDER BY r.id DESC LIMIT 6").all(u.id)
        .map((r) => ({ type: 'Recommendation', title: r.purpose, student: r.student_name, status: r.status, date: r.created_at, link: `/lecturer/requests/${r.id}` })),
      ...db.prepare(ACH_LIST_SQL + " WHERE a.lecturer_id=? AND a.status IN ('pending_verification','under_review') ORDER BY a.id DESC LIMIT 6").all(u.id)
        .map((a) => ({ type: 'Achievement', title: a.title, student: a.student_name, status: a.status, date: a.created_at, link: `/lecturer/achievements/${a.id}` }))
    ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8);
    return res.json({
      assigned: c('SELECT COUNT(*) c FROM lecturer_assignments WHERE lecturer_id=?', u.id),
      pending_recs: open.length, completed_recs: rows.filter((r) => r.status === 'completed').length,
      pending_ach: c("SELECT COUNT(*) c FROM achievements WHERE lecturer_id=? AND status IN ('pending_verification','under_review')", u.id),
      verified_ach: c("SELECT COUNT(*) c FROM achievements WHERE lecturer_id=? AND status='verified'", u.id),
      attention, recent
    });
  }
  const t = new Date().toISOString().slice(0, 10);
  res.json({
    users: c('SELECT COUNT(*) c FROM users'), awaiting: c("SELECT COUNT(*) c FROM users WHERE status='pending'"),
    recs: c('SELECT COUNT(*) c FROM recommendations'),
    overdue: c("SELECT COUNT(*) c FROM recommendations WHERE status IN ('pending','under_review','approved','more_info') AND deadline < ?", t),
    ageing: c("SELECT COUNT(*) c FROM recommendations WHERE status IN ('pending','under_review','approved','more_info') AND julianday('now') - julianday(created_at) > 10"),
    ach_pending: c("SELECT COUNT(*) c FROM achievements WHERE status IN ('pending_verification','under_review','evidence_required')"),
    ach_unassigned: c("SELECT COUNT(*) c FROM achievements WHERE lecturer_id IS NULL AND status != 'verified'"), recent
  });
}));

// ---------------------------------------------------------------- admin
app.get('/api/admin/users', auth('admin'), wrap((req, res) => {
  const { role, status, q } = req.query;
  let sql = 'SELECT * FROM users WHERE 1=1'; const args = [];
  if (role) { sql += ' AND role=?'; args.push(role); }
  if (status) { sql += ' AND status=?'; args.push(status); }
  if (q) { sql += ' AND (full_name LIKE ? OR email LIKE ? OR university_id LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  res.json(db.prepare(sql + ' ORDER BY id DESC').all(...args).map(pub));
}));

app.put('/api/admin/users/:id', auth('admin'), wrap((req, res) => {
  const { status } = req.body || {};
  if (!['active', 'pending', 'suspended'].includes(status)) return bad(res, 'Invalid status');
  const target = getUser(req.params.id);
  if (!target) return bad(res, 'User not found', 404);
  if (target.id === req.user.id) return bad(res, 'You cannot change your own account');
  db.prepare('UPDATE users SET status=? WHERE id=?').run(status, target.id);
  audit(req.user, 'account.' + status, { type: 'user', id: target.id, student: target.role === 'student' ? target.id : null, decision: status });
  if (status === 'active' && target.status === 'pending') {
    notify(target.id, 'Account approved', 'Your StudentSphere account is now active.', null, 'account');
    sendMail({
      user: target, force: true, template: 'account_approved', subject: 'Your StudentSphere Account Is Approved', related: { type: 'user', id: target.id },
      heading: 'Your account has been approved', intro: 'An administrator has approved your StudentSphere account. You can now log in.',
      rows: [['Role', target.role], ['University ID', target.university_id]], action: { label: 'Log in', path: '/login' }
    });
  }
  res.json({ ok: true });
}));

app.post('/api/admin/users/:id/reject', auth('admin'), wrap((req, res) => {
  const target = getUser(req.params.id);
  if (!target) return bad(res, 'User not found', 404);
  if (target.status !== 'pending') return bad(res, 'Only pending registrations can be rejected', 409);
  const reason = String((req.body || {}).reason || '').trim();
  sendMail({
    user: target, force: true, template: 'account_rejected', subject: 'Your StudentSphere Registration Was Not Approved', related: { type: 'user', id: target.id },
    heading: 'Your registration was not approved', intro: 'An administrator reviewed your StudentSphere registration and could not approve it.',
    rows: [['Reason', reason || 'No reason was given']], paragraphs: ['If you believe this is a mistake, please contact the university administration.']
  });
  audit(req.user, 'account.rejected', { type: 'user', id: target.id, decision: 'rejected', comments: reason || null });
  db.prepare('DELETE FROM users WHERE id=?').run(target.id);
  res.json({ ok: true });
}));

app.delete('/api/admin/users/:id', auth('admin'), wrap((req, res) => {
  const target = getUser(req.params.id);
  if (!target) return bad(res, 'User not found', 404);
  if (target.id === req.user.id) return bad(res, 'You cannot delete your own account');
  db.prepare('SELECT id FROM achievements WHERE user_id=?').all(target.id).forEach((a) => removeFiles(a.id));
  audit(req.user, 'account.deleted', { type: 'user', id: target.id, comments: `${target.role}: ${target.full_name}` });
  db.prepare('DELETE FROM users WHERE id=?').run(target.id);
  res.json({ ok: true });
}));

// Lecturer <-> student assignments
app.get('/api/admin/assignments', auth('admin'), wrap((req, res) => {
  const students = db.prepare("SELECT id, full_name, university_id, programme FROM users WHERE role='student' AND status='active' ORDER BY full_name").all()
    .map((s) => ({ ...s, assignments: db.prepare(`SELECT a.id, a.lecturer_id, a.is_primary, u.full_name AS lecturer_name FROM lecturer_assignments a
      JOIN users u ON u.id=a.lecturer_id WHERE a.student_id=? ORDER BY a.is_primary DESC, a.id`).all(s.id) }));
  res.json({ students, lecturers: db.prepare("SELECT id, full_name FROM users WHERE role='lecturer' AND status='active' ORDER BY full_name").all() });
}));
app.post('/api/admin/assignments', auth('admin'), wrap((req, res) => {
  const { student_id, lecturer_id, is_primary } = req.body || {};
  const s = db.prepare("SELECT id FROM users WHERE id=? AND role='student'").get(student_id);
  const l = db.prepare("SELECT id FROM users WHERE id=? AND role='lecturer' AND status='active'").get(lecturer_id);
  if (!s || !l) return bad(res, 'Choose a valid student and an active lecturer');
  if (is_primary) db.prepare('UPDATE lecturer_assignments SET is_primary=0 WHERE student_id=?').run(s.id);
  db.prepare('INSERT INTO lecturer_assignments (student_id,lecturer_id,is_primary) VALUES (?,?,?) ON CONFLICT(student_id,lecturer_id) DO UPDATE SET is_primary=excluded.is_primary')
    .run(s.id, l.id, is_primary ? 1 : 0);
  db.routeUnassignedAchievements();
  audit(req.user, 'assignment.added', { type: 'assignment', student: s.id, comments: `lecturer ${l.id}${is_primary ? ' (primary)' : ''}` });
  res.json({ ok: true });
}));
app.delete('/api/admin/assignments/:id', auth('admin'), wrap((req, res) => {
  const a = db.prepare('SELECT * FROM lecturer_assignments WHERE id=?').get(req.params.id);
  if (!a) return bad(res, 'Assignment not found', 404);
  db.prepare('DELETE FROM lecturer_assignments WHERE id=?').run(a.id);
  audit(req.user, 'assignment.removed', { type: 'assignment', student: a.student_id, comments: `lecturer ${a.lecturer_id}` });
  res.json({ ok: true });
}));

// Email log + audit trail
app.get('/api/admin/emails', auth('admin'), wrap((req, res) => {
  res.json({ mode: mailMode(), app_url: appUrl(), rows: db.prepare('SELECT id,to_email,subject,template,status,error,created_at FROM email_log ORDER BY id DESC LIMIT 200').all() });
}));
app.get('/api/admin/emails/:id', auth('admin'), wrap((req, res) => {
  const e = db.prepare('SELECT * FROM email_log WHERE id=?').get(req.params.id);
  if (!e) return bad(res, 'Email not found', 404);
  res.json(e);
}));
app.post('/api/admin/email-test', auth('admin'), wrap((req, res) => {
  sendMail({ user: req.user, force: true, template: 'test', subject: 'StudentSphere test email', heading: 'Email test',
    intro: 'If you can read this, StudentSphere email is configured correctly.', rows: [['Mode', mailMode()], ['Sent', today()]] });
  res.json({ ok: true, mode: mailMode() });
}));
app.get('/api/admin/audit', auth('admin'), wrap((req, res) => {
  res.json(db.prepare(`SELECT g.*, a.full_name AS actor_name, s.full_name AS student_name FROM audit_log g
    LEFT JOIN users a ON a.id=g.actor_id LEFT JOIN users s ON s.id=g.student_id ORDER BY g.id DESC LIMIT 300`).all());
}));

// CSV columns: university_id, year_label, academic_year, gpa, standing
app.post('/api/admin/import', auth('admin'), wrap((req, res) => {
  const lines = String((req.body || {}).csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let imported = 0; const warnings = [];
  const ins = db.prepare('INSERT INTO results (user_id,year_label,academic_year,gpa,standing) VALUES (?,?,?,?,?)');
  lines.forEach((line, i) => {
    const c = line.split(',').map((x) => x.trim());
    if (i === 0 && /university_id/i.test(c[0])) return;
    const stu = db.prepare("SELECT id FROM users WHERE university_id=? AND role='student'").get(c[0]);
    const gpa = parseFloat(c[3]);
    if (!stu || !c[1] || isNaN(gpa)) { warnings.push(`Line ${i + 1}: could not import "${line}"`); return; }
    ins.run(stu.id, c[1], c[2] || '', gpa, c[4] || ''); imported++;
  });
  audit(req.user, 'records.imported', { type: 'results', comments: `${imported} rows` });
  res.json({ imported, warnings });
}));

// Student list (spreadsheet) managed by the admin. The browser converts .xlsx to CSV text before sending.
app.get('/api/admin/roster', auth('admin'), wrap((req, res) => res.json(roster.listRoster(db, req.query.q))));
app.post('/api/admin/roster', auth('admin'), wrap((req, res) => {
  const r = roster.importRoster(db, (req.body || {}).csv);
  audit(req.user, 'roster.imported', { type: 'roster', comments: `${r.added} added, ${r.updated} updated, ${r.skipped} skipped` });
  res.json(r);
}));
app.delete('/api/admin/roster/:id', auth('admin'), wrap((req, res) => {
  db.prepare('DELETE FROM student_roster WHERE id=?').run(req.params.id);
  audit(req.user, 'roster.entry_removed', { type: 'roster', id: Number(req.params.id) });
  res.json({ ok: true });
}));
app.delete('/api/admin/roster', auth('admin'), wrap((req, res) => {
  const n = db.prepare('DELETE FROM student_roster WHERE NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.university_id)=lower(student_roster.university_id))').run().changes;
  audit(req.user, 'roster.cleared', { type: 'roster', comments: `${n} unregistered entries removed` });
  res.json({ removed: n });
}));

app.get('/api/admin/records', auth('admin'), wrap((req, res) => {
  res.json({
    faculties: db.prepare("SELECT COUNT(DISTINCT faculty) c FROM users WHERE faculty IS NOT NULL AND faculty != ''").get().c,
    programmes: db.prepare("SELECT COUNT(DISTINCT programme) c FROM users WHERE programme IS NOT NULL AND programme != ''").get().c,
    rows: db.prepare(`SELECT u.full_name, u.university_id, u.programme, r.year_label, r.academic_year, r.gpa, r.standing
      FROM results r JOIN users u ON u.id=r.user_id ORDER BY u.full_name, r.id`).all()
  });
}));

app.get('/api/admin/reports', auth('admin'), wrap((req, res) => {
  const count = (sql) => db.prepare(sql).get().c;
  const students = count("SELECT COUNT(*) c FROM users WHERE role='student'");
  const filled = count("SELECT COUNT(*) c FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.role='student' AND length(coalesce(p.about,''))>0");
  res.json({
    users_total: count('SELECT COUNT(*) c FROM users'), students, lecturers: count("SELECT COUNT(*) c FROM users WHERE role='lecturer'"),
    pending_accounts: count("SELECT COUNT(*) c FROM users WHERE status='pending'"),
    profile_completion: students ? Math.round((filled / students) * 100) : 0,
    recs_total: count('SELECT COUNT(*) c FROM recommendations'),
    recs_completed: count("SELECT COUNT(*) c FROM recommendations WHERE status='completed'"),
    recs_declined: count("SELECT COUNT(*) c FROM recommendations WHERE status='declined'"),
    recs_open: count("SELECT COUNT(*) c FROM recommendations WHERE status IN ('pending','under_review','approved','more_info')"),
    achievements_total: count('SELECT COUNT(*) c FROM achievements'),
    achievements_verified: count("SELECT COUNT(*) c FROM achievements WHERE status='verified'"),
    achievements_rejected: count("SELECT COUNT(*) c FROM achievements WHERE status='rejected'"),
    achievements_awaiting: count("SELECT COUNT(*) c FROM achievements WHERE status IN ('pending_verification','under_review','evidence_required')"),
    emails_sent: count("SELECT COUNT(*) c FROM email_log WHERE status IN ('sent','dev')"),
    emails_failed: count("SELECT COUNT(*) c FROM email_log WHERE status='failed'"),
    avg_cgpa: db.prepare("SELECT ROUND(AVG(gpa),2) c FROM results WHERE academic_year != 'Projected'").get().c
  });
}));

// Faculties, courses, marks, GPA/CGPA and optional demo data live in academics.js
require('./academics')(app, { db, auth, wrap, bad, audit, notify });

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res) => bad(res, 'Not found', 404));

if (require.main === module) {
  app.listen(PORT, () => console.log(`StudentSphere running at http://localhost:${PORT}  (email mode: ${mailMode()})`));
}
module.exports = app;
