export interface SystemPort {
  createId(prefix: string): string;
  now(): string;
  nowMs(): number;
}
