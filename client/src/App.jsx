import './index.css';
import { useEffect, useState, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, ReferenceArea } from "recharts";

const socket = io(window.location.origin);

// ── constants ─────────────────────────────────────────────────
const STATE = {
  SAFE:    { label:"SAFE",    icon:"✅", color:"var(--green)", bg:"var(--green-bg)", border:"var(--green-border)" },
  WARNING: { label:"WARNING", icon:"⚠️", color:"var(--amber)", bg:"var(--amber-bg)", border:"var(--amber-border)" },
  DANGER:  { label:"DANGER",  icon:"🚨", color:"var(--red)",   bg:"var(--red-bg)",   border:"var(--red-border)" },
  UNKNOWN: { label:"WAITING", icon:"⏳", color:"var(--slate)", bg:"var(--slate-bg)", border:"var(--slate-border)" },
};
const COLORS = ["#2563eb","#7c3aed","#059669","#db2777","#ea580c","#0891b2","#9333ea","#16a34a","#ca8a04","#dc2626","#6366f1","#0d9488"];
const CAT_COLOR = { A:"#dc2626", B:"#d97706", C:"#16a34a" };
const CAT_LABEL = { A:"Very Sensitive", B:"Moderate", C:"Stable" };
const HOUR_RANGES = [1, 2, 4];

// ── helpers ───────────────────────────────────────────────────
const fmtTime   = ts => new Date(ts).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"});
const fmtDate   = ts => new Date(ts).toLocaleDateString("en-IN",{day:"2-digit",month:"short"});
const fmtUptime = s  => `${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor((s%3600)/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;

function potencyTier(p) {
  if (p >= 80) return { label:"Excellent", icon:"💚", color:"var(--green)", bg:"var(--green-bg)", border:"var(--green-border)" };
  if (p >= 50) return { label:"Reduced",   icon:"🟡", color:"var(--amber)", bg:"var(--amber-bg)", border:"var(--amber-border)" };
  if (p >  0)  return { label:"Critical",  icon:"🔴", color:"var(--red)",   bg:"var(--red-bg)",   border:"var(--red-border)" };
  return             { label:"Destroyed",  icon:"☠️", color:"#7f1d1d",     bg:"#fef2f2",         border:"#fecaca" };
}

// ── small components ──────────────────────────────────────────
function Badge({ children, color, bg, border }) {
  return <span className="badge" style={{ color, background:bg, borderColor:border }}>{children}</span>;
}
function Skeleton({ h=14, w="100%" }) {
  return <div className="skeleton" style={{ height:h, width:w }}/>;
}
function PotencyRing({ potency=100, size=54 }) {
  const r=( size-7)/2, circ=2*Math.PI*r, pct=Math.max(0,Math.min(100,potency));
  const color=pct>80?"#16a34a":pct>50?"#d97706":"#dc2626";
  return (
    <svg width={size} height={size} style={{flexShrink:0}}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={5}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={5}
        strokeDasharray={`${(pct/100)*circ} ${circ}`} strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`} style={{transition:"stroke-dasharray .6s"}}/>
      <text x={size/2} y={size/2+1} textAnchor="middle" dominantBaseline="middle" fill={color} fontSize={10} fontWeight={700}>{Math.round(pct)}%</text>
    </svg>
  );
}
function Sparkline({ data, color="#2563eb" }) {
  if(!data||data.length<2) return null;
  const w=88,h=28,pts=data.slice(-18);
  const mn=Math.min(...pts),mx=Math.max(...pts)||mn+1;
  return <svg width={w} height={h}>
    <path d={"M"+pts.map((v,i)=>`${i/(pts.length-1)*w},${h-((v-mn)/(mx-mn))*h}`).join("L")} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round"/>
  </svg>;
}
function Toggle({ checked, onChange }) {
  return <button className="toggle" onClick={onChange} style={{background:checked?"var(--primary)":"var(--border)"}}>
    <div className="toggle-thumb" style={{left:checked?21:3}}/>
  </button>;
}
function GraphTooltip({ active, payload }) {
  if(!active||!payload?.length) return null;
  const d=payload[0]?.payload;
  const s=STATE[d?.state]??STATE.UNKNOWN;
  return <div className="g-tip">
    <div style={{color:"var(--text3)",marginBottom:4}}>🕐 {d?.time}</div>
    <div style={{fontSize:16,fontWeight:800,color:"var(--primary)"}}>🌡️ {d?.temp}°C</div>
    <div style={{color:"var(--text2)"}}>💧 {d?.hum}%</div>
    <div style={{color:s.color,fontWeight:600,marginTop:4}}>{s.icon} {s.label}</div>
  </div>;
}
function exportCSV(readings) {
  const b=new Blob(["timestamp,temp,hum,state\n"+readings.map(r=>`${r.timestamp},${r.temp},${r.hum},${r.state}`).join("\n")],{type:"text/csv"});
  const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(b),download:"vaccitrack.csv"});
  a.click(); URL.revokeObjectURL(a.href);
}

