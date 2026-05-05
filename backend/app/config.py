"""
VoiceBridge — Central Configuration
All secrets loaded from environment variables / .env file
"""

from pydantic_settings import BaseSettings
from typing import List
import os


class Settings(BaseSettings):
    # ── App ──────────────────────────────────────────────────────
    APP_NAME: str = "AI VoiceBridge 1092"
    ENV: str = "development"
    SECRET_KEY: str = "change-me-in-production-use-256-bit-random"
    ALLOWED_ORIGINS: List[str] = ["http://localhost:3000", "http://localhost:8000", "*"]

    # ── Database ─────────────────────────────────────────────────
    DATABASE_URL: str = "sqlite+aiosqlite:///./voicebridge.db"
    # For production use PostgreSQL:
    # DATABASE_URL: str = "postgresql+asyncpg://user:pass@localhost/voicebridge"

    # ── Anthropic / Claude ───────────────────────────────────────
    ANTHROPIC_API_KEY: str = "sk-ant-REPLACE_ME"
    CLAUDE_MODEL: str = "claude-3-5-sonnet-20241022"
    CLAUDE_MAX_TOKENS: int = 1024
    CLAUDE_TEMPERATURE: float = 0.1          # Low temp for consistency

    # ── OpenAI / Whisper ─────────────────────────────────────────
    OPENAI_API_KEY: str = "sk-REPLACE_ME"
    WHISPER_MODEL: str = "whisper-1"         # or large-v3 via local Whisper

    # ── Twilio ───────────────────────────────────────────────────
    TWILIO_ACCOUNT_SID: str = "ACxxxxxx"
    TWILIO_AUTH_TOKEN: str = "xxxxxx"
    TWILIO_PHONE_NUMBER: str = "+91xxxxxxxxxx"

    # ── Exotel (Indian PSTN alternative) ─────────────────────────
    EXOTEL_SID: str = "REPLACE_ME"
    EXOTEL_TOKEN: str = "REPLACE_ME"
    EXOTEL_SUBDOMAIN: str = "api.exotel.com"

    # ── STT Config ───────────────────────────────────────────────
    STT_CHUNK_MS: int = 100
    STT_LANGUAGE_DETECTION: bool = True
    SUPPORTED_LANGUAGES: List[str] = ["kn", "hi", "en", "kn-IN", "hi-IN", "en-IN"]

    # ── Confirmation Engine ───────────────────────────────────────
    MAX_CONFIRMATION_RETRIES: int = 3
    CONFIDENCE_THRESHOLD: int = 70          # Below → escalate
    HIGH_EMOTION_ESCALATE: bool = True

    # ── Agent Dashboard ───────────────────────────────────────────
    WEBSOCKET_HEARTBEAT_SECS: int = 30
    MAX_AGENT_CONNECTIONS: int = 50

    # ── Redis (for WebSocket pub/sub & sessions) ──────────────────
    REDIS_URL: str = "redis://localhost:6379"
    USE_REDIS: bool = False                 # Set True in production

    # ── Logging ───────────────────────────────────────────────────
    LOG_LEVEL: str = "INFO"
    LOG_JSON: bool = False                  # True → structured JSON logs

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
