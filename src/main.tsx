import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/index";
import { runtimeApi } from "./runtimeApi";
import { ThemeProvider } from "./theme/ThemeProvider";
import { installWorkingGlowMotion } from "./workingGlowMotion";
import "./styles/index.css";
import { desktopBridge } from "./platform/desktop";

async function bootstrap(): Promise<void> {
  const desktop = desktopBridge();
  if (desktop) {
    const connection = await desktop.runtime.connection();
    runtimeApi.configure(connection);
  }
  const rootElement = document.getElementById("root")!;
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </React.StrictMode>
  );
  installWorkingGlowMotion(rootElement);
}

void bootstrap().catch((error) => {
  const root = document.getElementById("root")!;
  const main = document.createElement("main");
  const title = document.createElement("h1");
  const detail = document.createElement("p");
  main.className = "bootstrap-error";
  title.textContent = "DeepSeeker 无法启动";
  detail.textContent = error instanceof Error ? error.message : String(error);
  main.append(title, detail);
  root.replaceChildren(main);
});
