import { z } from "zod";

export const strategyRuleSchema = z.object({
  /** Имя правила/параметра стратегии (например "rsi_threshold"). */
  field: z.string().min(1).max(120),
  /** Формулировка корректировки (что и как менять). */
  change: z.string().min(1).max(500),
  /** Обоснование корректировки по данным сделок. */
  reason: z.string().min(1).max(500),
});

export const learningAnalysisSchema = z.object({
  summary: z.string().min(1).max(2000),
  successPatterns: z.array(z.string().min(1).max(500)).max(20).default([]),
  failurePatterns: z.array(z.string().min(1).max(500)).max(20).default([]),
  ruleAdjustments: z.array(strategyRuleSchema).max(10).default([]),
});

export type LearningAnalysis = z.infer<typeof learningAnalysisSchema>;
export type StrategyRuleInput = z.infer<typeof strategyRuleSchema>;
