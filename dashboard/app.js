const agentId = "agent-" + Math.floor(Math.random() * 10000);
const API_BASE = "http://localhost:8000/api";
const WS_BASE = "ws://localhost:8000/api/calls/ws/dashboard";

let ws;
let allTickets = [];

// ── Init ────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initClock();
  connectWebSocket();
  loadStats();
  loadTickets();
  renderSampleFlows();
  
  // Set agent ID
  document.getElementById("agentNameSidebar").innerText = "Agent " + agentId.substring(6);
});

// ── WebSocket ───────────────────────────────────────────────────
function connectWebSocket() {
  const wsStatus = document.getElementById("wsLabel");
  const wsDot = document.getElementById("wsDot");
  
  wsStatus.innerText = "Connecting...";
  wsDot.className = "ws-dot";

  ws = new WebSocket(`${WS_BASE}/${agentId}`);

  ws.onopen = () => {
    wsStatus.innerText = "Live";
    wsDot.className = "ws-dot connected";
    showToast("Connected to live feed", "success");
    
    // Ping heartbeat
    setInterval(() => { if(ws.readyState === WebSocket.OPEN) ws.send("ping"); }, 30000);
  };

  ws.onmessage = (event) => {
    if(event.data === "pong") return;
    try {
      const payload = JSON.parse(event.data);
      handleWsEvent(payload);
    } catch(e) { console.error(e); }
  };

  ws.onclose = () => {
    wsStatus.innerText = "Disconnected";
    wsDot.className = "ws-dot error";
    setTimeout(connectWebSocket, 5000);
  };
}

function handleWsEvent({ event, data, timestamp }) {
  const feed = document.getElementById("eventFeed");
  const empty = feed.querySelector(".feed-empty");
  if(empty) empty.remove();

  const item = document.createElement("div");
  item.className = `feed-item ${event}`;
  
  const timeStr = new Date(timestamp).toLocaleTimeString();
  
  if(event === "new_ticket") {
    item.innerHTML = `
      <div class="feed-icon">🎫</div>
      <div>
        <div class="feed-text"><strong>New Ticket:</strong> ${data.intent_category} (${data.language})</div>
        <div class="feed-text" style="color:var(--muted)">${data.summary}</div>
        <div class="feed-time">${timeStr} · Caller: ${data.phone_number}</div>
      </div>
    `;
    loadStats(); // refresh counts
    loadTickets();
    showToast(`New Ticket: ${data.intent_category}`, "info");
  } 
  else if(event === "escalation") {
    item.innerHTML = `
      <div class="feed-icon">🚨</div>
      <div>
        <div class="feed-text"><strong>ESCALATION:</strong> ${data.reason}</div>
        <div class="feed-time">${timeStr} · Caller: ${data.phone_number}</div>
      </div>
    `;
    loadStats();
    addEscalationToQueue(data);
    showToast("Urgent: Call Escalated!", "error");
  }
  else if(event === "call_status") {
    item.innerHTML = `
      <div class="feed-icon">📞</div>
      <div>
        <div class="feed-text"><strong>Call Status:</strong> ${data.status}</div>
        <div class="feed-time">${timeStr} · Call: ${data.call_id}</div>
      </div>
    `;
    updateActiveCall(data);
  }
  
  feed.prepend(item);
}

// ── UI Actions ──────────────────────────────────────────────────
function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  
  document.getElementById('view' + viewId.charAt(0).toUpperCase() + viewId.slice(1)).classList.remove('hidden');
  
  const navBtn = Array.from(document.querySelectorAll('.nav-item')).find(b => b.onclick.toString().includes(viewId));
  if(navBtn) navBtn.classList.add('active');
  
  const titles = {
    'dashboard': 'Live Dashboard',
    'tickets': 'Ticket Management',
    'escalations': 'Urgent Escalations',
    'analytics': 'System Analytics',
    'flows': 'Sample Conversational Flows'
  };
  document.getElementById('pageTitle').innerText = titles[viewId] || 'Dashboard';
}

