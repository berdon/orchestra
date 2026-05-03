import React from "react";
import ReactDOM from "react-dom/client";

import { GitHubLandingPage } from "./GitHubLandingPage";
import "./github-landing.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GitHubLandingPage />
  </React.StrictMode>,
);
