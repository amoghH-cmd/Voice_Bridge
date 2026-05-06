const Groq = require('groq-sdk');
const { SYSTEM_PROMPT, buildAnalysisPrompt } = require('./prompts');
require('dotenv').config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

async function analyzeTranscript(transcript, language = 'en', history = []) {
  const prompt = buildAnalysisPrompt(transcript, language, history);

  try {
    console.log("Analyzing transcript via Groq Llama 3.3...");
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      max_tokens: 1024,
    });

    const content = response.choices[0].message.content;
    
    // Parse the JSON. Groq/Llama might wrap it in markdown block, so we clean it.
    const cleanJson = content.replace(/```json\\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error("Groq LLM Analysis Error:", error);
    throw error;
  }
}

module.exports = { analyzeTranscript };
