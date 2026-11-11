require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const db = require("./postgres");
const { sendMail, mode: mailMode, appUrl } = require("./mailer");

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is missing from .env");
}

const SECRET = process.env.JWT_SECRET;
const PORT = Number(process.env.PORT || 3000);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function httpErr(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function bad(res, message, status = 400) {
  return res.status(status).json({ ok: false, error: message });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function pub(user) {
  if (!user) return null;
  const output = { ...user };
  delete output.password_hash;
  return output;
}

function auth(...roles) {
  return wrap(async (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token) return bad(res, "Please log in to continue", 401);

    let decoded;
    try {
      decoded = jwt.verify(token, SECRET);
    } catch {
      return bad(res, "Your session is invalid or has expired. Please log in again.", 401);
    }

    const result = await db.query(
      "SELECT * FROM users WHERE id = $1",
      [decoded.id]
    );

    const user = result.rows[0];

    if (!user || user.status !== "active") {
      return bad(res, "Your account is not active", 403);
    }

    if (roles.length && !roles.includes(user.role)) {
      return bad(res, "You do not have permission to perform this action", 403);
    }

    req.user = user;
    next();
  });
}

async function getUser(id) {
  const result = await db.query(
    "SELECT * FROM users WHERE id = $1",
    [id]
  );
  return result.rows[0] || null;
}

async function notify(userId, title, body, link = null, type = null) {
  await db.query(
    `INSERT INTO notifications (user_id, title, body, link, type, is_read, created_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, CURRENT_TIMESTAMP)`,
    [userId, title, body, link, type]
  );
}

async function audit(actor, action, details = {}) {
  await db.query(
    `INSERT INTO audit_log
      (actor_id, actor_role, action, entity_type, entity_id, student_id, decision, comments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actor ? actor.id : null,
      actor ? actor.role : null,
      action,
      details.type || null,
      details.id || null,
      details.student || null,
      details.decision || null,
      details.comments || null
    ]
  );
}

async function ensureExtras(userId) {
  await db.query(
    `INSERT INTO profiles (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  await db.query(
    `INSERT INTO settings (user_id, email_notifications, deadline_reminders)
     VALUES ($1, TRUE, TRUE)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

async function cgpaOf(userId) {
  const result = await db.query(
    `SELECT ROUND(AVG(gpa)::numeric, 2) AS cgpa
     FROM results
     WHERE user_id = $1 AND academic_year IS DISTINCT FROM 'Projected'`,
    [userId]
  );
  return result.rows[0].cgpa === null ? 0 : Number(result.rows[0].cgpa);
}

async function routeUnassignedAchievements(studentId) {
  await db.query(
    `UPDATE achievements
     SET lecturer_id = (
       SELECT lecturer_id
       FROM lecturer_assignments
       WHERE student_id = achievements.user_id
       ORDER BY is_primary DESC, id
       LIMIT 1
     )
     WHERE user_id = $1
       AND lecturer_id IS NULL
       AND status IN ('pending_verification', 'under_review')`,
    [studentId]
  );
}
async function lecturerCanSee(lecturerId, studentId) {
  const result = await db.query(
    `SELECT 1
     FROM lecturer_assignments
     WHERE lecturer_id = $1 AND student_id = $2
     UNION
     SELECT 1
     FROM recommendations
     WHERE lecturer_id = $1 AND student_id = $2`,
    [lecturerId, studentId]
  );
  return result.rowCount > 0;
}

const ACH_STATUSES = [
  "pending_verification",
  "under_review",
  "verified",
  "rejected",
  "evidence_required"
];

const REASON_CODES = [
  "insufficient_evidence",
  "inaccurate_information",
  "not_relevant",
  "guideline_violation",
  "other"
];

const ACH_CATEGORIES = [
  "Academic award",
  "Certificate",
  "Leadership position",
  "Competition award",
  "Hackathon achievement",
  "Research achievement",
  "Community service",
  "Professional achievement",
  "Training certificate",
  "Other extracurricular"
];

function prepareFiles(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > 3) throw httpErr("You can upload a maximum of 3 files");

  const allowed = {
    "application/pdf": { ext: ".pdf", magic: Buffer.from("%PDF-") },
    "image/png": { ext: ".png", magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    "image/jpeg": { ext: ".jpg", magic: Buffer.from([0xff, 0xd8, 0xff]) }
  };

  return input.map((file) => {
    const mime = String(file.mime || file.type || "").toLowerCase();
    const rule = allowed[mime];

    if (!rule) throw httpErr("Only PDF, PNG and JPG files are allowed");

    const encoded = String(file.data || "").replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(encoded, "base64");

    if (!buffer.length || buffer.length > 4 * 1024 * 1024) {
      throw httpErr("Each file must be no larger than 4 MB");
    }

    if (!buffer.subarray(0, rule.magic.length).equals(rule.magic)) {
      throw httpErr("A file does not match its declared file type");
    }

    return {
      buffer,
      mime,
      size: buffer.length,
      original_name: path.basename(String(file.name || `evidence${rule.ext}`)).slice(0, 255),
      stored_name: crypto.randomBytes(24).toString("hex") + rule.ext,
      kind: file.kind || "evidence"
    };
  });
}

async function storeFiles(achievementId, files) {
  for (const file of files) {
    const destination = path.join(UPLOAD_DIR, file.stored_name);
    await fs.promises.writeFile(destination, file.buffer, { flag: "wx" });

    try {
      await db.query(
        `INSERT INTO achievement_files
          (achievement_id, kind, original_name, stored_name, mime, size)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          achievementId,
          file.kind,
          file.original_name,
          file.stored_name,
          file.mime,
          file.size
        ]
      );
    } catch (error) {
      await fs.promises.unlink(destination).catch(() => {});
      throw error;
    }
  }
}

async function removeFiles(achievementId) {
  const result = await db.query(
    "SELECT stored_name FROM achievement_files WHERE achievement_id = $1",
    [achievementId]
  );

  for (const file of result.rows) {
    await fs.promises.unlink(path.join(UPLOAD_DIR, file.stored_name)).catch(() => {});
  }

  await db.query(
    "DELETE FROM achievement_files WHERE achievement_id = $1",
    [achievementId]
  );
}

async function filesOf(achievementId) {
  const result = await db.query(
    `SELECT id, achievement_id, kind, original_name, mime, size, uploaded_at
     FROM achievement_files
     WHERE achievement_id = $1
     ORDER BY id`,
    [achievementId]
  );
  return result.rows;
}


/* =========================
   AUTHENTICATION
========================= */

async function achievementsOf(userId) {
  const result = await db.query(
    `SELECT a.*, l.full_name AS lecturer_name
     FROM achievements a
     LEFT JOIN users l ON l.id = a.lecturer_id
     WHERE a.user_id = $1
     ORDER BY a.id DESC`,
    [userId]
  );

  return Promise.all(
    result.rows.map(async (achievement) => ({
      ...achievement,
      files: await filesOf(achievement.id)
    }))
  );
}

async function profileBundle(id) {
  await ensureExtras(id);

  const user = await getUser(id);
  if (!user) return null;

  const profileResult = await db.query(
    "SELECT * FROM profiles WHERE user_id = $1",
    [id]
  );

  const profile = profileResult.rows[0] || {};
  let skills = [];

  try {
    skills = JSON.parse(profile.skills || "[]");
  } catch {
    skills = [];
  }

  const projectsResult = await db.query(
    "SELECT * FROM projects WHERE user_id = $1 ORDER BY id",
    [id]
  );

  const resultsResult = await db.query(
    "SELECT * FROM results WHERE user_id = $1 ORDER BY id",
    [id]
  );

  return {
    user: pub(user),
    profile: { ...profile, skills },
    projects: projectsResult.rows,
    achievements: await achievementsOf(id),
    results: resultsResult.rows,
    cgpa: await cgpaOf(id)
  };
}
const loginAttempts = new Map();

function checkLoginLimit(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);

  if (!entry || now - entry.start > 15 * 60 * 1000) {
    loginAttempts.set(key, { count: 1, start: now });
    return true;
  }

  if (entry.count >= 10) return false;

  entry.count += 1;
  return true;
}

app.post("/api/auth/register", wrap(async (req, res) => {
  const b = req.body || {};

  const fullName = String(b.full_name || "").trim();
  const universityId = String(b.university_id || "").trim();
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  const role = String(b.role || "").trim().toLowerCase();

  if (!fullName || !universityId || !email || !password) {
    return bad(res, "Please complete all required fields");
  }

  if (!["student", "lecturer"].includes(role)) {
    return bad(res, "Choose either Student or Lecturer");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return bad(res, "Enter a valid email address");
  }

  if (password.length < 8 || !/\d/.test(password)) {
    return bad(res, "Password must contain at least 8 characters and one number");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const user = await db.transaction(async (client) => {
      const existing = await client.query(
        `SELECT id FROM users
         WHERE LOWER(email) = LOWER($1)
            OR LOWER(university_id) = LOWER($2)
         LIMIT 1`,
        [email, universityId]
      );

      if (existing.rowCount) {
        throw httpErr("An account with that email or university ID already exists", 409);
      }

      const inserted = await client.query(
        `INSERT INTO users
          (role, full_name, university_id, email, password_hash,
           status, faculty, programme, year_of_study, specialisation)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)
         RETURNING *`,
        [
          role,
          fullName,
          universityId,
          email,
          passwordHash,
          b.faculty || null,
          b.programme || null,
          b.year_of_study || null,
          b.specialisation || null
        ]
      );

      const newUser = inserted.rows[0];

      await client.query(
        "INSERT INTO profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [newUser.id]
      );

      await client.query(
        `INSERT INTO settings (user_id, email_notifications, deadline_reminders)
         VALUES ($1, TRUE, TRUE)
         ON CONFLICT DO NOTHING`,
        [newUser.id]
      );

      await client.query(
        `INSERT INTO audit_log
          (actor_id, actor_role, action, entity_type, entity_id, comments)
         VALUES (NULL, NULL, 'account_registered', 'user', $1, $2)`,
        [newUser.id, "New " + role + " registration"]
      );

      return newUser;
    });

    return res.status(201).json({
      ok: true,
      message: "Registration submitted. Please wait for administrator approval.",
      user: pub(user)
    });
  } catch (error) {
    if (error.status) return bad(res, error.message, error.status);

    if (error.code === "23505") {
      return bad(res, "An account with that email or university ID already exists", 409);
    }

    throw error;
  }
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const b = req.body || {};
  const identifier = String(b.email || b.identifier || b.university_id || "").trim();
  const password = String(b.password || "");
  const requestedRole = String(b.role || "").trim().toLowerCase();
  const ip = req.ip || "unknown";

  if (!identifier || !password) {
    return bad(res, "Enter your email or university ID and password");
  }

  if (!checkLoginLimit(ip)) {
    return bad(res, "Too many login attempts. Please try again in 15 minutes.", 429);
  }

  const result = await db.query(
    `SELECT * FROM users
     WHERE LOWER(email) = LOWER($1)
        OR LOWER(university_id) = LOWER($1)
     LIMIT 1`,
    [identifier]
  );

  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return bad(res, "Invalid login details", 401);
  }

  if (requestedRole && requestedRole !== user.role) {
    return bad(res, "This account does not belong to the selected role", 403);
  }

  if (user.status === "pending") {
    return bad(res, "Your account is awaiting administrator approval", 403);
  }

  if (user.status !== "active") {
    return bad(res, "Your account is not active. Please contact the administrator.", 403);
  }

  loginAttempts.delete(ip);

  const token = jwt.sign(
    { id: String(user.id), role: user.role },
    SECRET,
    { expiresIn: "12h" }
  );

  await ensureExtras(user.id);

  return res.json({
    ok: true,
    token,
    user: pub(user)
  });
}));

