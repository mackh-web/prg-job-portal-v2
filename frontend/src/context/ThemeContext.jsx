import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const { user, updateProfile } = useAuth();
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("prg-theme") || "dark"; } catch { return "dark"; }
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.body.classList.toggle("dark", theme === "dark");
    try { localStorage.setItem("prg-theme", theme); } catch { void 0; }
  }, [theme]);

  useEffect(() => {
    if (user?.theme && user.theme !== theme) setTheme(user.theme);
  }, [user?.theme, theme]);

  const toggle = useCallback(async () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    if (user && user.id) {
      try { await updateProfile({ theme: next }); } catch { void 0; }
    }
  }, [theme, user, updateProfile]);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be inside ThemeProvider");
  return ctx;
}
