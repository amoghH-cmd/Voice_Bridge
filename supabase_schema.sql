-- Run this in your Supabase SQL Editor

-- 1. Create the Tickets table
CREATE TABLE tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status TEXT DEFAULT 'OPEN',
    intent_category TEXT,
    intent_subtype TEXT,
    summary TEXT,
    emotion TEXT,
    confidence FLOAT,
    language TEXT,
    location_raw TEXT,
    district TEXT,
    caller_name TEXT,
    assigned_agent TEXT,
    agent_notes TEXT,
    cultural_context TEXT,
    urgency_cues JSONB DEFAULT '[]'::jsonb
);

-- 2. Create the Calls table
CREATE TABLE calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number TEXT NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status TEXT DEFAULT 'ACTIVE',
    language TEXT
);

-- 3. Enable Realtime for these tables
-- This is crucial so our React dashboard updates instantly without WebSockets setup!
alter publication supabase_realtime add table tickets;
alter publication supabase_realtime add table calls;
