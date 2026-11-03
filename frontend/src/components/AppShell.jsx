import { useState, useEffect, useRef } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext";
import { hasAnyRole, ROLES, primaryRole } from "@/lib/permissions";
import { api, urlBase64ToUint8Array } from "@/lib/api";
import { toast } from "sonner";
import {
  House, Briefcase, Barcode, Buildings, Bell, UsersThree,
  Wrench, ClipboardText, MagnifyingGlass, SunDim, Moon, SignOut, WifiHigh, WifiSlash, CalendarBlank, UserCircle, BellRinging,
} from "@phosphor-icons/react";

const nav = (u) => {
  const isServiceOnly = u?.roles?.length === 1 && u.roles[0] === ROLES.SERVICE;
  return [
    { to: "/", label: "Dashboard", icon: House, testId: "nav-dashboard" },
    !isServiceOnly && { to: "/jobs", label: "Jobs", icon: Briefcase, testId: "nav-jobs" },
    hasAnyRole(u, ROLES.PROJECT_MANAGER, ROLES.OPERATIONS_MANAGER) && { to: "/calendar", label: "Prep Calendar", icon: CalendarBlank, testId: "nav-calendar" },
    { to: "/equipment", label: "Equipment", icon: Barcode, testId: "nav-equipment" },
    !isServiceOnly && { to: "/building", label: "Building", icon: Buildings, testId: "nav-building" },
    { to: "/notifications", label: "Notifications", icon: Bell, testId: "nav-notifications" },
    hasAnyRole(u, ROLES.PROJECT_MANAGER) && { to: "/users", label: "Users", icon: UsersThree, testId: "nav-users" },
    hasAnyRole(u, ROLES.SERVICE, ROLES.OPERATIONS_MANAGER, ROLES.PROJECT_MANAGER) && { to: "/faults", label: "Faults", icon: Wrench, testId: "nav-faults" },
    hasAnyRole(u, ROLES.ADMIN) && { to: "/audit", label: "Audit Log", icon: ClipboardText, testId: "nav-audit" },
  ].filter(Boolean);
};

