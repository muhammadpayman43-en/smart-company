import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import AppHeader from "../../componets/layout/AppHeader/AppHeader";
import DatabaseCard from "../../componets/database/DatabaseCard";
import CreateDatabaseModal from "../../componets/CreateDatabaseModel/CreateDatabaseModel";
import databaseCards from "../../data/databaseCard";
import { useLanguage } from "../../i18n/translation";
import { listLocalDatabases, registerExistingDatabase } from "../../sevices/database";
import DatabaseLoginPage from "./DatabaseLoginPage";
import ServerConnection from "../../componets/database/ServerConnection";
import {closeTopDialog,confirmAndroidExit,useAndroidBack} from "../../hooks/useAndroidBack";

import "./LoginPage.css";

function LoginPage({ onEnterDashboard }) {
  const { t,language } = useLanguage();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [databases, setDatabases] = useState([]);
  const [selectedDatabase, setSelectedDatabase] = useState(null);
  const [isLoadingDatabases, setIsLoadingDatabases] = useState(true);
  const [isOpeningDatabase, setIsOpeningDatabase] = useState(false);
  const [pageError, setPageError] = useState("");
  const [serverConnectionOpen,setServerConnectionOpen]=useState(false);
  const exitPending=useRef(false);
  useAndroidBack(()=>{
    if(isCreateModalOpen){setIsCreateModalOpen(false);return}
    if(closeTopDialog())return;
    if(selectedDatabase){setSelectedDatabase(null);return}
    if(serverConnectionOpen){setServerConnectionOpen(false);return}
    if(exitPending.current)return;exitPending.current=true;confirmAndroidExit(language).finally(()=>{exitPending.current=false});
  });

  useEffect(() => {
    if (!isTauri()) {
      setIsLoadingDatabases(false);
      return;
    }
    listLocalDatabases()
      .then((localDatabases) => {
        setDatabases(localDatabases);
      })
      .catch(() => setPageError("databaseListFailed"))
      .finally(() => setIsLoadingDatabases(false));
  }, []);

  const handleOpenExistingDatabase = async () => {
    setPageError("");
    if (!isTauri()) {
      setPageError("databaseActionsRequireDesktop");
      return;
    }

    setIsOpeningDatabase(true);
    try {
      const selectedPath = await open({
        multiple: false,
        title: t("selectExistingDatabase"),
        filters: [{
          name: t("databaseFile"),
          extensions: ["sqlite3", "sqlite", "db"],
        }],
      });

      if (!selectedPath || typeof selectedPath !== "string") return;
      const database = await registerExistingDatabase(selectedPath);
      setDatabases((previous) => [
        ...previous.filter((entry) => entry.databasePath !== database.databasePath),
        database,
      ]);
      setSelectedDatabase(database);
    } catch (error) {
      const message = typeof error === "string" ? error : error?.message;
      setPageError(
        message === "invalid_database_file"
          ? "invalidDatabaseFile"
          : "databaseImportFailed",
      );
    } finally {
      setIsOpeningDatabase(false);
    }
  };

  const handleCardSelect = (id) => {
    if (id === "connect") {
      setPageError("");
      setSelectedDatabase(null);
      setServerConnectionOpen(true);
      return;
    }

    if (id === "create") {
      setIsCreateModalOpen(true);
    } else if (id === "open") {
      handleOpenExistingDatabase();
    }
  };

  if(serverConnectionOpen)return <ServerConnection onBack={()=>setServerConnectionOpen(false)} onConnect={onEnterDashboard}/>;
  if (selectedDatabase) {
    return (
      <DatabaseLoginPage
        database={selectedDatabase}
        onBack={() => setSelectedDatabase(null)}
        onLoginSuccess={onEnterDashboard}
      />
    );
  }

  return (
    <main className="login-page">

      <AppHeader />

      <section className="login-welcome" aria-labelledby="welcome-title">
        <span className="login-welcome-kicker">{t("managementSystem")}</span>
        <h1 id="welcome-title">{t("appName")}</h1>
        <p>{t("localDatabasesDescription")}</p>
      </section>

      <section
        className="database-options"
        aria-label={t("databaseOptions")}
      >
        {databaseCards.map((card) => (
          <DatabaseCard
            key={card.id}
            type={card.id}
            onSelect={handleCardSelect}
          />
        ))}
      </section>

      <section className="local-databases" aria-labelledby="local-databases-title">
        <div className="local-databases-heading">
          <div>
            <h1 id="local-databases-title">{t("localDatabases")}</h1>
            <p>{t("localDatabasesDescription")}</p>
          </div>
          {isOpeningDatabase && <span className="database-list-loading" role="status">{t("loading")}</span>}
        </div>

        {pageError && <p className="database-list-error" role="alert">{t(pageError)}</p>}
        {!isTauri() && <p className="database-list-empty">{t("databaseActionsRequireDesktop")}</p>}
        {isLoadingDatabases && <p className="database-list-empty" role="status">{t("loading")}</p>}
        {!isLoadingDatabases && isTauri() && databases.length === 0 && (
          <p className="database-list-empty">{t("noLocalDatabases")}</p>
        )}

        {databases.length > 0 && isTauri() && (
          <div className="local-database-grid">
            {databases.map((database) => (
              <button
                className="local-database-item"
                key={database.databasePath}
                type="button"
                onClick={() => setSelectedDatabase(database)}
              >
                <span className="local-database-icon" aria-hidden="true">DB</span>
                <span className="local-database-details">
                  <strong>{database.companyName}</strong>
                  <span>{database.databaseName}</span>
                  <small>{database.databasePath}</small>
                </span>
                <span className="local-database-open">{t("login")}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* کامپوننت فرم ۳ مرحله‌ای */}
      <CreateDatabaseModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreateSuccess={(database) => {
          setIsCreateModalOpen(false);
          onEnterDashboard(database);
        }}
      />

    </main>
  );
}

export default LoginPage;
