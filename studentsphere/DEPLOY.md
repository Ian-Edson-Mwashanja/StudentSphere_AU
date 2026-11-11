# StudentSphere Deployment Guide

## Deployment Architecture

StudentSphere uses:
- Render to host the Express application and frontend.
- Supabase PostgreSQL to store application data.
- Render Persistent Disk to store uploaded achievement evidence.
- SMTP to send password reset and notification emails.

The application entry point is `server.pg.js`.

## 1. GitHub

Push the application source code to the configured GitHub repository.

Do not commit:
- `.env`
- Database passwords or connection strings
- JWT secrets
- SMTP passwords
- Supabase service-role keys

## 2. Supabase Database

1. Open the Supabase project.
2. Obtain the PostgreSQL connection string.
3. Configure `DATABASE_URL` in Render.
4. Keep the database connection string private.

StudentSphere uses the `studentsphere` PostgreSQL schema.

Do not reset or delete production database records during deployment. Preserve the existing administrator account and academic data.

## 3. Render Deployment

The repository contains `studentsphere/render.yaml`.

Create or update the Render Blueprint using the GitHub repository.

The Blueprint configures:
- Application root: `studentsphere`
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`
- Persistent upload directory: `/var/data/uploads`

Configure these environment variables in Render:

| Variable | Value |
|---|---|
| NODE_ENV | production |
| NODE_VERSION | 20 |
| DATABASE_URL | Supabase PostgreSQL connection string |
| JWT_SECRET | A long, randomly generated secret |
| APP_URL | Public Render application URL |
| UPLOAD_DIR | /var/data/uploads |
| MAIL_MODE | smtp when SMTP is configured |
| SMTP_HOST | Your email provider SMTP host |
| SMTP_PORT | Your email provider SMTP port |
| SMTP_SECURE | According to your SMTP provider |
| SMTP_USER | Your SMTP username |
| SMTP_PASS | Your SMTP password |
| MAIL_FROM | Your verified sender address |

Never put private credentials in frontend files or commit them to GitHub.

If SMTP is not configured, use development email mode only for local testing.

## 4. Verify Deployment

After deployment, open:

`https://studentsphere-au.onrender.com/api/health`

The expected response is:

`{"ok":true,"database":"connected"}`

Then test:
- Administrator login.
- Student and lecturer registration pages.
- Dashboard access and role permissions.
- Password reset email workflow.
- Student and lecturer management.
- Results and GPA management.
- Recommendation requests.
- Achievement submission and verification.
- Evidence uploads.

## 5. Database and Account Safety

- Preserve the existing administrator account.
- Do not import the old 30 student records.
- Do not create demonstration student or lecturer accounts.
- Keep the existing student roster unchanged unless an authorised update is requested.
- Back up the database and uploaded evidence regularly.

## 6. Email Configuration

Configure SMTP credentials as private Render environment variables.

Set `APP_URL` to the public application address so password reset links point to the deployed application.

Test password reset using an authorised account.

## 7. Local Development

From the `studentsphere` directory:

Install dependencies:

`npm install`

Start the application:

`npm start`

The local application normally runs at:

`http://localhost:3000`

Use a private local `.env` file for development configuration.
