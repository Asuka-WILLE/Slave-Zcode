export class BridgeError extends Error {
  constructor(public code: string, message: string, public retryable = false) {
    super(message); this.name = 'BridgeError';
  }
}
export function errorInfo(error: unknown) {
  return {
    code: error instanceof BridgeError ? error.code : 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: error instanceof BridgeError && error.retryable
  };
}
