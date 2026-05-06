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

  try {
    console.log("Received voice audio chunk...");
    
    // Rename the file to include .webm extension so Groq STT can recognize the format
    const fs = require('fs');
    const path = require('path');
    const newFilePath = req.file.path + '.webm';
    fs.renameSync(req.file.path, newFilePath);

    // 1. STT: Transcribe the audio via Whisper
    const transcript = await transcribeAudio(newFilePath);
    console.log("Transcription:", transcript);

    // 2. LLM: Send to Claude
    const analysis = await analyzeTranscript(transcript, 'en');

    // 3. Format for Supabase
    const newTicket = {
      call_id: "voice-call-" + Math.floor(Math.random() * 1000),
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

    // 4. Insert into Supabase
    const { data, error } = await supabase.from('tickets').insert([newTicket]).select();
    
    if (error) throw error;
    
    res.json({
      success: true,
      ticket: data[0],
      transcript: transcript,
      ai_confirmation: analysis.confirmation_sentence
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

// Start Server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
