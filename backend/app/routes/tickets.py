"""
VoiceBridge — Tickets Routes (Section 6 · Agent Dashboard)
"""

import logging
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, Ticket, AgentEdit, TicketStatus
from app.schemas import TicketCreate, TicketUpdate, TicketResponse
from app.websocket.manager import manager

router = APIRouter()
logger = logging.getLogger("voicebridge.tickets")


@router.get("/", response_model=list[TicketResponse])
async def list_tickets(
    status: str = None,
    emotion: str = None,
    language: str = None,
    district: str = None,
    limit: int = Query(default=50, le=200),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    """List tickets with optional filters — powers the agent dashboard."""
    q = select(Ticket).order_by(desc(Ticket.created_at)).offset(offset).limit(limit)
    if status:
        try:
            q = q.where(Ticket.status == TicketStatus(status))
        except ValueError:
            pass
    if emotion:
        q = q.where(Ticket.emotion == emotion.upper())
    if language:
        q = q.where(Ticket.language == language.lower())
    if district:
        q = q.where(Ticket.district.ilike(f"%{district}%"))

    result = await db.execute(q)
    return result.scalars().all()


@router.get("/stats")
async def ticket_stats(db: AsyncSession = Depends(get_db)):
    """Aggregate stats for dashboard overview cards."""
    from sqlalchemy import func, case

    result = await db.execute(
        select(
            func.count(Ticket.id).label("total"),
            func.sum(case((Ticket.status == TicketStatus.OPEN, 1), else_=0)).label("open"),
            func.sum(case((Ticket.status == TicketStatus.ESCALATED, 1), else_=0)).label("escalated"),
            func.sum(case((Ticket.emotion.in_(["HIGH", "PANIC"]), 1), else_=0)).label("high_emotion"),
            func.avg(Ticket.confidence).label("avg_confidence"),
        )
    )
    row = result.first()
    return {
        "total": row.total or 0,
        "open": row.open or 0,
        "escalated": row.escalated or 0,
        "high_emotion": row.high_emotion or 0,
        "avg_confidence": round(float(row.avg_confidence or 0), 1),
    }


@router.get("/{ticket_id}", response_model=TicketResponse)
async def get_ticket(ticket_id: str, db: AsyncSession = Depends(get_db)):
    ticket = await db.get(Ticket, ticket_id)
    if not ticket:
        raise HTTPException(404, "Ticket not found")
    return ticket


@router.patch("/{ticket_id}", response_model=TicketResponse)
async def update_ticket(
    ticket_id: str,
    payload: TicketUpdate,
    agent_id: str = Query(default="unknown"),
    db: AsyncSession = Depends(get_db),
):
    """
    Agent edits a ticket field.
    All changes logged to AgentEdit for training data.
    """
    ticket = await db.get(Ticket, ticket_id)
    if not ticket:
        raise HTTPException(404, "Ticket not found")

    update_data = payload.model_dump(exclude_none=True)

    for field_name, new_val in update_data.items():
        original = getattr(ticket, field_name, None)
        if original != new_val:
            # Log correction
            edit = AgentEdit(
                ticket_id=ticket_id,
                agent_id=agent_id,
                field_name=field_name,
                original_value=str(original),
                corrected_value=str(new_val),
            )
            db.add(edit)
            setattr(ticket, field_name, new_val)

    await db.flush()

    # Broadcast update to dashboard
    await manager.broadcast_ticket_update(ticket_id, {
        "status": ticket.status.value if ticket.status else None,
        "agent_notes": ticket.agent_notes,
        "assigned_agent": ticket.assigned_agent,
        "updated_by": agent_id,
    })

    return ticket


@router.post("/{ticket_id}/escalate")
async def escalate_ticket(
    ticket_id: str,
    reason: str = Query(default="Manual escalation by agent"),
    agent_id: str = Query(default="unknown"),
    db: AsyncSession = Depends(get_db),
):
    ticket = await db.get(Ticket, ticket_id)
    if not ticket:
        raise HTTPException(404, "Ticket not found")

    ticket.status = TicketStatus.ESCALATED
    ticket.assigned_agent = agent_id

    await manager.broadcast_escalation({
        "ticket_id": ticket_id,
        "call_id": ticket.call_id,
        "reason": reason,
        "escalated_by": agent_id,
    })

    return {"ticket_id": ticket_id, "status": "ESCALATED"}


@router.post("/{ticket_id}/resolve")
async def resolve_ticket(
    ticket_id: str,
    resolution: str = Query(...),
    agent_id: str = Query(default="unknown"),
    db: AsyncSession = Depends(get_db),
):
    ticket = await db.get(Ticket, ticket_id)
    if not ticket:
        raise HTTPException(404, "Ticket not found")

    ticket.status = TicketStatus.RESOLVED
    ticket.resolution = resolution
    ticket.assigned_agent = agent_id

    await manager.broadcast_ticket_update(ticket_id, {"status": "RESOLVED"})
    return {"ticket_id": ticket_id, "status": "RESOLVED"}
