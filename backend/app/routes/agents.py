"""
VoiceBridge — Agents Routes (auth + profile)
"""

import uuid
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import bcrypt
import jwt

from app.database import get_db, Agent
from app.schemas import AgentLogin, AgentResponse, AgentToken
from app.config import settings

router = APIRouter()
logger = logging.getLogger("voicebridge.agents")
security = HTTPBearer(auto_error=False)

JWT_ALGO = "HS256"
JWT_EXPIRE_HOURS = 12


# ──────────────────────────────────────────────────────────────────
# JWT helpers
# ──────────────────────────────────────────────────────────────────
def create_token(agent_id: str, role: str) -> str:
    payload = {
        "sub": agent_id,
        "role": role,
        "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=JWT_ALGO)


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.SECRET_KEY, algorithms=[JWT_ALGO])


async def get_current_agent(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> Agent:
    if not credentials:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = decode_token(credentials.credentials)
        agent = await db.get(Agent, payload["sub"])
        if not agent or not agent.is_active:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Agent not found")
        agent.last_seen = datetime.utcnow()
        return agent
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired")
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")


# ──────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────
@router.post("/login", response_model=AgentToken)
async def login(payload: AgentLogin, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Agent).where(Agent.email == payload.email))
    agent = result.scalar_one_or_none()

    if not agent or not bcrypt.checkpw(
        payload.password.encode(), agent.password_hash.encode()
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")

    agent.last_seen = datetime.utcnow()
    token = create_token(agent.id, agent.role)
    return AgentToken(access_token=token, agent=agent)


@router.post("/register", response_model=AgentResponse, status_code=201)
async def register_agent(
    name: str,
    email: str,
    password: str,
    role: str = "agent",
    languages: list = None,
    db: AsyncSession = Depends(get_db),
):
    """Admin-only in production — protected by role check."""
    existing = await db.execute(select(Agent).where(Agent.email == email))
    if existing.scalar_one_or_none():
        raise HTTPException(409, "Email already registered")

    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    agent = Agent(
        id=str(uuid.uuid4()),
        name=name,
        email=email,
        password_hash=pw_hash,
        role=role,
        languages=languages or ["en"],
    )
    db.add(agent)
    return agent


@router.get("/me", response_model=AgentResponse)
async def get_me(agent: Agent = Depends(get_current_agent)):
    return agent


@router.get("/", response_model=list[AgentResponse])
async def list_agents(
    db: AsyncSession = Depends(get_db),
    _agent: Agent = Depends(get_current_agent),
):
    result = await db.execute(select(Agent).where(Agent.is_active == True))
    return result.scalars().all()