// ── App ───────────────────────────────────────────────────────
export default function App() {
  const [readings,    setReadings]    = useState([]);
  const [alerts,      setAlerts]      = useState([]);
  const [latest,      setLatest]      = useState(null);
  const [vaccines,    setVaccines]    = useState({});
  const [exposure,    setExposure]    = useState({});
  const [selectedVax, setSelectedVax] = useState(null);
  const [connected,   setConnected]   = useState(false);
  const [loading,     setLoading]     = useState(true);
  const [activeTab,   setActiveTab]   = useState("dashboard");
  const [search,      setSearch]      = useState("");
  const [stats,       setStats]       = useState(null);
  const [uptime,      setUptime]      = useState(0);
  const [hourRange,   setHourRange]   = useState(4);
  const [viewMode,    setViewMode]    = useState("cards");
  const [justSafe,    setJustSafe]    = useState(false);
  const [resetting,   setResetting]   = useState(false);
  const warnRef=useRef(null), dangerRef=useRef(null), prevState=useRef("UNKNOWN");

  const overallState = latest?.state??"UNKNOWN";
  const vState     = n => latest?.vaccineStates?.[n]?.state??"UNKNOWN";
  const vPotency   = n => exposure?.[n]?.potency??100;

  // Effective state = temperature state PLUS potency override:
  //   potency = 0  → always DANGER (destroyed)
  //   potency < 50 → at least WARNING (critical)
  const effectiveState = n => {
    const pot = vPotency(n);
    const ts  = vState(n);
    if (pot <= 0)          return "DANGER";
    if (pot < 50 && ts === "SAFE") return "WARNING";
    return ts;
  };

  // Overall fridge state: worst of temperature state + any potency overrides
  const worstMonitored = selectedVax?.length
    ? (selectedVax.some(n => effectiveState(n) === "DANGER")  ? "DANGER"
      :selectedVax.some(n => effectiveState(n) === "WARNING") ? "WARNING"
      :overallState)
    : overallState;
  const cfg = STATE[worstMonitored]??STATE.UNKNOWN;

  const notify   = useCallback((t,b)=>{ if(Notification.permission==="granted") new Notification(t,{body:b}); },[]);
  const loadStats = () => fetch("/api/stats").then(r=>r.json()).then(setStats);

  useEffect(()=>{
    Notification.requestPermission();
    Promise.all([
      fetch("/api/vaccines").then(r=>r.json()),
      fetch("/api/readings").then(r=>r.json()),
      fetch("/api/alerts").then(r=>r.json()),
      fetch("/api/exposure").then(r=>r.json()),
      fetch("/api/selected-vaccines").then(r=>r.json()),
      fetch("/api/status").then(r=>r.json()),
    ]).then(([v,rd,al,exp,sel,status])=>{
      setVaccines(v);
      const fmt=rd.map(d=>({...d,time:fmtTime(d.timestamp)}));
      setReadings(fmt); if(fmt.length) setLatest(fmt[fmt.length-1]);
      setAlerts(al); setExposure(exp);
      setSelectedVax(sel.selected??Object.keys(v));
      setUptime(status.uptime??0); setLoading(false);
    });
    loadStats();
    const tick=setInterval(()=>setUptime(u=>u+1),1000);
    socket.on("connect",    ()=>setConnected(true));
    socket.on("disconnect", ()=>setConnected(false));
    socket.on("reading",data=>{
      setLatest(data); if(data.vaccineExposure) setExposure(data.vaccineExposure);
      setReadings(prev=>[...prev,{...data,time:fmtTime(data.timestamp)}].filter(r=>Date.now()-new Date(r.timestamp)<4*3600000));
      if(data.state==="SAFE"&&prevState.current!=="SAFE"){ setJustSafe(true); setTimeout(()=>setJustSafe(false),3000); }
      prevState.current=data.state;
    });
    socket.on("alert",a=>{
      setAlerts(p=>[a,...p.slice(0,49)]);
      if(a.state==="DANGER") dangerRef.current?.play().catch(()=>{});
      else warnRef.current?.play().catch(()=>{});
      notify(STATE[a.state]?.label??"Alert",a.message); loadStats();
    });
    socket.on("sensor_error",()=>{});
    socket.on("selected_vaccines_changed",d=>setSelectedVax(d.selected));
    socket.on("data_reset",()=>{ setReadings([]); setAlerts([]); setLatest(null); setExposure({}); setStats(null); });
    return ()=>{ socket.offAny(); clearInterval(tick); };
  },[notify]);

  async function toggleVaccine(name) {
    const next=selectedVax.includes(name)?selectedVax.filter(n=>n!==name):[...selectedVax,name];
    setSelectedVax(next);
    await fetch("/api/selected-vaccines",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selected:next})});
  }
  async function resetData() {
    await fetch("/api/reset",{method:"POST"}); setResetting(false); loadStats();
  }

  const vaccineKeys   = Object.keys(vaccines);
  const monitoredKeys = vaccineKeys.filter(n=>selectedVax?.includes(n));
  const filteredKeys  = monitoredKeys.filter(n=>n.toLowerCase().includes(search.toLowerCase()));
  const vColor        = n=>COLORS[vaccineKeys.indexOf(n)%COLORS.length];
  const stateCounts   = {SAFE:0,WARNING:0,DANGER:0,UNKNOWN:0};
  monitoredKeys.forEach(n=>{ const s=effectiveState(n); stateCounts[s]=(stateCounts[s]||0)+1; });
  const sparkData  = readings.map(r=>r.temp).filter(Boolean);
  const chartData  = readings.filter(r=>Date.now()-new Date(r.timestamp)<hourRange*3600000);

  const tabs=[["dashboard","📊","Dashboard"],["vaccines","💉","Vaccines"],["analytics","📈","Analytics"],["alerts","🔔","Alerts"]];

  return (<>
    <audio ref={warnRef}   src="/warn.mp3"   preload="auto"/>
    <audio ref={dangerRef} src="/danger.mp3" preload="auto"/>

    {/* ── NAV ── */}
    <nav className="nav">
      <a className="nav-logo">
        <div className="nav-logo-icon">💉</div>
        <div>
          <div style={{fontWeight:800,fontSize:15,color:"var(--text)"}}>VacciTrack</div>
          <div style={{fontSize:9,color:"var(--text3)",lineHeight:1}}>PHC Cold Chain Monitor</div>
        </div>
      </a>

      <div className="nav-tabs">
        {tabs.map(([id,icon,label])=>(
          <button key={id} className={`nav-tab${activeTab===id?" active":""}`}
            onClick={()=>{ setActiveTab(id); if(id==="analytics") loadStats(); }}>
            {icon} <span>{label}</span>
            {id==="alerts"&&alerts.length>0&&<span style={{marginLeft:4,background:"#dc2626",color:"#fff",borderRadius:999,padding:"1px 6px",fontSize:9}}>{alerts.length}</span>}
          </button>
        ))}
      </div>

      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <div style={{fontSize:11,color:"var(--text3)",fontFamily:"monospace"}}>⏱ {fmtUptime(uptime)}</div>
        <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12,fontWeight:600,color:connected?"var(--green)":"var(--red)"}}>
          <div className={`live-dot ${connected?"online":"offline"}`}><span/></div>
          {connected?"Live":"Offline"}
        </div>
        <span className="badge" style={{color:cfg.color,background:cfg.bg,borderColor:cfg.border,fontSize:12,padding:"4px 12px"}}>
          {cfg.icon} {cfg.label}
        </span>
      </div>
    </nav>

    {/* ── LIVE TEMP BAR ── */}
    {latest&&(
      <div className={`status-bar${justSafe?" safe-flash":""}`} style={{background:cfg.bg,borderBottomColor:cfg.border}}>
        <span style={{fontWeight:700,color:cfg.color,fontSize:13}}>{cfg.icon} Fridge {cfg.label}</span>
        <span style={{color:"var(--text2)"}}>🌡️ <strong style={{color:cfg.color}}>{latest.temp}°C</strong></span>
        <span style={{color:"var(--text2)"}}>💧 {latest.hum}%</span>
        <span style={{color:"var(--text3)",marginLeft:"auto",fontSize:11}}>Updated {fmtDate(latest.timestamp)} {fmtTime(latest.timestamp)}</span>
        {justSafe&&<span style={{color:"var(--green)",fontWeight:700}}>🎉 Recovered to SAFE!</span>}
      </div>
    )}

    <div className="page">

      {/* ═══ DASHBOARD ═══ */}
      {activeTab==="dashboard"&&<>

        {/* Hero stat row */}
        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr",gap:14,marginBottom:18}} className="hero-grid">
          {/* Big status card */}
          <div className="card" style={{background:cfg.bg,borderColor:cfg.border,display:"flex",alignItems:"center",gap:16}}>
            <div style={{fontSize:44,lineHeight:1}}>{cfg.icon}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:20,fontWeight:800,color:cfg.color}}>Fridge is {cfg.label}</div>
              <div style={{fontSize:13,color:"var(--text2)",marginTop:3}}>
                {overallState==="SAFE"   &&"All vaccines within safe temperature range ✓"}
                {overallState==="WARNING"&&"Temperature rising — inspect refrigerator now!"}
                {overallState==="DANGER" &&<strong style={{color:"var(--red)"}}>STOP — Do NOT administer vaccines. Call doctor.</strong>}
                {overallState==="UNKNOWN"&&"Waiting for Arduino sensor data…"}
              </div>
            </div>
          </div>
          {[
            {icon:"✅",val:stateCounts.SAFE,    label:"Safe",      color:"var(--green)"},
            {icon:"⚠️",val:stateCounts.WARNING, label:"Warning",   color:"var(--amber)"},
            {icon:"🚨",val:stateCounts.DANGER,  label:"Danger",    color:"var(--red)"},
            {icon:"💉",val:monitoredKeys.length, label:"Monitored", color:"var(--primary)"},
          ].map(c=>(
            <div key={c.label} className="hero-stat" style={{borderTopColor:c.color}}>
              <div style={{fontSize:18,marginBottom:6}}>{c.icon}</div>
              {loading?<Skeleton h={28} w={40}/>:<div className="hero-stat-val" style={{color:c.color}}>{c.val}</div>}
              <div className="hero-stat-lbl">{c.label}</div>
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div style={{display:"flex",gap:9,marginBottom:14,alignItems:"center",flexWrap:"wrap"}}>
          <input className="input" style={{width:210}} placeholder="🔍 Filter vaccines…" value={search} onChange={e=>setSearch(e.target.value)}/>
          <span style={{fontSize:12,color:"var(--text3)"}}>{filteredKeys.length}/{monitoredKeys.length} shown</span>
          <div style={{display:"flex",gap:6,marginLeft:"auto",flexWrap:"wrap"}}>
            <button className={`btn${viewMode==="cards"?" active":""}`} onClick={()=>setViewMode("cards")}>⊞ Cards</button>
            <button className={`btn${viewMode==="list"?" active":""}`}  onClick={()=>setViewMode("list")}>☰ List</button>
            <button className="btn" onClick={()=>exportCSV(readings)}>⬇ CSV</button>
            <button className="btn danger" onClick={()=>setResetting(true)}>🗑 Reset</button>
          </div>
        </div>

        {/* ── Vaccine Grid ── */}
        <div className="card" style={{marginBottom:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
            <div>
              <h3 style={{fontSize:16,fontWeight:700}}>💉 Live Vaccine Status</h3>
              <p style={{fontSize:12,color:"var(--text3)",marginTop:2}}>{monitoredKeys.length} vaccines · simultaneous cold-chain monitoring</p>
            </div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {(["SAFE","WARNING","DANGER"]).map(s=>stateCounts[s]>0&&(
                <Badge key={s} color={STATE[s].color} bg={STATE[s].bg} border={STATE[s].border}>{STATE[s].icon} {stateCounts[s]} {s}</Badge>
              ))}
            </div>
          </div>

          {loading
            ? <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12}}>
                {[...Array(8)].map((_,i)=><div key={i} className="card" style={{display:"flex",flexDirection:"column",gap:8}}><Skeleton h={16} w="65%"/><Skeleton/><Skeleton h={6}/></div>)}
              </div>
            : viewMode==="cards"
            ? <div className="vcard-grid" style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12}}>
                {filteredKeys.map(name=>{
                  const vs=effectiveState(name), sc=STATE[vs]??STATE.UNKNOWN, col=vColor(name);
                  const pot=vPotency(name), tier=potencyTier(pot), vi=vaccines[name];
                  const catCol=CAT_COLOR[vi?.heatCategory]??"#64748b";
                  return (
                    <div key={name} className={`vcard state-${vs.toLowerCase()}`} style={{borderTopColor:col}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                        <div>
                          <div style={{fontWeight:700,fontSize:13,color:"var(--text)",lineHeight:1.3,marginBottom:4}}>{name}</div>
                          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                            <span style={{fontSize:9,padding:"2px 7px",borderRadius:4,background:catCol+"18",color:catCol,fontWeight:700,border:`1px solid ${catCol}40`}}>Cat {vi?.heatCategory}</span>
                            <span className="badge" style={{fontSize:9,padding:"1px 7px",color:tier.color,background:tier.bg,borderColor:tier.border}}>{tier.icon} {tier.label}</span>
                          </div>
                        </div>
                        <PotencyRing potency={pot} size={50}/>
                      </div>
                      {latest&&<>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--text3)",marginBottom:3}}>
                          <span>Temperature</span><span style={{fontWeight:700,color:sc.color}}>{latest.temp}°C</span>
                        </div>
                        <div className="pbar-wrap" style={{marginBottom:8}}>
                          <div className="pbar" style={{width:`${Math.min(100,Math.max(0,(latest.temp/(vi?.warn||12))*100))}%`,background:sc.color}}/>
                        </div>
                      </>}
                      <Sparkline data={sparkData} color={col}/>
                      {latest&&<div style={{fontSize:9,color:"var(--text3)",marginTop:5}}>Updated {fmtTime(latest.timestamp)}</div>}
                      {vs!=="SAFE"&&vs!=="UNKNOWN"&&<div style={{marginTop:6,fontSize:10,color:sc.color,fontWeight:600}}>{sc.icon} {sc.label} — check immediately</div>}
                    </div>
                  );
                })}
              </div>
            : <table className="tbl">
                <thead><tr>
                  {["Vaccine","Cat","Heat Sensitivity","Temp Status","Potency","Updated"].map(h=><th key={h}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {filteredKeys.map(name=>{
                    const vs=effectiveState(name), sc=STATE[vs]??STATE.UNKNOWN;
                    const pot=vPotency(name), tier=potencyTier(pot);
                    const catCol=CAT_COLOR[vaccines[name]?.heatCategory]??"#64748b";
                    return <tr key={name}>
                      <td style={{fontWeight:600}}>{name}</td>
                      <td><span style={{fontSize:10,padding:"2px 7px",borderRadius:4,background:catCol+"18",color:catCol,fontWeight:700}}>{vaccines[name]?.heatCategory}</span></td>
                      <td style={{fontSize:12,color:"var(--text2)"}}>{CAT_LABEL[vaccines[name]?.heatCategory]}</td>
                      <td><Badge color={sc.color} bg={sc.bg} border={sc.border}>{sc.icon} {sc.label}</Badge></td>
                      <td>
                        <div style={{display:"flex",gap:7,alignItems:"center"}}>
                          <div className="pbar-wrap" style={{width:60}}><div className="pbar" style={{width:`${pot}%`,background:pot>80?"var(--green)":pot>50?"var(--amber)":"var(--red)"}}/></div>
                          <span style={{fontWeight:700,fontSize:12,color:tier.color}}>{Math.round(pot)}%</span>
                        </div>
                      </td>
                      <td style={{color:"var(--text3)",fontSize:12}}>{latest?fmtTime(latest.timestamp):"—"}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
          }
        </div>

        {/* ── Temperature Graph ── */}
        <div className="card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
            <div>
              <h3 style={{fontSize:16,fontWeight:700}}>📈 Temperature History</h3>
              <p style={{fontSize:12,color:"var(--text3)",marginTop:2}}>{chartData.length} readings · last {hourRange}h</p>
            </div>
            <div style={{display:"flex",gap:5}}>
              {HOUR_RANGES.map(h=><button key={h} className={`btn${hourRange===h?" active":""}`} onClick={()=>setHourRange(h)}>Last {h}h</button>)}
            </div>
          </div>
          {chartData.length===0
            ? <div className="empty" style={{padding:"40px 0"}}><div className="empty-icon">📡</div><div className="empty-title">Waiting for Arduino…</div><p>Connect Arduino on COM5 and start the server.</p></div>
            : <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={chartData} margin={{top:8,right:24,left:0,bottom:0}}>
                  <defs>
                    <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#2563eb" stopOpacity={0.18}/>
                      <stop offset="95%" stopColor="#2563eb" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e8effa"/>
                  <XAxis dataKey="time" tick={{fill:"#8fa3c4",fontSize:10}} interval={Math.max(0,Math.floor(chartData.length/8))}/>
                  <YAxis domain={[0,40]} tick={{fill:"#8fa3c4",fontSize:10}} label={{value:"°C",angle:-90,position:"insideLeft",fill:"#8fa3c4",fontSize:11}}/>
                  <Tooltip content={<GraphTooltip/>}/>
                  <ReferenceArea y1={8}  y2={12} fill="rgba(217,119,6,0.06)"/>
                  <ReferenceArea y1={12} y2={40} fill="rgba(220,38,38,0.05)"/>
                  <ReferenceLine y={2}  stroke="#16a34a" strokeDasharray="4 3" label={{value:"MIN 2°C",   fill:"#16a34a",fontSize:9,position:"insideBottomRight"}}/>
                  <ReferenceLine y={8}  stroke="#d97706" strokeDasharray="4 3" label={{value:"WARN 8°C",  fill:"#d97706",fontSize:9,position:"insideTopRight"}}/>
                  <ReferenceLine y={12} stroke="#dc2626" strokeDasharray="4 3" label={{value:"DANGER 12°C",fill:"#dc2626",fontSize:9,position:"insideTopRight"}}/>
                  <Area type="monotoneX" dataKey="temp" stroke="#2563eb" strokeWidth={2.5} fill="url(#tg)" dot={false} activeDot={{r:5,fill:"#2563eb"}}/>
                </AreaChart>
              </ResponsiveContainer>
          }
        </div>
      </>}

      {/* ═══ VACCINE MANAGER ═══ */}
      {activeTab==="vaccines"&&<>
        <div style={{marginBottom:18}}>
          <h2 style={{fontSize:20,fontWeight:800}}>💉 Vaccine Manager</h2>
          <p style={{color:"var(--text3)",fontSize:13,marginTop:4}}>Toggle monitoring per vaccine. All vaccines always accumulate potency data.</p>
        </div>

        {/* Monitored */}
        <div className="card" style={{marginBottom:14}}>
          <h3 style={{fontSize:14,fontWeight:700,color:"var(--green)",marginBottom:14}}>✅ Monitoring ({monitoredKeys.length})</h3>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
            {vaccineKeys.filter(n=>selectedVax?.includes(n)).map(name=>{
              const col=vColor(name),pot=vPotency(name),tier=potencyTier(pot);
              const catCol=CAT_COLOR[vaccines[name]?.heatCategory]??"#64748b";
              return <div key={name} className="card" style={{borderLeft:`4px solid ${col}`,display:"flex",gap:12,alignItems:"flex-start",padding:"13px 14px",boxShadow:"none"}}>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                    <span style={{fontWeight:700,fontSize:13}}>{name}</span>
                    <span style={{fontSize:9,padding:"2px 7px",borderRadius:4,background:catCol+"18",color:catCol,fontWeight:700}}>Cat {vaccines[name]?.heatCategory} · {CAT_LABEL[vaccines[name]?.heatCategory]}</span>
                  </div>
                  <p style={{fontSize:11,color:"var(--text3)",lineHeight:1.5,marginBottom:8}}>{vaccines[name]?.info}</p>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                    <Badge color="var(--green)" bg="var(--green-bg)" border="var(--green-border)">✅ {vaccines[name]?.min}–{vaccines[name]?.max}°C safe</Badge>
                    <Badge color="var(--amber)" bg="var(--amber-bg)" border="var(--amber-border)">⚠️ &gt;{vaccines[name]?.max}°C warn</Badge>
                  </div>
                  <div style={{fontSize:12,display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{color:"var(--text3)"}}>Potency:</span>
                    <span className="badge" style={{color:tier.color,background:tier.bg,borderColor:tier.border}}>{tier.icon} {Math.round(pot)}% {tier.label}</span>
                  </div>
                </div>
                <Toggle checked={true} onChange={()=>toggleVaccine(name)}/>
              </div>;
            })}
          </div>
        </div>

        {/* Not monitored */}
        {vaccineKeys.filter(n=>!selectedVax?.includes(n)).length>0&&(
          <div className="card">
            <h3 style={{fontSize:14,fontWeight:700,color:"var(--text3)",marginBottom:14}}>⏸ Not Monitoring ({vaccineKeys.filter(n=>!selectedVax?.includes(n)).length})</h3>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:10}}>
              {vaccineKeys.filter(n=>!selectedVax?.includes(n)).map(name=>(
                <div key={name} className="card" style={{opacity:.58,display:"flex",gap:12,alignItems:"center",padding:"12px 14px",boxShadow:"none"}}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13,marginBottom:2}}>{name}</div>
                    <div style={{fontSize:11,color:"var(--text3)"}}>{vaccines[name]?.info}</div>
                  </div>
                  <Toggle checked={false} onChange={()=>toggleVaccine(name)}/>
                </div>
              ))}
            </div>
          </div>
        )}
      </>}

      {/* ═══ ANALYTICS ═══ */}
      {activeTab==="analytics"&&<>
        <div style={{marginBottom:18}}>
          <h2 style={{fontSize:20,fontWeight:800}}>📈 Analytics</h2>
          <p style={{color:"var(--text3)",fontSize:13,marginTop:4}}>Temperature stats, potency tracking, safe streaks & daily heatmap</p>
        </div>
        {!stats||stats.empty
          ? <div className="card empty"><div className="empty-icon">📊</div><div className="empty-title">No data yet</div><p>Analytics appear after the first Arduino readings arrive.</p></div>
          : <>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(155px,1fr))",gap:12,marginBottom:18}}>
                {[
                  {icon:"❄️",label:"Min Temp",     val:`${stats.minTemp}°C`,         color:"var(--green)"},
                  {icon:"🔥",label:"Max Temp",     val:`${stats.maxTemp}°C`,         color:"var(--red)"},
                  {icon:"📊",label:"Avg Temp",     val:`${stats.avgTemp}°C`,         color:"var(--primary)"},
                  {icon:"🔒",label:"Safe Streak",  val:`${stats.streak} readings`,   color:"var(--green)"},
                  {icon:"🏆",label:"Best Streak",  val:`${stats.maxStreak} readings`,color:"#7c3aed"},
                  {icon:"📋",label:"Total (4h)",   val:stats.totalReadings,          color:"var(--slate)"},
                ].map(c=><div key={c.label} className="hero-stat card" style={{borderTopColor:c.color,padding:16}}>
                  <div style={{fontSize:20,marginBottom:6}}>{c.icon}</div>
                  <div style={{fontSize:22,fontWeight:800,color:c.color,marginBottom:2}}>{c.val}</div>
                  <div style={{fontSize:11,color:"var(--text3)"}}>{c.label}</div>
                </div>)}
              </div>

              {/* Potency table */}
              <div className="card" style={{marginBottom:18}}>
                <h3 style={{fontSize:15,fontWeight:700,marginBottom:4}}>💊 Vaccine Potency Status</h3>
                <p style={{fontSize:12,color:"var(--text3)",marginBottom:14}}>Cumulative heat exposure since last reset</p>
                <table className="tbl">
                  <thead><tr>{["Vaccine","Heat Cat","Potency","Damage %","Status"].map(h=><th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {vaccineKeys.map(name=>{
                      const pot=vPotency(name), tier=potencyTier(pot);
                      const exp=stats.vaccinePotency?.[name];
                      const catCol=CAT_COLOR[vaccines[name]?.heatCategory]??"#64748b";
                      return <tr key={name}>
                        <td style={{fontWeight:600}}>{name}</td>
                        <td><span style={{fontSize:10,padding:"2px 7px",borderRadius:4,background:catCol+"18",color:catCol,fontWeight:700}}>Cat {vaccines[name]?.heatCategory} · {CAT_LABEL[vaccines[name]?.heatCategory]}</span></td>
                        <td>
                          <div style={{display:"flex",gap:7,alignItems:"center"}}>
                            <div className="pbar-wrap" style={{width:70}}><div className="pbar" style={{width:`${pot}%`,background:tier.color}}/></div>
                            <span style={{fontWeight:700,color:tier.color}}>{Math.round(pot)}%</span>
                          </div>
                        </td>
                        <td style={{color:"var(--text2)"}}>{exp?.damage?`${Math.round(exp.damage)}%`:"0%"}</td>
                        <td><Badge color={tier.color} bg={tier.bg} border={tier.border}>{tier.icon} {tier.label}</Badge></td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>

              {/* Heatmap */}
              {Object.keys(stats.heatmap??{}).length>0&&<div className="card">
                <h3 style={{fontSize:15,fontWeight:700,marginBottom:4}}>📅 Daily Safety Heatmap</h3>
                <p style={{fontSize:12,color:"var(--text3)",marginBottom:14}}>Each cell = one day · hover for details</p>
                <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                  {Object.entries(stats.heatmap).sort().map(([day,c])=>{
                    const bg=!c.total?"#f1f5f9":c.danger/c.total>0.1?`rgba(220,38,38,${.2+c.danger/c.total*.6})`:c.warning/c.total>0.1?`rgba(217,119,6,${.2+c.warning/c.total*.6})`:`rgba(22,163,74,${.18+.55*c.safe/c.total})`;
                    return <div key={day} className="heat-cell" style={{background:bg}} title={`${day}: ${c.safe} safe, ${c.warning} warn, ${c.danger} danger`}>
                      <div style={{fontSize:9,color:"var(--text2)",fontWeight:600}}>{new Date(day).toLocaleDateString("en-IN",{day:"2-digit",month:"short"})}</div>
                      <div style={{fontSize:9,color:"var(--text3)"}}>{c.total}pts</div>
                    </div>;
                  })}
                </div>
                <div style={{display:"flex",gap:14,marginTop:12,fontSize:11,color:"var(--text3)",flexWrap:"wrap"}}>
                  {[["rgba(22,163,74,.6)","All Safe"],["rgba(217,119,6,.6)","Warning"],["rgba(220,38,38,.6)","Danger"],["#f1f5f9","No data"]].map(([c,l])=>(
                    <span key={l} style={{display:"flex",alignItems:"center",gap:5}}>
                      <span style={{width:12,height:12,borderRadius:3,background:c,display:"inline-block",border:"1px solid var(--border)"}}/>{l}
                    </span>
                  ))}
                </div>
              </div>}
            </>}
      </>}

      {/* ═══ ALERTS ═══ */}
      {activeTab==="alerts"&&<>
        <div style={{marginBottom:18,display:"flex",alignItems:"center",gap:12}}>
          <h2 style={{fontSize:20,fontWeight:800}}>🔔 Alert History</h2>
          {alerts.length>0&&<span className="badge" style={{color:"#fff",background:"var(--red)",borderColor:"var(--red)"}}>{alerts.length}</span>}
        </div>
        {alerts.length===0
          ? <div className="card empty"><div className="empty-icon">✅</div><div className="empty-title">No Alerts</div><p>System is running normally. Great job!</p></div>
          : <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {alerts.map((a,i)=>{
                const ac=STATE[a.state]??STATE.UNKNOWN;
                return <div key={i} className="card" style={{borderLeft:`4px solid ${ac.color}`,background:ac.bg}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{fontWeight:700,fontSize:14,marginBottom:4,color:ac.color}}>{ac.icon} {a.message}</div>
                      <div style={{fontSize:12,color:"var(--text2)"}}>🌡️ {a.temp}°C &nbsp;·&nbsp; 🕐 {new Date(a.timestamp).toLocaleString("en-IN")}</div>
                    </div>
                    <Badge color={ac.color} bg={ac.bg} border={ac.border}>{ac.label}</Badge>
                  </div>
                  {a.state==="DANGER"&&<div style={{marginTop:10,padding:"7px 12px",borderRadius:8,background:"rgba(220,38,38,0.1)",color:"var(--red)",fontSize:12,fontWeight:600}}>
                    ⚕️ Doctor recheck required — Do NOT administer vaccines
                  </div>}
                </div>;
              })}
            </div>}
      </>}

    </div>{/* end .page */}

    {/* ── RESET MODAL ── */}
    {resetting&&<div className="modal-overlay">
      <div className="modal-box">
        <div style={{fontSize:42,marginBottom:12}}>🗑️</div>
        <h3 style={{fontSize:17,fontWeight:800,color:"var(--red)",marginBottom:8}}>Reset All Data?</h3>
        <p style={{color:"var(--text2)",fontSize:13,lineHeight:1.7,marginBottom:22}}>
          Permanently deletes all <strong>readings</strong>, <strong>alerts</strong>, and <strong>potency history</strong>.<br/>
          Your vaccine selection is kept. <strong>This cannot be undone.</strong>
        </p>
        <div style={{display:"flex",gap:10,justifyContent:"center"}}>
          <button className="btn" onClick={()=>setResetting(false)}>Cancel</button>
          <button className="btn danger primary" style={{background:"var(--red)",color:"#fff",borderColor:"var(--red)"}} onClick={resetData}>Yes, Reset Everything</button>
        </div>
      </div>
    </div>}

    <footer style={{textAlign:"center",padding:"14px 0",color:"var(--text3)",fontSize:11,borderTop:"1px solid var(--border)",marginTop:16}}>
      VacciTrack v4.1 — Village PHC Cold Chain Monitor · Arduino + Node.js + React
    </footer>
  </>);
}