function initClock() {
  setInterval(() => {
    document.getElementById("liveClock").innerText = new Date().toLocaleTimeString('en-US', { hour12: false });
  }, 1000);
}

function showToast(msg, type="info") {
  const container = document.getElementById("toastContainer");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  let icon = "ℹ️";
  if(type==="success") icon="✅";
  if(type==="error") icon="❌";
  if(type==="warning") icon="⚠️";
  t.innerHTML = `<span>${icon}</span> <span>${msg}</span>`;
  container.appendChild(t);
  setTimeout(() => { t.style.opacity=0; setTimeout(()=>t.remove(), 300); }, 3000);
}

function clearFeed() {
  document.getElementById("eventFeed").innerHTML = '<div class="feed-empty">Waiting for events…</div>';
}

// ── API Calls ───────────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/tickets/stats`);
    if(res.ok) {
      const data = await res.json();
      document.getElementById('statOpenTickets').innerText = data.open;
      document.getElementById('statEscalated').innerText = data.escalated;
      document.getElementById('statConfidence').innerText = data.avg_confidence + "%";
      
      document.getElementById('openCount').innerText = data.open;
      document.getElementById('escCount').innerText = data.escalated;
    }
  } catch(e) { console.error("Stats fail", e); }
}

async function loadTickets() {
  try {
    const res = await fetch(`${API_BASE}/tickets?limit=20`);
    if(res.ok) {
      allTickets = await res.json();
      renderTickets();
    }
  } catch(e) { console.error("Tickets fail", e); }
}

function renderTickets() {
  const recentBody = document.getElementById("recentTicketRows");
  const fullBody = document.getElementById("ticketRows");
  
  recentBody.innerHTML = "";
  fullBody.innerHTML = "";
  
  allTickets.forEach((t, i) => {
    const rowHTML = `
      <tr>
        <td class="ticket-id">${t.id.substring(0,8)}</td>
        <td>${t.caller_name || 'Unknown'}</td>
        <td><span class="badge">${t.intent_category}</span></td>
        <td class="summary-cell" title="${t.summary}">${t.summary}</td>
        <td><span class="badge badge-emotion-${t.emotion}">${t.emotion}</span></td>
        <td><span class="badge badge-lang">${t.language}</span></td>
        <td>
          <div class="conf-bar"><div class="conf-fill" style="width:${t.confidence}%;background:${t.confidence>70?'#22c55e':t.confidence>40?'#f59e0b':'#ef4444'}"></div></div>
          <span style="font-size:11px">${Math.round(t.confidence)}%</span>
        </td>
        <td><span class="badge badge-status-${t.status}">${t.status}</span></td>
        <td><button class="btn btn-ghost btn-sm" onclick="openTicketModal('${t.id}')">View</button></td>
      </tr>
    `;
    
    if(i < 5) recentBody.innerHTML += rowHTML;
    fullBody.innerHTML += rowHTML;
  });
}

function filterTickets() {
  // basic filtering
  const s = document.getElementById('filterStatus').value;
  const e = document.getElementById('filterEmotion').value;
  const l = document.getElementById('filterLang').value;
  const d = document.getElementById('filterDistrict').value.toLowerCase();
  
  const rows = document.getElementById('ticketRows').querySelectorAll('tr');
  rows.forEach((row, i) => {
    const t = allTickets[i];
    let match = true;
    if(s && t.status !== s) match = false;
    if(e && t.emotion !== e) match = false;
    if(l && t.language !== l) match = false;
    if(d && t.district && !t.district.toLowerCase().includes(d)) match = false;
    
    row.style.display = match ? '' : 'none';
  });
}

