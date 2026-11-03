import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/date";
import { Bell, Check, Trash } from "@phosphor-icons/react";

export default function Notifications() {
  const [rows, setRows] = useState([]);
  const load = async () => { try { const { data } = await api.get("/notifications"); setRows(data); } catch { void 0; } };
  useEffect(() => { load(); }, []);
  const markRead = async (id) => { await api.post(`/notifications/${id}/read`); load(); };
  const readAll = async () => { await api.post("/notifications/read-all"); load(); };
  const del = async (id) => { try { await api.delete(`/notifications/${id}`); load(); } catch { void 0; } };

  return (
    <div className="space-y-4" data-testid="notifications-page">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Notifications</div>
          <h1 className="font-display font-black text-3xl">Notification center</h1>
        </div>
        <button onClick={readAll} data-testid="read-all-btn" className="h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
          <Check size={14} /> Mark all read
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="bg-card border border-border rounded-card p-8 text-center text-muted-foreground text-sm">
          <Bell size={22} className="mx-auto mb-2" />
          You&apos;re all caught up.
        </div>
      ) : (
        <div className="bg-card border border-border rounded-card divide-y divide-border overflow-hidden">
          {rows.map((n) => (
            <div key={n.id} data-testid={`notification-${n.id}`}
              className={`flex items-start gap-2 p-4 hover:bg-secondary transition-colors ${!n.read ? "bg-secondary/50" : ""}`}>
              <Link to={n.link || "#"} onClick={() => markRead(n.id)} className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <div className="font-semibold text-sm flex items-center gap-2">
                    {!n.read && <span className="w-2 h-2 rounded-full bg-prg-red shrink-0" />}
                    {n.title}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(n.created_at)}</div>
                </div>
                <div className="text-sm text-muted-foreground">{n.message}</div>
              </Link>
              <button onClick={() => del(n.id)} data-testid={`notification-delete-${n.id}`}
                className="p-1.5 rounded-btn text-muted-foreground hover:text-red-500 hover:bg-background transition-colors shrink-0" aria-label="Delete notification">
                <Trash size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}