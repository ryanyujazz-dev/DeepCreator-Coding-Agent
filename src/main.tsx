import React from "react";
import ReactDOM from "react-dom/client";
import { DesktopAppRoot } from "./app/index";
import { ThemeProvider } from "./theme/ThemeProvider";
import { installWorkingGlowMotion } from "./workingGlowMotion";
import "./styles/index.css";

async function bootstrap(): Promise<void> {
  const rootElement = document.getElementById("root")!;
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <DesktopAppRoot />
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
  title.textContent = "DeepCreator 无法启动";
  detail.textContent = error instanceof Error ? error.message : String(error);
  main.append(title, detail);
  root.replaceChildren(main);
});
