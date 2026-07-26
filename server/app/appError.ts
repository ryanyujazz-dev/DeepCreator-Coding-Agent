export type AppErrorCode =
  | "conflict"
  | "invalid_input"
  | "not_found"
  | "not_waiting"
  | "stale_revision";

export class AppError extends Error {
  constructor(message: string, readonly code: AppErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
  }
}
