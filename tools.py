"""
tools.py
Reusable CrewAI tools for the AI Customer Support Agent.

Each capability has two layers:
    * a plain Python function (find_order, search_policies, create_ticket_record)
      that is easy to test and reuse outside CrewAI, and
    * a CrewAI tool (lookup_order, search_policy, create_support_ticket) that wraps
      it and returns JSON text the agents can read.

All data lives in data/knowledge_base.json. Writes are atomic (temp file + os.replace)
and serialised with a lock, so the file is never left half-written.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from crewai.tools import tool

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
KNOWLEDGE_BASE_PATH = BASE_DIR / "data" / "knowledge_base.json"

POLICY_TOPICS = ("refund", "return", "shipping", "cancellation", "payment")
MAX_POLICY_RESULTS = 3

# Serialises writes made by concurrent requests inside this process.
_DB_LOCK = threading.Lock()

_STOPWORDS = {
    "the", "and", "for", "with", "can", "you", "your", "are", "was", "have", "has",
    "how", "what", "when", "where", "why", "who", "does", "did", "this", "that",
    "from", "want", "need", "help", "please", "about", "there", "into", "any", "my",
    "our", "its", "not", "but", "get", "got", "will", "would", "could", "should",
    "just", "like", "some", "they", "them", "their", "its", "more", "long", "take",
}

# Maps common customer wording onto the policy topics used in the knowledge base.
_SYNONYMS = {
    "refunds": "refund", "refunded": "refund", "reimbursed": "refund",
    "returns": "return", "returning": "return", "returned": "return",
    "exchange": "return", "exchanges": "return",
    "shipment": "shipping", "shipments": "shipping", "shipped": "shipping",
    "ship": "shipping", "delivery": "shipping", "deliveries": "shipping",
    "cancel": "cancellation", "cancelled": "cancellation", "canceled": "cancellation",
    "cancelling": "cancellation", "cancellations": "cancellation",
    "payments": "payment", "billing": "payment", "charge": "payment",
    "charged": "payment", "paid": "payment", "declined": "payment",
}


# ---------------------------------------------------------------------------
# Knowledge base access
# ---------------------------------------------------------------------------

def _read_knowledge_base() -> dict[str, Any]:
    """Load knowledge_base.json. Returns an empty structure if the file does not exist yet."""
    if not KNOWLEDGE_BASE_PATH.exists():
        return {"orders": [], "policies": [], "tickets": []}
    with KNOWLEDGE_BASE_PATH.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    for key in ("orders", "policies", "tickets"):
        data.setdefault(key, [])
    return data


def _write_knowledge_base(data: dict[str, Any]) -> None:
    """Write JSON atomically so a crash or concurrent read never sees a partial file."""
    KNOWLEDGE_BASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(
        dir=KNOWLEDGE_BASE_PATH.parent, prefix="kb_", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, KNOWLEDGE_BASE_PATH)
    except BaseException:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise


def _to_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _run_safely(action: Callable[..., dict[str, Any]], *args: Any) -> str:
    """Run a plain function and return JSON, never raising into the agent loop."""
    try:
        return _to_json(action(*args))
    except (OSError, json.JSONDecodeError):
        logger.exception("Knowledge base access failed")
        return _to_json({
            "status": "error",
            "message": (
                "The knowledge base is temporarily unavailable. Do not guess the answer. "
                "Tell the customer the support team will follow up."
            ),
        })


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> set[str]:
    tokens: set[str] = set()
    for word in re.findall(r"[a-z0-9]+", (text or "").lower()):
        if len(word) < 3 or word in _STOPWORDS:
            continue
        tokens.add(_SYNONYMS.get(word, word))
    return tokens


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " ".join(str(item) for item in value)
    return str(value)


def normalize_order_id(raw_id: str) -> str:
    """'#ord-1001' -> 'ORD1001'. A bare number such as '1001' becomes 'ORD1001'."""
    cleaned = re.sub(r"[^A-Za-z0-9]", "", str(raw_id or "")).upper()
    if cleaned.isdigit():
        cleaned = f"ORD{cleaned}"
    return cleaned


# ---------------------------------------------------------------------------
# 1. Order lookup
# ---------------------------------------------------------------------------

def find_order(order_id: str) -> dict[str, Any]:
    """Return the order details for an order ID, or a status explaining why none was found."""
    normalized = normalize_order_id(order_id)
    if not normalized:
        return {
            "status": "missing",
            "message": "No order ID was provided. Ask the customer for their order ID.",
        }
    if not re.fullmatch(r"ORD\d{3,}", normalized):
        return {
            "status": "invalid",
            "order_id": normalized,
            "message": "This does not look like a valid order ID. Order IDs look like ORD1001. Ask the customer to check it.",
        }

    for order in _read_knowledge_base()["orders"]:
        if str(order.get("order_id", "")).upper() == normalized:
            return {
                "status": "found",
                "order": {
                    "order_id": order.get("order_id"),
                    "customer_name": order.get("customer_name"),
                    "product_name": order.get("product_name"),
                    "order_status": order.get("order_status"),
                    "tracking_number": order.get("tracking_id") or "Not assigned yet",
                    "estimated_delivery": order.get("estimated_delivery") or "Not available",
                    "amount": order.get("amount"),
                },
            }

    return {
        "status": "not_found",
        "order_id": normalized,
        "message": "No order was found with this ID. Ask the customer to double-check it.",
    }


@tool("lookup_order")
def lookup_order(order_id: str) -> str:
    """Look up a customer order by its order ID, for example ORD1001. Returns the order status,
    product name, tracking number, estimated delivery date and amount. If the ID is missing,
    invalid or not found, returns a clear message. Use this tool for any question about an
    order's status, tracking or delivery."""
    return _run_safely(find_order, order_id)


