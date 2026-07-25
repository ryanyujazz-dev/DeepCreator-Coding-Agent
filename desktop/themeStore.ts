import { app } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ThemePack } from "../shared/contracts/theme";
import { BUILTIN_THEMES, validateThemePack } from "../shared/themeCatalog";

export class ThemeStore {
  private readonly directory: string;

  constructor() {
    this.directory = path.join(app.getPath("userData"), "themes");
    mkdirSync(this.directory, { recursive: true });
  }

  all(): ThemePack[] {
    const custom: ThemePack[] = [];
    for (const file of this.files()) {
      try {
        const theme = validateThemePack(JSON.parse(readFileSync(file, "utf8")));
        if (!theme.readonly && theme.source !== "builtin") custom.push(theme);
      } catch {
        // A damaged custom theme is ignored so settings remain available.
      }
    }
    return [...structuredClone(BUILTIN_THEMES), ...custom.sort((left, right) => left.name.localeCompare(right.name))];
  }

  get(id: string): ThemePack | undefined {
    return this.all().find((theme) => theme.id === id);
  }

  save(input: ThemePack): ThemePack {
    const theme = validateThemePack({ ...input, readonly: false, source: input.source === "imported" ? "imported" : "custom" });
    if (BUILTIN_THEMES.some((builtin) => builtin.id === theme.id)) throw new Error("不能覆盖内置主题。");
    const target = this.file(theme.id);
    const temporary = `${target}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(theme, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    return theme;
  }

  remove(id: string): void {
    if (BUILTIN_THEMES.some((theme) => theme.id === id)) throw new Error("不能删除内置主题。");
    const target = this.file(id);
    if (existsSync(target)) rmSync(target);
  }

  private file(id: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(id)) throw new Error("主题 ID 无效。");
    return path.join(this.directory, `${id}.json`);
  }

  private files(): string[] {
    try {
      return readdirSync(this.directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(this.directory, name));
    } catch {
      return [];
    }
  }
}
