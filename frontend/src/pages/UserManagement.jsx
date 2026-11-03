import { useEffect, useState } from "react";
import { api, formatErr } from "@/lib/api";
import { formatDate } from "@/lib/date";
import { useAuth } from "@/context/AuthContext";
import { hasAnyRole, ROLES } from "@/lib/permissions";
import { UserPlus, Copy, CheckCircle, XCircle, PencilSimple, X, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";

const ALL_ROLES = ["Crew Member", "Project Manager", "Account Manager", "Operations Manager", "Service Department", "Administrator"];
const PM_DEPARTMENTS = ["Lighting", "Video", "Rigging"];
const CREW_MEMBER_DEPARTMENTS = ["Lighting", "Video", "Rigging", "Automation", "Audio"];

// Department is only meaningful for Project Manager / Crew Member roles.
// Returns [] if neither role is held (department should be hidden/cleared).
function departmentOptionsFor(roles) {
  const isPM = roles.includes("Project Manager");
  const isCrew = roles.includes("Crew Member");
  if (isPM && isCrew) return CREW_MEMBER_DEPARTMENTS; // superset covers both
  if (isPM) return PM_DEPARTMENTS;
  if (isCrew) return CREW_MEMBER_DEPARTMENTS;
  return [];
}

export default function UserManagement() {
  const { user } = useAuth();
  const isAdmin = hasAnyRole(user, ROLES.ADMIN);
  const [users, setUsers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [show, setShow] = useState(false);
  const [inv, setInv] = useState({ name: "", email: "", roles: ["Crew Member"], department: "" });
  const [lastLink, setLastLink] = useState("");

  const load = async () => {
    const [u, iv] = await Promise.all([api.get("/users"), api.get("/invitations").catch(() => ({ data: [] }))]);
    setUsers(u.data); setInvitations(iv.data);
  };
  useEffect(() => { load(); }, []);

  const submitInvite = async () => {
    try {
      const payload = { name: inv.name, email: inv.email.toLowerCase(), roles: inv.roles, department: inv.department || null };
      const { data } = await api.post("/users/invite", payload);
      setLastLink(data.invitation_link);
      toast.success("Invitation sent");
      setShow(false); setInv({ name: "", email: "", roles: ["Crew Member"], department: "" });
      load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  const patchUser = async (id, updates) => {
    try { await api.patch(`/users/${id}`, updates); load(); } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  const deleteUser = async (target) => {
    if (!window.confirm(`Permanently delete ${target.name} (${target.email})? This removes their account entirely and cannot be undone.`)) return;
    try {
      await api.delete(`/users/${target.id}`);
      toast.success(`${target.name} deleted`);
      load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  const canDeleteInvitation = (invitation) => {
    if (invitation.used) return false;
    if (isAdmin) return true;
    const crewOnly = (invitation.roles || []).every((r) => ["Crew Member"].includes(r));
    return invitation.invited_by === user.id || crewOnly;
  };

  const deleteInvitation = async (invitation) => {
    if (!window.confirm(`Delete the pending invitation for ${invitation.email}? The invitation link will be invalidated immediately.`)) return;
    try {
      await api.delete(`/invitations/${invitation.id}`);
      toast.success("Invitation deleted");
      load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  const [editing, setEditing] = useState(null); // user object or null


  const rolesEditableFor = (target) => {
    if (isAdmin) return ALL_ROLES;
    // PM: can only manage Crew Member AND target must not currently hold Admin/PM
    if (target?.roles?.some((r) => [ROLES.ADMIN, ROLES.PROJECT_MANAGER].includes(r))) return null;
    return ["Crew Member"];
  };
  const canEdit = (target) => target.id !== user.id && rolesEditableFor(target) !== null;
  const canDelete = (target) => isAdmin && target.id !== user.id;


  const toggleRole = (roles, r) => (roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r]);

  return (
    <div className="space-y-6" data-testid="user-management-page">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Users</div>
          <h1 className="font-display font-black text-3xl">User management</h1>
        </div>
        <button onClick={() => setShow(true)} data-testid="invite-user-btn" className="h-9 px-3 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
          <UserPlus size={14} /> Invite user
        </button>
      </div>

      {show && (
        <div className="bg-card border border-border rounded-card p-4 space-y-3">
          <div className="grid md:grid-cols-2 gap-2">
            <input value={inv.name} onChange={(e) => setInv({...inv, name: e.target.value})} placeholder="Full name" data-testid="invite-name" className="h-9 px-3 rounded-btn bg-background border border-border text-sm" />
            <input value={inv.email} onChange={(e) => setInv({...inv, email: e.target.value})} placeholder="Email" data-testid="invite-email" className="h-9 px-3 rounded-btn bg-background border border-border text-sm" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Roles</div>
            <div className="flex flex-wrap gap-2">
              {ALL_ROLES.filter((r) => isAdmin || ["Crew Member"].includes(r)).map((r) => (
                <button key={r} type="button" onClick={() => {
                    const newRoles = toggleRole(inv.roles, r);
                    const opts = departmentOptionsFor(newRoles);
                    setInv({ ...inv, roles: newRoles, department: opts.includes(inv.department) ? inv.department : "" });
                  }} data-testid={`invite-role-${r.replace(/\s+/g,"-").toLowerCase()}`}
                  className={`px-3 h-8 rounded-btn text-xs font-bold uppercase tracking-widest border transition-colors ${inv.roles.includes(r) ? "bg-prg-red text-white border-prg-red" : "border-border bg-background text-muted-foreground hover:border-prg-red"}`}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          {departmentOptionsFor(inv.roles).length > 0 && (
            <label className="block">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Department</span>
              <select value={inv.department} onChange={(e) => setInv({...inv, department: e.target.value})} data-testid="invite-department"
                className="mt-1 w-full h-9 px-3 rounded-btn bg-background border border-border text-sm">
                <option value="">— No department —</option>
                {departmentOptionsFor(inv.roles).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
          <div className="flex gap-2">
            <button onClick={submitInvite} data-testid="invite-submit" className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">Send invitation</button>
            <button onClick={() => setShow(false)} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
          </div>
        </div>
      )}

      {lastLink && (
        <div className="bg-card border border-border rounded-card p-4 flex items-center justify-between gap-3" data-testid="invite-link-panel">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Invitation link (share with recipient)</div>
            <div className="font-mono text-xs break-all">{lastLink}</div>
          </div>
          <button onClick={() => { navigator.clipboard.writeText(lastLink); toast.success("Copied"); }} className="h-9 px-3 rounded-btn border border-border text-xs font-bold uppercase tracking-widest inline-flex items-center gap-1"><Copy size={12} /> Copy</button>
        </div>
      )}

      <div className="bg-card border border-border rounded-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary">
            <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="p-3">Name</th><th className="p-3">Email</th><th className="p-3">Roles</th><th className="p-3">Dept</th><th className="p-3">Status</th><th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-border" data-testid={`user-row-${u.id}`}>
                <td className="p-3 font-semibold">{u.name}</td>
                <td className="p-3 font-mono text-xs text-muted-foreground">{u.email}</td>
                <td className="p-3">{u.roles?.join(", ")}</td>
                <td className="p-3">{u.department || "—"}</td>
                <td className="p-3">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${u.status === "active" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>{u.status}</span>
                </td>
                <td className="p-3 text-right">
                  {(canEdit(u) || canDelete(u)) && (
                    <div className="inline-flex items-center gap-3 justify-end">
                      {canEdit(u) && (
                        <>
                          <button onClick={() => setEditing(u)} data-testid={`user-edit-${u.id}`} className="text-xs text-muted-foreground hover:text-prg-red inline-flex items-center gap-1">
                            <PencilSimple size={12} /> Edit
                          </button>
                          <button onClick={() => patchUser(u.id, { status: u.status === "active" ? "disabled" : "active" })} data-testid={`user-toggle-${u.id}`} className="text-xs text-muted-foreground hover:text-prg-red">
                            {u.status === "active" ? "Disable" : "Enable"}
                          </button>
                        </>
                      )}
                      {canDelete(u) && (
                        <button onClick={() => deleteUser(u)} data-testid={`user-delete-${u.id}`} className="text-xs text-muted-foreground hover:text-red-500 inline-flex items-center gap-1" aria-label={`Delete ${u.name}`}>
                          <Trash size={12} /> Delete
                        </button>
                      )}
                    </div>
                  )}
                  {u.id === user.id && <span className="text-[10px] uppercase tracking-widest text-muted-foreground">You</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {invitations.filter((i) => !i.used).length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">Pending invitations</div>
          <div className="bg-card border border-border rounded-card divide-y divide-border" data-testid="pending-invitations">
            {invitations.filter((i) => !i.used).map((i) => (
              <div key={i.id} className="p-3 flex items-center justify-between gap-3 text-sm" data-testid={`invitation-row-${i.id}`}>
                <div className="min-w-0">
                  <div className="font-semibold truncate">{i.name}</div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{i.email}</div>
                  {i.roles?.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {i.roles.map((r) => (
                        <span key={r} className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest border border-border text-muted-foreground">{r}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-xs text-muted-foreground whitespace-nowrap">expires {formatDate(i.expires_at)}</div>
                  {canDeleteInvitation(i) && (
                    <button onClick={() => deleteInvitation(i)} data-testid={`invitation-delete-${i.id}`}
                      className="p-1.5 rounded-btn text-muted-foreground hover:text-red-500 hover:bg-secondary transition-colors" aria-label="Delete invitation">
                      <Trash size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <EditUserModal
          target={editing}
          availableRoles={rolesEditableFor(editing) || []}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
          onSave={async (updates) => {
            try {
              await api.patch(`/users/${editing.id}`, updates);
              toast.success("User updated");
              setEditing(null); load();
            } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
          }}
        />
      )}
    </div>
  );
}

function EditUserModal({ target, availableRoles, isAdmin, onClose, onSave }) {
  const [name, setName] = useState(target.name || "");
  const [roles, setRoles] = useState(target.roles || []);
  const [department, setDepartment] = useState(
    departmentOptionsFor(target.roles || []).includes(target.department) ? target.department : ""
  );
  const [status, setStatus] = useState(target.status || "active");
  const toggleRole = (r) => {
    const newRoles = roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r];
    const opts = departmentOptionsFor(newRoles);
    setRoles(newRoles);
    setDepartment(opts.includes(department) ? department : "");
  };

  const submit = () => {
    const updates = { name, department: department || null, status };
    // Only send roles when Admin (or when PM changes among allowed set)
    if (JSON.stringify(roles.slice().sort()) !== JSON.stringify((target.roles || []).slice().sort())) {
      updates.roles = roles;
    }
    onSave(updates);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" data-testid="edit-user-modal">
      <div className="w-full max-w-lg bg-card border border-border rounded-modal p-6 space-y-4 animate-slide-up">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Edit user</div>
            <h3 className="font-display font-black text-xl">{target.name}</h3>
            <div className="text-xs text-muted-foreground font-mono">{target.email}</div>
          </div>
          <button onClick={onClose} data-testid="edit-user-close" className="p-2 rounded-btn hover:bg-secondary"><X size={16} /></button>
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Full name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="edit-user-name"
            className="mt-1 w-full h-10 px-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
        </label>

        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Roles</div>
          <div className="flex flex-wrap gap-2">
            {availableRoles.map((r) => (
              <button key={r} type="button" onClick={() => toggleRole(r)} data-testid={`edit-user-role-${r.replace(/\s+/g, "-").toLowerCase()}`}
                className={`px-3 h-8 rounded-btn text-xs font-bold uppercase tracking-widest border transition-colors ${roles.includes(r) ? "bg-prg-red text-white border-prg-red" : "border-border bg-background text-muted-foreground hover:border-prg-red"}`}>
                {r}
              </button>
            ))}
          </div>
          {!isAdmin && <div className="text-[11px] text-muted-foreground mt-2">Project Managers can only manage the Crew Member role.</div>}
        </div>

        {departmentOptionsFor(roles).length > 0 && (
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Department</span>
            <select value={department} onChange={(e) => setDepartment(e.target.value)} data-testid="edit-user-department"
              className="mt-1 w-full h-10 px-3 rounded-input bg-background border border-border text-sm">
              <option value="">— None —</option>
              {departmentOptionsFor(roles).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        )}

        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="edit-user-status"
            className="mt-1 w-full h-10 px-3 rounded-input bg-background border border-border text-sm">
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
          <button onClick={submit} data-testid="edit-user-save" className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">Save changes</button>
        </div>
      </div>
    </div>
  );
}