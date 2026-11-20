"""
app.py
FastAPI backend for the AI Customer Support Agent.

Endpoints:
    GET  /health  - service status
    POST /chat    - send a customer message through the CrewAI support crew
    GET  /        - browser interface served from ./frontend
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from crew import SupportCrewError, run_support_crew

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

FRONTEND_DIR = BASE_DIR / "frontend"
APP_VERSION = "1.0.0"
DEFAULT_MODEL = "groq/openai/gpt-oss-120b"
DEBUG = os.getenv("DEBUG", "false").strip().lower() in {"1", "true", "yes", "on"}
CREW_TIMEOUT_SECONDS = float(os.getenv("CREW_TIMEOUT_SECONDS", "120"))
DEFAULT_CORS_ORIGINS = "http://127.0.0.1:8000,http://localhost:8000"

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("support_api")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    message: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="The customer's question or message.",
        examples=["Where is my order ORD1001?"],
    )

    @field_validator("message")
    @classmethod
    def strip_and_reject_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Message cannot be blank.")
        return cleaned


class ChatResponse(BaseModel):
    answer: str = Field(..., description="Customer-facing response from the support crew.")


class HealthResponse(BaseModel):
    status: str
    version: str
    model: str


class ErrorResponse(BaseModel):
    detail: str


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="AI Customer Support Agent",
    version=APP_VERSION,
    description="Three-agent CrewAI customer support service powered by Groq.",
)


def _allowed_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS)
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Accept"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected server error occurred. Please try again later."},
    )


@app.get("/health", response_model=HealthResponse, tags=["system"])
async def health() -> HealthResponse:
    """Report that the API is running and which model is configured."""
    return HealthResponse(
        status="ok",
        version=APP_VERSION,
        model=os.getenv("MODEL_NAME", DEFAULT_MODEL),
    )


@app.post(
    "/chat",
    response_model=ChatResponse,
    responses={
        400: {"model": ErrorResponse, "description": "Invalid message content."},
        422: {"description": "Request body failed validation."},
        503: {"model": ErrorResponse, "description": "The support assistant is unavailable."},
        504: {"model": ErrorResponse, "description": "The assistant took too long to respond."},
    },
    tags=["support"],
)
async def chat(payload: ChatRequest) -> ChatResponse:
    """Send a customer message through the three-agent CrewAI workflow."""
    logger.info("Chat request received (%d characters)", len(payload.message))

    try:
        # The CrewAI workflow is synchronous, so run it in a worker thread
        # to keep the event loop free for other requests.
        answer = await asyncio.wait_for(
            asyncio.to_thread(run_support_crew, payload.message),
            timeout=CREW_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        logger.warning("Support crew exceeded %.0f seconds", CREW_TIMEOUT_SECONDS)
        raise HTTPException(
            status_code=504,
            detail="The assistant took too long to respond. Please try again.",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SupportCrewError as exc:
        logger.error("Support crew failed: %s", exc)
        detail = str(exc) if DEBUG else (
            "The support assistant is temporarily unavailable. Please try again shortly."
        )
        raise HTTPException(status_code=503, detail=detail) from exc

    return ChatResponse(answer=answer)


# Mount the frontend last so the API routes above take priority.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
else:
    logger.warning("Frontend directory not found at %s", FRONTEND_DIR)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.getenv("APP_HOST", "127.0.0.1"),
        port=int(os.getenv("APP_PORT", "8000")),
        reload=DEBUG,
    )