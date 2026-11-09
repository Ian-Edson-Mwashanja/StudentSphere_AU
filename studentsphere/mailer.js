// StudentSphere PostgreSQL email system.
//
// MAIL_MODE=dev:
// Emails are logged in PostgreSQL but not sent.
//
// MAIL_MODE=smtp:
// Emails are sent using Nodemailer.
//
// Credentials are read from environment variables.

const postgres = require('./postgres');

let nodemailer = null;

try {
  nodemailer = require('nodemailer');
} catch (error) {
  // Nodemailer is only required in SMTP mode.
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));

const appUrl = () =>
  (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`)
    .replace(/\/$/, '');

const mode = () =>
  (process.env.MAIL_MODE || (process.env.SMTP_HOST ? 'smtp' : 'dev'))
    .toLowerCase();

const fromAddress = () =>
  process.env.MAIL_FROM || 'StudentSphere <no-reply@studentsphere.local>';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!nodemailer) {
    throw new Error('Nodemailer is not installed.');
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      : undefined
  });

  return transporter;
}

// Consistent StudentSphere email design.
function renderHtml({
  heading,
  greeting,
  intro,
  rows = [],
  paragraphs = [],
  action,
  closing
}) {
  const rowHtml = rows
    .filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== '')
    .map(([k, v]) => `
      <tr>
        <td style="padding:8px 12px;color:#6b6b6b;font-size:13px;width:38%;border-bottom:1px solid #eee">
          ${esc(k)}
        </td>
        <td style="padding:8px 12px;font-size:14px;font-weight:600;border-bottom:1px solid #eee">
          ${esc(v)}
        </td>
      </tr>
    `)
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="margin:0;background:#f4f4f5;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0a0a0a">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr>
<td align="center" style="padding:24px 12px">

<table role="presentation" width="600" cellpadding="0" cellspacing="0"
style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e8e8ea">

<tr>
<td style="background:#0a0a0a;padding:22px 26px">
<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#c8102e;margin-right:8px"></span>

<span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-.02em">
StudentSphere
</span>

<div style="color:#bdbdbd;font-size:12px;margin-top:4px">
Africa University · Your Academic Journey. Connected.
</div>
</td>
</tr>

<tr>
<td style="padding:28px 26px 8px">

<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#c8102e;font-weight:700">
Notification
</div>

<h1 style="margin:6px 0 14px;font-size:24px;line-height:1.2">
${esc(heading)}
</h1>

<p style="margin:0 0 10px;font-size:15px;line-height:1.6;font-weight:600">
${esc(greeting)}
</p>

<p style="margin:0 0 14px;font-size:15px;line-height:1.6">
${esc(intro)}
</p>

</td>
</tr>

${rowHtml ? `
<tr>
<td style="padding:0 26px 8px">
<table width="100%" cellpadding="0" cellspacing="0"
style="border:1px solid #eee;border-radius:10px;border-collapse:separate">
${rowHtml}
</table>
</td>
</tr>
` : ''}

<tr>
<td style="padding:8px 26px 4px">
${paragraphs.map((p) => `
<p style="margin:12px 0;font-size:14px;line-height:1.6;color:#333">
${esc(p)}
</p>
`).join('')}
</td>
</tr>

${action ? `
<tr>
<td style="padding:14px 26px 8px">

<a href="${esc(action.url)}"
style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 22px;border-radius:10px">

${esc(action.label)} →
</a>

<p style="font-size:12px;color:#8a8a8a;margin:10px 0 0">
You will be asked to log in first. Button not working? Copy this link:
${esc(action.url)}
</p>

</td>
</tr>
` : ''}

<tr>
<td style="padding:18px 26px 26px;font-size:14px;color:#333">
${esc(closing || 'Thank you.')}
<br>
<b>StudentSphere Notification System</b>
</td>
</tr>

<tr>
<td style="background:#fafafa;padding:14px 26px;font-size:11px;color:#8a8a8a;border-top:1px solid #eee">
This is an automatic message from StudentSphere, Africa University. Please do not reply to this email.
</td>
</tr>

</table>

</td>
</tr>
</table>

</body>
</html>`;
}

const toText = (o, url) => [
  o.greeting,
  '',
  o.heading,
  '',
  o.intro,
  '',
  ...(o.rows || [])
    .filter((r) => r[1])
    .map(([k, v]) => `${k}: ${v}`),
  '',
  ...(o.paragraphs || []),
  url ? `\n${o.action.label}: ${url}` : '',
  '\nStudentSphere Notification System'
].join('\n');

// Save an email record in PostgreSQL.
async function logEmail(user, o, html, related, status, error = null) {
  const result = await postgres.query(
    `INSERT INTO email_log
      (to_user_id, to_email, subject, template, status, error,
       body_html, related_type, related_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      user.id || null,
      user.email,
      o.subject,
      o.template || null,
      status,
      error,
      html,
      related.type || null,
      related.id || null
    ]
  );

  return result.rows[0].id;
}

// Send or log an email.
async function sendMail(o) {
  const user = o.user;

  if (!user || !user.email) return;

  const action = o.action
    ? {
        label: o.action.label,
        url: appUrl() + '/#' + o.action.path
      }
    : null;

  const content = {
    heading: o.heading || o.subject,
    greeting: o.greeting || `Dear ${user.full_name},`,
    intro: o.intro,
    rows: o.rows || [],
    paragraphs: o.paragraphs || [],
    action,
    closing: o.closing
  };

  const html = renderHtml(content);
  const related = o.related || {};

  try {
    // Check the user's email notification preference.
    if (user.id && !o.force) {
      const preference = await postgres.query(
        `SELECT email_notifications
         FROM settings
         WHERE user_id = $1`,
        [user.id]
      );

      if (
        preference.rows.length > 0 &&
        preference.rows[0].email_notifications === false
      ) {
        await logEmail(
          user,
          o,
          html,
          related,
          'skipped',
          'User turned email notifications off'
        );

        return;
      }
    }

    // Development mode: save the email without sending it.
    if (mode() !== 'smtp') {
      await logEmail(user, o, html, related, 'dev');

      console.log(
        `[mail:dev] To: ${user.email} | ${o.subject}${action ? ' | ' + action.url : ''}`
      );

      return;
    }

    // Record the email before attempting delivery.
    const emailId = await logEmail(
      user,
      o,
      html,
      related,
      'queued'
    );

    if (!nodemailer) {
      await postgres.query(
        `UPDATE email_log
         SET status = 'failed',
             error = $1
         WHERE id = $2`,
        ['Nodemailer is not installed.', emailId]
      );

      return;
    }

    try {
      await getTransporter().sendMail({
        from: fromAddress(),
        to: user.email,
        subject: o.subject,
        html,
        text: toText(content, action && action.url)
      });

      await postgres.query(
        `UPDATE email_log
         SET status = 'sent', error = NULL
         WHERE id = $1`,
        [emailId]
      );

      console.log(`[mail] Successfully sent to ${user.email}`);
    } catch (error) {
      console.error('[mail] Delivery failed:', error.message);

      await postgres.query(
        `UPDATE email_log
         SET status = 'failed',
             error = $1
         WHERE id = $2`,
        [String(error.message).slice(0, 300), emailId]
      );
    }
  } catch (error) {
    // Email failures should not crash the main application workflow.
    console.error('[mail] Email processing failed:', error.message);
  }
}

module.exports = {
  sendMail,
  mode,
  appUrl,
  renderHtml
};
