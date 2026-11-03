import { useState } from "react";
import { api, formatErr } from "@/lib/api";
import { Link } from "react-router-dom";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setMsg("");
    try {
      await api.post("/auth/forgot-password", { email: email.trim() });
      setMsg("If an account exists, a reset link has been sent (check backend logs in dev).");
    } catch (e2) { setErr(formatErr(e2?.response?.data?.detail) || e2.message); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 bg-secondary border border-border rounded-card p-8" data-testid="forgot-form">
        <h1 className="font-display font-black text-2xl">Forgot password</h1>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="forgot-email"
            className="mt-1 w-full h-10 px-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
        </label>
        {msg && <div className="text-sm text-emerald-400 border border-emerald-800 bg-emerald-500/10 rounded-input p-2">{msg}</div>}
        {err && <div className="text-sm text-red-400 border border-red-800 bg-red-500/10 rounded-input p-2">{err}</div>}
        <button data-testid="forgot-submit" className="w-full h-10 rounded-btn bg-prg-red hover:bg-prg-red-dim text-white font-bold text-sm uppercase tracking-widest">Send reset link</button>
        <Link to="/login" className="block text-center text-xs text-muted-foreground hover:text-prg-red">Back to sign in</Link>
      </form>
    </div>
  );
}
