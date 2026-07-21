import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./tokens.css";
import { App } from "./App";
import { ToastProvider } from "./ui";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ToastProvider><App /></ToastProvider></React.StrictMode>,
);
