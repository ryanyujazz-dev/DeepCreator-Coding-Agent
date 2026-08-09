import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["exec", "electron-forge", "start"], {
  env: { ...process.env, DEEPCREATOR_AUTH_MODE: "local" },
  stdio: "inherit"
});

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
