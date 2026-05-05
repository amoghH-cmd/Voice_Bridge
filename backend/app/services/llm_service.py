"""
VoiceBridge — LLM Service (Layer 3)
Model: Claude 3.5 Sonnet
Tasks (parallel in single call):
  1. Intent extraction  (category + sub-type)
  2. Summarisation      (≤60 words)
  3. Emotion detection  (LOW / MEDIUM / HIGH / PANIC)
  4. Confirmation gen   (AI restates issue for user)

Strict JSON-only output — no prose, no markdown fences.
"""

import json
import logging
import re
from typing import Optional

import anthropic

from app.config import settings
from app.schemas import LLMAnalysis
from app.database import IntentCategory, Emotion, Language
from app.prompts import (
    SYSTEM_PROMPT, build_analysis_prompt,
    build_confirmation_refine_prompt
)

logger = logging.getLogger("voicebridge.llm")

# ── Anthropic client ─────────────────────────────────────────────
_client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)


class LLMService:

    async def analyse(
        self,
        transcript: str,
        language: Language,
        call_id: str,
        session_history: Optional[list] = None,
    ) -> LLMAnalysis:
        """
        Full analysis pass — single API call, structured JSON output.
        Returns typed LLMAnalysis.
        """
        user_prompt = build_analysis_prompt(
            transcript=transcript,
            language=language.value,
            session_history=session_history or [],
        )

        logger.info(f"[{call_id}] Calling Claude for full analysis …")

        import asyncio
        loop = asyncio.get_event_loop()
        raw_response = await loop.run_in_executor(
            None, self._sync_call, SYSTEM_PROMPT, user_prompt
        )

        return self._parse_analysis(raw_response, call_id)

    async def refine(
        self,
        original_analysis: LLMAnalysis,
        user_correction: str,
        language: Language,
        attempt: int,
        call_id: str,
    ) -> LLMAnalysis:
        """
        Refinement pass — user said NO/PARTIAL.
        Incorporates correction and re-extracts.
        """
        user_prompt = build_confirmation_refine_prompt(
            original=original_analysis,
            user_correction=user_correction,
            language=language.value,
            attempt=attempt,
        )

        logger.info(f"[{call_id}] Refinement pass #{attempt} …")

        import asyncio
        loop = asyncio.get_event_loop()
        raw_response = await loop.run_in_executor(
            None, self._sync_call, SYSTEM_PROMPT, user_prompt
        )

        return self._parse_analysis(raw_response, call_id)

    # ── Private ──────────────────────────────────────────────────
    def _sync_call(self, system: str, user: str) -> str:
        """Synchronous Anthropic call (run in thread executor)."""
        msg = _client.messages.create(
            model=settings.CLAUDE_MODEL,
            max_tokens=settings.CLAUDE_MAX_TOKENS,
            temperature=settings.CLAUDE_TEMPERATURE,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return msg.content[0].text

    def _parse_analysis(self, raw: str, call_id: str) -> LLMAnalysis:
        """Extract JSON from Claude response and validate into LLMAnalysis."""
        # Strip any accidental markdown fences
        raw = re.sub(r"```(?:json)?", "", raw).strip()

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            logger.error(f"[{call_id}] JSON parse error: {e}\nRaw: {raw[:400]}")
            # Return safe default
            return self._fallback_analysis()

        # Normalise enums
        try:
            data["intent_category"] = IntentCategory(
                data.get("intent_category", "other")
            )
        except ValueError:
            data["intent_category"] = IntentCategory.OTHER

        try:
            data["emotion"] = Emotion(data.get("emotion", "LOW"))
        except ValueError:
            data["emotion"] = Emotion.LOW

        try:
            data["language_detected"] = Language(
                data.get("language_detected", "unknown")
            )
        except ValueError:
            data["language_detected"] = Language.UNKNOWN

        # Clamp confidence
        data["confidence"] = max(0.0, min(100.0, float(data.get("confidence", 50))))

        try:
            analysis = LLMAnalysis(**data)
            logger.info(
                f"[{call_id}] Analysis: intent={analysis.intent_category.value} | "
                f"conf={analysis.confidence} | emotion={analysis.emotion.value}"
            )
            return analysis
        except Exception as e:
            logger.error(f"[{call_id}] Schema validation error: {e}")
            return self._fallback_analysis()

    @staticmethod
    def _fallback_analysis() -> LLMAnalysis:
        return LLMAnalysis(
            intent_category=IntentCategory.OTHER,
            intent_subtype="unknown",
            summary="Could not extract information. Please ask caller to repeat.",
            emotion=Emotion.MEDIUM,
            confidence=0.0,
            language_detected=Language.UNKNOWN,
            confirmation_sentence="I'm sorry, I didn't understand. Could you please describe your issue again?",
            needs_escalation=True,
            escalation_reason="LLM parse failure",
        )


llm_service = LLMService()
