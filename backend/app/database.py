"""
VoiceBridge — Async SQLAlchemy Database Layer
Models: Call, Ticket, Agent, ConfirmationLog, EscalationLog
"""

from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional

from sqlalchemy import (
    Column, String, Integer, Float, Boolean, DateTime,
    Enum, ForeignKey, Text, JSON
)
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, relationship

from app.config import settings

# ──────────────────────────────────────────────────────────────────
# Engine & Session factory
# ──────────────────────────────────────────────────────────────────
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=(settings.ENV == "development"),
    pool_pre_ping=True,
)

AsyncSessionLocal = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


# ──────────────────────────────────────────────────────────────────
# Base
# ──────────────────────────────────────────────────────────────────
class Base(DeclarativeBase):
    pass


# ──────────────────────────────────────────────────────────────────
# Enums
# ──────────────────────────────────────────────────────────────────
class CallStatus(str, PyEnum):
    ACTIVE      = "ACTIVE"
    CONFIRMED   = "CONFIRMED"
    ESCALATED   = "ESCALATED"
    CLOSED      = "CLOSED"
    ABANDONED   = "ABANDONED"

class Language(str, PyEnum):
    KANNADA     = "kn"
    HINDI       = "hi"
    ENGLISH     = "en"
    KANGLISH    = "kanglish"
    HINGLISH    = "hinglish"
    UNKNOWN     = "unknown"

class Emotion(str, PyEnum):
    LOW         = "LOW"
    MEDIUM      = "MEDIUM"
    HIGH        = "HIGH"
    PANIC       = "PANIC"

class IntentCategory(str, PyEnum):
    WOMEN_SAFETY    = "women_safety"
    CHILD_SAFETY    = "child_safety"
    DOMESTIC_VIOLENCE = "domestic_violence"
    MEDICAL         = "medical"
    MENTAL_HEALTH   = "mental_health"
    TRAFFICKING     = "trafficking"
    LEGAL_AID       = "legal_aid"
    OTHER           = "other"

class ConfirmationResult(str, PyEnum):
    YES         = "YES"
    NO          = "NO"
    PARTIAL     = "PARTIAL"
    TIMEOUT     = "TIMEOUT"

class TicketStatus(str, PyEnum):
    OPEN        = "OPEN"
    IN_PROGRESS = "IN_PROGRESS"
    RESOLVED    = "RESOLVED"
    ESCALATED   = "ESCALATED"


# ──────────────────────────────────────────────────────────────────
# Models
# ──────────────────────────────────────────────────────────────────
class Call(Base):
    __tablename__ = "calls"

    id              = Column(String(36), primary_key=True)   # UUID
    phone_number    = Column(String(20), nullable=False)
    started_at      = Column(DateTime, default=datetime.utcnow)
    ended_at        = Column(DateTime, nullable=True)
    duration_secs   = Column(Integer, default=0)
    status          = Column(Enum(CallStatus), default=CallStatus.ACTIVE)
    language        = Column(Enum(Language), default=Language.UNKNOWN)
    raw_transcript  = Column(Text, nullable=True)
    twilio_call_sid = Column(String(64), nullable=True)
    exotel_call_sid = Column(String(64), nullable=True)
    audio_url       = Column(String(512), nullable=True)

    # Relationships
    tickets         = relationship("Ticket", back_populates="call")
    confirmations   = relationship("ConfirmationLog", back_populates="call")
    escalations     = relationship("EscalationLog", back_populates="call")


class Ticket(Base):
    __tablename__ = "tickets"

    id              = Column(String(36), primary_key=True)
    call_id         = Column(String(36), ForeignKey("calls.id"), nullable=False)
    created_at      = Column(DateTime, default=datetime.utcnow)
    updated_at      = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    status          = Column(Enum(TicketStatus), default=TicketStatus.OPEN)

    # Core fields
    intent_category = Column(Enum(IntentCategory), nullable=True)
    intent_subtype  = Column(String(128), nullable=True)
    summary         = Column(Text, nullable=True)
    emotion         = Column(Enum(Emotion), default=Emotion.LOW)
    confidence      = Column(Float, default=0.0)        # 0–100
    language        = Column(Enum(Language), default=Language.UNKNOWN)

    # Location
    location_raw    = Column(String(512), nullable=True)
    district        = Column(String(128), nullable=True)
    landmark        = Column(String(256), nullable=True)

    # Caller
    caller_name     = Column(String(256), nullable=True)
    caller_age      = Column(Integer, nullable=True)
    caller_gender   = Column(String(32), nullable=True)

    # Agent fields
    assigned_agent  = Column(String(128), nullable=True)
    agent_notes     = Column(Text, nullable=True)
    resolution      = Column(Text, nullable=True)

    # Raw LLM output
    llm_output      = Column(JSON, nullable=True)

    # Relationships
    call            = relationship("Call", back_populates="tickets")
    agent_edits     = relationship("AgentEdit", back_populates="ticket")


class ConfirmationLog(Base):
    __tablename__ = "confirmation_logs"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    call_id         = Column(String(36), ForeignKey("calls.id"))
    attempt         = Column(Integer, default=1)            # 1–3
    confirmation_text = Column(Text)                        # AI's restatement
    user_response   = Column(Text, nullable=True)           # raw user reply
    result          = Column(Enum(ConfirmationResult))
    confidence_before = Column(Float)
    confidence_after  = Column(Float, nullable=True)
    timestamp       = Column(DateTime, default=datetime.utcnow)

    call            = relationship("Call", back_populates="confirmations")


class EscalationLog(Base):
    __tablename__ = "escalation_logs"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    call_id         = Column(String(36), ForeignKey("calls.id"))
    reason          = Column(String(256))                   # emotion/retries/panic
    escalated_at    = Column(DateTime, default=datetime.utcnow)
    assigned_agent  = Column(String(128), nullable=True)
    resolved        = Column(Boolean, default=False)

    call            = relationship("Call", back_populates="escalations")


class Agent(Base):
    __tablename__ = "agents"

    id              = Column(String(36), primary_key=True)
    name            = Column(String(256), nullable=False)
    email           = Column(String(256), unique=True, nullable=False)
    password_hash   = Column(String(512), nullable=False)
    role            = Column(String(64), default="agent")   # agent | supervisor
    languages       = Column(JSON, default=list)            # ["kn","hi","en"]
    is_active       = Column(Boolean, default=True)
    last_seen       = Column(DateTime, nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)


class AgentEdit(Base):
    """Stores agent corrections — used as training data for fine-tuning."""
    __tablename__ = "agent_edits"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    ticket_id       = Column(String(36), ForeignKey("tickets.id"))
    agent_id        = Column(String(36), ForeignKey("agents.id"))
    field_name      = Column(String(64))                    # e.g. "intent_category"
    original_value  = Column(Text)
    corrected_value = Column(Text)
    timestamp       = Column(DateTime, default=datetime.utcnow)

    ticket          = relationship("Ticket", back_populates="agent_edits")
