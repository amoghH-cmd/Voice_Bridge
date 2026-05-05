"""
VoiceBridge — Health Check Routes
"""
from datetime import datetime
from fastapi import APIRouter
from app.websocket.manager import manager

router = APIRouter()

@router.get("/")
async def health():
    return {
        "status": "ok",
        "service": "AI VoiceBridge 1092",
        "timestamp": datetime.utcnow().isoformat(),
        "connected_agents": len(manager.connected_agents()),
    }

@router.get("/ready")
async def readiness():
    """Kubernetes readiness probe."""
    return {"ready": True}

@router.get("/live")
async def liveness():
    """Kubernetes liveness probe."""
    return {"alive": True}
