import { FunnelConfigSchema, resolveVariant, type ResolvedFunnel } from '../../../packages/shared/src/index';
import v1 from '../../../funnel-v1.json';
import v3 from '../../../funnel-v3.json';

/** The customer's configs, parsed and resolved exactly as the server does before sending them to the page. */
export const funnelV1 = (variant: 'A' | 'B'): ResolvedFunnel => resolveVariant(FunnelConfigSchema.parse(v1), variant);
export const funnelV3 = (variant: 'A' | 'B'): ResolvedFunnel => resolveVariant(FunnelConfigSchema.parse(v3), variant);
