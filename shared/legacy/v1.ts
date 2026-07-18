export const LEGACY_EVENT_VERSION = "deepseeker.flow/v1" as const;

export type LegacyEvent = {
  contract: typeof LEGACY_EVENT_VERSION;
  signalKey: string;
  offset: number;
  topic: string;
  scope: {
    sessionKey: string;
    cycleKey?: string;
    unitKey?: string;
  };
  emittedAt: string;
  payload: unknown;
};
