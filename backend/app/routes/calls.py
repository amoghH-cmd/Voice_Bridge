"""
VoiceBridge — Calls Routes + WebSocket Audio Stream
"""

import logging
import uuid
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, Call, CallStatus
from app.schemas import CallCreate, CallResponse
from app.services.pipeline import get_session, register_session, close_session, CallSession
from app.websocket.manager import manager

router = APIRouter()
logger = logging.getLogger("voicebridge.calls")


# ──────────────────────────────────────────────────────────────────
# REST: Create / list calls
# ──────────────────────────────────────────────────────────────────
@router.post("/", response_model=CallResponse, status_code=201)
async def create_call(payload: CallCreate, db: AsyncSession = Depends(get_db)):
    """Manually create a call record (for testing / direct API use)."""
    call_id = str(uuid.uuid4())
    call = Call(
        id=call_id,
        phone_number=payload.phone_number,
        twilio_call_sid=payload.twilio_call_sid,
        exotel_call_sid=payload.exotel_call_sid,
        status=CallStatus.ACTIVE,
    )
    db.add(call)
    session = CallSession(call_id=call_id, phone_number=payload.phone_number)
    register_session(session)
    return call


@router.get("/", response_model=list[CallResponse])
async def list_calls(
    status: str = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    q = select(Call).order_by(Call.started_at.desc()).limit(limit)
    if status:
        try:
            q = q.where(Call.status == CallStatus(status))
        except ValueError:
            raise HTTPException(400, f"Invalid status: {status}")
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/{call_id}", response_model=CallResponse)
async def get_call(call_id: str, db: AsyncSession = Depends(get_db)):
    call = await db.get(Call, call_id)
    if not call:
        raise HTTPException(404, "Call not found")
    return call


# ──────────────────────────────────────────────────────────────────
# WebSocket: Real-time audio stream (Twilio Media Streams protocol)
# ──────────────────────────────────────────────────────────────────
@router.websocket("/stream/{call_id}")
async def audio_stream(websocket: WebSocket, call_id: str):
    """
    Twilio Media Streams WebSocket endpoint.
    Receives:  { event: "media", media: { payload: <base64 mulaw> } }
    Sends:     { event: "mark", streamSid: ... }  (for Twilio sync)
    """
    await websocket.accept()
    session = get_session(call_id)

    if not session:
        await websocket.close(code=1008, reason="Unknown call_id")
        return

    logger.info(f"[{call_id}] 🎙️  Audio stream opened")
    import json, base64

    try:
        async for raw in websocket.iter_text():
            data = json.loads(raw)
            event_type = data.get("event", "")

            if event_type == "connected":
                logger.debug(f"[{call_id}] Stream connected")

            elif event_type == "start":
                logger.info(f"[{call_id}] Stream started: {data.get('start', {})}")

            elif event_type == "media":
                # Decode base64 µ-law audio
                payload = data.get("media", {}).get("payload", "")
                if payload:
                    audio_bytes = base64.b64decode(payload)
                    await session.ingest_audio_chunk(audio_bytes)

            elif event_type == "stop":
                logger.info(f"[{call_id}] Stream stopped — running analysis")
                if session.transcript_buffer.strip():
                    analysis = await session.run_analysis()
                    opening = session.init_confirmation()
                    logger.info(f"[{call_id}] Confirmation prompt: {opening[:80]}")
                break

    except WebSocketDisconnect:
        logger.info(f"[{call_id}] Stream WebSocket disconnected")
    except Exception as e:
        logger.error(f"[{call_id}] Stream error: {e}")
    finally:
        logger.info(f"[{call_id}] 🎙️  Audio stream closed")


# ──────────────────────────────────────────────────────────────────
# REST: Confirmation response (from IVR second pass)
# ──────────────────────────────────────────────────────────────────
@router.post("/{call_id}/confirm")
async def submit_confirmation(call_id: str, payload: dict):
    """
    Receive caller's YES/NO/PARTIAL response (from IVR or manual test).
    Body: { "user_response": "yes" }
    """
    session = get_session(call_id)
    if not session:
        raise HTTPException(404, "Active call session not found")

    user_response = payload.get("user_response", "")
    result = await session.handle_confirmation_response(user_response)

    return JSONResponse({
        "call_id": call_id,
        "action": result["action"],
        "next_prompt": result.get("next_prompt", ""),
        "ticket_id": session.ticket_id,
    })


# ──────────────────────────────────────────────────────────────────
# WebSocket: Agent dashboard live feed
# ──────────────────────────────────────────────────────────────────
@router.websocket("/ws/dashboard/{agent_id}")
async def dashboard_ws(websocket: WebSocket, agent_id: str):
    """
    WebSocket endpoint for agent dashboard.
    Agent connects here to receive real-time ticket/escalation events.
    """
    await manager.connect(websocket, agent_id)
    try:
        while True:
            # Keep-alive: echo pings from client
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(agent_id)
    except Exception as e:
        logger.error(f"Dashboard WS error ({agent_id}): {e}")
        manager.disconnect(agent_id)
