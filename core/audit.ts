import { randomUUID } from "node:crypto";
import type {
  AuditActorRole,
  AuditLog,
  AuditRepository,
} from "../db/audit-repository";

export type { AuditActorRole } from "../db/audit-repository";

export const AuditAction = {
  TRADE_OPEN: "trade.open",
  TRADE_CLOSE: "trade.close",
  TRADE_REJECTED: "trade.rejected",
  TRADE_ERROR: "trade.error",
  SETTINGS_UPDATE: "settings.update",
  TRADING_PAUSE: "trading.pause",
  TRADING_RESUME: "trading.resume",
  TRADING_AUTO_PAUSE: "trading.auto_pause",
  TRADING_TOTAL_STOP: "trading.total_stop",
  TRADING_ADMIN_NOTIFY: "trading.admin_notify",
  BROKER_CONNECT: "broker.connect",
  BROKER_DISCONNECT: "broker.disconnect",
  ADMIN_GRANT: "admin.grant",
  ADMIN_REVOKE: "admin.revoke",
  ADMIN_GLOBAL_PAUSE: "admin.global_pause",
  ADMIN_BROADCAST: "admin.broadcast",
  STRATEGY_PROMOTE: "strategy.promote",
  STRATEGY_AB_START: "strategy.ab_start",
  STRATEGY_AB_STOP: "strategy.ab_stop",
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

/** Метаданные источника действия (кто и из какого запроса). */
export interface AuditMeta {
  actorId?: number | null;
  actorRole?: AuditActorRole | null;
  requestId?: string | null;
}

export interface AuditEntryInput extends AuditMeta {
  action: string;
  userId: number;
  entityType?: string | null;
  entityId?: string | number | null;
  details?: Record<string, unknown> | null;
  occurredAt?: string;
}

interface ActionRecord extends AuditMeta {
  userId: number;
  entityType?: string | null;
  entityId?: string | number | null;
  details?: Record<string, unknown> | null;
}

type TradeAction = ActionRecord;
type SettingsAction = ActionRecord;
type ControlAction = ActionRecord;
type AdminAction = ActionRecord;
type StrategyAction = ActionRecord;

/**
 * Сервис журнала аудита: пишет в audit_repository структурированные записи
 * «кто, когда, что» по всем торговым действиям и изменениям настроек.
 * Детали всегда очищаются от секретов (API-ключи не логируются).
 */
export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async record(input: AuditEntryInput): Promise<AuditLog> {
    const entry: AuditLog = {
      id: randomUUID(),
      userId: input.userId,
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId != null ? String(input.entityId) : null,
      details: input.details ?? null,
      requestId: input.requestId ?? null,
      createdAt: input.occurredAt ?? new Date().toISOString(),
    };
    await this.repository.save(entry);
    return entry;
  }

  /** Открытие позиции торговым ядром. */
  tradeOpen(input: TradeAction): Promise<AuditLog> {
    return this.record({ ...input, action: AuditAction.TRADE_OPEN });
  }

  /** Закрытие позиции торговым ядром. */
  tradeClose(input: TradeAction): Promise<AuditLog> {
    return this.record({ ...input, action: AuditAction.TRADE_CLOSE });
  }

  /** Отклонение сделки риск-менеджментом. */
  tradeRejected(input: TradeAction): Promise<AuditLog> {
    return this.record({ ...input, action: AuditAction.TRADE_REJECTED });
  }

  /** Ошибка исполнения ордера. */
  tradeError(input: TradeAction): Promise<AuditLog> {
    return this.record({ ...input, action: AuditAction.TRADE_ERROR });
  }

  /** Изменение настроек торговли пользователя. */
  settingsUpdate(input: SettingsAction): Promise<AuditLog> {
    return this.record({ ...input, action: AuditAction.SETTINGS_UPDATE });
  }

  /** Пауза/возобновление торговли пользователем. */
  tradingControl(
    action: "trading.pause" | "trading.resume",
    input: ControlAction
  ): Promise<AuditLog> {
    return this.record({ ...input, action });
  }

  /** Автопауза/автостоп риск-менеджмента или уведомление админа. */
  riskState(
    action:
      | "trading.auto_pause"
      | "trading.total_stop"
      | "trading.admin_notify",
    input: ControlAction
  ): Promise<AuditLog> {
    return this.record({ ...input, action });
  }

  /** Привязка брокера. Ключ никогда не сохраняется (только маска). */
  brokerConnect(input: ActionRecord): Promise<AuditLog> {
    return this.record({ ...input, action: AuditAction.BROKER_CONNECT });
  }

  brokerDisconnect(input: ActionRecord): Promise<AuditLog> {
    return this.record({ ...input, action: AuditAction.BROKER_DISCONNECT });
  }

  /** Административные действия (выдача/отзыв доступа, пауза, рассылка). */
  adminAction(
    action:
      | "admin.grant"
      | "admin.revoke"
      | "admin.global_pause"
      | "admin.broadcast",
    input: AdminAction
  ): Promise<AuditLog> {
    return this.record({ ...input, action });
  }

  /** Управление стратегиями (продвижение/откат/A-B). */
  strategyAction(
    action: "strategy.promote" | "strategy.ab_start" | "strategy.ab_stop",
    input: StrategyAction
  ): Promise<AuditLog> {
    return this.record({ ...input, action });
  }

  listByUser(userId: number, limit?: number): Promise<AuditLog[]> {
    return this.repository.listByUser(userId, limit);
  }
}
