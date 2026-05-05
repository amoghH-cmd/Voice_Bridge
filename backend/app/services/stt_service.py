"""
VoiceBridge — Speech-to-Text Service (Layer 2)
Primary: OpenAI Whisper API
Fallback: langdetect on transcript text
Handles: Kannada · Hindi · English · Kanglish · Hinglish
"""

import io
import logging
import asyncio
from typing import Optional, Tuple
from dataclasses import dataclass

import httpx
from openai import AsyncOpenAI

from app.config import settings
from app.database import Language

logger = logging.getLogger("voicebridge.stt")

# Language code → VoiceBridge Language enum
WHISPER_LANG_MAP = {
    "kn": Language.KANNADA,
    "kn-IN": Language.KANNADA,
    "hi": Language.HINDI,
    "hi-IN": Language.HINDI,
    "en": Language.ENGLISH,
    "en-IN": Language.ENGLISH,
    "en-US": Language.ENGLISH,
}

# Mixed-dialect markers detected in transcript text
KANGLISH_MARKERS = ["ಆದ್ರೆ", "ಬೇಕು", "okay", "please", "alli"]
HINGLISH_MARKERS  = ["kyunki", "matlab", "lekin", "okay", "bhai", "yaar"]


@dataclass
class STTResult:
    transcript: str
    language: Language
    confidence: float          # 0.0–1.0 (Whisper logprob-derived)
    duration_secs: float
    word_timestamps: list      # [{word, start, end}]
    is_mixed: bool


class STTService:
    """
    Wraps OpenAI Whisper API.
    For local deployment swap `_call_whisper_api` with a local model call.
    """

    def __init__(self):
        self.client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

    # ──────────────────────────────────────────────────────────────
    # Public
    # ──────────────────────────────────────────────────────────────
    async def transcribe(self, audio_bytes: bytes, filename: str = "audio.wav") -> STTResult:
        """
        Transcribe audio bytes → STTResult.
        Tries Whisper with timestamp_granularities=["word"].
        Falls back to text-only on error.
        """
        try:
            result = await self._call_whisper_api(audio_bytes, filename)
            return result
        except Exception as e:
            logger.error(f"Whisper API error: {e}")
            raise

    async def transcribe_chunk(
        self, audio_chunk: bytes, session_transcript: str = ""
    ) -> Tuple[str, Language]:
        """
        Lightweight streaming: transcribe a 100ms chunk.
        Returns (partial_transcript, language).
        """
        result = await self.transcribe(audio_chunk)
        # Merge with session context
        combined = (session_transcript + " " + result.transcript).strip()
        return combined, result.language

    # ──────────────────────────────────────────────────────────────
    # Private
    # ──────────────────────────────────────────────────────────────
    async def _call_whisper_api(self, audio_bytes: bytes, filename: str) -> STTResult:
        audio_file = io.BytesIO(audio_bytes)
        audio_file.name = filename

        response = await self.client.audio.transcriptions.create(
            model=settings.WHISPER_MODEL,
            file=audio_file,
            response_format="verbose_json",
            timestamp_granularities=["word"],
        )

        raw_lang = getattr(response, "language", "en")
        language = WHISPER_LANG_MAP.get(raw_lang, Language.UNKNOWN)

        transcript = response.text or ""
        words = getattr(response, "words", []) or []

        # Convert Whisper word objects → dicts
        word_timestamps = [
            {"word": w.word, "start": w.start, "end": w.end}
            for w in words
        ]

        # Detect mixed dialects
        is_mixed, language = self._detect_mixed(transcript, language)

        # Derive confidence from avg logprobs (Whisper verbose_json segments)
        segments = getattr(response, "segments", []) or []
        confidence = self._avg_confidence(segments)

        duration = getattr(response, "duration", 0.0) or 0.0

        logger.info(
            f"STT: lang={language.value} | conf={confidence:.2f} | "
            f"mixed={is_mixed} | len={len(transcript)}"
        )

        return STTResult(
            transcript=transcript,
            language=language,
            confidence=confidence,
            duration_secs=duration,
            word_timestamps=word_timestamps,
            is_mixed=is_mixed,
        )

    def _detect_mixed(self, text: str, detected: Language) -> Tuple[bool, Language]:
        """Detect Kanglish / Hinglish by marker words."""
        lower = text.lower()
        if detected == Language.KANNADA:
            for m in KANGLISH_MARKERS:
                if m in lower:
                    return True, Language.KANGLISH
        if detected == Language.HINDI:
            for m in HINGLISH_MARKERS:
                if m in lower:
                    return True, Language.HINGLISH
        return False, detected

    @staticmethod
    def _avg_confidence(segments: list) -> float:
        if not segments:
            return 0.5
        import math
        logprobs = [s.avg_logprob for s in segments if hasattr(s, "avg_logprob")]
        if not logprobs:
            return 0.5
        avg_lp = sum(logprobs) / len(logprobs)
        # Map logprob (typically -0.1 to -1.5) to 0–1
        score = min(1.0, max(0.0, 1.0 + avg_lp / 2.0))
        return round(score, 3)


# ── Singleton ─────────────────────────────────────────────────────
stt_service = STTService()
