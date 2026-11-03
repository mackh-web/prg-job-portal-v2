import { useEffect, useState } from "react";
import { api, formatErr } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { hasAnyRole, ROLES } from "@/lib/permissions";
import { formatDateTime } from "@/lib/date";
import JobCard from "@/components/JobCard";
import { StatusChip } from "@/components/StatusChip";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Barcode, ArrowRight, Bell, ClipboardText, TrendUp, ArrowsClockwise, Plus, Trash, LinkSimple,
} from "@phosphor-icons/react";

const DASHBOARD_VIEW_KEY = "prg_dashboard_view";

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [switching, setSwitching] = useState(false);

  const load = async (view) => {
    setSwitching(true);
    try {
      const { data } = await api.get("/dashboard", view ? { params: { view } } : undefined);
      setData(data);
      // Only persist a real switch away from the default, and only once we know
      // the user is actually eligible to switch (dual-role) — otherwise a
      // stale value could get set from a user who briefly held both roles.
      if (data.can_switch_view) {
        try { localStorage.setItem(DASHBOARD_VIEW_KEY, data.view); } catch { /* ignore */ }
      }
    } catch { void 0; }
    finally { setSwitching(false); }
  };

  useEffect(() => {
    let remembered = null;
    try { remembered = localStorage.getItem(DASHBOARD_VIEW_KEY); } catch { /* ignore */ }
    load(remembered || undefined);
  }, []);

  if (!data) return <div className="text-muted-foreground text-sm">Loading dashboard…</div>;

  return data.view === "service"
    ? <ServiceDashboard data={data} user={user} switching={switching} onSwitchView={(v) => load(v)} onRefresh={() => load(data.view)} />
    : <StandardDashboard data={data} user={user} switching={switching} onSwitchView={(v) => load(v)} />;
}

