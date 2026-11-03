import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, formatErr } from "@/lib/api";
import { formatDateTime } from "@/lib/date";
import { useAuth } from "@/context/AuthContext";
import { hasAnyRole, ROLES } from "@/lib/permissions";
import { StatusChip } from "@/components/StatusChip";
import { Barcode, ArrowLeft, PencilSimple, Scales, Ruler } from "@phosphor-icons/react";
import { toast } from "sonner";

export default function EquipmentDetails() {
  const { fixtureType } = useParams();
  const decodedType = decodeURIComponent(fixtureType);
  const nav = useNavigate();
  const { user } = useAuth();
  const canEdit = hasAnyRole(user, ROLES.ADMIN);
  const [data, setData] = useState(null);
  const [editSpecs, setEditSpecs] = useState(false);
  const [specsForm, setSpecsForm] = useState({ weight_kg: "", width_cm: "", height_cm: "", depth_cm: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get("/equipment/by-type", { params: { fixture_type: decodedType } });
      setData(data);
      setSpecsForm({
        weight_kg: data.specs?.weight_kg ?? "",
        width_cm: data.specs?.width_cm ?? "",
        height_cm: data.specs?.height_cm ?? "",
        depth_cm: data.specs?.depth_cm ?? "",
      });
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };
  useEffect(() => { setData(null); load(); }, [decodedType]);

  const saveSpecs = async () => {
    setSaving(true);
    try {
      const num = (v) => (v === "" || v === null ? null : parseFloat(v));
      await api.patch("/equipment/specs", {
        weight_kg: num(specsForm.weight_kg), width_cm: num(specsForm.width_cm),
        height_cm: num(specsForm.height_cm), depth_cm: num(specsForm.depth_cm),
      }, { params: { fixture_type: decodedType } });
      toast.success("Specs updated");
      setEditSpecs(false);
      load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
    finally { setSaving(false); }
  };

  if (!data) return <div className="text-muted-foreground text-sm">Loading…</div>;
  const { units, faults, specs } = data;
  const openFaultBarcodes = new Set(faults.filter((f) => f.status !== "Closed").map((f) => f.equipment_barcode));
  const hasSpecs = specs && (specs.weight_kg != null || specs.width_cm != null || specs.height_cm != null || specs.depth_cm != null);
  const dims = specs && [specs.width_cm, specs.height_cm, specs.depth_cm].every((v) => v != null)
    ? `${specs.width_cm} × ${specs.height_cm} × ${specs.depth_cm} cm (W×H×D)`
    : null;

  return (
    <div className="space-y-6" data-testid={`equipment-details-${fixtureType}`}>
      <button onClick={() => nav(-1)} className="text-xs text-muted-foreground hover:text-prg-red inline-flex items-center gap-1"><ArrowLeft size={12} /> Back</button>
      <div className="bg-card border border-border rounded-card p-6 flex items-start gap-4">
        <div className="w-14 h-14 rounded-btn bg-prg-red/10 flex items-center justify-center shrink-0"><Barcode size={28} className="text-prg-red" /></div>
        <div className="flex-1 min-w-0">
          <h1 className="font-display font-black text-2xl">{decodedType}</h1>
          <div className="text-xs text-muted-foreground mt-1">{units.length} unit{units.length === 1 ? "" : "s"}</div>
          {!editSpecs && (hasSpecs ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm">
              {specs.weight_kg != null && <span className="inline-flex items-center gap-1.5"><Scales size={14} className="text-muted-foreground" /> {specs.weight_kg} kg</span>}
              {dims && <span className="inline-flex items-center gap-1.5"><Ruler size={14} className="text-muted-foreground" /> {dims}</span>}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground mt-2">No weight/dimension data yet.</div>
          ))}
        </div>
        {canEdit && !editSpecs && (
          <button onClick={() => setEditSpecs(true)} data-testid="edit-specs-btn" className="text-xs text-muted-foreground hover:text-prg-red inline-flex items-center gap-1 shrink-0">
            <PencilSimple size={12} /> Edit
          </button>
        )}
      </div>

      {editSpecs && (
        <div className="bg-card border border-border rounded-card p-4 space-y-3">
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Weight &amp; dimensions</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <label className="block">
              <span className="text-[9px] uppercase tracking-widest text-muted-foreground">Weight (kg)</span>
              <input type="number" min="0" step="0.1" value={specsForm.weight_kg} onChange={(e) => setSpecsForm({...specsForm, weight_kg: e.target.value})} data-testid="specs-weight" className="w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
            </label>
            <label className="block">
              <span className="text-[9px] uppercase tracking-widest text-muted-foreground">Width (cm)</span>
              <input type="number" min="0" step="0.1" value={specsForm.width_cm} onChange={(e) => setSpecsForm({...specsForm, width_cm: e.target.value})} data-testid="specs-width" className="w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
            </label>
            <label className="block">
              <span className="text-[9px] uppercase tracking-widest text-muted-foreground">Height (cm)</span>
              <input type="number" min="0" step="0.1" value={specsForm.height_cm} onChange={(e) => setSpecsForm({...specsForm, height_cm: e.target.value})} data-testid="specs-height" className="w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
            </label>
            <label className="block">
              <span className="text-[9px] uppercase tracking-widest text-muted-foreground">Depth (cm)</span>
              <input type="number" min="0" step="0.1" value={specsForm.depth_cm} onChange={(e) => setSpecsForm({...specsForm, depth_cm: e.target.value})} data-testid="specs-depth" className="w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={saveSpecs} disabled={saving} data-testid="specs-save" className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest disabled:opacity-60">{saving ? "Saving…" : "Save"}</button>
            <button onClick={() => setEditSpecs(false)} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
          </div>
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">Barcodes</div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {units.map((u) => (
            <div key={u.id} data-testid={`equipment-unit-${u.barcode}`}
              className={`flex items-center justify-between gap-2 bg-card border rounded-card p-3 ${openFaultBarcodes.has(u.barcode) ? "border-red-800" : "border-border"}`}>
              <span className="font-mono text-xs">{u.barcode}</span>
              {openFaultBarcodes.has(u.barcode) && <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" title="Has an open fault" />}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">Fault history</div>
        <p className="text-xs text-muted-foreground mb-3">Faults are reported from the relevant job's Faults tab, not from here.</p>
        {faults.length === 0 ? <div className="text-sm text-muted-foreground">No faults recorded.</div> : (
          <div className="space-y-2">
            {faults.map((f) => (
              <Link key={f.id} to={`/faults/${f.id}`} className="block bg-card border border-border rounded-card p-4 hover:border-prg-red transition-colors">
                <div className="flex justify-between items-center mb-1">
                  <div className="font-semibold text-sm">{f.job_name || "No job"} <span className="font-mono text-xs text-muted-foreground ml-2">{f.equipment_barcode}</span></div>
                  <StatusChip label={f.status} state={f.status === "Closed" ? "green" : "red"} />
                </div>
                <div className="text-sm text-muted-foreground line-clamp-2">{f.description}</div>
                <div className="text-xs text-muted-foreground mt-1">by {f.reported_by_name} · {formatDateTime(f.created_at)}</div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}