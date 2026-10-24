import { useState } from "react";
import { FiArrowLeft, FiDatabase, FiLock, FiUser } from "react-icons/fi";
import { useLanguage } from "../../i18n/translation";
import { authenticateLocalDatabase } from "../../sevices/database";
import "./DatabaseLoginPage.css";

function DatabaseLoginPage({ database, onBack, onLoginSuccess }) {
	const { t } = useLanguage();
	const [identifier, setIdentifier] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (event) => {
		event.preventDefault();
		setError("");
		setIsSubmitting(true);

		try {
			const session = await authenticateLocalDatabase(
				database.databasePath,
				identifier,
				password,
			);
			onLoginSuccess(session);
		} catch (loginError) {
			const message = typeof loginError === "string" ? loginError : loginError?.message;
			setError(message === "invalid_credentials" ? "invalidCredentials" : "loginFailed");
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<main className="database-login-page">
			<button className="database-login-back" type="button" onClick={onBack}>
				<FiArrowLeft aria-hidden="true" />
				<span>{t("backToDatabases")}</span>
			</button>

			<section className="database-login-panel" aria-labelledby="database-login-title">
				<div className="database-login-icon" aria-hidden="true"><FiDatabase /></div>
				<p className="database-login-company">{database.companyName}</p>
				<h1 id="database-login-title">{t("loginToDatabase")}</h1>
				<p className="database-login-file">{database.databaseName}</p>

				<form onSubmit={handleSubmit}>
					<label htmlFor="database-login-identifier">{t("databaseLoginIdentifier")}</label>
					<div className="database-login-input">
						<FiUser aria-hidden="true" />
						<input
							id="database-login-identifier"
							autoComplete="username"
							required
							value={identifier}
							onChange={(event) => setIdentifier(event.target.value)}
						/>
					</div>

					<label htmlFor="database-login-password">{t("password")}</label>
					<div className="database-login-input">
						<FiLock aria-hidden="true" />
						<input
							id="database-login-password"
							type="password"
							autoComplete="current-password"
							required
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</div>

					{error && <p className="database-login-error" role="alert">{t(error)}</p>}
					<button className="database-login-submit" type="submit" disabled={isSubmitting}>
						{t(isSubmitting ? "checkingCredentials" : "login")}
					</button>
				</form>
			</section>
		</main>
	);
}

export default DatabaseLoginPage;