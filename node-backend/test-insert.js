const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function mockIncomingCall() {
  console.log("Simulating incoming call and AI processing...");
  
  const newTicket = {
    call_id: "mock-call-" + Math.floor(Math.random() * 1000),
    intent_category: "medical",
    summary: "Simulated incoming emergency call from Node.js backend. Caller needs ambulance.",
    emotion: "HIGH",
    confidence: 85.5,
    language: "hi",
    location_raw: "Bangalore",
    urgency_cues: ["urgency", "distress"]
  };

  const { data, error } = await supabase
    .from('tickets')
    .insert([newTicket]);

  if (error) {
    console.error("Error inserting ticket:", error.message);
  } else {
    console.log("Ticket successfully inserted! Check your React Dashboard.");
  }
}

mockIncomingCall();
