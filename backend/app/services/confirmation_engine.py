"""
VoiceBridge — Confirmation Engine (Layer 4) — Section 4
State machine managing YES / NO / PARTIAL / TIMEOUT branches.
Max 3 retries. Auto-escalates on:
  • 3 failed retries
  • HIGH / PANIC emotion
  • confidence < threshold after final attempt
"""

import logging
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import anthropic

from app.config import settings
from app.database import ConfirmationResult, Emotion
from app.schemas import LLMAnalysis
from app.prompts import build_yes_no_prompt

logger = logging.getLogger("voicebridge.confirmation")

_anthropic = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)


# ──────────────────────────────────────────────────────────────────
# State
# ──────────────────────────────────────────────────────────────────
class EngineState(str, Enum):
    AWAITING_RESPONSE   = "AWAITING_RESPONSE"
    REFINING            = "REFINING"
    CONFIRMED           = "CONFIRMED"
    ESCALATED           = "ESCALATED"
    FAILED              = "FAILED"


@dataclass
class ConfirmationState:
    call_id: str
    current_analysis: LLMAnalysis
    attempt: int = 1
    state: EngineState = EngineState.AWAITING_RESPONSE
    history: list = field(default_factory=list)  # [{attempt, result, user_response}]
    escalation_reason: Optional[str] = None


