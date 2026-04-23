import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { OrchestraClientProvider } from "./lib/orchestraClient";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OrchestraClientProvider>
      <App />
    </OrchestraClientProvider>
  </React.StrictMode>,
);
