import { z } from 'zod';

/**
 * Zod schema for funnel config files (funnel-v1/v2/v3.json).
 * Objects are "loose": unknown fields are kept, so a newer config with extra metadata
 * (e.g. `releaseNote`, which only v2/v3 have) is still accepted without code changes.
 * Anything the runtime actually relies on (step types, operators) is strict.
 */

export const OPERATORS = ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'] as const;
export type Operator = (typeof OPERATORS)[number];

export type AnswerValue = string | number | string[];
export type Answers = Record<string, AnswerValue>;

export interface LeafCondition {
  answer: string;
  operator: Operator;
  value?: unknown;
}
export type Condition = LeafCondition | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema).min(1) }),
    z.object({ any: z.array(ConditionSchema).min(1) }),
    z.object({ not: ConditionSchema }),
    z.object({ answer: z.string().min(1), operator: z.enum(OPERATORS), value: z.unknown().optional() }),
  ]),
) as z.ZodType<Condition>;

const ContentSchema = z.looseObject({
  eyebrow: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  helperText: z.string().optional(),
  primaryActionLabel: z.string().optional(),
  loadingTitle: z.string().optional(),
  errorTitle: z.string().optional(),
  retryLabel: z.string().optional(),
});

const MessagesSchema = z.record(z.string(), z.string());

const OptionSchema = z.looseObject({ value: z.string().min(1), label: z.string() });

const baseStep = {
  id: z.string().min(1),
  content: ContentSchema,
  visibleWhen: ConditionSchema.optional(),
};

const InfoStepSchema = z.looseObject({ ...baseStep, type: z.literal('info') });

const SingleSelectStepSchema = z.looseObject({
  ...baseStep,
  type: z.literal('single-select'),
  input: z.looseObject({ name: z.string().min(1), options: z.array(OptionSchema).min(1) }),
  validation: z.looseObject({ required: z.boolean().optional(), messages: MessagesSchema.optional() }).optional(),
});

const MultiSelectStepSchema = z.looseObject({
  ...baseStep,
  type: z.literal('multi-select'),
  input: z.looseObject({ name: z.string().min(1), options: z.array(OptionSchema).min(1) }),
  validation: z
    .looseObject({
      required: z.boolean().optional(),
      minSelections: z.number().int().nonnegative().optional(),
      maxSelections: z.number().int().positive().optional(),
      messages: MessagesSchema.optional(),
    })
    .optional(),
});

const NumberStepSchema = z.looseObject({
  ...baseStep,
  type: z.literal('number'),
  input: z.looseObject({
    name: z.string().min(1),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    unit: z.string().optional(),
  }),
  validation: z.looseObject({ required: z.boolean().optional(), messages: MessagesSchema.optional() }).optional(),
});

const ResultStepSchema = z.looseObject({
  ...baseStep,
  type: z.literal('result'),
  resultSource: z.string().optional(),
});

export const StepSchema = z.discriminatedUnion('type', [
  InfoStepSchema,
  SingleSelectStepSchema,
  MultiSelectStepSchema,
  NumberStepSchema,
  ResultStepSchema,
]);

export const STEP_TYPES = ['info', 'single-select', 'multi-select', 'number', 'result'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export type Step = z.infer<typeof StepSchema>;
export type InteractiveStep = Extract<Step, { type: 'single-select' | 'multi-select' | 'number' }>;

export const ResultSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  summary: z.string().optional(),
  recommendations: z.array(z.string()).optional(),
  cta: z.looseObject({ label: z.string(), action: z.string() }).optional(),
});
export type Result = z.infer<typeof ResultSchema>;

const OverrideSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

export const VariantSchema = z.looseObject({
  weight: z.number().positive(),
  stepSequence: z.array(z.string().min(1)).min(1),
  stepOverrides: OverrideSchema.optional(),
  resultOverrides: OverrideSchema.optional(),
});

export const EventDefinitionSchema = z.looseObject({
  name: z.string().min(1),
  trigger: z.string().optional(),
  properties: z.array(z.string()),
});
export type EventDefinition = z.infer<typeof EventDefinitionSchema>;

export const EventsConfigSchema = z.looseObject({
  baseProperties: z.array(z.string()),
  allowed: z.array(EventDefinitionSchema),
  privacy: z
    .looseObject({ storeRawAnswers: z.boolean().optional(), allowAnswerKinds: z.boolean().optional() })
    .optional(),
});
export type EventsConfig = z.infer<typeof EventsConfigSchema>;

export const ProgressConfigSchema = z.looseObject({
  countVisibleOnly: z.boolean().optional(),
  excludeTypes: z.array(z.string()).optional(),
});
export type ProgressConfig = z.infer<typeof ProgressConfigSchema>;

export const FunnelConfigSchema = z.looseObject({
  schemaVersion: z.string(),
  funnelId: z.string().min(1).regex(/^[a-z0-9-]+$/, 'funnelId must be kebab-case'),
  version: z.number().int().positive(),
  status: z.string().optional(),
  locale: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  releaseNote: z.string().optional(),
  session: z.looseObject({ ttlHours: z.number().positive() }),
  progress: ProgressConfigSchema.optional(),
  experiment: z.looseObject({
    id: z.string().min(1),
    overrideQueryParam: z.string().min(1).optional(),
    variants: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), VariantSchema),
  }),
  steps: z.record(z.string(), StepSchema),
  resultRules: z.array(z.looseObject({ resultId: z.string().min(1), when: ConditionSchema })),
  defaultResultId: z.string().min(1),
  results: z.record(z.string(), ResultSchema),
  events: EventsConfigSchema,
});
export type FunnelConfig = z.infer<typeof FunnelConfigSchema>;

/** A funnel as seen by one session: config of the pinned version with the variant already applied. */
export interface ResolvedFunnel {
  funnelId: string;
  version: number;
  experimentId: string;
  variant: string;
  /** Query parameter that forces a variant for testing (e.g. ?variant=B). */
  overrideQueryParam: string;
  title: string;
  locale: string | undefined;
  /** Step ids in the order this variant shows them. */
  sequence: string[];
  steps: Record<string, Step>;
  results: Record<string, Result>;
  resultRules: { resultId: string; when: Condition }[];
  defaultResultId: string;
  progress: { excludeTypes: string[]; countVisibleOnly: boolean };
  events: EventsConfig;
}

export function isInteractive(step: Step): step is InteractiveStep {
  return step.type === 'single-select' || step.type === 'multi-select' || step.type === 'number';
}
