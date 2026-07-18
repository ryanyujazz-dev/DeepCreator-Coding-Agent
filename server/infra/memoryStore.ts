import { MemoryFact } from "../../shared/contracts/context";
import { Database } from "./database";

type MemoryInput = Omit<MemoryFact, "createdAt" | "lastConfirmedAt" | "memoryId">
  & Partial<Pick<MemoryFact, "createdAt" | "lastConfirmedAt" | "memoryId">>;

export class MemoryStore {
  constructor(private readonly database: Database) {}

  save(input: MemoryInput): MemoryFact {
    const statement = input.statement.trim();
    if (!statement) throw new Error("memory statement is required");
    if (/\bsk-[a-zA-Z0-9_-]{12,}\b|(?:api[_ -]?key|token|password|secret)\s*[:=]/i.test(statement)) {
      throw new Error("Memory 不允许保存密钥或凭据。");
    }
    const now = new Date().toISOString();
    const memoryId = input.memoryId ?? `memory_${crypto.randomUUID()}`;
    const row = this.database.raw.prepare("SELECT memory_json FROM memories WHERE memory_id = ?").get(memoryId) as { memory_json: string } | undefined;
    const previous = row ? JSON.parse(row.memory_json) as MemoryFact : undefined;
    const fact: MemoryFact = {
      category: input.category,
      confidence: Math.min(1, Math.max(0, input.confidence)),
      createdAt: previous?.createdAt ?? input.createdAt ?? now,
      expiresAt: input.expiresAt,
      lastConfirmedAt: input.lastConfirmedAt ?? now,
      memoryId,
      projectRoot: input.visibility === "project" ? input.projectRoot : undefined,
      provenance: input.provenance.trim(),
      statement,
      visibility: input.visibility
    };
    if (fact.visibility === "project" && !fact.projectRoot) throw new Error("project memory requires projectRoot");
    this.database.raw.prepare(`INSERT INTO memories
      (memory_id, visibility, project_root, category, updated_at, memory_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        visibility = excluded.visibility,
        project_root = excluded.project_root,
        category = excluded.category,
        updated_at = excluded.updated_at,
        memory_json = excluded.memory_json`)
      .run(fact.memoryId, fact.visibility, fact.projectRoot ?? null, fact.category, fact.lastConfirmedAt, JSON.stringify(fact));
    return structuredClone(fact);
  }

  read(projectRoot?: string): MemoryFact[] {
    const now = new Date().toISOString();
    const rows = projectRoot
      ? this.database.raw.prepare(`SELECT memory_json FROM memories
          WHERE visibility = 'personal' OR (visibility = 'project' AND project_root = ?)
          ORDER BY updated_at DESC`).all(projectRoot)
      : this.database.raw.prepare("SELECT memory_json FROM memories WHERE visibility = 'personal' ORDER BY updated_at DESC").all();
    return (rows as Array<{ memory_json: string }>)
      .map((row) => JSON.parse(row.memory_json) as MemoryFact)
      .filter((fact) => !fact.expiresAt || fact.expiresAt > now)
      .map((fact) => structuredClone(fact));
  }

  delete(memoryId: string): boolean {
    return Number(this.database.raw.prepare("DELETE FROM memories WHERE memory_id = ?").run(memoryId).changes) > 0;
  }
}
