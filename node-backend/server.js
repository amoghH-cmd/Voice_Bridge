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
const { analyzeTranscript } = require('./services/llm');
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

// Real voice pipeline
app.post('/api/calls/voice', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });

  const call_id = req.body.call_id || "voice-call-" + Math.floor(Math.random() * 1000);
  let sessionHistory = [];
  try {
    if (req.body.history) sessionHistory = JSON.parse(req.body.history);
  } catch (e) {
    console.error("Could not parse history", e);
  }

  try {
    console.log(`Received voice audio chunk for call ${call_id}...`);
    
    // Rename the file to include .webm extension so Groq STT can recognize the format
    const fs = require('fs');
    const path = require('path');
    const newFilePath = req.file.path + '.webm';
    fs.renameSync(req.file.path, newFilePath);

    // 1. STT: Transcribe the audio via Whisper
    const transcript = await transcribeAudio(newFilePath);
    console.log("Transcription:", transcript);

    // 2. LLM: Send to Groq Llama 3 with session history
    const analysis = await analyzeTranscript(transcript, 'en', sessionHistory);

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
      ai_confirmation: analysis.helpline_reply
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
    const newFilePath = req.file ? req.file.path + '.webm' : null;
    if (newFilePath && fs.existsSync(newFilePath)) {
      fs.unlinkSync(newFilePath);
    }
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

// TTS Proxy Route (ElevenLabs API)
app.get('/api/tts', async (req, res) => {
  const { text } = req.query;
  if (!text) return res.status(400).json({ error: "Text required" });
  
  try {
    // Sarah - Mature, Reassuring, Confident
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
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });
    
    if (!response.ok) throw new Error("ElevenLabs TTS fetch failed: " + await response.text());
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (error) {
    console.error("TTS Proxy error:", error);
    res.status(500).json({ error: "Failed to fetch TTS from ElevenLabs" });
  }
});

// Start Server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
