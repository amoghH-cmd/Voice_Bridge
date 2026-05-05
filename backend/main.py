"""
AI VoiceBridge — 1092 Karnataka Helpline
FastAPI Backend Entry Point
Production-Ready · Multilingual · Confirmation-First
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse

from app.config import settings
from app.routes import calls, tickets, agents, webhooks, health
from app.websocket.manager import ConnectionManager
from app.database import init_db

# ──────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("voicebridge")


# ──────────────────────────────────────────────────────────────────
# Lifespan — startup / shutdown
# ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 VoiceBridge starting up …")
    await init_db()
    logger.info("✅ Database initialised")
    yield
    logger.info("🛑 VoiceBridge shutting down …")


# ──────────────────────────────────────────────────────────────────
# App
# ──────────────────────────────────────────────────────────────────
app = FastAPI(
    title="AI VoiceBridge — 1092 Karnataka Helpline",
    description=(
        "Production-grade multilingual voice helpline backend. "
        "Supports Kannada, Hindi, English, and mixed dialects. "
        "Five-layer pipeline: Telephony → STT → LLM → Confirmation → Dashboard."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# ──────────────────────────────────────────────────────────────────
# Middleware
# ──────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────
app.include_router(health.router,    prefix="/api/health",   tags=["Health"])
app.include_router(webhooks.router,  prefix="/api/webhook",  tags=["Telephony"])
app.include_router(calls.router,     prefix="/api/calls",    tags=["Calls"])
app.include_router(tickets.router,   prefix="/api/tickets",  tags=["Tickets"])
app.include_router(agents.router,    prefix="/api/agents",   tags=["Agents"])


# ──────────────────────────────────────────────────────────────────
# Serve Agent Dashboard (static SPA)
# ──────────────────────────────────────────────────────────────────
DASHBOARD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "dashboard")
if os.path.isdir(DASHBOARD_DIR):
    app.mount("/dashboard", StaticFiles(directory=DASHBOARD_DIR, html=True), name="dashboard")


@app.get("/", include_in_schema=False)
async def root():
    return HTMLResponse(
        "<h2>AI VoiceBridge 1092 — Backend Running</h2>"
        "<p><a href='/api/docs'>API Docs</a> | "
        "<a href='/dashboard'>Agent Dashboard</a></p>"
    )


# ──────────────────────────────────────────────────────────────────
# Dev run
# ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
