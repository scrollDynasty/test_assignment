import type { StepType } from './config.js';

/** Public analytics report (GET /api/analytics). Shared so the dashboard and the server agree on the shape. */

export type Interval = [number, number];

export interface AnalyticsFilters {
  funnelId: string;
  version?: number | undefined;
  utmCampaign?: string | undefined;
  includeOverrides: boolean;
}

export interface SummaryMetrics {
  started: number;
  reachedResult: number;
  ctaClicked: number;
  inProgress: number;
  completion: number | null;
  ctr: number | null;
  startToCta: number | null;
  serverCompleted: number;
}

export interface VersionRow extends SummaryMetrics {
  version: number;
  experimentId: string;
}

export interface StepRow {
  stepId: string;
  type: StepType;
  conditional: boolean;
  /** 0-based position in the variant's step sequence. */
  position: number;
  viewed: number;
  passed: number | null;
  stepConversion: number | null;
  reach: number | null;
  dropoff: number;
}

export interface VariantReport extends SummaryMetrics {
  backRate: number | null;
  steps: StepRow[];
  beforeFirstStep: number;
  invariantOk: boolean;
  resultMix: Record<string, number>;
}

export interface RateWithCi {
  variant: string;
  sessions: number;
  conversions: number;
  rate: number | null;
  ci: Interval | null;
}

export interface AbTest {
  metric: 'startToCta';
  a: RateWithCi;
  b: RateWithCi;
  /** rate(b) − rate(a), absolute. */
  diff: number;
  diffCi: Interval | null;
  pValue: number;
  significant: boolean;
  mde: number | null;
  srm: {
    pValue: number;
    chi2: number;
    observed: Record<string, number>;
    expectedShare: Record<string, number>;
    ok: boolean;
  } | null;
}

export interface OtherEventRow {
  name: string;
  sessions: number;
  byVariant: Record<string, number>;
}

export interface SelectedReport {
  version: number;
  experimentId: string;
  variants: Record<string, VariantReport>;
  abTest: AbTest | null;
  otherEvents: OtherEventRow[];
}

export interface IngestionQuality {
  /** Stored event rows matching the filter (selected version). */
  rawEvents: number;
  /** Totals of ingest_log. The log has no funnel column, so these are global across funnels. */
  accepted: number;
  duplicates: number;
  rejected: number;
  rejectedReasons: Record<string, number>;
}

export interface AnalyticsReport {
  generatedAt: string;
  filters: { funnelId: string; version: number | null; utmCampaign: string | null; includeOverrides: boolean };
  availableVersions: number[];
  availableCampaigns: string[];
  versions: VersionRow[];
  selected: SelectedReport | null;
  ingestion: IngestionQuality;
}

