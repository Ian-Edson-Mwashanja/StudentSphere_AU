// Database setup, SAFE MIGRATIONS (existing data is kept) and demo data.
// SQLite file: studentsphere.db (override with DB_FILE).
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(process.env.DB_FILE || path.join(__dirname, 'studentsphere.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------- base tables (created only if missing)
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('student','lecturer','admin')),
  full_name TEXT NOT NULL,
  university_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  faculty TEXT, programme TEXT, year_of_study TEXT, specialisation TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline TEXT, about TEXT, skills TEXT DEFAULT '[]', phone TEXT, location TEXT,
  linkedin TEXT, github TEXT, experience TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, tech TEXT, url TEXT
);
CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, category TEXT, description TEXT, year TEXT
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year_label TEXT NOT NULL, academic_year TEXT, gpa REAL, standing TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT, is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_notifications INTEGER DEFAULT 1, deadline_reminders INTEGER DEFAULT 1
);
`);

// ---------------------------------------------------------------- recommendations (request + letter in one table)
const RECS_DDL = (name) => `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lecturer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL, deadline TEXT, message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','under_review','approved','declined','more_info','completed')),
  letter TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT,
  decline_reason TEXT, info_request TEXT, release_to_student INTEGER DEFAULT 1, updated_at TEXT
)`;
const recSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='recommendations'").get();
if (!recSql) {
  db.exec(RECS_DDL('recommendations'));
} else if (!recSql.sql.includes('declined')) {
  // Old table only allowed 4 statuses. Rebuild it with the new statuses and copy every row across.
  db.pragma('foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE recommendations RENAME TO recommendations_old');
    db.exec(RECS_DDL('recommendations'));
    db.exec(`INSERT INTO recommendations (id,student_id,lecturer_id,purpose,deadline,message,status,letter,created_at,completed_at)
             SELECT id,student_id,lecturer_id,purpose,deadline,message,status,letter,created_at,completed_at FROM recommendations_old`);
    db.exec('DROP TABLE recommendations_old');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  db.pragma('foreign_keys = ON');
  console.log('Migrated recommendations table to the new status list.');
}

// ---------------------------------------------------------------- additive migrations on existing tables
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const addCol = (t, c, def) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };

addCol('achievements', 'organisation', 'TEXT');
addCol('achievements', 'date_obtained', 'TEXT');
addCol('achievements', 'evidence_note', 'TEXT');
addCol('achievements', 'status', "TEXT DEFAULT 'pending_verification'");
addCol('achievements', 'lecturer_id', 'INTEGER');
addCol('achievements', 'reviewer_comment', 'TEXT');
addCol('achievements', 'reason_code', 'TEXT');
addCol('achievements', 'evidence_request', 'TEXT');
addCol('achievements', 'student_response', 'TEXT');
addCol('achievements', 'reviewed_at', 'TEXT');
addCol('achievements', 'created_at', 'TEXT');
db.exec("UPDATE achievements SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL");
db.exec("UPDATE achievements SET status = 'pending_verification' WHERE status IS NULL");
addCol('notifications', 'link', 'TEXT');
addCol('notifications', 'type', 'TEXT');

// ---------------------------------------------------------------- new tables
db.exec(`
CREATE TABLE IF NOT EXISTS lecturer_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lecturer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary INTEGER DEFAULT 0,
  assigned_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, lecturer_id)
);
CREATE TABLE IF NOT EXISTS achievement_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  achievement_id INTEGER NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  kind TEXT DEFAULT 'certificate',
  original_name TEXT, stored_name TEXT NOT NULL, mime TEXT, size INTEGER,
  uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS achievement_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  achievement_id INTEGER, lecturer_id INTEGER, student_id INTEGER,
  action TEXT NOT NULL, decision TEXT, comments TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER, actor_role TEXT, action TEXT NOT NULL,
  entity_type TEXT, entity_id INTEGER, student_id INTEGER,
  decision TEXT, comments TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS student_roster (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL, email TEXT, faculty TEXT, programme TEXT, year_of_study TEXT,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_user_id INTEGER, to_email TEXT, subject TEXT, template TEXT,
  status TEXT, error TEXT, body_html TEXT, related_type TEXT, related_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Existing achievements that have no lecturer yet go to the student's primary assigned lecturer (if any).
function routeUnassignedAchievements() {
  db.exec(`UPDATE achievements SET lecturer_id = (
      SELECT lecturer_id FROM lecturer_assignments WHERE student_id = achievements.user_id ORDER BY is_primary DESC, id LIMIT 1)
    WHERE lecturer_id IS NULL AND status IN ('pending_verification','under_review')`);
}

// ---------------------------------------------------------------- demo data (fresh database only)
// Production: SEED_DEMO=false creates ONE admin from ADMIN_EMAIL / ADMIN_PASSWORD (no demo accounts, no demo passwords).
function seedAdminFromEnv() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) { console.warn('SEED_DEMO=false but ADMIN_EMAIL / ADMIN_PASSWORD are not set: no admin was created.'); return; }
  const id = db.prepare(`INSERT INTO users (role, full_name, university_id, email, password_hash, status) VALUES ('admin',?,?,?,?, 'active')`)
    .run(process.env.ADMIN_NAME || 'System Administrator', process.env.ADMIN_ID || 'AU-ADMIN-001', ADMIN_EMAIL.trim().toLowerCase(), bcrypt.hashSync(ADMIN_PASSWORD, 10)).lastInsertRowid;
  db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(id);
  db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(id);
  console.log('Created the administrator account from environment variables.');
}

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  if (String(process.env.SEED_DEMO).toLowerCase() === 'false') return seedAdminFromEnv();
  const hash = (p) => bcrypt.hashSync(p, 10);
  const addUser = db.prepare(`INSERT INTO users
    (role, full_name, university_id, email, password_hash, status, faculty, programme, year_of_study, specialisation)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const admin = addUser.run('admin', 'System Administrator', 'AU-ADMIN-001', 'mwashanjai@africau.edu', hash('Admin@12345'), 'active', null, null, null, null).lastInsertRowid;
  const dube = addUser.run('lecturer', 'Dr. Mercy Dube', 'AU-STAFF-0042', 'mdube@africau.edu', hash('Lecturer@123'), 'active', 'College of Engineering', null, null, 'Software architecture, distributed systems and student mentorship').lastInsertRowid;
  const ncube = addUser.run('lecturer', 'Prof. J. Ncube', 'AU-STAFF-0033', 'jncube@africau.edu', hash('Lecturer@123'), 'active', 'College of Engineering', null, null, 'Databases and information systems').lastInsertRowid;
  addUser.run('lecturer', 'Dr. P. Moyo', 'AU-STAFF-0061', 'pmoyo@africau.edu', hash('Lecturer@123'), 'pending', 'College of Engineering', null, null, 'Networks and security');
  const ian = addUser.run('student', 'Ian Edson Mwashanja', 'AU-SE-2025-0142', 'ian@student.africau.edu', hash('Student@123'), 'active', 'College of Engineering', 'Software Engineering', 'Year 3', null).lastInsertRowid;
  const tariro = addUser.run('student', 'Tariro Tekwa', 'AU-CS-2025-0108', 'tariro@student.africau.edu', hash('Student@123'), 'pending', 'College of Engineering', 'Computer Science', 'Year 3', null).lastInsertRowid;

  const addProfile = db.prepare('INSERT INTO profiles (user_id, headline, about, skills, phone, location, linkedin, github, experience) VALUES (?,?,?,?,?,?,?,?,?)');
  addProfile.run(admin, 'University systems administrator', '', '[]', '', 'Mutare, Zimbabwe', '', '', '');
  addProfile.run(dube, 'Senior Lecturer, Software Engineering', 'I teach software architecture and distributed systems, and I mentor final-year students on their capstone projects.', '[]', '', 'Mutare, Zimbabwe', '', '', '');
  addProfile.run(ncube, 'Professor, Information Systems', 'Databases and information systems.', '[]', '', 'Mutare, Zimbabwe', '', '', '');
  addProfile.run(ian, 'Software Engineering student', 'Curious by nature. Driven by possibility. I build practical web and mobile systems and enjoy learning in teams.',
    JSON.stringify(['HTML', 'CSS', 'JavaScript', 'C#', 'SQL', 'Database management', 'Git/GitHub']),
    '', 'Mutare, Zimbabwe', '', 'https://github.com/', 'Supported the delivery of accessible web interfaces, collaborated with a small development team, and used Git for version control.');
  addProfile.run(tariro, 'Computer Science student', '', '[]', '', '', '', '', '');

  const asg = db.prepare('INSERT INTO lecturer_assignments (student_id, lecturer_id, is_primary) VALUES (?,?,?)');
  asg.run(ian, dube, 1); asg.run(ian, ncube, 0); asg.run(tariro, dube, 1);

  db.prepare('INSERT INTO projects (user_id,title,description,tech,url) VALUES (?,?,?,?,?)').run(ian, 'Student Profile Website', 'A responsive personal portfolio that presents student skills, education, projects, and contact details.', 'HTML5, CSS3, JavaScript', '');
  db.prepare('INSERT INTO projects (user_id,title,description,tech,url) VALUES (?,?,?,?,?)').run(ian, 'Student Management System', 'A concept system for organising student records, academic information, and programme details.', 'C#, SQL, UI Design', '');

  const ach = db.prepare(`INSERT INTO achievements (user_id,title,category,description,year,organisation,date_obtained,status,lecturer_id,reviewed_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
  const a1 = ach.run(ian, 'Coding Club Coordinator', 'Leadership position', 'Organised weekly peer-learning sessions.', '2025', 'Africa University Coding Club', '2025-02-01', 'verified', dube, new Date().toISOString()).lastInsertRowid;
  ach.run(ian, "Dean's List", 'Academic award', 'Recognised for strong academic performance.', '2025', 'Africa University', '2025-06-30', 'pending_verification', dube, null);
  db.prepare("INSERT INTO achievement_verifications (achievement_id,lecturer_id,student_id,action,decision,comments) VALUES (?,?,?,?,?,?)").run(a1, dube, ian, 'verify', 'verified', 'Confirmed with the club register.');

  const addRes = db.prepare('INSERT INTO results (user_id,year_label,academic_year,gpa,standing) VALUES (?,?,?,?,?)');
  addRes.run(ian, 'Year 1', '2023', 3.4, "Dean's list");
  addRes.run(ian, 'Year 2', '2024', 3.5, "Dean's list");
  addRes.run(ian, 'Year 3', '2025', 3.7, "Dean's list");
  addRes.run(ian, 'Year 4', 'Projected', 3.8, 'On track');
  addRes.run(tariro, 'Year 1', '2023', 3.1, 'Good standing');

  const rec = db.prepare('INSERT INTO recommendations (student_id,lecturer_id,purpose,deadline,message,status,letter,completed_at) VALUES (?,?,?,?,?,?,?,?)');
  rec.run(ian, dube, 'Internship', '2026-11-18', 'Applying for a software internship.', 'completed',
    'I am pleased to recommend Ian Edson Mwashanja, a Software Engineering student at Africa University. Ian has consistently shown initiative, strong technical ability and a willingness to support his peers. I recommend him without reservation.', new Date().toISOString());
  rec.run(ian, ncube, 'Postgraduate Studies', '2026-12-10', 'Please highlight my database coursework.', 'pending', null, null);

  const note = db.prepare('INSERT INTO notifications (user_id,title,body,is_read,type) VALUES (?,?,?,0,?)');
  note.run(ian, 'Recommendation letter ready', 'Dr. Mercy Dube completed your academic recommendation.', 'recommendation');
  note.run(dube, 'New recommendation request', 'Ian Edson Mwashanja requested a letter.', 'recommendation');
  note.run(admin, 'Account awaiting approval', 'Tariro Tekwa registered as a student.', 'account');

  const set = db.prepare('INSERT INTO settings (user_id) VALUES (?)');
  [admin, dube, ncube, ian, tariro].forEach((id) => set.run(id));
  console.log('Seeded demo data.');
}
seed();

// Upgrade path: an older database with the demo accounts but no assignments yet.
(function demoAssignmentsForUpgrades() {
  if (db.prepare('SELECT COUNT(*) c FROM lecturer_assignments').get().c > 0) return;
  const s = db.prepare("SELECT id FROM users WHERE email='ian@student.africau.edu'").get();
  const l = db.prepare("SELECT id FROM users WHERE email='mdube@africau.edu'").get();
  if (s && l) db.prepare('INSERT OR IGNORE INTO lecturer_assignments (student_id, lecturer_id, is_primary) VALUES (?,?,1)').run(s.id, l.id);
})();
routeUnassignedAchievements();

module.exports=db;
module.exports.routeUnassignedAchievements = routeUnassignedAchievements;