app.get("/api/me", auth(), wrap(async (req, res) => {
  await ensureExtras(req.user.id);

  return res.json({
    ok: true,
    user: pub(req.user)
  });
}));

app.put("/api/me/password", auth(), wrap(async (req, res) => {
  const currentPassword = String(req.body.current_password || "");
  const newPassword = String(req.body.new_password || "");

  if (!currentPassword || !newPassword) {
    return bad(res, "Enter your current password and new password");
  }

  if (newPassword.length < 8 || !/\d/.test(newPassword)) {
    return bad(res, "New password must contain at least 8 characters and one number");
  }

  const matches = await bcrypt.compare(currentPassword, req.user.password_hash);

  if (!matches) {
    return bad(res, "Your current password is incorrect", 401);
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  await db.query(
    "UPDATE users SET password_hash = $1 WHERE id = $2",
    [passwordHash, req.user.id]
  );

  await audit(req.user, "password_changed", {
    type: "user",
    id: req.user.id
  });

  return res.json({
    ok: true,
    message: "Your password has been changed successfully"
  });
}));

/* =========================
   PROFILE
========================= */

app.get("/api/me/profile", auth(), wrap(async (req, res) => {
  await ensureExtras(req.user.id);

  const profileResult = await db.query(
    "SELECT * FROM profiles WHERE user_id = $1",
    [req.user.id]
  );

  const rawProfile = profileResult.rows[0] || {};

  let skills = rawProfile.skills || [];

  if (!Array.isArray(skills)) {
    try {
      const parsed = JSON.parse(skills || "[]");
      skills = Array.isArray(parsed) ? parsed : [];
    } catch {
      skills = [];
    }
  }

  const projectsResult = await db.query(
    "SELECT * FROM projects WHERE user_id = $1 ORDER BY id DESC",
    [req.user.id]
  );

  const resultsResult = await db.query(
    "SELECT * FROM results WHERE user_id = $1 ORDER BY id",
    [req.user.id]
  );

  const achievements = await achievementsOf(req.user.id);

  return res.json({
    ok: true,
    user: pub(req.user),
    profile: {
      ...rawProfile,
      skills
    },
    projects: projectsResult.rows,
    achievements,
    results: resultsResult.rows,
    cgpa: await cgpaOf(req.user.id)
  });
}));

app.put("/api/me/profile", auth(), wrap(async (req, res) => {
  const b = req.body || {};

  const allowed = [
    "headline",
    "about",
    "skills",
    "phone",
    "location",
    "linkedin",
    "github",
    "experience"
  ];

  const values = allowed.map((field) => {
    const value = b[field];

    if (field === "skills" && Array.isArray(value)) {
      return JSON.stringify(value);
    }

    return value === undefined ? null : String(value).trim();
  });

  await ensureExtras(req.user.id);

  await db.query(
    `UPDATE profiles SET
      headline = COALESCE($1, headline),
      about = COALESCE($2, about),
      skills = COALESCE($3, skills),
      phone = COALESCE($4, phone),
      location = COALESCE($5, location),
      linkedin = COALESCE($6, linkedin),
      github = COALESCE($7, github),
      experience = COALESCE($8, experience)
     WHERE user_id = $9`,
    [...values, req.user.id]
  );

  const updated = await db.query(
    "SELECT * FROM profiles WHERE user_id = $1",
    [req.user.id]
  );

  await audit(req.user, "profile_updated", {
    type: "user",
    id: req.user.id
  });

  return res.json({
    ok: true,
    profile: updated.rows[0]
  });
}));

/* =========================
   PROJECTS
========================= */

app.post("/api/me/projects", auth(), wrap(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || "").trim();

  if (!title) return bad(res, "Project title is required");

  const result = await db.query(
    `INSERT INTO projects (user_id, title, description, tech, url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      req.user.id,
      title,
      b.description || null,
      b.tech || null,
      b.url || null
    ]
  );

  await audit(req.user, "project_created", {
    type: "project",
    id: result.rows[0].id
  });

  return res.status(201).json({
    ok: true,
    project: result.rows[0]
  });
}));

app.delete("/api/me/projects/:id", auth(), wrap(async (req, res) => {
  const result = await db.query(
    `DELETE FROM projects
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [req.params.id, req.user.id]
  );

  if (!result.rowCount) {
    return bad(res, "Project not found", 404);
  }

  await audit(req.user, "project_deleted", {
    type: "project",
    id: req.params.id
  });

  return res.json({
    ok: true,
    message: "Project deleted"
  });
}));


// ==========================================
// PASSWORD RECOVERY
// ==========================================

const resetAttempts = new Map();

function checkResetLimit(key) {
  const now = Date.now();
  const entry = resetAttempts.get(key);

  if (!entry || now - entry.start > 15 * 60 * 1000) {
    resetAttempts.set(key, { count: 1, start: now });
    return true;
  }

  if (entry.count >= 5) return false;

  entry.count += 1;
  return true;
}

// Request a password reset link.
app.post("/api/auth/forgot-password", wrap(async (req, res) => {
  const ip = req.ip || "unknown";
  const email = String(req.body?.email || "").trim().toLowerCase();

  if (!checkResetLimit(ip)) {
    return bad(res, "Too many password reset requests. Please try again in 15 minutes.", 429);
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return bad(res, "Enter a valid university email address");
  }

  const genericMessage =
    "If an active StudentSphere account exists for that email, a password reset link will be sent.";

  const result = await db.query(
    `SELECT id, full_name, email
     FROM users
     WHERE LOWER(email) = $1
       AND status = 'active'
     LIMIT 1`,
    [email]
  );

  const user = result.rows[0];

  if (!user) {
    return res.json({
      ok: true,
      message: genericMessage
    });
  }

  const token = crypto.randomBytes(32).toString("hex");

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  await db.transaction(async (client) => {
    await client.query(
      `UPDATE password_reset_tokens
       SET used_at = CURRENT_TIMESTAMP
       WHERE user_id = $1
         AND used_at IS NULL`,
      [user.id]
    );

    await client.query(
      `INSERT INTO password_reset_tokens
        (user_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '30 minutes', CURRENT_TIMESTAMP)`,
      [user.id, tokenHash]
    );
  });

  await sendMail({
    user,
    subject: "StudentSphere password reset",
    heading: "Reset your StudentSphere password",
    intro: "We received a request to reset your StudentSphere account password.",
    paragraphs: [
      "This secure link expires in 30 minutes and can only be used once.",
      "If you did not request this change, you can ignore this email."
    ],
    action: {
      label: "Reset my password",
      path: `/reset-password/${token}`
    },
    force: true,
    related: {
      type: "password_reset",
      id: user.id
    }
  });

  const response = {
    ok: true,
    message: genericMessage
  };

  if (mailMode() !== "smtp" && process.env.NODE_ENV !== "production") {
    response.resetUrl =
      `${appUrl()}/#/reset-password/${token}`;
  }

  return res.json(response);
}));

