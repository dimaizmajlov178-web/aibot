import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface CryptoService {
  encrypt(secret: string): string;
  decrypt(payload: string): string;
  fingerprint(secret: string): string;
}

const FERNET_VERSION = 0x80;
const FERNET_TIMESTAMP_BYTES = 8;
const FERNET_IV_BYTES = 16;
const FERNET_HMAC_BYTES = 32;
const FERNET_KEY_BYTES = 32;
const SIGNING_KEY_BYTES = 16;
const MIN_TOKEN_BYTES =
  1 + FERNET_TIMESTAMP_BYTES + FERNET_IV_BYTES + FERNET_HMAC_BYTES;

interface FernetKey {
  /** Первые 16 байт ключа — ключ подписи HMAC-SHA256. */
  signingKey: Buffer;
  /** Последние 16 байт ключа — ключ AES-128-CBC. */
  encryptionKey: Buffer;
}

function requireKey(encryptionKey: string): void {
  if (!encryptionKey) {
    throw new Error(
      "ENCRYPTION_KEY не задан. Укажите ключ шифрования API-ключей в переменной окружения ENCRYPTION_KEY"
    );
  }
}

function tryBase64UrlDecode(value: string): Buffer | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Нормализует ENCRYPTION_KEY из .env в валидный 32-байтовый ключ Fernet.
 * Если значение уже является URL-safe base64 от 32 байт (например,
 * сгенерированное createFernetKey) — используется напрямую. Иначе ключ
 * детерминированно выводится из строки через SHA-256, что позволяет
 * использовать обычные строки/hex без потери совместимости.
 */
function toFernetKey(encryptionKey: string): FernetKey {
  requireKey(encryptionKey);
  let raw = tryBase64UrlDecode(encryptionKey);
  if (!raw || raw.length !== FERNET_KEY_BYTES) {
    raw = createHash("sha256").update(encryptionKey).digest();
  }
  return {
    signingKey: raw.subarray(0, SIGNING_KEY_BYTES),
    encryptionKey: raw.subarray(SIGNING_KEY_BYTES),
  };
}

function base64UrlToken(bytes: Buffer): string {
  const encoded = bytes.toString("base64url");
  return encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
}

function decodeToken(token: string): Buffer | null {
  try {
    const decoded = Buffer.from(token, "base64url");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function hmacForKey(key: FernetKey, body: Buffer): Buffer {
  return createHmac("sha256", key.signingKey).update(body).digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Fernet-совместимое симметричное шифрование (спецификация
 * https://github.com/fernet/spec): AES-128-CBC + HMAC-SHA256,
 * токен в формате version || timestamp || iv || ciphertext || hmac,
 * закодированный base64url. Ключ берётся из .env (ENCRYPTION_KEY).
 */
export function createCrypto(encryptionKey: string): CryptoService {
  const encrypt = (secret: string): string => {
    const key = toFernetKey(encryptionKey);
    if (!secret) {
      throw new Error("Шифрование пустого значения не поддерживается");
    }

    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const iv = randomBytes(FERNET_IV_BYTES);

    const cipher = createCipheriv("aes-128-cbc", key.encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);

    const header = Buffer.allocUnsafe(
      1 + FERNET_TIMESTAMP_BYTES + FERNET_IV_BYTES
    );
    header[0] = FERNET_VERSION;
    header.writeBigUInt64BE(timestamp, 1);
    iv.copy(header, 1 + FERNET_TIMESTAMP_BYTES);

    const body = Buffer.concat([header, ciphertext]);
    const hmac = hmacForKey(key, body);
    return base64UrlToken(Buffer.concat([body, hmac]));
  };

  const decrypt = (payload: string): string => {
    const key = toFernetKey(encryptionKey);
    const token = decodeToken(payload);
    if (!token || token.length < MIN_TOKEN_BYTES) {
      throw new Error("Неверный формат зашифрованного значения");
    }
    if (token[0] !== FERNET_VERSION) {
      throw new Error("Неверный формат зашифрованного значения");
    }

    const body = token.subarray(0, token.length - FERNET_HMAC_BYTES);
    const expectedHmac = token.subarray(token.length - FERNET_HMAC_BYTES);
    const actualHmac = hmacForKey(key, body);
    if (!safeEqual(actualHmac, expectedHmac)) {
      throw new Error("Неверный формат зашифрованного значения");
    }

    const ivStart = 1 + FERNET_TIMESTAMP_BYTES;
    const iv = body.subarray(ivStart, ivStart + FERNET_IV_BYTES);
    const ciphertext = body.subarray(ivStart + FERNET_IV_BYTES);

    const decipher = createDecipheriv("aes-128-cbc", key.encryptionKey, iv);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  };

  const fingerprint = (secret: string): string =>
    createHash("sha256").update(secret).digest("hex");

  return { encrypt, decrypt, fingerprint };
}

/**
 * Генерирует ключ Fernet для .env: URL-safe base64 от 32 байт
 * (44 символа). Полученное значение задаётся в ENCRYPTION_KEY.
 */
export function createFernetKey(): string {
  const raw = randomBytes(FERNET_KEY_BYTES);
  const encoded = raw.toString("base64url");
  return encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
}

/** Алиас для обратной совместимости с прежним генератором ключа. */
export const createEncryptionKey = createFernetKey;