// ── Modal ───────────────────────────────────────────────────────
let currentModalTicket = null;
function openTicketModal(id) {
  const t = allTickets.find(x => x.id === id);
  if(!t) return;
  currentModalTicket = id;
  
  let urgencyHtml = '';
  if (t.urgency_cues && t.urgency_cues.length > 0) {
    urgencyHtml = t.urgency_cues.map(c => `<span class="badge badge-emotion-HIGH">${c}</span>`).join(' ');
  } else {
    urgencyHtml = '<span class="detail-value">-</span>';
  }

  const body = document.getElementById('modalBody');
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-field">
        <span class="detail-label">Intent Category</span>
        <input type="text" id="editIntent" class="filter-input" style="width:100%" value="${t.intent_category || ''}" />
      </div>
      <div class="detail-field">
        <span class="detail-label">Subtype</span>
        <input type="text" id="editSubtype" class="filter-input" style="width:100%" value="${t.intent_subtype || ''}" />
      </div>
      
      <div class="detail-field detail-full">
        <span class="detail-label">Summary (Editable)</span>
        <textarea id="editSummary" class="filter-input" style="width:100%; height:60px;">${t.summary || ''}</textarea>
      </div>
      
      <div class="detail-field"><span class="detail-label">Emotion</span><span class="detail-value badge badge-emotion-${t.emotion}">${t.emotion}</span></div>
      <div class="detail-field"><span class="detail-label">Language</span><span class="detail-value badge badge-lang">${t.language}</span></div>
      
      <div class="detail-field">
        <span class="detail-label">Location</span>
        <input type="text" id="editLocation" class="filter-input" style="width:100%" value="${t.location_raw || ''}" />
      </div>
      <div class="detail-field">
        <span class="detail-label">District</span>
        <input type="text" id="editDistrict" class="filter-input" style="width:100%" value="${t.district || ''}" />
      </div>

      <div class="detail-field detail-full">
        <span class="detail-label">Cultural & Dialect Context</span>
        <div class="detail-summary" style="background:#f8fafc;">${t.cultural_context || 'None specified.'}</div>
      </div>

      <div class="detail-field detail-full">
        <span class="detail-label">Urgency Cues</span>
        <div>${urgencyHtml}</div>
      </div>
    </div>
  `;
  document.getElementById('ticketModal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('ticketModal').classList.add('hidden');
}

async function saveTicketEdits() {
  if (!currentModalTicket) return;
  const data = {
    intent_category: document.getElementById('editIntent').value,
    intent_subtype: document.getElementById('editSubtype').value,
    summary: document.getElementById('editSummary').value,
    location_raw: document.getElementById('editLocation').value,
    district: document.getElementById('editDistrict').value,
  };

  try {
    const res = await fetch(`${API_BASE}/tickets/${currentModalTicket}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) {
      showToast('Corrections saved to system.', 'success');
      loadTickets(); // refresh table
      closeModal();
    } else {
      showToast('Failed to save edits.', 'error');
    }
  } catch(e) {
    console.error(e);
    showToast('Network error saving edits.', 'error');
  }
}

// ── Mock Events (Simulate call) ─────────────────────────────────
function simulateCall() {
  handleWsEvent({
    event: "call_status",
    timestamp: new Date().toISOString(),
    data: { status: "ACTIVE", call_id: "mock-"+Math.floor(Math.random()*1000) }
  });
  // TTS for voice-to-voice simulation
  if ('speechSynthesis' in window) {
    const msg = new SpeechSynthesisUtterance("I understand your situation. Please hold while I create an urgent ticket.");
    window.speechSynthesis.speak(msg);
  }

  setTimeout(() => {
    handleWsEvent({
      event: "new_ticket",
      timestamp: new Date().toISOString(),
      data: {
        intent_category: "domestic_violence",
        summary: "Caller reporting physical abuse by husband. Needs immediate police help.",
        language: "kanglish",
        emotion: "HIGH",
        phone_number: "+919876543210",
        cultural_context: "Uses North Karnataka slang for 'abuse', indicating rural context.",
        urgency_cues: ["distress", "fear", "urgency"]
      }
    });
  }, 2000);
}