// Complete a password reset.
app.post("/api/auth/reset-password", wrap(async (req, res) => {
  const ip = req.ip || "unknown";

  if (!checkResetLimit(`reset:${ip}`)) {
    return bad(res, "Too many password reset attempts. Please try again in 15 minutes.", 429);
  }

  const token = String(req.body?.token || "").trim();
  const password = String(req.body?.password || "");

  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return bad(res, "This password reset link is invalid or has expired.", 400);
  }

  if (password.length < 8 || !/\d/.test(password)) {
    return bad(res, "Password must contain at least 8 characters and one number.");
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const passwordHash = await bcrypt.hash(password, 12);

  let userId;

  try {
    userId = await db.transaction(async (client) => {
      const result = await client.query(
        `SELECT id, user_id
         FROM password_reset_tokens
         WHERE token_hash = $1
           AND used_at IS NULL
           AND expires_at > CURRENT_TIMESTAMP
         FOR UPDATE`,
        [tokenHash]
      );

      const resetRecord = result.rows[0];

      if (!resetRecord) {
        throw httpErr("This password reset link is invalid or has expired. Request a new link.", 400);
      }

      await client.query(
        `UPDATE users
         SET password_hash = $1
         WHERE id = $2`,
        [passwordHash, resetRecord.user_id]
      );

      await client.query(
        `UPDATE password_reset_tokens
         SET used_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [resetRecord.id]
      );

      await client.query(
        `UPDATE password_reset_tokens
         SET used_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
           AND used_at IS NULL`,
        [resetRecord.user_id]
      );

      return resetRecord.user_id;
    });
  } catch (error) {
    if (error.status) {
      return bad(res, error.message, error.status);
    }

    throw error;
  }

  await audit(null, "password_reset_completed", {
    type: "user",
    id: userId
  });

  return res.json({
    ok: true,
    message: "Your password has been updated successfully. You can now log in."
  });
}));


/* =========================
   ACHIEVEMENT WORKFLOW HELPERS
========================= */

async function pickLecturer(student, requestedId) {
  if (requestedId) {
    const result = await db.query(
      "SELECT id FROM users WHERE id = $1 AND role = 'lecturer' AND status = 'active'",
      [requestedId]
    );

    if (!result.rows[0]) {
      throw httpErr("The selected lecturer was not found");
    }

    return result.rows[0].id;
  }

  const assigned = await db.query(
    `SELECT a.lecturer_id AS id
     FROM lecturer_assignments a
     JOIN users u ON u.id = a.lecturer_id
     WHERE a.student_id = $1 AND u.status = 'active'
     ORDER BY a.is_primary DESC, a.id
     LIMIT 1`,
    [student.id]
  );

  if (assigned.rows[0]) return assigned.rows[0].id;

  const facultyLecturer = await db.query(
    `SELECT id FROM users
     WHERE role = 'lecturer' AND status = 'active' AND faculty = $1
     ORDER BY id
     LIMIT 1`,
    [student.faculty]
  );

  if (facultyLecturer.rows[0]) return facultyLecturer.rows[0].id;

  throw httpErr(
    "No lecturer is available to verify this yet. Please contact the administrator."
  );
}

async function loadAchievementFor(user, id) {
  const result = await db.query(
    "SELECT * FROM achievements WHERE id = $1",
    [id]
  );

  const achievement = result.rows[0];

  if (!achievement) {
    throw httpErr("Achievement not found", 404);
  }

  const permitted =
    user.role === "admin" ||
    (user.role === "student" && String(achievement.user_id) === String(user.id)) ||
    (user.role === "lecturer" && String(achievement.lecturer_id) === String(user.id));

  if (!permitted) {
    throw httpErr("You do not have permission to view this achievement", 403);
  }

  return achievement;
}

async function mailRecRequest(rec, student, lecturer) {
  return sendMail({
    user: lecturer,
    template: "rec_request",
    subject: "New Recommendation Request - StudentSphere",
    related: { type: "recommendation", id: rec.id },
    heading: "New recommendation request",
    intro: "A student has submitted a recommendation letter request through StudentSphere.",
    rows: [
      ["Student Name", student.full_name],
      ["Student ID", student.university_id],
      ["Programme", student.programme],
      ["Faculty", student.faculty],
      ["Purpose", rec.purpose],
      ["Date submitted", today()],
      ["Deadline", rec.deadline],
      ["Message from student", rec.message]
    ],
    paragraphs: [
      "Please log in to your StudentSphere Lecturer Dashboard to review the request.",
      "You can review the student's academic profile, achievements, skills, projects, and academic performance before making your decision."
    ],
    action: {
      label: "Review request",
      path: `/lecturer/requests/${rec.id}`
    }
  });
}

async function mailRecUpdate(rec, student, lecturer, kind, detail) {
  const messages = {
    approved: [
      "Recommendation Request Approved - StudentSphere",
      "Your recommendation request was approved",
      `${lecturer.full_name} approved your request and will now write your recommendation letter.`
    ],
    declined: [
      "Recommendation Request Declined - StudentSphere",
      "Your recommendation request was declined",
      `${lecturer.full_name} is unable to provide this recommendation.`
    ],
    more_info: [
      "More Information Required for Your Recommendation - StudentSphere",
      "More information is required",
      `${lecturer.full_name} needs more information before deciding on your request.`
    ],
    completed: [
      "Your Recommendation Letter Is Ready - StudentSphere",
      "Your recommendation letter is ready",
      `${lecturer.full_name} has completed your recommendation letter.`
    ]
  };

  const message = messages[kind];
  if (!message) return;

  return sendMail({
    user: student,
    template: "rec_" + kind,
    subject: message[0],
    related: { type: "recommendation", id: rec.id },
    heading: message[1],
    intro: message[2],
    rows: [
      ["Purpose", rec.purpose],
      ["Lecturer", lecturer.full_name],
      [
        kind === "declined" ? "Reason" :
        kind === "more_info" ? "What is needed" : "",
        detail || ""
      ]
    ],
    paragraphs: kind === "completed"
      ? ["Log in to StudentSphere to view your letter, if your lecturer has released it for download."]
      : [],
    action: {
      label: "Open Recommendations",
      path: "/student/recommendations"
    }
  });
}
async function mailAchSubmitted(achievement, student, lecturer, again = false) {
  return sendMail({
    user: lecturer,
    template: "ach_submitted",
    subject: again
      ? "Achievement Evidence Updated - StudentSphere"
      : "Student Achievement Verification Required - StudentSphere",
    related: { type: "achievement", id: achievement.id },
    heading: again
      ? "Student added requested evidence"
      : "Achievement verification required",
    intro: again
      ? "A student has responded to your request for additional evidence."
      : "A student has submitted a new achievement through the StudentSphere platform.",
    rows: [
      ["Student Name", student.full_name],
      ["Student ID", student.university_id],
      ["Achievement Title", achievement.title],
      ["Achievement Category", achievement.category],
      ["Date Submitted", today()]
    ],
    paragraphs: [
      "The student has submitted this achievement for verification.",
      "Please log in to your StudentSphere Lecturer Dashboard to review the information and supporting documents."
    ],
    action: {
      label: "Review achievement",
      path: `/lecturer/achievements/${achievement.id}`
    }
  });
}

async function mailAchDecision(achievement, student, lecturer, kind, comment) {
  const messages = {
    verified: [
      "Achievement Verified - StudentSphere",
      "Your achievement has been verified",
      "A VERIFIED badge now appears next to this achievement on your profile."
    ],
    rejected: [
      "Achievement Not Verified - StudentSphere",
      "Your achievement could not be verified",
      "The lecturer could not verify this achievement. The reason is shown below."
    ],
    evidence_required: [
      "Additional Evidence Required - StudentSphere",
      "Additional evidence is required",
      "Your lecturer needs more evidence or clarification before this achievement can be verified."
    ]
  };

  const message = messages[kind];

  if (!message) return;

  return sendMail({
    user: student,
    template: "ach_" + kind,
    subject: message[0],
    related: { type: "achievement", id: achievement.id },
    heading: message[1],
    intro: message[2],
    rows: [
      ["Achievement", achievement.title],
      ["Reviewed by", lecturer.full_name],
      [
        kind === "verified" ? "Comment" :
        kind === "rejected" ? "Reason" : "What is needed",
        comment || ""
      ]
    ],
    action: {
      label: kind === "evidence_required" ? "Add evidence" : "View achievements",
      path: "/student/achievements"
    }
  });
}


/* =========================
   ACHIEVEMENT ROUTES
========================= */

app.get("/api/achievement-options", auth(), wrap(async (req, res) => {
  res.json({
    ok: true,
    categories: ACH_CATEGORIES,
    reasons: REASON_CODES
  });
}));

app.post("/api/me/achievements", auth("student"), wrap(async (req, res) => {
  const body = req.body || {};

  const title = String(body.title || "").trim();
  const category = String(body.category || "").trim();
  const description = String(body.description || "").trim();
  const dateObtained = String(body.date_obtained || "").trim();
  const organisation = String(body.organisation || "").trim();
  const evidenceNote = String(body.evidence_note || "").trim();

  if (!title || !category || !description || !dateObtained) {
    return bad(res, "Title, category, description and date obtained are required");
  }

  if (!ACH_CATEGORIES.includes(category)) {
    return bad(res, "Please select a valid achievement category");
  }

  const parsedDate = new Date(`${dateObtained}T00:00:00.000Z`);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateObtained) ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== dateObtained) {
    return bad(res, "Please provide a valid achievement date");
  }

  const files = prepareFiles(body.files);
  const lecturerId = await pickLecturer(req.user, body.lecturer_id);

  const inserted = await db.query(
    `INSERT INTO achievements
      (user_id, title, category, description, year, organisation,
       date_obtained, evidence_note, status, lecturer_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_verification',$9,NOW())
     RETURNING id`,
    [
      req.user.id, title, category, description,
      dateObtained.substring(0, 4), organisation || null,
      dateObtained, evidenceNote || null, lecturerId
    ]
  );

  const achievementId = inserted.rows[0].id;

  try {
    await storeFiles(achievementId, files);

    await db.query(
      `INSERT INTO achievement_verifications
        (achievement_id, lecturer_id, student_id, action, decision, comments)
       VALUES ($1,$2,$3,'submitted','pending_verification',NULL)`,
      [achievementId, lecturerId, req.user.id]
    );
  } catch (error) {
    await removeFiles(achievementId).catch(() => {});

    await db.query(
      "DELETE FROM achievements WHERE id = $1 AND user_id = $2",
      [achievementId, req.user.id]
    ).catch(() => {});

    throw error;
  }

  const achievement = {
    id: achievementId,
    title,
    category
  };

  let lecturer = null;

  try {
    lecturer = await getUser(lecturerId);
  } catch (error) {
    console.error("Achievement lecturer lookup failed:", error.message);
  }

  if (lecturer) {
    try {
      await notify(
        lecturer.id,
        "Achievement verification required",
        `${req.user.full_name} submitted "${title}" for verification.`,
        `/lecturer/achievements/${achievementId}`,
        "achievement"
      );
    } catch (error) {
      console.error("Achievement notification failed:", error.message);
    }

    try {
      await mailAchSubmitted(achievement, req.user, lecturer);
    } catch (error) {
      console.error("Achievement email failed:", error.message);
    }
  }

  try {
    await audit(req.user, "achievement.submitted", {
      type: "achievement",
      id: achievementId,
      student: req.user.id,
      decision: "pending_verification",
      comments: title
    });
  } catch (error) {
    console.error("Achievement audit logging failed:", error.message);
  }

  res.json({
    ok: true,
    id: achievementId,
    message: "Your achievement has been submitted and is awaiting lecturer verification."
  });
}));

app.put("/api/me/achievements/:id/evidence", auth("student"), wrap(async (req, res) => {
  const result = await db.query(
    "SELECT * FROM achievements WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );

  const achievement = result.rows[0];

  if (!achievement) {
    return bad(res, "Achievement not found", 404);
  }

  if (achievement.status !== "evidence_required") {
    return bad(res, "No additional evidence has been requested for this achievement", 409);
  }

  const body = req.body || {};
  const message = String(body.message || "").trim();

  const files = prepareFiles(
    (Array.isArray(body.files) ? body.files : [])
      .map(file => ({ ...file, kind: "additional" }))
  );

  if (!message && !files.length) {
    return bad(res, "Add a message or attach a file");
  }

  const previousResult = await db.query(
    "SELECT id FROM achievement_files WHERE achievement_id = $1",
    [achievement.id]
  );

  const previousIds = new Set(
    previousResult.rows.map(file => String(file.id))
  );

  try {
    await storeFiles(achievement.id, files);

    await db.transaction(async (client) => {
      await client.query(
        `UPDATE achievements
         SET status = 'pending_verification',
             student_response = $1
         WHERE id = $2 AND user_id = $3`,
        [message || null, achievement.id, req.user.id]
      );

      await client.query(
        `INSERT INTO achievement_verifications
          (achievement_id, lecturer_id, student_id, action, decision, comments)
         VALUES ($1,$2,$3,'evidence_added','pending_verification',$4)`,
        [achievement.id, achievement.lecturer_id, req.user.id, message || null]
      );
    });
  } catch (error) {
    const currentFiles = await db.query(
      "SELECT id, stored_name FROM achievement_files WHERE achievement_id = $1",
      [achievement.id]
    ).catch(() => ({ rows: [] }));

    for (const file of currentFiles.rows) {
      if (!previousIds.has(String(file.id))) {
        await fs.promises.unlink(
          path.join(UPLOAD_DIR, file.stored_name)
        ).catch(() => {});

        await db.query(
          "DELETE FROM achievement_files WHERE id = $1",
          [file.id]
        ).catch(() => {});
      }
    }

    throw error;
  }

  let lecturer = null;

  if (achievement.lecturer_id) {
    try {
      lecturer = await getUser(achievement.lecturer_id);
    } catch (error) {
      console.error("Additional evidence lecturer lookup failed:", error.message);
    }
  }

  if (lecturer) {
    try {
      await notify(
        lecturer.id,
        "Student added evidence",
        `${req.user.full_name} responded about "${achievement.title}".`,
        `/lecturer/achievements/${achievement.id}`,
        "achievement"
      );
    } catch (error) {
      console.error("Additional evidence notification failed:", error.message);
    }

    try {
      await mailAchSubmitted(achievement, req.user, lecturer, true);
    } catch (error) {
      console.error("Additional evidence email failed:", error.message);
    }
  }

  try {
    await audit(req.user, "achievement.evidence_added", {
      type: "achievement",
      id: achievement.id,
      student: req.user.id,
      comments: message || null
    });
  } catch (error) {
    console.error("Additional evidence audit logging failed:", error.message);
  }

  res.json({
    ok: true,
    message: "Your additional evidence has been submitted for review."
  });
}));
app.delete("/api/me/achievements/:id", auth("student"), wrap(async (req, res) => {
  const achievementId = req.params.id;

  const result = await db.query(
    "SELECT id FROM achievements WHERE id = $1 AND user_id = $2",
    [achievementId, req.user.id]
  );

  if (!result.rows[0]) {
    return bad(res, "Achievement not found", 404);
  }

  await removeFiles(achievementId);

  await db.query(
    "DELETE FROM achievements WHERE id = $1 AND user_id = $2",
    [achievementId, req.user.id]
  );

  await audit(req.user, "achievement.deleted", {
    type: "achievement",
    id: achievementId
  });

  res.json({ ok: true, message: "Achievement deleted successfully" });
}));

app.get("/api/achievements", auth("lecturer", "admin"), wrap(async (req, res) => {
  const params = [];
  let conditions = [];

  if (req.user.role === "lecturer") {
    params.push(req.user.id);
    conditions.push(`a.lecturer_id = $${params.length}`);
  }

  const status = String(req.query.status || "").trim();

  if (status) {
    if (!ACH_STATUSES.includes(status)) {
      return bad(res, "Invalid achievement status");
    }

    params.push(status);
    conditions.push(`a.status = $${params.length}`);
  }

  const where = conditions.length
    ? "WHERE " + conditions.join(" AND ")
    : "";

  const result = await db.query(
    `SELECT
       a.id, a.title, a.category, a.status, a.created_at,
       a.lecturer_id, a.date_obtained, a.organisation,
       u.id AS student_id,
       u.full_name AS student_name,
       u.university_id AS student_university_id,
       l.full_name AS lecturer_name,
       (SELECT COUNT(*) FROM achievement_files f
        WHERE f.achievement_id = a.id) AS file_count
     FROM achievements a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN users l ON l.id = a.lecturer_id
     ${where}
     ORDER BY a.id DESC`,
    params
  );

  res.json({ ok: true, achievements: result.rows });
}));

app.get("/api/achievements/:id", auth(), wrap(async (req, res) => {
  const achievement = await loadAchievementFor(req.user, req.params.id);

  const student = await getUser(achievement.user_id);

  const profile = (
    await db.query(
      "SELECT * FROM profiles WHERE user_id = $1",
      [achievement.user_id]
    )
  ).rows[0] || {};

  const lecturer = achievement.lecturer_id
    ? await getUser(achievement.lecturer_id)
    : null;

  const files = await filesOf(achievement.id);

  const history = await db.query(
    `SELECT
       v.id, v.action, v.decision, v.comments, v.created_at,
       u.full_name AS lecturer_name
     FROM achievement_verifications v
     LEFT JOIN users u ON u.id = v.lecturer_id
     WHERE v.achievement_id = $1
     ORDER BY v.id DESC`,
    [achievement.id]
  );

  const cgpa = await cgpaOf(achievement.user_id);

  res.json({
    ok: true,
    achievement: {
      ...achievement,
      lecturer_name: lecturer ? lecturer.full_name : null
    },
    student: {
      id: student.id,
      full_name: student.full_name,
      university_id: student.university_id,
      faculty: student.faculty,
      programme: student.programme,
      year_of_study: student.year_of_study,
      profile
    },
    cgpa,
    files,
    history: history.rows
  });
}));

app.put("/api/achievements/:id/review", auth("lecturer"), wrap(async (req, res) => {
  const achievement = await loadAchievementFor(req.user, req.params.id);

  const action = String(req.body.action || "").trim();
  const comment = String(req.body.comment || "").trim();
  const reasonCode = String(req.body.reason_code || "").trim();

  if (["verified", "rejected"].includes(achievement.status)) {
    return bad(res, "This achievement has already received a final decision");
  }

  if (achievement.status === "evidence_required" && action !== "start_review") {
    return bad(res, "Start reviewing the submitted evidence before making another decision");
  }

  let nextStatus;
  let decision;
  let notificationTitle;
  let notificationBody;
  let emailKind;

  if (action === "start_review") {
    if (!["pending_verification", "evidence_required"].includes(achievement.status)) {
      return bad(res, "This achievement cannot be moved into review");
    }

    nextStatus = "under_review";
    decision = "under_review";
  } else if (action === "verify") {
    nextStatus = "verified";
    decision = "verified";
    notificationTitle = "Achievement verified";
    notificationBody = `Your achievement "${achievement.title}" has been verified.`;
    emailKind = "verified";
  } else if (action === "reject") {
    if (!REASON_CODES.includes(reasonCode)) {
      return bad(res, "Please select a valid rejection reason");
    }

    if (comment.length < 10) {
      return bad(res, "Please provide a rejection explanation of at least 10 characters");
    }

    nextStatus = "rejected";
    decision = "rejected";
    notificationTitle = "Achievement not verified";
    notificationBody = `Your achievement "${achievement.title}" could not be verified.`;
    emailKind = "rejected";
  } else if (action === "request_evidence") {
    if (comment.length < 10) {
      return bad(res, "Please explain what additional evidence is required");
    }

    nextStatus = "evidence_required";
    decision = "evidence_required";
    notificationTitle = "Additional evidence required";
    notificationBody = `Your lecturer has requested additional evidence for "${achievement.title}".`;
    emailKind = "evidence_required";
  } else {
    return bad(res, "Invalid review action");
  }

  await db.transaction(async (client) => {
    if (action === "verify") {
      await client.query(
        `UPDATE achievements
         SET status = $1, reviewer_comment = $2,
             reason_code = NULL, evidence_request = NULL,
             reviewed_at = NOW()
         WHERE id = $3`,
        [nextStatus, comment || null, achievement.id]
      );
    } else if (action === "reject") {
      await client.query(
        `UPDATE achievements
         SET status = $1, reviewer_comment = $2,
             reason_code = $3, reviewed_at = NOW()
         WHERE id = $4`,
        [nextStatus, comment, reasonCode, achievement.id]
      );
    } else if (action === "request_evidence") {
      await client.query(
        `UPDATE achievements
         SET status = $1, reviewer_comment = $2,
             evidence_request = $2, reviewed_at = NOW()
         WHERE id = $3`,
        [nextStatus, comment, achievement.id]
      );
    } else {
      await client.query(
        "UPDATE achievements SET status = $1 WHERE id = $2",
        [nextStatus, achievement.id]
      );
    }

    await client.query(
      `INSERT INTO achievement_verifications
        (achievement_id, lecturer_id, student_id, action, decision, comments)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        achievement.id,
        req.user.id,
        achievement.user_id,
        action,
        decision,
        comment || null
      ]
    );
  });

  try {
    await audit(req.user, "achievement.reviewed", {
      type: "achievement",
      id: achievement.id,
      decision,
      comments: comment
    });
  } catch (error) {
    console.error("Achievement review audit failed:", error.message);
  }

  if (emailKind) {
    const student = await getUser(achievement.user_id);

    try {
      await notify(
        achievement.user_id,
        notificationTitle,
        notificationBody,
        "/student/achievements",
        "achievement"
      );
    } catch (error) {
      console.error("Achievement decision notification failed:", error.message);
    }

    try {
      await mailAchDecision(
        { ...achievement, status: nextStatus },
        student,
        req.user,
        emailKind,
        comment
      );
    } catch (error) {
      console.error("Achievement decision email failed:", error.message);
    }
  }

  res.json({
    ok: true,
    status: nextStatus,
    message: action === "start_review"
      ? "Achievement review started"
      : "Achievement review decision saved"
  });
}));

/* =========================
   RECOMMENDATION ROUTES
========================= */

/* =========================
   STUDENT AND LECTURER DIRECTORIES
========================= */


// ---------------------------------------------------------------- dashboard

// ---------------------------------------------------------------- admin student roster (read-only)
app.get("/api/admin/roster", auth("admin"), wrap(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const search = `%${q}%`;

  const [rowsResult, totalResult, registeredResult] = await Promise.all([
    db.query(
      `SELECT r.*,
              EXISTS (
                SELECT 1 FROM users u
                WHERE LOWER(u.university_id) = LOWER(r.university_id)
                  AND u.role = 'student'
              ) AS registered
       FROM student_roster r
       WHERE $1 = '' OR r.full_name ILIKE $2
          OR r.university_id ILIKE $2
          OR COALESCE(r.programme, '') ILIKE $2
       ORDER BY r.full_name
       LIMIT 500`,
      [q, search]
    ),
    db.query("SELECT COUNT(*)::int AS total FROM student_roster"),
    db.query(
      `SELECT COUNT(*)::int AS registered
       FROM student_roster r
       WHERE EXISTS (
         SELECT 1 FROM users u
         WHERE LOWER(u.university_id) = LOWER(r.university_id)
           AND u.role = 'student'
       )`
    )
  ]);

  res.json({
    total: totalResult.rows[0].total,
    registered: registeredResult.rows[0].registered,
    rows: rowsResult.rows
  });
}));
// ---------------------------------------------------------------- admin user management
app.get("/api/admin/users", auth("admin"), wrap(async (req, res) => {
  const { role, status, q } = req.query;

  const conditions = [];
  const params = [];

  if (role) {
    if (!["student", "lecturer", "admin"].includes(role)) {
      return bad(res, "Invalid user role");
    }

    params.push(role);
    conditions.push(`role = $${params.length}`);
  }

  if (status) {
    if (!["active", "pending", "suspended"].includes(status)) {
      return bad(res, "Invalid account status");
    }

    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  if (q) {
    params.push(`%${String(q).trim()}%`);
    conditions.push(
      `(full_name ILIKE $${params.length}
        OR email ILIKE $${params.length}
        OR university_id ILIKE $${params.length})`
    );
  }

  const where = conditions.length
    ? "WHERE " + conditions.join(" AND ")
    : "";

  const result = await db.query(
    `SELECT id, role, full_name, university_id, email,
            status, faculty, programme, year_of_study,
            specialisation, created_at
     FROM users
     ${where}
     ORDER BY id DESC`,
    params
  );

  res.json(result.rows);
}));


// ---------------------------------------------------------------- admin account approval
app.put("/api/admin/users/:id", auth("admin"), wrap(async (req, res) => {
  const { status } = req.body || {};

  if (!["active", "pending", "suspended"].includes(status)) {
    return bad(res, "Invalid status");
  }

  const target = await getUser(req.params.id);

  if (!target) {
    return bad(res, "User not found", 404);
  }
  if (Number(target.id) === 1) {
    return bad(res, "The original system administrator account is protected", 403);
  }
  if (String(target.id) === String(req.user.id)) {
    return bad(res, "You cannot change your own account");
  }

  await db.query(
    "UPDATE users SET status = $1 WHERE id = $2",
    [status, target.id]
  );

  await audit(req.user, "account." + status, {
    type: "user",
    id: target.id,
    student: target.role === "student" ? target.id : null,
    decision: status
  });

  let emailSent = true;

  if (status === "active" && target.status === "pending") {
    await notify(
      target.id,
      "Account approved",
      "Your StudentSphere account is now active.",
      null,
      "account"
    );

    try {
      await sendMail({
        user: target,
        force: true,
        template: "account_approved",
        subject: "Your StudentSphere Account Is Approved",
        related: { type: "user", id: target.id },
        heading: "Your account has been approved",
        intro: "An administrator has approved your StudentSphere account. You can now log in.",
        rows: [
          ["Role", target.role],
          ["University ID", target.university_id]
        ],
        action: {
          label: "Log in",
          path: "/login"
        }
      });
    } catch (error) {
      emailSent = false;
      console.error("Account approval email failed:", error.message);
    }
  }

  res.json({ ok: true, email_sent: emailSent });
}));


// ---------------------------------------------------------------- admin account rejection
app.post("/api/admin/users/:id/reject", auth("admin"), wrap(async (req, res) => {
  const target = await getUser(req.params.id);

  if (!target) {
    return bad(res, "User not found", 404);
  }

  if (Number(target.id) === 1) {
    return bad(res, "The system administrator account cannot be rejected", 403);
  }

  if (target.status !== "pending") {
    return bad(res, "Only pending registrations can be rejected", 409);
  }

  const reason = String((req.body || {}).reason || "").trim();

  await audit(req.user, "account.rejected", {
    type: "user",
    id: target.id,
    decision: "rejected",
    comments: reason || null
  });

  let emailSent = true;

  try {
    await sendMail({
      user: target,
      force: true,
      template: "account_rejected",
      subject: "Your StudentSphere Registration Was Not Approved",
      related: { type: "user", id: target.id },
      heading: "Your registration was not approved",
      intro: "An administrator reviewed your StudentSphere registration and could not approve it.",
      rows: [["Reason", reason || "No reason was given"]],
      paragraphs: [
        "If you believe this is a mistake, please contact the university administration."
      ]
    });
  } catch (error) {
    emailSent = false;
    console.error("Account rejection email failed:", error.message);
  }

  await db.query(
    "DELETE FROM users WHERE id = $1 AND status = 'pending'",
    [target.id]
  );

  res.json({ ok: true, email_sent: emailSent });
}));


// ---------------------------------------------------------------- admin account deletion
app.delete("/api/admin/users/:id", auth("admin"), wrap(async (req, res) => {
  const target = await getUser(req.params.id);

  if (!target) {
    return bad(res, "User not found", 404);
  }

  if (Number(target.id) === 1) {
    return bad(res, "The original system administrator cannot be deleted", 403);
  }

  if (String(target.id) === String(req.user.id)) {
    return bad(res, "You cannot delete your own account");
  }

  if (target.role === "admin" && target.status === "active") {
    const admins = await db.query(
      "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'"
    );

    if (Number(admins.rows[0].total) <= 1) {
      return bad(res, "The last active administrator cannot be deleted", 409);
    }
  }

  if (target.role === "student") {
    const academicRecords = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM course_marks WHERE student_id = $1) +
         (SELECT COUNT(*) FROM results WHERE user_id = $1) AS total`,
      [target.id]
    );

    if (Number(academicRecords.rows[0].total) > 0) {
      return bad(
        res,
        "This student has academic records. Suspend the account instead of deleting it.",
        409
      );
    }
  }

  const files = await db.query(
    `SELECT f.stored_name
     FROM achievement_files f
     JOIN achievements a ON a.id = f.achievement_id
     WHERE a.user_id = $1`,
    [target.id]
  );

  await db.transaction(async (client) => {
    await client.query(
      `INSERT INTO audit_log
        (actor_id, actor_role, action, entity_type, entity_id,
         student_id, decision, comments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.user.id,
        req.user.role,
        "account.deleted",
        "user",
        target.id,
        target.role === "student" ? target.id : null,
        "deleted",
        `${target.role}: ${target.full_name}`
      ]
    );

    const deleted = await client.query(
      "DELETE FROM users WHERE id = $1",
      [target.id]
    );

    if (deleted.rowCount !== 1) {
      throw new Error("Account deletion could not be completed");
    }
  });

  for (const file of files.rows) {
    const filePath = path.resolve(UPLOAD_DIR, file.stored_name);

    if (filePath.startsWith(UPLOAD_DIR + path.sep)) {
      await fs.promises.unlink(filePath).catch(() => {});
    }
  }

  res.json({ ok: true });
}));

