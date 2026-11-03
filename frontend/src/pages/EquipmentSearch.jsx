import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { Barcode, MagnifyingGlass } from "@phosphor-icons/react";

export default function EquipmentSearch() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try { const { data } = await api.get("/equipment/types", { params: { q } }); setRows(data); }
      catch { setRows([]); }
      finally { setLoading(false); }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="space-y-6" data-testid="equipment-search-page">
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Equipment Identification</div>
        <h1 className="font-display font-black text-3xl">Search the Equipment Inventory</h1>
        <p className="text-muted-foreground text-sm mt-2">All equipment types are listed below by default — search by barcode or fixture type to filter it down. Data sourced from the WinHits export.</p>
      </div>

      <div className="relative">
        <MagnifyingGlass className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} data-testid="equipment-search-input"
          placeholder="e.g. PRG-100015 or MegaPointe"
          className="w-full h-12 pl-11 pr-4 rounded-input bg-secondary border border-border text-base font-mono focus:outline-none focus:border-prg-red focus:ring-1 focus:ring-prg-red" />
      </div>

      {!loading && (
        <div className="text-xs text-muted-foreground">{rows.length} type{rows.length === 1 ? "" : "s"}{q.trim() && " matching your search"}</div>
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <button key={r.fixture_type} onClick={() => nav(`/equipment/type/${encodeURIComponent(r.fixture_type)}`)} data-testid={`equipment-type-${r.fixture_type.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
            className="text-left bg-card border border-border rounded-card p-4 hover:border-prg-red transition-colors">
            <div className="flex items-center gap-2 mb-1">
              <Barcode size={18} className="text-prg-red" />
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{r.unit_count} unit{r.unit_count === 1 ? "" : "s"}</div>
            </div>
            <div className="font-semibold">{r.fixture_type}</div>
          </button>
        ))}
        {!loading && rows.length === 0 && <div className="text-sm text-muted-foreground">No results.</div>}
      </div>
    </div>
  );
}