import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Шрифты встроены в сборку: CSP в nginx разрешает только 'self', а на
// площадке может не быть интернета.
import "@fontsource-variable/inter";
import "./styles.css";
import "./twin/twin.css";
import "./twin/design.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