/* =========================
   ADMIN LECTURER ASSIGNMENTS
========================= */

app.get("/api/admin/assignments", auth("admin"), wrap(async (req, res) => {
  const studentsResult = await db.query(
    `SELECT id, full_name, university_id, programme
     FROM users
     WHERE role = 'student' AND status = 'active'
     ORDER BY full_name`
  );

  const assignmentsResult = await db.query(
    `SELECT a.id, a.student_id, a.lecturer_id, a.is_primary,
            u.full_name AS lecturer_name
     FROM lecturer_assignments a
     JOIN users u ON u.id = a.lecturer_id
     ORDER BY a.is_primary DESC, a.id`
  );

  const assignmentsByStudent = new Map();

  for (const assignment of assignmentsResult.rows) {
    if (!assignmentsByStudent.has(assignment.student_id)) {
      assignmentsByStudent.set(assignment.student_id, []);
    }

    assignmentsByStudent.get(assignment.student_id).push(assignment);
  }

  const students = studentsResult.rows.map((student) => ({
    ...student,
    assignments: assignmentsByStudent.get(student.id) || []
  }));

  const lecturersResult = await db.query(
    `SELECT id, full_name
     FROM users
     WHERE role = 'lecturer' AND status = 'active'
     ORDER BY full_name`
  );

  res.json({
    students,
    lecturers: lecturersResult.rows
  });
}));