# ──────────────────────────────────────────────────────────────────
# Engine
# ──────────────────────────────────────────────────────────────────
class ConfirmationEngine:
    """
    Manages the confirmation loop for a single call.
    Callers interact via process_response().
    """

    def __init__(self, call_id: str, initial_analysis: LLMAnalysis):
        self.state = ConfirmationState(
            call_id=call_id,
            current_analysis=initial_analysis,
        )
        logger.info(f"[{call_id}] Confirmation engine initialised (attempt 1)")

    # ── Public API ────────────────────────────────────────────────
    async def process_response(
        self,
        user_response_text: str,
        refined_analysis: Optional[LLMAnalysis] = None,
    ) -> dict:
        """
        Process user's verbal confirmation response.
        Returns action dict:
            { "action": "emit_ticket" | "retry" | "escalate",
              "next_prompt": str,
              "result": ConfirmationResult,
              "analysis": LLMAnalysis }
        """
        call_id = self.state.call_id
        attempt = self.state.attempt
        language = self.state.current_analysis.language_detected.value

        # ── Classify YES / NO / PARTIAL / TIMEOUT ─────────────
        result = await self._classify_response(user_response_text, language)

        logger.info(
            f"[{call_id}] Attempt {attempt} → result={result.value} | "
            f"response='{user_response_text[:60]}'"
        )

        # Record history
        self.state.history.append({
            "attempt": attempt,
            "result": result.value,
            "user_response": user_response_text,
        })

        # ── Branch logic ──────────────────────────────────────
        if result == ConfirmationResult.YES:
            return self._handle_yes()

        if result in (ConfirmationResult.NO, ConfirmationResult.PARTIAL):
            return self._handle_no_partial(result, refined_analysis)

        if result == ConfirmationResult.TIMEOUT:
            return self._handle_timeout()

        # Unknown — treat as timeout
        return self._handle_timeout()

    def get_opening_prompt(self) -> str:
        """Returns the AI confirmation sentence to read to caller."""
        return self.state.current_analysis.confirmation_sentence

    def update_analysis(self, new_analysis: LLMAnalysis):
        """Called by the pipeline after LLM refinement."""
        self.state.current_analysis = new_analysis

    # ── Branch handlers ───────────────────────────────────────────
    def _handle_yes(self) -> dict:
        self.state.state = EngineState.CONFIRMED
        analysis = self.state.current_analysis

        # Even on YES, escalate if HIGH/PANIC emotion
        if analysis.emotion in (Emotion.HIGH, Emotion.PANIC):
            return self._escalate(
                reason=f"High emotion ({analysis.emotion.value}) — human support required",
                result=ConfirmationResult.YES,
            )

        logger.info(f"[{self.state.call_id}] ✅ Confirmed — emitting ticket")
        return {
            "action": "emit_ticket",
            "result": ConfirmationResult.YES,
            "next_prompt": self._lang_phrase("ticket_created"),
            "analysis": analysis,
        }

    def _handle_no_partial(
        self, result: ConfirmationResult, refined: Optional[LLMAnalysis]
    ) -> dict:
        self.state.attempt += 1

        if self.state.attempt > settings.MAX_CONFIRMATION_RETRIES:
            return self._escalate(
                reason=f"Max retries ({settings.MAX_CONFIRMATION_RETRIES}) reached",
                result=result,
            )

        if refined:
            self.state.current_analysis = refined

        lang = self.state.current_analysis.language_detected.value
        next_prompt = (
            f"{self._lang_phrase('refine_prefix', lang)} "
            f"{self.state.current_analysis.confirmation_sentence}"
        )

        logger.info(
            f"[{self.state.call_id}] 🔄 Retry {self.state.attempt - 1} — "
            f"asking caller to correct"
        )

        return {
            "action": "retry",
            "result": result,
            "attempt": self.state.attempt,
            "next_prompt": next_prompt,
            "analysis": self.state.current_analysis,
        }

    def _handle_timeout(self) -> dict:
        self.state.attempt += 1

        if self.state.attempt > settings.MAX_CONFIRMATION_RETRIES:
            return self._escalate(reason="Repeated timeouts — caller may be unable to respond")

        lang = self.state.current_analysis.language_detected.value
        return {
            "action": "retry",
            "result": ConfirmationResult.TIMEOUT,
            "attempt": self.state.attempt,
            "next_prompt": self._lang_phrase("timeout_retry", lang),
            "analysis": self.state.current_analysis,
        }

    def _escalate(
        self,
        reason: str,
        result: ConfirmationResult = ConfirmationResult.NO,
    ) -> dict:
        self.state.state = EngineState.ESCALATED
        self.state.escalation_reason = reason
        lang = self.state.current_analysis.language_detected.value
        logger.warning(f"[{self.state.call_id}] 🚨 ESCALATING — {reason}")
        return {
            "action": "escalate",
            "result": result,
            "reason": reason,
            "next_prompt": self._lang_phrase("escalation", lang),
            "analysis": self.state.current_analysis,
        }

    # ── LLM YES/NO classifier ─────────────────────────────────────
    async def _classify_response(
        self, user_response: str, language: str
    ) -> ConfirmationResult:
        """Use Claude mini-call to classify YES/NO/PARTIAL/TIMEOUT."""
        if not user_response.strip():
            return ConfirmationResult.TIMEOUT

        prompt = build_yes_no_prompt(user_response, language)
        try:
            import asyncio
            loop = asyncio.get_event_loop()
            raw = await loop.run_in_executor(
                None,
                lambda: _anthropic.messages.create(
                    model=settings.CLAUDE_MODEL,
                    max_tokens=64,
                    temperature=0.0,
                    messages=[{"role": "user", "content": prompt}],
                ).content[0].text
            )
            data = json.loads(raw.strip())
            return ConfirmationResult(data.get("result", "TIMEOUT"))
        except Exception as e:
            logger.error(f"YES/NO classifier error: {e}")
            # Rule-based fallback
            return self._rule_based_classify(user_response, language)

    @staticmethod
    def _rule_based_classify(text: str, lang: str) -> ConfirmationResult:
        """Simple keyword fallback when LLM is unavailable."""
        lower = text.lower()
        YES_WORDS  = ["yes", "haan", "ha", "howdu", "sari", "correct", "right", "ok", "okay", "ಹೌದು", "हाँ"]
        NO_WORDS   = ["no", "nahi", "illa", "wrong", "galat", "not", "ಇಲ್ಲ", "नहीं"]
        PART_WORDS = ["but", "however", "also", "lekin", "aadre", "ಆದ್ರೆ", "लेकिन"]

        for w in YES_WORDS:
            if w in lower:
                return ConfirmationResult.YES
        for w in PART_WORDS:
            if w in lower:
                return ConfirmationResult.PARTIAL
        for w in NO_WORDS:
            if w in lower:
                return ConfirmationResult.NO

        return ConfirmationResult.TIMEOUT

    # ── Multilingual phrases ──────────────────────────────────────
    PHRASES = {
        "ticket_created": {
            "kn": "ಧನ್ಯವಾದಗಳು. ನಿಮ್ಮ ದೂರು ದಾಖಲಾಗಿದೆ. ಸಹಾಯ ಬರುತ್ತಿದೆ.",
            "hi": "धन्यवाद। आपकी शिकायत दर्ज हो गई है। सहायता आ रही है।",
            "en": "Thank you. Your complaint has been registered. Help is on the way.",
            "kanglish": "Thank you. ನಿಮ್ಮ complaint register ಆಗಿದೆ. Help ಬರುತ್ತಿದೆ.",
            "hinglish": "Shukriya. Aapki complaint register ho gayi. Help aa rahi hai.",
        },
        "refine_prefix": {
            "kn": "ಕ್ಷಮಿಸಿ, ದಯವಿಟ್ಟು ಮತ್ತೊಮ್ಮೆ ಪರಿಶೀಲಿಸಿ —",
            "hi": "माफ़ करें, कृपया दोबारा जाँचें —",
            "en": "I'm sorry, let me try again —",
            "kanglish": "Sorry, once more try ಮಾಡೋಣ —",
            "hinglish": "Maafi chahta hoon, ek baar phir —",
        },
        "timeout_retry": {
            "kn": "ದಯವಿಟ್ಟು ಹೌದು ಅಥವಾ ಇಲ್ಲ ಎಂದು ಹೇಳಿ.",
            "hi": "कृपया हाँ या नहीं बताइए।",
            "en": "Please say yes or no.",
            "kanglish": "Please yes ಅಥವಾ no ಹೇಳಿ.",
            "hinglish": "Please haan ya no boliye.",
        },
        "escalation": {
            "kn": "ನಾನು ನಿಮ್ಮನ್ನು ತಕ್ಷಣ ಮಾನವ ಸಹಾಯಕರಿಗೆ ಸಂಪರ್ಕಿಸುತ್ತಿದ್ದೇನೆ. ದಯವಿಟ್ಟು ಇರಿ.",
            "hi": "मैं आपको अभी एक मानव सहायक से जोड़ रहा हूँ। कृपया रुकिए।",
            "en": "I'm connecting you to a human agent right now. Please stay on the line.",
            "kanglish": "ನಾನು ನಿಮ್ಮನ್ನು human agent ಗೆ connect ಮಾಡುತ್ತಿದ್ದೇನೆ. Please hold.",
            "hinglish": "Main aapko abhi ek insaan se connect kar raha hoon. Please rukiye.",
        },
    }

    def _lang_phrase(self, key: str, lang: str = None) -> str:
        lang = lang or self.state.current_analysis.language_detected.value
        phrases = self.PHRASES.get(key, {})
        return phrases.get(lang, phrases.get("en", ""))
