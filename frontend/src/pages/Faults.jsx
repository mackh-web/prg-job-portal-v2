import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { StatusChip } from "@/components/StatusChip";

export default function Faults() {
  const [rows, setRows] = useState([]);
  useEffect(() => { (async () => { const { data } = await api.get("/faults"); setRows(data); })(); }, []);
  return (
    <div className="space-y-4" data-testid="faults-page">
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Faults</div>
        <h1 className="font-display font-black text-3xl">All faults</h1>
      </div>
      {rows.length === 0 ? (
        <div className="bg-card border border-border rounded-card p-8 text-sm text-muted-foreground text-center">No faults.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((f) => (
            <Link key={f.id} to={`/faults/${f.id}`} data-testid={`fault-${f.id}`} className="block bg-card border border-border rounded-card p-4 hover:border-prg-red transition-colors">
              <div className="flex justify-between items-center mb-1">
                <div className="font-semibold">{f.fixture_type} <span className="font-mono text-xs text-muted-foreground ml-2">{f.equipment_barcode}</span></div>
                <div className="flex items-center gap-2">
                  {f.severity && <StatusChip label={f.severity} state={f.severity === "Critical" ? "red" : f.severity === "High" ? "amber" : "grey"} />}
                  <StatusChip label={f.status} state={f.status === "Closed" ? "green" : f.status === "Open" ? "red" : "amber"} />
                </div>
              </div>
              <div className="text-sm text-muted-foreground line-clamp-2">{f.description}</div>
              <div className="text-xs text-muted-foreground mt-2">by {f.reported_by_name} · {f.job_name || "No job"} · {new Date(f.created_at).toLocaleString()}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
