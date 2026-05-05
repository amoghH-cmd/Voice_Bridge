"""
VoiceBridge — Core Pipeline Orchestrator
Ties all 5 layers together: Telephony → STT → LLM → Confirmation → Dashboard
One CallSession per active call.
"""

import asyncio
import logging
import uuid
from datetime import datetime
from typing import Dict, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import (
    Call, Ticket, ConfirmationLog, EscalationLog,
    CallStatus, TicketStatus, AsyncSessionLocal
)
from app.schemas import LLMAnalysis
from app.services.stt_service import stt_service, STTResult
from app.services.llm_service import llm_service
from app.services.confirmation_engine import ConfirmationEngine, EngineState
from app.websocket.manager import manager
from app.database import Language

logger = logging.getLogger("voicebridge.pipeline")


# ──────────────────────────────────────────────────────────────────
# Active call registry (in-process; use Redis for multi-worker)
# ──────────────────────────────────────────────────────────────────
_active_sessions: Dict[str, "CallSession"] = {}


def get_session(call_id: str) -> Optional["CallSession"]:
    return _active_sessions.get(call_id)


def register_session(session: "CallSession"):
    _active_sessions[session.call_id] = session


def close_session(call_id: str):
    _active_sessions.pop(call_id, None)


# ──────────────────────────────────────────────────────────────────
# CallSession — one per active PSTN call
# ──────────────────────────────────────────────────────────────────
class CallSession:
    """
    Manages one caller's full lifecycle:
      1. Accumulate audio → STT transcript
      2. LLM analysis
      3. Confirmation loop
      4. Emit ticket OR escalate
    """

    def __init__(self, call_id: str, phone_number: str):
        self.call_id = call_id
        self.phone_number = phone_number
        self.transcript_buffer: str = ""
        self.language: Language = Language.UNKNOWN
        self.analysis: Optional[LLMAnalysis] = None
        self.engine: Optional[ConfirmationEngine] = None
        self.session_history: list = []
        self.started_at = datetime.utcnow()
        self.ticket_id: Optional[str] = None
        logger.info(f"[{call_id}] 📞 New session | caller={phone_number}")

    # ── Layer 2: Audio chunk → transcript ────────────────────────
    async def ingest_audio_chunk(self, audio_bytes: bytes) -> str:
        """
        Receive 100ms audio chunk.
        Updates internal transcript buffer.
        Returns current partial transcript.
        """
        result: STTResult = await stt_service.transcribe(audio_bytes)
        self.transcript_buffer = (
            self.transcript_buffer + " " + result.transcript
        ).strip()
        self.language = result.language
        logger.debug(
            f"[{self.call_id}] STT chunk: '{result.transcript[:50]}' "
            f"lang={result.language.value}"
        )
        return self.transcript_buffer

    # ── Layer 3: Full transcript → LLM analysis ──────────────────
    async def run_analysis(self) -> LLMAnalysis:
        """
        Called once caller stops speaking (end-of-utterance detected).
        Runs Claude full analysis pass.
        """
        self.analysis = await llm_service.analyse(
            transcript=self.transcript_buffer,
            language=self.language,
            call_id=self.call_id,
            session_history=self.session_history,
        )

        # Override language if Whisper was wrong
        if self.analysis.language_detected != Language.UNKNOWN:
            self.language = self.analysis.language_detected

        # Check immediate escalation
        if self.analysis.needs_escalation:
            await self._escalate_now(
                reason=self.analysis.escalation_reason or "LLM flagged escalation"
            )

        return self.analysis

    # ── Layer 4: Start confirmation loop ─────────────────────────
    def init_confirmation(self) -> str:
        """
        Initialises the confirmation engine.
        Returns the prompt to read to caller via TTS.
        """
        self.engine = ConfirmationEngine(self.call_id, self.analysis)
        return self.engine.get_opening_prompt()

    async def handle_confirmation_response(
        self, user_response_text: str
    ) -> dict:
        """
        Process one user YES/NO/PARTIAL response.
        Automatically triggers LLM refinement on NO/PARTIAL.
        Returns action dict from ConfirmationEngine.
        """
        refined_analysis = None

        # Check if user gave correction (NO/PARTIAL) — pre-refine
        pre_check = user_response_text.lower()
        needs_refine = any(
            w in pre_check for w in ["no", "nahi", "illa", "but", "wrong", "lekin", "aadre"]
        )
        if needs_refine and self.engine and self.engine.state.attempt < settings.MAX_CONFIRMATION_RETRIES:
            refined_analysis = await llm_service.refine(
                original_analysis=self.analysis,
                user_correction=user_response_text,
                language=self.language,
                attempt=self.engine.state.attempt,
                call_id=self.call_id,
            )

        result = await self.engine.process_response(user_response_text, refined_analysis)

        # Log to DB
        await self._log_confirmation(
            attempt=self.engine.state.attempt - 1,
            confirmation_text=self.analysis.confirmation_sentence,
            user_response=user_response_text,
            result=result["result"],
            confidence_before=self.analysis.confidence,
            confidence_after=result["analysis"].confidence if refined_analysis else None,
        )

        # Update session history
        self.session_history.append({"role": "ai", "text": self.analysis.confirmation_sentence})
        self.session_history.append({"role": "caller", "text": user_response_text})
        if refined_analysis:
            self.analysis = refined_analysis

        # Handle terminal states
        if result["action"] == "emit_ticket":
            await self._create_ticket(result["analysis"])
        elif result["action"] == "escalate":
            await self._escalate_now(reason=result.get("reason", "confirmation failure"))

        return result

    # ── Layer 5: Create ticket & broadcast ───────────────────────
    async def _create_ticket(self, analysis: LLMAnalysis):
        ticket_id = str(uuid.uuid4())
        self.ticket_id = ticket_id

        async with AsyncSessionLocal() as db:
            ticket = Ticket(
                id=ticket_id,
                call_id=self.call_id,
                intent_category=analysis.intent_category,
                intent_subtype=analysis.intent_subtype,
                summary=analysis.summary,
                emotion=analysis.emotion,
                confidence=analysis.confidence,
                language=analysis.language_detected,
                location_raw=analysis.location_raw,
                district=analysis.district,
                landmark=analysis.landmark,
                caller_name=analysis.caller_name,
                caller_age=analysis.caller_age,
                caller_gender=analysis.caller_gender,
                llm_output=analysis.model_dump(),
                status=TicketStatus.OPEN,
            )
            db.add(ticket)

            # Update call status
            call = await db.get(Call, self.call_id)
            if call:
                call.status = CallStatus.CONFIRMED

            await db.commit()

        logger.info(f"[{self.call_id}] 🎫 Ticket created: {ticket_id}")

        # Push to dashboard
        await manager.broadcast_new_ticket({
            "ticket_id": ticket_id,
            "call_id": self.call_id,
            "phone_number": self.phone_number,
            "intent_category": analysis.intent_category.value,
            "intent_subtype": analysis.intent_subtype,
            "summary": analysis.summary,
            "emotion": analysis.emotion.value,
            "confidence": analysis.confidence,
            "language": analysis.language_detected.value,
            "location": analysis.location_raw,
            "district": analysis.district,
            "caller_name": analysis.caller_name,
            "created_at": datetime.utcnow().isoformat(),
        })

    async def _escalate_now(self, reason: str):
        async with AsyncSessionLocal() as db:
            esc = EscalationLog(
                call_id=self.call_id,
                reason=reason,
            )
            db.add(esc)
            call = await db.get(Call, self.call_id)
            if call:
                call.status = CallStatus.ESCALATED
            await db.commit()

        logger.warning(f"[{self.call_id}] 🚨 Escalated: {reason}")

        analysis = self.analysis
        await manager.broadcast_escalation({
            "call_id": self.call_id,
            "phone_number": self.phone_number,
            "reason": reason,
            "emotion": analysis.emotion.value if analysis else "UNKNOWN",
            "summary": analysis.summary if analysis else "",
            "language": self.language.value,
            "escalated_at": datetime.utcnow().isoformat(),
        })

    async def _log_confirmation(self, **kwargs):
        async with AsyncSessionLocal() as db:
            log = ConfirmationLog(call_id=self.call_id, **kwargs)
            db.add(log)
            await db.commit()
