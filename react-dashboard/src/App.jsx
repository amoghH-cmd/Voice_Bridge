import React,{useState,useEffect,useRef}from 'react';
import{createClient}from'@supabase/supabase-js';
import EmergencyMap from'./EmergencyMap.jsx';
import{getDispatchType,findNearest,etaSeconds,playTTS,geocodeLocation}from'./constants.js';
import'./index.css';

const supabase=createClient(import.meta.env.VITE_SUPABASE_URL,import.meta.env.VITE_SUPABASE_ANON_KEY);
const API=import.meta.env.VITE_API_BASE_URL||'http://localhost:8000';
const EMOTION_COLOR={LOW:'#22c55e',MEDIUM:'#f59e0b',HIGH:'#f97316',PANIC:'#ef4444'};
const STATUS_COLOR={OPEN:'#3b82f6',ESCALATED:'#ef4444',IN_PROGRESS:'#f59e0b',RESOLVED:'#22c55e'};

export default function App(){
  const[tickets,setTickets]=useState([]);
  const[feed,setFeed]=useState([]);
  const[activeCalls,setActiveCalls]=useState([]);
  const[tab,setTab]=useState('dashboard');
  const[connected,setConnected]=useState(false);
  const[time,setTime]=useState(new Date().toLocaleTimeString());
  const[recording,setRecording]=useState(false);
  const[processing,setProcessing]=useState(false);
  const[callId,setCallId]=useState(null);
  const[history,setHistory]=useState([]);
  const[lastReply,setLastReply]=useState(null);
  const[dispatch,setDispatch]=useState(null);
  const[userLoc,setUserLoc]=useState([12.9716,77.5946]);
  const[etaRemaining,setEtaRemaining]=useState(null);

  const recRef=useRef(null);
  const chunksRef=useRef([]);
  const callIdRef=useRef(null);
  const histRef=useRef([]);
  const etaIntervalRef=useRef(null);

  useEffect(()=>{callIdRef.current=callId;},[callId]);
  useEffect(()=>{histRef.current=history;},[history]);
  useEffect(()=>{const t=setInterval(()=>setTime(new Date().toLocaleTimeString()),1000);return()=>clearInterval(t);},[]);

  useEffect(()=>{
    navigator.geolocation?.getCurrentPosition(p=>setUserLoc([p.coords.latitude,p.coords.longitude]));
    supabase.from('tickets').select('*').order('created_at',{ascending:false}).then(({data})=>data&&setTickets(data));
    const ch=supabase.channel('public:tickets')
      .on('postgres_changes',{event:'*',schema:'public',table:'tickets'},p=>{
        if(p.eventType==='INSERT'){
          setTickets(prev=>[p.new,...prev]);
          addFeed('ticket',p.new);
          if(p.new.status==='ESCALATED'||p.new.needs_escalation) triggerDispatch(p.new);
        }else if(p.eventType==='UPDATE'){
          setTickets(prev=>prev.map(t=>t.id===p.new.id?p.new:t));
        }
      }).subscribe(s=>setConnected(s==='SUBSCRIBED'));
    return()=>supabase.removeChannel(ch);
  },[]);

  function addFeed(type,data){
    setFeed(prev=>[{id:Date.now()+Math.random(),type,data,ts:new Date()},...prev].slice(0,60));
  }

  // coords: [lat, lng] — optional override (from geocoded speech location)
  function triggerDispatch(ticket, coords=null){
    const loc=coords||userLoc;
    const type=getDispatchType(ticket.intent_category,ticket.summary||'');
    const services=findNearest(loc[0],loc[1],type,1);
    if(!services.length)return;
    const svc=services[0];
    const eta=etaSeconds(svc.distKm);
    const d={dispatchId:'DSP-'+Date.now(),type,service:svc,userLat:loc[0],userLng:loc[1],etaSeconds:eta,startTime:Date.now()};
    setDispatch(d);
    setEtaRemaining(eta);
    setTab('map');
    if(etaIntervalRef.current)clearInterval(etaIntervalRef.current);
    addFeed('dispatch',{type,service:svc.name,eta});
  }

  async function startRec(){
    if(recording||processing)return;
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mr=new MediaRecorder(stream,{mimeType:'audio/webm'});
      recRef.current=mr; chunksRef.current=[];
      mr.ondataavailable=e=>{if(e.data.size>0)chunksRef.current.push(e.data);};
      mr.onstop=async()=>{
        const blob=new Blob(chunksRef.current,{type:'audio/webm'});
        if(blob.size<1000){console.warn('Too short');return;}
        await sendVoice(blob);
      };
      mr.start(); setRecording(true);
    }catch(e){alert('Microphone error: '+e.message);}
  }

  function stopRec(){
    if(recRef.current&&recording){
      recRef.current.stop();
      recRef.current.stream.getTracks().forEach(t=>t.stop());
      setRecording(false);
    }
  }

  async function sendVoice(blob){
    const id=callIdRef.current||('voice-'+Date.now());
    if(!callIdRef.current){callIdRef.current=id;setCallId(id);}
    setProcessing(true);
    setActiveCalls(prev=>prev.includes(id)?prev:[...prev,id]);
    addFeed('status',{status:'PROCESSING',call_id:id});
    const fd=new FormData();
    fd.append('audio',blob,'recording.webm');
    fd.append('call_id',id);
    fd.append('history',JSON.stringify(histRef.current));
    try{
      const res=await fetch(`${API}/api/calls/voice`,{method:'POST',body:fd});
      if(!res.ok)throw new Error('HTTP '+res.status);
      const data=await res.json();
      if(data.success){
        addFeed('status',{status:'TRANSCRIPT',call_id:id,transcript:data.transcript,ai_reply:data.ai_confirmation});
        setLastReply({text:data.ai_confirmation,lang:data.language||'en'});
        const nh=[...histRef.current,{role:'user',text:data.transcript},{role:'assistant',text:data.ai_confirmation}];
        histRef.current=nh; setHistory(nh);

        // ── Real-time Location + Map Update ────────────────────────
        const locationText = data.location_raw || data.landmark || data.district;
        if(locationText){
          addFeed('location',{status:'GEOCODING',location:locationText,call_id:id});
          geocodeLocation(locationText).then(geo=>{
            if(geo){
              const newCoords=[geo.lat,geo.lng];
              setUserLoc(newCoords);
              addFeed('location',{status:'LOCATION_FOUND',location:locationText,display:geo.display,lat:geo.lat,lng:geo.lng,call_id:id});
              // Auto-dispatch if emergency type detected from speech
              if(data.dispatch_type && data.dispatch_type!=='none'){
                triggerDispatch({intent_category:data.ticket?.intent_category||'other',summary:data.ticket?.summary||''},newCoords);
              } else if(data.needs_escalation){
                triggerDispatch({intent_category:data.ticket?.intent_category||'other',summary:data.ticket?.summary||''},newCoords);
              }
            } else {
              addFeed('location',{status:'GEOCODE_FAILED',location:locationText,call_id:id});
            }
          });
        } else if(data.dispatch_type && data.dispatch_type!=='none'){
          // No spoken location, dispatch to GPS/current location
          triggerDispatch({intent_category:data.ticket?.intent_category||'other',summary:data.ticket?.summary||''});
        }
        // ───────────────────────────────────────────────────────────

        if(data.ai_confirmation) await playTTS(data.ai_confirmation,data.language||'en',API);
      }else{addFeed('status',{status:'ERROR',call_id:id,transcript:data.error});}
    }catch(e){addFeed('status',{status:'ERROR',call_id:id,transcript:e.message});}
    finally{setProcessing(false);}
  }

  function endCall(){
    const id=callIdRef.current;
    setActiveCalls(prev=>prev.filter(c=>c!==id));
    callIdRef.current=null; histRef.current=[];
    setCallId(null); setHistory([]); setLastReply(null);
    if(id)addFeed('status',{status:'ENDED',call_id:id});
  }

  const open=tickets.filter(t=>t.status==='OPEN').length;
  const esc=tickets.filter(t=>t.status==='ESCALATED').length;
  const avgConf=tickets.length?Math.round(tickets.reduce((s,t)=>s+(t.confidence||0),0)/tickets.length):0;
  const micLabel=processing?'⏳ Processing…':recording?'🔴 Recording…':'🎙️ Hold to Speak';
  const TYPE_EMOJI={fire:'🔥',ambulance:'🚑',police:'🚔',rescue:'🚁'};

  return(
    <div style={{display:'flex',height:'100vh',width:'100vw',background:'#0f172a',color:'#f8fafc',fontFamily:'Inter,system-ui,sans-serif',overflow:'hidden'}}>
      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-logo"><span className="brand-icon">📡</span>
            <div><div className="brand-name">VoiceBridge</div><div className="brand-sub">1092 Karnataka Helpline</div></div>
          </div>
          <div className="ws-status">
            <span className={`ws-dot ${connected?'connected':'error'}`}/>
            <span>{connected?'Live — Supabase':'Connecting…'}</span>
          </div>
        </div>
        <nav className="sidebar-nav">
          {[['dashboard','⚡','Live Dashboard',null],['tickets','🎫','Tickets',open],['escalations','🚨','Escalations',esc],['map','🗺️','Emergency Map',dispatch?'!':null]].map(([id,icon,label,badge])=>(
            <button key={id} className={`nav-item ${tab===id?'active':''}`} onClick={()=>setTab(id)}>
              <span className="nav-icon">{icon}</span>{label}
              {badge!=null&&<span className={`nav-badge ${badge==='!'?'urgent':''}`}>{badge}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="agent-card">
            <div className="agent-avatar">A</div>
            <div><div className="agent-name">Agent 8512</div><div className="agent-role">SUPERVISOR</div></div>
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <h1 className="page-title">{tab==='dashboard'?'Live Dashboard':tab==='tickets'?'All Tickets':tab==='escalations'?'Escalations':'🗺️ Emergency Map'}</h1>
            <div className="breadcrumb">{tab==='map'&&dispatch?`${TYPE_EMOJI[dispatch.type]||'🚨'} ${dispatch.type.toUpperCase()} — dispatched`:'Real-time monitoring'}</div>
          </div>
          <div style={{display:'flex',gap:'1rem',alignItems:'center'}}>
            <div className="live-clock">{time}</div>
            {callId&&<button className="btn btn-ghost" onClick={endCall} disabled={processing} style={{border:'1px solid #ef4444',color:'#ef4444',padding:'0.6rem 1.2rem'}}>End Call</button>}
            <button className={`btn ${recording?'btn-danger':'btn-ghost'}`} onMouseDown={startRec} onMouseUp={stopRec} onTouchStart={startRec} onTouchEnd={stopRec} disabled={processing}
              style={{padding:'0.6rem 1.4rem',background:recording?'#ef4444':processing?'#1e293b':'#1e293b',opacity:processing?0.6:1,cursor:processing?'not-allowed':'pointer'}}>
              {micLabel}
            </button>
          </div>
        </header>

        <div className="view" style={{overflowY:'auto',flex:1}}>

          {/* ── DASHBOARD TAB ── */}
          {tab==='dashboard'&&<>
            <div className="stats-grid">
              <div className="stat-card"><div className="stat-icon blue">📞</div><div className="stat-body"><div className="stat-value">{activeCalls.length}</div><div className="stat-label">Active Calls</div></div>{activeCalls.length>0&&<div className="stat-pulse"/>}</div>
              <div className="stat-card"><div className="stat-icon yellow">🎫</div><div className="stat-body"><div className="stat-value">{open}</div><div className="stat-label">Open Tickets</div></div></div>
              <div className="stat-card danger"><div className="stat-icon red">🚨</div><div className="stat-body"><div className="stat-value">{esc}</div><div className="stat-label">Escalations</div></div></div>
              <div className="stat-card"><div className="stat-icon green">✅</div><div className="stat-body"><div className="stat-value">{avgConf}%</div><div className="stat-label">Avg Confidence</div></div></div>
            </div>

            {/* Last AI Reply banner */}
            {lastReply&&<div style={{background:'linear-gradient(135deg,#0f2a4a,#0c1a2e)',border:'1px solid #1e4a7a',borderRadius:12,padding:'1rem 1.5rem',marginBottom:'1.5rem',display:'flex',gap:'1rem',alignItems:'flex-start'}}>
              <span style={{fontSize:28}}>🤖</span>
              <div><div style={{color:'#38bdf8',fontWeight:600,marginBottom:4}}>Last AI Reply</div>
              <div style={{color:'#e2e8f0',lineHeight:1.6}}>{lastReply.text}</div></div>
            </div>}

            <div className="two-col">
              <section className="card">
                <div className="card-header"><h2 className="card-title">⚡ Live Feed</h2><button className="btn btn-ghost btn-sm" onClick={()=>setFeed([])}>Clear</button></div>
                <div className="event-feed">
                  {!feed.length&&<div className="feed-empty">Waiting for events…</div>}
                  {feed.map(ev=>(
                    <div key={ev.id} className={`feed-item ${ev.type}`}>
                      <div className="feed-icon">{ev.type==='ticket'?'🎫':ev.type==='dispatch'?'🚨':ev.type==='location'?'📍':'📞'}</div>
                      <div style={{flex:1}}>
                        {ev.type==='ticket'&&<><div className="feed-text"><b>New Ticket:</b> {ev.data.intent_category} — <span style={{color:EMOTION_COLOR[ev.data.emotion]||'#94a3b8'}}>{ev.data.emotion}</span></div><div className="feed-text" style={{color:'#64748b',fontSize:12}}>{ev.data.summary}</div></>}
                        {ev.type==='dispatch'&&<><div className="feed-text"><b>🚨 Dispatch:</b> {TYPE_EMOJI[ev.data.type]||'🚨'} {ev.data.type}</div><div className="feed-text" style={{color:'#f59e0b',fontSize:12}}>{ev.data.service} — ETA {Math.round(ev.data.eta/60)}m</div></>}
                        {ev.type==='location'&&(
                          ev.data.status==='GEOCODING'
                            ?<div className="feed-text" style={{color:'#94a3b8'}}>⏳ Locating: <em>"{ev.data.location}"</em></div>
                            :ev.data.status==='LOCATION_FOUND'
                              ?<><div className="feed-text"><b style={{color:'#22c55e'}}>📍 Location Found:</b> {ev.data.location}</div><div className="feed-text" style={{color:'#64748b',fontSize:11}}>{ev.data.lat?.toFixed(4)}, {ev.data.lng?.toFixed(4)}</div></>
                              :<div className="feed-text" style={{color:'#f97316'}}>⚠️ Could not locate: "{ev.data.location}"</div>
                        )}
                        {ev.type==='status'&&<><div className="feed-text"><b>Call:</b> {ev.data.status} ({ev.data.call_id})</div>
                          {ev.data.transcript&&<div className="feed-text" style={{color:'#94a3b8',fontStyle:'italic',fontSize:12}}>🗣️ "{ev.data.transcript}"</div>}
                          {ev.data.ai_reply&&<div className="feed-text" style={{color:'#38bdf8',fontSize:12}}>🤖 "{ev.data.ai_reply}"</div>}</>}
                        <div className="feed-time">{ev.ts.toLocaleTimeString()}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="card">
                <div className="card-header"><h2 className="card-title">📞 Active Calls</h2><span className="badge live">LIVE</span></div>
                <div className="active-calls">
                  {!activeCalls.length&&<div className="feed-empty">No active calls</div>}
                  {activeCalls.map(id=>(
                    <div key={id} className="call-item">
                      <div className="call-header"><span className="call-phone">ID: {id}</span><span className="badge live">{processing&&id===callId?'PROCESSING':'IN PROGRESS'}</span></div>
                    </div>
                  ))}
                </div>
                {callId&&history.length>0&&(
                  <div style={{padding:'1rem',borderTop:'1px solid #1e293b',maxHeight:200,overflowY:'auto'}}>
                    <div style={{fontSize:11,color:'#475569',textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:8}}>Session ({history.length/2} exchanges)</div>
                    {history.slice(-6).map((t,i)=>(
                      <div key={i} style={{marginBottom:6,fontSize:13}}>
                        <span style={{color:t.role==='user'?'#94a3b8':'#38bdf8',fontWeight:600}}>{t.role==='user'?'🗣️ You':'🤖 AI'}:</span>
                        <span style={{color:'#cbd5e1',marginLeft:6}}>{t.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <section className="card mt-4">
              <div className="card-header"><h2 className="card-title">🎫 Recent Tickets</h2></div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>ID</th><th>Intent</th><th>Summary</th><th>Emotion</th><th>Lang</th><th>Conf</th><th>Status</th></tr></thead>
                  <tbody>
                    {tickets.slice(0,12).map(t=>(
                      <tr key={t.id}>
                        <td className="ticket-id">{t.id.substring(0,8)}</td>
                        <td><span className="badge">{t.intent_category||'—'}</span></td>
                        <td className="summary-cell" title={t.summary}>{t.summary}</td>
                        <td><span className="badge" style={{background:EMOTION_COLOR[t.emotion]||'#334155',color:'#fff'}}>{t.emotion||'—'}</span></td>
                        <td><span className="badge badge-lang">{t.language||'en'}</span></td>
                        <td>
                          <div className="conf-bar"><div className="conf-fill" style={{width:`${t.confidence||0}%`,background:t.confidence>70?'#22c55e':t.confidence>40?'#f59e0b':'#ef4444'}}/></div>
                          <span style={{fontSize:11}}>{Math.round(t.confidence||0)}%</span>
                        </td>
                        <td><span className="badge" style={{background:STATUS_COLOR[t.status]||'#334155',color:'#fff'}}>{t.status||'OPEN'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>}

          {/* ── TICKETS TAB ── */}
          {tab==='tickets'&&<section className="card">
            <div className="card-header"><h2 className="card-title">🎫 All Tickets ({tickets.length})</h2></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>ID</th><th>Call ID</th><th>Intent</th><th>Summary</th><th>Emotion</th><th>District</th><th>Lang</th><th>Conf</th><th>Status</th></tr></thead>
                <tbody>
                  {tickets.map(t=>(
                    <tr key={t.id}>
                      <td className="ticket-id">{t.id.substring(0,8)}</td>
                      <td style={{fontSize:11,color:'#64748b'}}>{(t.call_id||'').substring(0,10)}</td>
                      <td><span className="badge">{t.intent_category||'—'}</span></td>
                      <td className="summary-cell" title={t.summary}>{t.summary}</td>
                      <td><span className="badge" style={{background:EMOTION_COLOR[t.emotion]||'#334155',color:'#fff'}}>{t.emotion||'—'}</span></td>
                      <td style={{fontSize:12,color:'#94a3b8'}}>{t.district||'—'}</td>
                      <td><span className="badge badge-lang">{t.language||'en'}</span></td>
                      <td>
                        <div className="conf-bar"><div className="conf-fill" style={{width:`${t.confidence||0}%`,background:t.confidence>70?'#22c55e':t.confidence>40?'#f59e0b':'#ef4444'}}/></div>
                        <span style={{fontSize:11}}>{Math.round(t.confidence||0)}%</span>
                      </td>
                      <td><span className="badge" style={{background:STATUS_COLOR[t.status]||'#334155',color:'#fff'}}>{t.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>}

          {/* ── ESCALATIONS TAB ── */}
          {tab==='escalations'&&<div>
            {!esc&&<div style={{textAlign:'center',padding:'4rem',color:'#475569'}}><div style={{fontSize:64}}>✅</div><div style={{fontSize:18,marginTop:16}}>No active escalations</div></div>}
            {tickets.filter(t=>t.status==='ESCALATED').map(t=>(
              <div key={t.id} style={{background:'#1e0a0a',border:'1px solid #7f1d1d',borderRadius:12,padding:'1.5rem',marginBottom:'1rem'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.75rem'}}>
                  <span style={{color:'#ef4444',fontWeight:700,fontSize:16}}>🚨 ESCALATED — {t.intent_category}</span>
                  <span className="badge" style={{background:EMOTION_COLOR[t.emotion]||'#334155',color:'#fff'}}>{t.emotion}</span>
                </div>
                <div style={{color:'#fca5a5',marginBottom:8}}>{t.summary}</div>
                <div style={{display:'flex',gap:'1rem',flexWrap:'wrap',fontSize:13,color:'#64748b'}}>
                  {t.district&&<span>📍 {t.district}</span>}
                  <span>🌐 {t.language}</span>
                  <span>📊 {Math.round(t.confidence||0)}% confidence</span>
                  <span>🕐 {new Date(t.created_at).toLocaleString()}</span>
                </div>
                <button onClick={()=>triggerDispatch(t)} style={{marginTop:'1rem',padding:'0.5rem 1.2rem',background:'#dc2626',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontWeight:600}}>
                  🚨 Dispatch Emergency Response
                </button>
              </div>
            ))}
          </div>}

          {/* ── MAP TAB ── */}
          {tab==='map'&&<div style={{display:'flex',gap:'1.5rem',height:'calc(100vh - 130px)'}}>
            <div style={{flex:1,borderRadius:12,overflow:'hidden',minHeight:400}}>
              <EmergencyMap
                dispatch={dispatch}
                userLocation={userLoc}
                onEtaUpdate={(secs)=>setEtaRemaining(secs)}
              />
            </div>
            <div style={{width:300,display:'flex',flexDirection:'column',gap:'1rem',overflowY:'auto'}}>
              {dispatch?(
                <div style={{background:'#1e0a0a',border:'1px solid #7f1d1d',borderRadius:12,padding:'1.5rem'}}>
                  <div style={{color:'#ef4444',fontWeight:700,fontSize:18,marginBottom:'0.5rem'}}>{TYPE_EMOJI[dispatch.type]||'🚨'} {dispatch.type.toUpperCase()} DISPATCH</div>
                  <div style={{color:'#94a3b8',fontSize:13,marginBottom:'1rem'}}>ID: {dispatch.dispatchId}</div>
                  <div style={{marginBottom:'0.75rem'}}><div style={{color:'#64748b',fontSize:12}}>RESPONDING UNIT</div><div style={{color:'#f8fafc',fontWeight:600}}>{dispatch.service.name}</div></div>
                  <div style={{marginBottom:'0.75rem'}}><div style={{color:'#64748b',fontSize:12}}>DISTANCE</div><div style={{color:'#f8fafc',fontWeight:600}}>{dispatch.service.distKm?.toFixed(2)} km</div></div>
                  <div style={{marginBottom:'1.5rem'}}><div style={{color:'#64748b',fontSize:12}}>ETA</div>
                    <div style={{fontSize:36,fontWeight:800,color:etaRemaining===0?'#22c55e':'#f59e0b'}}>
                      {etaRemaining===0?'ARRIVED ✅':`${Math.floor(etaRemaining/60)}m ${etaRemaining%60}s`}
                    </div>
                  </div>
                  <button onClick={()=>setDispatch(null)} style={{width:'100%',padding:'0.6rem',background:'#1e293b',color:'#94a3b8',border:'1px solid #334155',borderRadius:8,cursor:'pointer'}}>
                    Clear Dispatch
                  </button>
                </div>
              ):(
                <div style={{background:'#0f1a2e',border:'1px solid #1e3a5f',borderRadius:12,padding:'1.5rem'}}>
                  <div style={{color:'#38bdf8',fontWeight:700,marginBottom:'0.75rem'}}>🗺️ Manual Dispatch</div>
                  <div style={{color:'#64748b',fontSize:13,marginBottom:'1rem'}}>Select emergency type to simulate dispatch from nearest unit</div>
                  {['fire','ambulance','police','rescue'].map(type=>(
                    <button key={type} onClick={()=>triggerDispatch({intent_category:type==='ambulance'?'medical':type,summary:type})}
                      style={{display:'block',width:'100%',padding:'0.6rem 1rem',marginBottom:'0.5rem',background:'#1e293b',color:'#f8fafc',border:'1px solid #334155',borderRadius:8,cursor:'pointer',textAlign:'left',fontSize:14}}>
                      {TYPE_EMOJI[type]||'🚨'} Dispatch {type}
                    </button>
                  ))}
                </div>
              )}
              <div style={{background:'#0f1a2e',border:'1px solid #1e3a5f',borderRadius:12,padding:'1.5rem'}}>
                <div style={{color:'#38bdf8',fontWeight:600,marginBottom:'0.75rem',fontSize:14}}>📍 Your Location</div>
                <div style={{color:'#94a3b8',fontSize:13}}>Lat: {userLoc[0].toFixed(4)}</div>
                <div style={{color:'#94a3b8',fontSize:13}}>Lng: {userLoc[1].toFixed(4)}</div>
                <div style={{color:'#475569',fontSize:12,marginTop:'0.5rem'}}>Bangalore, Karnataka</div>
              </div>
            </div>
          </div>}

        </div>
      </main>
    </div>
  );
}
