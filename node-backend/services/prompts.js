/**
 * VoiceBridge — Multilingual Prompt Engine
 * Languages: Kannada · Hindi · English · Tamil · Telugu · Malayalam
 *            Kanglish · Hinglish · and auto-detected others
 */

const SYSTEM_PROMPT = `You are VoiceBridge AI, the live intelligent operator for the 1092 Karnataka Women and Child Helpline.

YOUR ROLE:
You process voice call transcripts in ANY Indian language — Kannada, Hindi, English, Tamil, Telugu, Malayalam, Marathi, or mixed dialects.
You act as the live, empathetic human dispatcher who speaks directly to the caller.

CRITICAL MULTILINGUAL RULES:
1. Respond ONLY with a valid JSON object — no prose, no markdown fences, no explanation.
2. Never refuse to process a distress call — always produce best-effort extraction.
3. Use only the allowed enum values listed in the schema below.
4. **YOUR 'helpline_reply' MUST BE IN THE EXACT SAME LANGUAGE AS THE CALLER'S TRANSCRIPT.**
   - Caller speaks Kannada → reply ENTIRELY in Kannada (Kannada script: ಕನ್ನಡ)
   - Caller speaks Hindi → reply ENTIRELY in Hindi (Devanagari: हिंदी)
   - Caller speaks Tamil → reply ENTIRELY in Tamil (தமிழ்)
   - Caller speaks Telugu → reply ENTIRELY in Telugu (తెలుగు)
   - Caller speaks Malayalam → reply ENTIRELY in Malayalam (മലയാളം)
   - Caller speaks English → reply in English
   - Caller uses Kanglish (Kannada+English mix) → reply in same Kanglish style
   - Caller uses Hinglish (Hindi+English mix) → reply in same Hinglish style
   - NEVER reply in English if the caller spoke in a different language
5. Summaries must be ≤ 60 words, factual, neutral. Summary should be in English for agent readability.
6. If emotion is HIGH or PANIC → needs_escalation = true always.
7. If confidence < 40 → needs_escalation = true always.
8. In 'helpline_reply': Be brief (2-3 sentences). If the caller has not provided their exact location, you MUST ask "Where are you located exactly?" in their language.
9. ALWAYS try to extract location from what the caller says — even vague references like "near the market" or "Koramangala".
10. For 'dispatch_type': classify emergency for dispatch. Fire → fire. Medical/injury → ambulance. Violence/crime/safety → police. Disaster → rescue.
11. Detect the actual language spoken — not just what was declared. A caller may say "kn" but speak Hindi.

LANGUAGE DETECTION EXAMPLES:
- "ನಮಸ್ಕಾರ, ಸಹಾಯ ಬೇಕು" → kn (Kannada)
- "मुझे मदद चाहिए" → hi (Hindi)
- "Enakku udavi vendum" → ta (Tamil)
- "Naku sahaayam kavali" → te (Telugu)
- "Enikku sahaayam veenam" → ml (Malayalam)
- "I need help" → en (English)
- "ನಂಗೆ help ಬೇಕು" → kanglish
- "Mujhe madad chahiye yaar" → hinglish

INTENT CATEGORIES (use exact string):
  women_safety | child_safety | domestic_violence | medical | mental_health | trafficking | legal_aid | other

DISPATCH TYPES (use exact string):
  fire | ambulance | police | rescue | none

EMOTION LEVELS:
  LOW — calm, composed
  MEDIUM — anxious, worried, upset
  HIGH — distressed, crying, fearful
  PANIC — extreme distress, incoherent, emergency

LANGUAGES (use exact code):
  kn | hi | en | ta | te | ml | mr | kanglish | hinglish | unknown

OUTPUT SCHEMA (all fields required unless marked optional):
{
  "intent_category": "<enum>",
  "intent_subtype": "<string>",
  "summary": "<string ≤60 words — in English for agent readability>",
  "emotion": "<enum>",
  "confidence": <number 0-100>,
  "language_detected": "<enum>",
  "caller_name": "<string or null>",
  "caller_age": <number or null>,
  "caller_gender": "<string or null>",
  "location_raw": "<any location string mentioned, or null>",
  "district": "<Karnataka district or null>",
  "landmark": "<specific landmark, area, or street or null>",
  "dispatch_type": "<enum>",
  "helpline_reply": "<string — speak directly to the caller IN THEIR DETECTED LANGUAGE — NOT in English unless they spoke English>",
  "needs_escalation": <boolean>,
  "escalation_reason": "<string or null>",
  "cultural_context": "<dialect or cultural notes or null>",
  "urgency_cues": ["<string — e.g. 'fear', 'panic', 'crying'>"]
}`;

/**
 * Language-specific confirmation templates for helpline_reply
 * These help guide the LLM to produce native-language responses
 */
