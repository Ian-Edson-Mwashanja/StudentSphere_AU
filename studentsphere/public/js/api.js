// Tiny API client. The login token lives in localStorage ("remember me") or sessionStorage.
export const store = {
  user: null,
  get token() { return localStorage.getItem('ss_token') || sessionStorage.getItem('ss_token'); },
  setToken(t, remember = true) {
    localStorage.removeItem('ss_token'); sessionStorage.removeItem('ss_token');
    if (t) (remember ? localStorage : sessionStorage).setItem('ss_token', t);
  }
};

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (store.token) headers.Authorization = 'Bearer ' + store.token;
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error('Cannot reach the server. Is it running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && store.token && !path.startsWith('/auth/')) {
      store.setToken(null); store.user = null; location.hash = '#/login'; location.reload();
    }
    throw new Error(data.error || 'Something went wrong');
  }
  return data;
}

// Open an uploaded evidence file (files are protected, so we fetch with the login token and show the blob).
export async function openFile(id) {
  const res = await fetch('/api/files/' + id, { headers: { Authorization: 'Bearer ' + store.token } });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not open the file'); }
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
