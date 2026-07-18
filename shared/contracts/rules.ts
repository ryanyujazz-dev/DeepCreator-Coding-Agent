export type RuleOrigin = "personal" | "workspace" | "project" | "local" | "path";
export type RuleTrust = "user_owned" | "trusted_project" | "untrusted_project";
export type RuleReach = "global" | "project" | "subtree" | "path_pattern";
export type RuleLoad = "session_start" | "on_path_access" | "explicit";

export type ResolvedRule = {
  activationReason: string;
  appliesTo: string[];
  body: string;
  guidanceId: string;
  hash: string;
  instructionKey: string;
  loadPolicy: RuleLoad;
  origin: RuleOrigin;
  precedenceRank: number;
  priority: number;
  reach: RuleReach;
  reason: string;
  revisionHash: string;
  scope: RuleOrigin;
  selectors: string[];
  sourceFile: string;
  sourcePath: string;
  text: string;
  trust: RuleTrust;
};

export type ResolveRulesInput = {
  activePaths?: string[];
  phase?: "session_start" | "path_access";
  projectRoot: string;
};

export interface RuleSource {
  render(rules: ResolvedRule[], envelope?: "stable" | "update"): string | undefined;
  resolve(input: ResolveRulesInput): ResolvedRule[];
}

export const emptyRuleSource: RuleSource = {
  render: () => undefined,
  resolve: () => []
};