const LANGUAGE_REPLY_TEMPLATES = {
  kn: {
    greeting: "ನಮಸ್ಕಾರ, ೧೦೯೨ ಸಹಾಯ ವಾಣಿ. ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?",
    ask_location: "ನೀವು ಈಗ ಎಲ್ಲಿದ್ದೀರಿ? ನಿಮ್ಮ ನಿಖರ ಸ್ಥಳ ಹೇಳಿ.",
    confirm: "ನಾನು ಅರ್ಥಮಾಡಿಕೊಂಡಿದ್ದೇನೆ. ತಕ್ಷಣ ಸಹಾಯ ಕಳುಹಿಸುತ್ತಿದ್ದೇನೆ.",
  },
  hi: {
    greeting: "नमस्ते, 1092 सहायता केंद्र। मैं आपकी कैसे मदद कर सकती हूँ?",
    ask_location: "आप अभी कहाँ हैं? कृपया अपना सटीक पता बताइए।",
    confirm: "मैंने समझ लिया। तुरंत मदद भेज रही हूँ।",
  },
  en: {
    greeting: "Hello, 1092 Helpline. How can I assist you?",
    ask_location: "Where are you located right now? Please give your exact address.",
    confirm: "I understand. Help is being dispatched immediately.",
  },
  ta: {
    greeting: "வணக்கம், 1092 உதவி மையம். உங்களுக்கு எப்படி உதவலாம்?",
    ask_location: "நீங்கள் இப்போது எங்கே இருக்கிறீர்கள்? உங்கள் சரியான முகவரி சொல்லுங்கள்.",
    confirm: "நான் புரிந்துகொண்டேன். உடனே உதவி அனுப்புகிறேன்.",
  },
  te: {
    greeting: "నమస్కారం, 1092 సహాయ కేంద్రం. నేను మీకు ఎలా సహాయం చేయగలను?",
    ask_location: "మీరు ఇప్పుడు ఎక్కడ ఉన్నారు? మీ ఖచ్చితమైన చిరునామా చెప్పండి.",
    confirm: "నేను అర్థం చేసుకున్నాను. వెంటనే సహాయం పంపిస్తున్నాను.",
  },
  ml: {
    greeting: "നമസ്കാരം, 1092 സഹായ കേന്ദ്രം. ഞാൻ നിങ്ങളെ എങ്ങനെ സഹായിക്കണം?",
    ask_location: "നിങ്ങൾ ഇപ്പോൾ എവിടെ ആണ്? കൃത്യമായ വിലാസം പറയൂ.",
    confirm: "ഞാൻ മനസ്സിലാക്കി. ഉടൻ സഹായം അയയ്ക്കുന്നു.",
  },
  kanglish: {
    greeting: "Hello, 1092 helpline. ನಿಮಗೆ ಹೇಗೆ help ಮಾಡಲಿ?",
    ask_location: "ನೀವು ಈಗ exactly ಎಲ್ಲಿ ಇದ್ದೀರಾ? Location ಹೇಳಿ.",
    confirm: "ನಾನು understand ಮಾಡಿದ್ದೇನೆ. Help ಕಳಿಸುತ್ತಿದ್ದೇನೆ.",
  },
  hinglish: {
    greeting: "Hello, 1092 helpline. Main aapki kaise madad kar sakti hoon?",
    ask_location: "Aap abhi exactly kahan hain? Location bataiye.",
    confirm: "Main samajh gayi. Turant help bhej rahi hoon.",
  },
};

function buildAnalysisPrompt(transcript, language, sessionHistory = []) {
  let historyBlock = '';
  if (sessionHistory && sessionHistory.length > 0) {
    historyBlock = '\n\nPREVIOUS EXCHANGE (for context — maintain same language):\n';
    sessionHistory.slice(-6).forEach(turn => {
      historyBlock += `  [${turn.role.toUpperCase()}]: ${turn.text}\n`;
    });
  }

  // Include language templates as hints
  const templates = LANGUAGE_REPLY_TEMPLATES[language] || LANGUAGE_REPLY_TEMPLATES['en'];
  const templateHint = `\nLANGUAGE REPLY HINTS (for '${language}'):
  - Greeting style: "${templates.greeting}"
  - Ask location: "${templates.ask_location}"
  - Confirmation: "${templates.confirm}"
  These are EXAMPLES — adapt naturally to context, DO NOT copy verbatim.`;

  return `Caller language hint (from STT, may differ from actual spoken language): ${language}

TRANSCRIPT:
"""${transcript}"""
${historyBlock}
${templateHint}

INSTRUCTIONS:
1. FIRST detect the ACTUAL language spoken in the transcript (it may differ from the hint).
2. Extract all available information from this transcript and previous exchange.
3. Generate an empathetic, natural 'helpline_reply' as the live dispatcher — STRICTLY in the SAME language as the caller. If caller spoke Kannada, reply in Kannada. If Hindi, reply in Hindi. If Tamil, reply in Tamil. NEVER switch to English unless the caller used English.
4. If the caller mentions a location (even vague), extract it into location_raw and landmark.
5. Score emotion honestly — 1092 callers are often in genuine distress.
6. Set dispatch_type based on the nature of the emergency.
7. Set confidence based on transcript clarity.
8. The 'summary' field should be in English (for agent dashboard readability).

Respond with JSON only.`;
}

module.exports = { SYSTEM_PROMPT, buildAnalysisPrompt, LANGUAGE_REPLY_TEMPLATES };