export default function AppShell({ children }) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [online, setOnline] = useState(navigator.onLine);
  const [unread, setUnread] = useState(0);
  const [q, setQ] = useState("");
  const [results, setResults] = useState(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);
  const isAdmin = hasAnyRole(user, ROLES.ADMIN);

  useEffect(() => {
    if (!userMenuOpen) return;
    const onClick = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [userMenuOpen]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data } = await api.get("/notifications");
        if (!cancelled) setUnread(data.filter((n) => !n.read).length);
      } catch { void 0; }
    };
    load();
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        console.warn("[push] serviceWorker or PushManager not supported in this browser");
        return;
      }
      try {
        const perm = Notification.permission;
        console.log("[push] current permission:", perm);
        if (perm !== "granted") {
          const asked = await Notification.requestPermission();
          console.log("[push] permission after request:", asked);
          if (asked !== "granted") {
            console.warn("[push] permission not granted, stopping");
            return;
          }
        }
        const reg = await navigator.serviceWorker.ready;
        console.log("[push] service worker ready:", reg);
        const { data } = await api.get("/auth/vapid-public-key");
        console.log("[push] vapid key from backend:", data.key ? "present" : "MISSING");
        if (!data.key) {
          console.warn("[push] no VAPID key returned from backend — check VAPID_PUBLIC_KEY env var");
          return;
        }
        const existing = await reg.pushManager.getSubscription();
        console.log("[push] existing subscription:", existing);
        const sub = existing || await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(data.key),
        });
        console.log("[push] subscription object:", sub.toJSON());
        const res = await api.post("/push/subscribe", { subscription: sub.toJSON() });
        console.log("[push] backend subscribe response:", res.data);
      } catch (e) {
        console.error("[push] subscription flow failed:", e);
      }
    })();
  }, []);

  const items = nav(user);

  const doSearch = async (val) => {
    setQ(val);
    if (val.length < 2) { setResults(null); return; }
    try {
      const { data } = await api.get("/search", { params: { q: val } });
      setResults(data);
    } catch { setResults(null); }
  };

  const gotoResult = (path) => { setResults(null); setQ(""); navigate(path); };

  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">
      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex md:flex-col w-[240px] shrink-0 border-r border-border bg-secondary">
        <div className="px-6 py-6 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-btn bg-white flex items-center justify-center overflow-hidden shrink-0 ring-1 ring-border">
              <img src="/prg-logo.png" alt="PRG" className="w-9 h-9 object-contain" />
            </div>
            <div className="min-w-0">
              <div className="font-display font-black tracking-tight text-lg leading-none">Job Portal</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-[0.2em] mt-1">Longbridge</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto scrollbar-slim">
          {items.map((it) => (
            <NavLink
              key={it.to} to={it.to} end={it.to === "/"} data-testid={it.testId}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-btn text-sm font-medium transition-colors ${
                  isActive ? "bg-prg-red text-white" : "text-foreground/70 hover:text-foreground hover:bg-background"
                }`
              }
            >
              <it.icon size={18} weight="bold" />
              <span>{it.label}</span>
              {it.to === "/notifications" && unread > 0 && (
                <span className="ml-auto px-1.5 rounded-full bg-prg-red text-white text-[10px] font-bold" data-testid="unread-badge">{unread}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border p-3">
          <NavLink to="/profile" data-testid="nav-profile" className="flex items-center gap-3 px-3 py-2 rounded-btn text-sm hover:bg-background transition-colors">
            <div className="w-8 h-8 rounded-full bg-prg-red text-white flex items-center justify-center font-display font-bold text-xs">
              {user?.name?.split(" ").map((w) => w[0]).slice(0, 2).join("")}
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">{user?.name}</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-widest truncate">{primaryRole(user)}</div>
            </div>
          </NavLink>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-30 h-[calc(3.5rem+env(safe-area-inset-top))] md:h-16 pt-[env(safe-area-inset-top)] bg-secondary border-b border-border flex items-center gap-2 md:gap-4 px-3 md:px-6">
          <div className="md:hidden flex items-center gap-2">
            <div className="w-9 h-9 rounded-btn bg-white flex items-center justify-center overflow-hidden ring-1 ring-border">
              <img src="/prg-logo.png" alt="PRG" className="w-7 h-7 object-contain" />
            </div>
          </div>
          <div className="flex-1 relative max-w-xl">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              data-testid="global-search-input"
              className="w-full h-9 pl-9 pr-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red focus:ring-1 focus:ring-prg-red"
              placeholder="Search jobs, equipment, users…"
              value={q} onChange={(e) => doSearch(e.target.value)}
            />
            {results && (q.length >= 2) && (
              <div className="absolute mt-1 left-0 right-0 max-h-96 overflow-y-auto scrollbar-slim rounded-modal bg-popover border border-border shadow-2xl z-40">
                {["jobs","equipment","users"].map((cat) => (
                  results[cat]?.length > 0 && (
                    <div key={cat}>
                      <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-muted-foreground">{cat}</div>
                      {results[cat].slice(0,6).map((r) => {
                        const label = cat === "jobs" ? `${r.name} · ${r.winhits_number}` : cat === "equipment" ? `${r.fixture_type} · ${r.barcode}` : `${r.name} · ${r.email}`;
                        const path = cat === "jobs" ? `/jobs/${r.id}` : cat === "equipment" ? `/equipment/${r.barcode}` : `/users`;
                        return (
                          <button key={r.id || r.barcode} data-testid={`search-result-${cat}`} onClick={() => gotoResult(path)} className="w-full text-left px-4 py-2 hover:bg-background text-sm">
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )
                ))}
                {(!results.jobs?.length && !results.equipment?.length && !results.users?.length) && (
                  <div className="px-4 py-4 text-sm text-muted-foreground">No matches.</div>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span data-testid="online-indicator" className={`hidden sm:inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full border ${online ? "border-emerald-800 text-emerald-400" : "border-red-800 text-red-400"}`}>
              {online ? <WifiHigh size={12} /> : <WifiSlash size={12} />} {online ? "Online" : "Offline"}
            </span>
            <button data-testid="theme-toggle" onClick={toggle} className="p-2 rounded-btn hover:bg-background transition-colors">
              {theme === "dark" ? <SunDim size={18} weight="bold" /> : <Moon size={18} weight="bold" />}
            </button>

            {isAdmin && (
              <button
                data-testid="test-broadcast-btn"
                title="Send a test notification to every user"
                onClick={async () => {
                  try {
                    const { data } = await api.post("/notifications/test-broadcast");
                    toast.success(`Test notification sent to ${data.recipient_count} user(s)`);
                  } catch (e) {
                    toast.error("Failed to send test notification");
                  }
                }}
                className="p-2 rounded-btn hover:bg-background transition-colors text-muted-foreground hover:text-prg-red"
              >
                <BellRinging size={18} weight="bold" />
              </button>
            )}

            {/* Desktop: plain sign-out (Profile is already reachable via the sidebar) */}
            <button data-testid="logout-btn" onClick={async () => { await logout(); navigate("/login"); }} className="hidden md:inline-flex p-2 rounded-btn hover:bg-background transition-colors">
              <SignOut size={18} weight="bold" />
            </button>

            {/* Mobile: user menu (Profile / Users for admins / Sign out) */}
            <div className="md:hidden relative" ref={userMenuRef}>
              <button data-testid="user-menu-btn" onClick={() => setUserMenuOpen((v) => !v)} className="p-2 rounded-btn hover:bg-background transition-colors" aria-label="Account menu">
                <UserCircle size={20} weight="bold" />
              </button>
              {userMenuOpen && (
                <div data-testid="user-menu" className="absolute right-0 mt-1 w-44 rounded-modal bg-popover border border-border shadow-2xl z-40 overflow-hidden animate-fade-in">
                  <NavLink to="/profile" data-testid="user-menu-profile" onClick={() => setUserMenuOpen(false)}
                    className="block px-4 py-2.5 text-sm hover:bg-background transition-colors">
                    My profile
                  </NavLink>
                  {isAdmin && (
                    <NavLink to="/users" data-testid="user-menu-users" onClick={() => setUserMenuOpen(false)}
                      className="block px-4 py-2.5 text-sm hover:bg-background transition-colors">
                      Users
                    </NavLink>
                  )}
                  <button
                    data-testid="user-menu-signout"
                    onClick={async () => { setUserMenuOpen(false); await logout(); navigate("/login"); }}
                    className="w-full text-left px-4 py-2.5 text-sm hover:bg-background transition-colors border-t border-border text-red-400"
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto scrollbar-slim px-4 md:px-8 py-6 pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-8 animate-fade-in">
          {children}
        </main>

        {/* Bottom nav (mobile) */}
        <nav className="md:hidden fixed bottom-0 inset-x-0 border-t border-border bg-secondary z-30 pb-[env(safe-area-inset-bottom)]">
          <div className="grid grid-cols-5">
            {items.slice(0, 5).map((it) => (
              <NavLink key={it.to} to={it.to} end={it.to === "/"} data-testid={`mobile-${it.testId}`}
                className={({ isActive }) => `flex flex-col items-center justify-center py-2 gap-0.5 text-[10px] ${isActive ? "text-prg-red" : "text-muted-foreground"}`}
              >
                <it.icon size={20} weight="bold" />
                <span>{it.label}</span>
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}