import type { CreateSessionRequest, Result, SessionDto, SessionState } from '@funnel/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (json ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, err.error ?? 'http_error', err.message ?? res.statusText, err.details);
  }
  return json as T;
}

export const api = {
  createSession: (body: CreateSessionRequest) => request<SessionDto>('POST', '/api/sessions', body),
  getSession: (id: string) => request<SessionDto>('GET', `/api/sessions/${id}`),
  saveState: (id: string, state: SessionState, rev: number) => request<SessionDto>('PUT', `/api/sessions/${id}/state`, { state, rev }),
  result: (id: string) => request<{ resultId: string; result: Result }>('POST', `/api/sessions/${id}/result`),
  request,
};
