"""
VoiceBridge — Webhook Routes (Twilio / Exotel telephony callbacks)
"""

import uuid
import logging
from fastapi import APIRouter, Request, Form, Depends
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, Call, CallStatus
from app.services.pipeline import CallSession, register_session, get_session, close_session
from app.websocket.manager import manager

router = APIRouter()
logger = logging.getLogger("voicebridge.webhooks")


# ──────────────────────────────────────────────────────────────────
# Twilio — Incoming call
# ──────────────────────────────────────────────────────────────────
@router.post("/twilio/call")
async def twilio_incoming_call(
    CallSid: str = Form(...),
    From: str = Form(...),
    To: str = Form(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Twilio calls this URL when a new PSTN call arrives.
    Returns TwiML to open a WebSocket media stream.
    """
    call_id = str(uuid.uuid4())
    logger.info(f"📞 Twilio call: {CallSid} from {From}")

    # Persist call record
    call = Call(
        id=call_id,
        phone_number=From,
        twilio_call_sid=CallSid,
        status=CallStatus.ACTIVE,
    )
    db.add(call)

    # Register pipeline session
    session = CallSession(call_id=call_id, phone_number=From)
    register_session(session)

    await manager.broadcast_call_status(call_id, "ACTIVE")

    # TwiML: open WebSocket stream to our backend
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="kn-IN">ನಮಸ್ಕಾರ. ೧೦೯೨ ಸಹಾಯ ವಾಣಿಗೆ ಸ್ವಾಗತ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಸಮಸ್ಯೆ ತಿಳಿಸಿ.</Say>
  <Connect>
    <Stream url="wss://YOUR_DOMAIN/api/calls/stream/{call_id}" />
  </Connect>
</Response>"""

    return Response(content=twiml, media_type="text/xml")


@router.post("/twilio/status")
async def twilio_status_callback(
    CallSid: str = Form(...),
    CallStatus: str = Form(...),
    CallDuration: str = Form(default="0"),
    db: AsyncSession = Depends(get_db),
):
    """Twilio call status updates."""
    logger.info(f"Twilio status update: {CallSid} → {CallStatus}")
    # Map Twilio status to ours
    if CallStatus in ("completed", "busy", "no-answer", "failed"):
        close_session(CallSid)
    return Response(status_code=204)


# ──────────────────────────────────────────────────────────────────
# Exotel — Indian PSTN alternative
# ──────────────────────────────────────────────────────────────────
@router.post("/exotel/call")
async def exotel_incoming_call(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Exotel passthru webhook.
    """
    form = await request.form()
    call_sid = form.get("CallSid", str(uuid.uuid4()))
    caller   = form.get("From", "unknown")

    call_id = str(uuid.uuid4())
    call = Call(
        id=call_id,
        phone_number=caller,
        exotel_call_sid=call_sid,
        status=CallStatus.ACTIVE,
    )
    db.add(call)

    session = CallSession(call_id=call_id, phone_number=caller)
    register_session(session)

    await manager.broadcast_call_status(call_id, "ACTIVE")

    # Exotel uses XML responses as well
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Namaskara. 1092 helpline ge swagata. Dayavittu nimma samasye tilisi.</Say>
  <Record maxLength="30" action="/api/webhook/exotel/recording/{call_id}" />
</Response>"""
    return Response(content=xml, media_type="text/xml")


@router.post("/exotel/recording/{call_id}")
async def exotel_recording(
    call_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Exotel sends recording URL here.
    Download audio → feed through pipeline.
    """
    import httpx
    form = await request.form()
    recording_url = form.get("RecordingUrl", "")

    session = get_session(call_id)
    if not session or not recording_url:
        return Response(status_code=204)

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(recording_url)
            audio_bytes = resp.content

        # Run full pipeline
        await session.ingest_audio_chunk(audio_bytes)
        analysis = await session.run_analysis()
        opening_prompt = session.init_confirmation()

        logger.info(
            f"[{call_id}] Analysis complete. "
            f"Intent={analysis.intent_category.value} "
            f"Confidence={analysis.confidence}"
        )

        return Response(status_code=204)
    except Exception as e:
        logger.error(f"[{call_id}] Recording pipeline error: {e}")
        return Response(status_code=500)
