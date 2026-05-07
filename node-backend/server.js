const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Admin Client (Bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Node.js Backend is running' });
});

const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const { analyzeTranscript, summarizeConversation } = require('./services/llm');
const { transcribeAudio } = require('./services/stt');

// Example route to fetch tickets
app.get('/api/tickets', async (req, res) => {
  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Real voice pipeline — multilingual
app.post('/api/calls/voice', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });

  const call_id = req.body.call_id || "voice-call-" + Math.floor(Math.random() * 1000);
  let sessionHistory = [];
  try {
    if (req.body.history) sessionHistory = JSON.parse(req.body.history);
  } catch (e) {
    console.error("Could not parse history", e);
  }

  const newFilePath = req.file.path + '.webm';

  try {
    console.log(`Received voice audio chunk for call ${call_id}...`);

    // Rename the file to include .webm extension so Groq STT can recognize the format
    const fs = require('fs');
    const path = require('path');
    fs.renameSync(req.file.path, newFilePath);

    // 1. STT: Transcribe audio — Whisper auto-detects language
    const sttResult = await transcribeAudio(newFilePath);
    const transcript = sttResult.text;
    const detectedLanguage = sttResult.language; // e.g. 'kn', 'hi', 'ta', 'te', 'ml', 'en'
    console.log(`Transcription [${detectedLanguage}]:`, transcript);

    // 2. LLM: Analyze with DETECTED language — enables multilingual helpline_reply
    const analysis = await analyzeTranscript(transcript, detectedLanguage, sessionHistory);

    // 3. Format for Supabase
    const newTicket = {
      call_id: call_id,
      intent_category: analysis.intent_category,
      intent_subtype: analysis.intent_subtype,
      summary: analysis.summary,
      emotion: analysis.emotion,
      confidence: analysis.confidence,
      language: analysis.language_detected || 'en',
      location_raw: analysis.location_raw,
      district: analysis.district,
      cultural_context: analysis.cultural_context,
      urgency_cues: analysis.urgency_cues || [],
      status: analysis.needs_escalation ? 'ESCALATED' : 'OPEN'
    };

    // 4. Update or Insert into Supabase
    let ticketData;
    const { data: existing } = await supabase.from('tickets').select('id').eq('call_id', call_id).maybeSingle();
    
    if (existing) {
      const { data, error } = await supabase.from('tickets').update(newTicket).eq('id', existing.id).select();
      if (error) throw error;
      ticketData = data[0];
    } else {
      const { data, error } = await supabase.from('tickets').insert([newTicket]).select();
      if (error) throw error;
      ticketData = data[0];
    }
    
    res.json({
      success: true,
      ticket: ticketData,
      transcript: transcript,
      ai_confirmation: analysis.helpline_reply,
      // Location + dispatch info for real-time map updates
      location_raw: analysis.location_raw || null,
      landmark: analysis.landmark || null,
      district: analysis.district || null,
      dispatch_type: analysis.dispatch_type || 'none',
      needs_escalation: analysis.needs_escalation || false,
      language: analysis.language_detected || 'en',
    });

  } catch (error) {
    console.error("Voice pipeline error:", error);
    res.status(500).json({ error: "Failed to process voice pipeline" });
  } finally {
    // Clean up the uploaded files
    const fs = require('fs');
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    if (newFilePath && fs.existsSync(newFilePath)) {
      fs.unlinkSync(newFilePath);
    }
  }
});

// Summarize Call API
app.post('/api/calls/summarize', async (req, res) => {
  const { history } = req.body;
  if (!history || !Array.isArray(history) || history.length === 0) {
    return res.json({ summary: "No conversation history available to summarize." });
  }
  try {
    const summary = await summarizeConversation(history);
    res.json({ summary });
  } catch (error) {
    console.error("Summarize error:", error);
    res.status(500).json({ error: "Failed to summarize conversation" });
  }
});

