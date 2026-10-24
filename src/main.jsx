import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/colors.css";

document.documentElement.dataset.theme = localStorage.getItem("app-theme") || "light";

import App from "./App";
import { LanguageProvider } from "./i18n/translation";
import {LicenseProvider} from "./context/LicenseContext";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <LanguageProvider>
      <LicenseProvider><App /></LicenseProvider>
    </LanguageProvider>
  </StrictMode>
);
