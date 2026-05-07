const Groq = require('groq-sdk');
const fs = require('fs');
require('dotenv').config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/**
 * Map Whisper returned language codes → our Language enum
 */
const WHISPER_LANG_MAP = {
  'kannada': 'kn',     'kn': 'kn',
  'hindi': 'hi',       'hi': 'hi',
  'english': 'en',     'en': 'en',
  'tamil': 'ta',       'ta': 'ta',
  'telugu': 'te',      'te': 'te',
  'malayalam': 'ml',   'ml': 'ml',
  'marathi': 'mr',     'mr': 'mr',
  'bengali': 'hi',     'bn': 'hi',     // Fallback
  'gujarati': 'hi',    'gu': 'hi',     // Fallback
  'punjabi': 'hi',     'pa': 'hi',     // Fallback
};

/**
 * Transcribe audio and detect language
 * Returns { text, language } where language is our enum code
 */
async function transcribeAudio(filePath) {
  try {
    console.log('Transcribing audio file via Groq Whisper large-v3 (multilingual)...');
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-large-v3',
      response_format: 'verbose_json',  // Get language detection info
    });

    // Extract language from verbose response
    const rawLang = (transcription.language || 'en').toLowerCase();
    const mappedLang = WHISPER_LANG_MAP[rawLang] || 'en';

    console.log(`✅ STT Complete | lang_detected="${rawLang}" → mapped="${mappedLang}" | chars=${transcription.text.length}`);

    return {
      text: transcription.text,
      language: mappedLang,
      raw_language: rawLang,
    };

  } catch (error) {
    console.error('Groq STT Error:', error);
    throw error;
  }
}

module.exports = { transcribeAudio };
