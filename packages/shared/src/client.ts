/**
 * Browser entry of the shared package: the funnel engine and event rules, without the zod schemas (those validate
 * configs and requests on the server). Keeps zod out of the visitor's bundle; the web app resolves
 * "@funnel/shared" to this file.
 */
export * from './steps.js';
export * from './conditions.js';
export * from './engine.js';
export * from './validation.js';
export * from './eventRules.js';
export type { AnswerValue, Answers, InteractiveStep, ResolvedFunnel, Result, Step, StepType } from './config.js';
export type { EventBatchResponse, EventStatus, IncomingEvent } from './events.js';
export type * from './api.js';
export type * from './analytics.js';
