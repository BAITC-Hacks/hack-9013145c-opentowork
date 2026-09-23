import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Шрифты встроены в сборку: CSP в nginx разрешает только 'self', а на
// площадке может не быть интернета.
import "@fontsource/golos-text/400.css";
import "@fontsource/golos-text/500.css";
import "@fontsource/golos-text/600.css";
import "@fontsource/martian-mono/400.css";
import "@fontsource/martian-mono/500.css";
import "@fontsource/tektur/500.css";
import "@fontsource/tektur/600.css";
import "./styles.css";
import "./twin/twin.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
