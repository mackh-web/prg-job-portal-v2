import { useEffect, useRef, useState } from "react";
import { api, formatErr } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { hasAnyRole, ROLES } from "@/lib/permissions";
import { WifiHigh, Phone, MapPin, Plus, Trash, PencilSimple, DotsSixVertical, Image as ImageIcon, Copy } from "@phosphor-icons/react";
import { toast } from "sonner";

const MIN_ZONE_SIZE = 30;
const MIN_CANVAS_SIZE = 300;
const MARGIN = { left: 20, top: 40, right: 20, bottom: 10 };

function LongbridgeMap({ zones, mapSize, backgroundUrl, selected, setSelected, editable, onZoneChange, onCanvasResize }) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const { width, height } = mapSize;

  const toSvgDelta = (dxPx, dyPx) => {
    const rect = svgRef.current.getBoundingClientRect();
    return { dx: (dxPx / rect.width) * width, dy: (dyPx / rect.height) * height };
  };

  const startZoneDrag = (e, zone, mode) => {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    e.target.setPointerCapture(e.pointerId);
    dragRef.current = {
      id: zone.id, mode, pointerId: e.pointerId,
      startClientX: e.clientX, startClientY: e.clientY,
      orig: { x: zone.x, y: zone.y, w: zone.w, h: zone.h },
    };
    setSelected(zone);
  };

  const startCanvasResize = (e) => {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    e.target.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "canvas", pointerId: e.pointerId,
      startClientX: e.clientX, startClientY: e.clientY,
      orig: { w: width, h: height },
    };
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const { dx, dy } = toSvgDelta(e.clientX - drag.startClientX, e.clientY - drag.startClientY);
    if (drag.mode === "move") {
      onZoneChange(drag.id, { x: Math.max(0, Math.round(drag.orig.x + dx)), y: Math.max(0, Math.round(drag.orig.y + dy)) });
    } else if (drag.mode === "resize") {
      onZoneChange(drag.id, { w: Math.max(MIN_ZONE_SIZE, Math.round(drag.orig.w + dx)), h: Math.max(MIN_ZONE_SIZE, Math.round(drag.orig.h + dy)) });
    } else if (drag.mode === "canvas") {
      onCanvasResize(Math.max(MIN_CANVAS_SIZE, Math.round(drag.orig.w + dx)), Math.max(MIN_CANVAS_SIZE, Math.round(drag.orig.h + dy)));
    }
  };

  const onPointerUp = (e) => {
    if (dragRef.current && dragRef.current.pointerId === e.pointerId) dragRef.current = null;
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-auto bg-background border border-border rounded-card"
      role="img"
      aria-label="Longbridge facility map"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <defs>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0 L0 0 0 20" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1"/>
        </pattern>
        <clipPath id="map-canvas-clip">
          <rect x={MARGIN.left} y={MARGIN.top} width={width - MARGIN.left - MARGIN.right} height={height - MARGIN.top - MARGIN.bottom} rx="12" />
        </clipPath>
      </defs>
      {backgroundUrl ? (
        <image
          href={backgroundUrl}
          x={MARGIN.left} y={MARGIN.top}
          width={width - MARGIN.left - MARGIN.right} height={height - MARGIN.top - MARGIN.bottom}
          preserveAspectRatio="xMidYMid slice"
          clipPath="url(#map-canvas-clip)"
        />
      ) : (
        <rect x={MARGIN.left} y={MARGIN.top} width={width - MARGIN.left - MARGIN.right} height={height - MARGIN.top - MARGIN.bottom} rx="12" fill="url(#grid)" />
      )}
      <rect x={MARGIN.left} y={MARGIN.top} width={width - MARGIN.left - MARGIN.right} height={height - MARGIN.top - MARGIN.bottom} rx="12" fill="none" stroke="#000" strokeWidth="2"/>
      <text x="30" y="30" fill="currentColor" fontFamily="Chivo" fontSize="12" fontWeight="900" letterSpacing="2">PRG UK · LONGBRIDGE</text>
      {zones.map((z) => (
        <g key={z.id} data-testid={`map-zone-${z.id}`}>
          <rect
            x={z.x} y={z.y} width={z.w} height={z.h} rx="8"
            fill={z.color} fillOpacity={selected?.id === z.id ? 0.9 : (backgroundUrl ? 0.65 : 0.55)}
            stroke="#000" strokeWidth="1.5"
            style={{ cursor: editable ? "grab" : "pointer" }}
            onPointerDown={(e) => (editable ? startZoneDrag(e, z, "move") : null)}
            onClick={() => !editable && setSelected(z)}
          />
          <text
            x={z.x + z.w / 2} y={z.y + z.h / 2 + 4} textAnchor="middle" fill="white"
            fontFamily="IBM Plex Sans" fontSize="10" fontWeight="700"
            style={{ pointerEvents: "none", userSelect: "none" }}
          >
            {z.label}
          </text>
          {editable && (
            <rect
              data-testid={`map-zone-resize-${z.id}`}
              x={z.x + z.w - 9} y={z.y + z.h - 9} width={14} height={14} rx="3"
              fill="white" stroke="#000" strokeWidth="1"
              style={{ cursor: "nwse-resize" }}
              onPointerDown={(e) => startZoneDrag(e, z, "resize")}
            />
          )}
        </g>
      ))}
      {editable && (
        <g data-testid="map-canvas-resize" onPointerDown={startCanvasResize} style={{ cursor: "nwse-resize" }}>
          <rect x={width - 26} y={height - 26} width={22} height={22} rx="4" fill="#D11047" stroke="#000" strokeWidth="1.5" />
          <line x1={width - 19} y1={height - 8} x2={width - 8} y2={height - 19} stroke="white" strokeWidth="2" strokeLinecap="round" />
          <line x1={width - 14} y1={height - 8} x2={width - 8} y2={height - 14} stroke="white" strokeWidth="2" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}

function newZone() {
  return {
    id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `zone-${Date.now()}`,
    label: "New Section",
    x: 40, y: 60, w: 120, h: 80, color: "#D11047",
    notes: "",
  };
}

function MapEditor({ zones, setZones }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [openNotes, setOpenNotes] = useState({});

  const update = (id, patch) => setZones(zones.map((z) => (z.id === id ? { ...z, ...patch } : z)));
  const remove = (id) => setZones(zones.filter((z) => z.id !== id));
  const add = () => setZones([...zones, newZone()]);
  const toggleNotes = (id) => setOpenNotes((o) => ({ ...o, [id]: !o[id] }));

  const duplicate = (id) => {
    const original = zones.find((z) => z.id === id);
    if (!original) return;
    const copy = {
      ...original,
      id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `zone-${Date.now()}`,
      label: `${original.label} copy`,
      x: original.x + 20,
      y: original.y + 20,
    };
    const idx = zones.findIndex((z) => z.id === id);
    setZones([...zones.slice(0, idx + 1), copy, ...zones.slice(idx + 1)]);
  };

  const reorder = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    const next = [...zones];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    setZones(next);
  };

  return (
    <div className="space-y-2">
      {zones.map((z, idx) => (
        <div
          key={z.id}
          draggable
          onDragStart={(e) => { setDragIndex(idx); e.dataTransfer.effectAllowed = "move"; }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) reorder(dragIndex, idx); setDragIndex(null); }}
          onDragEnd={() => setDragIndex(null)}
          data-testid={`map-editor-row-${z.id}`}
          className={`bg-background border border-border rounded-input transition-opacity ${dragIndex === idx ? "opacity-40" : ""}`}
        >
          <div className="flex items-center gap-2 p-2">
            <span className="cursor-grab text-muted-foreground shrink-0 touch-none" data-testid={`map-zone-drag-${z.id}`} aria-label="Drag to reorder">
              <DotsSixVertical size={16} weight="bold" />
            </span>
            <input
              value={z.label}
              onChange={(e) => update(z.id, { label: e.target.value })}
              placeholder="Section name"
              data-testid={`map-zone-label-${z.id}`}
              className="flex-1 h-8 px-2 rounded-btn bg-card border border-border text-sm"
            />
            <input
              type="color"
              value={z.color}
              onChange={(e) => update(z.id, { color: e.target.value })}
              data-testid={`map-zone-color-${z.id}`}
              className="w-8 h-8 rounded-btn border border-border bg-card cursor-pointer shrink-0"
              aria-label="Section colour"
            />
            <button onClick={() => toggleNotes(z.id)} data-testid={`map-zone-notes-toggle-${z.id}`}
              className={`text-[10px] font-bold uppercase tracking-widest px-2 py-1.5 rounded-btn shrink-0 ${z.notes ? "text-prg-red" : "text-muted-foreground"} hover:bg-secondary`}>
              Notes
            </button>
            <button onClick={() => duplicate(z.id)} data-testid={`map-zone-duplicate-${z.id}`}
              className="p-1.5 rounded-btn text-muted-foreground hover:text-prg-red hover:bg-secondary shrink-0" aria-label="Duplicate section">
              <Copy size={14} />
            </button>
            <button onClick={() => remove(z.id)} data-testid={`map-zone-remove-${z.id}`}
              className="p-1.5 rounded-btn text-muted-foreground hover:text-red-500 hover:bg-secondary shrink-0" aria-label="Remove section">
              <Trash size={14} />
            </button>
          </div>
          {openNotes[z.id] && (
            <div className="px-2 pb-2">
              <textarea
                value={z.notes || ""}
                onChange={(e) => update(z.id, { notes: e.target.value })}
                placeholder="Notes visible to all users when they tap this section on the map…"
                data-testid={`map-zone-notes-${z.id}`}
                className="w-full h-16 px-2 py-1.5 rounded-btn bg-card border border-border text-sm"
              />
            </div>
          )}
        </div>
      ))}
      <button onClick={add} data-testid="map-zone-add"
        className="h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
        <Plus size={14} /> Add section
      </button>
    </div>
  );
}

