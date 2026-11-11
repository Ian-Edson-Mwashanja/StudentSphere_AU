 // StudentSphere academic module - PostgreSQL version.
 // Uses existing PostgreSQL tables. Does not create demo accounts or delete records.

const SEM_RE = /^\d{4}-S[1-3]$/;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const numOrNull = (v) => v === '' || v === null || v === undefined ? null : Number(v);
const text = (v, max = 80) => String(v || '').trim().slice(0, max);

module.exports = function mountAcademics(app, { db, auth, wrap, bad, audit, notify }) {
  const query = (sql, params = []) => db.query(sql, params);
  const transaction = (fn) => db.transaction(fn);

  const recordAudit = (actor, action, details = {}) =>
    audit(actor, action, details);

  const sendNotification = (id, title, body, link, type) =>
    notify(id, title, body, link, type);

  const getScale = async () => {
    let result = await query(
      'SELECT grade, min_mark, points FROM grade_scale ORDER BY min_mark DESC'
    );

    // This is a starter grading configuration, not demo student data.
    if (!result.rowCount) {
      await query(`
        INSERT INTO grade_scale (grade, min_mark, points)
        VALUES ('A',80,4),('B',70,3),('C',60,2),('D',50,1),('F',0,0)
        ON CONFLICT (grade) DO NOTHING
      `);

      result = await query(
        'SELECT grade, min_mark, points FROM grade_scale ORDER BY min_mark DESC'
      );
    }

    return result.rows.map(r => ({
      ...r,
      min_mark: Number(r.min_mark),
      points: Number(r.points)
    }));
  };

  const gradeOf = (total, scale) => {
    if (total === null || total === undefined) {
      return { grade: '—', points: 0 };
    }

    const mark = Number(total);
    const grade = scale.find(r => mark >= r.min_mark) || scale[scale.length - 1];

    return grade
      ? { grade: grade.grade, points: Number(grade.points) }
      : { grade: '—', points: 0 };
  };

  const weighted = list => {
    const credits = list.reduce((sum, r) => sum + Number(r.credits || 0), 0);

    return credits
      ? round2(list.reduce(
          (sum, r) => sum + Number(r.points) * Number(r.credits),
          0
        ) / credits)
      : null;
  };

  const standing = cgpa =>
    cgpa === null ? '—'
      : cgpa >= 3.5 ? "Dean's list"
      : cgpa >= 2 ? 'Good standing'
      : 'Academic warning';

  const semesterOrder = value => {
    const match = /^(\d{4})-S([1-3])$/.exec(value || '');
    return match ? Number(match[1]) * 10 + Number(match[2]) : 0;
  };

  const transcript = async studentId => {
    const scale = await getScale();

    const result = await query(`
      SELECT m.course_id, m.semester, m.coursework, m.exam, m.total,
             c.code, c.title, c.credits
      FROM course_marks m
      JOIN courses c ON c.id = m.course_id
      WHERE m.student_id = $1 AND m.status = 'approved'
    `, [studentId]);

    const rows = result.rows.map(r => ({
      ...r,
      coursework: r.coursework === null ? null : Number(r.coursework),
      exam: r.exam === null ? null : Number(r.exam),
      total: r.total === null ? null : Number(r.total),
      credits: Number(r.credits),
      ...gradeOf(r.total === null ? null : Number(r.total), scale)
    }));

    rows.sort((a, b) =>
      semesterOrder(a.semester) - semesterOrder(b.semester) ||
      a.code.localeCompare(b.code)
    );

    const latest = new Map();

    rows.forEach(row => latest.set(Number(row.course_id), row));

    rows.forEach(row => {
      row.superseded = latest.get(Number(row.course_id)) !== row;
    });

    const bySemester = new Map();

    rows.forEach(row => {
      if (!bySemester.has(row.semester)) bySemester.set(row.semester, []);
      bySemester.get(row.semester).push(row);
    });

    const semesters = [...bySemester.entries()]
      .sort((a, b) => semesterOrder(a[0]) - semesterOrder(b[0]))
      .map(([semester, courses]) => ({
        semester,
        courses,
        credits: courses.reduce((sum, r) => sum + r.credits, 0),
        gpa: weighted(courses)
      }));

    const counted = [...latest.values()];
    const cgpa = weighted(counted);

    return {
      semesters,
      cgpa,
      standing: standing(cgpa),
      credits_attempted: counted.reduce((sum, r) => sum + r.credits, 0),
      credits_earned: counted
        .filter(r => r.points > 0)
        .reduce((sum, r) => sum + r.credits, 0)
    };
  };

  const guard = async (res, fn) => {
    try {
      return await fn();
    } catch (error) {
      if (['23505', '23503', '23514'].includes(String(error.code))) {
        return bad(res, 'That name, code or relationship is invalid or already exists', 409);
      }
      throw error;
    }
  };

  const admins = async () => {
    const result = await query(
      "SELECT id FROM users WHERE role='admin' AND status='active'"
    );
    return result.rows;
  };

  // ---------------------------------------------------------
  // FACULTIES AND DEPARTMENTS
  // ---------------------------------------------------------

  app.get('/api/admin/faculties', auth('admin'), wrap(async (req, res) => {
    const [faculties, departments] = await Promise.all([
      query('SELECT * FROM faculties ORDER BY name'),
      query(`
        SELECT d.*,
          (SELECT COUNT(*)::int FROM courses c WHERE c.department_id=d.id) AS courses
        FROM departments d ORDER BY d.name
      `)
    ]);

    const output = [];

    for (const faculty of faculties.rows) {
      const [students, lecturers] = await Promise.all([
        query(
          "SELECT COUNT(*)::int AS count FROM users WHERE role='student' AND lower(faculty)=lower($1)",
          [faculty.name]
        ),
        query(
          "SELECT COUNT(*)::int AS count FROM users WHERE role='lecturer' AND lower(faculty)=lower($1)",
          [faculty.name]
        )
      ]);

      output.push({
        ...faculty,
        students: Number(students.rows[0].count),
        lecturers: Number(lecturers.rows[0].count),
        departments: departments.rows
          .filter(d => Number(d.faculty_id) === Number(faculty.id))
      });
    }

    res.json(output);
  }));

  app.post('/api/admin/faculties', auth('admin'), wrap(async (req, res) => {
    const name = text((req.body || {}).name);

    if (name.length < 2) return bad(res, 'Enter a faculty name');

    await guard(res, async () => {
      const result = await query(
        'INSERT INTO faculties (name) VALUES ($1) RETURNING id',
        [name]
      );

      await recordAudit(req.user, 'faculty.created', {
        type: 'faculty', id: result.rows[0].id, comments: name
      });

      res.json({ ok: true });
    });
  }));

  app.put('/api/admin/faculties/:id', auth('admin'), wrap(async (req, res) => {
    const current = await query(
      'SELECT * FROM faculties WHERE id=$1',
      [req.params.id]
    );
    const name = text((req.body || {}).name);

    if (!current.rowCount) return bad(res, 'Faculty not found', 404);
    if (name.length < 2) return bad(res, 'Enter a faculty name');

    await guard(res, async () => {
      const faculty = current.rows[0];

      await transaction(async client => {
        await client.query(
          'UPDATE faculties SET name=$1 WHERE id=$2',
          [name, faculty.id]
        );
        await client.query(
          'UPDATE users SET faculty=$1 WHERE lower(faculty)=lower($2)',
          [name, faculty.name]
        );
      });

      await recordAudit(req.user, 'faculty.renamed', {
        type: 'faculty',
        id: faculty.id,
        comments: `${faculty.name} -> ${name}`
      });

      res.json({ ok: true });
    });
  }));

  app.delete('/api/admin/faculties/:id', auth('admin'), wrap(async (req, res) => {
    const result = await query(
      'SELECT * FROM faculties WHERE id=$1',
      [req.params.id]
    );

    if (!result.rowCount) return bad(res, 'Faculty not found', 404);

    const faculty = result.rows[0];

    const [departments, users] = await Promise.all([
      query('SELECT 1 FROM departments WHERE faculty_id=$1 LIMIT 1', [faculty.id]),
      query('SELECT 1 FROM users WHERE lower(faculty)=lower($1) LIMIT 1', [faculty.name])
    ]);

    if (departments.rowCount) return bad(res, 'Remove its departments first', 409);
    if (users.rowCount) return bad(res, 'Accounts still belong to this faculty, so it cannot be deleted', 409);

    await query('DELETE FROM faculties WHERE id=$1', [faculty.id]);

    await recordAudit(req.user, 'faculty.deleted', {
      type: 'faculty', id: faculty.id, comments: faculty.name
    });

    res.json({ ok: true });
  }));

  app.post('/api/admin/departments', auth('admin'), wrap(async (req, res) => {
    const body = req.body || {};
    const name = text(body.name);
    const facultyId = Number(body.faculty_id);

    if (!Number.isInteger(facultyId) || facultyId <= 0) {
      return bad(res, 'Choose a faculty');
    }

    if (name.length < 2) return bad(res, 'Enter a department name');

    const faculty = await query(
      'SELECT id FROM faculties WHERE id=$1',
      [facultyId]
    );

    if (!faculty.rowCount) return bad(res, 'Choose a valid faculty');

    await guard(res, async () => {
      const result = await query(
        'INSERT INTO departments (faculty_id,name) VALUES ($1,$2) RETURNING id',
        [facultyId, name]
      );

      await recordAudit(req.user, 'department.created', {
        type: 'department', id: result.rows[0].id, comments: name
      });

      res.json({ ok: true });
    });
  }));

  app.put('/api/admin/departments/:id', auth('admin'), wrap(async (req, res) => {
    const current = await query(
      'SELECT * FROM departments WHERE id=$1',
      [req.params.id]
    );
    const name = text((req.body || {}).name);

    if (!current.rowCount) return bad(res, 'Department not found', 404);
    if (name.length < 2) return bad(res, 'Enter a department name');

    const department = current.rows[0];

    await guard(res, async () => {
      await query('UPDATE departments SET name=$1 WHERE id=$2', [
        name, department.id
      ]);

      await recordAudit(req.user, 'department.renamed', {
        type: 'department',
        id: department.id,
        comments: `${department.name} -> ${name}`
      });

      res.json({ ok: true });
    });
  }));

  app.delete('/api/admin/departments/:id', auth('admin'), wrap(async (req, res) => {
    const result = await query(
      'SELECT * FROM departments WHERE id=$1',
      [req.params.id]
    );

    if (!result.rowCount) return bad(res, 'Department not found', 404);

    const department = result.rows[0];
    const courses = await query(
      'SELECT 1 FROM courses WHERE department_id=$1 LIMIT 1',
      [department.id]
    );

    if (courses.rowCount) {
      return bad(res, 'Courses still belong to this department', 409);
    }

    await query('DELETE FROM departments WHERE id=$1', [department.id]);

    await recordAudit(req.user, 'department.deleted', {
      type: 'department', id: department.id, comments: department.name
    });

    res.json({ ok: true });
  }));

  // ---------------------------------------------------------
  // COURSES
  // ---------------------------------------------------------

  app.get('/api/courses', auth('lecturer', 'admin'), wrap(async (req, res) => {
    const mine = req.user.role === 'lecturer';

    const result = await query(`
      SELECT c.*, u.full_name AS lecturer_name,
             d.name AS department_name,
             (SELECT COUNT(*)::int FROM course_marks m WHERE m.course_id=c.id) AS marks_count
      FROM courses c
      LEFT JOIN users u ON u.id=c.lecturer_id
      LEFT JOIN departments d ON d.id=c.department_id
      ${mine ? 'WHERE c.lecturer_id=$1' : ''}
      ORDER BY c.code
    `, mine ? [req.user.id] : []);

    res.json(result.rows.map(r => ({
      ...r,
      credits: Number(r.credits),
      marks_count: Number(r.marks_count)
    })));
  }));

  const courseBody = async body => {
    const code = text(body.code, 30).toUpperCase();
    const title = text(body.title, 150);
    const credits = numOrNull(body.credits);
    const departmentId = numOrNull(body.department_id);
    const lecturerId = numOrNull(body.lecturer_id);

    if (!code || !title) throw Object.assign(
      new Error('Enter the course code and title'), { status: 400 }
    );

    if (credits === null || !Number.isFinite(credits) || credits < 0.5 || credits > 12) {
      throw Object.assign(
        new Error('Credit hours must be between 0.5 and 12'), { status: 400 }
      );
    }

    if (departmentId !== null) {
      if (!Number.isInteger(departmentId) || departmentId <= 0) {
        throw Object.assign(new Error('Choose a valid department'), { status: 400 });
      }

      const department = await query(
        'SELECT id FROM departments WHERE id=$1', [departmentId]
      );

      if (!department.rowCount) {
        throw Object.assign(new Error('Department not found'), { status: 400 });
      }
    }

    if (lecturerId !== null) {
      if (!Number.isInteger(lecturerId) || lecturerId <= 0) {
        throw Object.assign(new Error('Choose a valid lecturer'), { status: 400 });
      }

      const lecturer = await query(
        "SELECT id FROM users WHERE id=$1 AND role='lecturer' AND status='active'",
        [lecturerId]
      );

      if (!lecturer.rowCount) {
        throw Object.assign(new Error('Active lecturer not found'), { status: 400 });
      }
    }

    return { code, title, credits, departmentId, lecturerId };
  };

  app.post('/api/admin/courses', auth('admin'), wrap(async (req, res) => {
    await guard(res, async () => {
      const c = await courseBody(req.body || {});
      const result = await query(`
        INSERT INTO courses (code,title,credits,department_id,lecturer_id)
        VALUES ($1,$2,$3,$4,$5) RETURNING id
      `, [c.code, c.title, c.credits, c.departmentId, c.lecturerId]);

      await recordAudit(req.user, 'course.created', {
        type: 'course',
        id: result.rows[0].id,
        comments: `${c.code} ${c.title}`
      });

      if (c.lecturerId) {
        await sendNotification(
          c.lecturerId,
          'Course assigned',
          `You can now enter marks for ${c.code} ${c.title}.`,
          '/lecturer/marks',
          'results'
        );
      }

      res.json({ ok: true });
    });
  }));

  app.put('/api/admin/courses/:id', auth('admin'), wrap(async (req, res) => {
    const current = await query(
      'SELECT * FROM courses WHERE id=$1',
      [req.params.id]
    );

    if (!current.rowCount) return bad(res, 'Course not found', 404);

    const old = current.rows[0];

    await guard(res, async () => {
      const c = await courseBody({ ...old, ...(req.body || {}) });

      if (Number(c.credits) !== Number(old.credits)) {
        const marks = await query(
          'SELECT 1 FROM course_marks WHERE course_id=$1 LIMIT 1',
          [old.id]
        );

        if (marks.rowCount) {
          return bad(res, 'Credit hours cannot change once marks exist', 409);
        }
      }

      await query(`
        UPDATE courses
        SET code=$1,title=$2,credits=$3,department_id=$4,lecturer_id=$5
        WHERE id=$6
      `, [c.code, c.title, c.credits, c.departmentId, c.lecturerId, old.id]);

      await recordAudit(req.user, 'course.updated', {
        type: 'course', id: old.id, comments: c.code
      });

      res.json({ ok: true });
    });
  }));

  app.delete('/api/admin/courses/:id', auth('admin'), wrap(async (req, res) => {
    const result = await query(
      'SELECT * FROM courses WHERE id=$1',
      [req.params.id]
    );

    if (!result.rowCount) return bad(res, 'Course not found', 404);

    const course = result.rows[0];
    const marks = await query(
      'SELECT 1 FROM course_marks WHERE course_id=$1 LIMIT 1',
      [course.id]
    );

    if (marks.rowCount) return bad(res, 'This course has marks and cannot be deleted', 409);

    await query('DELETE FROM courses WHERE id=$1', [course.id]);

    await recordAudit(req.user, 'course.deleted', {
      type: 'course', id: course.id, comments: course.code
    });

    res.json({ ok: true });
  }));

  // ---------------------------------------------------------
  // MARK ENTRY
  // ---------------------------------------------------------

  const ownCourse = async (req, res) => {
    const result = await query(
      'SELECT * FROM courses WHERE id=$1',
      [req.params.id]
    );

    if (!result.rowCount) {
      bad(res, 'Course not found', 404);
      return null;
    }

    const course = result.rows[0];

    if (
      req.user.role === 'lecturer' &&
      Number(course.lecturer_id) !== Number(req.user.id)
    ) {
      bad(res, 'You are not assigned to this course', 403);
      return null;
    }

    return course;
  };

  app.get('/api/grade-scale', auth(), wrap(async (req, res) => {
    res.json(await getScale());
  }));

  app.get('/api/courses/:id/marks', auth('lecturer', 'admin'), wrap(async (req, res) => {
    const course = await ownCourse(req, res);
    if (!course) return;

    const semester = String(req.query.semester || '');

    if (!SEM_RE.test(semester)) {
      return bad(res, 'Semester must look like 2026-S1');
    }

    const scale = await getScale();

    const result = await query(`
      SELECT u.id,u.full_name,u.university_id,u.programme,
             m.coursework,m.exam,m.total,m.status,m.return_comment
      FROM users u
      LEFT JOIN course_marks m
        ON m.student_id=u.id AND m.course_id=$1 AND m.semester=$2
      WHERE u.role='student' AND u.status='active'
      ORDER BY u.full_name
    `, [course.id, semester]);

    res.json({
      course,
      semester,
      students: result.rows.map(r => ({
        ...r,
        grade: r.total === null ? null : gradeOf(Number(r.total), scale).grade,
        coursework: r.coursework === null ? null : Number(r.coursework),
        exam: r.exam === null ? null : Number(r.exam),
        total: r.total === null ? null : Number(r.total)
      }))
    });
  }));

  app.put('/api/courses/:id/marks', auth('lecturer'), wrap(async (req, res) => {
    const course = await ownCourse(req, res);
    if (!course) return;

    const { semester, rows, submit } = req.body || {};

    if (!SEM_RE.test(String(semester || ''))) {
      return bad(res, 'Semester must look like 2026-S1');
    }

    if (!Array.isArray(rows) || !rows.length || rows.length > 1000) {
      return bad(res, 'No marks were sent');
    }

    const clean = [];

    for (const row of rows) {
      const studentId = Number(row.student_id);

      const student = await query(
        "SELECT id,full_name FROM users WHERE id=$1 AND role='student' AND status='active'",
        [studentId]
      );

      if (!student.rowCount) continue;

      const name = student.rows[0].full_name;
      const coursework = numOrNull(row.coursework);
      const exam = numOrNull(row.exam);

      if (coursework === null && exam === null) continue;

      if ([coursework, exam].some(v =>
        v !== null && (!Number.isFinite(v) || v < 0 || v > 100)
      )) {
        return bad(res, `Marks for ${name} must be between 0 and 100`);
      }

      if (coursework !== null && exam !== null && coursework + exam > 100) {
        return bad(res, `Coursework + exam for ${name} is more than 100`);
      }

      if (submit && (coursework === null || exam === null)) {
        return bad(res, `Enter both coursework and exam for ${name} before submitting`);
      }

      clean.push({
        id: studentId,
        coursework,
        exam,
        total: coursework !== null && exam !== null
          ? round2(coursework + exam)
          : null
      });
    }

    if (!clean.length) return bad(res, 'Enter at least one mark');

    const status = submit ? 'submitted' : 'draft';
    let saved = 0;
    let locked = 0;

    await transaction(async client => {
      for (const row of clean) {
        const existing = await client.query(`
          SELECT status FROM course_marks
          WHERE student_id=$1 AND course_id=$2 AND semester=$3
          FOR UPDATE
        `, [row.id, course.id, semester]);

        if (existing.rowCount && existing.rows[0].status === 'approved') {
          locked++;
          continue;
        }

        await client.query(`
          INSERT INTO course_marks
            (student_id,course_id,semester,coursework,exam,total,status,entered_by,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
          ON CONFLICT (student_id,course_id,semester)
          DO UPDATE SET
            coursework=EXCLUDED.coursework,
            exam=EXCLUDED.exam,
            total=EXCLUDED.total,
            status=EXCLUDED.status,
            return_comment=NULL,
            entered_by=EXCLUDED.entered_by,
            updated_at=CURRENT_TIMESTAMP
          WHERE course_marks.status <> 'approved'
        `, [
          row.id, course.id, semester, row.coursework, row.exam,
          row.total, status, req.user.id
        ]);

        saved++;
      }
    });

    await recordAudit(req.user, submit ? 'marks.submitted' : 'marks.saved', {
      type: 'course',
      id: course.id,
      comments: `${course.code} ${semester}: ${saved} students`
    });

    if (submit && saved) {
      const activeAdmins = await admins();

      for (const admin of activeAdmins) {
        await sendNotification(
          admin.id,
          'Results awaiting approval',
          `${req.user.full_name} submitted ${course.code} (${semester}) marks.`,
          '/admin/results',
          'results'
        );
      }
    }

    res.json({ ok: true, saved, locked, submitted: !!submit });
  }));

  // ---------------------------------------------------------
  // REGISTRAR APPROVAL AND REPORTS
  // ---------------------------------------------------------

  app.get('/api/admin/results/batches', auth('admin'), wrap(async (req, res) => {
    const result = await query(`
      SELECT m.course_id,m.semester,c.code,c.title,
             u.full_name AS lecturer_name,
             COUNT(*)::int AS students,
             MAX(m.updated_at) AS submitted_at
      FROM course_marks m
      JOIN courses c ON c.id=m.course_id
      LEFT JOIN users u ON u.id=c.lecturer_id
      WHERE m.status='submitted'
      GROUP BY m.course_id,m.semester,c.code,c.title,u.full_name
      ORDER BY submitted_at
    `);

    res.json(result.rows);
  }));

  app.get('/api/admin/results/batch', auth('admin'), wrap(async (req, res) => {
    const courseId = Number(req.query.course_id);
    const semester = String(req.query.semester || '');

    if (!Number.isInteger(courseId) || !SEM_RE.test(semester)) {
      return bad(res, 'Choose a course and semester');
    }

    const scale = await getScale();

    const result = await query(`
      SELECT u.full_name,u.university_id,
             m.coursework,m.exam,m.total,m.status
      FROM course_marks m
      JOIN users u ON u.id=m.student_id
      WHERE m.course_id=$1 AND m.semester=$2 AND m.status='submitted'
      ORDER BY u.full_name
    `, [courseId, semester]);

    res.json(result.rows.map(r => ({
      ...r,
      coursework: r.coursework === null ? null : Number(r.coursework),
      exam: r.exam === null ? null : Number(r.exam),
      total: r.total === null ? null : Number(r.total),
      grade: gradeOf(r.total === null ? null : Number(r.total), scale).grade
    })));
  }));

  const batchArgs = async (req, res) => {
    const courseId = Number((req.body || {}).course_id);
    const semester = String((req.body || {}).semester || '');

    if (!Number.isInteger(courseId) || !SEM_RE.test(semester)) {
      bad(res, 'Choose a course and semester');
      return null;
    }

    const result = await query(
      'SELECT * FROM courses WHERE id=$1',
      [courseId]
    );

    if (!result.rowCount) {
      bad(res, 'Course not found', 404);
      return null;
    }

    return { course: result.rows[0], semester };
  };

  app.post('/api/admin/results/approve', auth('admin'), wrap(async (req, res) => {
    const args = await batchArgs(req, res);
    if (!args) return;

    const { course, semester } = args;

    const result = await query(`
      UPDATE course_marks
      SET status='approved',approved_by=$1,
          approved_at=CURRENT_TIMESTAMP,return_comment=NULL
      WHERE course_id=$2 AND semester=$3 AND status='submitted'
      RETURNING student_id
    `, [req.user.id, course.id, semester]);

    if (!result.rowCount) {
      return bad(res, 'Nothing is waiting for approval for that course', 409);
    }

    for (const row of result.rows) {
      await sendNotification(
        row.student_id,
        'Results published',
        `${course.code} ${course.title} (${semester}) results are now on your account.`,
        '/student/results',
        'results'
      );
    }

    if (course.lecturer_id) {
      await sendNotification(
        course.lecturer_id,
        'Results approved',
        `${course.code} (${semester}) was approved by the Registrar.`,
        '/lecturer/marks',
        'results'
      );
    }

    await recordAudit(req.user, 'results.approved', {
      type: 'course',
      id: course.id,
      decision: 'approved',
      comments: `${course.code} ${semester}: ${result.rowCount} students`
    });

    res.json({ ok: true, approved: result.rowCount });
  }));

  app.post('/api/admin/results/return', auth('admin'), wrap(async (req, res) => {
    const args = await batchArgs(req, res);
    if (!args) return;

    const comment = text((req.body || {}).comment, 500);

    if (!comment) return bad(res, 'Tell the lecturer what to correct');

    const { course, semester } = args;

    const result = await query(`
      UPDATE course_marks
      SET status='returned',return_comment=$1
      WHERE course_id=$2 AND semester=$3 AND status='submitted'
      RETURNING id
    `, [comment, course.id, semester]);

    if (!result.rowCount) {
      return bad(res, 'Nothing is waiting for approval for that course', 409);
    }

    if (course.lecturer_id) {
      await sendNotification(
        course.lecturer_id,
        'Results returned for correction',
        `${course.code} (${semester}): ${comment}`,
        '/lecturer/marks',
        'results'
      );
    }

    await recordAudit(req.user, 'results.returned', {
      type: 'course',
      id: course.id,
      decision: 'returned',
      comments: comment
    });

    res.json({ ok: true, returned: result.rowCount });
  }));

  app.get('/api/admin/gpa-report', auth('admin'), wrap(async (req, res) => {
    const ids = await query(`
      SELECT DISTINCT u.id
      FROM users u
      JOIN course_marks m ON m.student_id=u.id
      WHERE u.role='student' AND m.status='approved'
    `);

    const list = [];

    for (const { id } of ids.rows) {
      const user = await query(`
        SELECT id,full_name,university_id,faculty,programme
        FROM users WHERE id=$1
      `, [id]);

      if (!user.rowCount) continue;

      const result = await transcript(id);

      list.push({
        ...user.rows[0],
        cgpa: result.cgpa,
        credits_earned: result.credits_earned,
        standing: result.standing
      });
    }

    list.sort((a, b) => (b.cgpa ?? -1) - (a.cgpa ?? -1));

    const values = list.filter(s => s.cgpa !== null);

    res.json({
      students: list,
      summary: {
        students: list.length,
        avg_cgpa: values.length
          ? round2(values.reduce((sum, s) => sum + s.cgpa, 0) / values.length)
          : null
      }
    });
  }));

  app.get('/api/admin/students/:id/transcript', auth('admin'), wrap(async (req, res) => {
    const result = await query(`
      SELECT id,full_name,university_id,faculty,programme,year_of_study
      FROM users WHERE id=$1 AND role='student'
    `, [req.params.id]);

    if (!result.rowCount) return bad(res, 'Student not found', 404);

    res.json({
      student: result.rows[0],
      ...await transcript(result.rows[0].id)
    });
  }));

  app.put('/api/admin/grade-scale', auth('admin'), wrap(async (req, res) => {
    const rows = (req.body || {}).rows;

    if (!Array.isArray(rows) || rows.length < 2 || rows.length > 12) {
      return bad(res, 'Enter between 2 and 12 grades');
    }

    const clean = rows.map(r => ({
      grade: text(r.grade, 4).toUpperCase(),
      min: Number(r.min_mark),
      points: Number(r.points)
    }));

    if (clean.some(r =>
      !r.grade ||
      !Number.isFinite(r.min) || r.min < 0 || r.min > 100 ||
      !Number.isFinite(r.points) || r.points < 0 || r.points > 5
    )) {
      return bad(res, 'Each grade needs a name, a minimum mark (0-100) and points (0-5)');
    }

    if (new Set(clean.map(r => r.grade)).size !== clean.length) {
      return bad(res, 'Grade names must be different');
    }

    if (new Set(clean.map(r => r.min)).size !== clean.length) {
      return bad(res, 'Grade minimum marks must be different');
    }

    if (!clean.some(r => r.min === 0)) {
      return bad(res, 'One grade must start at 0 so every mark gets a grade');
    }

    await transaction(async client => {
      await client.query('DELETE FROM grade_scale');

      for (const row of clean) {
        await client.query(
          'INSERT INTO grade_scale (grade,min_mark,points) VALUES ($1,$2,$3)',
          [row.grade, row.min, row.points]
        );
      }
    });

    await recordAudit(req.user, 'grade_scale.updated', {
      type: 'grade_scale',
      comments: clean.map(r => `${r.grade}>=${r.min}:${r.points}`).join(' ')
    });

    res.json({ ok: true });
  }));

  app.get('/api/me/results', auth('student'), wrap(async (req, res) => {
    res.json(await transcript(req.user.id));
  }));
};

module.exports.SEM_RE = SEM_RE;
