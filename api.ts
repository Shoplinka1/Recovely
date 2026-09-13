import { api as appDeployApi } from '@appdeploy/client';
import { supabase } from './supabase';

type ApiError = Error & { status?: number; data?: unknown };

let bridgedAccessToken = '';
let bridgePromise: Promise<void> | null = null;

const bridgeSupabaseSession = async (accessToken: string) => {
  if (bridgedAccessToken === accessToken) return;
  if (!bridgePromise) {
    bridgePromise = appDeployApi.post('/api/auth/supabase-session', { accessToken }).then(({ data }) => {
      if (!data?.ok) throw new Error(data?.message || 'Could not establish the authenticated workspace session.');
      bridgedAccessToken = accessToken;
    }).finally(() => {
      bridgePromise = null;
    });
  }
  await bridgePromise;
  if (bridgedAccessToken !== accessToken) {
    await bridgeSupabaseSession(accessToken);
  }
};

const normalizeError = (error: any): ApiError => {
  const status = Number(error?.response?.status ?? error?.status);
  const data = error?.response?.data ?? error?.data;
  const message = typeof data?.message === 'string'
    ? data.message
    : typeof error?.message === 'string' && error.message.trim()
      ? error.message.trim()
      : `Request failed${Number.isFinite(status) ? ` (${status})` : ''}`;
  const normalized = new Error(message) as ApiError;
  if (Number.isFinite(status)) normalized.status = status;
  normalized.data = data;
  return normalized;
};

async function request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, data?: unknown) {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw Object.assign(new Error('Your session has expired. Please sign in again.'), { status: 401 });

  await bridgeSupabaseSession(accessToken);

  try {
    if (method === 'GET') return await appDeployApi.get(url, data);
    if (method === 'POST') return await appDeployApi.post(url, data);
    if (method === 'PUT') return await appDeployApi.put(url, data);
    return await appDeployApi.delete(url, data);
  } catch (error) {
    throw normalizeError(error);
  }
}

export const clearApiSession = async () => {
  try {
    await appDeployApi.post('/api/auth/supabase-session/logout', {});
  } catch {
    // Supabase sign-out remains authoritative if the bridge cleanup request cannot be completed.
  } finally {
    bridgedAccessToken = '';
    bridgePromise = null;
  }
};

export const api = {
  get: (url: string, data?: unknown) => request('GET', url, data),
  post: (url: string, data?: unknown) => request('POST', url, data),
  put: (url: string, data?: unknown) => request('PUT', url, data),
  delete: (url: string, data?: unknown) => request('DELETE', url, data),
};
