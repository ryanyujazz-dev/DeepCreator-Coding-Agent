import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/index";
import { runtimeApi } from "./runtimeApi";
import "./styles.css";

async function bootstrap(): Promise<void> {
  if (window.deepseeker) {
    const connection = await window.deepseeker.runtime.connection();
    runtimeApi.configure(connection);
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
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
