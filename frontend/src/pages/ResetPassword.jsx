import { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { api, formatErr } from "@/lib/api";
import { toast } from "sonner";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const nav = useNavigate();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    if (pw !== confirm) { setErr("Passwords do not match."); return; }
    try {
      await api.post("/auth/reset-password", { token, password: pw });
      toast.success("Password reset — please sign in");
      nav("/login");
    } catch (e2) { setErr(formatErr(e2?.response?.data?.detail) || e2.message); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 bg-secondary border border-border rounded-card p-8" data-testid="reset-form">
        <h1 className="font-display font-black text-2xl">Reset password</h1>
        <input type="password" placeholder="New password" required value={pw} onChange={(e) => setPw(e.target.value)} data-testid="reset-password"
          className="w-full h-10 px-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
        <input type="password" placeholder="Confirm" required value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="reset-confirm"
          className="w-full h-10 px-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
        {err && <div className="text-sm text-red-400 border border-red-800 bg-red-500/10 rounded-input p-2">{err}</div>}
        <button data-testid="reset-submit" className="w-full h-10 rounded-btn bg-prg-red hover:bg-prg-red-dim text-white font-bold text-sm uppercase tracking-widest">Reset</button>
        <Link to="/login" className="block text-center text-xs text-muted-foreground hover:text-prg-red">Back to sign in</Link>
      </form>
    </div>
  );
}
