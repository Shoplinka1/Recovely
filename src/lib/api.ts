import { supabase } from './supabase';

type ApiError = Error & {
  status?: number;
  data?: unknown;
};

let bridgedAccessToken = '';
let bridgePromise: Promise<void> | null = null;

const bridgeSupabaseSession = async (accessToken: string) => {
  if (bridgedAccessToken === accessToken) {
    return;
  }

  if (!bridgePromise) {
    bridgePromise = (async () => {
      const response = await fetch('/api/auth/supabase-session', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ accessToken }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        const error = new Error(
          typeof data?.message === 'string'
            ? data.message
            : `Could not establish authenticated session (${response.status})`
        ) as ApiError;

        error.status = response.status;
        error.data = data;

        throw error;
      }

      bridgedAccessToken = accessToken;
    })().finally(() => {
      bridgePromise = null;
    });
  }

  await bridgePromise;

  if (bridgedAccessToken !== accessToken) {
    await bridgeSupabaseSession(accessToken);
  }
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

  await bridgeSupabaseSession(accessToken);

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
  } finally {
    bridgedAccessToken = '';
    bridgePromise = null;
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
