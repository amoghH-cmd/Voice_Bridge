require('dotenv').config();
const { analyzeTranscript } = require('./services/llm');

async function run() {
  try {
    const res = await analyzeTranscript("Hello, can you hear me? I'm in BMS project engineering, so I hope you might see me inside. I'm not good in English, so can you please help me?", "en", []);
    console.log("LLM Output:", res);
  } catch (err) {
    console.error("Error:", err);
  }
}
run();
