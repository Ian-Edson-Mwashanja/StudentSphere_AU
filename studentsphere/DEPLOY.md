# Deploying StudentSphere (Netlify + backend) and the student list

## Why not Netlify alone?
Netlify hosts static files and short-lived serverless functions. StudentSphere is a long-running Express server that
keeps an SQLite file (`studentsphere.db`) and uploaded evidence in `uploads/`. On Netlify those would be wiped
on every deploy/cold start. So: **backend on a host with a persistent disk, website on Netlify** (Netlify forwards /api to the backend).
(Prefer one service? Deploy just the backend on Render - it also serves the website. Skip steps 3-4.)

## 1. Push to GitHub
`.gitignore` already excludes `.env`, the database and `uploads`.

## 2. Backend on Render (Blueprint)
1. render.com -> New -> Blueprint -> pick the repo (it reads `render.yaml`). Check current pricing: the disk needs a paid instance.
2. When asked, set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `APP_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Get the service-role key from Supabase Dashboard -> Project Settings -> API Keys. Keep it secret and only add it to Render environment variables.
3. Open `https://<name>.onrender.com/api/health` - you should see `{"ok":true}`.
First start creates only your admin account (no demo users). Add SMTP_* variables later for real emails.
Railway or Fly.io work the same way: any host with a persistent volume. Point `DB_FILE` and `UPLOAD_DIR` at the volume.

## 3. Website on Netlify
1. Edit `netlify.toml`: replace `YOUR-BACKEND.onrender.com` with your backend address.
2. app.netlify.com -> Add new site -> Import from Git -> same repo. No build command; publish directory `public`.
3. Because Netlify proxies /api, the front end needs no code changes and there are no CORS problems.

## 4. Finish
- Set `APP_URL` on the backend to your Netlify address so email links are right.
- Log in as the admin and change nothing else: the demo accounts do not exist in production.
- Back up the disk (database + uploads) regularly.

## Student list feature
Admin -> **Student list** -> Upload spreadsheet (.xlsx or .csv). Supabase table: `student_roster`. Expected CSV columns: `StudentID, FullName, Email, College, Programme, YearOfStudy, Status`. The ID column should be a six-digit number and the primary key. Use active/inactive status values.
- Student sign-up looks up the six-digit Student ID in the Supabase `student_roster` table. The official full name, college, programme, year and university email are applied by the backend; the browser receives only a masked email.
  The server applies the official record itself, so a student cannot change those fields by editing the page. The service-role key must never be placed in frontend code.
- Re-uploading updates existing students (blank cells never erase existing data).
- `REQUIRE_ROSTER=true` -> only active IDs in the Supabase `student_roster` table can register. The Render blueprint enables this by default.
- `AUTO_APPROVE_ROSTER=false` keeps new accounts pending administrator approval. Keep this setting false until you implement a secure email verification step; a Student ID alone is not proof of identity.
- The sign-up lookup is public but rate-limited (30 per 10 min per IP) and returns no email, phone or marks.

## Files changed
roster.js (new), db.js, server.js, public/js/{admin,auth,app}.js, package.json, netlify.toml, render.yaml, .env.example.
