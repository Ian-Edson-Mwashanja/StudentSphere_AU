// StudentSphere academics module (additive: creates its own tables, never deletes or rewrites existing data).
//   * Faculties and departments
//   * Courses, lecturer mark entry, Registrar approval
//   * GPA / CGPA calculated from APPROVED marks only (never typed in by hand)
//   * Optional demo data (set DEMO_PASSWORD on a fresh database)
const bcrypt = require('bcryptjs');

const SEM_RE = /^\d{4}-S[1-3]$/;               // e.g. 2026-S1
const round2 = (x) => Math.round(x * 100) / 100;
const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const text = (v, max = 80) => String(v || '').trim().slice(0, max);

module.exports = function mountAcademics(app, { db, auth, wrap, bad, audit, notify }) {
  // ------------------------------------------------------------ schema (CREATE IF NOT EXISTS only)
  db.exec(`
  CREATE TABLE IF NOT EXISTS faculties (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, faculty_id INTEGER NOT NULL REFERENCES faculties(id),
    name TEXT NOT NULL COLLATE NOCASE, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE (faculty_id, name));
  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE NOCASE, title TEXT NOT NULL,
    credits REAL NOT NULL DEFAULT 3, department_id INTEGER REFERENCES departments(id),
    lecturer_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS course_marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id),
    semester TEXT NOT NULL, coursework REAL, exam REAL, total REAL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','returned')),
    return_comment TEXT, entered_by INTEGER, approved_by INTEGER, approved_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE (student_id, course_id, semester));
  CREATE TABLE IF NOT EXISTS grade_scale (grade TEXT PRIMARY KEY, min_mark REAL NOT NULL, points REAL NOT NULL);
  `);
  // SAMPLE scale. The Registrar replaces it with the official one from the Results page.
  if (!db.prepare('SELECT 1 FROM grade_scale LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO grade_scale (grade,min_mark,points) VALUES (?,?,?)');
    [['A', 80, 4], ['B', 70, 3], ['C', 60, 2], ['D', 50, 1], ['F', 0, 0]].forEach((r) => ins.run(...r));
  }

  // ------------------------------------------------------------ calculation
  const getScale = () => db.prepare('SELECT grade, min_mark, points FROM grade_scale ORDER BY min_mark DESC').all().map((r) => ({ ...r }));
  const gradeOf = (total, scale) => {
    if (total === null || total === undefined) return { grade: '—', points: 0 };
    const s = scale.find((x) => total >= x.min_mark) || scale[scale.length - 1];
    return { grade: s.grade, points: s.points };
  };
  const weighted = (list) => {
    const cr = list.reduce((a, r) => a + r.credits, 0);
    return cr ? round2(list.reduce((a, r) => a + r.points * r.credits, 0) / cr) : null;   // GPA = sum(points x credits) / sum(credits)
  };
  const standing = (cgpa) => (cgpa === null ? '—' : cgpa >= 3.5 ? "Dean's list" : cgpa >= 2 ? 'Good standing' : 'Academic warning');

  // Only APPROVED marks count. Semester GPA uses that semester's courses; CGPA uses the latest attempt of every course.
  function transcript(studentId) {
    const scale = getScale();
    const rows = db.prepare(`SELECT m.course_id, m.semester, m.coursework, m.exam, m.total, c.code, c.title, c.credits
      FROM course_marks m JOIN courses c ON c.id = m.course_id
      WHERE m.student_id = ? AND m.status = 'approved' ORDER BY m.semester, c.code`).all(studentId)
      .map((r) => ({ ...r, ...gradeOf(r.total, scale) }));
    const latest = new Map(); rows.forEach((r) => latest.set(r.course_id, r));
    rows.forEach((r) => { r.superseded = latest.get(r.course_id) !== r; });
    const bySem = new Map(); rows.forEach((r) => { if (!bySem.has(r.semester)) bySem.set(r.semester, []); bySem.get(r.semester).push(r); });
    const semesters = [...bySem].map(([semester, courses]) => ({ semester, courses, credits: courses.reduce((a, r) => a + r.credits, 0), gpa: weighted(courses) }));
    const counted = [...latest.values()], cgpa = weighted(counted);
    return {
      semesters, cgpa, standing: standing(cgpa),
      credits_attempted: counted.reduce((a, r) => a + r.credits, 0),
      credits_earned: counted.filter((r) => r.points > 0).reduce((a, r) => a + r.credits, 0)
    };
  }
  const guard = (res, fn) => {
    try { return fn(); } catch (e) {
      if (String(e.code || '').startsWith('SQLITE_CONSTRAINT') || /UNIQUE/.test(String(e.message))) return bad(res, 'That name or code already exists', 409);
      throw e;
    }
  };
  const admins = () => db.prepare("SELECT id FROM users WHERE role='admin' AND status='active'").all();

  // ------------------------------------------------------------ faculties & departments (admin)
  app.get('/api/admin/faculties', auth('admin'), wrap((req, res) => {
    const deps = db.prepare('SELECT d.*, (SELECT COUNT(*) FROM courses c WHERE c.department_id = d.id) courses FROM departments d ORDER BY d.name').all();
    const cnt = (role, f) => db.prepare('SELECT COUNT(*) c FROM users WHERE role=? AND lower(faculty)=lower(?)').get(role, f).c;
    res.json(db.prepare('SELECT * FROM faculties ORDER BY name').all().map((f) => ({
      ...f, students: cnt('student', f.name), lecturers: cnt('lecturer', f.name), departments: deps.filter((d) => d.faculty_id === f.id).map((d) => ({ ...d }))
    })));
  }));
  app.post('/api/admin/faculties', auth('admin'), wrap((req, res) => {
    const name = text((req.body || {}).name);
    if (name.length < 2) return bad(res, 'Enter a faculty name');
    guard(res, () => {
      const id = db.prepare('INSERT INTO faculties (name) VALUES (?)').run(name).lastInsertRowid;
      audit(req.user, 'faculty.created', { type: 'faculty', id: Number(id), comments: name });
      res.json({ ok: true });
    });
  }));
  app.put('/api/admin/faculties/:id', auth('admin'), wrap((req, res) => {
    const f = db.prepare('SELECT * FROM faculties WHERE id=?').get(req.params.id);
    const name = text((req.body || {}).name);
    if (!f) return bad(res, 'Faculty not found', 404);
    if (name.length < 2) return bad(res, 'Enter a faculty name');
    guard(res, () => {
      db.transaction(() => {
        db.prepare('UPDATE faculties SET name=? WHERE id=?').run(name, f.id);
        db.prepare('UPDATE users SET faculty=? WHERE lower(faculty)=lower(?)').run(name, f.name);   // keep accounts pointing at the renamed faculty
      })();
      audit(req.user, 'faculty.renamed', { type: 'faculty', id: f.id, comments: `${f.name} -> ${name}` });
      res.json({ ok: true });
    });
  }));
  app.delete('/api/admin/faculties/:id', auth('admin'), wrap((req, res) => {
    const f = db.prepare('SELECT * FROM faculties WHERE id=?').get(req.params.id);
    if (!f) return bad(res, 'Faculty not found', 404);
    if (db.prepare('SELECT 1 FROM departments WHERE faculty_id=?').get(f.id)) return bad(res, 'Remove its departments first', 409);
    if (db.prepare('SELECT 1 FROM users WHERE lower(faculty)=lower(?)').get(f.name)) return bad(res, 'Accounts still belong to this faculty, so it cannot be deleted', 409);
    db.prepare('DELETE FROM faculties WHERE id=?').run(f.id);
    audit(req.user, 'faculty.deleted', { type: 'faculty', id: f.id, comments: f.name });
    res.json({ ok: true });
  }));
  app.post('/api/admin/departments', auth('admin'), wrap((req, res) => {
    const b = req.body || {}, name = text(b.name);
    if (!db.prepare('SELECT 1 FROM faculties WHERE id=?').get(b.faculty_id)) return bad(res, 'Choose a faculty');
    if (name.length < 2) return bad(res, 'Enter a department name');
    guard(res, () => {
      const id = db.prepare('INSERT INTO departments (faculty_id,name) VALUES (?,?)').run(b.faculty_id, name).lastInsertRowid;
      audit(req.user, 'department.created', { type: 'department', id: Number(id), comments: name });
      res.json({ ok: true });
    });
  }));
  app.put('/api/admin/departments/:id', auth('admin'), wrap((req, res) => {
    const d = db.prepare('SELECT * FROM departments WHERE id=?').get(req.params.id), name = text((req.body || {}).name);
    if (!d) return bad(res, 'Department not found', 404);
    if (name.length < 2) return bad(res, 'Enter a department name');
    guard(res, () => {
      db.prepare('UPDATE departments SET name=? WHERE id=?').run(name, d.id);
      audit(req.user, 'department.renamed', { type: 'department', id: d.id, comments: `${d.name} -> ${name}` });
      res.json({ ok: true });
    });
  }));
  app.delete('/api/admin/departments/:id', auth('admin'), wrap((req, res) => {
    const d = db.prepare('SELECT * FROM departments WHERE id=?').get(req.params.id);
    if (!d) return bad(res, 'Department not found', 404);
    if (db.prepare('SELECT 1 FROM courses WHERE department_id=?').get(d.id)) return bad(res, 'Courses still belong to this department', 409);
    db.prepare('DELETE FROM departments WHERE id=?').run(d.id);
    audit(req.user, 'department.deleted', { type: 'department', id: d.id, comments: d.name });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------ courses
  app.get('/api/courses', auth('lecturer', 'admin'), wrap((req, res) => {
    const mine = req.user.role === 'lecturer';
    res.json(db.prepare(`SELECT c.*, u.full_name lecturer_name, d.name department_name,
        (SELECT COUNT(*) FROM course_marks m WHERE m.course_id = c.id) marks_count
      FROM courses c LEFT JOIN users u ON u.id = c.lecturer_id LEFT JOIN departments d ON d.id = c.department_id
      ${mine ? 'WHERE c.lecturer_id = ?' : ''} ORDER BY c.code`).all(...(mine ? [req.user.id] : [])).map((r) => ({ ...r })));
  }));
  const courseBody = (b, res) => {
    const code = text(b.code, 20).toUpperCase(), title = text(b.title, 120), credits = Number(b.credits);
    if (!code || !title) return bad(res, 'Enter the course code and title');
    if (!(credits >= 0.5 && credits <= 12)) return bad(res, 'Credit hours must be between 0.5 and 12');
    if (b.lecturer_id && !db.prepare("SELECT 1 FROM users WHERE id=? AND role='lecturer'").get(b.lecturer_id)) return bad(res, 'Choose a valid lecturer');
    if (b.department_id && !db.prepare('SELECT 1 FROM departments WHERE id=?').get(b.department_id)) return bad(res, 'Choose a valid department');
    return { code, title, credits, lecturer_id: b.lecturer_id || null, department_id: b.department_id || null };
  };
  app.post('/api/admin/courses', auth('admin'), wrap((req, res) => {
    const c = courseBody(req.body || {}, res); if (!c) return;
    guard(res, () => {
      const id = db.prepare('INSERT INTO courses (code,title,credits,department_id,lecturer_id) VALUES (?,?,?,?,?)').run(c.code, c.title, c.credits, c.department_id, c.lecturer_id).lastInsertRowid;
      audit(req.user, 'course.created', { type: 'course', id: Number(id), comments: `${c.code} ${c.title}` });
      if (c.lecturer_id) notify(c.lecturer_id, 'Course assigned', `You can now enter marks for ${c.code} ${c.title}.`, '/lecturer/marks', 'results');
      res.json({ ok: true });
    });
  }));
  app.put('/api/admin/courses/:id', auth('admin'), wrap((req, res) => {
    const cur = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
    if (!cur) return bad(res, 'Course not found', 404);
    const c = courseBody({ ...cur, ...(req.body || {}) }, res); if (!c) return;
    if (c.credits !== cur.credits && db.prepare('SELECT 1 FROM course_marks WHERE course_id=?').get(cur.id)) return bad(res, 'Credit hours cannot change once marks exist', 409);
    guard(res, () => {
      db.prepare('UPDATE courses SET code=?, title=?, credits=?, department_id=?, lecturer_id=? WHERE id=?').run(c.code, c.title, c.credits, c.department_id, c.lecturer_id, cur.id);
      audit(req.user, 'course.updated', { type: 'course', id: cur.id, comments: c.code });
      res.json({ ok: true });
    });
  }));
  app.delete('/api/admin/courses/:id', auth('admin'), wrap((req, res) => {
    const c = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
    if (!c) return bad(res, 'Course not found', 404);
    if (db.prepare('SELECT 1 FROM course_marks WHERE course_id=?').get(c.id)) return bad(res, 'This course has marks and cannot be deleted', 409);
    db.prepare('DELETE FROM courses WHERE id=?').run(c.id);
    audit(req.user, 'course.deleted', { type: 'course', id: c.id, comments: c.code });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------ marks (lecturer enters, Registrar approves)
  const ownCourse = (req, res) => {
    const c = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
    if (!c) { bad(res, 'Course not found', 404); return null; }
    if (req.user.role === 'lecturer' && c.lecturer_id !== req.user.id) { bad(res, 'You are not assigned to this course', 403); return null; }
    return { ...c };
  };
  app.get('/api/grade-scale', auth(), wrap((req, res) => res.json(getScale())));

  app.get('/api/courses/:id/marks', auth('lecturer', 'admin'), wrap((req, res) => {
    const course = ownCourse(req, res); if (!course) return;
    const semester = String(req.query.semester || '');
    if (!SEM_RE.test(semester)) return bad(res, 'Semester must look like 2026-S1');
    const scale = getScale();
    const students = db.prepare(`SELECT u.id, u.full_name, u.university_id, u.programme, m.coursework, m.exam, m.total, m.status, m.return_comment
      FROM users u LEFT JOIN course_marks m ON m.student_id = u.id AND m.course_id = ? AND m.semester = ?
      WHERE u.role = 'student' AND u.status = 'active' ORDER BY u.full_name`).all(course.id, semester)
      .map((r) => ({ ...r, grade: r.total === null || r.total === undefined ? null : gradeOf(r.total, scale).grade }));
    res.json({ course, semester, students });
  }));

  app.put('/api/courses/:id/marks', auth('lecturer'), wrap((req, res) => {
    const course = ownCourse(req, res); if (!course) return;
    const { semester, rows, submit } = req.body || {};
    if (!SEM_RE.test(String(semester || ''))) return bad(res, 'Semester must look like 2026-S1');
    if (!Array.isArray(rows) || !rows.length || rows.length > 1000) return bad(res, 'No marks were sent');
    const clean = [];
    for (const r of rows) {
      const s = db.prepare("SELECT full_name FROM users WHERE id=? AND role='student' AND status='active'").get(r.student_id);
      const cw = numOrNull(r.coursework), ex = numOrNull(r.exam);
      if (!s || (cw === null && ex === null)) continue;
      if ([cw, ex].some((v) => v !== null && (!Number.isFinite(v) || v < 0 || v > 100))) return bad(res, `Marks for ${s.full_name} must be between 0 and 100`);
      if (cw !== null && ex !== null && cw + ex > 100) return bad(res, `Coursework + exam for ${s.full_name} is more than 100`);
      if (submit && (cw === null || ex === null)) return bad(res, `Enter both coursework and exam for ${s.full_name} before submitting`);
      clean.push({ id: Number(r.student_id), cw, ex, total: cw !== null && ex !== null ? round2(cw + ex) : null });
    }
    if (!clean.length) return bad(res, 'Enter at least one mark');
    const status = submit ? 'submitted' : 'draft';
    const isLocked = db.prepare("SELECT 1 FROM course_marks WHERE student_id=? AND course_id=? AND semester=? AND status='approved'");
    const upsert = db.prepare(`INSERT INTO course_marks (student_id,course_id,semester,coursework,exam,total,status,entered_by,updated_at)
      VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(student_id,course_id,semester) DO UPDATE SET coursework=excluded.coursework, exam=excluded.exam, total=excluded.total,
        status=excluded.status, return_comment=NULL, entered_by=excluded.entered_by, updated_at=CURRENT_TIMESTAMP
      WHERE course_marks.status != 'approved'`);
    let saved = 0, locked = 0;
    db.transaction(() => clean.forEach((r) => {
      if (isLocked.get(r.id, course.id, semester)) { locked++; return; }
      upsert.run(r.id, course.id, semester, r.cw, r.ex, r.total, status, req.user.id); saved++;
    }))();
    audit(req.user, submit ? 'marks.submitted' : 'marks.saved', { type: 'course', id: course.id, comments: `${course.code} ${semester}: ${saved} students` });
    if (submit && saved) admins().forEach((a) => notify(a.id, 'Results awaiting approval', `${req.user.full_name} submitted ${course.code} (${semester}) marks.`, '/admin/results', 'results'));
    res.json({ ok: true, saved, locked, submitted: !!submit });
  }));

  // ------------------------------------------------------------ Registrar approval + reports (admin)
  app.get('/api/admin/results/batches', auth('admin'), wrap((req, res) => {
    res.json(db.prepare(`SELECT m.course_id, m.semester, c.code, c.title, u.full_name lecturer_name, COUNT(*) students, MAX(m.updated_at) submitted_at
      FROM course_marks m JOIN courses c ON c.id = m.course_id LEFT JOIN users u ON u.id = c.lecturer_id
      WHERE m.status = 'submitted' GROUP BY m.course_id, m.semester ORDER BY submitted_at`).all().map((r) => ({ ...r })));
  }));
  app.get('/api/admin/results/batch', auth('admin'), wrap((req, res) => {
    const scale = getScale();
    const rows = db.prepare(`SELECT u.full_name, u.university_id, m.coursework, m.exam, m.total, m.status FROM course_marks m JOIN users u ON u.id = m.student_id
      WHERE m.course_id = ? AND m.semester = ? AND m.status = 'submitted' ORDER BY u.full_name`).all(req.query.course_id, req.query.semester)
      .map((r) => ({ ...r, grade: gradeOf(r.total, scale).grade }));
    res.json(rows);
  }));
  const batchArgs = (req, res) => {
    const { course_id, semester } = req.body || {};
    const course = db.prepare('SELECT * FROM courses WHERE id=?').get(course_id);
    if (!course || !SEM_RE.test(String(semester || ''))) { bad(res, 'Choose a course and semester'); return null; }
    return { course, semester };
  };
  app.post('/api/admin/results/approve', auth('admin'), wrap((req, res) => {
    const a = batchArgs(req, res); if (!a) return;
    const rows = db.prepare("SELECT student_id FROM course_marks WHERE course_id=? AND semester=? AND status='submitted'").all(a.course.id, a.semester);
    if (!rows.length) return bad(res, 'Nothing is waiting for approval for that course', 409);
    db.transaction(() => db.prepare("UPDATE course_marks SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, return_comment=NULL WHERE course_id=? AND semester=? AND status='submitted'")
      .run(req.user.id, a.course.id, a.semester))();
    rows.forEach((r) => notify(r.student_id, 'Results published', `${a.course.code} ${a.course.title} (${a.semester}) results are now on your account.`, '/student/results', 'results'));
    if (a.course.lecturer_id) notify(a.course.lecturer_id, 'Results approved', `${a.course.code} (${a.semester}) was approved by the Registrar.`, '/lecturer/marks', 'results');
    audit(req.user, 'results.approved', { type: 'course', id: a.course.id, decision: 'approved', comments: `${a.course.code} ${a.semester}: ${rows.length} students` });
    res.json({ ok: true, approved: rows.length });
  }));
  app.post('/api/admin/results/return', auth('admin'), wrap((req, res) => {
    const a = batchArgs(req, res); if (!a) return;
    const comment = text((req.body || {}).comment, 500);
    if (!comment) return bad(res, 'Tell the lecturer what to correct');
    const n = db.prepare("UPDATE course_marks SET status='returned', return_comment=? WHERE course_id=? AND semester=? AND status='submitted'").run(comment, a.course.id, a.semester).changes;
    if (!n) return bad(res, 'Nothing is waiting for approval for that course', 409);
    if (a.course.lecturer_id) notify(a.course.lecturer_id, 'Results returned for correction', `${a.course.code} (${a.semester}): ${comment}`, '/lecturer/marks', 'results');
    audit(req.user, 'results.returned', { type: 'course', id: a.course.id, decision: 'returned', comments: comment });
    res.json({ ok: true });
  }));

  app.get('/api/admin/gpa-report', auth('admin'), wrap((req, res) => {
    const ids = db.prepare(`SELECT DISTINCT u.id FROM users u JOIN course_marks m ON m.student_id = u.id WHERE u.role='student' AND m.status='approved'`).all();
    const list = ids.map(({ id }) => {
      const u = db.prepare('SELECT id, full_name, university_id, faculty, programme FROM users WHERE id=?').get(id), t = transcript(id);
      return { ...u, cgpa: t.cgpa, credits_earned: t.credits_earned, standing: t.standing };
    }).sort((a, b) => (b.cgpa ?? -1) - (a.cgpa ?? -1));
    const vals = list.filter((s) => s.cgpa !== null);
    res.json({ students: list, summary: { students: list.length, avg_cgpa: vals.length ? round2(vals.reduce((a, s) => a + s.cgpa, 0) / vals.length) : null } });
  }));
  app.get('/api/admin/students/:id/transcript', auth('admin'), wrap((req, res) => {
    const s = db.prepare("SELECT id, full_name, university_id, faculty, programme, year_of_study FROM users WHERE id=? AND role='student'").get(req.params.id);
    if (!s) return bad(res, 'Student not found', 404);
    res.json({ student: { ...s }, ...transcript(s.id) });
  }));
  app.put('/api/admin/grade-scale', auth('admin'), wrap((req, res) => {
    const rows = (req.body || {}).rows;
    if (!Array.isArray(rows) || rows.length < 2 || rows.length > 12) return bad(res, 'Enter between 2 and 12 grades');
    const clean = rows.map((r) => ({ grade: text(r.grade, 4).toUpperCase(), min: Number(r.min_mark), pts: Number(r.points) }));
    if (clean.some((r) => !r.grade || !Number.isFinite(r.min) || r.min < 0 || r.min > 100 || !Number.isFinite(r.pts) || r.pts < 0 || r.pts > 5)) return bad(res, 'Each grade needs a name, a minimum mark (0-100) and points (0-5)');
    if (new Set(clean.map((r) => r.grade)).size !== clean.length) return bad(res, 'Grade names must be different');
    if (!clean.some((r) => r.min === 0)) return bad(res, 'One grade must start at 0 so every mark gets a grade');
    db.transaction(() => {
      db.prepare('DELETE FROM grade_scale').run();
      const ins = db.prepare('INSERT INTO grade_scale (grade,min_mark,points) VALUES (?,?,?)');
      clean.forEach((r) => ins.run(r.grade, r.min, r.pts));
    })();
    audit(req.user, 'grade_scale.updated', { type: 'grade_scale', comments: clean.map((r) => `${r.grade}>=${r.min}:${r.pts}`).join(' ') });
    res.json({ ok: true });
  }));
  app.get('/api/me/results', auth('student'), wrap((req, res) => res.json(transcript(req.user.id))));

  // ------------------------------------------------------------ optional demo data (fresh database only)
  seedDemo();
  function seedDemo() {
    const pw = process.env.DEMO_PASSWORD;
    if (!pw) return;
    if (db.prepare("SELECT 1 FROM users WHERE role IN ('student','lecturer') LIMIT 1").get()) return;   // real data exists: never touch it
    const hash = bcrypt.hashSync(pw, 10);
    db.transaction(() => {
      const fac = db.prepare('INSERT INTO faculties (name) VALUES (?)'), dep = db.prepare('INSERT INTO departments (faculty_id,name) VALUES (?,?)');
      const eng = Number(fac.run('College of Engineering').lastInsertRowid), bus = Number(fac.run('College of Business').lastInsertRowid);
      const dSE = Number(dep.run(eng, 'Software Engineering').lastInsertRowid);
      const dCS = Number(dep.run(eng, 'Computer Science').lastInsertRowid);
      dep.run(eng, 'Information Systems'); dep.run(bus, 'Accounting'); dep.run(bus, 'Management');

      const addU = db.prepare(`INSERT INTO users (role,full_name,university_id,email,password_hash,status,faculty,programme,year_of_study,specialisation) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const prof = db.prepare('INSERT OR IGNORE INTO profiles (user_id, headline, about, skills, location) VALUES (?,?,?,?,?)');
      const sett = db.prepare('INSERT OR IGNORE INTO settings (user_id) VALUES (?)');
      const mk = (role, name, uid, email, status, programme, year, spec, headline) => {
        const id = Number(addU.run(role, name, uid, email, hash, status, 'College of Engineering', programme, year, spec).lastInsertRowid);
        prof.run(id, headline, '', '[]', 'Mutare, Zimbabwe'); sett.run(id); return id;
      };
      const dube = mk('lecturer', 'Dr. Mercy Dube', 'AU-STAFF-0042', 'mdube@africau.edu', 'active', null, null, 'Software architecture and distributed systems', 'Senior Lecturer, Software Engineering');
      const ncube = mk('lecturer', 'Prof. J. Ncube', 'AU-STAFF-0033', 'jncube@africau.edu', 'active', null, null, 'Databases and information systems', 'Professor, Information Systems');
      const ian = mk('student', 'Ian Edson Mwashanja', 'AU-SE-2025-0142', 'ian@student.africau.edu', 'active', 'Software Engineering', 'Year 3', null, 'Software Engineering student');
      const chipo = mk('student', 'Chipo Moyo', 'AU-SE-2025-0151', 'chipo@student.africau.edu', 'active', 'Software Engineering', 'Year 3', null, 'Software Engineering student');
      const taku = mk('student', 'Takudzwa Ncube', 'AU-CS-2025-0117', 'taku@student.africau.edu', 'active', 'Computer Science', 'Year 3', null, 'Computer Science student');
      const rudo = mk('student', 'Rudo Chikwanha', 'AU-CS-2025-0123', 'rudo@student.africau.edu', 'active', 'Computer Science', 'Year 2', null, 'Computer Science student');
      mk('student', 'Tariro Tekwa', 'AU-CS-2025-0108', 'tariro@student.africau.edu', 'pending', 'Computer Science', 'Year 3', null, 'Computer Science student');   // shows up in Account approvals

      const asg = db.prepare('INSERT INTO lecturer_assignments (student_id, lecturer_id, is_primary) VALUES (?,?,?)');
      [[ian, dube, 1], [ian, ncube, 0], [chipo, dube, 1], [taku, ncube, 1], [rudo, ncube, 1]].forEach((r) => asg.run(...r));
      db.prepare('UPDATE profiles SET skills=?, about=? WHERE user_id=?').run(JSON.stringify(['HTML', 'CSS', 'JavaScript', 'C#', 'SQL', 'Git/GitHub']), 'I build practical web and mobile systems and enjoy learning in teams.', ian);

      const ach = db.prepare(`INSERT INTO achievements (user_id,title,category,description,year,organisation,date_obtained,status,lecturer_id,reviewed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
      const a1 = Number(ach.run(ian, 'Coding Club Coordinator', 'Leadership position', 'Organised weekly peer-learning sessions.', '2025', 'Africa University Coding Club', '2025-02-01', 'verified', dube, new Date().toISOString()).lastInsertRowid);
      ach.run(ian, "Dean's List", 'Academic award', 'Recognised for strong academic performance.', '2025', 'Africa University', '2025-06-30', 'pending_verification', dube, null);
      ach.run(chipo, 'Hackathon Finalist', 'Hackathon achievement', 'Top 5 in the university hackathon.', '2026', 'Africa University', '2026-05-12', 'pending_verification', dube, null);
      db.prepare('INSERT INTO achievement_verifications (achievement_id,lecturer_id,student_id,action,decision,comments) VALUES (?,?,?,?,?,?)').run(a1, dube, ian, 'verify', 'verified', 'Confirmed with the club register.');

      const rec = db.prepare('INSERT INTO recommendations (student_id,lecturer_id,purpose,deadline,message,status,letter,completed_at) VALUES (?,?,?,?,?,?,?,?)');
      rec.run(ian, dube, 'Internship', '2026-12-18', 'Applying for a software internship.', 'completed',
        'I am pleased to recommend Ian Edson Mwashanja, a Software Engineering student at Africa University. Ian has consistently shown initiative, strong technical ability and a willingness to support his peers.', new Date().toISOString());
      rec.run(ian, ncube, 'Postgraduate Studies', '2027-01-20', 'Please highlight my database coursework.', 'pending', null, null);
      rec.run(chipo, dube, 'Scholarship', '2026-12-05', 'Applying for a national ICT scholarship.', 'pending', null, null);

      const course = db.prepare('INSERT INTO courses (code,title,credits,department_id,lecturer_id) VALUES (?,?,?,?,?)');
      const sa = Number(course.run('SEN301', 'Software Architecture', 3, dSE, dube).lastInsertRowid);
      const wt = Number(course.run('SEN305', 'Web Technologies', 3, dSE, dube).lastInsertRowid);
      const db1 = Number(course.run('CSC302', 'Database Systems', 4, dCS, ncube).lastInsertRowid);
      const dm = Number(course.run('CSC205', 'Discrete Mathematics', 3, dCS, ncube).lastInsertRowid);
      const os = Number(course.run('CSC310', 'Operating Systems', 4, dCS, ncube).lastInsertRowid);

      const mark = db.prepare(`INSERT INTO course_marks (student_id,course_id,semester,coursework,exam,total,status,entered_by,approved_by,approved_at) VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
      const adm = (db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() || {}).id || null;
      // [student, course, semester, coursework, exam]  (approved history)
      [[ian, dm, '2025-S1', 32, 51], [ian, sa, '2025-S2', 34, 49], [ian, db1, '2025-S2', 30, 46], [ian, wt, '2026-S1', 36, 55],
       [chipo, dm, '2025-S1', 28, 40], [chipo, sa, '2025-S2', 26, 38], [chipo, wt, '2026-S1', 31, 44],
       [taku, dm, '2025-S1', 24, 30], [taku, db1, '2025-S2', 27, 41], [rudo, dm, '2025-S1', 35, 52], [rudo, db1, '2025-S2', 33, 47]]
        .forEach(([s, c, sem, cw, ex]) => mark.run(s, c, sem, cw, ex, cw + ex, 'approved', null, adm));
      // One batch waiting for the Registrar, so approval can be shown live.
      const sub = db.prepare(`INSERT INTO course_marks (student_id,course_id,semester,coursework,exam,total,status,entered_by) VALUES (?,?,?,?,?,?,?,?)`);
      [[ian, os, 35, 52], [chipo, os, 29, 41], [taku, os, 25, 36], [rudo, os, 34, 50]].forEach(([s, c, cw, ex]) => sub.run(s, c, '2026-S2', cw, ex, cw + ex, 'submitted', ncube));

      const note = db.prepare('INSERT INTO notifications (user_id,title,body,is_read,type) VALUES (?,?,?,0,?)');
      note.run(ian, 'Recommendation letter ready', 'Dr. Mercy Dube completed your academic recommendation.', 'recommendation');
      note.run(dube, 'New recommendation request', 'Ian Edson Mwashanja requested a letter.', 'recommendation');
      if (adm) note.run(adm, 'Results awaiting approval', 'Prof. J. Ncube submitted CSC310 (2026-S2) marks.', 'results');
    })();
    console.log('Loaded demo data (DEMO_PASSWORD is the password for every demo account).');
  }
};
module.exports.SEM_RE = SEM_RE;