// Simulate a full call pipeline
app.post('/api/calls/simulate', async (req, res) => {
  const { transcript, phone_number, language } = req.body;
  
  if (!transcript) return res.status(400).json({ error: "Transcript required" });

  try {
    console.log(`Processing simulated call for ${phone_number}...`);
    
    // 1. Send to Claude
    const analysis = await analyzeTranscript(transcript, language || 'en');
    
    // 2. Format for Supabase
    const newTicket = {
      call_id: "mock-call-" + Math.floor(Math.random() * 1000),
      intent_category: analysis.intent_category,
      intent_subtype: analysis.intent_subtype,
      summary: analysis.summary,
      emotion: analysis.emotion,
      confidence: analysis.confidence,
      language: analysis.language_detected || language,
      location_raw: analysis.location_raw,
      district: analysis.district,
      cultural_context: analysis.cultural_context,
      urgency_cues: analysis.urgency_cues || [],
      status: analysis.needs_escalation ? 'ESCALATED' : 'OPEN'
    };

    // 3. Insert into Supabase (will auto-trigger React frontend)
    const { data, error } = await supabase.from('tickets').insert([newTicket]).select();
    
    if (error) throw error;
    
    res.json({
      success: true,
      ticket: data[0],
      ai_confirmation: analysis.confirmation_sentence
    });

  } catch (error) {
    console.error("Simulation error:", error);
    res.status(500).json({ error: "Failed to process call pipeline" });
  }
});

// TTS Proxy Route (ElevenLabs API — Multilingual)
app.get('/api/tts', async (req, res) => {
  const { text, lang } = req.query;
  if (!text) return res.status(400).json({ error: "Text required" });

  try {
    // ElevenLabs eleven_turbo_v2_5 supports 30+ languages including all Indian languages.
    // Sarah voice (EXAVITQu4vr4xnSDxMaL) — Mature, Reassuring, Confident
    // Works natively with Kannada, Hindi, Tamil, Telugu, Malayalam, English
    const voiceId = "EXAVITQu4vr4xnSDxMaL";
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_turbo_v2_5",  // Multilingual model — auto-handles Indian scripts
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true,
        }
      })
    });

    if (!response.ok) throw new Error("ElevenLabs TTS fetch failed: " + await response.text());

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (error) {
    console.error("TTS Proxy error:", error.message);
    res.status(500).json({ error: "Failed to fetch TTS from ElevenLabs: " + error.message });
  }
});

// ── Emergency Dispatch API ────────────────────────────────────────────────────
const EMERGENCY_SERVICES = {
  fire:      [{name:'Shivajinagar Fire Station',lat:12.9862,lng:77.5996},{name:'Jayanagar Fire Station',lat:12.9250,lng:77.5938},{name:'Rajajinagar Fire Station',lat:12.9900,lng:77.5520}],
  ambulance: [{name:'Victoria Hospital',lat:12.9591,lng:77.5790},{name:'Bowring Hospital',lat:12.9767,lng:77.6064},{name:'MS Ramaiah Hospital',lat:13.0099,lng:77.5536}],
  police:    [{name:'Cubbon Park Police',lat:12.9776,lng:77.5993},{name:'High Grounds Police',lat:12.9882,lng:77.5860},{name:'Koramangala Police',lat:12.9279,lng:77.6271}],
  rescue:    [{name:'SDRF Karnataka HQ',lat:12.9716,lng:77.5236},{name:'Civil Defence Bangalore',lat:12.9640,lng:77.5810}],
};

function haversineKm(lat1,lng1,lat2,lng2){
  const R=6371,r=d=>d*Math.PI/180;
  const dLat=r(lat2-lat1),dLng=r(lng2-lng1);
  return R*2*Math.asin(Math.sqrt(Math.sin(dLat/2)**2+Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(dLng/2)**2));
}

app.post('/api/dispatch', (req, res) => {
  const { lat = 12.9716, lng = 77.5946, type = 'police', call_id } = req.body;
  const services = EMERGENCY_SERVICES[type] || EMERGENCY_SERVICES.police;
  const nearest = services
    .map(s => ({ ...s, distKm: haversineKm(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => a.distKm - b.distKm)[0];
  const etaSeconds = Math.round((nearest.distKm / 30) * 3600);
  console.log(`Dispatch: ${type} → ${nearest.name} (${nearest.distKm.toFixed(2)}km, ETA ${etaSeconds}s)`);
  res.json({
    success: true,
    dispatch: {
      dispatchId: 'DSP-' + Date.now(),
      type, service: nearest, etaSeconds,
      userLat: lat, userLng: lng, call_id,
    }
  });
});

// ── Nearest Services Lookup ───────────────────────────────────────────────────
app.get('/api/nearest', (req, res) => {
  const lat = parseFloat(req.query.lat) || 12.9716;
  const lng = parseFloat(req.query.lng) || 77.5946;
  const type = req.query.type || 'police';
  const services = (EMERGENCY_SERVICES[type] || EMERGENCY_SERVICES.police)
    .map(s => ({ ...s, distKm: haversineKm(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, 3);
  res.json({ type, services });
});

// Start Server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`✅ VoiceBridge Node backend running on port ${PORT}`);
});
