import { z } from "zod";

export const brokerApiKeySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(8, "API-ключ слишком короткий")
    .max(128, "API-ключ слишком длинный")
    .regex(/^[A-Za-z0-9._-]+$/, "API-ключ содержит недопустимые символы"),
});

export type BrokerApiKeyInput = z.infer<typeof brokerApiKeySchema>;

export function parseBrokerApiKey(raw: string): string {
  const parsed = brokerApiKeySchema.safeParse({ apiKey: raw });
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Некорректный API-ключ";
    throw new Error(message);
  }
  return parsed.data.apiKey;
}
