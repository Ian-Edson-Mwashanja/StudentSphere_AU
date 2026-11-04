// StudentSphere email system.
//  - MAIL_MODE=dev  (default when SMTP_HOST is empty): nothing is sent. Every email is saved in the
//    email_log table and shown in Admin -> Email log (full HTML preview) and printed in the terminal.
//  - MAIL_MODE=smtp (automatic when SMTP_HOST is set): emails are sent with nodemailer.
// Credentials are read from environment variables ONLY (see .env.example).
const db = require('./db');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* only needed in smtp mode */ }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const appUrl = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const mode = () => (process.env.MAIL_MODE || (process.env.SMTP_HOST ? 'smtp' : 'dev')).toLowerCase();
const fromAddress = () => process.env.MAIL_FROM || 'StudentSphere <no-reply@studentsphere.local>';

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transporter;
}

// One consistent, branded layout for every email.
function renderHtml({ heading, greeting, intro, rows = [], paragraphs = [], action, closing }) {
  const rowHtml = rows.filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v]) =>
    `<tr><td style="padding:8px 12px;color:#6b6b6b;font-size:13px;width:38%;border-bottom:1px solid #eee">${esc(k)}</td>
     <td style="padding:8px 12px;font-size:14px;font-weight:600;border-bottom:1px solid #eee">${esc(v)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f5;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0a0a0a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e8e8ea">
    <tr><td style="background:#0a0a0a;padding:22px 26px"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#c8102e;margin-right:8px"></span>
      <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-.02em">StudentSphere</span>
      <div style="color:#bdbdbd;font-size:12px;margin-top:4px">Africa University · Your Academic Journey. Connected.</div></td></tr>
    <tr><td style="padding:28px 26px 8px"><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#c8102e;font-weight:700">Notification</div>
      <h1 style="margin:6px 0 14px;font-size:24px;line-height:1.2">${esc(heading)}</h1>
      <p style="margin:0 0 10px;font-size:15px;line-height:1.6;font-weight:600">${esc(greeting)}</p>
      <p style="margin:0 0 14px;font-size:15px;line-height:1.6">${esc(intro)}</p></td></tr>
    ${rowHtml ? `<tr><td style="padding:0 26px 8px"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:10px;border-collapse:separate">${rowHtml}</table></td></tr>` : ''}
    <tr><td style="padding:8px 26px 4px">${paragraphs.map((p) => `<p style="margin:12px 0;font-size:14px;line-height:1.6;color:#333">${esc(p)}</p>`).join('')}</td></tr>
    ${action ? `<tr><td style="padding:14px 26px 8px"><a href="${esc(action.url)}" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 22px;border-radius:10px">${esc(action.label)} →</a>
      <p style="font-size:12px;color:#8a8a8a;margin:10px 0 0">You will be asked to log in first. Button not working? Copy this link: ${esc(action.url)}</p></td></tr>` : ''}
    <tr><td style="padding:18px 26px 26px;font-size:14px;color:#333">${esc(closing || 'Thank you.')}<br><b>StudentSphere Notification System</b></td></tr>
    <tr><td style="background:#fafafa;padding:14px 26px;font-size:11px;color:#8a8a8a;border-top:1px solid #eee">This is an automatic message from StudentSphere, Africa University. Please do not reply to this email.</td></tr>
  </table></td></tr></table></body></html>`;
}

const toText = (o, url) => [o.greeting, '', o.heading, '', o.intro, '', ...(o.rows || []).filter((r) => r[1]).map(([k, v]) => `${k}: ${v}`), '', ...(o.paragraphs || []), url ? `\n${o.action.label}: ${url}` : '', '\nStudentSphere Notification System'].join('\n');

/**
 * sendMail({ user, subject, template, heading, intro, rows, paragraphs, action:{label,path}, related:{type,id}, force })
 * Returns a promise; callers do not need to wait for it (request handlers never block on email).
 */
function sendMail(o) {
  const user = o.user;
  if (!user || !user.email) return Promise.resolve();
  const action = o.action ? { label: o.action.label, url: appUrl() + '/#' + o.action.path } : null;
  const content = { heading: o.heading || o.subject, greeting: o.greeting || `Dear ${user.full_name},`, intro: o.intro, rows: o.rows, paragraphs: o.paragraphs, action, closing: o.closing };
  const html = renderHtml(content);
  const rel = o.related || {};
  const log = (status, error) => db.prepare(`INSERT INTO email_log (to_user_id,to_email,subject,template,status,error,body_html,related_type,related_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(user.id || null, user.email, o.subject, o.template || null, status, error || null, html, rel.type || null, rel.id || null);

  const pref = user.id ? db.prepare('SELECT email_notifications e FROM settings WHERE user_id=?').get(user.id) : null;
  if (pref && pref.e === 0 && !o.force) { log('skipped', 'User turned email notifications off'); return Promise.resolve(); }

  if (mode() !== 'smtp') {
    log('dev'); console.log(`[mail:dev] To: ${user.email} | ${o.subject}${action ? ' | ' + action.url : ''}`);
    return Promise.resolve();
  }
  const id = log('queued').lastInsertRowid;
  if (!nodemailer) {
    db.prepare("UPDATE email_log SET status='failed', error=? WHERE id=?").run('nodemailer is not installed (run npm install)', id);
    return Promise.resolve();
  }
  return getTransporter().sendMail({ from: fromAddress(), to: user.email, subject: o.subject, html, text: toText(content, action && action.url) })
    .then(() => db.prepare("UPDATE email_log SET status='sent' WHERE id=?").run(id))
    .catch((e) => { console.error('[mail] failed:', e.message); db.prepare("UPDATE email_log SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 300), id); });
}

module.exports = { sendMail, mode, appUrl, renderHtml };
