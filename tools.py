"""
tools.py
Reusable CrewAI tools for the AI Customer Support Agent & Shopping Assistant (Aria).

Each capability has two layers:
    * a plain Python function (find_order, search_policies, create_ticket_record,
      find_product, place_order_record, cancel_order_record, update_address_record)
      that is easy to test and reuse outside CrewAI, and
    * a CrewAI tool (lookup_order, search_policy, create_support_ticket,
      check_inventory, place_order, cancel_order, update_delivery_address) that wraps
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
    """Load knowledge_base.json. Returns default structure if file does not exist yet."""
    if not KNOWLEDGE_BASE_PATH.exists():
        return {"products": [], "orders": [], "policies": [], "tickets": []}
    with KNOWLEDGE_BASE_PATH.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    for key in ("products", "orders", "policies", "tickets"):
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
# 1. Product catalog & Inventory
# ---------------------------------------------------------------------------

def get_all_products() -> list[dict[str, Any]]:
    """Return all products in the store."""
    return _read_knowledge_base().get("products", [])


def find_product(query: str) -> dict[str, Any]:
    """Look up product inventory, price, rating, and stock count by name/keyword."""
    cleaned = (query or "").strip().lower()
    if not cleaned:
        return {
            "status": "missing_query",
            "message": "Please specify a product name to check inventory.",
        }

    products = get_all_products()
    q_tokens = _tokenize(cleaned)
    matches: list[tuple[int, dict[str, Any]]] = []

    for prod in products:
        p_name = prod.get("name", "").lower()
        search_blob = f"{p_name} {prod.get('category', '')} {prod.get('description', '')}".lower()
        p_tokens = _tokenize(search_blob)

        score = 0
        if cleaned in p_name:
            score += 15
        for word in cleaned.split():
            if len(word) > 2 and word in p_name:
                score += 5
        score += len(q_tokens & p_tokens)

        if score > 0:
            matches.append((score, prod))

    if matches:
        matches.sort(key=lambda item: item[0], reverse=True)
        best = matches[0][1]
        stock = best.get("stock", 0)
        return {
            "status": "found",
            "product_id": best.get("product_id"),
            "product_name": best.get("name"),
            "category": best.get("category"),
            "price": best.get("price"),
            "stock_count": stock,
            "in_stock": stock > 0,
            "rating": best.get("rating"),
            "description": best.get("description"),
            "message": (
                f"'{best.get('name')}' is in stock ({stock} units available) at ${best.get('price', 0.0):.2f}."
                if stock > 0
                else f"'{best.get('name')}' is currently out of stock."
            ),
        }

    available_names = [p.get("name") for p in products]
    return {
        "status": "not_found",
        "query": query,
        "message": f"No product matching '{query}' was found in the catalog. Available products: {', '.join(available_names)}.",
    }


@tool("check_inventory")
def check_inventory(product_name: str) -> str:
    """Check inventory, stock count, and price for a product. Pass the product name or keywords,
    for example 'Smart Fitness Watch' or 'water bottle'. Returns stock availability, price, and details."""
    return _run_safely(find_product, product_name)


# ---------------------------------------------------------------------------
# 2. Placing an order
# ---------------------------------------------------------------------------

def place_order_record(
    product_name: str,
    quantity: int = 1,
    delivery_address: str = "12 Lake Road, Chennai",
    customer_name: str = "Valued Customer",
) -> dict[str, Any]:
    """Place a new order for a product, decrement stock, and return confirmed order details."""
    try:
        qty = max(1, int(quantity))
    except (ValueError, TypeError):
        qty = 1

    addr = (delivery_address or "12 Lake Road, Chennai").strip()
    c_name = (customer_name or "Valued Customer").strip()

    with _DB_LOCK:
        data = _read_knowledge_base()
        products = data.get("products", [])
        product = None

        # Exact / substring match
        target_name_lower = product_name.lower().strip()
        for p in products:
            p_lower = p.get("name", "").lower()
            if target_name_lower in p_lower or p_lower in target_name_lower:
                product = p
                break

        # Token match fallback
        if not product:
            q_tokens = _tokenize(product_name)
            for p in products:
                if q_tokens & _tokenize(p.get("name", "")):
                    product = p
                    break

        if not product:
            return {
                "status": "error",
                "message": f"Could not find product matching '{product_name}'. Please verify the product name.",
            }

        available_stock = product.get("stock", 0)
        if available_stock < qty:
            return {
                "status": "out_of_stock",
                "product_name": product.get("name"),
                "available_stock": available_stock,
                "requested_quantity": qty,
                "message": f"Insufficient stock for '{product.get('name')}'. Only {available_stock} units available.",
            }

        # Deduct stock
        product["stock"] = available_stock - qty

        # Generate new sequential order ID
        existing_orders = data.get("orders", [])
        max_num = 1000
        for ord_item in existing_orders:
            m = re.search(r"ORD(\d+)", str(ord_item.get("order_id", "")))
            if m:
                max_num = max(max_num, int(m.group(1)))
        new_order_id = f"ORD{max_num + 1}"

        unit_price = float(product.get("price", 0.0))
        total_amount = round(unit_price * qty, 2)
        tracking_id = f"TRK-{uuid.uuid4().hex[:8].upper()}"
        est_delivery = "2026-11-25"

        new_order = {
            "order_id": new_order_id,
            "customer_name": c_name,
            "product_name": product.get("name"),
            "quantity": qty,
            "delivery_address": addr,
            "order_status": "Processing",
            "tracking_id": tracking_id,
            "estimated_delivery": est_delivery,
            "amount": total_amount,
        }
        existing_orders.append(new_order)
        _write_knowledge_base(data)

    logger.info("Placed order %s for %s x%d", new_order_id, product.get("name"), qty)
    return {
        "status": "confirmed",
        "order_id": new_order_id,
        "customer_name": c_name,
        "product_name": product.get("name"),
        "quantity": qty,
        "amount": total_amount,
        "delivery_address": addr,
        "order_status": "Processing",
        "tracking_number": tracking_id,
        "estimated_delivery": est_delivery,
        "message": (
            f"Order **{new_order_id}** placed successfully! "
            f"**{qty}x {product.get('name')}** (Total: **${total_amount:.2f}**) "
            f"delivering to **{addr}** by **{est_delivery}**."
        ),
    }


@tool("place_order")
def place_order(
    product_name: str,
    quantity: int = 1,
    delivery_address: str = "12 Lake Road, Chennai",
    customer_name: str = "Valued Customer",
) -> str:
    """Place an order for a customer. Arguments: product_name (e.g. 'Stainless Steel Water Bottle'),
    quantity (e.g. 2), delivery_address (e.g. '12 Lake Road, Chennai'), and customer_name.
    Creates the order record, updates inventory stock, and returns order confirmation with the new Order ID."""
    return _run_safely(place_order_record, product_name, quantity, delivery_address, customer_name)


# ---------------------------------------------------------------------------
# 3. Order lookup
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
                    "quantity": order.get("quantity", 1),
                    "delivery_address": order.get("delivery_address", "Not on file"),
                    "order_status": order.get("order_status"),
                    "tracking_number": order.get("tracking_id") or "Not assigned yet",
                    "estimated_delivery": order.get("estimated_delivery") or "Not available",
                    "amount": order.get("amount"),
                },
            }

    return {
        "status": "not_found",
        "order_id": normalized,
        "message": f"No order was found with ID '{normalized}'. Ask the customer to double-check it.",
    }


@tool("lookup_order")
def lookup_order(order_id: str) -> str:
    """Look up a customer order by its order ID, for example ORD1001. Returns the order status,
    product name, quantity, delivery address, tracking number, estimated delivery date and amount.
    If the ID is missing, invalid or not found, returns a clear message."""
    return _run_safely(find_order, order_id)


# ---------------------------------------------------------------------------
# 4. Cancel order
# ---------------------------------------------------------------------------

def cancel_order_record(order_id: str) -> dict[str, Any]:
    """Cancel an order if it is in 'Processing' status, per the cancellation policy."""
    normalized = normalize_order_id(order_id)
    if not normalized:
        return {"status": "missing_id", "message": "Please provide an order ID to cancel."}

    with _DB_LOCK:
        data = _read_knowledge_base()
        target = None
        for order in data.get("orders", []):
            if str(order.get("order_id", "")).upper() == normalized:
                target = order
                break

        if not target:
            return {"status": "not_found", "order_id": normalized, "message": f"Order {normalized} not found."}

        current_status = target.get("order_status", "")
        if current_status == "Cancelled":
            return {
                "status": "already_cancelled",
                "order_id": normalized,
                "message": f"Order {normalized} is already cancelled.",
            }

        if current_status != "Processing":
            return {
                "status": "ineligible",
                "order_id": normalized,
                "current_status": current_status,
                "message": (
                    f"Order **{normalized}** cannot be cancelled because its status is **{current_status}**. "
                    "Per company cancellation policy, orders that have already shipped or are out for delivery "
                    "cannot be cancelled. Once delivered, you can return it within 30 days for a full refund."
                ),
            }

        target["order_status"] = "Cancelled"
        refund_amount = target.get("amount", 0.0)

        # Restock product if found
        p_name = target.get("product_name", "")
        qty = target.get("quantity", 1)
        for prod in data.get("products", []):
            if prod.get("name") == p_name:
                prod["stock"] = prod.get("stock", 0) + qty
                break

        _write_knowledge_base(data)

    logger.info("Cancelled order %s", normalized)
    return {
        "status": "cancelled",
        "order_id": normalized,
        "refund_amount": refund_amount,
        "message": (
            f"Order **{normalized}** has been successfully cancelled. A full refund of **${refund_amount:.2f}** "
            "will be credited to your original payment method within 5 to 7 business days."
        ),
    }


@tool("cancel_order")
def cancel_order(order_id: str) -> str:
    """Cancel an order by its order ID (for example ORD1003). Orders can only be cancelled while
    in 'Processing' status. Returns confirmation and refund information, or explains why the
    order cannot be cancelled."""
    return _run_safely(cancel_order_record, order_id)


# ---------------------------------------------------------------------------
# 5. Update delivery address
# ---------------------------------------------------------------------------

def update_address_record(order_id: str, new_address: str) -> dict[str, Any]:
    """Change the delivery address if the order has not been handed over to the carrier."""
    normalized = normalize_order_id(order_id)
    addr = (new_address or "").strip()
    if not normalized or not addr:
        return {
            "status": "invalid_request",
            "message": "Both the order ID and the new delivery address are required.",
        }

    with _DB_LOCK:
        data = _read_knowledge_base()
        target = None
        for order in data.get("orders", []):
            if str(order.get("order_id", "")).upper() == normalized:
                target = order
                break

        if not target:
            return {"status": "not_found", "order_id": normalized, "message": f"Order {normalized} not found."}

        current_status = target.get("order_status", "")
        if current_status != "Processing":
            return {
                "status": "ineligible",
                "order_id": normalized,
                "current_status": current_status,
                "message": (
                    f"The delivery address for order **{normalized}** cannot be changed because its status is "
                    f"**{current_status}**. Per company policy, addresses can only be updated before the order is "
                    "handed to the carrier."
                ),
            }

        target["delivery_address"] = addr
        _write_knowledge_base(data)

    logger.info("Updated address for order %s to %s", normalized, addr)
    return {
        "status": "updated",
        "order_id": normalized,
        "new_address": addr,
        "message": f"The delivery address for order **{normalized}** has been successfully updated to **{addr}**.",
    }


@tool("update_delivery_address")
def update_delivery_address(order_id: str, new_address: str) -> str:
    """Update the delivery address for an order. Arguments: order_id (e.g. 'ORD1003') and
    new_address (e.g. '15 Park Street, Kolkata'). Can only be updated if the order is still
    in 'Processing' status."""
    return _run_safely(update_address_record, order_id, new_address)


# ---------------------------------------------------------------------------
# 6. Policy search
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
# 7. Support ticket creation
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
