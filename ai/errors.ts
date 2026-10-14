export class AiAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiAnalysisError";
  }
}

export class InsufficientMarketDataError extends AiAnalysisError {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientMarketDataError";
  }
}

export class DeepSeekError extends AiAnalysisError {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekError";
  }
}

export class DeepSeekConfigError extends DeepSeekError {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekConfigError";
  }
}

export class DeepSeekApiError extends DeepSeekError {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "DeepSeekApiError";
  }
}

export class AiResponseError extends AiAnalysisError {
  constructor(message: string) {
    super(message);
    this.name = "AiResponseError";
  }
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
