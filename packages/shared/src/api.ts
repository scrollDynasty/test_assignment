import type { ResolvedFunnel } from './config.js';
import type { SessionState } from './engine.js';

export interface Utm {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
}

export type Assignment = 'hash' | 'override';
export type SessionStatus = 'active' | 'completed';

/** What the client gets for a session: the pinned version with its variant applied, plus saved state. */
export interface SessionDto {
  sessionId: string;
  funnelId: string;
  version: number;
  experimentId: string;
  variant: string;
  assignment: Assignment;
  status: SessionStatus;
  resultId: string | null;
  utm: Utm;
  funnel: ResolvedFunnel;
  state: SessionState;
  rev: number;
  expiresAt: string;
}

export interface CreateSessionRequest {
  funnelId: string;
  utm?: Utm;
  variantOverride?: string;
}

export interface SaveStateRequest {
  state: SessionState;
  rev: number;
}

export interface ResultDto {
  resultId: string;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
