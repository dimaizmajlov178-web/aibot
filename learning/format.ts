import type {
  AbTestComparisonResult,
  LearningReport,
  MetricsSnapshot,
  StrategyState,
  StrategyVersion,
} from "./types";

const money = (value: number): string =>
  value.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const signedMoney = (value: number): string =>
  value >= 0 ? `+${money(value)}` : money(value);

const percent = (value: number): string => `${money(value)}%`;

const REPORT_STATUS_LABEL: Record<LearningReport["status"], string> = {
  strategy_created: "создана новая версия стратегии",
  no_changes: "изменений нет",
  insufficient_data: "недостаточно данных",
  failed: "ошибка генерации",
};

export function formatMetrics(metrics: MetricsSnapshot | null): string {
  if (!metrics) {
    return "Метрик нет (недостаточно закрытых сделок)";
  }
  return [
    `Сделок: ${metrics.totalTrades} (${metrics.wins} приб. / ${metrics.losses} убыт.)`,
    `Винрейт: ${percent(metrics.winrate)}`,
    `Профит-фактор: ${metrics.profitFactor === 99 ? "∞" : metrics.profitFactor}`,
    `Средний R: ${money(metrics.averageR)}`,
    `Просадка: ${percent(metrics.maxDrawdownPercent)}`,
    `Чистый PnL: ${signedMoney(metrics.netPnl)}`,
    `Период: ${metrics.periodStart.slice(0, 10)} — ${metrics.periodEnd.slice(0, 10)}`,
  ].join("\n");
}

export function formatLearningReport(report: LearningReport): string {
  const lines = [
    `Learning-отчёт ${report.reportDate} (${REPORT_STATUS_LABEL[report.status]})`,
    `Сделок в выборке: ${report.tradeCount}`,
    "",
    report.summary,
  ];

  if (report.successPatterns.length > 0) {
    lines.push(
      "",
      "Паттерны успеха:",
      ...report.successPatterns.map((pattern) => `• ${pattern}`)
    );
  }
  if (report.failurePatterns.length > 0) {
    lines.push(
      "",
      "Паттерны неудач:",
      ...report.failurePatterns.map((pattern) => `• ${pattern}`)
    );
  }
  if (report.ruleAdjustments.length > 0) {
    lines.push(
      "",
      "Корректировки правил:",
      ...report.ruleAdjustments.map(
        (rule) => `• ${rule.field}: ${rule.change} (${rule.reason})`
      )
    );
  }
  if (report.strategyVersion != null) {
    lines.push(
      "",
      `Создана версия стратегии v${report.strategyVersion} (candidate).`,
      formatMetrics(report.metrics)
    );
  }

  return lines.join("\n");
}

export function formatStrategyList(
  state: StrategyState,
  versions: readonly StrategyVersion[]
): string {
  const lines = [
    `Текущая стратегия: v${state.activeVersion}`,
    `Последний отчёт: ${state.lastReportDate ?? "—"}`,
  ];

  const ab = state.abTest;
  if (ab?.enabled) {
    const status =
      ab.testVersion != null && ab.referenceVersion != null
        ? `Сравниваю v${ab.referenceVersion} (база) vs v${ab.testVersion} (тест) с ${ab.startedAt?.slice(0, 16)}`
        : "A/B тест активен";
    lines.push(`A/B: ${status}`);
  } else if (ab?.startedAt && ab.endedAt) {
    lines.push(`A/B завершён ${ab.endedAt.slice(0, 16)}`);
  }

  lines.push("", "Версии:");
  for (const version of versions) {
    const status =
      version.status === "active" ? " [активна]" : ` [${version.status}]`;
    const metrics =
      version.metrics != null
        ? ` винрейт=${percent(version.metrics.winrate)} PF=${version.metrics.profitFactor === 99 ? "∞" : version.metrics.profitFactor}`
        : "";
    lines.push(`v${version.version}${status}${metrics}`);
  }

  return lines.join("\n");
}

export function formatAbTestResults(
  comparison: AbTestComparisonResult
): string {
  const lines = [
    `A/B тест v${comparison.referenceVersion} vs v${comparison.testVersion}`,
    `Период: ${comparison.startedAt?.slice(0, 16) ?? "—"} — ${comparison.endedAt?.slice(0, 16) ?? "ещё идёт"}`,
    "",
    `Сделок по базе (v${comparison.referenceVersion}): ${comparison.referenceTrades}`,
    `Сделок по тесту (v${comparison.testVersion}): ${comparison.testTrades}`,
    "",
    "Базовая стратегия:",
    formatMetrics(comparison.reference),
    "",
    "Тестовая стратегия:",
    formatMetrics(comparison.test),
  ];
  return lines.join("\n");
}

export function formatStrategyVersion(version: StrategyVersion): string {
  const lines = [
    `Стратегия v${version.version} [${version.status}]`,
    version.name,
    `Правил: ${version.rules.length}`,
  ];
  for (const rule of version.rules) {
    lines.push(`• ${rule.field}: ${rule.change} (${rule.reason})`);
  }
  lines.push("", "Метрики:", formatMetrics(version.metrics));
  return lines.join("\n");
}
