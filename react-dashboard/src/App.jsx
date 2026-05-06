import React, { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import './index.css';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export default function App() {
  const [tickets, setTickets] = useState([]);
  const [feedEvents, setFeedEvents] = useState([]);
  const [activeCalls, setActiveCalls] = useState([]);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isConnected, setIsConnected] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date().toLocaleTimeString());

  // Stats
  const openTicketsCount = tickets.filter(t => t.status === 'OPEN').length;
  const escalatedCount = tickets.filter(t => t.status === 'ESCALATED').length;
  const avgConfidence = tickets.length > 0 
    ? Math.round(tickets.reduce((sum, t) => sum + (t.confidence || 0), 0) / tickets.length) 
    : 0;

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      const { data } = await supabase.from('tickets').select('*').order('created_at', { ascending: false });
      if (data) setTickets(data);
    };
    fetchData();

    const channel = supabase
      .channel('public:tickets')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, payload => {
        if (payload.eventType === 'INSERT') {
          setTickets(prev => [payload.new, ...prev]);
          addFeedEvent('new_ticket', payload.new);
        } else if (payload.eventType === 'UPDATE') {
          setTickets(prev => prev.map(t => t.id === payload.new.id ? payload.new : t));
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setIsConnected(true);
        else setIsConnected(false);
      });

    return () => supabase.removeChannel(channel);
  }, []);

  const addFeedEvent = (type, data) => {
    setFeedEvents(prev => [{
      id: Date.now().toString(),
      type,
      data,
      timestamp: new Date()
    }, ...prev].slice(0, 50));
  };

  // Microphone Recording State
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  // Session State
  const [currentCallId, setCurrentCallId] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        // Prevent sending empty or extremely short audio which causes Groq 400 errors
        if (audioBlob.size < 1000) {
          console.warn("Audio too short, skipping...");
          return;
        }
        await sendVoiceToBackend(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Microphone access denied or error:", err);
      alert("Microphone access is required to use the real voice feature.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
    }
  };

  const sendVoiceToBackend = async (audioBlob) => {
    const callId = currentCallId || "voice-" + Math.floor(Math.random()*1000);
    if (!currentCallId) setCurrentCallId(callId);

    addFeedEvent('call_status', { status: 'PROCESSING_AUDIO', call_id: callId });
    setActiveCalls(prev => prev.includes(callId) ? prev : [...prev, callId]);
    
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    formData.append('call_id', callId);
    formData.append('history', JSON.stringify(conversationHistory));
    
    try {
      const res = await fetch('http://localhost:8000/api/calls/voice', {
        method: 'POST',
        body: formData
      });
      
      const data = await res.json();
      if (data.success) {
        addFeedEvent('call_status', { 
          status: 'TRANSCRIPT', 
          call_id: callId, 
          transcript: data.transcript,
          ai_reply: data.ai_confirmation 
        });
        
        setConversationHistory(prev => [
          ...prev,
          { role: 'user', text: data.transcript },
          { role: 'assistant', text: data.ai_confirmation }
        ]);

        // Play audio using our Backend TTS Proxy (Bypasses Brave Shields)
        const playCloudTTS = async (text) => {
          // Split into sentences to avoid limit of Google TTS
          const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
          for (let sentence of sentences) {
            if (!sentence.trim()) continue;
            const url = `http://localhost:8000/api/tts?text=${encodeURIComponent(sentence.trim())}`;
            const audio = new Audio(url);
            await new Promise(resolve => {
              audio.onended = resolve;
              audio.onerror = resolve;
              audio.play().catch(err => {
                console.error("Audio playback failed (Brave autoplay blocker?):", err);
                resolve();
              });
            });
          }
        };

        playCloudTTS(data.ai_confirmation);
      } else {
        console.error("Backend failed:", data.error);
        addFeedEvent('call_status', { status: 'ERROR', call_id: callId, transcript: "Failed to process audio." });
      }
    } catch (e) {
      console.error("Failed to process voice:", e);
      addFeedEvent('call_status', { status: 'ERROR', call_id: callId, transcript: "Network Error" });
    } finally {
      // Keep in activeCalls since session is ongoing, but maybe remove processing status
    }
  };

  const endCallSession = () => {
    setActiveCalls(prev => prev.filter(id => id !== currentCallId));
    setCurrentCallId(null);
    setConversationHistory([]);
    addFeedEvent('call_status', { status: 'CALL_ENDED', call_id: currentCallId });
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', backgroundColor: '#0f172a', color: '#f8fafc' }}>
      
      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-logo">
            <span className="brand-icon">📡</span>
            <div>
              <div className="brand-name">VoiceBridge</div>
              <div className="brand-sub">1092 Karnataka Helpline</div>
            </div>
          </div>
          <div className="ws-status">
            <span className={`ws-dot ${isConnected ? 'connected' : 'error'}`}></span>
            <span>{isConnected ? 'Live (Supabase)' : 'Connecting...'}</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <button className={`nav-item ${activeTab==='dashboard'?'active':''}`} onClick={()=>setActiveTab('dashboard')}>
            <span className="nav-icon">⚡</span> Live Dashboard
          </button>
          <button className={`nav-item ${activeTab==='tickets'?'active':''}`} onClick={()=>setActiveTab('tickets')}>
            <span className="nav-icon">🎫</span> Tickets
            <span className="nav-badge">{openTicketsCount}</span>
          </button>
          <button className={`nav-item ${activeTab==='escalations'?'active':''}`} onClick={()=>setActiveTab('escalations')}>
            <span className="nav-icon">🚨</span> Escalations
            <span className="nav-badge urgent">{escalatedCount}</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="agent-card">
            <div className="agent-avatar">A</div>
            <div>
              <div className="agent-name">Agent 8512</div>
              <div className="agent-role">SUPERVISOR</div>
            </div>
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <h1 className="page-title">Live Dashboard</h1>
            <div className="breadcrumb">Real-time call monitoring</div>
          </div>
          <div className="topbar-right" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <div className="live-clock">{currentTime}</div>
            {currentCallId && (
              <button 
                className="btn btn-ghost" 
                onClick={endCallSession}
                style={{ padding: '0.75rem 1.5rem', border: '1px solid #ef4444', color: '#ef4444' }}
              >
                <span>End Call</span>
              </button>
            )}
            <button 
              className={`btn ${isRecording ? 'btn-danger' : 'btn-ghost'}`} 
              onMouseDown={startRecording} 
              onMouseUp={stopRecording}
              onMouseLeave={stopRecording}
              style={{ padding: '0.75rem 1.5rem', background: isRecording ? '#ef4444' : '#1e293b' }}
            >
              <span>{isRecording ? '🔴 Recording...' : '🎙️ Hold to Speak'}</span>
            </button>
          </div>
        </header>

        <div className="view">
          {/* STATS */}
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-icon blue">📞</div>
              <div className="stat-body">
                <div className="stat-value">{activeCalls.length}</div>
                <div className="stat-label">Active Calls</div>
              </div>
              {activeCalls.length > 0 && <div className="stat-pulse"></div>}
            </div>
            <div className="stat-card">
              <div className="stat-icon yellow">🎫</div>
              <div className="stat-body">
                <div className="stat-value">{openTicketsCount}</div>
                <div className="stat-label">Open Tickets</div>
              </div>
            </div>
            <div className="stat-card danger">
              <div className="stat-icon red">🚨</div>
              <div className="stat-body">
                <div className="stat-value">{escalatedCount}</div>
                <div className="stat-label">Escalations</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon green">✅</div>
              <div className="stat-body">
                <div className="stat-value">{avgConfidence}%</div>
                <div className="stat-label">Avg Confidence</div>
              </div>
            </div>
          </div>

          <div className="two-col">
            {/* FEED */}
            <section className="card">
              <div className="card-header">
                <h2 className="card-title">⚡ Live Event Feed</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setFeedEvents([])}>Clear</button>
              </div>
              <div className="event-feed">
                {feedEvents.length === 0 ? <div className="feed-empty">Waiting for events…</div> : 
                  feedEvents.map(ev => (
                    <div key={ev.id} className={`feed-item ${ev.type}`}>
                      <div className="feed-icon">{ev.type === 'new_ticket' ? '🎫' : '📞'}</div>
                      <div>
                        {ev.type === 'new_ticket' ? (
                          <>
                            <div className="feed-text"><strong>New Ticket:</strong> {ev.data.intent_category} ({ev.data.language})</div>
                            <div className="feed-text" style={{color:'var(--muted)'}}>{ev.data.summary}</div>
                          </>
                        ) : (
                          <>
                            <div className="feed-text"><strong>Call Status:</strong> {ev.data.status} ({ev.data.call_id})</div>
                            {ev.data.transcript && <div className="feed-text" style={{fontStyle:'italic', color:'#94a3b8', marginTop: '4px'}}>🗣️ You: "{ev.data.transcript}"</div>}
                            {ev.data.ai_reply && <div className="feed-text" style={{color:'#38bdf8', marginTop: '4px'}}>🤖 AI: "{ev.data.ai_reply}"</div>}
                          </>
                        )}
                        <div className="feed-time">{ev.timestamp.toLocaleTimeString()}</div>
                      </div>
                    </div>
                  ))
                }
              </div>
            </section>

            {/* ACTIVE CALLS */}
            <section className="card">
              <div className="card-header">
                <h2 className="card-title">📞 Active Calls</h2>
                <span className="badge live">LIVE</span>
              </div>
              <div className="active-calls">
                {activeCalls.length === 0 ? <div className="feed-empty">No active calls</div> : 
                  activeCalls.map(call => (
                    <div key={call} className="call-item">
                      <div className="call-header">
                        <span className="call-phone">Call ID: {call}</span>
                        <span className="badge live">IN PROGRESS</span>
                      </div>
                    </div>
                  ))
                }
              </div>
            </section>
          </div>

          {/* TABLE */}
          <section className="card mt-4">
            <div className="card-header">
              <h2 className="card-title">🎫 Recent Tickets</h2>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>ID</th><th>Intent</th><th>Summary</th>
                    <th>Emotion</th><th>Lang</th><th>Conf</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.slice(0, 10).map(t => (
                    <tr key={t.id}>
                      <td className="ticket-id">{t.id.substring(0,8)}</td>
                      <td><span className="badge">{t.intent_category || 'Unknown'}</span></td>
                      <td className="summary-cell" title={t.summary}>{t.summary}</td>
                      <td><span className={`badge badge-emotion-${t.emotion || 'LOW'}`}>{t.emotion || 'LOW'}</span></td>
                      <td><span className="badge badge-lang">{t.language || 'en'}</span></td>
                      <td>
                        <div className="conf-bar">
                          <div className="conf-fill" style={{width: `${t.confidence||0}%`, background: t.confidence>70?'#22c55e':t.confidence>40?'#f59e0b':'#ef4444'}}></div>
                        </div>
                        <span style={{fontSize:'11px'}}>{Math.round(t.confidence||0)}%</span>
                      </td>
                      <td><span className={`badge badge-status-${t.status || 'OPEN'}`}>{t.status || 'OPEN'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

        </div>
      </main>
    </div>
  );
}