app.post("/api/admin/assignments", auth("admin"), wrap(async (req, res) => {
  const { student_id, lecturer_id, is_primary } = req.body || {};

  const studentResult = await db.query(
    `SELECT id FROM users WHERE id = $1 AND role = 'student'`,
    [student_id]
  );

  const lecturerResult = await db.query(
    `SELECT id FROM users
     WHERE id = $1 AND role = 'lecturer' AND status = 'active'`,
    [lecturer_id]
  );

  if (!studentResult.rowCount || !lecturerResult.rowCount) {
    return bad(res, "Choose a valid student and an active lecturer");
  }

  const studentId = studentResult.rows[0].id;
  const lecturerId = lecturerResult.rows[0].id;
  const primary = is_primary === true;

  await db.transaction(async (client) => {
    if (primary) {
      await client.query(
        `UPDATE lecturer_assignments
         SET is_primary = FALSE
         WHERE student_id = $1`,
        [studentId]
      );
    }

    await client.query(
      `INSERT INTO lecturer_assignments
         (student_id, lecturer_id, is_primary)
       VALUES ($1, $2, $3)
       ON CONFLICT (student_id, lecturer_id)
       DO UPDATE SET is_primary = EXCLUDED.is_primary`,
      [studentId, lecturerId, primary]
    );

    await client.query(
      `UPDATE achievements
       SET lecturer_id = (
         SELECT lecturer_id
         FROM lecturer_assignments
         WHERE student_id = achievements.user_id
         ORDER BY is_primary DESC, id
         LIMIT 1
       )
       WHERE user_id = $1
         AND lecturer_id IS NULL
         AND status IN ('pending_verification', 'under_review')`,
      [studentId]
    );
  });

  await audit(req.user, "assignment.added", {
    type: "assignment",
    student: studentId,
    comments: `lecturer ${lecturerId}${primary ? " (primary)" : ""}`
  });

  res.json({ ok: true });
}));

