const extensionLanguages: Record<string, string> = {
  bash: "shell",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  env: "shell",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  less: "less",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  php: "php",
  properties: "ini",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell"
};

const fileLanguages: Record<string, string> = {
  ".env": "shell",
  ".gitignore": "ignore",
  dockerfile: "dockerfile",
  makefile: "makefile"
};

export function languageForPath(filePath: string): string {
  const fileName = filePath.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? "";
  if (fileLanguages[fileName]) return fileLanguages[fileName];
  const extension = fileName.includes(".") ? fileName.split(".").at(-1) ?? "" : "";
  return extensionLanguages[extension] ?? "plaintext";
}
