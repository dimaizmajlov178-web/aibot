/**
 * Executable rules of the active strategy (learning).
 * Before opening a new position the trading core checks indicators against
 * the active strategy rules and blocks the entry if a rule is violated.
 */

export interface StrategyRuleLike {
  field: string;
  change: string;
}

export interface StrategyRuleCheck {
  blocked: boolean;
  reasons: string[];
}

function extractNumber(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Checks active strategy rules against symbol indicators.
 * Rules are mapped by field name; numeric thresholds are read from change
 * text (e.g. "RSI > 72", "VWAP-dev > 1.5%") with defaults when absent.
 */
export function evaluateStrategyRules(
  rules: readonly StrategyRuleLike[],
  side: "long" | "short",
  indicators: { rsi: number; cvd: number; vwapDeviation: number }
): StrategyRuleCheck {
  const reasons: string[] = [];
  const { rsi, cvd, vwapDeviation } = indicators;

  for (const rule of rules ?? []) {
    const field = (rule.field ?? "").toLowerCase();
    const change = rule.change ?? "";

    if (side === "long") {
      const isLongRule =
        field.includes("long") || field.includes("entry_filter") || field.includes("cvd");
      if (!isLongRule) {
        continue;
      }
      if (
        field.includes("rsi") ||
        field.includes("overbought") ||
        field.includes("entry_filter")
      ) {
        const threshold =
          extractNumber(change, /RSI\s*(?:>|>=)?\s*(\d+(?:\.\d+)?)/i) ?? 72;
        if (rsi > threshold) {
          reasons.push(
            `strategy: long blocked (RSI ${rsi.toFixed(1)} > ${threshold})`
          );
        }
      }
      if (field.includes("vwap")) {
        const threshold =
          extractNumber(
            change,
            /VWAP[^%\d]*>\s*\+?(\d+(?:\.\d+)?)\s*%/i
          ) ?? 1.5;
        if (vwapDeviation > threshold) {
          reasons.push(
            `strategy: long blocked (VWAP dev ${vwapDeviation.toFixed(2)}% > ${threshold}%)`
          );
        }
      }
      if (field.includes("cvd") && cvd < 0) {
        reasons.push(`strategy: long blocked (CVD negative: ${cvd.toFixed(0)})`);
      }
    }
  }

  return { blocked: reasons.length > 0, reasons };
}
