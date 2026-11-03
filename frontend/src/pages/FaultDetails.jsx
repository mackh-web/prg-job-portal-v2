import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, formatErr } from "@/lib/api";
import { formatDate } from "@/lib/date";
import { useAuth } from "@/context/AuthContext";
import { canManageFaults, hasAnyRole, ROLES } from "@/lib/permissions";
import { StatusChip } from "@/components/StatusChip";
import { ArrowLeft, PencilSimple, X, Check, Plus, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";

const STATUSES = ["Open", "Under Assessment", "In Repair", "Awaiting Parts", "Parts Received", "Repaired", "Closed"];
const AUTO_ONLY_STATUSES = new Set(["Under Assessment", "Awaiting Parts", "Parts Received"]);
const SEVERITIES = ["Low", "Medium", "High", "Critical"];

export default function FaultDetails() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const [f, setF] = useState(null);
  const [comment, setComment] = useState("");
  const [editReport, setEditReport] = useState(false);
  const [reportForm, setReportForm] = useState({ description: "", can_be_used: true, additional_comments: "" });
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try { const { data } = await api.get(`/faults/${id}`); setF(data); } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (f) setReportForm({
      description: f.description || "",
      can_be_used: !!f.can_be_used,
      additional_comments: f.additional_comments || "",
    });
  }, [f]);

  const update = async (updates) => {
    try { await api.patch(`/faults/${id}`, updates); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };
  const addComment = async () => {
    if (!comment.trim()) return;
    try { await api.post(`/faults/${id}/comments`, { comment }); setComment(""); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };
  const saveReport = async () => {
    try {
      await api.patch(`/faults/${id}/report`, reportForm);
      toast.success("Report updated");
      setEditReport(false); load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };
  const deleteFault = async () => {
    if (!window.confirm("Permanently delete this fault ticket? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await api.delete(`/faults/${id}`);
      toast.success("Fault deleted");
      nav("/faults");
    } catch (e) {
      toast.error(formatErr(e?.response?.data?.detail));
      setDeleting(false);
    }
  };

  if (!f) return <div className="text-muted-foreground text-sm">Loading…</div>;
  const canManage = canManageFaults(user);
  const canAssign = hasAnyRole(user, ROLES.ADMIN) || (user?.roles?.includes(ROLES.SERVICE) && user?.roles?.includes(ROLES.OPERATIONS_MANAGER));
  const canSelfAssignOnly = !canAssign && user?.roles?.includes(ROLES.SERVICE);
  const isReporter = f.reported_by_id === user.id;
  const reportLocked = !!f.severity;
  const canEditReport = (isReporter || hasAnyRole(user, ROLES.ADMIN)) && !reportLocked;
  const isAdmin = hasAnyRole(user, ROLES.ADMIN);
  const canViewFaultLogs = hasAnyRole(user, ROLES.SERVICE, ROLES.OPERATIONS_MANAGER, ROLES.ACCOUNT_MANAGER, ROLES.PROJECT_MANAGER);
  const canEditFaultLogs = hasAnyRole(user, ROLES.SERVICE);

  return (
    <div className="space-y-6" data-testid={`fault-details-${id}`}>
      <div className="flex items-center justify-between">
        <button onClick={() => nav(-1)} className="text-xs text-muted-foreground hover:text-prg-red inline-flex items-center gap-1"><ArrowLeft size={12} /> Back</button>
        {isAdmin && (
          <button onClick={deleteFault} disabled={deleting} data-testid="delete-fault"
            className="h-8 px-3 rounded-btn border border-red-800 text-red-400 hover:bg-red-500/10 text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2 disabled:opacity-60">
            <X size={12} /> {deleting ? "Deleting…" : "Delete Fault"}
          </button>
        )}
      </div>
      <div className="bg-card border border-border rounded-card p-6">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="font-mono text-xs text-muted-foreground">{f.equipment_barcode}</div>
            <h1 className="font-display font-black text-2xl">{f.fixture_type}</h1>
            <div className="text-sm text-muted-foreground mt-1">on {f.job_name || "no job"}</div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <StatusChip label={f.status} state={f.status === "Closed" ? "green" : "red"} />
            {f.severity && <StatusChip label={f.severity} state={f.severity === "Critical" ? "red" : f.severity === "High" ? "amber" : "grey"} />}
            {reportLocked && <span className="text-[10px] uppercase tracking-widest text-muted-foreground" data-testid="fault-report-locked">Report locked</span>}
          </div>
        </div>
   {editReport ? (
          <div className="space-y-3 border-t border-border pt-3 mt-3" data-testid="fault-report-edit-form">
            <label className="block">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Description</span>
              <textarea value={reportForm.description} onChange={(e) => setReportForm({...reportForm, description: e.target.value})} data-testid="fault-edit-description"
                className="mt-1 w-full h-24 px-3 py-2 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={reportForm.can_be_used} onChange={(e) => setReportForm({...reportForm, can_be_used: e.target.checked})} data-testid="fault-edit-can-be-used" />
              Equipment can still be used
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Additional comments</span>
              <textarea value={reportForm.additional_comments} onChange={(e) => setReportForm({...reportForm, additional_comments: e.target.value})} data-testid="fault-edit-comments"
                className="mt-1 w-full h-16 px-3 py-2 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
            </label>
            <div className="flex gap-2">
              <button onClick={saveReport} data-testid="fault-edit-save" className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2"><Check size={12} /> Save</button>
              <button onClick={() => setEditReport(false)} data-testid="fault-edit-cancel" className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="text-sm whitespace-pre-wrap">{f.description}</div>
            {f.additional_comments && <div className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">{f.additional_comments}</div>}
            <div className="text-xs text-muted-foreground mt-3">
              by {f.reported_by_name} · {new Date(f.created_at).toLocaleString()} · usable: {f.can_be_used ? "Yes" : "No"}
              {f.last_edited_at && <span> · last edited {new Date(f.last_edited_at).toLocaleString()}{f.last_edited_by ? ` by ${f.last_edited_by}` : ""}</span>}
            </div>
            {canEditReport && (
              <div className="mt-3">
                <button onClick={() => setEditReport(true)} data-testid="fault-edit-report" className="h-8 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
                  <PencilSimple size={12} /> Edit report
                </button>
                <span className="ml-2 text-[11px] text-muted-foreground">Locks once a severity is assigned.</span>
              </div>
            )}
          </>
        )}
      </div>

 {canManage && (
        <div className="bg-card border border-border rounded-card p-4 space-y-3">
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Service actions</div>
          <div className="grid md:grid-cols-3 gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Status</div>
              <select value={f.status} onChange={(e) => update({ status: e.target.value })} data-testid="fault-status-select" className="w-full h-9 px-3 rounded-btn bg-background border border-border text-sm">
                {STATUSES.map((s) => (
                  <option key={s} value={s} disabled={AUTO_ONLY_STATUSES.has(s) || (s === "Closed" && !canAssign)}>
                    {s}{AUTO_ONLY_STATUSES.has(s) ? " (auto)" : s === "Closed" && !canAssign ? " (needs Service + Ops)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Severity</div>
              <select value={f.severity || ""} onChange={(e) => update({ severity: e.target.value })} data-testid="fault-severity-select" className="w-full h-9 px-3 rounded-btn bg-background border border-border text-sm">
                <option value="">—</option>
                {SEVERITIES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            {canAssign && (
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Engineer</div>
                <EngineerPicker current={f.assigned_engineer_id} onChange={(uid) => update({ assigned_engineer_id: uid })} />
              </div>
            )}
            {canSelfAssignOnly && (
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Engineer</div>
                {f.assigned_engineer_id === user.id ? (
                  <div className="h-9 px-3 rounded-btn bg-background border border-border text-sm flex items-center text-emerald-400" data-testid="fault-assigned-to-me">
                    Assigned to you
                  </div>
                ) : f.assigned_engineer_id ? (
                  <div className="h-9 px-3 rounded-btn bg-background border border-border text-sm flex items-center text-muted-foreground" data-testid="fault-assigned-other">
                    Assigned to another engineer
                  </div>
                ) : (
                  <button onClick={() => update({ assigned_engineer_id: user.id })} data-testid="fault-assign-to-me"
                    className="w-full h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest">
                    Assign to me
                  </button>
                )}
              </div>
            )}
          </div>
          {f.status === "Closed" && <button onClick={() => update({ reopen: true })} data-testid="fault-reopen" className="h-8 px-3 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Reopen</button>}
        </div>
      )}

      <div className="bg-card border border-border rounded-card p-4">
        <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">Service comments</div>
        <div className="space-y-2 mb-3">
          {(f.comments || []).length === 0 && <div className="text-sm text-muted-foreground">No comments yet.</div>}
          {(f.comments || []).map((c, i) => (
            <div key={i} className="text-sm">
              <div className="text-xs text-muted-foreground">{c.created_by} · {new Date(c.date).toLocaleString()}</div>
              <div>{c.comment}</div>
            </div>
          ))}
        </div>
        {canManage && (
          <div className="flex gap-2">
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a service comment…" data-testid="fault-comment-input" className="flex-1 h-9 px-3 rounded-btn bg-background border border-border text-sm" />
            <button onClick={addComment} data-testid="fault-comment-submit" className="h-9 px-3 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">Post</button>
          </div>
        )}
      </div>

      {canViewFaultLogs && <FaultLogs faultId={id} canEdit={canEditFaultLogs} />}
    </div>
  );
}

function EngineerPicker({ current, onChange }) {
  const [users, setUsers] = useState([]);
  useEffect(() => { (async () => { try { const { data } = await api.get("/users"); setUsers(data.filter((u) => u.roles?.includes("Service Department"))); } catch { /* ignore */ } })(); }, []);
  return (
    <select value={current || ""} onChange={(e) => onChange(e.target.value)} data-testid="fault-engineer-select" className="w-full h-9 px-3 rounded-btn bg-background border border-border text-sm">
      <option value="">— unassigned —</option>
      {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
    </select>
  );
}

/* Internal-only — visible to Service Department / Operations Manager / Account
   Manager / Project Manager / Administrator. The backend enforces this
   independently via its own endpoints, so this isn't just a UI hide. */
function FaultLogs({ faultId, canEdit }) {
  const [timeLogs, setTimeLogs] = useState([]);
  const [parts, setParts] = useState([]);
  const [showTimeForm, setShowTimeForm] = useState(false);
  const [showPartForm, setShowPartForm] = useState(false);
  const [hours, setHours] = useState("");
  const [logDesc, setLogDesc] = useState("");
  const [logDate, setLogDate] = useState("");
  const [partName, setPartName] = useState("");
  const [qty, setQty] = useState(1);
  const [cost, setCost] = useState("");
  const [orderDate, setOrderDate] = useState("");
  const [partStatus, setPartStatus] = useState("Ordered");
  const [partNotes, setPartNotes] = useState("");

  const load = async () => {
    try {
      const [t, p] = await Promise.all([
        api.get(`/faults/${faultId}/time-logs`),
        api.get(`/faults/${faultId}/parts`),
      ]);
      setTimeLogs(t.data);
      setParts(p.data);
    } catch { /* ignore — 403 for ineligible roles is expected and silent */ }
  };
  useEffect(() => { load(); }, [faultId]);

  const totalHours = timeLogs.reduce((sum, l) => sum + Number(l.hours || 0), 0);
  const totalCost = parts.reduce((sum, p) => sum + (Number(p.cost) || 0) * (Number(p.quantity) || 0), 0);

  const addTimeLog = async () => {
    if (!hours || !logDesc.trim()) { toast.error("Hours and description are required"); return; }
    try {
      await api.post(`/faults/${faultId}/time-logs`, { hours: parseFloat(hours), description: logDesc.trim(), log_date: logDate || undefined });
      setHours(""); setLogDesc(""); setLogDate(""); setShowTimeForm(false);
      load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };
  const deleteTimeLog = async (logId) => {
    if (!window.confirm("Delete this time log entry?")) return;
    try { await api.delete(`/faults/${faultId}/time-logs/${logId}`); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  const addPart = async () => {
    if (!partName.trim()) { toast.error("Part name is required"); return; }
    try {
      await api.post(`/faults/${faultId}/parts`, {
        part_name: partName.trim(), quantity: parseInt(qty, 10) || 1,
        cost: cost ? parseFloat(cost) : null, order_date: orderDate || undefined,
        status: partStatus, notes: partNotes,
      });
      setPartName(""); setQty(1); setCost(""); setOrderDate(""); setPartStatus("Ordered"); setPartNotes(""); setShowPartForm(false);
      load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };
  const updatePartStatus = async (partId, status) => {
    try { await api.patch(`/faults/${faultId}/parts/${partId}`, { status }); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };
  const deletePart = async (partId) => {
    if (!window.confirm("Delete this part entry?")) return;
    try { await api.delete(`/faults/${faultId}/parts/${partId}`); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Time log <span className="text-muted-foreground/70 normal-case tracking-normal">(internal — {totalHours.toFixed(2)}h total)</span>
          </div>
          {canEdit && !showTimeForm && (
            <button onClick={() => setShowTimeForm(true)} data-testid="add-time-log-btn" className="text-xs text-prg-red inline-flex items-center gap-1"><Plus size={12} /> Add entry</button>
          )}
        </div>
        {showTimeForm && (
          <div className="space-y-2 mb-3 pb-3 border-b border-border">
            <div className="grid grid-cols-2 gap-2">
              <input type="number" min="0.25" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Hours" data-testid="time-log-hours" className="h-9 px-3 rounded-btn bg-background border border-border text-sm" />
              <input type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} data-testid="time-log-date" className="h-9 px-3 rounded-btn bg-background border border-border text-sm" />
            </div>
            <textarea value={logDesc} onChange={(e) => setLogDesc(e.target.value)} placeholder="What was done…" data-testid="time-log-description" className="w-full h-16 px-3 py-2 rounded-btn bg-background border border-border text-sm" />
            <div className="flex gap-2">
              <button onClick={addTimeLog} data-testid="time-log-save" className="h-8 px-3 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">Save</button>
              <button onClick={() => setShowTimeForm(false)} className="h-8 px-3 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
            </div>
          </div>
        )}
        <div className="space-y-2">
          {timeLogs.length === 0 && <div className="text-sm text-muted-foreground">No time logged yet.</div>}
          {timeLogs.map((l) => (
            <div key={l.id} className="flex items-start justify-between gap-2 text-sm" data-testid={`time-log-${l.id}`}>
              <div>
                <div><span className="font-semibold">{l.hours}h</span> · {l.user_name} · {formatDate(l.log_date)}</div>
                <div className="text-muted-foreground">{l.description}</div>
              </div>
              {canEdit && (
                <button onClick={() => deleteTimeLog(l.id)} data-testid={`time-log-delete-${l.id}`} className="p-1 text-muted-foreground hover:text-red-500 shrink-0">
                  <Trash size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="bg-card border border-border rounded-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Parts ordered <span className="text-muted-foreground/70 normal-case tracking-normal">(internal{totalCost > 0 ? ` — £${totalCost.toFixed(2)} total` : ""})</span>
          </div>
          {canEdit && !showPartForm && (
            <button onClick={() => setShowPartForm(true)} data-testid="add-part-btn" className="text-xs text-prg-red inline-flex items-center gap-1"><Plus size={12} /> Add part</button>
          )}
        </div>
        {showPartForm && (
          <div className="space-y-2 mb-3 pb-3 border-b border-border">
            <input value={partName} onChange={(e) => setPartName(e.target.value)} placeholder="Part name" data-testid="part-name" className="w-full h-9 px-3 rounded-btn bg-background border border-border text-sm" />
            <div className="grid grid-cols-3 gap-2">
              <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" data-testid="part-qty" className="h-9 px-2 rounded-btn bg-background border border-border text-sm" />
              <input type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Cost (£)" data-testid="part-cost" className="h-9 px-2 rounded-btn bg-background border border-border text-sm" />
              <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} data-testid="part-order-date" className="h-9 px-2 rounded-btn bg-background border border-border text-sm" />
            </div>
            <textarea value={partNotes} onChange={(e) => setPartNotes(e.target.value)} placeholder="Notes (optional)" data-testid="part-notes" className="w-full h-14 px-3 py-2 rounded-btn bg-background border border-border text-sm" />
            <div className="flex gap-2">
              <button onClick={addPart} data-testid="part-save" className="h-8 px-3 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">Save</button>
              <button onClick={() => setShowPartForm(false)} className="h-8 px-3 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
            </div>
          </div>
        )}
        <div className="space-y-2">
          {parts.length === 0 && <div className="text-sm text-muted-foreground">No parts ordered yet.</div>}
          {parts.map((p) => (
            <div key={p.id} className="flex items-start justify-between gap-2 text-sm" data-testid={`part-${p.id}`}>
              <div>
                <div className="font-semibold">
                  {p.part_name} <span className="text-muted-foreground font-normal">× {p.quantity}</span>
                  {p.cost != null && <span className="text-muted-foreground font-normal"> · £{Number(p.cost).toFixed(2)}</span>}
                </div>
                <div className="text-xs text-muted-foreground">Ordered {formatDate(p.order_date)} by {p.created_by_name}{p.notes ? ` — ${p.notes}` : ""}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {canEdit ? (
                  <select value={p.status} onChange={(e) => updatePartStatus(p.id, e.target.value)} data-testid={`part-status-${p.id}`} className="h-7 px-2 rounded-btn bg-background border border-border text-xs">
                    <option>Ordered</option>
                    <option>Received</option>
                    <option>Cancelled</option>
                  </select>
                ) : (
                  <StatusChip label={p.status} state={p.status === "Received" ? "green" : p.status === "Cancelled" ? "grey" : "amber"} />
                )}
                {canEdit && (
                  <button onClick={() => deletePart(p.id)} data-testid={`part-delete-${p.id}`} className="p-1 text-muted-foreground hover:text-red-500">
                    <Trash size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}