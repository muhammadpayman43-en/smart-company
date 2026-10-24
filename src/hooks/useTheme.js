import { useEffect, useState } from "react";

export function useTheme() {
	const [isDark, setIsDark] = useState(() => localStorage.getItem("app-theme") === "dark");

	useEffect(() => {
		document.documentElement.dataset.theme = isDark ? "dark" : "light";
		localStorage.setItem("app-theme", isDark ? "dark" : "light");
	}, [isDark]);

	const toggleTheme = () => setIsDark((current) => !current);

	return { isDark, toggleTheme };
}