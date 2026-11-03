import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { formatErr } from "@/lib/api";
import { toast } from "sonner";
import { Eye, EyeSlash } from "@phosphor-icons/react";

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true); setErr("");
    try {
      await login(email.trim(), password);
      toast.success("Welcome back");
      nav("/");
    } catch (e2) {
      setErr(formatErr(e2?.response?.data?.detail) || e2.message);
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen grid md:grid-cols-2 bg-background text-foreground">
      <div className="relative hidden md:block overflow-hidden">
        <img
          alt=""
          src="https://images.unsplash.com/photo-1573339887617-d674bc961c31?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjAzMjd8MHwxfHNlYXJjaHwyfHxzdGFnZSUyMGxpZ2h0aW5nJTIwcmlnZ2luZ3xlbnwwfHx8fDE3ODM5NDE4Mjd8MA&ixlib=rb-4.1.0&q=85"
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-black/70" />
        <div className="prg-grain" />
        <div className="relative z-10 h-full flex flex-col justify-between p-10">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-btn bg-white flex items-center justify-center overflow-hidden ring-1 ring-white/20">
              <img src="/prg-logo.png" alt="PRG" className="w-10 h-10 object-contain" />
            </div>
            <div>
              <div className="font-display font-black text-xl leading-none text-white">Job Portal</div>
              <div className="text-[10px] uppercase tracking-[0.3em] text-white/60 mt-1">Longbridge · UK</div>
            </div>
          </div>
          <div className="text-white space-y-3 max-w-md">
            <h1 className="font-display font-black text-4xl leading-tight">Every job. Every prep. Every crew.</h1>
            <p className="text-white/70 text-sm leading-relaxed">The single source of truth for PRG UK production operations — schedules, drawings, prep planning and fault reporting in one place.</p>
          </div>
          <div className="text-white/40 text-xs uppercase tracking-widest">© Production Resource Group UK</div>
        </div>
      </div>

      <div className="flex items-center justify-center px-6 py-10">
        <form onSubmit={submit} className="w-full max-w-sm space-y-6" data-testid="login-form">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">Sign in</div>
            <h2 className="font-display font-black text-3xl">Welcome back</h2>
            <p className="text-muted-foreground text-sm mt-2">Enter your credentials to access the portal.</p>
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Email</span>
              <input
                data-testid="login-email"
                type="email" required autoFocus
                value={email} onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full h-10 px-3 rounded-input bg-secondary border border-border text-sm focus:outline-none focus:border-prg-red focus:ring-1 focus:ring-prg-red"
              />
            </label>
            <label className="block relative">
              <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Password</span>
              <input
                data-testid="login-password"
                type={show ? "text" : "password"} required
                value={password} onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full h-10 px-3 pr-10 rounded-input bg-secondary border border-border text-sm focus:outline-none focus:border-prg-red focus:ring-1 focus:ring-prg-red"
              />
              <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-[30px] p-2 text-muted-foreground" data-testid="login-show-password">
                {show ? <EyeSlash size={16} /> : <Eye size={16} />}
              </button>
            </label>
          </div>

          {err && <div className="text-sm text-red-400 border border-red-800 bg-red-500/10 rounded-input p-2" data-testid="login-error">{err}</div>}

          <button
            type="submit" disabled={loading} data-testid="login-submit"
            className="w-full h-10 rounded-btn bg-prg-red hover:bg-prg-red-dim disabled:opacity-60 text-white font-bold text-sm uppercase tracking-widest transition-colors focus-ring"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>

          <div className="flex items-center justify-between text-xs">
            <Link to="/forgot-password" className="text-muted-foreground hover:text-prg-red" data-testid="link-forgot">Forgot password?</Link>
            <span className="text-muted-foreground">Invitation only</span>
          </div>
        </form>
      </div>
    </div>
  );
}
