import { supabase } from './supabase';

type ApiError = Error & {
  status?: number;
  data?: unknown;
};

const normalizeError = async (response: Response): Promise<ApiError> => {
  const data = await response.json().catch(() => null);

  const message =
    typeof data?.message === 'string'
      ? data.message
      : `Request failed (${response.status})`;

  const error = new Error(message) as ApiError;
  error.status = response.status;
  error.data = data;

  return error;
};

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  data?: unknown
) {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  if (!accessToken) {
    throw Object.assign(
      new Error('Your session has expired. Please sign in again.'),
      { status: 401 }
    );
  }

  const options: RequestInit = {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  };

  if (method !== 'GET' && data !== undefined) {
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      throw await normalizeError(response);
    }

    const responseData = await response.json().catch(() => ({}));

    return {
      data: responseData,
      status: response.status,
    };
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      throw error;
    }

    const normalized = new Error(
      error instanceof Error ? error.message : 'Request failed'
    ) as ApiError;

    throw normalized;
  }
}

export const clearApiSession = async () => {
  try {
    await fetch('/api/auth/supabase-session/logout', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
  } catch {
    // Supabase sign-out remains authoritative if bridge cleanup fails.
  }
};

export const api = {
  get: (url: string, data?: unknown) =>
    request('GET', url, data),

  post: (url: string, data?: unknown) =>
    request('POST', url, data),

  put: (url: string, data?: unknown) =>
    request('PUT', url, data),

  delete: (url: string, data?: unknown) =>
    request('DELETE', url, data),
};
