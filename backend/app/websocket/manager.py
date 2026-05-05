"""
VoiceBridge — WebSocket Connection Manager (Section 6 · Agent Dashboard)
Broadcasts real-time events to all connected agent dashboards.
Events: new_ticket · escalation · ticket_update · call_status
"""

import json
import logging
from datetime import datetime
from typing import Dict, Set
from fastapi import WebSocket

logger = logging.getLogger("voicebridge.ws")


class ConnectionManager:
    """
    In-process WebSocket manager.
    For multi-process production: swap to Redis pub/sub.
    """

    def __init__(self):
        # agent_id → WebSocket
        self.active: Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, agent_id: str):
        await websocket.accept()
        self.active[agent_id] = websocket
        logger.info(f"🔌 Agent connected: {agent_id} | total={len(self.active)}")
        # Send connection ack
        await self.send_to(agent_id, {
            "event": "connected",
            "data": {"message": "VoiceBridge dashboard live", "agent_id": agent_id},
        })

    def disconnect(self, agent_id: str):
        self.active.pop(agent_id, None)
        logger.info(f"🔌 Agent disconnected: {agent_id} | total={len(self.active)}")

    async def broadcast(self, event: str, data: dict):
        """Send event to ALL connected agents."""
        payload = json.dumps({
            "event": event,
            "data": data,
            "timestamp": datetime.utcnow().isoformat(),
        })
        dead: list = []
        for agent_id, ws in self.active.items():
            try:
                await ws.send_text(payload)
            except Exception as e:
                logger.warning(f"Dead WS for {agent_id}: {e}")
                dead.append(agent_id)
        for a in dead:
            self.disconnect(a)

    async def send_to(self, agent_id: str, payload: dict):
        """Send to a specific agent."""
        ws = self.active.get(agent_id)
        if not ws:
            return
        try:
            await ws.send_text(json.dumps(payload))
        except Exception as e:
            logger.warning(f"WS send error ({agent_id}): {e}")
            self.disconnect(agent_id)

    async def broadcast_new_ticket(self, ticket_data: dict):
        await self.broadcast("new_ticket", ticket_data)

    async def broadcast_escalation(self, escalation_data: dict):
        await self.broadcast("escalation", escalation_data)

    async def broadcast_ticket_update(self, ticket_id: str, update: dict):
        await self.broadcast("ticket_update", {"ticket_id": ticket_id, **update})

    async def broadcast_call_status(self, call_id: str, status: str):
        await self.broadcast("call_status", {"call_id": call_id, "status": status})

    def connected_agents(self) -> list:
        return list(self.active.keys())


# ── Singleton shared across the app ──────────────────────────────
manager = ConnectionManager()
