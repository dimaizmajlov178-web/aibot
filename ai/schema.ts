import { z } from "zod";

export const tradeActionSchema = z.enum(["buy", "sell", "hold"]);
export const positionSideSchema = z.enum(["long", "short", "none"]);

export const tradeSignalSchema = z.object({
  action: tradeActionSchema,
  side: positionSideSchema,
  confidence: z.number().min(0).max(100),
  entryPrice: z.number().positive().nullable().default(null),
  stopLoss: z.number().positive().nullable().default(null),
  takeProfit: z.number().positive().nullable().default(null),
  riskPercent: z.number().min(0).max(100),
  reasoning: z.string().min(1).max(2000),
});

export const trendSchema = z.enum(["bullish", "bearish", "neutral"]);
export const riskLevelSchema = z.enum(["low", "medium", "high"]);

export const deepAnalysisSchema = z.object({
  trend: trendSchema,
  trendStrength: z.number().min(0).max(100),
  keyLevels: z.object({
    support: z.array(z.number().positive()).max(10).default([]),
    resistance: z.array(z.number().positive()).max(10).default([]),
  }),
  scenario: z.object({
    bullCase: z.string().max(2000),
    bearCase: z.string().max(2000),
    baseCase: z.string().max(2000),
  }),
  riskAssessment: riskLevelSchema,
  summary: z.string().max(4000),
});

export type TradeSignal = z.infer<typeof tradeSignalSchema>;
export type DeepAnalysis = z.infer<typeof deepAnalysisSchema>;

export function isTradeSignal(value: unknown): value is TradeSignal {
  return tradeSignalSchema.safeParse(value).success;
}

export function isDeepAnalysis(value: unknown): value is DeepAnalysis {
  return deepAnalysisSchema.safeParse(value).success;
}
