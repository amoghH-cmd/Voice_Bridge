"""
VoiceBridge — Pydantic Schemas (Request / Response)
"""

from datetime import datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
from app.database import (
    CallStatus, Language, Emotion, IntentCategory,
    ConfirmationResult, TicketStatus
)


# ── Call Schemas ──────────────────────────────────────────────────
class CallCreate(BaseModel):
    phone_number: str
    twilio_call_sid: Optional[str] = None
    exotel_call_sid: Optional[str] = None


class CallResponse(BaseModel):
    id: str
    phone_number: str
    started_at: datetime
    status: CallStatus
    language: Language

    class Config:
        from_attributes = True


# ── LLM Analysis Schemas ──────────────────────────────────────────
class LLMAnalysis(BaseModel):
    """Typed output from Claude — strict schema enforced via prompt."""
    intent_category: IntentCategory
    intent_subtype: str
    summary: str                            # ≤ 60 words
    emotion: Emotion
    confidence: float = Field(ge=0, le=100)
    language_detected: Language
    caller_name: Optional[str] = None
    caller_age: Optional[int] = None
    caller_gender: Optional[str] = None
    location_raw: Optional[str] = None
    district: Optional[str] = None
    landmark: Optional[str] = None
    confirmation_sentence: str              # AI restates issue for user to confirm
    needs_escalation: bool = False
    escalation_reason: Optional[str] = None


# ── Confirmation Schemas ──────────────────────────────────────────
class ConfirmationRequest(BaseModel):
    call_id: str
    attempt: int = 1
    user_response_text: str


class ConfirmationResponse(BaseModel):
    call_id: str
    result: ConfirmationResult
    next_action: str        # "emit_ticket" | "retry" | "escalate"
    retry_prompt: Optional[str] = None
    ticket_id: Optional[str] = None


# ── Ticket Schemas ────────────────────────────────────────────────
class TicketCreate(BaseModel):
    call_id: str
    intent_category: IntentCategory
    intent_subtype: str
    summary: str
    emotion: Emotion
    confidence: float
    language: Language
    location_raw: Optional[str] = None
    district: Optional[str] = None
    landmark: Optional[str] = None
    caller_name: Optional[str] = None
    caller_age: Optional[int] = None
    caller_gender: Optional[str] = None
    llm_output: Optional[Dict[str, Any]] = None


class TicketUpdate(BaseModel):
    intent_category: Optional[IntentCategory] = None
    intent_subtype: Optional[str] = None
    summary: Optional[str] = None
    emotion: Optional[Emotion] = None
    status: Optional[TicketStatus] = None
    agent_notes: Optional[str] = None
    resolution: Optional[str] = None
    assigned_agent: Optional[str] = None
    district: Optional[str] = None
    caller_name: Optional[str] = None


class TicketResponse(BaseModel):
    id: str
    call_id: str
    created_at: datetime
    status: TicketStatus
    intent_category: Optional[IntentCategory]
    intent_subtype: Optional[str]
    summary: Optional[str]
    emotion: Emotion
    confidence: float
    language: Language
    location_raw: Optional[str]
    district: Optional[str]
    caller_name: Optional[str]
    assigned_agent: Optional[str]
    agent_notes: Optional[str]

    class Config:
        from_attributes = True


# ── Agent Schemas ─────────────────────────────────────────────────
class AgentLogin(BaseModel):
    email: str
    password: str


class AgentResponse(BaseModel):
    id: str
    name: str
    email: str
    role: str
    languages: List[str]
    is_active: bool

    class Config:
        from_attributes = True


class AgentToken(BaseModel):
    access_token: str
    token_type: str = "bearer"
    agent: AgentResponse


# ── WebSocket Event Schemas ───────────────────────────────────────
class WSEvent(BaseModel):
    event: str                              # "new_ticket" | "escalation" | "update"
    data: Dict[str, Any]
    timestamp: datetime = Field(default_factory=datetime.utcnow)


# ── Webhook Schemas (Twilio / Exotel) ────────────────────────────
class TwilioCallWebhook(BaseModel):
    CallSid: str
    From: str
    To: str
    CallStatus: str
    Direction: Optional[str] = None


class ExotelCallWebhook(BaseModel):
    CallSid: str
    From: str
    To: str
    Status: str
    Direction: Optional[str] = None
