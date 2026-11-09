// StudentSphere academic module - PostgreSQL version.
// Uses the existing studentsphere schema. It does not create tables or demo accounts.

const SEM_RE = /^\d{4}-S[1-3]$/;
const round2 = (value) => Math.round(Number(value) * 100) / 100;
const numOrNull = (value) =>
  value === '' || value === null || value === undefined ? null : Number(value);
const text = (value, max = 80) => String(value || '').trim().slice(0, max);

module.exports = function mountAcademics(app, { db, auth, wrap, bad, audit, notify }) {
  // db must be the PostgreSQL helper exported by postgres.js.
  const query = (sql, params = []) => db.query(sql, params);
  const transaction = (callback) => db.transaction(callback);

  const getScale = async () => {
    let result = await query(
      'SELECT grade, min_mark, points FROM grade_scale ORDER BY min_mark DESC'
    );

    // Insert the starter scale only if the table is empty.
    // Never overwrite an official scale entered by the Registrar.
    if (!result.rowCount) {
      await query(
        `INSERT INTO grade_scale (grade, min_mark, points)
         VALUES ('A', 80, 4), ('B', 70, 3), ('C', 60, 2), ('D', 50, 1), ('F', 0, 0)
         ON CONFLICT (grade) DO NOTHING`
      );

      result = await query(
        'SELECT grade, min_mark, points FROM grade_scale ORDER BY min_mark DESC'
      );
    }

    return result.rows.map((row) => ({
      ...row,
      min_mark: Number(row.min_mark),
      points: Number(row.points)
    }));
  };

  const gradeOf = (total, scale) => {
    if (total === null || total === undefined) {
      return { grade: '—', points: 0 };
    }

    const mark = Number(total);
    const grade = scale.find((item) => mark >= item.min_mark)
      || scale[scale.length - 1];

    return grade
      ? { grade: grade.grade, points: Number(grade.points) }
      : { grade: '—', points: 0 };
  };

  const weighted = (list) => {
    const credits = list.reduce(
      (sum, row) => sum + Number(row.credits || 0),
      0
    );

    return credits
      ? round2(
          list.reduce(
            (sum, row) => sum + row.points * Number(row.credits || 0),
            0
          ) / credits
        )
      : null;
  };

  const standing = (cgpa) =>
    cgpa === null
      ? '—'
      : cgpa >= 3.5
        ? "Dean's list"
        : cgpa >= 2
          ? 'Good standing'
          : 'Academic warning';

  // Only approved marks count.
  // The latest approved attempt per course counts towards CGPA.
  const transcript = async (studentId) => {
    const scale = await getScale();

    const result = await query(
      `SELECT m.course_id, m.semester, m.coursework, m.exam, m.total,
              c.code, c.title, c.credits
       FROM course_marks m
       JOIN courses c ON c.id = m.course_id
       WHERE m.student_id = $1 AND m.status = 'approved'
       ORDER BY m.semester, c.code`,
      [studentId]
    );

    const rows = result.rows.map((row) => ({
      ...row,
      coursework: row.coursework === null ? null : Number(row.coursework),
      exam: row.exam === null ? null : Number(row.exam),
      total: row.total === null ? null : Number(row.total),
      credits: Number(row.credits),
      ...gradeOf(
        row.total === null ? null : Number(row.total),
        scale
      )
    }));

    const latest = new Map();

    rows.forEach((row) => {
      latest.set(Number(row.course_id), row);
    });

    rows.forEach((row) => {
      row.superseded =
        latest.get(Number(row.course_id)) !== row;
    });

    const bySemester = new Map();

    rows.forEach((row) => {
      if (!bySemester.has(row.semester)) {
        bySemester.set(row.semester, []);
      }

      bySemester.get(row.semester).push(row);
    });

    const semesters = [...bySemester].map(([semester, courses]) => ({
      semester,
      courses,
      credits: courses.reduce(
        (sum, row) => sum + row.credits,
        0
      ),
      gpa: weighted(courses)
    }));

    const counted = [...latest.values()];
    const cgpa = weighted(counted);

    return {
      semesters,
      cgpa,
      standing: standing(cgpa),
      credits_attempted: counted.reduce(
        (sum, row) => sum + row.credits,
        0
      ),
      credits_earned: counted
        .filter((row) => row.points > 0)
        .reduce((sum, row) => sum + row.credits, 0)
    };
  };

  const guard = async (res, fn) => {
    try {
      return await fn();
    } catch (error) {
      if (['23505', '23503', '23514'].includes(String(error.code))) {
        return bad(
          res,
          'That name, code or relationship is invalid or already exists',
          409
        );
      }

      throw error;
    }
  };

  const admins = async () => {
    const result = await query(
      "SELECT id FROM users WHERE role = 'admin' AND status = 'active'"
    );

    return result.rows;
  };
    // Validate and prepare course information.
  const courseBody = async (body = {}) => {
    const code = text(body.code, 30).toUpperCase();
    const title = text(body.title, 150);
    const credits = numOrNull(body.credits);
    const departmentId = numOrNull(body.department_id);
    const lecturerId = numOrNull(body.lecturer_id);

    if (!code || !title) {
      throw Object.assign(
        new Error('Course code and title are required'),
        { status: 400 }
      );
    }

    if (credits === null || !Number.isFinite(credits) || credits <= 0) {
      throw Object.assign(
        new Error('Course credits must be greater than zero'),
        { status: 400 }
      );
    }

    if (
      departmentId !== null &&
      (!Number.isInteger(departmentId) || departmentId <= 0)
    ) {
      throw Object.assign(
        new Error('Invalid department'),
        { status: 400 }
      );
    }

    if (
      lecturerId !== null &&
      (!Number.isInteger(lecturerId) || lecturerId <= 0)
    ) {
      throw Object.assign(
        new Error('Invalid lecturer'),
        { status: 400 }
      );
    }

    if (departmentId !== null) {
      const department = await query(
        'SELECT id FROM departments WHERE id = $1',
        [departmentId]
      );

      if (!department.rowCount) {
        throw Object.assign(
          new Error('Department not found'),
          { status: 400 }
        );
      }
    }

    if (lecturerId !== null) {
      const lecturer = await query(
        "SELECT id FROM users WHERE id = $1 AND role = 'lecturer' AND status = 'active'",
        [lecturerId]
      );

      if (!lecturer.rowCount) {
        throw Object.assign(
          new Error('Active lecturer not found'),
          { status: 400 }
        );
      }
    }

    return {
      code,
      title,
      credits,
      departmentId,
      lecturerId
    };
  };

  // FACULTIES

  app.get('/api/academics/faculties', auth(), wrap(async (req, res) => {
    const result = await query(
      'SELECT id, name, created_at FROM faculties ORDER BY name'
    );

    res.json(result.rows);
  }));

  app.post('/api/admin/faculties', auth('admin'), wrap(async (req, res) => {
    return guard(res, async () => {
      const name = text(req.body.name, 150);

      if (!name) {
        return bad(res, 'Faculty name is required', 400);
      }

      const result = await query(
        'INSERT INTO faculties (name) VALUES ($1) RETURNING *',
        [name]
      );

      await audit(req, {
        action: 'faculty_created',
        entity_type: 'faculty',
        entity_id: result.rows[0].id
      });

      res.status(201).json(result.rows[0]);
    });
  }));

  app.put('/api/admin/faculties/:id', auth('admin'), wrap(async (req, res) => {
    return guard(res, async () => {
      const id = Number(req.params.id);
      const name = text(req.body.name, 150);

      if (!Number.isInteger(id) || id <= 0 || !name) {
        return bad(res, 'Valid faculty ID and name are required', 400);
      }

      const result = await query(
        'UPDATE faculties SET name = $1 WHERE id = $2 RETURNING *',
        [name, id]
      );

      if (!result.rowCount) {
        return bad(res, 'Faculty not found', 404);
      }

      await audit(req, {
        action: 'faculty_updated',
        entity_type: 'faculty',
        entity_id: id
      });

      res.json(result.rows[0]);
    });
  }));

  // DEPARTMENTS

  app.get('/api/academics/departments', auth(), wrap(async (req, res) => {
    const params = [];
    let sql = `
      SELECT d.id, d.name, d.faculty_id,
             f.name AS faculty_name, d.created_at
      FROM departments d
      JOIN faculties f ON f.id = d.faculty_id
    `;

    if (req.query.faculty_id) {
      params.push(Number(req.query.faculty_id));
      sql += ' WHERE d.faculty_id = $1';
    }

    sql += ' ORDER BY f.name, d.name';

    const result = await query(sql, params);
    res.json(result.rows);
  }));

  app.post('/api/admin/departments', auth('admin'), wrap(async (req, res) => {
    return guard(res, async () => {
      const name = text(req.body.name, 150);
      const facultyId = Number(req.body.faculty_id);

      if (!name || !Number.isInteger(facultyId) || facultyId <= 0) {
        return bad(res, 'Department name and valid faculty are required', 400);
      }

      const result = await query(
        `INSERT INTO departments (faculty_id, name)
         VALUES ($1, $2)
         RETURNING *`,
        [facultyId, name]
      );

      await audit(req, {
        action: 'department_created',
        entity_type: 'department',
        entity_id: result.rows[0].id
      });

      res.status(201).json(result.rows[0]);
    });
  }));

  app.put('/api/admin/departments/:id', auth('admin'), wrap(async (req, res) => {
    return guard(res, async () => {
      const id = Number(req.params.id);
      const name = text(req.body.name, 150);
      const facultyId = Number(req.body.faculty_id);

      if (
        !Number.isInteger(id) || id <= 0 ||
        !name ||
        !Number.isInteger(facultyId) || facultyId <= 0
      ) {
        return bad(res, 'Valid department information is required', 400);
      }

      const result = await query(
        `UPDATE departments
         SET name = $1, faculty_id = $2
         WHERE id = $3
         RETURNING *`,
        [name, facultyId, id]
      );

      if (!result.rowCount) {
        return bad(res, 'Department not found', 404);
      }

      await audit(req, {
        action: 'department_updated',
        entity_type: 'department',
        entity_id: id
      });

      res.json(result.rows[0]);
    });
  }));
    // COURSES

  app.get('/api/academics/courses', auth(), wrap(async (req, res) => {
    const params = [];
    let sql = `
      SELECT c.id, c.code, c.title, c.credits,
             c.department_id, d.name AS department_name,
             f.id AS faculty_id, f.name AS faculty_name,
             c.lecturer_id, u.full_name AS lecturer_name,
             c.created_at
      FROM courses c
      LEFT JOIN departments d ON d.id = c.department_id
      LEFT JOIN faculties f ON f.id = d.faculty_id
      LEFT JOIN users u ON u.id = c.lecturer_id
      WHERE 1 = 1
    `;

    if (req.query.department_id) {
      params.push(Number(req.query.department_id));
      sql += ` AND c.department_id = $${params.length}`;
    }

    if (req.query.lecturer_id) {
      params.push(Number(req.query.lecturer_id));
      sql += ` AND c.lecturer_id = $${params.length}`;
    }

    sql += ' ORDER BY c.code';

    const result = await query(sql, params);
    res.json(result.rows);
  }));

  app.post('/api/admin/courses', auth('admin'), wrap(async (req, res) => {
    return guard(res, async () => {
      const course = await courseBody(req.body);

      const result = await query(
        `INSERT INTO courses
           (code, title, credits, department_id, lecturer_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          course.code,
          course.title,
          course.credits,
          course.departmentId,
          course.lecturerId
        ]
      );

      await audit(req, {
        action: 'course_created',
        entity_type: 'course',
        entity_id: result.rows[0].id
      });

      res.status(201).json(result.rows[0]);
    });
  }));

  app.put('/api/admin/courses/:id', auth('admin'), wrap(async (req, res) => {
    return guard(res, async () => {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return bad(res, 'Invalid course ID', 400);
      }

      const course = await courseBody(req.body);

      const result = await query(
        `UPDATE courses
         SET code = $1,
             title = $2,
             credits = $3,
             department_id = $4,
             lecturer_id = $5
         WHERE id = $6
         RETURNING *`,
        [
          course.code,
          course.title,
          course.credits,
          course.departmentId,
          course.lecturerId,
          id
        ]
      );

      if (!result.rowCount) {
        return bad(res, 'Course not found', 404);
      }

      await audit(req, {
        action: 'course_updated',
        entity_type: 'course',
        entity_id: id
      });

      res.json(result.rows[0]);
    });
  }));

  // Assign or change the lecturer responsible for a course.
  app.put(
    '/api/admin/courses/:id/lecturer',
    auth('admin'),
    wrap(async (req, res) => {
      return guard(res, async () => {
        const id = Number(req.params.id);
        const lecturerId = numOrNull(req.body.lecturer_id);

        if (!Number.isInteger(id) || id <= 0) {
          return bad(res, 'Invalid course ID', 400);
        }

        if (lecturerId !== null) {
          const lecturer = await query(
            `SELECT id FROM users
             WHERE id = $1 AND role = 'lecturer' AND status = 'active'`,
            [lecturerId]
          );

          if (!lecturer.rowCount) {
            return bad(res, 'Active lecturer not found', 404);
          }
        }

        const result = await query(
          `UPDATE courses
           SET lecturer_id = $1
           WHERE id = $2
           RETURNING *`,
          [lecturerId, id]
        );

        if (!result.rowCount) {
          return bad(res, 'Course not found', 404);
        }

        await audit(req, {
          action: 'course_lecturer_updated',
          entity_type: 'course',
          entity_id: id
        });

        res.json(result.rows[0]);
      });
    })
  );
    // LECTURER MARK ENTRY

  app.get(
    '/api/academics/lecturer/students',
    auth('lecturer'),
    wrap(async (req, res) => {
      const result = await query(
        `SELECT DISTINCT u.id, u.full_name, u.university_id,
                c.id AS course_id, c.code, c.title,
                c.credits
         FROM courses c
         JOIN users u ON u.role = 'student'
         JOIN lecturer_assignments la
           ON la.student_id = u.id
          AND la.lecturer_id = $1
         WHERE c.lecturer_id = $1
         ORDER BY u.full_name, c.code`,
        [req.user.id]
      );

      res.json(result.rows);
    })
  );

  app.get(
    '/api/academics/marks',
    auth('lecturer', 'admin'),
    wrap(async (req, res) => {
      const params = [];
      let sql = `
        SELECT m.id, m.student_id, u.full_name AS student_name,
               u.university_id, m.course_id, c.code AS course_code,
               c.title AS course_title, c.credits,
               m.semester, m.coursework, m.exam, m.total,
               m.status, m.return_comment, m.updated_at
        FROM course_marks m
        JOIN users u ON u.id = m.student_id
        JOIN courses c ON c.id = m.course_id
        WHERE 1 = 1
      `;

      if (req.user.role === 'lecturer') {
        params.push(req.user.id);
        sql += ` AND c.lecturer_id = $${params.length}`;
      }

      if (req.query.student_id) {
        params.push(Number(req.query.student_id));
        sql += ` AND m.student_id = $${params.length}`;
      }

      if (req.query.course_id) {
        params.push(Number(req.query.course_id));
        sql += ` AND m.course_id = $${params.length}`;
      }

      if (req.query.semester) {
        params.push(text(req.query.semester, 20));
        sql += ` AND m.semester = $${params.length}`;
      }

      sql += ' ORDER BY m.semester DESC, u.full_name, c.code';

      const result = await query(sql, params);
      res.json(result.rows);
    })
  );

  app.post(
    '/api/academics/marks',
    auth('lecturer'),
    wrap(async (req, res) => {
      return guard(res, async () => {
        const studentId = Number(req.body.student_id);
        const courseId = Number(req.body.course_id);
        const semester = text(req.body.semester, 20);
        const coursework = numOrNull(req.body.coursework);
        const exam = numOrNull(req.body.exam);

        if (
          !Number.isInteger(studentId) || studentId <= 0 ||
          !Number.isInteger(courseId) || courseId <= 0
        ) {
          return bad(res, 'Valid student and course are required', 400);
        }

        if (!SEM_RE.test(semester)) {
          return bad(res, 'Semester must use the format YYYY-S1, YYYY-S2 or YYYY-S3', 400);
        }

        if (
          coursework === null || exam === null ||
          !Number.isFinite(coursework) ||
          !Number.isFinite(exam) ||
          coursework < 0 || coursework > 100 ||
          exam < 0 || exam > 100
        ) {
          return bad(res, 'Marks must be between 0 and 100', 400);
        }

        const courseResult = await query(
          `SELECT id, lecturer_id
           FROM courses
           WHERE id = $1`,
          [courseId]
        );

        if (!courseResult.rowCount) {
          return bad(res, 'Course not found', 404);
        }

        if (Number(courseResult.rows[0].lecturer_id) !== Number(req.user.id)) {
          return bad(res, 'You are not assigned to this course', 403);
        }

        const studentResult = await query(
          `SELECT id
           FROM users
           WHERE id = $1 AND role = 'student' AND status = 'active'`,
          [studentId]
        );

        if (!studentResult.rowCount) {
          return bad(res, 'Active student not found', 404);
        }

        const assignment = await query(
          `SELECT id
           FROM lecturer_assignments
           WHERE student_id = $1 AND lecturer_id = $2`,
          [studentId, req.user.id]
        );

        if (!assignment.rowCount) {
          return bad(res, 'This student is not assigned to you', 403);
        }

        const total = round2((coursework + exam) / 2);

        const result = await query(
          `INSERT INTO course_marks
             (student_id, course_id, semester, coursework,
              exam, total, status, entered_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, CURRENT_TIMESTAMP)
           ON CONFLICT (student_id, course_id, semester)
           DO UPDATE SET
             coursework = EXCLUDED.coursework,
             exam = EXCLUDED.exam,
             total = EXCLUDED.total,
             status = 'draft',
             return_comment = NULL,
             entered_by = EXCLUDED.entered_by,
             approved_by = NULL,
             approved_at = NULL,
             updated_at = CURRENT_TIMESTAMP
           WHERE course_marks.status <> 'approved'
           RETURNING *`,
          [
            studentId,
            courseId,
            semester,
            coursework,
            exam,
            total,
            req.user.id
          ]
        );

        if (!result.rowCount) {
          return bad(res, 'Approved marks cannot be changed', 409);
        }

        await audit(req, {
          action: 'academic_mark_saved',
          entity_type: 'course_mark',
          entity_id: result.rows[0].id,
          student_id: studentId
        });

        res.status(201).json(result.rows[0]);
      });
    })
  );

  // Submit draft marks for Registrar approval.
  app.post(
    '/api/academics/marks/:id/submit',
    auth('lecturer'),
    wrap(async (req, res) => {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return bad(res, 'Invalid mark ID', 400);
      }

      const result = await query(
        `UPDATE course_marks m
         SET status = 'submitted',
             return_comment = NULL,
             updated_at = CURRENT_TIMESTAMP
         FROM courses c
         WHERE m.id = $1
           AND c.id = m.course_id
           AND c.lecturer_id = $2
           AND m.status IN ('draft', 'returned')
         RETURNING m.*`,
        [id, req.user.id]
      );

      if (!result.rowCount) {
        return bad(res, 'Mark not found or cannot be submitted', 404);
      }

      await audit(req, {
        action: 'academic_mark_submitted',
        entity_type: 'course_mark',
        entity_id: id
      });

      res.json(result.rows[0]);
    })
  );
    // REGISTRAR MARK REVIEW

  app.get(
    '/api/academics/registrar/pending',
    auth('admin'),
    wrap(async (req, res) => {
      const result = await query(
        `SELECT m.id, m.student_id,
                u.full_name AS student_name,
                u.university_id,
                m.course_id, c.code AS course_code,
                c.title AS course_title, c.credits,
                m.semester, m.coursework, m.exam, m.total,
                m.status, m.updated_at,
                lecturer.full_name AS lecturer_name
         FROM course_marks m
         JOIN users u ON u.id = m.student_id
         JOIN courses c ON c.id = m.course_id
         LEFT JOIN users lecturer ON lecturer.id = m.entered_by
         WHERE m.status = 'submitted'
         ORDER BY m.updated_at ASC`
      );

      res.json(result.rows);
    })
  );

  // Approve submitted marks.
  app.post(
    '/api/academics/registrar/marks/:id/approve',
    auth('admin'),
    wrap(async (req, res) => {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return bad(res, 'Invalid mark ID', 400);
      }

      const result = await query(
        `UPDATE course_marks
         SET status = 'approved',
             approved_by = $1,
             approved_at = CURRENT_TIMESTAMP,
             return_comment = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND status = 'submitted'
         RETURNING *`,
        [req.user.id, id]
      );

      if (!result.rowCount) {
        return bad(res, 'Mark not found or is no longer awaiting approval', 404);
      }

      await audit(req, {
        action: 'academic_mark_approved',
        entity_type: 'course_mark',
        entity_id: id,
        student_id: result.rows[0].student_id,
        decision: 'approved'
      });

      await notify(
        result.rows[0].student_id,
        'Academic mark approved',
        'Your submitted academic mark has been approved by the Registrar.'
      );

      res.json(result.rows[0]);
    })
  );

  // Return submitted marks to the lecturer for correction.
  app.post(
    '/api/academics/registrar/marks/:id/return',
    auth('admin'),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const comment = text(req.body.comment, 1000);

      if (!Number.isInteger(id) || id <= 0) {
        return bad(res, 'Invalid mark ID', 400);
      }

      if (!comment) {
        return bad(res, 'A reason for returning the mark is required', 400);
      }

      const result = await query(
        `UPDATE course_marks
         SET status = 'returned',
             return_comment = $1,
             approved_by = NULL,
             approved_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND status = 'submitted'
         RETURNING *`,
        [comment, id]
      );

      if (!result.rowCount) {
        return bad(res, 'Mark not found or is no longer awaiting approval', 404);
      }

      await audit(req, {
        action: 'academic_mark_returned',
        entity_type: 'course_mark',
        entity_id: id,
        student_id: result.rows[0].student_id,
        decision: 'returned',
        comments: comment
      });

      const lecturer = await query(
        `SELECT lecturer_id
         FROM courses
         WHERE id = $1`,
        [result.rows[0].course_id]
      );

      if (lecturer.rows[0]?.lecturer_id) {
        await notify(
          lecturer.rows[0].lecturer_id,
          'Academic mark returned',
          `A submitted mark was returned for correction. Reason: ${comment}`
        );
      }

      res.json(result.rows[0]);
    })
  );
    // STUDENT ACADEMIC RESULTS

  // Get a student's academic transcript.
  app.get(
    '/api/academics/transcript/:studentId',
    auth('student', 'lecturer', 'admin'),
    wrap(async (req, res) => {
      const studentId = Number(req.params.studentId);

      if (!Number.isInteger(studentId) || studentId <= 0) {
        return bad(res, 'Invalid student ID', 400);
      }

      // Students can only view their own transcript.
      if (
        req.user.role === 'student' &&
        Number(req.user.id) !== studentId
      ) {
        return bad(res, 'You can only view your own transcript', 403);
      }

      // Lecturers must be assigned to the student.
      if (req.user.role === 'lecturer') {
        const assignment = await query(
          `SELECT id FROM lecturer_assignments
           WHERE student_id = $1 AND lecturer_id = $2`,
          [studentId, req.user.id]
        );

        if (!assignment.rowCount) {
          return bad(res, 'You are not assigned to this student', 403);
        }
      }

      const student = await query(
        `SELECT id, full_name, university_id, faculty,
                programme, year_of_study
         FROM users
         WHERE id = $1 AND role = 'student'`,
        [studentId]
      );

      if (!student.rowCount) {
        return bad(res, 'Student not found', 404);
      }

      const academicRecord = await transcript(studentId);

      res.json({
        student: student.rows[0],
        ...academicRecord
      });
    })
  );

  // Allow a student to view their own academic record.
  app.get(
    '/api/academics/my-transcript',
    auth('student'),
    wrap(async (req, res) => {
      const academicRecord = await transcript(req.user.id);

      res.json(academicRecord);
    })
  );

  // Academic summary for administrators.
  app.get(
    '/api/admin/academics/summary',
    auth('admin'),
    wrap(async (req, res) => {
      const result = await query(`
        SELECT
          COUNT(*)::int AS total_marks,
          COUNT(*) FILTER (WHERE status = 'draft')::int AS draft_marks,
          COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted_marks,
          COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_marks,
          COUNT(*) FILTER (WHERE status = 'returned')::int AS returned_marks
        FROM course_marks
      `);

      res.json(result.rows[0]);
    })
  );
    // GRADE SCALE MANAGEMENT

  app.get(
    '/api/academics/grade-scale',
    auth(),
    wrap(async (req, res) => {
      const scale = await getScale();
      res.json(scale);
    })
  );

  app.put(
    '/api/admin/academics/grade-scale',
    auth('admin'),
    wrap(async (req, res) => {
      return guard(res, async () => {
        const grades = req.body.grades;

        if (!Array.isArray(grades) || grades.length === 0) {
          return bad(res, 'A valid grade scale is required', 400);
        }

        const seen = new Set();

        for (const item of grades) {
          const grade = text(item.grade, 10).toUpperCase();
          const minMark = Number(item.min_mark);
          const points = Number(item.points);

          if (
            !grade ||
            !Number.isFinite(minMark) ||
            !Number.isFinite(points) ||
            minMark < 0 ||
            minMark > 100 ||
            points < 0 ||
            seen.has(grade)
          ) {
            return bad(res, 'Invalid or duplicate grade information', 400);
          }

          seen.add(grade);
        }

        const sorted = grades
          .map((item) => ({
            grade: text(item.grade, 10).toUpperCase(),
            min_mark: Number(item.min_mark),
            points: Number(item.points)
          }))
          .sort((a, b) => b.min_mark - a.min_mark);

        if (sorted[sorted.length - 1].min_mark !== 0) {
          return bad(res, 'The lowest grade must start at zero', 400);
        }

        await transaction(async (client) => {
          await client.query('DELETE FROM grade_scale');

          for (const item of sorted) {
            await client.query(
              `INSERT INTO grade_scale (grade, min_mark, points)
               VALUES ($1, $2, $3)`,
              [item.grade, item.min_mark, item.points]
            );
          }
        });

        await audit(req, {
          action: 'grade_scale_updated',
          entity_type: 'grade_scale'
        });

        res.json({
          message: 'Grade scale updated successfully',
          grades: sorted
        });
      });
    })
  );

  // END OF STUDENTSPHERE ACADEMICS MODULE
};
