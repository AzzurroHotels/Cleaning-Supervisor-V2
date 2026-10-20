export class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

let redirecting = false;

function redirectToLogin() {
  if (redirecting) return;
  redirecting = true;
  const next = encodeURIComponent(location.pathname + location.hash);
  location.assign('/login?next=' + next);
}

async function request(path, options = {}) {
  const {
    method = 'GET',
    body,
    formData,
    redirectOn401 = true,
    signal,
    headers: extraHeaders = {}
  } = options;

  const headers = { Accept: 'application/json', ...extraHeaders };
  const init = {
    method,
    credentials: 'same-origin',
    headers,
    signal
  };

  if (formData) {
    init.body = formData;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }

  if (response.status === 401 && redirectOn401 && location.pathname !== '/login') {
    redirectToLogin();
  }

  const contentType = response.headers.get('content-type') || '';
  let data = null;
  if (response.status !== 204 && contentType.includes('application/json')) {
    data = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const message =
      data?.error ||
      (response.status === 401
        ? 'Please sign in to continue.'
        : response.status === 403
          ? 'You do not have permission to do that.'
          : response.status >= 500
            ? 'The server ran into a problem. Please try again.'
            : 'The request could not be completed.');
    throw new ApiError(response.status, message, data);
  }

  return data;
}

export const api = {
  get(path, options) {
    return request(path, { ...options, method: 'GET' });
  },
  post(path, body, options) {
    return request(path, { ...options, method: 'POST', body });
  },
  put(path, body, options) {
    return request(path, { ...options, method: 'PUT', body });
  },
  patch(path, body, options) {
    return request(path, { ...options, method: 'PATCH', body });
  },
  delete(path, options) {
    return request(path, { ...options, method: 'DELETE' });
  },
  upload(path, formData, options) {
    return request(path, { ...options, method: 'POST', formData });
  },
  async blob(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        credentials: 'same-origin',
        signal: options.signal
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
    }
    if (response.status === 401) {
      redirectToLogin();
      throw new ApiError(401, 'Please sign in to continue.');
    }
    if (!response.ok) {
      throw new ApiError(response.status, 'Could not load that file.');
    }
    return response.blob();
  }
};

export function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? '?' + query : '';
}
