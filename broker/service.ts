import type { CryptoService } from "../core/crypto";
import { BrokerConnectionError, type BaseBroker } from "./base";
import type { BrokerAccount } from "./base";
import type {
  BrokerConnection,
  BrokerRepository,
} from "../db/broker-repository";
import type { AuditMeta } from "../core/audit";
import { createBroker, type CreateBrokerOptions } from "./factory";
import { parseBrokerApiKey } from "./validation";

function maskApiKey(apiKey: string): string {
  const first = apiKey.slice(0, 4);
  const last = apiKey.slice(-4);
  return `${first}••••${last}`;
}

export interface BrokerServiceDeps {
  crypto: CryptoService;
  repository: BrokerRepository;
  brokerType: string;
  /** Базовый URL API реального брокера (BROKER_API_BASE_URL). */
  brokerApiBaseUrl?: string;
  /** HTTP-заголовок авторизации брокера (BROKER_API_KEY_HEADER). */
  brokerApiKeyHeader?: string;
  /** Журнал аудита привязки/отключения брокера. */
  audit?: import("../core/audit").AuditService;
}

export interface ConnectResult {
  account: BrokerAccount;
  brokerName: string;
  connectedAt: string;
}

export class BrokerService {
  constructor(private readonly deps: BrokerServiceDeps) {}

  /** Опции создания клиента брокера из конфига окружения. */
  private brokerOptions(): CreateBrokerOptions {
    return {
      baseUrl: this.deps.brokerApiBaseUrl,
      apiKeyHeader: this.deps.brokerApiKeyHeader,
    };
  }

  async isConnected(userId: number): Promise<boolean> {
    return (await this.deps.repository.findByUserId(userId)) !== null;
  }

  async listUserIds(): Promise<number[]> {
    return this.deps.repository.listUserIds();
  }

  async connectUser(
    userId: number,
    rawApiKey: string,
    meta: AuditMeta = {}
  ): Promise<ConnectResult> {
    if (await this.isConnected(userId)) {
      throw new BrokerConnectionError(
        "Брокер уже подключён. Сначала отключите его: /disconnect"
      );
    }

    const apiKey = parseBrokerApiKey(rawApiKey);
    const broker = createBroker(
      this.deps.brokerType,
      apiKey,
      this.brokerOptions()
    );
    const account = await broker.testConnection();

    const connection: BrokerConnection = {
      userId,
      brokerType: this.deps.brokerType,
      encryptedApiKey: this.deps.crypto.encrypt(apiKey),
      keyFingerprint: this.deps.crypto.fingerprint(apiKey),
      connectedAt: new Date().toISOString(),
    };
    await this.deps.repository.save(connection);

    await this.deps.audit?.brokerConnect({
      userId,
      actorId: meta.actorId ?? userId,
      actorRole: meta.actorRole ?? "user",
      requestId: meta.requestId ?? null,
      entityType: "broker_connection",
      entityId: userId,
      details: {
        brokerType: connection.brokerType,
        brokerName: broker.name,
        // Никогда не записываем ключ — только маску и префикс отпечатка.
        keyMask: maskApiKey(apiKey),
        keyFingerprintPrefix: connection.keyFingerprint.slice(0, 12),
      },
    });

    return {
      account,
      brokerName: broker.name,
      connectedAt: connection.connectedAt,
    };
  }

  async getBrokerForUser(userId: number): Promise<BaseBroker | null> {
    const connection = await this.deps.repository.findByUserId(userId);
    if (!connection) {
      return null;
    }
    const apiKey = this.deps.crypto.decrypt(connection.encryptedApiKey);
    return createBroker(connection.brokerType, apiKey, this.brokerOptions());
  }

  async disconnectUser(userId: number, meta: AuditMeta = {}): Promise<boolean> {
    const removed = await this.deps.repository.deleteByUserId(userId);
    if (removed) {
      await this.deps.audit?.brokerDisconnect({
        userId,
        actorId: meta.actorId ?? userId,
        actorRole: meta.actorRole ?? "user",
        requestId: meta.requestId ?? null,
        entityType: "broker_connection",
        entityId: userId,
        details: { brokerType: this.deps.brokerType },
      });
    }
    return removed;
  }
}