function simulateEscalation() {
  handleWsEvent({
    event: "escalation",
    timestamp: new Date().toISOString(),
    data: {
      reason: "Repeated timeout in confirmation loop",
      phone_number: "+918888888888",
      call_id: "mock-"+Math.floor(Math.random()*1000)
    }
  });
}

function updateActiveCall(data) {
  const activeDiv = document.getElementById("activeCalls");
  const empty = activeDiv.querySelector(".feed-empty");
  if(empty) empty.remove();
  
  if(data.status === "ACTIVE") {
    document.getElementById("statActiveCalls").innerText = parseInt(document.getElementById("statActiveCalls").innerText)+1;
    activeDiv.innerHTML += `
      <div class="call-item" id="call-${data.call_id}">
        <div class="call-header">
          <span class="call-phone">Call ID: ${data.call_id.substring(0,6)}</span>
          <span class="badge live">IN PROGRESS</span>
        </div>
      </div>
    `;
  }
}

function addEscalationToQueue(data) {
  const list = document.getElementById("escalationList");
  list.innerHTML += `
    <div class="esc-card">
      <div class="esc-card-header">
        <span class="esc-phone">${data.phone_number}</span>
        <span class="badge badge-emotion-HIGH">URGENT</span>
      </div>
      <div class="esc-reason">${data.reason}</div>
      <button class="btn btn-sm btn-danger-ghost mt-4">Take Call</button>
    </div>
  `;
}

// Sample Flows Data
function renderSampleFlows() {
  const flows = [
    {
      title: "Flow 1: Domestic Violence (Kanglish)",
      turns: [
        { role: "caller", text: "Nanna husband nannanna urididdane, please help madi. I am bleeding." },
        { role: "ai", text: "ನಾನು ಅರ್ಥಮಾಡಿಕೊಂಡಿದ್ದೇನೆ — ನಿಮ್ಮ ಪತಿ ನಿಮಗೆ ಹೊಡೆದಿದ್ದಾರೆ ಮತ್ತು ನಿಮಗೆ ರಕ್ತಸ್ರಾವವಾಗುತ್ತಿದೆ. ಇದು ಸರಿಯಾಗಿದೆಯೇ? (ಹೌದು ಅಥವಾ ಇಲ್ಲ ಎಂದು ಹೇಳಿ)" },
        { role: "caller", text: "Howdu, correct." },
        { role: "system", text: "Ticket emitted: Intent = domestic_violence | Emotion = HIGH | Conf = 92" }
      ],
      outcome: "success"
    },
    {
      title: "Flow 2: Medical Emergency (Hindi) - Refinement",
      turns: [
        { role: "caller", text: "Mere bete ko saans lene mein takleef ho rahi hai." },
        { role: "ai", text: "मैंने समझा — आपके बेटे को साँस लेने में तकलीफ हो रही है। क्या यह सही है? (हाँ या नहीं बताइए)" },
        { role: "caller", text: "Nahi, saans nahi, usey chot lagi hai sir par." },
        { role: "ai", text: "माफ़ करें, कृपया दोबारा जाँचें — आपके बेटे के सिर पर चोट लगी है। क्या यह सही है?" },
        { role: "caller", text: "Haan, right." },
        { role: "system", text: "Ticket emitted: Intent = medical | Subtype = head_injury" }
      ],
      outcome: "success"
    }
  ];
  
  const grid = document.getElementById("flowsGrid");
  flows.forEach(f => {
    let turnsHtml = f.turns.map(t => `
      <div class="turn">
        <span class="turn-role ${t.role}">${t.role}</span>
        <span class="turn-text">${t.text}</span>
      </div>
    `).join('');
    
    grid.innerHTML += `
      <div class="flow-card">
        <div class="flow-card-header"><div class="flow-title">${f.title}</div></div>
        <div class="flow-turns">${turnsHtml}</div>
        <div class="flow-outcome ${f.outcome}">Final State: ${f.outcome.toUpperCase()}</div>
      </div>
    `;
  });
}
