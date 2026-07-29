import { app } from "electron";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const PREVIOUS_PRODUCT_NAME = "DeepSeeker";

export function migratePreviousDesktopData(): void {
  const sourceRoot = path.join(app.getPath("appData"), PREVIOUS_PRODUCT_NAME);
  const targetRoot = app.getPath("userData");
  if (!existsSync(sourceRoot) || path.resolve(sourceRoot) === path.resolve(targetRoot)) return;
  mkdirSync(targetRoot, { recursive: true });
  for (const name of ["desktop.json", "runtime", "themes"]) {
    const source = path.join(sourceRoot, name);
    const target = path.join(targetRoot, name);
    if (!existsSync(source) || existsSync(target)) continue;
    cpSync(source, target, { errorOnExist: false, force: false, recursive: true });
  }
}
