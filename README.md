# 🎙️ AI VoiceBridge 1092 — Karnataka Helpline

> A production-grade, multilingual, real-time voice AI helpline system designed for Karnataka's 1092 Women and Child Helpline.

![Node.js](https://img.shields.io/badge/Node.js-Backend-339933.svg)
![React](https://img.shields.io/badge/React-Dashboard-61DAFB.svg)
![Supabase](https://img.shields.io/badge/Supabase-Realtime_DB-3ECF8E.svg)
![Groq](https://img.shields.io/badge/AI_Engine-Groq_LPUs-f55036.svg)

---

## 🌟 Overview

AI VoiceBridge 1092 is a cutting-edge voice helpline architecture tailored to assist distressed callers. It supports multiple languages (Kannada, Hindi, English) seamlessly, capturing live microphone audio from the browser, transcribing it instantly, analyzing distress patterns and cultural context using Large Language Models, and auto-generating structured tickets on a real-time React dashboard for human operators.

---

## 🚀 Key Features

- **🎤 Live Voice-to-Voice Loop**: Speak directly into the browser microphone. The system transcribes your voice, analyzes the intent, and speaks back the confirmation sentence aloud using the Web Speech API.
- **🗣️ Multilingual & Dialect Aware**: Handles Kannada, Hindi, and English interchangeably (including Kanglish/Hinglish), and explicitly identifies cultural context and regional phrasing.
- **⚡ Blazing Fast AI via Groq**: Powered by Groq's LPUs, utilizing **Whisper-Large-v3** for transcription and **Llama-3.3-70B-Versatile** for instantaneous intent and emotion extraction.
- **🚨 Automated Urgency Detection**: Explicitly extracts emotional cues (distress, fear, panic) and flags high-urgency calls automatically.
- **🖥️ Real-Time React Dashboard**: A beautiful, dark-mode React UI that uses Supabase WebSockets to instantly display new tickets and active calls as they happen.
- **👩‍💻 Human-in-the-Loop**: Agents can edit AI-generated intents, summaries, and locations on the dashboard, proving a "learning from feedback" mechanism.

---

## 🏗️ System Architecture

1. **Frontend (React)**: The agent clicks "Hold to Speak", records audio via the `MediaRecorder` API, and POSTs the `.webm` file to the Node backend.
2. **STT (Speech-to-Text)**: Node.js sends the audio file to **Groq's Whisper API**.
3. **LLM Analysis**: The text is sent to **Groq's Llama 3.3 70B** with a strict system prompt to extract JSON data (intent, summary, emotion, dialect notes) and generate a confirmation sentence in the caller's language.
4. **Database (Supabase)**: The structured JSON ticket is inserted into a Supabase PostgreSQL database.
5. **Real-Time Update**: Supabase broadcasts an `INSERT` event over WebSockets to the React frontend.
6. **Voice Output**: The React frontend adds the ticket to the screen and uses the browser's Text-to-Speech API to literally speak the AI's confirmation to the user.

---

## 🛠️ Technology Stack

**Backend (`node-backend/`)**
- Node.js & Express.js
- Multer (File Uploads)
- Groq Node SDK
- Supabase JS SDK

**Frontend (`react-dashboard/`)**
- React.js (Vite)
- Vanilla CSS (Custom dark theme styling)
- Web Speech API (TTS)
- MediaRecorder API (Microphone)

**Database & Realtime**
- Supabase (PostgreSQL + Realtime Subscriptions)

**AI Models (Hosted on Groq)**
- `whisper-large-v3` (Transcription)
- `llama-3.3-70b-versatile` (Intelligence & Reasoning)

---

## ⚙️ Setup & Installation

### 1. Prerequisites
- Node.js (v18+)
- A free account on [Supabase](https://supabase.com)
- A free API key from [Groq](https://console.groq.com)

### 2. Environment Variables
You need two `.env` files.

**In `node-backend/.env`:**
```ini
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_KEY=your_supabase_secret_key
GROQ_API_KEY=gsk_your_groq_key
PORT=8000
```

**In `react-dashboard/.env`:**
```ini
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_publishable_key
```

### 3. Database Setup
Run the SQL found in `supabase_schema.sql` inside your Supabase SQL Editor. This will create the `tickets` and `calls` tables and enable Realtime tracking.

### 4. Installation & Running

Open two terminal windows.

**Terminal 1 (Backend):**
```bash
cd node-backend
npm install
npm start
```

**Terminal 2 (Frontend):**
```bash
cd react-dashboard
npm install
npm run dev
```

Navigate to `http://localhost:5173` in your browser. Click the **🎙️ Hold to Speak** button, talk into your microphone, and watch the system work in real-time!