app.delete("/api/admin/assignments/:id", auth("admin"), wrap(async (req, res) => {
  const assignmentResult = await db.query(
    `SELECT * FROM lecturer_assignments WHERE id = $1`,
    [req.params.id]
  );

  if (!assignmentResult.rowCount) {
    return bad(res, "Assignment not found", 404);
  }

  const assignment = assignmentResult.rows[0];

  await db.query(
    `DELETE FROM lecturer_assignments WHERE id = $1`,
    [assignment.id]
  );

  await audit(req.user, "assignment.removed", {
    type: "assignment",
    student: assignment.student_id,
    comments: `lecturer ${assignment.lecturer_id}`
  });

  res.json({ ok: true });
}));
/* =========================
   ADMIN EMAIL LOG AND AUDIT
========================= */

app.get("/api/admin/emails", auth("admin"), wrap(async (req, res) => {
  const result = await db.query(
    `SELECT id, to_email, subject, template, status, error, created_at
     FROM email_log
     ORDER BY id DESC
     LIMIT 200`
  );

  res.json({
    mode: mailMode(),
    app_url: appUrl(),
    rows: result.rows
  });
}));

app.get("/api/admin/emails/:id", auth("admin"), wrap(async (req, res) => {
  const result = await db.query(
    `SELECT * FROM email_log WHERE id = $1`,
    [req.params.id]
  );

  if (!result.rowCount) {
    return bad(res, "Email not found", 404);
  }

  res.json(result.rows[0]);
}));

app.post("/api/admin/email-test", auth("admin"), wrap(async (req, res) => {
  try {
    await sendMail({
      user: req.user,
      force: true,
      template: "test",
      subject: "StudentSphere test email",
      heading: "Email test",
      intro: "If you can read this, StudentSphere email is configured correctly.",
      rows: [
        ["Mode", mailMode()],
        ["Sent", today()]
      ]
    });

    res.json({
      ok: true,
      mode: mailMode()
    });
  } catch (error) {
    console.error("Admin test email failed:", error.message);
    return bad(res, "Test email could not be sent", 500);
  }
}));

app.get("/api/admin/audit", auth("admin"), wrap(async (req, res) => {
  const result = await db.query(
    `SELECT g.*,
            a.full_name AS actor_name,
            s.full_name AS student_name
     FROM audit_log g
     LEFT JOIN users a ON a.id = g.actor_id
     LEFT JOIN users s ON s.id = g.student_id
     ORDER BY g.id DESC
     LIMIT 300`
  );

  res.json(result.rows);
}));
/* =========================
   ADMIN CSV IMPORT
========================= */

