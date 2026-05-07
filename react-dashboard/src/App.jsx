import React, { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import EmergencyMap from './EmergencyMap.jsx';
import LoadingScreen from './LoadingScreen.jsx';
import { getDispatchType, findNearest, etaSeconds, playTTS, geocodeLocation } from './constants.js';
import './index.css';

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

const EMOTION_COLOR = { LOW: '#10b981', MEDIUM: '#f59e0b', HIGH: '#ef4444', PANIC: '#dc2626' };
const STATUS_COLOR = { OPEN: '#3b82f6', ESCALATED: '#ef4444', IN_PROGRESS: '#f59e0b', RESOLVED: '#10b981' };

export default function App() {
  const [loading, setLoading] = useState(true);
  const [tickets, setTickets] = useState([]);
  const [feed, setFeed] = useState([]);
  const [activeCalls, setActiveCalls] = useState([]);
  const [tab, setTab] = useState('dashboard');
  const [connected, setConnected] = useState(false);
  const [time, setTime] = useState(new Date().toLocaleTimeString());
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [callId, setCallId] = useState(null);
  const [history, setHistory] = useState([]);
  const [lastReply, setLastReply] = useState(null);
  const [callSummary, setCallSummary] = useState(null);
  const [dispatch, setDispatch] = useState(null);
  const [userLoc, setUserLoc] = useState([12.9716, 77.5946]);
  const [etaRemaining, setEtaRemaining] = useState(null);

  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const callIdRef = useRef(null);
  const histRef = useRef([]);
  const etaIntervalRef = useRef(null);

  useEffect(() => { callIdRef.current = callId; }, [callId]);
  useEffect(() => { histRef.current = history; }, [history]);
  useEffect(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    supabase.from('tickets').select('*').order('created_at', { ascending: false }).then(({ data }) => data && setTickets(data));
    const ch = supabase.channel('public:tickets')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, p => {
        if (p.eventType === 'INSERT') {
          setTickets(prev => [p.new, ...prev]);
          addFeed('ticket', p.new);
        } else if (p.eventType === 'UPDATE') {
          setTickets(prev => prev.map(t => t.id === p.new.id ? p.new : t));
        }
      }).subscribe(s => setConnected(s === 'SUBSCRIBED'));
    return () => supabase.removeChannel(ch);
  }, []);

  function addFeed(type, data) {
    setFeed(prev => [{ id: Date.now() + Math.random(), type, data, ts: new Date() }, ...prev].slice(0, 60));
  }

  function triggerDispatch(ticket, coords = null) {
    const loc = coords || userLoc;
    const type = getDispatchType(ticket.intent_category, ticket.summary || '');
    const services = findNearest(loc[0], loc[1], type, 1);
    if (!services.length) return;
    const svc = services[0];
    const eta = etaSeconds(svc.distKm);
    const d = { dispatchId: 'DSP-' + Date.now(), type, service: svc, userLat: loc[0], userLng: loc[1], etaSeconds: eta, startTime: Date.now() };
    setDispatch(d);
    setEtaRemaining(eta);
    setTab('map');
    if (etaIntervalRef.current) clearInterval(etaIntervalRef.current);
    addFeed('dispatch', { type, service: svc.name, eta });
  }

  async function startRec() {
    if (recording || processing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recRef.current = mr; chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size < 1000) { console.warn('Too short'); return; }
        await sendVoice(blob);
      };
      mr.start(); setRecording(true);
    } catch (e) { alert('Microphone error: ' + e.message); }
  }

  function stopRec() {
    if (recRef.current && recording) {
      recRef.current.stop();
      recRef.current.stream.getTracks().forEach(t => t.stop());
      setRecording(false);
    }
  }

  async function sendVoice(blob) {
    const id = callIdRef.current || ('voice-' + Date.now());
    if (!callIdRef.current) { callIdRef.current = id; setCallId(id); }
    setProcessing(true);
    setActiveCalls(prev => prev.includes(id) ? prev : [...prev, id]);
    addFeed('status', { status: 'PROCESSING', call_id: id });
    
    const fd = new FormData();
    fd.append('audio', blob, 'recording.webm');
    fd.append('call_id', id);
    fd.append('history', JSON.stringify(histRef.current));
    
    try {
      const res = await fetch(`${API}/api/calls/voice`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      
      if (data.success) {
        addFeed('status', { status: 'TRANSCRIPT', call_id: id, transcript: data.transcript, ai_reply: data.ai_confirmation });
        setLastReply({ text: data.ai_confirmation, lang: data.language || 'en' });
        
        const nh = [...histRef.current, { role: 'user', text: data.transcript }, { role: 'assistant', text: data.ai_confirmation }];
        histRef.current = nh; setHistory(nh);

        const locationText = data.location_raw || data.landmark || data.district;
        if (locationText) {
          addFeed('location', { status: 'GEOCODING', location: locationText, call_id: id });
          geocodeLocation(locationText).then(geo => {
            if (geo) {
              const newCoords = [geo.lat, geo.lng];
              setUserLoc(newCoords);
              addFeed('location', { status: 'LOCATION_FOUND', location: locationText, display: geo.display, lat: geo.lat, lng: geo.lng, call_id: id });
              if ((data.dispatch_type && data.dispatch_type !== 'none') || data.needs_escalation) {
                triggerDispatch({ intent_category: data.ticket?.intent_category || 'other', summary: data.ticket?.summary || '' }, newCoords);
              }
            } else {
              addFeed('location', { status: 'GEOCODE_FAILED', location: locationText, call_id: id });
            }
          });
        }

        if (data.ai_confirmation) {
          await playTTS(data.ai_confirmation, data.language || 'en', API);
        }
      } else {
        addFeed('status', { status: 'ERROR', call_id: id, transcript: data.error });
      }
    } catch (e) { 
      addFeed('status', { status: 'ERROR', call_id: id, transcript: e.message }); 
    } finally { 
      setProcessing(false); 
    }
  }

  async function endCall() {
    const id = callIdRef.current;
    setActiveCalls(prev => prev.filter(c => c !== id));
    
    const currentHistory = histRef.current;
    if (currentHistory.length > 0) {
      setCallSummary("Generating summary...");
      try {
        const res = await fetch(`${API}/api/calls/summarize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: currentHistory })
        });
        const data = await res.json();
        setCallSummary(data.summary);
      } catch (e) {
        setCallSummary("Failed to generate summary.");
      }
    }
    
    callIdRef.current = null; histRef.current = [];
    setCallId(null); setHistory([]); setLastReply(null);
    if (id) addFeed('status', { status: 'ENDED', call_id: id });
  }

  if (loading) {
    return <LoadingScreen onComplete={() => setLoading(false)} />;
  }

  const open = tickets.filter(t => t.status === 'OPEN').length;
  const esc = tickets.filter(t => t.status === 'ESCALATED').length;
  const avgConf = tickets.length ? Math.round(tickets.reduce((s, t) => s + (t.confidence || 0), 0) / tickets.length) : 0;
  const micLabel = processing ? '⏳ Processing…' : recording ? '🔴 Recording…' : '🎙️ Hold to Speak';
  const TYPE_EMOJI = { fire: '🔥', ambulance: '🚑', police: '🚔', rescue: '🚁' };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      
      {/* ── SIDEBAR ── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-logo">
            <img src="/favicon.svg" alt="VoiceBridge" className="brand-img" />
            <div>
              <div className="brand-name">VoiceBridge</div>
              <div className="brand-sub">1092 AI Helpline</div>
            </div>
          </div>
          <div className="ws-status">
            <span className={`ws-dot ${connected ? 'connected' : 'error'}`} />
            <span>{connected ? 'System Online' : 'Connecting…'}</span>
          </div>
        </div>
        
        <nav className="sidebar-nav">
          {[
            ['dashboard', '⚡', 'Live Dashboard', null],
            ['tickets', '🎫', 'Tickets', open],
            ['escalations', '🚨', 'Escalations', esc],
            ['map', '🗺️', 'Emergency Map', dispatch ? '!' : null]
          ].map(([id, icon, label, badge]) => (
            <button key={id} className={`nav-item ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              <span className="nav-icon">{icon}</span>
              <span style={{ flex: 1 }}>{label}</span>
              {badge != null && <span className={`nav-badge ${badge === '!' ? 'urgent' : ''}`}>{badge}</span>}
            </button>
          ))}
        </nav>
        
        <div className="sidebar-footer">
          <div className="agent-card">
            <div className="agent-avatar">AG</div>
            <div>
              <div className="agent-name">Agent 8512</div>
              <div className="agent-role">SUPERVISOR</div>
            </div>
          </div>
        </div>
      </aside>

      {/* ── MAIN CONTENT ── */}
      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <h1 className="page-title">
              {tab === 'dashboard' ? 'Live Dashboard' : 
               tab === 'tickets' ? 'All Tickets' : 
               tab === 'escalations' ? 'Active Escalations' : 'Emergency Map'}
            </h1>
            <div className="breadcrumb">
              {tab === 'map' && dispatch ? `${TYPE_EMOJI[dispatch.type] || '🚨'} ${dispatch.type.toUpperCase()} UNIT DISPATCHED` : 'Real-time monitoring'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
            <div className="live-clock">{time}</div>
            
            {callId && (
              <button className="btn btn-ghost" onClick={endCall} disabled={processing} style={{ color: '#ef4444', borderColor: '#ef4444' }}>
                End Call
              </button>
            )}
            
            <button 
              className={`btn mic-btn ${recording ? 'recording' : 'btn-primary'}`} 
              onMouseDown={startRec} onMouseUp={stopRec} 
              onTouchStart={startRec} onTouchEnd={stopRec} 
              disabled={processing}
              style={{ padding: '12px 24px', opacity: processing ? 0.6 : 1, cursor: processing ? 'not-allowed' : 'pointer' }}
            >
              {micLabel}
            </button>
          </div>
        </header>

        <div className="view">
          
          {/* ── DASHBOARD TAB ── */}
          {tab === 'dashboard' && <>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon blue">📞</div>
                <div className="stat-body">
                  <div className="stat-value">{activeCalls.length}</div>
                  <div className="stat-label">Active Calls</div>
                </div>
                {activeCalls.length > 0 && <div className="stat-pulse" />}
              </div>
              <div className="stat-card">
                <div className="stat-icon yellow">🎫</div>
                <div className="stat-body">
                  <div className="stat-value">{open}</div>
                  <div className="stat-label">Open Tickets</div>
                </div>
              </div>
              <div className="stat-card danger">
                <div className="stat-icon red">🚨</div>
                <div className="stat-body">
                  <div className="stat-value">{esc}</div>
                  <div className="stat-label">Escalations</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon green">✅</div>
                <div className="stat-body">
                  <div className="stat-value">{avgConf}%</div>
                  <div className="stat-label">Avg Confidence</div>
                </div>
              </div>
            </div>

            {lastReply && (
              <div className="ai-banner">
                <span className="banner-icon">🤖</span>
                <div>
                  <div className="banner-title" style={{ color: '#06b6d4' }}>Last AI Reply</div>
                  <div className="banner-text">{lastReply.text}</div>
                </div>
              </div>
            )}

            {callSummary && (
              <div className="summary-banner">
                <span className="banner-icon">📝</span>
                <div>
                  <div className="banner-title" style={{ color: '#10b981' }}>Call Summary</div>
                  <div className="banner-text">{callSummary}</div>
                </div>
              </div>
            )}

            <div className="two-col">
              <section className="card">
                <div className="card-header">
                  <h2 className="card-title">⚡ Live Feed</h2>
                  <button className="btn btn-ghost btn-sm" onClick={() => setFeed([])}>Clear</button>
                </div>
                <div className="event-feed">
                  {!feed.length && <div className="feed-empty" style={{ textAlign: 'center', color: '#94a3b8', padding: '40px' }}>Waiting for events…</div>}
                  {feed.map(ev => (
                    <div key={ev.id} className={`feed-item ${ev.type}`}>
                      <div className="feed-icon">{ev.type === 'ticket' ? '🎫' : ev.type === 'dispatch' ? '🚨' : ev.type === 'location' ? '📍' : '📞'}</div>
                      <div className="feed-content">
                        {ev.type === 'ticket' && <><div className="feed-text"><b>New Ticket:</b> {ev.data.intent_category} — <span style={{ color: EMOTION_COLOR[ev.data.emotion] || '#94a3b8' }}>{ev.data.emotion}</span></div><div className="feed-subtext">{ev.data.summary}</div></>}
                        {ev.type === 'dispatch' && <><div className="feed-text"><b>🚨 Dispatch:</b> {TYPE_EMOJI[ev.data.type] || '🚨'} {ev.data.type}</div><div className="feed-subtext" style={{ color: '#f59e0b' }}>{ev.data.service} — ETA {Math.round(ev.data.eta / 60)}m</div></>}
                        {ev.type === 'location' && (
                          ev.data.status === 'GEOCODING'
                            ? <div className="feed-text" style={{ color: '#94a3b8' }}>⏳ Locating: <em>"{ev.data.location}"</em></div>
                            : ev.data.status === 'LOCATION_FOUND'
                              ? <><div className="feed-text"><b style={{ color: '#10b981' }}>📍 Location Found:</b> {ev.data.location}</div><div className="feed-subtext">{ev.data.lat?.toFixed(4)}, {ev.data.lng?.toFixed(4)}</div></>
                              : <div className="feed-text" style={{ color: '#f59e0b' }}>⚠️ Could not locate: "{ev.data.location}"</div>
                        )}
                        {ev.type === 'status' && <><div className="feed-text"><b>Call:</b> {ev.data.status}</div>
                          {ev.data.transcript && <div className="feed-subtext" style={{ fontStyle: 'italic' }}>🗣️ "{ev.data.transcript}"</div>}
                          {ev.data.ai_reply && <div className="feed-subtext" style={{ color: '#38bdf8' }}>🤖 "{ev.data.ai_reply}"</div>}</>}
                        <div className="feed-time">{ev.ts.toLocaleTimeString()}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="card">
                <div className="card-header">
                  <h2 className="card-title">📞 Active Call Context</h2>
                  {activeCalls.length > 0 && <span className="badge live">LIVE</span>}
                </div>
                <div className="active-calls">
                  {!activeCalls.length && <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px' }}>No active calls</div>}
                  {activeCalls.map(id => (
                    <div key={id} className="call-item">
                      <div className="call-header">
                        <span className="call-phone">ID: {id.substring(0, 16)}...</span>
                        <span className="badge" style={{ background: 'rgba(59, 130, 246, 0.2)', color: '#60a5fa' }}>IN PROGRESS</span>
                      </div>
                    </div>
                  ))}
                </div>
                {callId && history.length > 0 && (
                  <div className="chat-log" style={{ padding: '0 16px 16px' }}>
                    {history.slice(-6).map((t, i) => (
                      <div key={i} className={`chat-bubble ${t.role === 'user' ? 'user' : 'ai'}`}>
                        <div style={{ fontSize: '10px', fontWeight: 'bold', marginBottom: '4px', textTransform: 'uppercase', opacity: 0.8 }}>
                          {t.role === 'user' ? 'Caller' : 'AI'}
                        </div>
                        {t.text}
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
                    {tickets.slice(0, 12).map(t => (
                      <tr key={t.id}>
                        <td className="ticket-id">{t.id.substring(0, 8)}</td>
                        <td><span className="badge">{t.intent_category || '—'}</span></td>
                        <td className="summary-cell" title={t.summary}>{t.summary}</td>
                        <td><span className="badge" style={{ background: EMOTION_COLOR[t.emotion] || 'transparent', borderColor: EMOTION_COLOR[t.emotion] || '#334155' }}>{t.emotion || '—'}</span></td>
                        <td><span className="badge badge-lang">{t.language || 'en'}</span></td>
                        <td>
                          <div className="conf-bar"><div className="conf-fill" style={{ width: `${t.confidence || 0}%`, background: t.confidence > 70 ? '#10b981' : t.confidence > 40 ? '#f59e0b' : '#ef4444' }} /></div>
                          <span style={{ fontSize: 12, fontWeight: 600 }}>{Math.round(t.confidence || 0)}%</span>
                        </td>
                        <td><span className="badge" style={{ color: STATUS_COLOR[t.status] || '#94a3b8' }}>{t.status || 'OPEN'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>}

          {/* ── TICKETS TAB ── */}
          {tab === 'tickets' && <section className="card">
            <div className="card-header"><h2 className="card-title">🎫 All Tickets</h2></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>ID</th><th>Intent</th><th>Summary</th><th>Emotion</th><th>Lang</th><th>Status</th></tr></thead>
                <tbody>
                  {tickets.map(t => (
                    <tr key={t.id}>
                      <td className="ticket-id">{t.id.substring(0, 8)}</td>
                      <td><span className="badge">{t.intent_category || '—'}</span></td>
                      <td className="summary-cell" title={t.summary}>{t.summary}</td>
                      <td><span className="badge" style={{ background: EMOTION_COLOR[t.emotion] || 'transparent' }}>{t.emotion || '—'}</span></td>
                      <td><span className="badge badge-lang">{t.language || 'en'}</span></td>
                      <td><span className="badge" style={{ color: STATUS_COLOR[t.status] || '#fff' }}>{t.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>}

          {/* ── ESCALATIONS TAB ── */}
          {tab === 'escalations' && <div className="esc-grid">
            {!esc && <div style={{ textAlign: 'center', padding: '60px', color: '#64748b', gridColumn: '1 / -1' }}><div style={{ fontSize: 64 }}>✅</div><div style={{ fontSize: 18, marginTop: 16 }}>No active escalations</div></div>}
            {tickets.filter(t => t.status === 'ESCALATED').map(t => (
              <div key={t.id} className="esc-card">
                <div className="esc-header">
                  <div className="esc-title">🚨 {t.intent_category?.toUpperCase().replace('_', ' ')}</div>
                  <span className="badge" style={{ background: EMOTION_COLOR[t.emotion] || 'transparent' }}>{t.emotion}</span>
                </div>
                <div className="esc-summary">{t.summary}</div>
                <div className="esc-meta">
                  {t.district && <span className="esc-tag">📍 {t.district}</span>}
                  <span className="esc-tag">🌐 {t.language}</span>
                  <span className="esc-tag">🕒 {new Date(t.created_at).toLocaleTimeString()}</span>
                </div>
                <button className="btn btn-danger" style={{ width: '100%' }} onClick={() => triggerDispatch(t)}>
                  Dispatch Emergency Unit
                </button>
              </div>
            ))}
          </div>}

          {/* ── MAP TAB ── */}
          {tab === 'map' && <div style={{ display: 'flex', gap: '24px', height: 'calc(100vh - 140px)' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <EmergencyMap dispatch={dispatch} userLocation={userLoc} onEtaUpdate={(secs) => setEtaRemaining(secs)} />
            </div>
            
            <div style={{ width: '340px', display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto', paddingRight: '4px' }}>
              {dispatch ? (
                <div className="dispatch-panel dispatch-active">
                  <div style={{ color: '#ef4444', fontWeight: 800, fontSize: '18px', marginBottom: '8px' }}>
                    {TYPE_EMOJI[dispatch.type] || '🚨'} {dispatch.type.toUpperCase()} DISPATCHED
                  </div>
                  <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '16px' }}>ID: {dispatch.dispatchId}</div>
                  
                  <div style={{ background: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '8px', marginBottom: '16px' }}>
                    <div style={{ color: '#64748b', fontSize: '12px' }}>RESPONDING UNIT</div>
                    <div style={{ color: '#f8fafc', fontWeight: 600, marginTop: '4px' }}>{dispatch.service.name}</div>
                  </div>
                  
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: '#64748b', fontSize: '12px', fontWeight: 700, letterSpacing: '1px' }}>ESTIMATED TIME OF ARRIVAL</div>
                    <div className="eta-display" style={{ color: etaRemaining === 0 ? '#10b981' : '#f59e0b' }}>
                      {etaRemaining === 0 ? 'ARRIVED ✅' : `${Math.floor(etaRemaining / 60)}m ${etaRemaining % 60}s`}
                    </div>
                  </div>
                  
                  <button className="btn btn-ghost" style={{ width: '100%' }} onClick={() => setDispatch(null)}>
                    Clear Dispatch
                  </button>
                </div>
              ) : (
                <div className="dispatch-panel">
                  <div style={{ color: '#38bdf8', fontWeight: 700, fontSize: '16px', marginBottom: '16px' }}>🗺️ Manual Dispatch Simulator</div>
                  <div style={{ color: '#94a3b8', fontSize: '13.5px', marginBottom: '20px', lineHeight: 1.5 }}>
                    Select an emergency type below to simulate an automated dispatch from the nearest available unit.
                  </div>
                  
                  {['fire', 'ambulance', 'police', 'rescue'].map(type => (
                    <button key={type} className="btn btn-ghost" style={{ display: 'flex', width: '100%', marginBottom: '10px', justifyContent: 'flex-start' }}
                      onClick={() => triggerDispatch({ intent_category: type === 'ambulance' ? 'medical' : type, summary: type })}>
                      <span style={{ fontSize: '18px', marginRight: '8px' }}>{TYPE_EMOJI[type] || '🚨'}</span> 
                      Dispatch {type.charAt(0).toUpperCase() + type.slice(1)}
                    </button>
                  ))}
                </div>
              )}
              
              <div className="dispatch-panel">
                <div style={{ color: '#38bdf8', fontWeight: 600, fontSize: '14px', marginBottom: '12px' }}>📍 Current Location Context</div>
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px' }}>
                  <div style={{ color: '#94a3b8', fontSize: '13px', fontFamily: 'monospace' }}>Lat: {userLoc[0].toFixed(5)}</div>
                  <div style={{ color: '#94a3b8', fontSize: '13px', fontFamily: 'monospace', marginTop: '4px' }}>Lng: {userLoc[1].toFixed(5)}</div>
                  <div style={{ color: '#64748b', fontSize: '12px', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    Bengaluru, Karnataka
                  </div>
                </div>
              </div>
            </div>
          </div>}

        </div>
      </main>
    </div>
  );
}
