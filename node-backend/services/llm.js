const Groq = require('groq-sdk');
const { SYSTEM_PROMPT, buildAnalysisPrompt } = require('./prompts');
require('dotenv').config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/**
 * Map Whisper language codes → our language enum
 * Extended to support all major Indian languages
 */
const WHISPER_LANGUAGE_MAP = {
  'kn': 'kn', 'kn-IN': 'kn',            // Kannada
  'hi': 'hi', 'hi-IN': 'hi',            // Hindi
  'en': 'en', 'en-IN': 'en',            // English
  'en-US': 'en', 'en-GB': 'en',
  'ta': 'ta', 'ta-IN': 'ta',            // Tamil
  'te': 'te', 'te-IN': 'te',            // Telugu
  'ml': 'ml', 'ml-IN': 'ml',            // Malayalam
  'mr': 'mr', 'mr-IN': 'mr',            // Marathi
  'bn': 'hi',                            // Bengali → fallback Hindi
  'gu': 'hi',                            // Gujarati → fallback Hindi
  'pa': 'hi',                            // Punjabi → fallback Hindi
};

/**
 * Mixed dialect detection markers
 */
const KANGLISH_MARKERS = ['ಆದ್ರೆ', 'ಬೇಕು', 'okay', 'please', 'alli', 'ille', 'eno'];
const HINGLISH_MARKERS = ['kyunki', 'matlab', 'lekin', 'okay', 'bhai', 'yaar', 'karo', 'nahi'];

/**
 * Detect if transcript is mixed dialect
 */
function detectMixedDialect(transcript, baseLanguage) {
  const lower = transcript.toLowerCase();
  if (baseLanguage === 'kn') {
    if (KANGLISH_MARKERS.some(m => lower.includes(m)) && lower.match(/[a-z]{3,}/)) {
      return 'kanglish';
    }
  }
  if (baseLanguage === 'hi') {
    if (HINGLISH_MARKERS.some(m => lower.includes(m)) && lower.match(/[a-z]{3,}/)) {
      return 'hinglish';
    }
  }
  return baseLanguage;
}

/**
 * Analyze transcript using Groq Llama 3
 * @param {string} transcript - The caller's speech text
 * @param {string} detectedLanguage - Language code from Whisper STT
 * @param {Array} history - Conversation history
 */
async function analyzeTranscript(transcript, detectedLanguage = 'en', history = []) {
  // Refine language detection with mixed dialect check
  const refinedLanguage = detectMixedDialect(transcript, detectedLanguage);
  const prompt = buildAnalysisPrompt(transcript, refinedLanguage, history);

  try {
    console.log(`Analyzing transcript via Groq Llama 3.3 | Language: ${refinedLanguage} ...`);
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      max_tokens: 1200,
    });

    const content = response.choices[0].message.content;

    // Parse JSON — strip any accidental markdown fences
    const cleanJson = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const parsed = JSON.parse(cleanJson);

    // Ensure the language_detected reflects what LLM actually detected
    // (override if LLM found a more specific language from the text)
    if (!parsed.language_detected || parsed.language_detected === 'unknown') {
      parsed.language_detected = refinedLanguage;
    }

    // Validate helpline_reply is not accidentally in English when it shouldn't be
    // Log a warning if mismatch detected
    if (
      parsed.language_detected !== 'en' &&
      parsed.helpline_reply &&
      !parsed.helpline_reply.match(/[\u0C80-\u0CFF\u0900-\u097F\u0B80-\u0BFF\u0C00-\u0C7F\u0D00-\u0D7F]/) &&
      parsed.language_detected !== 'kanglish' &&
      parsed.language_detected !== 'hinglish'
    ) {
      console.warn(`⚠️ Language mismatch detected: LLM said language=${parsed.language_detected} but helpline_reply appears to be in English. This may need retrying.`);
    }

    console.log(`✅ Analysis complete | lang=${parsed.language_detected} | intent=${parsed.intent_category} | emotion=${parsed.emotion}`);
    return parsed;

  } catch (error) {
    console.error('Groq LLM Analysis Error:', error);
    throw error;
  }
}

/**
 * Summarize a complete call conversation
 * @param {Array} history - Array of {role, text} turns
 */
async function summarizeConversation(history) {
  const historyText = history.map(t => `[${t.role.toUpperCase()}]: ${t.text}`).join('\n');

  const prompt = `You are a professional emergency dispatcher analyst.
Below is the transcript of an emergency call between a caller and the AI dispatcher.
Summarize the emergency issue, the location (if provided), the action taken, and any key details.
Format the summary as a clear, concise text paragraph (max 3 sentences). Do not use JSON.
Write the summary in English regardless of the call language.

TRANSCRIPT:
${historyText}`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 256,
    });
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('Groq Summary Error:', error);
    return 'Failed to generate summary.';
  }
}

module.exports = { analyzeTranscript, summarizeConversation, WHISPER_LANGUAGE_MAP };
