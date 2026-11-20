"""
crew.py
Sequential three-agent CrewAI workflow for the AI Customer Support Agent.

    Order Support Agent  ->  Policy Specialist Agent  ->  Customer Resolution Agent

Public API:
    run_support_crew(customer_message: str) -> str
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

from crewai import LLM, Agent, Crew, Process, Task
from dotenv import load_dotenv

from tools import create_support_ticket, lookup_order, search_policy

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "groq/openai/gpt-oss-120b"
MAX_MESSAGE_LENGTH = 2000
VERBOSE = os.getenv("DEBUG", "false").strip().lower() in {"1", "true", "yes", "on"}

FALLBACK_RESPONSE = (
    "Thank you for reaching out. We are reviewing your request, and a member of our "
    "support team will follow up with you shortly."
)


class SupportCrewError(RuntimeError):
    """Raised when the support crew cannot produce a customer response."""


@lru_cache(maxsize=1)
def get_llm() -> LLM:
    """Create the Groq-backed LLM once, using GROQ_API_KEY and MODEL_NAME from .env."""
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key or api_key.startswith("your_"):
        raise SupportCrewError("GROQ_API_KEY is not set. Add your Groq key to the .env file.")
    model = os.getenv("MODEL_NAME", "").strip() or DEFAULT_MODEL
    return LLM(model=model, api_key=api_key, temperature=0.2)


def _build_agents(llm: LLM) -> tuple[Agent, Agent, Agent]:
    order_agent = Agent(
        role="Order Support Specialist",
        goal=(
            "Find accurate order facts (status, product, tracking number and delivery estimate) "
            "and clearly identify any missing or invalid order information, without guessing."
        ),
        backstory=(
            "You are a meticulous order operations specialist. You report only facts returned "
            "by the lookup_order tool. If the customer has not provided an order ID, or the ID "
            "is invalid or not found, you say so plainly instead of inventing details."
        ),
        tools=[lookup_order],
        llm=llm,
        allow_delegation=False,
        verbose=VERBOSE,
        max_iter=4,
    )

    policy_agent = Agent(
        role="Policy Specialist",
        goal=(
            "Explain the refund, return, shipping, cancellation and payment policies that apply "
            "to the customer's situation, using only the company knowledge base."
        ),
        backstory=(
            "You are an expert on the company's customer policies. You search the knowledge base "
            "with the search_policy tool before stating any rule, and you quote eligibility and "
            "conditions exactly as they appear. You never invent policies, fees or time frames."
        ),
        tools=[search_policy],
        llm=llm,
        allow_delegation=False,
        verbose=VERBOSE,
        max_iter=4,
    )

    resolution_agent = Agent(
        role="Customer Resolution Specialist",
        goal=(
            "Combine the order and policy findings into a professional, empathetic reply. Open a "
            "support ticket when the problem cannot be resolved automatically and share the ticket ID."
        ),
        backstory=(
            "You are a senior customer experience lead known for clear, warm and honest replies. "
            "You rely only on verified findings from your colleagues. You create a support ticket "
            "only when a problem is unresolved, and you never make up ticket IDs."
        ),
        tools=[create_support_ticket],
        llm=llm,
        allow_delegation=False,
        verbose=VERBOSE,
        max_iter=4,
    )

    return order_agent, policy_agent, resolution_agent


def _build_tasks(
    order_agent: Agent, policy_agent: Agent, resolution_agent: Agent
) -> list[Task]:
    order_task = Task(
        description=(
            'Customer message: "{customer_message}"\n\n'
            "1. Identify any order ID in the message. Accept formats such as ORD1001, #ORD1001 or 1001.\n"
            "2. If an order ID is present, call the lookup_order tool with it.\n"
            "3. Report the order facts returned by the tool: order ID, product, status, tracking "
            "number, estimated delivery and amount.\n"
            "4. If there is no order ID, or the order is invalid or not found, state exactly which "
            "information is missing.\n"
            "Never invent or assume order details."
        ),
        expected_output=(
            "A short factual summary containing either the verified order details or a clear "
            "statement of the missing or invalid order information. Internal notes only, no "
            "customer-facing wording."
        ),
        agent=order_agent,
    )

    policy_task = Task(
        description=(
            'Customer message: "{customer_message}"\n\n'
            "Using the order findings from the previous step and the search_policy tool, identify "
            "which policies apply to the customer's situation: refunds, returns, shipping, order "
            "cancellation or payment issues. Call search_policy with a short query for each topic "
            "the customer raises. Quote eligibility and conditions exactly as the tool returns them. "
            "If no policy matches, say so. Never invent policies, fees or time frames."
        ),
        expected_output=(
            "A list of applicable policies, each with its eligibility and conditions taken from "
            "search_policy results, plus a note about any topic that no policy covers."
        ),
        agent=policy_agent,
        context=[order_task],
    )

    resolution_task = Task(
        description=(
            'Customer message: "{customer_message}"\n\n'
            "Using the order findings and policy findings from the previous steps:\n"
            "1. Decide whether the customer's problem can be resolved with the information available.\n"
            "2. If it cannot be resolved automatically (for example a damaged or missing item, a "
            "payment problem, a refund that needs a human decision, or an order that cannot be found), "
            "call the create_support_ticket tool once. Use a short issue summary and the customer's "
            "original message.\n"
            "3. Write the final reply to the customer. It must be warm, professional and concise. "
            "Include the verified order facts, explain the relevant policy in plain language, and "
            "if a ticket was created, include its ticket ID and say the team will follow up. If "
            "information is missing, politely ask for it.\n"
            "Never invent order details, policies, dates or ticket IDs."
        ),
        expected_output=(
            "The final customer-facing reply only. Plain text, with no JSON, no internal notes and "
            "no mention of agents or tools. Include the ticket reference if a ticket was created."
        ),
        agent=resolution_agent,
        context=[order_task, policy_task],
    )

    return [order_task, policy_task, resolution_task]


def run_support_crew(customer_message: str) -> str:
    """Run the three-agent sequential crew and return the final customer-facing response.

    Raises:
        ValueError: if the message is empty or too long.
        SupportCrewError: if the crew cannot be configured or fails while running.
    """
    cleaned = (customer_message or "").strip()
    if not cleaned:
        raise ValueError("Customer message cannot be empty.")
    if len(cleaned) > MAX_MESSAGE_LENGTH:
        raise ValueError(f"Customer message cannot exceed {MAX_MESSAGE_LENGTH} characters.")

    try:
        llm = get_llm()
        agents = _build_agents(llm)
        tasks = _build_tasks(*agents)
        crew = Crew(
            agents=list(agents),
            tasks=tasks,
            process=Process.sequential,
            verbose=VERBOSE,
        )
        result = crew.kickoff(inputs={"customer_message": cleaned})
    except SupportCrewError:
        raise
    except Exception as exc:
        logger.exception("CrewAI workflow failed")
        raise SupportCrewError("The support crew could not process this request.") from exc

    answer = str(getattr(result, "raw", result) or "").strip()
    if not answer:
        logger.warning("Support crew returned an empty response. Using fallback text.")
        return FALLBACK_RESPONSE
    return answer


if __name__ == "__main__":
    # Quick manual test: python crew.py
    print(run_support_crew("Where is my order ORD1001?"))