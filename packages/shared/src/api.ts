import type { ResolvedFunnel } from './config.js';
import type { SessionState } from './engine.js';

export interface Utm {
  utm_source?: string | null | undefined;
  utm_medium?: string | null | undefined;
  utm_campaign?: string | null | undefined;
  utm_content?: string | null | undefined;
  utm_term?: string | null | undefined;
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
  /** Explicit variant override (tools, tests). */
  variantOverride?: string;
  /** Page query parameters; the server reads the override from `experiment.overrideQueryParam` of the active version. */
  query?: Record<string, string>;
}
