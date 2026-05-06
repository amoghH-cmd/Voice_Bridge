const Groq = require('groq-sdk');
const fs = require('fs');
require('dotenv').config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

async function transcribeAudio(filePath) {
  try {
    console.log("Transcribing audio file via Groq Whisper...");
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3",
    });
    
    return transcription.text;
  } catch (error) {
    console.error("Groq STT Error:", error);
    throw error;
  }
}

module.exports = { transcribeAudio };
