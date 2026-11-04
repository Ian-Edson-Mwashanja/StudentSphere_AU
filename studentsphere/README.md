# StudentSphere — Africa University portal (v2: verification + email)

Student, Lecturer and Admin portals. Node.js + Express + SQLite, plain HTML/CSS/JavaScript front end.

## 1. Run it
    npm install        (needed again once: v2 adds the "nodemailer" package)
    npm start
Open http://localhost:3000

### Upgrading your existing v1 folder (keeps your data)
1. Stop the server. Make a copy of `studentsphere.db` (your backup).
2. Copy these over your project, replacing the old ones: `server.js`, `db.js`, `mailer.js`, `package.json`,
   `.env.example`, and the whole `public/js` folder, plus `public/css/styles.css` if you did not change it.
   Keep your `public/img/logo.png` and your `studentsphere.db`.
3. `npm install` then `npm start`.
The database upgrades itself on start (see "Database changes"). Nothing is deleted.

## 2. Demo accounts
| Role | Login | Password |
|---|---|---|
| Student | ian@student.africau.edu | Student@123 |
| Lecturer (Dr. Mercy Dube) | mdube@africau.edu | Lecturer@123 |
| Lecturer (Prof. J. Ncube) | jncube@africau.edu | Lecturer@123 |
| Admin | mwashanjai@africau.edu | Admin@12345 |
New sign-ups wait for Admin -> Account approvals. Ian is assigned to Dr. Dube (primary) and Prof. Ncube.

## 3. Email setup
**Default = DEV mode (no credentials needed).** Nothing is really sent. Every email is saved and you can read the
full HTML in **Admin -> Email log** (click a row). Use this to test the whole workflow.

**To send real emails:**
1. Copy `.env.example` to a new file named `.env` (same folder as server.js).
2. Fill in your mail server. Gmail example (needs 2-step verification, then create an "App password"):
       SMTP_HOST=smtp.gmail.com
       SMTP_PORT=587
       SMTP_SECURE=false
       SMTP_USER=yourname@gmail.com
       SMTP_PASS=your-16-character-app-password
       MAIL_FROM=StudentSphere <yourname@gmail.com>
       APP_URL=http://localhost:3000        (use your real website address once deployed)
3. Restart the server. The Email log banner changes to "SMTP mode". Click **Send a test email to me**.
Other providers (Brevo, Mailgun, SendGrid SMTP, your university mail server) work the same way.
Passwords/keys are read only from `.env` / environment variables — never from the source code. `.env` is git-ignored.
Users can switch off emails in Settings (account-approval emails are always sent).

## 4. What was added
- **Recommendations:** student request -> lecturer email + notification; lecturer opens it (Under Review), reviews the full
  profile (GPA/CGPA by year, skills, projects, achievements + certificates), then Approve / Decline (reason) / Request more
  information. After approval: write, edit, save draft, submit, with a choice to release the letter to the student.
  Statuses: Pending, Under Review, Approved, Declined, More Information Required, Completed. Student gets an in-app
  notification and an email for every lecturer action.
- **Achievements:** students add title, category, description, organisation, date, certificate and extra evidence files
  (PDF/PNG/JPG, max 3 files x 4 MB). Saved as Pending Verification. Lecturer gets an email; reviews in
  **Achievement Verification**; can Verify, Reject (reason code + explanation required) or Request additional evidence.
  Only a lecturer decision creates the VERIFIED badge; students cannot change status.
- **Accounts:** admin is emailed on new registrations; users are emailed on approval/rejection.
- **Lecturer dashboard:** 5 summary cards, requests needing attention, recent activity; menu: Dashboard, My Profile,
  Student Profiles, Recommendation Requests, Achievement Verification, Completed Recommendations, Notifications, Settings, Log out.
- **Admin:** Lecturer assignments, Achievement verification monitor, Email log, Audit trail, extended Reports.
- **Security:** role checks on every API route, per-record ownership checks (a lecturer only sees students assigned to them or who
  sent them something; only the addressed lecturer can decide), evidence files stored outside the public folder and served only to
  the owner / addressed lecturer / admin, upload type checked by file signature, login rate limiting, audit log.

## 5. Database changes (automatic on start)
| Change | Details |
|---|---|
| `recommendations` rebuilt | Same rows copied. New statuses (approved, declined) + columns decline_reason, info_request, release_to_student, updated_at. This table is the "RecommendationRequests + Recommendations" in one. |
| `achievements` extended | + organisation, date_obtained, evidence_note, status, lecturer_id, reviewer_comment, reason_code, evidence_request, student_response, reviewed_at, created_at. Old achievements become **Pending Verification** (they are not assumed genuine) and go to the student's primary lecturer. |
| `notifications` extended | + link, type (NotificationHistory) |
| NEW `lecturer_assignments` | student <-> lecturer (one marked primary) |
| NEW `achievement_files` | uploaded evidence (files live in the `uploads/` folder) |
| NEW `achievement_verifications` | every verification action: lecturer, student, action, decision, comments, time |
| NEW `audit_log` | important actions across the system |
| NEW `email_log` | EmailNotifications: every email, status (dev/sent/failed/skipped), full HTML |
No tables are dropped except the temporary copy used while rebuilding `recommendations`.

## 6. Testing each role
- Student: login -> Recommendations -> send request; Achievements -> Add achievement with a PDF.
- Lecturer: Dashboard -> open the request / achievement (or use the link in the email) -> act.
- Admin: Email log (preview every email), Audit trail, Lecturer assignments.
- Back as the student: notifications, statuses, VERIFIED badge on the profile, letter download (print -> Save as PDF).

## 7. Still needs you
- Real SMTP credentials (or stay in dev mode) and the final `APP_URL` so email links point to your live site.
- Set `JWT_SECRET`, remove the demo-accounts text in `public/js/auth.js`, change the seeded passwords in `db.js`.
- Host with a persistent disk (SQLite file + `uploads/` folder) and back both up.
- University policies are coded as sensible defaults (4 MB limit, 3 files, letter release switch). Adjust to your rules.
- Password reset by email is not built yet.
