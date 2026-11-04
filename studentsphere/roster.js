// Student roster: the official student list uploaded by the admin (as CSV text) and the lookup used at sign-up.
// Kept free of Express so it is easy to test. `db` is the better-sqlite3 connection.

// Accepted column names (case, spaces and symbols are ignored): "Student ID", "student_id", "university_id" ...
const HEADERS = {
  university_id: ['universityid', 'studentid', 'id', 'regnumber', 'regno', 'registrationnumber', 'studentnumber', 'studentno'],
  full_name: ['fullname', 'name', 'studentname'],
  first_name: ['firstname', 'givenname', 'givennames', 'forename'],
  last_name: ['surname', 'lastname', 'familyname'],
  email: ['email', 'emailaddress', 'universityemail', 'studentemail'],
  faculty: ['faculty', 'college', 'department', 'school'],
  programme: ['programme', 'program', 'course', 'degree', 'programmeofstudy', 'programofstudy'],
  year_of_study: ['yearofstudy', 'year', 'level', 'studylevel']
};
const MAX_ROWS = 20000;
const httpErr = (m, status = 400) => Object.assign(new Error(m), { status });

// Small RFC 4180 CSV parser (quotes, commas inside quotes, CRLF). Detects , ; or tab as the separator.
function parseCsv(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function normYear(v) {
  v = String(v || '').trim(); if (!v) return null;
  if (/^\d$/.test(v)) return 'Year ' + v;
  const m = v.match(/^year\s*(\d)$/i); if (m) return 'Year ' + m[1];
  if (/^post/i.test(v)) return 'Postgraduate';
  return v;
}

function importRoster(db, csvText) {
  const rows = parseCsv(csvText).filter((r) => r.some((c) => String(c).trim()));
  if (rows.length < 2) throw httpErr('The file needs a header row and at least one student.');
  if (rows.length > MAX_ROWS + 1) throw httpErr(`Please upload at most ${MAX_ROWS} students at a time.`);
  const map = {};
  rows[0].forEach((h, i) => {
    const k = String(h).toLowerCase().replace(/[^a-z]/g, '');
    for (const [f, names] of Object.entries(HEADERS)) if (names.includes(k) && map[f] === undefined) map[f] = i;
  });
  if (map.university_id === undefined) throw httpErr('No Student ID column found. Name the column "Student ID" or "university_id".');
  if (map.full_name === undefined && (map.first_name === undefined || map.last_name === undefined))
    throw httpErr('No name column found. Use "Full name", or "First name" and "Surname".');

  const exists = db.prepare('SELECT 1 FROM student_roster WHERE university_id=?');
  const upsert = db.prepare(`INSERT INTO student_roster (university_id, full_name, email, faculty, programme, year_of_study) VALUES (?,?,?,?,?,?)
    ON CONFLICT(university_id) DO UPDATE SET full_name=excluded.full_name, email=COALESCE(excluded.email, email),
      faculty=COALESCE(excluded.faculty, faculty), programme=COALESCE(excluded.programme, programme),
      year_of_study=COALESCE(excluded.year_of_study, year_of_study)`);
  let added = 0, updated = 0, skipped = 0; const warnings = [];
  const warn = (m) => { if (warnings.length < 25) warnings.push(m); };

  db.exec('BEGIN');
  try {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const get = (f) => (map[f] === undefined ? '' : String(r[map[f]] ?? '').trim());
      const uid = get('university_id');
      const name = get('full_name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ');
      if (!uid || !name) { skipped++; warn(`Row ${i + 1}: missing student ID or name, skipped`); continue; }
      let email = get('email').toLowerCase();
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { warn(`Row ${i + 1}: "${email}" is not a valid email, left blank`); email = ''; }
      const had = exists.get(uid);
      upsert.run(uid, name, email || null, get('faculty') || null, get('programme') || null, normYear(get('year_of_study')));
      if (had) updated++; else added++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { added, updated, skipped, warnings };
}

const maskEmail = (e) => { if (!e || !e.includes('@')) return null; const [n, d] = e.split('@'); return (n[0] || '') + '***@' + d; };

// What the sign-up form may learn about an ID. Email is masked; the real one is applied on the server at registration.
function lookup(db, id) {
  const r = db.prepare(`SELECT r.*, EXISTS(SELECT 1 FROM users u WHERE lower(u.university_id)=lower(r.university_id)) AS claimed
    FROM student_roster r WHERE r.university_id=?`).get(String(id || '').trim());
  if (!r) return { found: false };
  return { found: true, claimed: !!r.claimed, full_name: r.full_name, faculty: r.faculty, programme: r.programme,
    year_of_study: r.year_of_study, email_masked: maskEmail(r.email) };
}

function listRoster(db, q) {
  const like = `%${String(q || '').trim()}%`;
  const rows = db.prepare(`SELECT r.*, EXISTS(SELECT 1 FROM users u WHERE lower(u.university_id)=lower(r.university_id)) AS registered
    FROM student_roster r WHERE ? = '%%' OR r.full_name LIKE ? OR r.university_id LIKE ? OR r.programme LIKE ? ORDER BY r.full_name LIMIT 500`).all(like, like, like, like);
  const total = db.prepare('SELECT COUNT(*) c FROM student_roster').get().c;
  const registered = db.prepare('SELECT COUNT(*) c FROM student_roster r WHERE EXISTS(SELECT 1 FROM users u WHERE lower(u.university_id)=lower(r.university_id))').get().c;
  return { total, registered, rows: rows.map((x) => ({ ...x, registered: !!x.registered })) };
}

module.exports = { parseCsv, importRoster, lookup, listRoster, maskEmail };
