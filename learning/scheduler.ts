import type { LearningService } from "./service";

export const DEFAULT_LEARNING_INTERVAL_MS = 6 * 3_600_000;

export interface DailyLearningSchedulerDeps {
  learning: LearningService;
  /** Интервал проверки необходимости отчёта (по умолчанию 6 часов). */
  intervalMs?: number;
  onError?: (userId: number, error: unknown) => void;
  /** Разовый запуск сразу после старта (полезно для dry-run тестов). */
  runImmediately?: boolean;
}

export interface DailyLearningScheduler {
  stop(): void;
}

/**
 * Планировщик суточного learning-отчёта: раз в intervalMs проверяет
 * пользователей с данными и запускает runDailyReport, который сам
 * гарантирует генерацию не чаще раза в сутки.
 */
export function startDailyLearningScheduler(
  deps: DailyLearningSchedulerDeps
): DailyLearningScheduler {
  const intervalMs = deps.intervalMs ?? DEFAULT_LEARNING_INTERVAL_MS;

  const run = async (): Promise<void> => {
    let userIds: number[] = [];
    try {
      userIds = await deps.learning.listUsersWithData();
    } catch (error) {
      deps.onError?.(0, error);
      return;
    }
    for (const userId of userIds) {
      try {
        await deps.learning.runDailyReport(userId);
      } catch (error) {
        deps.onError?.(userId, error);
      }
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();

  if (deps.runImmediately) {
    setTimeout(() => void run(), 1_000);
  }

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