// CSV columns: university_id, year_label, academic_year, gpa, standing
app.post("/api/admin/import", auth("admin"), wrap(async (req, res) => {
  const lines = String((req.body || {}).csv || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  let imported = 0;
  const warnings = [];

  const studentsResult = await db.query(
    "SELECT id, university_id FROM users WHERE role = 'student'"
  );

  const students = new Map(
    studentsResult.rows.map(student => [
      String(student.university_id).toLowerCase(),
      student.id
    ])
  );

  await db.transaction(async client => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const columns = line.split(",").map(value => value.trim());

      if (i === 0 && /university_id/i.test(columns[0])) {
        continue;
      }

      const studentId = students.get(
        String(columns[0] || "").toLowerCase()
      );

      const gpa = Number.parseFloat(columns[3]);

      if (
        !studentId ||
        !columns[1] ||
        !Number.isFinite(gpa)
      ) {
        warnings.push(`Line ${i + 1}: could not import "${line}"`);
        continue;
      }

      await client.query(
        `INSERT INTO results
         (user_id, year_label, academic_year, gpa, standing)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          studentId,
          columns[1],
          columns[2] || "",
          gpa,
          columns[4] || ""
        ]
      );

      imported++;
    }
  });

  await audit(req.user, "records.imported", {
    type: "results",
    comments: `${imported} rows`
  });

  res.json({ imported, warnings });
}));

/* =========================
   ADMIN ACADEMIC RECORDS
========================= */

app.get("/api/admin/records", auth("admin"), wrap(async (req, res) => {
  const [faculties, programmes, rows] = await Promise.all([
    db.query(
      "SELECT COUNT(DISTINCT faculty)::int AS c FROM users WHERE faculty IS NOT NULL AND faculty <> ''"
    ),
    db.query(
      "SELECT COUNT(DISTINCT programme)::int AS c FROM users WHERE programme IS NOT NULL AND programme <> ''"
    ),
    db.query(
      `SELECT u.full_name, u.university_id, u.programme,
              r.year_label, r.academic_year, r.gpa, r.standing
       FROM results r
       JOIN users u ON u.id = r.user_id
       ORDER BY u.full_name, r.id`
    )
  ]);

  res.json({
    faculties: faculties.rows[0].c,
    programmes: programmes.rows[0].c,
    rows: rows.rows
  });
}));

/* =========================
   ADMIN REPORTS
========================= */

app.get("/api/admin/reports", auth("admin"), wrap(async (req, res) => {
  const count = async (sql) => {
    const result = await db.query(sql);
    return result.rows[0].c;
  };

  const students = await count(
    "SELECT COUNT(*)::int AS c FROM users WHERE role = 'student'"
  );

  const filled = await count(
    `SELECT COUNT(*)::int AS c
     FROM users u
     JOIN profiles p ON p.user_id = u.id
     WHERE u.role = 'student'
       AND length(coalesce(p.about, '')) > 0`
  );

  const [
    usersTotal,
    lecturers,
    pendingAccounts,
    recsTotal,
    recsCompleted,
    recsDeclined,
    recsOpen,
    achievementsTotal,
    achievementsVerified,
    achievementsRejected,
    achievementsAwaiting,
    emailsSent,
    emailsFailed,
    avgCgpa
  ] = await Promise.all([
    count("SELECT COUNT(*)::int AS c FROM users"),
    count("SELECT COUNT(*)::int AS c FROM users WHERE role = 'lecturer'"),
    count("SELECT COUNT(*)::int AS c FROM users WHERE status = 'pending'"),
    count("SELECT COUNT(*)::int AS c FROM recommendations"),
    count("SELECT COUNT(*)::int AS c FROM recommendations WHERE status = 'completed'"),
    count("SELECT COUNT(*)::int AS c FROM recommendations WHERE status = 'declined'"),
    count("SELECT COUNT(*)::int AS c FROM recommendations WHERE status IN ('pending','under_review','approved','more_info')"),
    count("SELECT COUNT(*)::int AS c FROM achievements"),
    count("SELECT COUNT(*)::int AS c FROM achievements WHERE status = 'verified'"),
    count("SELECT COUNT(*)::int AS c FROM achievements WHERE status = 'rejected'"),
    count("SELECT COUNT(*)::int AS c FROM achievements WHERE status IN ('pending_verification','under_review','evidence_required')"),
    count("SELECT COUNT(*)::int AS c FROM email_log WHERE status IN ('sent','dev')"),
    count("SELECT COUNT(*)::int AS c FROM email_log WHERE status = 'failed'"),
    `(SELECT ROUND(AVG(gpa), 2) AS c FROM results WHERE academic_year != 'Projected')`
  ]);

  const averageResult = await db.query(avgCgpa);

  res.json({
    users_total: usersTotal,
    students,
    lecturers,
    pending_accounts: pendingAccounts,
    profile_completion: students ? Math.round((filled / students) * 100) : 0,
    recs_total: recsTotal,
    recs_completed: recsCompleted,
    recs_declined: recsDeclined,
    recs_open: recsOpen,
    achievements_total: achievementsTotal,
    achievements_verified: achievementsVerified,
    achievements_rejected: achievementsRejected,
    achievements_awaiting: achievementsAwaiting,
    emails_sent: emailsSent,
    emails_failed: emailsFailed,
    avg_cgpa: averageResult.rows[0].c
  });
}));
app.get("/api/dashboard", auth(), wrap(async (req, res) => {
  const u = req.user;

  const recentResult = await db.query(
    `SELECT title, body, link, created_at
     FROM notifications
     WHERE user_id = $1
     ORDER BY id DESC
     LIMIT 5`,
    [u.id]
  );

  const recent = recentResult.rows;

  if (u.role === "student") {
    const p = await profileBundle(u.id);

    if (!p) return bad(res, "Profile not found", 404);

    const recResult = await db.query(
      "SELECT status FROM recommendations WHERE student_id = $1",
      [u.id]
    );

    const recs = recResult.rows;

    return res.json({
      cgpa: p.cgpa,
      projects: p.projects.length,
      achievements: p.achievements.length,
      skills: p.profile.skills.length,
      verified: p.achievements.filter(a => a.status === "verified").length,
      needs_action:
        p.achievements.filter(a => a.status === "evidence_required").length +
        recs.filter(r => r.status === "more_info").length,
      recs_total: recs.length,
      recs_ready: recs.filter(r => r.status === "completed").length,
      recent
    });
  }

  if (u.role === "lecturer") {
    const rowsResult = await db.query(
      "SELECT status, deadline FROM recommendations WHERE lecturer_id = $1",
      [u.id]
    );

    const rows = rowsResult.rows;
    const open = rows.filter(r =>
      ["pending", "under_review", "approved"].includes(r.status)
    );

    const [assignedResult, pendingAchResult, verifiedAchResult,
      recAttentionResult, achAttentionResult] = await Promise.all([

      db.query(
        "SELECT COUNT(*) AS c FROM lecturer_assignments WHERE lecturer_id = $1",
        [u.id]
      ),

      db.query(
        `SELECT COUNT(*) AS c FROM achievements
         WHERE lecturer_id = $1
         AND status IN ('pending_verification', 'under_review')`,
        [u.id]
      ),

      db.query(
        `SELECT COUNT(*) AS c FROM achievements
         WHERE lecturer_id = $1 AND status = 'verified'`,
        [u.id]
      ),

      db.query(
        RECS_SQL + `
          WHERE r.lecturer_id = $1
          AND r.status IN ('pending', 'under_review', 'approved')
          ORDER BY r.id DESC
          LIMIT 6`,
        [u.id]
      ),

      db.query(
        `SELECT a.id, a.title, a.status, a.created_at,
                s.full_name AS student_name
         FROM achievements a
         JOIN users s ON s.id = a.user_id
         WHERE a.lecturer_id = $1
         AND a.status IN ('pending_verification', 'under_review')
         ORDER BY a.id DESC
         LIMIT 6`,
        [u.id]
      )
    ]);

    const attention = [
      ...recAttentionResult.rows.map(r => ({
        type: "Recommendation",
        title: r.purpose,
        student: r.student_name,
        status: r.status,
        date: r.created_at,
        link: `/lecturer/requests/${r.id}`
      })),

      ...achAttentionResult.rows.map(a => ({
        type: "Achievement",
        title: a.title,
        student: a.student_name,
        status: a.status,
        date: a.created_at,
        link: `/lecturer/achievements/${a.id}`
      }))
    ]
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 8);

    return res.json({
      assigned: Number(assignedResult.rows[0].c),
      pending_recs: open.length,
      completed_recs: rows.filter(r => r.status === "completed").length,
      pending_ach: Number(pendingAchResult.rows[0].c),
      verified_ach: Number(verifiedAchResult.rows[0].c),
      attention,
      recent
    });
  }

  const [usersResult, awaitingResult, recsResult, overdueResult,
    ageingResult, achPendingResult, achUnassignedResult] = await Promise.all([

    db.query("SELECT COUNT(*) AS c FROM users"),

    db.query("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'"),

    db.query("SELECT COUNT(*) AS c FROM recommendations"),

    db.query(
      `SELECT COUNT(*) AS c FROM recommendations
       WHERE status IN ('pending', 'under_review', 'approved', 'more_info')
       AND CASE WHEN pg_input_is_valid(deadline, 'date') THEN deadline::date < CURRENT_DATE ELSE FALSE END`
    ),

    db.query(
      `SELECT COUNT(*) AS c FROM recommendations
       WHERE status IN ('pending', 'under_review', 'approved', 'more_info')
       AND created_at < CURRENT_TIMESTAMP - INTERVAL '10 days'`
    ),

    db.query(
      `SELECT COUNT(*) AS c FROM achievements
       WHERE status IN ('pending_verification', 'under_review', 'evidence_required')`
    ),

    db.query(
      `SELECT COUNT(*) AS c FROM achievements
       WHERE lecturer_id IS NULL AND status != 'verified'`
    )
  ]);

  res.json({
    users: Number(usersResult.rows[0].c),
    awaiting: Number(awaitingResult.rows[0].c),
    recs: Number(recsResult.rows[0].c),
    overdue: Number(overdueResult.rows[0].c),
    ageing: Number(ageingResult.rows[0].c),
    ach_pending: Number(achPendingResult.rows[0].c),
    ach_unassigned: Number(achUnassignedResult.rows[0].c),
    recent
  });
}));

app.get("/api/lecturers", auth(), wrap(async (req, res) => {
  const result = await db.query(
    `SELECT u.id, u.full_name, u.faculty, u.specialisation,
            EXISTS(
              SELECT 1
              FROM lecturer_assignments a
              WHERE a.lecturer_id = u.id
                AND a.student_id = $1
            ) AS assigned
     FROM users u
     WHERE u.role = 'lecturer'
       AND u.status = 'active'
     ORDER BY assigned DESC, u.full_name`,
    [req.user.id]
  );

  res.json(result.rows);
}));

app.get("/api/students", auth("lecturer", "admin"), wrap(async (req, res) => {
  let query = `
    SELECT u.*
    FROM users u
    WHERE u.role = 'student'
      AND u.status = 'active'
  `;

  const params = [];

  if (req.user.role === "lecturer") {
    params.push(req.user.id);

    query += `
      AND (
        EXISTS (
          SELECT 1
          FROM lecturer_assignments a
          WHERE a.lecturer_id = $1
            AND a.student_id = u.id
        )
        OR EXISTS (
          SELECT 1
          FROM recommendations r
          WHERE r.lecturer_id = $1
            AND r.student_id = u.id
        )
      )
    `;
  }

  query += " ORDER BY u.full_name";

  const result = await db.query(query, params);

  const students = await Promise.all(
    result.rows.map(async (student) => ({
      ...pub(student),
      cgpa: await cgpaOf(student.id)
    }))
  );

  res.json(students);
}));

app.get("/api/students/:id/profile", auth("lecturer", "admin"), wrap(async (req, res) => {
  const studentId = Number(req.params.id);

  if (!Number.isInteger(studentId) || studentId <= 0) {
    return bad(res, "Invalid student ID", 400);
  }

  if (
    req.user.role === "lecturer" &&
    !(await lecturerCanSee(req.user.id, studentId))
  ) {
    return bad(
      res,
      "This student is not assigned to you and has not sent you a request",
      403
    );
  }

  const bundle = await profileBundle(studentId);

  if (!bundle || bundle.user.role !== "student") {
    return bad(res, "Student not found", 404);
  }

  if (req.user.role === "lecturer") {
    bundle.achievements = bundle.achievements.filter(
      (achievement) =>
        achievement.lecturer_id === req.user.id ||
        achievement.status === "verified"
    );
  }

  res.json(bundle);
}));
const RECS_SQL = `
  SELECT r.*,
         s.full_name AS student_name,
         s.programme AS student_programme,
         s.university_id AS student_uid,
         s.faculty AS student_faculty,
         l.full_name AS lecturer_name,
         GREATEST(0, CURRENT_DATE - r.created_at::date) AS age_days
  FROM recommendations r
  JOIN users s ON s.id = r.student_id
  JOIN users l ON l.id = r.lecturer_id
`;

const REC_OPEN_STATUSES = ["pending", "under_review", "approved"];

async function recommendationSideEffects(rec, student, lecturer, action, detail = null) {
  try {
    await audit(
      lecturer,
      "recommendation." + action,
      {
        type: "recommendation",
        id: rec.id,
        student: rec.student_id,
        decision: rec.status,
        comments: detail
      }
    );
  } catch (error) {
    console.error("Recommendation audit failed:", error.message);
  }

  if (!student || !lecturer) return;

  const messages = {
    approved: [
      "Recommendation request approved",
      `${lecturer.full_name} approved your request for: ${rec.purpose}.`
    ],
    declined: [
      "Recommendation request declined",
      `${lecturer.full_name} declined your request: ${detail}`
    ],
    more_info: [
      "More information required",
      `${lecturer.full_name} needs more information: ${detail}`
    ],
    completed: [
      "Recommendation letter ready",
      `${lecturer.full_name} completed your letter for: ${rec.purpose}.`
    ]
  };

  const message = messages[action];

  if (message) {
    try {
      await notify(
        student.id,
        message[0],
        message[1],
        "/student/recommendations",
        "recommendation"
      );
    } catch (error) {
      console.error("Recommendation notification failed:", error.message);
    }

    try {
      await mailRecUpdate(rec, student, lecturer, action, detail);
    } catch (error) {
      console.error("Recommendation email failed:", error.message);
    }
  }
}

app.get("/api/recommendations", auth(), wrap(async (req, res) => {
  let sql = RECS_SQL;
  let params = [];

  if (req.user.role === "student") {
    sql += " WHERE r.student_id = $1";
    params = [req.user.id];
  } else if (req.user.role === "lecturer") {
    sql += " WHERE r.lecturer_id = $1";
    params = [req.user.id];
  }

  sql += " ORDER BY r.id DESC";

  const result = await db.query(sql, params);

  const rows = result.rows.map((row) => {
    const output = {
      ...row,
      ref: "REC-" + (2040 + Number(row.id))
    };

    const letterVisible =
      req.user.role === "lecturer" ||
      (
        req.user.role === "student" &&
        row.status === "completed" &&
        row.release_to_student === true
      );

    if (!letterVisible) delete output.letter;

    return output;
  });

  res.json(rows);
}));

app.post("/api/recommendations", auth("student"), wrap(async (req, res) => {
  const body = req.body || {};
  const lecturerId = Number(body.lecturer_id);
  const purpose = String(body.purpose || "").trim();
  const message = String(body.message || "").trim();
  const deadline = body.deadline || null;

  if (!Number.isSafeInteger(lecturerId) || lecturerId <= 0 || !purpose) {
    return bad(res, "Choose a lecturer and a purpose");
  }

  if (purpose.length > 200 || message.length > 5000) {
    return bad(res, "The purpose or message is too long");
  }

  const lecturer = await getUser(lecturerId);

  if (!lecturer || lecturer.role !== "lecturer" || lecturer.status !== "active") {
    return bad(res, "Lecturer not found");
  }

  if (deadline && Number.isNaN(Date.parse(deadline))) {
    return bad(res, "Please provide a valid deadline");
  }

  const result = await db.query(
    `INSERT INTO recommendations
       (student_id, lecturer_id, purpose, deadline, message, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING *`,
    [req.user.id, lecturer.id, purpose, deadline, message]
  );

  const rec = result.rows[0];

  try {
    await notify(
      lecturer.id,
      "New recommendation request",
      `${req.user.full_name} requested a letter for: ${rec.purpose}.`,
      `/lecturer/requests/${rec.id}`,
      "recommendation"
    );
  } catch (error) {
    console.error("Recommendation request notification failed:", error.message);
  }

  try {
    await mailRecRequest(rec, req.user, lecturer);
  } catch (error) {
    console.error("Recommendation request email failed:", error.message);
  }

  try {
    await audit(req.user, "recommendation.requested", {
      type: "recommendation",
      id: rec.id,
      student: req.user.id,
      decision: "pending",
      comments: rec.purpose
    });
  } catch (error) {
    console.error("Recommendation request audit failed:", error.message);
  }

  res.json({ ok: true, id: rec.id });
}));

app.put("/api/recommendations/:id", auth("lecturer"), wrap(async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return bad(res, "Invalid recommendation request ID");
  }

  const result = await db.query(
    "SELECT * FROM recommendations WHERE id = $1",
    [id]
  );

  const rec = result.rows[0];

  if (!rec) return bad(res, "Request not found", 404);

  if (String(rec.lecturer_id) !== String(req.user.id)) {
    return bad(res, "This request was sent to a different lecturer", 403);
  }

  const { action, letter, reason, note, release } = req.body || {};
  const student = await getUser(rec.student_id);

  let updated;
  let auditAction;
  let detail = null;

  if (action === "start_review") {
    if (rec.status !== "pending") {
      return bad(res, "This request cannot be moved into review", 409);
    }

    auditAction = "review_started";

    updated = await db.query(
      `UPDATE recommendations
       SET status = 'under_review', updated_at = NOW()
       WHERE id = $1 AND lecturer_id = $2 AND status = 'pending'
       RETURNING *`,
      [id, req.user.id]
    );

  } else if (action === "approve") {
    if (!["pending", "under_review"].includes(rec.status)) {
      return bad(res, "This request cannot be approved from its current status", 409);
    }

    auditAction = "approved";

    updated = await db.query(
      `UPDATE recommendations
       SET status = 'approved', updated_at = NOW()
       WHERE id = $1 AND lecturer_id = $2
         AND status IN ('pending', 'under_review')
       RETURNING *`,
      [id, req.user.id]
    );

  } else if (action === "decline") {
    if (!REC_OPEN_STATUSES.includes(rec.status)) {
      return bad(res, "This request can no longer be declined", 409);
    }

    detail = String(reason || "").trim();

    if (detail.length < 10) {
      return bad(res, "Please give a reason for declining (at least 10 characters)");
    }

    auditAction = "declined";

    updated = await db.query(
      `UPDATE recommendations
       SET status = 'declined', decline_reason = $1, updated_at = NOW()
       WHERE id = $2 AND lecturer_id = $3
         AND status IN ('pending', 'under_review', 'approved')
       RETURNING *`,
      [detail, id, req.user.id]
    );

  } else if (action === "more_info") {
    if (!["pending", "under_review"].includes(rec.status)) {
      return bad(res, "More information can only be requested before approving", 409);
    }

    detail = String(note || "").trim();

    if (detail.length < 10) {
      return bad(res, "Tell the student what information you need (at least 10 characters)");
    }

    auditAction = "more_info_requested";

    updated = await db.query(
      `UPDATE recommendations
       SET status = 'more_info', info_request = $1, updated_at = NOW()
       WHERE id = $2 AND lecturer_id = $3
         AND status IN ('pending', 'under_review')
       RETURNING *`,
      [detail, id, req.user.id]
    );

  } else if (action === "save_draft") {
    if (rec.status !== "approved") {
      return bad(res, "Approve the request before writing the letter", 409);
    }

    const draft = String(letter || "");

    if (draft.length > 30000) {
      return bad(res, "The recommendation letter is too long");
    }

    auditAction = "draft_saved";

    updated = await db.query(
      `UPDATE recommendations
       SET letter = $1, updated_at = NOW()
       WHERE id = $2 AND lecturer_id = $3 AND status = 'approved'
       RETURNING *`,
      [draft, id, req.user.id]
    );

  } else if (action === "submit") {
    if (rec.status !== "approved") {
      return bad(res, "Approve the request before submitting the letter", 409);
    }

    const finalLetter = String(letter || "").trim();

    if (finalLetter.length < 30) {
      return bad(res, "Write the letter before submitting (at least 30 characters)");
    }

    if (finalLetter.length > 30000) {
      return bad(res, "The recommendation letter is too long");
    }

    const releaseToStudent = release !== false && release !== 0;

    auditAction = "completed";
    detail = releaseToStudent ? "released to student" : "not released to student";

    updated = await db.query(
      `UPDATE recommendations
       SET status = 'completed',
           letter = $1,
           release_to_student = $2,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $3 AND lecturer_id = $4 AND status = 'approved'
       RETURNING *`,
      [finalLetter, releaseToStudent, id, req.user.id]
    );

  } else {
    return bad(res, "Unknown action");
  }

  if (!updated || !updated.rows[0]) {
    return bad(res, "The request changed before your update could be saved. Refresh and try again.", 409);
  }

  const saved = updated.rows[0];

  if (["approved", "declined", "more_info", "completed"].includes(action)) {
    await recommendationSideEffects(saved, student, req.user, action, detail);
  } else {
    try {
      await audit(req.user, "recommendation." + auditAction, {
        type: "recommendation",
        id: saved.id,
        student: saved.student_id,
        decision: saved.status,
        comments: detail
      });
    } catch (error) {
      console.error("Recommendation audit failed:", error.message);
    }
  }

  res.json({ ok: true, status: saved.status });
}));

app.put("/api/recommendations/:id/info", auth("student"), wrap(async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return bad(res, "Invalid recommendation request ID");
  }

  const result = await db.query(
    `SELECT * FROM recommendations
     WHERE id = $1 AND student_id = $2`,
    [id, req.user.id]
  );

  const rec = result.rows[0];

  if (!rec) return bad(res, "Request not found", 404);

  if (rec.status !== "more_info") {
    return bad(res, "No extra information was requested", 409);
  }

  const additionalMessage = String((req.body || {}).message || "").trim();

  if (!additionalMessage) {
    return bad(res, "Write your reply");
  }

  if (additionalMessage.length > 5000) {
    return bad(res, "Your reply is too long");
  }

  const combinedMessage =
    `${rec.message || ""}\n\nStudent update (${today()}): ${additionalMessage}`.trim();

  const updated = await db.query(
    `UPDATE recommendations
     SET message = $1, status = 'pending', updated_at = NOW()
     WHERE id = $2 AND student_id = $3 AND status = 'more_info'
     RETURNING *`,
    [combinedMessage, id, req.user.id]
  );

  if (!updated.rows[0]) {
    return bad(res, "The request changed before your reply could be saved. Refresh and try again.", 409);
  }

  try {
    await notify(
      rec.lecturer_id,
      "Student added information",
      `${req.user.full_name} added details to request REC-${2040 + Number(rec.id)}.`,
      `/lecturer/requests/${rec.id}`,
      "recommendation"
    );
  } catch (error) {
    console.error("Student information notification failed:", error.message);
  }

  try {
    await audit(req.user, "recommendation.info_added", {
      type: "recommendation",
      id: rec.id,
      student: req.user.id,
      comments: additionalMessage
    });
  } catch (error) {
    console.error("Recommendation information audit failed:", error.message);
  }

  res.json({ ok: true, status: "pending" });
}));
/* =========================
   NOTIFICATION ROUTES
========================= */

app.get("/api/notifications", auth(), wrap(async (req, res) => {
  const result = await db.query(
    `SELECT *
     FROM notifications
     WHERE user_id = $1
     ORDER BY id DESC
     LIMIT 100`,
    [req.user.id]
  );

  res.json(result.rows);
}));

app.post("/api/notifications/read-all", auth(), wrap(async (req, res) => {
  await db.query(
    `UPDATE notifications
     SET is_read = TRUE
     WHERE user_id = $1`,
    [req.user.id]
  );

  res.json({ ok: true });
}));

app.put("/api/notifications/:id/read", auth(), wrap(async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return bad(res, "Invalid notification ID");
  }

  await db.query(
    `UPDATE notifications
     SET is_read = TRUE
     WHERE id = $1 AND user_id = $2`,
    [id, req.user.id]
  );

  res.json({ ok: true });
}));
/* =========================
   USER SETTINGS ROUTES
========================= */

app.get("/api/me/settings", auth(), wrap(async (req, res) => {
  await ensureExtras(req.user.id);

  const result = await db.query(
    `SELECT email_notifications, deadline_reminders
     FROM settings
     WHERE user_id = $1`,
    [req.user.id]
  );

  res.json(result.rows[0] || {
    email_notifications: true,
    deadline_reminders: true
  });
}));

app.put("/api/me/settings", auth(), wrap(async (req, res) => {
  await ensureExtras(req.user.id);

  const body = req.body || {};

  await db.query(
    `UPDATE settings
     SET email_notifications = $1,
         deadline_reminders = $2
     WHERE user_id = $3`,
    [
      body.email_notifications === true,
      body.deadline_reminders === true,
      req.user.id
    ]
  );

  res.json({ ok: true });
}));
app.get("/api/files/:id", auth(), wrap(async (req, res) => {
  const result = await db.query(
    `SELECT f.*, a.user_id, a.lecturer_id
     FROM achievement_files f
     JOIN achievements a ON a.id = f.achievement_id
     WHERE f.id = $1`,
    [req.params.id]
  );

  const file = result.rows[0];

  if (!file) {
    return bad(res, "File not found", 404);
  }

  const permitted =
    req.user.role === "admin" ||
    (req.user.role === "student" && String(file.user_id) === String(req.user.id)) ||
    (req.user.role === "lecturer" && String(file.lecturer_id) === String(req.user.id));

  if (!permitted) {
    return bad(res, "You do not have permission to access this file", 403);
  }

  const filePath = path.resolve(UPLOAD_DIR, file.stored_name);

  if (!filePath.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(filePath)) {
    return bad(res, "File is unavailable", 404);
  }

  res.type(file.mime || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${String(file.original_name || "evidence").replace(/["\\\r\n]/g, "_")}"`
  );

  res.sendFile(filePath);
}));











// =========================
// POSTGRESQL ACADEMIC MODULE
// =========================
require("./academics.postgres")(app, {
  db,
  auth,
  wrap,
  bad,
  audit,
  notify
});

// =========================
// HEALTH CHECK
// =========================
app.get("/api/health", wrap(async (req, res) => {
  await db.query("SELECT 1");
  res.json({ ok: true, database: "connected" });
}));

// =========================
// API NOT FOUND
// =========================
app.use("/api", (req, res) => {
  return bad(res, "Not found", 404);
});

// =========================
// ERROR HANDLER
// =========================
app.use((err, req, res, next) => {
  console.error("StudentSphere server error:", err);

  if (res.headersSent) {
    return next(err);
  }

  return bad(
    res,
    process.env.NODE_ENV === "production"
      ? "An unexpected server error occurred"
      : (err.message || "An unexpected server error occurred"),
    err.status || 500
  );
});

// =========================
// SERVER STARTUP
// =========================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `StudentSphere running at http://localhost:${PORT} (email mode: ${mailMode()})`
    );
  });
}

module.exports = app;
