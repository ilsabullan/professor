import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { laserLog, onLaserEnd, onStrokeEnd } from "./lib/events";
import "./styles.css";

// 개발 중 콘솔에서 이벤트를 확인할 수 있게 열어 둔다 (예: ink.onStrokeEnd(console.log))
if (import.meta.env.DEV) Object.assign(window, { ink: { onStrokeEnd, onLaserEnd, laserLog } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
