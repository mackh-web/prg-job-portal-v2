import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { primaryRole } from "@/lib/permissions";

export default function Profile() {
  const { user, updateProfile, logout } = useAuth();
  const [nickname, setNickname] = useState(user?.nickname || "");
  const save = async () => { try { await updateProfile({ nickname }); toast.success("Profile updated"); } catch (e) { toast.error(e.message); } };
  return (
    <div className="space-y-6 max-w-lg" data-testid="profile-page">
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Profile</div>
        <h1 className="font-display font-black text-3xl">{user.name}</h1>
        {user.nickname && <div className="text-muted-foreground text-sm mt-0.5">aka &quot;{user.nickname}&quot;</div>}
        <div className="text-muted-foreground text-sm mt-1">
          <span className="text-prg-red font-bold uppercase tracking-widest text-xs">{primaryRole(user)}</span>
          {user.department && ` · ${user.department}`} · <span className="font-mono">{user.email}</span>
        </div>
      </div>
      <div className="bg-card border border-border rounded-card p-4 space-y-3">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Details</div>
        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Name</span>
          <input value={user.name} disabled data-testid="profile-name" className="mt-1 w-full h-10 px-3 rounded-input bg-secondary border border-border text-sm text-muted-foreground cursor-not-allowed" />
          <span className="text-[11px] text-muted-foreground">Contact an Administrator to change your display name.</span>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Nickname</span>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="What should people call you?" data-testid="profile-nickname" className="mt-1 w-full h-10 px-3 rounded-input bg-background border border-border text-sm" />
        </label>
        <button onClick={save} data-testid="profile-save" className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">Save</button>
      </div>
      <div className="bg-card border border-border rounded-card p-4 space-y-3">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Roles</div>
        <div className="flex flex-wrap gap-2">
          {user.roles?.map((r) => <span key={r} className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border border-prg-red text-prg-red">{r}</span>)}
        </div>
      </div>
      <button onClick={logout} data-testid="profile-logout" className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Sign out</button>
    </div>
  );
}