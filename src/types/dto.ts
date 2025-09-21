import { z } from 'zod';

// --- Schemas de Zod (Fuente de la Verdad) ---

export const ResolveRequestZod = z.object({
  url: z.string().url({ message: 'El campo url debe ser una URL válida' }).min(1, { message: 'El campo url es requerido' }),
  options: z.object({
    emulateMobile: z.boolean().optional(),
    extraHeaders: z.record(z.string(), z.string()).optional(),
    navTimeoutMs: z.number().int().positive().optional(),
    maxWaitMs: z.number().int().positive().optional(),
    waitUntil: z.enum(['domcontentloaded', 'networkidle2']).optional(),
    m3u8Patterns: z.array(z.string()).optional(),
  }).optional(),
});

const ResolveOptionsZod = ResolveRequestZod.shape.options;

// --- Zod Schemas for Responses ---

const StreamVariantZod = z.object({
  uri: z.string(),
  bandwidth: z.number().optional(),
  codecs: z.string().optional(),
  resolution: z.object({
    width: z.number(),
    height: z.number(),
  }).optional(),
  frameRate: z.number().optional(),
});

const StreamEncryptionZod = z.object({
  method: z.enum(['AES-128', 'SAMPLE-AES', 'NONE']),
  keyUri: z.string().optional(),
});

const StreamZod = z.object({
  type: z.literal('HLS'),
  masterUrl: z.string(),
  mediaPlaylists: z.array(z.string()).nullish(),
  isLive: z.boolean().nullish(),
  isLowLatency: z.boolean().nullish(),
  encryption: StreamEncryptionZod.nullish(),
  variants: z.array(StreamVariantZod).nullish(),
});

const CookieZod = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
});

const RawFindingZod = z.object({
  url: z.string(),
  contentType: z.string().optional(),
});

export const ResolveResponseZod = z.object({
  sessionId: z.string(),
  pageUrl: z.string(),
  detectedAt: z.string(),
  streams: z.array(StreamZod),
  bestGuess: z.number().int().nullish(),
  requiredHeaders: z.record(z.string(), z.string()),
  requiredCookies: z.array(CookieZod).nullish(),
  rawFindings: z.array(RawFindingZod).nullish(),
  notes: z.array(z.string()).nullish(),
});

export const HealthResponseZod = z.object({
  status: z.literal('ok'),
  uptime: z.number(),
  version: z.string(),
  timestamp: z.string(),
});

export const ErrorResponseZod = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number(),
  timestamp: z.string(),
  requestId: z.string().optional(),
});

// --- Tipos inferidos de Zod ---
export type ResolveRequest = z.infer<typeof ResolveRequestZod>;
export type ResolveOptions = z.infer<typeof ResolveOptionsZod>;
export type StreamVariant = z.infer<typeof StreamVariantZod>;
export type StreamEncryption = z.infer<typeof StreamEncryptionZod>;
export type Stream = z.infer<typeof StreamZod>;
export type Cookie = z.infer<typeof CookieZod>;
export type RawFinding = z.infer<typeof RawFindingZod>;
export type ResolveResponse = z.infer<typeof ResolveResponseZod>;
export type HealthResponse = z.infer<typeof HealthResponseZod>;
export type ErrorResponse = z.infer<typeof ErrorResponseZod>;

// Internal types
export interface BrowserPoolOptions {
  maxConcurrentPages: number;
  browserPoolSize: number;
  headless: boolean;
  userAgent: string;
  proxy?: string;
}

export interface DetectionContext {
  url: string;
  options: ResolveOptions;
  sessionId: string;
  startTime: number;
}

export interface HLSCandidate {
  url: string;
  contentType?: string;
  headers: Record<string, string>;
  cookies: Cookie[];
  detectedAt: number;
  source: 'request' | 'response' | 'iframe' | 'serviceworker';
}

export interface ParsedM3U8 {
  isLive: boolean;
  isLowLatency: boolean;
  variants: StreamVariant[];
  mediaPlaylists: string[];
  encryption?: StreamEncryption;
}

export interface DetectionResult {
  candidates: HLSCandidate[];
  requiredHeaders: Record<string, string>;
  requiredCookies: Cookie[];
  rawFindings: RawFinding[];
  notes: string[];
}

// --- JSON Schemas para Fastify ---
export const resolveRequestSchema = ResolveRequestZod;
export const resolveResponseSchema = ResolveResponseZod;
export const healthResponseSchema = HealthResponseZod;
export const errorResponseSchema = ErrorResponseZod;
