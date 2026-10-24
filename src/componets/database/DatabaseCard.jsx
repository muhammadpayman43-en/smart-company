import {
  FiServer,
  FiDatabase,
  FiFolder,
} from "react-icons/fi";

import { useLanguage } from "../../i18n/translation";

import "./DatabaseCard.css";

function DatabaseCard({ type, onSelect, disabled=false }) {
  const { t } = useLanguage();

  const cardData = {
    connect: {
      title: t("connect"),
      description: t("connectToServer"),
      className: "connect",
      icon: <FiServer />,
    },

    create: {
      title: t("create"),
      description: t("createNewDatabase"),
      className: "create",
      icon: <FiDatabase />,
    },

    open: {
      title: t("open"),
      description: t("openExistingDatabase"),
      className: "open",
      icon: <FiFolder />,
    },
  };

  const card = cardData[type];

  return (
    <article className={`database-card ${card.className}`}>
      <button
        type="button"
        className="database-card-button"
        disabled={disabled}
        onClick={() => onSelect(type)}
      >
        <div className="database-card-top">
          <div className="database-card-lines">
            <span></span>
            <span></span>
            <span></span>
          </div>

          <div className="database-card-icon">
            {card.icon}
          </div>
        </div>

        <div className="database-card-content">
          <h2>{card.title}</h2>
          <p>{card.description}</p>
        </div>
      </button>
    </article>
  );
}

export default DatabaseCard;
