import { useEffect, useState, useCallback } from "react";
import { api, formatErr } from "@/lib/api";
import JobCard from "@/components/JobCard";
import { useAuth } from "@/context/AuthContext";
import { hasAnyRole, ROLES } from "@/lib/permissions";
import { Plus, X } from "@phosphor-icons/react";
import { toast } from "sonner";

const STATUSES = ["All", "Order", "Quote", "Reservation", "Complete", "Cancelled"];
const CREATE_STATUSES = ["Quote", "Reservation", "Order", "Complete", "Cancelled"];

export default function Jobs() {
  const { user } = useAuth();
  const [jobs, setJobs] = useState([]);
  const [scope, setScope] = useState("mine");
  const [status, setStatus] = useState("All");
  const [showAdd, setShowAdd] = useState(false);
  const canSeeAll = hasAnyRole(user, ROLES.OPERATIONS_MANAGER, ROLES.ADMIN, ROLES.PROJECT_MANAGER);
  const isAdmin = hasAnyRole(user, ROLES.ADMIN);

  const load = useCallback(async () => {
    const params = { scope };
    if (status !== "All") params.status = status;
    const { data } = await api.get("/jobs", { params });
    setJobs(data);
  }, [scope, status]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6" data-testid="jobs-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Jobs</div>
          <h1 className="font-display font-black text-3xl">All productions</h1>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button onClick={() => setShowAdd(true)} data-testid="add-job-btn"
              className="h-9 px-3 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
              <Plus size={14} /> Add Job
            </button>
          )}
          {canSeeAll && (
            <div className="inline-flex rounded-btn bg-secondary border border-border p-0.5">
              {["mine", "all"].map((s) => (
                <button key={s} onClick={() => setScope(s)} data-testid={`scope-${s}`}
                  className={`px-3 h-8 text-xs font-bold uppercase tracking-widest rounded-btn transition-colors ${scope === s ? "bg-prg-red text-white" : "text-muted-foreground hover:text-foreground"}`}>
                  {s === "mine" ? "Mine" : "All"}
                </button>
              ))}
            </div>
          )}
          <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="jobs-status-filter"
            className="h-8 px-3 text-xs font-semibold uppercase tracking-widest bg-secondary border border-border rounded-btn">
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="bg-card border border-border rounded-card p-8 text-center text-muted-foreground text-sm">No jobs match the current filters.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {jobs.map((j) => <JobCard key={j.id} job={j} />)}
        </div>
      )}

      {showAdd && (
        <AddJobModal onClose={() => setShowAdd(false)} onCreated={() => { setShowAdd(false); load(); }} />
      )}
    </div>
  );
}

function AddJobModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    name: "", winhits_number: "", status: "Quote",
    project_manager_id: "", account_manager_id: "", production_manager: "",
    prep_date: "", ship_date: "", return_date: "",
    notes: "", hotel_details: "", travel_details: "", client_details: "",
  });
  const [pms, setPms] = useState([]);
  const [ams, setAms] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/users");
        setPms(data.filter((u) => u.roles?.includes("Project Manager") && u.status === "active"));
        setAms(data.filter((u) => u.roles?.includes("Account Manager") && u.status === "active"));
      } catch { /* ignore */ }
    })();
  }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    if (!form.name.trim()) { toast.error("Job name is required"); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        winhits_number: form.winhits_number || null,
        project_manager_id: form.project_manager_id || null,
        account_manager_id: form.account_manager_id || null,
        production_manager: form.production_manager || null,
        prep_date: form.prep_date || null,
        ship_date: form.ship_date || null,
        return_date: form.return_date || null,
      };
      await api.post("/jobs", payload);
      toast.success("Job created");
      onCreated();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" data-testid="add-job-modal">
      <div className="w-full max-w-lg bg-card border border-border rounded-modal p-6 space-y-4 animate-slide-up max-h-[90vh] overflow-y-auto scrollbar-slim">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Testing tool</div>
            <h3 className="font-display font-black text-xl">Add Job</h3>
          </div>
          <button onClick={onClose} data-testid="add-job-close" className="p-2 rounded-btn hover:bg-secondary"><X size={16} /></button>
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Job name (required)</span>
          <input value={form.name} onChange={set("name")} data-testid="add-job-name"
            className="mt-1 w-full h-10 px-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">WinHits number</span>
            <input value={form.winhits_number} onChange={set("winhits_number")} data-testid="add-job-winhits"
              className="mt-1 w-full h-9 px-3 rounded-btn bg-background border border-border text-sm" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Status</span>
            <select value={form.status} onChange={set("status")} data-testid="add-job-status"
              className="mt-1 w-full h-9 px-3 rounded-btn bg-background border border-border text-sm">
              {CREATE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Prep date</span>
            <input type="date" value={form.prep_date} onChange={set("prep_date")} data-testid="add-job-prep-date"
              className="mt-1 w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Ship date</span>
            <input type="date" value={form.ship_date} onChange={set("ship_date")} data-testid="add-job-ship-date"
              className="mt-1 w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Return date</span>
            <input type="date" value={form.return_date} onChange={set("return_date")} data-testid="add-job-return-date"
              className="mt-1 w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Project Manager</span>
            <select value={form.project_manager_id} onChange={set("project_manager_id")} data-testid="add-job-pm"
              className="mt-1 w-full h-9 px-3 rounded-btn bg-background border border-border text-sm">
              <option value="">— None —</option>
              {pms.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Account Manager</span>
            <select value={form.account_manager_id} onChange={set("account_manager_id")} data-testid="add-job-am"
              className="mt-1 w-full h-9 px-3 rounded-btn bg-background border border-border text-sm">
              <option value="">— None —</option>
              {ams.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Production Manager (name)</span>
          <input value={form.production_manager} onChange={set("production_manager")} data-testid="add-job-production-manager"
            className="mt-1 w-full h-9 px-3 rounded-btn bg-background border border-border text-sm" />
        </label>

        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Notes</span>
          <textarea value={form.notes} onChange={set("notes")} data-testid="add-job-notes"
            className="mt-1 w-full h-16 px-3 py-2 rounded-btn bg-background border border-border text-sm" />
        </label>

        <div className="flex gap-2 pt-2">
          <button onClick={submit} disabled={saving} data-testid="add-job-save"
            className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest disabled:opacity-60">
            {saving ? "Creating…" : "Create job"}
          </button>
          <button onClick={onClose} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
        </div>
      </div>
    </div>
  );
}