import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api, formatErr } from "@/lib/api";
import { toast } from "sonner";

export default function AcceptInvitation() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const nav = useNavigate();
  const [inv, setInv] = useState(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) { setErr("Missing invitation token."); return; }
    (async () => {
      try {
        const { data } = await api.get(`/auth/invitation/${token}`);
        setInv(data);
      } catch (e) {
        setErr(formatErr(e?.response?.data?.detail) || "Invitation not found or expired.");
      }
    })();
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) { setErr("Passwords do not match."); return; }
    setLoading(true); setErr("");
    try {
      await api.post("/auth/accept-invitation", { token, password });
      toast.success("Account created — please sign in");
      nav("/login");
    } catch (e2) {
      setErr(formatErr(e2?.response?.data?.detail) || e2.message);
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8 bg-background">
      <form onSubmit={submit} className="w-full max-w-md space-y-5 bg-secondary border border-border rounded-card p-8" data-testid="accept-invite-form">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Invitation</div>
          <h1 className="font-display font-black text-2xl">Set up your account</h1>
        </div>
        {inv && (
          <div className="text-sm bg-background border border-border rounded-input p-3">
            <div><span className="text-muted-foreground">Name:</span> <span className="font-semibold">{inv.name}</span></div>
            <div><span className="text-muted-foreground">Email:</span> <span className="font-mono">{inv.email}</span></div>
            <div><span className="text-muted-foreground">Roles:</span> {inv.roles.join(", ")}</div>
          </div>
        )}
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">New password</span>
          <input data-testid="invite-password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full h-10 px-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Confirm password</span>
          <input data-testid="invite-confirm" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)}
            className="mt-1 w-full h-10 px-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
        </label>
        <div className="text-[11px] text-muted-foreground">Min 8 chars, incl. uppercase, lowercase, number, special.</div>
        {err && <div className="text-sm text-red-400 border border-red-800 bg-red-500/10 rounded-input p-2" data-testid="invite-error">{err}</div>}
        <button type="submit" disabled={loading || !inv} data-testid="invite-submit"
          className="w-full h-10 rounded-btn bg-prg-red hover:bg-prg-red-dim disabled:opacity-60 text-white font-bold text-sm uppercase tracking-widest transition-colors">
          {loading ? "Creating…" : "Create account"}
        </button>
      </form>
    </div>
  );
}
