// Secure server-side lookup of official student records stored in Supabase.
// Never place the service-role key in frontend JavaScript.

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = process.env.SUPABASE_ROSTER_TABLE || 'student_roster';
const ID_COLUMNS = (process.env.SUPABASE_ROSTER_ID_COLUMNS || 'studentid,student_id,university_id')
  .split(',').map((x) => x.trim()).filter(Boolean);

const configured = () => Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
const get = (row, names) => {
  const wanted = new Set(names.map(normalizeKey));
  const key = Object.keys(row || {}).find((k) => wanted.has(normalizeKey(k)));
  return key === undefined ? null : row[key];
};
const normalizeYear = (value) => {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (/^\d$/.test(v)) return `Year ${v}`;
  if (/^year\s*\d$/i.test(v)) return v.replace(/\s+/g, ' ');
  if (/^post/i.test(v)) return 'Postgraduate';
  return v;
};
const maskEmail = (email) => {
  if (!email || !String(email).includes('@')) return null;
  const [name, domain] = String(email).split('@');
  return `${name.slice(0, 1)}***@${domain}`;
};

async function lookupStudent(studentId) {
  if (!configured()) throw Object.assign(new Error('Student verification is not configured on the backend. Please contact the administrator.'), { status: 503 });
  const id = String(studentId || '').trim();
  if (!/^\d{6}$/.test(id)) return null;

  let lastError;
  for (const idColumn of ID_COLUMNS) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(TABLE)}`);
    url.searchParams.set('select', '*');
    url.searchParams.set(idColumn, `eq.${id}`);
    url.searchParams.set('limit', '1');
    let response;
    try {
      response = await fetch(url, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: 'application/json'
        }
      });
    } catch (error) {
      throw Object.assign(new Error('Could not connect to the student records database. Please try again.'), { status: 503 });
    }

    if (response.ok) {
      const rows = await response.json();
      const row = rows[0];
      if (!row) return null;
      return {
        university_id: String(get(row, ['StudentID', 'Student ID', 'student_id', 'university_id', 'id']) ?? id),
        full_name: String(get(row, ['FullName', 'Full Name', 'full_name', 'student_name', 'name']) ?? ''),
        email: String(get(row, ['Email', 'email', 'university_email']) ?? '').toLowerCase(),
        faculty: String(get(row, ['College', 'college', 'faculty', 'school']) ?? ''),
        programme: String(get(row, ['Programme', 'Program', 'programme', 'course']) ?? ''),
        year_of_study: normalizeYear(get(row, ['YearOfStudy', 'Year Of Study', 'year_of_study', 'year'])),
        status: String(get(row, ['Status', 'status']) ?? 'Active').toLowerCase()
      };
    }

    const errorText = await response.text();
    lastError = errorText;
    // Try the next possible ID-column name only when this column does not exist.
    if (response.status !== 400 && response.status !== 404) {
      throw Object.assign(new Error('Student records could not be checked. Please try again later.'), { status: 503 });
    }
  }

  console.error('Supabase roster lookup failed. Check the roster table and ID column names:', lastError);
  throw Object.assign(new Error('The student roster table or Student ID column is not configured correctly in Supabase.'), { status: 503 });
}

module.exports = { configured, lookupStudent, maskEmail };
