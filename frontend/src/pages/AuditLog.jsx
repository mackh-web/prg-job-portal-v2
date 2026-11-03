import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function AuditLog() {
  const [rows, setRows] = useState([]);
  useEffect(() => { (async () => { try { const { data } = await api.get("/audit-log"); setRows(data); } catch { void 0; } })(); }, []);
  return (
    <div className="space-y-4" data-testid="audit-page">
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Compliance</div>
        <h1 className="font-display font-black text-3xl">Audit log</h1>
      </div>
      <div className="bg-card border border-border rounded-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary">
            <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="p-3">When</th><th className="p-3">User</th><th className="p-3">Action</th><th className="p-3">Related</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border" data-testid={`audit-row-${r.id}`}>
                <td className="p-3 whitespace-nowrap font-mono text-xs text-muted-foreground">{new Date(r.date).toLocaleString()}</td>
                <td className="p-3">{r.user_name}</td>
                <td className="p-3 font-mono text-xs">{r.action}</td>
                <td className="p-3 font-mono text-xs text-muted-foreground">{r.related}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No audit records visible for your role.</div>}
      </div>
    </div>
  );
}
