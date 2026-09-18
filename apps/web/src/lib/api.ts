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
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (e.g. a proxy's HTML error page): keep the status, drop the body.
  }
  if (!res.ok) {
    const err = (json ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, err.error ?? 'http_error', err.message ?? res.statusText, err.details);
  }
  return json as T;
}

/** No answer at all, or the platform answering for a server that is restarting (deploy, crash restart). */
const isTransient = (e: unknown): boolean =>
  !(e instanceof ApiError) || e.status === 502 || e.status === 503 || e.status === 504;

/**
 * Retries a request that is safe to repeat while the server is briefly unavailable (a deploy restarts the single
 * instance for a few seconds). Back-off 0.5 → 8 s, about 15 s in total; anything else fails immediately.
 */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= 5 || !isTransient(e)) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

export const api = {
  // Safe to repeat: creation carries an idempotency key, reads are reads, the result is computed from saved answers.
  createSession: (body: CreateSessionRequest) => withRetry(() => request<SessionDto>('POST', '/api/sessions', body)),
  getSession: (id: string) => withRetry(() => request<SessionDto>('GET', `/api/sessions/${id}`)),
  result: (id: string) => withRetry(() => request<{ resultId: string; result: Result }>('POST', `/api/sessions/${id}/result`)),
  // Not retried here: the save loop in useFunnel owns retries and the optimistic lock (rev).
  saveState: (id: string, state: SessionState, rev: number) => request<SessionDto>('PUT', `/api/sessions/${id}/state`, { state, rev }),
  request,
};