export default function BuildingInfo() {
  const { user } = useAuth();
  const canEdit = hasAnyRole(user, ROLES.ADMIN);
  const [info, setInfo] = useState(null);
  const [selected, setSelected] = useState(null);
  const [wifi, setWifi] = useState({ ssid: "", password: "", instructions: "" });
  const [wifiEdit, setWifiEdit] = useState(false);
  const [newContact, setNewContact] = useState({ label: "", name: "", phone: "", email: "" });
  const [mapEdit, setMapEdit] = useState(false);
  const [editZones, setEditZones] = useState([]);
  const [editMapSize, setEditMapSize] = useState({ width: 700, height: 340 });
  const [savingMap, setSavingMap] = useState(false);
  const [uploadingBg, setUploadingBg] = useState(false);
  const fileInputRef = useRef(null);

  const load = async () => {
    const { data } = await api.get("/building-info");
    setInfo(data);
    setWifi(data.wifi || { ssid: "", password: "", instructions: "" });
  };
  useEffect(() => { load(); }, []);

  const saveWifi = async () => { try { await api.patch("/building-info/wifi", wifi); toast.success("Wi-Fi updated"); setWifiEdit(false); load(); } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); } };
  const addContact = async () => { try { await api.post("/building-info/contacts", newContact); setNewContact({ label: "", name: "", phone: "", email: "" }); load(); } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); } };
  const delContact = async (id) => { try { await api.delete(`/building-info/contacts/${id}`); load(); } catch { void 0; } };

  const startMapEdit = () => {
    setEditZones((info?.map_zones || []).map((z) => ({ ...z })));
    setEditMapSize({ width: info?.map_width || 700, height: info?.map_height || 340 });
    setMapEdit(true);
  };
  const cancelMapEdit = () => { setMapEdit(false); setEditZones([]); setSelected(null); };
  const patchZone = (id, patch) => setEditZones((zs) => zs.map((z) => (z.id === id ? { ...z, ...patch } : z)));
  const saveMapEdit = async () => {
    if (editZones.some((z) => !z.label.trim())) {
      toast.error("Every section needs a name.");
      return;
    }
    setSavingMap(true);
    try {
      await api.patch("/building-info/map-zones", {
        zones: editZones,
        map_width: editMapSize.width,
        map_height: editMapSize.height,
      });
      toast.success("Map updated");
      setMapEdit(false);
      load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
    finally { setSavingMap(false); }
  };

  const uploadBackground = async (file) => {
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    setUploadingBg(true);
    try {
      await api.post("/building-info/map-background", formData, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success("Background image updated");
      load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
    finally { setUploadingBg(false); if (fileInputRef.current) fileInputRef.current.value = ""; }
  };
  const removeBackground = async () => {
    if (!window.confirm("Remove the background image?")) return;
    try { await api.delete("/building-info/map-background"); toast.success("Background removed"); load(); }
    catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  if (!info) return <div className="text-muted-foreground text-sm">Loading…</div>;

  const displayZones = mapEdit ? editZones : (info.map_zones || []);
  const displaySize = mapEdit ? editMapSize : { width: info.map_width || 700, height: info.map_height || 340 };

  return (
    <div className="space-y-6" data-testid="building-info">
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Building</div>
        <h1 className="font-display font-black text-3xl">Longbridge facility</h1>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Facility map</div>
            {canEdit && !mapEdit && (
              <button onClick={startMapEdit} data-testid="map-edit-btn" className="text-xs text-muted-foreground hover:text-prg-red inline-flex items-center gap-1">
                <PencilSimple size={12} /> Edit map
              </button>
            )}
          </div>
          <LongbridgeMap
            zones={displayZones}
            mapSize={displaySize}
            backgroundUrl={info.map_background_url}
            selected={selected}
            setSelected={setSelected}
            editable={mapEdit}
            onZoneChange={patchZone}
            onCanvasResize={(w, h) => setEditMapSize({ width: w, height: h })}
          />
          {mapEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => uploadBackground(e.target.files?.[0])}
                data-testid="map-background-input"
                className="hidden"
                id="map-background-file"
              />
              <label htmlFor="map-background-file" data-testid="map-background-upload-btn"
                className="h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2 cursor-pointer">
                <ImageIcon size={14} /> {uploadingBg ? "Uploading…" : info.map_background_url ? "Replace background" : "Upload background image"}
              </label>
              {info.map_background_url && (
                <button onClick={removeBackground} data-testid="map-background-remove"
                  className="h-9 px-3 rounded-btn border border-border text-xs font-bold uppercase tracking-widest text-red-400 hover:border-red-500">
                  Remove background
                </button>
              )}
            </div>
          )}
          {mapEdit && (
            <div className="text-[11px] text-muted-foreground">
              Drag a section to move it, or its corner handle to resize it. Drag the red handle in the map&apos;s own bottom-right corner to resize the whole canvas.
            </div>
          )}
          {!mapEdit && selected && (
            <div className="bg-card border border-border rounded-card p-4" data-testid={`map-detail-${selected.id}`}>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Selected zone</div>
              <div className="font-display font-bold text-lg mt-1 flex items-center gap-2"><MapPin size={16} className="text-prg-red" /> {selected.label}</div>
              {selected.notes && <div className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap" data-testid={`map-zone-notes-display-${selected.id}`}>{selected.notes}</div>}
            </div>
          )}
          {mapEdit && (
            <div className="bg-card border border-border rounded-card p-4 space-y-3">
              <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Sections (name, colour &amp; notes)</div>
              <MapEditor zones={editZones} setZones={setEditZones} />
              <div className="text-[11px] text-muted-foreground">Drag the handle on the left of a section to reorder — sections lower in this list appear on top when they overlap on the map.</div>
              <div className="flex gap-2 pt-1">
                <button onClick={saveMapEdit} disabled={savingMap} data-testid="map-save"
                  className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest disabled:opacity-60">
                  {savingMap ? "Saving…" : "Save changes"}
                </button>
                <button onClick={cancelMapEdit} data-testid="map-cancel" className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-card border border-border rounded-card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground flex items-center gap-1.5"><WifiHigh size={12} /> Guest Wi-Fi</div>
              {canEdit && <button onClick={() => setWifiEdit((v) => !v)} data-testid="wifi-edit" className="text-xs text-muted-foreground hover:text-prg-red">{wifiEdit ? "Cancel" : "Edit"}</button>}
            </div>
            {wifiEdit ? (
              <div className="space-y-2">
                <input value={wifi.ssid} onChange={(e) => setWifi({...wifi, ssid: e.target.value})} placeholder="SSID" data-testid="wifi-ssid" className="w-full h-9 px-3 rounded-btn bg-background border border-border text-sm" />
                <input value={wifi.password} onChange={(e) => setWifi({...wifi, password: e.target.value})} placeholder="Password" data-testid="wifi-password" className="w-full h-9 px-3 rounded-btn bg-background border border-border text-sm font-mono" />
                <textarea value={wifi.instructions} onChange={(e) => setWifi({...wifi, instructions: e.target.value})} placeholder="Instructions" className="w-full h-16 px-3 py-2 rounded-btn bg-background border border-border text-sm" />
                <button onClick={saveWifi} data-testid="wifi-save" className="h-8 px-3 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest">Save</button>
              </div>
            ) : (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">SSID</span><span className="font-mono">{info.wifi?.ssid}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Password</span><span className="font-mono">{info.wifi?.password}</span></div>
                {info.wifi?.instructions && <div className="text-muted-foreground text-xs pt-1">{info.wifi.instructions}</div>}
              </div>
            )}
          </div>

          <div className="bg-card border border-border rounded-card p-4">
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3 flex items-center gap-1.5"><Phone size={12} /> Important contacts</div>
            <div className="space-y-3">
              {(info.contacts || []).map((c) => (
                <div key={c.id} className="flex items-center justify-between text-sm">
                  <div>
                    <div className="font-semibold">{c.name} - {c.label}</div>
                    <div className="text-xs text-muted-foreground font-mono">{c.phone}{c.email && ` - ${c.email}`}</div>
                  </div>
                  {canEdit && <button onClick={() => delContact(c.id)} className="p-1 text-muted-foreground hover:text-red-500"><Trash size={14} /></button>}
                </div>
              ))}
            </div>
            {canEdit && (
              <div className="mt-3 pt-3 border-t border-border space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input value={newContact.label} onChange={(e) => setNewContact({...newContact, label: e.target.value})} placeholder="Label" data-testid="contact-label" className="h-8 px-2 rounded-btn bg-background border border-border text-sm" />
                  <input value={newContact.name} onChange={(e) => setNewContact({...newContact, name: e.target.value})} placeholder="Name" data-testid="contact-name" className="h-8 px-2 rounded-btn bg-background border border-border text-sm" />
                  <input value={newContact.phone} onChange={(e) => setNewContact({...newContact, phone: e.target.value})} placeholder="Phone" data-testid="contact-phone" className="h-8 px-2 rounded-btn bg-background border border-border text-sm font-mono" />
                  <input value={newContact.email} onChange={(e) => setNewContact({...newContact, email: e.target.value})} placeholder="Email" type="email" data-testid="contact-email" className="h-8 px-2 rounded-btn bg-background border border-border text-sm font-mono" />
                </div>
                <button onClick={addContact} data-testid="contact-add" className="h-8 px-3 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest inline-flex items-center gap-1"><Plus size={12} /> Add contact</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}