# ---------------------------------------------------------------------------
# 2. Policy search
# ---------------------------------------------------------------------------

def search_policies(query: str, limit: int = MAX_POLICY_RESULTS) -> dict[str, Any]:
    """Score policies against a query using topic, title and body keyword overlap."""
    tokens = _tokenize(query)
    if not tokens:
        return {
            "status": "no_match",
            "query": query,
            "message": "The search query had no usable keywords. Ask the customer which topic they mean.",
            "available_topics": list(POLICY_TOPICS),
        }

    scored: list[tuple[int, dict[str, Any]]] = []
    for policy in _read_knowledge_base()["policies"]:
        topic = str(policy.get("topic", "")).lower()
        title_tokens = _tokenize(_as_text(policy.get("title")))
        body_tokens = _tokenize(" ".join(
            _as_text(policy.get(field))
            for field in ("title", "content", "eligibility", "conditions")
        ))
        score = 0
        if topic and topic in tokens:
            score += 5
        score += 3 * len(tokens & title_tokens)
        score += len(tokens & body_tokens)
        if score > 0:
            scored.append((score, policy))

    if not scored:
        return {
            "status": "no_match",
            "query": query,
            "message": (
                "No matching policy was found. Do not invent a policy. Tell the customer "
                "the team will confirm, and consider creating a support ticket."
            ),
            "available_topics": list(POLICY_TOPICS),
        }

    scored.sort(key=lambda item: item[0], reverse=True)
    fields = ("policy_id", "topic", "title", "content", "eligibility", "conditions")
    matches = [{field: policy.get(field) for field in fields} for _, policy in scored[:limit]]
    return {"status": "matched", "query": query, "matches": matches}


@tool("search_policy")
def search_policy(query: str) -> str:
    """Search company policies for refunds, returns, shipping, order cancellation or payment
    issues. Pass the customer's topic or question as the query, for example
    'refund for damaged item'. Returns matching policy text, eligibility and conditions, or a
    no-match message. Always call this tool before stating any policy."""
    return _run_safely(search_policies, query)


# ---------------------------------------------------------------------------
# 3. Support ticket creation
# ---------------------------------------------------------------------------

def _generate_ticket_id(existing_ids: set[str]) -> str:
    while True:
        candidate = f"TKT-{uuid.uuid4().hex[:8].upper()}"
        if candidate not in existing_ids:
            return candidate


def create_ticket_record(issue: str, customer_message: str) -> dict[str, Any]:
    """Create an open support ticket and save it to the knowledge base."""
    issue_text = (issue or "").strip()
    message_text = (customer_message or "").strip()
    if not issue_text or not message_text:
        return {
            "status": "invalid",
            "message": "Both an issue summary and the customer's message are required to create a ticket.",
        }

    with _DB_LOCK:
        data = _read_knowledge_base()
        existing_ids = {str(ticket.get("ticket_id")) for ticket in data["tickets"]}
        ticket = {
            "ticket_id": _generate_ticket_id(existing_ids),
            "issue": issue_text[:500],
            "customer_message": message_text[:2000],
            "status": "open",
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        data["tickets"].append(ticket)
        _write_knowledge_base(data)

    logger.info("Created support ticket %s", ticket["ticket_id"])
    return {"status": "created", "ticket_id": ticket["ticket_id"], "ticket": ticket}


@tool("create_support_ticket")
def create_support_ticket(issue: str, customer_message: str) -> str:
    """Create a support ticket for a problem that could not be resolved automatically, such as
    a damaged or missing item, a payment problem, a refund needing a human decision, or an order
    that cannot be found. Arguments: issue is a short summary of the problem, and
    customer_message is the customer's original message. Returns the ticket ID to share with
    the customer."""
    return _run_safely(create_ticket_record, issue, customer_message)