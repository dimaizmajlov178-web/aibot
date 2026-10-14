import type { MetricsSnapshot, TradingSnapshot } from "./types";
import { ANALYSIS_HISTORY_DAYS, MIN_TRADES_FOR_RULES } from "./types";

export type MetricsOutcome =
  | { ok: true; metrics: MetricsSnapshot }
  | { ok: false; reason: "insufficient_data" };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isWithinHistory(
  closedAt: string,
  now: Date = new Date()
): boolean {
  const cutoff = new Date(now.getTime() - ANALYSIS_HISTORY_DAYS * 86_400_000);
  return closedAt >= cutoff.toISOString();
}

/**
 * Анти-оверфит расчёт метрик по закрытым сделкам:
 * учитываются только сделки за последние ANALYSIS_HISTORY_DAYS дней;
 * если закрытых сделок меньше MIN_TRADES_FOR_RULES — возвращает
 * insufficient_data (правила не корректируются).
 */
export function computeMetrics(
  snapshots: readonly TradingSnapshot[]
): MetricsOutcome {
  const now = new Date();
  const closed = snapshots.filter(
    (snapshot) =>
      snapshot.status === "closed" &&
      snapshot.result !== null &&
      isWithinHistory(snapshot.result.closedAt, now)
  );

  if (closed.length < MIN_TRADES_FOR_RULES) {
    return { ok: false, reason: "insufficient_data" };
  }

  const sorted = [...closed].sort((a, b) =>
    (a.result?.closedAt ?? a.updatedAt).localeCompare(
      b.result?.closedAt ?? b.updatedAt
    )
  );

  const totalTrades = sorted.length;
  const wins = sorted.filter(
    (snapshot) => (snapshot.result?.pnl ?? 0) > 0
  ).length;
  const losses = totalTrades - wins;
  const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  const grossProfit = sorted
    .filter((snapshot) => (snapshot.result?.pnl ?? 0) > 0)
    .reduce((sum, snapshot) => sum + (snapshot.result?.pnl ?? 0), 0);
  const grossLoss = sorted
    .filter((snapshot) => (snapshot.result?.pnl ?? 0) < 0)
    .reduce((sum, snapshot) => sum + Math.abs(snapshot.result?.pnl ?? 0), 0);
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  const averageR =
    sorted.length > 0
      ? sorted.reduce(
          (sum, snapshot) => sum + (snapshot.result?.rMultiple ?? 0),
          0
        ) / sorted.length
      : 0;

  const netPnl = sorted.reduce(
    (sum, snapshot) => sum + (snapshot.result?.pnl ?? 0),
    0
  );

  let peak = 0;
  let cumulative = 0;
  let maxDrawdownPercent = 0;
  for (const snapshot of sorted) {
    cumulative += snapshot.result?.pnl ?? 0;
    if (cumulative > peak) {
      peak = cumulative;
    }
    if (peak > 0) {
      const drawdown = ((peak - cumulative) / peak) * 100;
      if (drawdown > maxDrawdownPercent) {
        maxDrawdownPercent = drawdown;
      }
    }
  }

  return {
    ok: true,
    metrics: {
      totalTrades,
      wins,
      losses,
      winrate: round2(winrate),
      profitFactor: round2(profitFactor),
      maxDrawdownPercent: round2(maxDrawdownPercent),
      averageR: round2(averageR),
      netPnl: round2(netPnl),
      periodStart: sorted[0]?.result?.closedAt ?? "",
      periodEnd: sorted[sorted.length - 1]?.result?.closedAt ?? "",
    },
  };
}

/** Сравнивает правила стратегий без учёта порядка следования. */
export function rulesChanged(
  current: readonly StrategyRuleLike[],
  next: readonly StrategyRuleLike[]
): boolean {
  const normalize = (rules: readonly StrategyRuleLike[]): string =>
    JSON.stringify(
      [...rules]
        .map((rule) => [
          rule.field.trim().toLowerCase(),
          rule.change.trim(),
          rule.reason.trim(),
        ])
        .sort(
          (a, b) => a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!)
        )
    );
  return normalize(current) !== normalize(next);
}

interface StrategyRuleLike {
  field: string;
  change: string;
  reason: string;
}
