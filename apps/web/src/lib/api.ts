import Cookies from 'js-cookie';

const API_BASE = '/api';

function getToken(): string | undefined {
  const cookieToken = Cookies.get('vismed_auth_token');
  if (cookieToken) return cookieToken;

  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem('vismed-auth-storage');
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed?.state?.token || undefined;
      }
    } catch {}
  }
  return undefined;
}

async function request(method: string, url: string, body?: any, config?: any) {
  const token = getToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const cleanUrl = url.startsWith('/') ? url : `/${url}`;
  let fullUrl = `${API_BASE}${cleanUrl}`;

  if (config?.params) {
    const qs = new URLSearchParams(config.params).toString();
    fullUrl += (fullUrl.includes('?') ? '&' : '?') + qs;
  }

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (body && method !== 'GET') {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(fullUrl, fetchOptions);

  if (!response.ok) {
    if (response.status === 401) {
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        Cookies.remove('vismed_auth_token');
        window.location.href = '/login';
      }
    }

    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.message || errorData.error || `API Error: ${response.status}`);
  }

  const contentType = response.headers.get('content-type');
  const hasBody = response.status !== 204 && contentType?.includes('application/json');
  const data = hasBody ? await response.json() : null;
  return { data, status: response.status };
}

export const api = {
  get: (url: string, config?: any) => request('GET', url, undefined, config),
  post: (url: string, body?: any, config?: any) => request('POST', url, body, config),
  put: (url: string, body?: any, config?: any) => request('PUT', url, body, config),
  delete: (url: string, config?: any) => request('DELETE', url, undefined, config),
  patch: (url: string, body?: any, config?: any) => request('PATCH', url, body, config),
};
