import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { api, formatErr } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/date";
import { useAuth } from "@/context/AuthContext";
import { hasAnyRole, ROLES, canApprovePrepAdd, canSubmitPrepAdd, canSubmitIdealPrep, canApproveIdealPrep, canEditJob } from "@/lib/permissions";
import { JobStatusPill, StatusChip } from "@/components/StatusChip";
import { toast } from "sonner";
import { Plus, PencilSimple, Trash, FileText, ArrowsClockwise, X, Check } from "@phosphor-icons/react";

const PREP_BAYS = [
  "Prep Bay 0", "Prep Bay 1", "Prep Bay 2", "Prep Bay 3",
  "Prep Bay 4 (Small GS)", "Prep Bay 5 (Small GS)",
  "Prep Bay 6", "Prep Bay 7", "Prep Bay 8", "Prep Bay 9",
  "Prep Bay 10 (Large GS)", "Prep Bay 11", "The Bridge",
];

const TABS = ["overview", "documents", "prep-adds", "ideal-prep", "faults"];
const JOB_STATUSES = ["Quote", "Reservation", "Order", "Complete", "Cancelled"];

export default function JobDetails() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = hasAnyRole(user, ROLES.ADMIN);
  const [job, setJob] = useState(null);
  const [tab, setTab] = useState(params.get("tab") || "overview");
  const [err, setErr] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [showEditInfo, setShowEditInfo] = useState(false);

  const loadJob = useCallback(async () => {
    try {
      const { data } = await api.get(`/jobs/${id}`);
      setJob(data);
    } catch (e) { setErr(formatErr(e?.response?.data?.detail) || e.message); }
  }, [id]);
  useEffect(() => { loadJob(); }, [loadJob]);

  const switchTab = (t) => { setTab(t); setParams({ tab: t }); };

  const deleteJob = async () => {
    if (!job) return;
    if (!window.confirm(`Permanently delete "${job.name}"? This removes its documents, prep adds, ideal prep, and crew assignments. This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.delete(`/jobs/${id}`);
      toast.success("Job deleted");
      navigate("/jobs");
    } catch (e) {
      toast.error(formatErr(e?.response?.data?.detail) || e.message);
      setDeleting(false);
    }
  };

  if (err) return <div className="text-red-400 text-sm">{err}</div>;
  if (!job) return <div className="text-muted-foreground text-sm">Loading…</div>;

  return (
    <div className="space-y-6" data-testid={`job-details-${id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-muted-foreground tracking-widest">{job.winhits_number}</div>
          <h1 className="font-display font-black text-3xl md:text-4xl leading-tight">{job.name}</h1>
          <div className="flex items-center gap-2 mt-2">
            <JobStatusPill status={job.status} />
            <span className="text-xs text-muted-foreground">Prep {formatDate(job.prep_date)} · Ship {formatDate(job.ship_date)} · Return {formatDate(job.return_date)}</span>
          </div>
        </div>
        {isAdmin && (
          <div className="flex gap-2 shrink-0">
            <button onClick={() => setShowEditInfo(true)} data-testid="edit-job-info"
              className="h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
              <PencilSimple size={14} /> Edit Job Info
            </button>
            <button onClick={deleteJob} disabled={deleting} data-testid="delete-job"
              className="h-9 px-3 rounded-btn border border-red-800 text-red-400 hover:bg-red-500/10 text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2 disabled:opacity-60">
              <Trash size={14} /> {deleting ? "Deleting…" : "Delete Job"}
            </button>
          </div>
        )}
      </div>

      {showEditInfo && (
        <EditJobInfoModal job={job} onClose={() => setShowEditInfo(false)} onSaved={() => { setShowEditInfo(false); loadJob(); }} />
      )}

      <div className="flex gap-1 border-b border-border overflow-x-auto scrollbar-slim" role="tablist">
        {TABS.map((t) => (
          <button key={t} onClick={() => switchTab(t)} data-testid={`tab-${t}`}
            className={`px-4 h-10 text-sm font-semibold border-b-2 whitespace-nowrap transition-colors ${tab === t ? "border-prg-red text-prg-red" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t.replace("-", " ").replace(/\b\w/g, (l) => l.toUpperCase())}
          </button>
        ))}
      </div>

      <div className="animate-slide-up">
        {tab === "overview" && <Overview job={job} onSaved={loadJob} />}
        {tab === "documents" && <Documents job={job} />}
        {tab === "prep-adds" && <PrepAdds job={job} />}
        {tab === "ideal-prep" && <IdealPrep job={job} />}
        {tab === "faults" && <Faults job={job} />}
      </div>
    </div>
  );
}

/* ---------------- Edit Job Info (Admin only) ---------------- */
function EditJobInfoModal({ job, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: job.name || "", winhits_number: job.winhits_number || "",
    project_manager_id: job.project_manager_id || "", account_manager_id: job.account_manager_id || "",
    production_manager: job.production_manager || "",
    prep_date: job.prep_date || "", ship_date: job.ship_date || "", return_date: job.return_date || "",
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

  const save = async () => {
    if (!form.name.trim()) { toast.error("Job name is required"); return; }
    setSaving(true);
    try {
      await api.patch(`/jobs/${job.id}`, {
        ...form,
        winhits_number: form.winhits_number || null,
        project_manager_id: form.project_manager_id || null,
        account_manager_id: form.account_manager_id || null,
        production_manager: form.production_manager || null,
        prep_date: form.prep_date || null,
        ship_date: form.ship_date || null,
        return_date: form.return_date || null,
      });
      toast.success("Job info updated");
      onSaved();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail) || e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" data-testid="edit-job-info-modal">
      <div className="w-full max-w-lg bg-card border border-border rounded-modal p-6 space-y-4 animate-slide-up max-h-[90vh] overflow-y-auto scrollbar-slim">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Administrator</div>
            <h3 className="font-display font-black text-xl">Edit Job Info</h3>
          </div>
          <button onClick={onClose} data-testid="edit-job-info-close" className="p-2 rounded-btn hover:bg-secondary"><X size={16} /></button>
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Job name</span>
          <input value={form.name} onChange={set("name")} data-testid="edit-name"
            className="mt-1 w-full h-10 px-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
        </label>

        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">WinHits number</span>
          <input value={form.winhits_number} onChange={set("winhits_number")} data-testid="edit-winhits"
            className="mt-1 w-full h-9 px-3 rounded-btn bg-background border border-border text-sm" />
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Prep date</span>
            <input type="date" value={form.prep_date} onChange={set("prep_date")} data-testid="edit-prep-date"
              className="mt-1 w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Ship date</span>
            <input type="date" value={form.ship_date} onChange={set("ship_date")} data-testid="edit-ship-date"
              className="mt-1 w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Return date</span>
            <input type="date" value={form.return_date} onChange={set("return_date")} data-testid="edit-return-date"
              className="mt-1 w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Project Manager</span>
            <select value={form.project_manager_id} onChange={set("project_manager_id")} data-testid="edit-pm"
              className="mt-1 w-full h-9 px-3 rounded-btn bg-background border border-border text-sm">
              <option value="">— None —</option>
              {pms.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Account Manager</span>
            <select value={form.account_manager_id} onChange={set("account_manager_id")} data-testid="edit-am"
              className="mt-1 w-full h-9 px-3 rounded-btn bg-background border border-border text-sm">
              <option value="">— None —</option>
              {ams.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Production Manager (name)</span>
          <input value={form.production_manager} onChange={set("production_manager")} data-testid="edit-production-manager"
            className="mt-1 w-full h-9 px-3 rounded-btn bg-background border border-border text-sm" />
        </label>

        <div className="flex gap-2 pt-2">
          <button onClick={save} disabled={saving} data-testid="edit-job-info-save"
            className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest disabled:opacity-60">
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button onClick={onClose} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Overview ---------------- */
function Overview({ job, onSaved }) {
  const { user } = useAuth();
  const editable = canEditJob(user, job);
  const canSeeBayAvailability = hasAnyRole(user, ROLES.OPERATIONS_MANAGER, ROLES.PROJECT_MANAGER, ROLES.ADMIN);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({
    notes: job.notes || "", hotel_details: job.hotel_details || "",
    travel_details: job.travel_details || "", client_details: job.client_details || "",
    status: job.status,
  });
  const [bayAvailability, setBayAvailability] = useState([]);

  useEffect(() => {
    if (!canSeeBayAvailability || !job.prep_date || !job.ship_date) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get("/prep-bays/availability", {
          params: { prep_date: job.prep_date, ship_date: job.ship_date, exclude_job_id: job.id },
        });
        if (!cancelled) setBayAvailability(data);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [canSeeBayAvailability, job.id, job.prep_date, job.ship_date]);

  const save = async () => {
    try {
      await api.patch(`/jobs/${job.id}`, form);
      toast.success("Saved");
      setEdit(false);
      onSaved();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail) || e.message); }
  };

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="md:col-span-2 space-y-4 min-w-0">
        <Panel title="Contacts">
          <KV k="Project Manager" v={job.project_manager} />
          <KV k="Account Manager" v={job.account_manager} />
          <KV k="Production Manager" v={job.production_manager} />
          {(job.crew || []).filter((c) => c.is_crew_chief).map((c) => (
            <KV key={c.user_id} k={`${c.department} Crew Chief`} v={c.user_name} />
          ))}
        </Panel>
        <Panel title="General Info" action={editable && !edit && <button onClick={() => setEdit(true)} data-testid="edit-job" className="text-xs text-muted-foreground hover:text-prg-red inline-flex items-center gap-1"><PencilSimple size={12} /> Edit</button>}>
          {edit ? (
            <div className="space-y-2 text-sm">
              <Field label="Notes"><textarea className="input h-20" value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} data-testid="edit-notes" /></Field>
              <Field label="Hotel details"><textarea className="input h-16" value={form.hotel_details} onChange={(e) => setForm({...form, hotel_details: e.target.value})} data-testid="edit-hotel" /></Field>
              <Field label="Travel details"><textarea className="input h-16" value={form.travel_details} onChange={(e) => setForm({...form, travel_details: e.target.value})} data-testid="edit-travel" /></Field>
              <Field label="Client details"><textarea className="input h-16" value={form.client_details} onChange={(e) => setForm({...form, client_details: e.target.value})} /></Field>
              <Field label="Status">
                <select className="input" value={form.status} onChange={(e) => setForm({...form, status: e.target.value})} data-testid="edit-status">
                  {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
              <div className="flex gap-2">
                <button onClick={save} data-testid="save-job" className="h-9 px-4 rounded-btn bg-prg-red text-white font-bold text-xs uppercase tracking-widest">Save</button>
                <button onClick={() => setEdit(false)} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <KV k="Prep bays" v={(job.prep_bays || []).map((b) => job.bay_departments?.[b] ? `${b} (${job.bay_departments[b]})` : b).join(", ")} multi />
              <KV k="Notes" v={job.notes} multi />
              <KV k="Hotel" v={job.hotel_details} multi />
              <KV k="Travel" v={job.travel_details} multi />
              {job.client_details && <KV k="Client" v={job.client_details} multi />}
            </>
          )}
        </Panel>
      </div>
      <div className="space-y-4 min-w-0">
        <Panel title="Schedule">
          <KV k="Prep" v={formatDate(job.prep_date)} />
          <KV k="Ship" v={formatDate(job.ship_date)} />
          <KV k="Show" v={(job.show_dates || []).map(formatDate).join(", ")} />
          <KV k="Return" v={formatDate(job.return_date)} />
        </Panel>
        {canSeeBayAvailability && (
          <Panel title="Bay Availability">
            <BayAvailability job={job} bayAvailability={bayAvailability} />
          </Panel>
        )}
        <Panel title="Crew">
          <CrewManager job={job} onChanged={onSaved} />
        </Panel>
      </div>
      <style>{`
        .input { width: 100%; background: hsl(var(--background)); border: 1px solid hsl(var(--border)); padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.85rem; }
        .input:focus { outline: none; border-color: #D11047; }
      `}</style>
    </div>
  );
}

function Panel({ title, action, children }) {
  return (
    <div className="bg-card border border-border rounded-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">{title}</div>
        {action}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
function KV({ k, v, multi }) {
  if (!v) return null;
  return (
    <div className={`text-sm ${multi ? "flex flex-col gap-0.5" : "flex justify-between gap-3 min-w-0"}`}>
      <div className="text-muted-foreground text-xs shrink-0">{k}</div>
      <div className={multi ? "whitespace-pre-wrap" : "text-right font-medium truncate min-w-0"}>{v}</div>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{label}</div>
      {children}
    </label>
  );
}

/* Read-only bay status for this job's prep/ship window.
   Booking/editing bays is now exclusively an Admin/Ops action (Prep Calendar "Book Bays"). */
function BayAvailability({ job, bayAvailability }) {
  if (!job.prep_date || !job.ship_date) {
    return <div className="text-sm text-muted-foreground">Set prep and ship dates to see bay availability.</div>;
  }
  const availByBay = Object.fromEntries((bayAvailability || []).map((a) => [a.bay, a]));
  const bookedByThisJob = new Set(job.prep_bays || []);

  return (
    <div className="space-y-1.5">
      {PREP_BAYS.map((bay) => {
        const mine = bookedByThisJob.has(bay);
        const other = !mine && availByBay[bay] && !availByBay[bay].available;
        const conflict = other ? availByBay[bay].conflicts?.[0] : null;
        const dept = job.bay_departments?.[bay];
        return (
          <div key={bay} className="flex items-center justify-between text-sm" data-testid={`bay-status-${bay.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}>
            <span className={mine ? "font-semibold" : other ? "text-muted-foreground" : "text-muted-foreground"}>
              {bay}{mine && dept ? ` (${dept})` : ""}
            </span>
            {mine ? (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-500/20 text-emerald-400">This job</span>
            ) : other ? (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-500/20 text-red-400" title={conflict ? `${conflict.job_name} (${formatDate(conflict.prep_date)} → ${formatDate(conflict.ship_date)})` : ""}>
                Booked
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-secondary text-muted-foreground">Available</span>
            )}
          </div>
        );
      })}
      <div className="text-[10px] text-muted-foreground pt-1">Bay bookings are managed by Administrators / Operations Managers via the Prep Calendar.</div>
    </div>
  );
}

const CREW_DEPARTMENTS = ["Lighting", "Video", "Rigging", "Automation", "Audio"];

function CrewManager({ job, onChanged }) {
  const { user } = useAuth();
  const canManage = canEditJob(user, job); // PM assigned or Administrator
  const [adding, setAdding] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [pick, setPick] = useState("");
  const [isChief, setIsChief] = useState(false);
  const [loading, setLoading] = useState(false);

  const crew = (job.crew || []).filter(Boolean);
  const assignedIds = new Set(crew.map((c) => c.user_id));
  const chiefByDept = (dept) => crew.find((c) => c.department === dept && c.is_crew_chief);
  const pickedCandidate = candidates.find((c) => c.id === pick);
  const pickedDepartment = pickedCandidate?.department || "";

  const openPicker = async () => {
    setAdding(true);
    try {
      const { data } = await api.get("/users");
      // Only Crew Member role; must be active; not already on the crew; not the assigned PM
      const isCrewEligible = (u) => (u.roles || []).some((r) => r === "Crew Member");
      setCandidates(
        data.filter((u) =>
          u.status === "active" &&
          isCrewEligible(u) &&
          !assignedIds.has(u.id) &&
          u.id !== job.project_manager_id
        )
      );
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  const add = async () => {
    if (!pick) return;
    setLoading(true);
    try {
      // department is intentionally omitted — the backend falls back to the
      // user's own profile department (set when they were invited)
      await api.post(`/jobs/${job.id}/crew`, { user_id: pick, is_crew_chief: isChief });
      toast.success(isChief ? `Added as ${pickedDepartment} Crew Chief` : "Crew member added");
      setPick(""); setIsChief(false); setAdding(false);
      onChanged();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
    finally { setLoading(false); }
  };

  const remove = async (userId) => {
    if (!window.confirm("Remove this crew member from the job?")) return;
    try {
      await api.delete(`/jobs/${job.id}/crew/${userId}`);
      toast.success("Removed");
      onChanged();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  const toggleChief = async (c) => {
    const makingChief = !c.is_crew_chief;
    if (makingChief) {
      const existing = chiefByDept(c.department);
      if (existing && existing.user_id !== c.user_id &&
          !window.confirm(`${existing.user_name} is currently the ${c.department} Crew Chief. Replace them with ${c.user_name}?`)) {
        return;
      }
    }
    try {
      await api.post(`/jobs/${job.id}/crew`, { user_id: c.user_id, department: c.department, is_crew_chief: makingChief });
      toast.success(makingChief ? `${c.user_name} is now ${c.department} Crew Chief` : `${c.user_name} is no longer Crew Chief`);
      onChanged();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  return (
    <div className="space-y-3" data-testid="crew-manager">
      {crew.length > 0 ? (
        <div className="space-y-1.5">
          {crew.map((c) => (
            <div key={c.user_id} data-testid={`crew-row-${c.user_id}`} className="flex items-center justify-between text-sm bg-background border border-border rounded-input px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-7 h-7 rounded-full bg-prg-red text-white flex items-center justify-center font-display font-bold text-[10px] shrink-0">
                  {c.user_name?.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                </div>
                <div className="min-w-0">
                  <div className="font-semibold truncate flex items-center gap-1.5">
                    {c.user_name}
                    {c.is_crew_chief && (
                      <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest bg-prg-red text-white" data-testid={`chief-badge-${c.user_id}`}>Chief</span>
                    )}
                  </div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{c.department || "General"}</div>
                </div>
              </div>
              {canManage && (
                <div className="flex items-center gap-1 shrink-0">
                  {CREW_DEPARTMENTS.includes(c.department) && (
                    <button onClick={() => toggleChief(c)} data-testid={`crew-toggle-chief-${c.user_id}`}
                      className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-prg-red px-2 py-1 rounded-btn hover:bg-secondary">
                      {c.is_crew_chief ? "Remove chief" : "Make chief"}
                    </button>
                  )}
                  <button onClick={() => remove(c.user_id)} data-testid={`crew-remove-${c.user_id}`}
                    className="p-1.5 rounded-btn text-muted-foreground hover:text-red-500 hover:bg-secondary" aria-label="Remove">
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground" data-testid="crew-empty">No crew assigned.</div>
      )}

      {canManage && (
        adding ? (
          <div className="space-y-2 pt-1">
            <select value={pick} onChange={(e) => { setPick(e.target.value); setIsChief(false); }} data-testid="crew-picker"
              className="w-full h-9 px-3 rounded-btn bg-background border border-border text-sm">
              <option value="">— Select a user —</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {u.department || "General"}
                </option>
              ))}
            </select>
            {pick && (
              <label className={`flex items-center gap-2 text-xs px-1 ${CREW_DEPARTMENTS.includes(pickedDepartment) ? "" : "opacity-50"}`}>
                <input type="checkbox" checked={isChief} disabled={!CREW_DEPARTMENTS.includes(pickedDepartment)}
                  onChange={(e) => setIsChief(e.target.checked)} data-testid="crew-add-is-chief" />
                Make {pickedDepartment || "department"} Crew Chief
                {!CREW_DEPARTMENTS.includes(pickedDepartment) && " (no department set on their profile)"}
              </label>
            )}
            {isChief && chiefByDept(pickedDepartment) && (
              <div className="text-[11px] text-amber-400">This will replace {chiefByDept(pickedDepartment).user_name} as {pickedDepartment} Crew Chief.</div>
            )}
            <div className="flex gap-2">
              <button onClick={add} disabled={!pick || loading} data-testid="crew-add-confirm"
                className="h-9 px-3 rounded-btn bg-prg-red hover:bg-prg-red-dim disabled:opacity-60 text-white text-xs font-bold uppercase tracking-widest">
                Add
              </button>
              <button onClick={() => { setAdding(false); setPick(""); setIsChief(false); }} data-testid="crew-add-cancel"
                className="h-9 px-3 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={openPicker} data-testid="crew-add-btn"
            className="h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
            <Plus size={14} /> Add crew member
          </button>
        )
      )}
    </div>
  );
}

/* ---------------- Documents ---------------- */
function Documents({ job }) {
  const { user } = useAuth();
  const [docs, setDocs] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ document_type: "Drawing", department: "Lighting", file_name: "", file_url: "" });

  const load = async () => {
    try { const { data } = await api.get(`/jobs/${job.id}/documents`); setDocs(data); } catch { void 0; }
  };
  useEffect(() => { load(); }, [job.id]);

  const add = async () => {
    try { await api.post(`/jobs/${job.id}/documents`, form); toast.success("Uploaded"); setShow(false); setForm({ document_type: "Drawing", department: "Lighting", file_name: "", file_url: "" }); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };
  const del = async (id) => {
    try { await api.delete(`/jobs/${job.id}/documents/${id}`); toast.success("Deleted"); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };
  const canUpload = canEditJob(user, job);

  return (
    <div className="space-y-4">
      {canUpload && (
        <div>
          {!show ? (
            <button onClick={() => setShow(true)} data-testid="add-document" className="h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
              <Plus size={14} /> Add document
            </button>
          ) : (
            <div className="bg-card border border-border rounded-card p-4 space-y-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <select value={form.document_type} onChange={(e) => setForm({...form, document_type: e.target.value})} data-testid="doc-type" className="h-9 px-2 rounded-btn bg-background border border-border text-sm">
                  {["Drawing","RAMS","Motor Certificate","LOLER"].map((t) => <option key={t}>{t}</option>)}
                </select>
                <select value={form.department} onChange={(e) => setForm({...form, department: e.target.value})} data-testid="doc-department" className="h-9 px-2 rounded-btn bg-background border border-border text-sm">
                  {["Lighting","Video","Rigging","Automation","Audio","General"].map((t) => <option key={t}>{t}</option>)}
                </select>
                <input placeholder="File name" value={form.file_name} onChange={(e) => setForm({...form, file_name: e.target.value})} data-testid="doc-name" className="h-9 px-2 rounded-btn bg-background border border-border text-sm" />
                <input placeholder="File URL" value={form.file_url} onChange={(e) => setForm({...form, file_url: e.target.value})} data-testid="doc-url" className="h-9 px-2 rounded-btn bg-background border border-border text-sm" />
              </div>
              <div className="flex gap-2">
                <button onClick={add} data-testid="doc-save" className="h-9 px-3 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">Save</button>
                <button onClick={() => setShow(false)} className="h-9 px-3 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {docs.length === 0 ? (
        <div className="bg-card border border-border rounded-card p-6 text-sm text-muted-foreground text-center">No documents.</div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {docs.map((d) => (
            <div key={d.id} className="bg-card border border-border rounded-card p-4 flex items-center gap-3" data-testid={`document-${d.id}`}>
              <FileText size={22} className="text-prg-red" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm truncate"><a href={d.file_url} target="_blank" rel="noopener noreferrer" className="hover:text-prg-red">{d.file_name}</a></div>
                <div className="text-xs text-muted-foreground">{d.document_type} · {d.department || "—"} · by {d.uploaded_by_name}</div>
              </div>
              {canUpload && <button onClick={() => del(d.id)} className="p-2 text-muted-foreground hover:text-red-500"><Trash size={16} /></button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Prep Adds ---------------- */
function FixtureTypeInput({ value, onChange, testId }) {
  const [query, setQuery] = useState(value || "");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => { setQuery(value || ""); }, [value]);

  useEffect(() => {
    if (query.trim().length < 3 || query === value) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get("/equipment/fixture-types", { params: { q: query.trim() } });
        if (!cancelled) setResults(data);
      } catch { if (!cancelled) setResults([]); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, value]);

  const pick = (ft) => { onChange(ft); setQuery(ft); setResults([]); setOpen(false); };

  return (
    <div className="relative">
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search equipment type… (3+ characters)"
        data-testid={testId}
        className="w-full h-9 px-2 rounded-btn bg-background border border-border text-sm"
      />
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 left-0 right-0 max-h-48 overflow-y-auto scrollbar-slim rounded-input border border-border bg-popover shadow-lg">
          {results.map((ft) => (
            <button key={ft} type="button" onMouseDown={() => pick(ft)} className="w-full text-left px-3 py-1.5 text-sm hover:bg-secondary">
              {ft}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PrepAdds({ job }) {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [show, setShow] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [items, setItems] = useState([{ fixture_type: "", qty: 1 }]);
  const [notes, setNotes] = useState("");
  const canSubmit = canSubmitPrepAdd(user, job);
  const canDecide = canApprovePrepAdd(user);
  const todayIso = new Date().toISOString().slice(0, 10);
  const inPrepWindow = !!(job.prep_date && job.ship_date && todayIso >= job.prep_date && todayIso <= job.ship_date);

  const load = async () => {
    try { const { data } = await api.get(`/jobs/${job.id}/prep-adds`); setRows(data); } catch { void 0; }
  };
  useEffect(() => { load(); }, [job.id]);

  const openNew = () => {
    setEditingId(null);
    setItems([{ fixture_type: "", qty: 1 }]);
    setNotes("");
    setShow(true);
  };

  const openEdit = (p) => {
    setEditingId(p.id);
    setItems(p.items?.length ? p.items.map((i) => ({ fixture_type: i.fixture_type, qty: i.qty })) : [{ fixture_type: "", qty: 1 }]);
    setNotes(p.notes || "");
    setShow(true);
  };

  const submit = async () => {
    try {
      const payload = { items: items.filter((i) => i.fixture_type), notes };
      if (editingId) {
        await api.patch(`/prep-adds/${editingId}`, payload);
        toast.success("Prep Add updated");
      } else {
        await api.post(`/jobs/${job.id}/prep-adds`, payload);
        toast.success("Prep Add submitted");
      }
      setShow(false); setEditingId(null); setItems([{ fixture_type: "", qty: 1 }]); setNotes(""); load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  const decide = async (id, decision) => {
    const comments = decision === "Rejected" ? window.prompt("Rejection comments (optional):") || "" : "";
    try { await api.post(`/prep-adds/${id}/decision`, { decision, comments }); toast.success(decision); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  return (
    <div className="space-y-4">
      {canSubmit && (
        <div>
          {!inPrepWindow ? (
            <div className="text-sm text-muted-foreground bg-card border border-border rounded-card p-3" data-testid="prep-add-window-closed">
              Prep Adds can only be submitted while this job is between its prep ({formatDate(job.prep_date)}) and ship ({formatDate(job.ship_date)}) dates.
            </div>
          ) : !show ? (
            <button onClick={openNew} data-testid="new-prep-add" className="h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
              <Plus size={14} /> New Prep Add
            </button>
          ) : (
            <div className="bg-card border border-border rounded-card p-4 space-y-3">
              {editingId && <div className="text-[11px] text-amber-400">Editing your pending submission — changes save in place, no new Prep Add will be created.</div>}
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Items</div>
              <div className="space-y-2">
                {items.map((it, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2">
                    <div className="col-span-9">
                      <FixtureTypeInput
                        value={it.fixture_type}
                        onChange={(v) => { const c = [...items]; c[idx].fixture_type = v; setItems(c); }}
                        testId={`prep-item-type-${idx}`}
                      />
                    </div>
                    <input placeholder="Qty" type="number" min="1" value={it.qty} onChange={(e) => { const c = [...items]; c[idx].qty = e.target.value; setItems(c); }} data-testid={`prep-item-qty-${idx}`} className="col-span-2 h-9 px-2 rounded-btn bg-background border border-border text-sm" />
                    <button onClick={() => setItems(items.filter((_, i) => i !== idx))} className="col-span-1 h-9 rounded-btn hover:bg-background text-muted-foreground"><X size={14} /></button>
                  </div>
                ))}
              </div>
              <button onClick={() => setItems([...items, { fixture_type: "", qty: 1 }])} data-testid="prep-add-item" className="text-xs text-prg-red inline-flex items-center gap-1">+ Add item</button>
              <textarea placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="prep-notes" className="w-full h-20 px-3 py-2 rounded-btn bg-background border border-border text-sm" />
              <div className="flex gap-2">
                <button onClick={submit} data-testid="prep-submit" className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">{editingId ? "Save changes" : "Submit"}</button>
                <button onClick={() => { setShow(false); setEditingId(null); }} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        {rows.length === 0 && <div className="text-sm text-muted-foreground bg-card border border-border rounded-card p-6 text-center">No Prep Adds yet.</div>}
        {rows.map((p) => (
          <div key={p.id} className="bg-card border border-border rounded-card p-4" data-testid={`prep-row-${p.id}`}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <div className="text-xs text-muted-foreground">by {p.submitted_by_name} · {formatDateTime(p.submission_date)}</div>
                {p.notes && <div className="text-sm mt-1">{p.notes}</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {p.status === "Pending" && p.submitted_by_id === user?.id && (
                  <button onClick={() => openEdit(p)} data-testid={`prep-edit-${p.id}`} className="text-xs text-muted-foreground hover:text-prg-red inline-flex items-center gap-1">
                    <PencilSimple size={12} /> Edit
                  </button>
                )}
                <StatusChip label={p.status} state={p.status === "Approved" ? "green" : p.status === "Rejected" ? "red" : "amber"} testId={`prep-status-${p.id}`} />
              </div>
            </div>
            <div className="text-sm space-y-1 pl-3 border-l-2 border-border">
              {(p.items || []).map((it, i) => (
                <div key={i} className="flex gap-3">
                  <span>{it.fixture_type}</span>
                  <span className="text-muted-foreground">× {it.qty}</span>
                </div>
              ))}
            </div>
            {p.status === "Pending" && canDecide && (
              <div className="mt-3 flex gap-2">
                <button onClick={() => decide(p.id, "Approved")} data-testid={`prep-approve-${p.id}`} className="h-8 px-3 rounded-btn bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs font-bold uppercase tracking-widest">Approve</button>
                <button onClick={() => decide(p.id, "Rejected")} data-testid={`prep-reject-${p.id}`} className="h-8 px-3 rounded-btn bg-red-600/80 hover:bg-red-600 text-white text-xs font-bold uppercase tracking-widest">Reject</button>
              </div>
            )}
            {p.decision_date && <div className="mt-2 text-xs text-muted-foreground">{p.status} by {p.decision_by} · {formatDateTime(p.decision_date)}{p.approval_notes && ` — ${p.approval_notes}`}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Ideal Prep ---------------- */
function IdealPrep({ job }) {
  const { user } = useAuth();
  const [versions, setVersions] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ equipment_requirements: "", timeline: [{ day: "Day 1", description: "" }], special_requirements: "", notes: "" });

  const load = async () => { try { const { data } = await api.get(`/jobs/${job.id}/ideal-prep`); setVersions(data); } catch { void 0; } };
  useEffect(() => { load(); }, [job.id]);

  const canSubmit = canSubmitIdealPrep(user, job);
  const canApprove = canApproveIdealPrep(user);

  // A submission the current user can still edit in place — theirs, still Pending,
  // and no PM (or Admin acting for PM) decision recorded yet.
  const editable = versions.find((v) =>
    v.submitted_by_id === user?.id &&
    v.status === "Pending" &&
    !(v.approvals || []).some((a) => a.role === "Project Manager" || a.role === "Administrator")
  );

  const openForm = () => {
    if (editable) {
      setForm({
        equipment_requirements: editable.equipment_requirements || "",
        timeline: editable.timeline?.length ? editable.timeline : [{ day: "Day 1", description: "" }],
        special_requirements: editable.special_requirements || "",
        notes: editable.notes || "",
      });
    } else {
      setForm({ equipment_requirements: "", timeline: [{ day: "Day 1", description: "" }], special_requirements: "", notes: "" });
    }
    setShow(true);
  };

  const submit = async () => {
    try {
      if (editable) {
        await api.patch(`/ideal-prep/${editable.id}`, form);
        toast.success("Ideal Prep updated");
      } else {
        await api.post(`/jobs/${job.id}/ideal-prep`, form);
        toast.success("Ideal Prep submitted");
      }
      setShow(false);
      load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  const decide = async (id, decision) => {
    const comments = decision === "Rejected" ? window.prompt("Comments (optional):") || "" : "";
    try { await api.post(`/ideal-prep/${id}/decision`, { decision, comments }); toast.success(decision); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  return (
    <div className="space-y-4">
      {canSubmit && (
        <div>
          {!show ? (
            <button onClick={openForm} data-testid="new-ideal-prep" className="h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
              <Plus size={14} /> {editable ? `Edit your v${editable.version} submission` : "New Ideal Prep"}
            </button>
          ) : (
            <div className="bg-card border border-border rounded-card p-4 space-y-3">
              {editable && (
                <div className="text-[11px] text-amber-400">Editing your pending v{editable.version} submission — no new version will be created. Once a Project Manager decides, this will lock and further changes will need a new submission.</div>
              )}
              <Field label="Equipment preparation requirements (required)">
                <textarea data-testid="ideal-equipment" value={form.equipment_requirements} onChange={(e) => setForm({...form, equipment_requirements: e.target.value})} className="w-full h-24 px-3 py-2 rounded-btn bg-background border border-border text-sm" placeholder="What needs to be prepared on Day 1?" required />
              </Field>
              <Field label="Timeline">
                <div className="space-y-2">
                  {form.timeline.map((t, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2">
                      <input value={t.day} onChange={(e) => { const c = [...form.timeline]; c[i].day = e.target.value; setForm({...form, timeline: c}); }} data-testid={`timeline-day-${i}`} className="col-span-3 h-9 px-2 rounded-btn bg-background border border-border text-sm" />
                      <input value={t.description} onChange={(e) => { const c = [...form.timeline]; c[i].description = e.target.value; setForm({...form, timeline: c}); }} data-testid={`timeline-desc-${i}`} placeholder="Description" className="col-span-8 h-9 px-2 rounded-btn bg-background border border-border text-sm" />
                      <button onClick={() => setForm({...form, timeline: form.timeline.filter((_, x) => x !== i)})} className="col-span-1 h-9 rounded-btn text-muted-foreground"><X size={14} /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setForm({...form, timeline: [...form.timeline, { day: `Day ${form.timeline.length + 1}`, description: "" }]})} className="text-xs text-prg-red">+ Add day</button>
                </div>
              </Field>
              <Field label="Special requirements">
                <textarea data-testid="ideal-special" value={form.special_requirements} onChange={(e) => setForm({...form, special_requirements: e.target.value})} className="w-full h-16 px-3 py-2 rounded-btn bg-background border border-border text-sm" />
              </Field>
              <Field label="Additional notes">
                <textarea value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} className="w-full h-16 px-3 py-2 rounded-btn bg-background border border-border text-sm" />
              </Field>
              <div className="flex gap-2">
                <button onClick={submit} data-testid="ideal-submit" className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">{editable ? "Save changes" : "Submit"}</button>
                <button onClick={() => setShow(false)} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {versions.length === 0 && <div className="text-sm text-muted-foreground bg-card border border-border rounded-card p-6 text-center">No Ideal Prep submitted yet.</div>}
      {versions.map((v) => (
        <div key={v.id} className="bg-card border border-border rounded-card p-4" data-testid={`ideal-row-${v.id}`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Version</span>
              <span className="font-mono text-sm">v{v.version}</span>
            </div>
            <StatusChip label={v.status} state={v.status === "Approved" ? "green" : v.status === "Rejected" ? "red" : "amber"} testId={`ideal-status-${v.id}`} />
          </div>
          <div className="text-xs text-muted-foreground mb-2">by {v.submitted_by_name} · {formatDateTime(v.submitted_date)}</div>
          <div className="text-sm whitespace-pre-wrap mb-2"><span className="text-muted-foreground text-xs uppercase tracking-widest block mb-1">Requirements</span>{v.equipment_requirements}</div>
          {v.timeline?.length > 0 && (
            <div className="text-sm space-y-0.5 mb-2">
              <span className="text-muted-foreground text-xs uppercase tracking-widest block mb-1">Timeline</span>
              {v.timeline.map((t, i) => <div key={i}><span className="text-prg-red font-mono text-xs">{t.day}</span> — {t.description}</div>)}
            </div>
          )}
          {v.special_requirements && <div className="text-sm mb-1"><span className="text-muted-foreground text-xs uppercase tracking-widest block mb-1">Special</span>{v.special_requirements}</div>}
          {v.approvals?.length > 0 && (
            <div className="mt-2 space-y-1 pt-2 border-t border-border">
              {v.approvals.map((a, i) => (
                <div key={i} className="text-xs flex justify-between">
                  <span><span className="text-muted-foreground">{a.role}:</span> <span className={a.decision === "Approved" ? "text-emerald-400" : "text-red-400"}>{a.decision}</span> by {a.user_name}</span>
                  <span className="text-muted-foreground">{formatDateTime(a.date)}</span>
                </div>
              ))}
            </div>
          )}
          {v.status === "Pending" && canApprove && (
            <div className="mt-3 flex gap-2">
              <button onClick={() => decide(v.id, "Approved")} data-testid={`ideal-approve-${v.id}`} className="h-8 px-3 rounded-btn bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs font-bold uppercase tracking-widest">Approve</button>
              <button onClick={() => decide(v.id, "Rejected")} data-testid={`ideal-reject-${v.id}`} className="h-8 px-3 rounded-btn bg-red-600/80 hover:bg-red-600 text-white text-xs font-bold uppercase tracking-widest">Reject</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Faults ---------------- */
function Faults({ job }) {
  const [rows, setRows] = useState([]);
  const [barcode, setBarcode] = useState("");
  const [desc, setDesc] = useState("");
  const [canUse, setCanUse] = useState(true);
  const [show, setShow] = useState(false);
  const [checkingBarcode, setCheckingBarcode] = useState(false);
  const [matchedEquipment, setMatchedEquipment] = useState(null);
  const [barcodeNotFound, setBarcodeNotFound] = useState(false);

  const load = async () => { try { const { data } = await api.get(`/jobs/${job.id}/faults`); setRows(data); } catch { void 0; } };
  useEffect(() => { load(); }, [job.id]);

  useEffect(() => {
    const trimmed = barcode.trim();
    if (trimmed.length < 3) { setMatchedEquipment(null); setBarcodeNotFound(false); return; }
    let cancelled = false;
    setCheckingBarcode(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get(`/equipment/${encodeURIComponent(trimmed)}`);
        if (!cancelled) { setMatchedEquipment(data.equipment); setBarcodeNotFound(false); }
      } catch {
        if (!cancelled) { setMatchedEquipment(null); setBarcodeNotFound(true); }
      } finally {
        if (!cancelled) setCheckingBarcode(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [barcode]);

  const submit = async () => {
    try { await api.post("/faults", { job_id: job.id, equipment_barcode: barcode.trim(), description: desc, can_be_used: canUse }); toast.success("Fault reported"); setShow(false); setBarcode(""); setDesc(""); setMatchedEquipment(null); setBarcodeNotFound(false); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  return (
    <div className="space-y-4">
      {!show ? (
        <button onClick={() => setShow(true)} data-testid="new-fault" className="h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
          <Plus size={14} /> Report a fault
        </button>
      ) : (
        <div className="bg-card border border-border rounded-card p-4 space-y-3">
          <div>
            <input value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="Equipment barcode" data-testid="fault-barcode" className="w-full h-9 px-3 rounded-btn bg-background border border-border text-sm font-mono" />
            {checkingBarcode && (
              <div className="mt-1.5 text-xs text-muted-foreground" data-testid="fault-barcode-checking">Checking barcode…</div>
            )}
            {!checkingBarcode && matchedEquipment && (
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-400" data-testid="fault-barcode-match">
                <Check size={12} weight="bold" /> {matchedEquipment.fixture_type} — verify this is the correct piece of equipment
              </div>
            )}
            {!checkingBarcode && barcodeNotFound && (
              <div className="mt-1.5 text-xs text-red-400" data-testid="fault-barcode-not-found">Barcode not recognised — double check it before submitting</div>
            )}
          </div>
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Describe the fault" data-testid="fault-description" className="w-full h-24 px-3 py-2 rounded-btn bg-background border border-border text-sm" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={canUse} onChange={(e) => setCanUse(e.target.checked)} data-testid="fault-can-be-used" /> Equipment can still be used
          </label>
          <div className="flex gap-2">
            <button onClick={submit} data-testid="fault-submit" className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">Submit</button>
            <button onClick={() => setShow(false)} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
          </div>
        </div>
      )}

      {rows.length === 0 && <div className="text-sm text-muted-foreground bg-card border border-border rounded-card p-6 text-center">No faults on this job.</div>}
      {rows.map((f) => (
        <a key={f.id} href={`/faults/${f.id}`} className="block bg-card border border-border rounded-card p-4 hover:border-prg-red transition-colors" data-testid={`fault-row-${f.id}`}>
          <div className="flex items-center justify-between mb-1">
            <div className="font-semibold">{f.fixture_type} <span className="font-mono text-xs text-muted-foreground ml-2">{f.equipment_barcode}</span></div>
            <StatusChip label={f.status} state={f.status === "Closed" ? "green" : "red"} />
          </div>
          <div className="text-sm text-muted-foreground line-clamp-2">{f.description}</div>
          <div className="text-xs text-muted-foreground mt-2">by {f.reported_by_name} · {formatDateTime(f.created_at)}</div>
        </a>
      ))}
    </div>
  );
}