/* ---------------- Standard dashboard (unchanged, plus a switch-view toggle) ---------------- */
function StandardDashboard({ data, user, switching, onSwitchView }) {
  const { current_or_next_job, upcoming_jobs, alerts, extras, can_switch_view } = data;

  return (
    <div className="space-y-8" data-testid="dashboard">
      {/* Profile summary */}
      <section className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">Welcome back</div>
          <h1 className="font-display font-black text-3xl md:text-4xl leading-tight" data-testid="dashboard-greeting">{user.name}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {user.roles?.map((r) => (
              <span key={r} data-testid={`role-chip-${r.replace(/\s+/g, "-").toLowerCase()}`}
                className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border border-prg-red text-prg-red">
                {r}
              </span>
            ))}
            {user.department && <span className="text-xs text-muted-foreground">· {user.department}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can_switch_view && (
            <button onClick={() => onSwitchView("service")} disabled={switching} data-testid="switch-to-service-dashboard"
              className="inline-flex items-center gap-2 h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-sm font-semibold transition-colors disabled:opacity-60">
              <ArrowsClockwise size={14} /> {switching ? "Switching…" : "View Service Dashboard"}
            </button>
          )}
          <Link to="/equipment" data-testid="qa-equipment" className="inline-flex items-center gap-2 h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-sm font-semibold transition-colors">
            <Barcode size={14} /> Identify equipment
          </Link>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Current / next job */}
        <div className="lg:col-span-2 space-y-6">
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Current / next job</div>
              <Link to="/jobs" className="text-xs text-muted-foreground hover:text-prg-red inline-flex items-center gap-1">See all <ArrowRight size={12} /></Link>
            </div>
            {current_or_next_job ? (
              <JobCard job={current_or_next_job} testId="dashboard-current-job" />
            ) : (
              <div className="bg-card border border-border rounded-card p-8 text-center text-muted-foreground text-sm" data-testid="dashboard-no-jobs">
                No assigned jobs at the moment.
              </div>
            )}
          </section>

          {hasAnyRole(user, ROLES.SERVICE) && (
            <section>
              <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">Open faults</div>
              <div className="space-y-2">
                {(data.extras?.open_faults || []).slice(0, 8).map((f) => (
                  <Link key={f.id} to={`/faults/${f.id}`} className="flex items-center justify-between gap-3 bg-card border border-border rounded-card p-3 hover:border-prg-red transition-colors" data-testid={`open-fault-${f.id}`}>
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{f.fixture_type}</div>
                      <div className="text-xs text-muted-foreground font-mono">{f.equipment_barcode} · {f.job_name || "No job"}</div>
                    </div>
                    <StatusChip label={f.status} state={f.status === "Closed" ? "green" : "red"} />
                  </Link>
                ))}
                {!data.extras?.open_faults?.length && <div className="text-muted-foreground text-sm">No open faults.</div>}
              </div>
            </section>
          )}

          {upcoming_jobs?.length > 0 && (
            <section>
              <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">Upcoming</div>
              <div className="grid gap-3 sm:grid-cols-2">
                {upcoming_jobs.slice(0, 6).map((j) => <JobCard key={j.id} job={j} testId={`upcoming-job-${j.id}`} />)}
              </div>
            </section>
          )}
        </div>

        {/* Alerts */}
        <aside className="space-y-4">
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Important alerts</div>
          <div className="bg-card border border-border rounded-card divide-y divide-border overflow-hidden" data-testid="dashboard-alerts">
            {alerts?.length ? alerts.slice(0, 12).map((a) => (
              <Link key={a.id} to={a.link || "/notifications"} className="block p-3 hover:bg-secondary transition-colors">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="font-semibold text-sm truncate">{a.title}</div>
                  <div className="w-2 h-2 rounded-full bg-prg-red" />
                </div>
                <div className="text-xs text-muted-foreground line-clamp-2">{a.message}</div>
              </Link>
            )) : (
              <div className="p-6 text-sm text-muted-foreground text-center">
                <Bell size={20} className="mx-auto mb-2" />
                No alerts right now.
              </div>
            )}
          </div>

          {hasAnyRole(user, ROLES.ADMIN) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-card border border-border rounded-card p-4">
                <TrendUp size={16} className="text-prg-red mb-2" />
                <div className="text-3xl font-display font-black">{data.extras?.user_count ?? 0}</div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Total users</div>
              </div>
              <div className="bg-card border border-border rounded-card p-4">
                <ClipboardText size={16} className="text-prg-red mb-2" />
                <div className="text-3xl font-display font-black">{data.extras?.active_jobs ?? 0}</div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Active jobs</div>
              </div>
            </div>
          )}

          {hasAnyRole(user, ROLES.PROJECT_MANAGER) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-card border border-border rounded-card p-4">
                <div className="text-3xl font-display font-black text-amber-400">{data.extras?.pending_prep_adds ?? 0}</div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Prep Adds pending</div>
              </div>
              <div className="bg-card border border-border rounded-card p-4">
                <div className="text-3xl font-display font-black text-amber-400">{data.extras?.pending_ideal_prep ?? 0}</div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Ideal Prep pending</div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ---------------- Service Department dashboard ---------------- */
function ServiceDashboard({ data, user, switching, onSwitchView, onRefresh }) {
  const { my_repairs, fault_reports, alerts, quick_links, can_edit_quick_links, can_switch_view } = data;

  return (
    <div className="space-y-8" data-testid="service-dashboard">
      <section className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">Welcome back</div>
          <h1 className="font-display font-black text-3xl md:text-4xl leading-tight" data-testid="dashboard-greeting">{user.name}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {user.roles?.map((r) => (
              <span key={r} className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border border-prg-red text-prg-red">{r}</span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can_switch_view && (
            <button onClick={() => onSwitchView("standard")} disabled={switching} data-testid="switch-to-standard-dashboard"
              className="inline-flex items-center gap-2 h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-sm font-semibold transition-colors disabled:opacity-60">
              <ArrowsClockwise size={14} /> {switching ? "Switching…" : "View My Dashboard"}
            </button>
          )}
          <Link to="/equipment" data-testid="qa-equipment" className="inline-flex items-center gap-2 h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-sm font-semibold transition-colors">
            <Barcode size={14} /> Identify equipment
          </Link>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">My ongoing repairs</div>
              <Link to="/faults" className="text-xs text-muted-foreground hover:text-prg-red inline-flex items-center gap-1">See all <ArrowRight size={12} /></Link>
            </div>
            <div className="space-y-2">
              {(my_repairs || []).length === 0 && (
                <div className="bg-card border border-border rounded-card p-8 text-center text-muted-foreground text-sm" data-testid="no-repairs">
                  No repairs currently assigned to you.
                </div>
              )}
              {(my_repairs || []).map((f) => (
                <Link key={f.id} to={`/faults/${f.id}`} className="flex items-center justify-between gap-3 bg-card border border-border rounded-card p-4 hover:border-prg-red transition-colors" data-testid={`my-repair-${f.id}`}>
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{f.fixture_type} <span className="font-mono text-xs text-muted-foreground ml-2">{f.equipment_barcode}</span></div>
                    <div className="text-xs text-muted-foreground line-clamp-1">{f.description}</div>
                    <div className="text-xs text-muted-foreground mt-1">{f.job_name || "No job"} · {formatDateTime(f.created_at)}</div>
                  </div>
                  <StatusChip label={f.status} state="red" />
                </Link>
              ))}
            </div>
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">High Priority New fault reports</div>
            <div className="grid gap-3 sm:grid-cols-2">
              {(fault_reports || []).slice(0, 8).map((f) => (
                <Link key={f.id} to={`/faults/${f.id}`} className="bg-card border border-border rounded-card p-4 hover:border-prg-red transition-colors" data-testid={`fault-report-${f.id}`}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="font-semibold truncate">{f.fixture_type}</div>
                    <StatusChip label={f.status} state={f.status === "Closed" ? "green" : "red"} />
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">{f.equipment_barcode} · {f.job_name || "No job"}</div>
                  <div className="text-xs text-muted-foreground mt-1">by {f.reported_by_name} · {formatDateTime(f.created_at)}</div>
                </Link>
              ))}
              {!fault_reports?.length && <div className="text-muted-foreground text-sm">No open fault reports.</div>}
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Important alerts</div>
          <div className="bg-card border border-border rounded-card divide-y divide-border overflow-hidden" data-testid="dashboard-alerts">
            {alerts?.length ? alerts.slice(0, 12).map((a) => (
              <Link key={a.id} to={a.link || "/notifications"} className="block p-3 hover:bg-secondary transition-colors">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="font-semibold text-sm truncate">{a.title}</div>
                  <div className="w-2 h-2 rounded-full bg-prg-red" />
                </div>
                <div className="text-xs text-muted-foreground line-clamp-2">{a.message}</div>
              </Link>
            )) : (
              <div className="p-6 text-sm text-muted-foreground text-center">
                <Bell size={20} className="mx-auto mb-2" />
                No alerts right now.
              </div>
            )}
          </div>

          <QuickLinks links={quick_links || []} canEdit={can_edit_quick_links} onChanged={onRefresh} />
        </aside>
      </div>
    </div>
  );
}

function QuickLinks({ links, canEdit, onChanged }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (!label.trim() || !url.trim()) { toast.error("Label and URL are required"); return; }
    setSaving(true);
    try {
      await api.post("/quick-links", { label: label.trim(), url: url.trim() });
      toast.success("Quick link added");
      setLabel(""); setUrl(""); setAdding(false);
      onChanged();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
    finally { setSaving(false); }
  };

  const remove = async (id) => {
    if (!window.confirm("Remove this quick link?")) return;
    try { await api.delete(`/quick-links/${id}`); onChanged(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  return (
    <div className="bg-card border border-border rounded-card p-4">
      <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3 flex items-center gap-1.5"><LinkSimple size={12} /> Quick links</div>
      <div className="space-y-1.5">
        {links.map((l) => (
          <div key={l.id} className="flex items-center justify-between gap-2 group">
            <a href={l.url} target="_blank" rel="noopener noreferrer" data-testid={`quick-link-${l.id}`}
              className="text-sm font-semibold hover:text-prg-red truncate flex-1">
              {l.label}
            </a>
            {canEdit && (
              <button onClick={() => remove(l.id)} data-testid={`quick-link-remove-${l.id}`} className="p-1 text-muted-foreground hover:text-red-500 shrink-0">
                <Trash size={13} />
              </button>
            )}
          </div>
        ))}
        {links.length === 0 && <div className="text-sm text-muted-foreground">No quick links yet.</div>}
      </div>
      {canEdit && (
        adding ? (
          <div className="mt-3 pt-3 border-t border-border space-y-2">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" data-testid="quick-link-label"
              className="w-full h-8 px-2 rounded-btn bg-background border border-border text-sm" />
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" data-testid="quick-link-url"
              className="w-full h-8 px-2 rounded-btn bg-background border border-border text-sm" />
            <div className="flex gap-2">
              <button onClick={add} disabled={saving} data-testid="quick-link-save"
                className="h-8 px-3 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest disabled:opacity-60">
                {saving ? "Saving…" : "Add"}
              </button>
              <button onClick={() => { setAdding(false); setLabel(""); setUrl(""); }} className="h-8 px-3 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} data-testid="quick-link-add-btn"
            className="mt-3 pt-3 border-t border-border w-full text-xs text-prg-red inline-flex items-center gap-1">
            <Plus size={12} /> Add quick link
          </button>
        )
      )}
    </div>
  );
}