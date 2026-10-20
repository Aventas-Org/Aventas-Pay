"""Async checkout-session client for the Aventas bot.

Integration contract (Stage 1):
  * The bot is the trusted source of order facts. It reads the order from its
    own database and sends the *persisted* amount; nothing here accepts a price
    from a Discord interaction or a browser.
  * Ownership is enforced locally before any network call: the caller passes the
    discord user id that interacted, and a mismatch raises without a round trip.
  * All requests carry the dedicated server-to-server secret.
  * The idempotency key is derived deterministically from (order_id, operation),
    so repeated button clicks and network retries converge on one session.
  * Timeouts and bounded retries with exponential backoff + jitter are applied
    to network failures, timeouts, 429 and 5xx. 4xx are never retried.
  * Logging is structured and redaction-guarded: never the bot token, the
    integration secret, a checkout token, or a full request/response body.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import random
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping

import aiohttp

from .config import CheckoutConfig
from .errors import (
    CheckoutApiError,
    CheckoutAuthError,
    CheckoutDisabled,
    CheckoutNetworkError,
    CheckoutOwnershipError,
    CheckoutTimeout,
    InvalidSessionResponse,
)

logger = logging.getLogger("avantas.checkout")

_IDEMPOTENCY_OPERATION = "checkout-session"

# Anything that looks like a bearer capability gets masked in logs.
_TOKEN_LIKE = re.compile(r"[A-Za-z0-9_\-]{40,}")
_SECRET_KEYS = frozenset(
    {"authorization", "checkout_token", "token", "secret", "api_secret"}
)


def _redact(value: str) -> str:
    return _TOKEN_LIKE.sub("[REDACTED]", value)


def _safe_extra(extra: Mapping[str, Any]) -> dict[str, Any]:
    """Drops secret-named keys and masks token-like strings for logging."""
    out: dict[str, Any] = {}
    for key, val in extra.items():
        if key.lower() in _SECRET_KEYS:
            out[key] = "[REDACTED]"
        elif isinstance(val, str):
            out[key] = _redact(val)
        else:
            out[key] = val
    return out


def _log(event: str, **extra: Any) -> None:
    logger.info("checkout %s %s", event, _safe_extra(extra))


@dataclass(frozen=True)
class OrderFacts:
    """Persisted order data, read from the bot database by the caller.

    ``amount_paise`` MUST be the value stored against the order (after the
    existing rounding behaviour), never a price from an interaction payload.
    """

    order_id: str
    owner_discord_id: str
    product_id: str
    product_name: str
    amount_paise: int
    currency: str = "INR"


@dataclass(frozen=True)
class PaymentProfile:
    """The UPI recipient the existing get_payment_profile() selection produced."""

    profile_id: str
    vpa: str
    display_name: str


@dataclass(frozen=True)
class CheckoutSessionResult:
    session_id: str
    order_id: str
    checkout_url: str
    checkout_token: str
    status: str
    expires_at: str
    reused: bool


class CheckoutClient:
    """Small, isolated client. Create one per bot process."""

    def __init__(
        self,
        config: CheckoutConfig,
        session: aiohttp.ClientSession | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if not config.enabled:
            raise CheckoutDisabled("checkout is disabled by configuration")
        self._config = config
        self._session = session
        self._owns_session = session is None
        self._sleep = sleep

    async def __aenter__(self) -> "CheckoutClient":
        if self._session is None:
            timeout = aiohttp.ClientTimeout(
                total=self._config.total_timeout_seconds,
                connect=self._config.connect_timeout_seconds,
            )
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._owns_session and self._session is not None:
            await self._session.close()
            self._session = None

    # ------------------------------------------------------------------ API

    @staticmethod
    def idempotency_key(order_id: str, operation: str = _IDEMPOTENCY_OPERATION) -> str:
        """Deterministic key: duplicate clicks and retries map to one session."""
        return f"{order_id}:{operation}"

    def build_checkout_page_url(self, checkout_token: str) -> str:
        return f"{self._config.base_url}/checkout/{checkout_token}"

    async def create_checkout_session(
        self,
        order: OrderFacts,
        profile: PaymentProfile,
        *,
        actor_discord_id: str,
    ) -> CheckoutSessionResult:
        """Creates (or re-fetches) the website checkout session for an order.

        Raises CheckoutOwnershipError before any network call when the actor is
        not the order owner. Callers should catch CheckoutError broadly and fall
        back to the existing manual UPI flow.
        """
        self._require_enabled()
        if order.owner_discord_id != actor_discord_id:
            # Deliberately raised before any HTTP call and without retry.
            _log(
                "ownership_mismatch",
                order_id=order.order_id,
            )
            raise CheckoutOwnershipError("actor does not own this order")
        if order.amount_paise <= 0:
            raise InvalidSessionResponse("order amount must be positive")

        payload = {
            "order_id": order.order_id,
            "discord_user_id": order.owner_discord_id,
            "product_id": order.product_id,
            "product_name": order.product_name,
            "amount_paise": order.amount_paise,
            "currency": order.currency,
            "payment_profile_id": profile.profile_id,
            "upi": {"vpa": profile.vpa, "display_name": profile.display_name},
            "idempotency_key": self.idempotency_key(order.order_id),
            "ttl_seconds": self._config.ttl_seconds,
        }

        started = time.monotonic()
        status, body = await self._request_json(
            "POST",
            "/api/payments/checkout-sessions",
            json_body=payload,
            context={"order_id": order.order_id},
        )
        if status not in (200, 201):
            self._raise_for_status(status, body)
        result = self._parse_session_response(body, order)
        _log(
            "session_ready",
            order_id=order.order_id,
            http_status=status,
            reused=result.reused,
            elapsed_ms=int((time.monotonic() - started) * 1000),
            status=result.status,
        )
        return result

    async def get_session_status(self, checkout_token: str) -> dict[str, Any]:
        """Public status lookup; the bot is not required to use it in Stage 1."""
        self._require_enabled()
        status, body = await self._request_json(
            "GET",
            f"/api/payments/checkout-sessions/{checkout_token}",
            context={"op": "status"},
        )
        if status != 200:
            self._raise_for_status(status, body)
        if not isinstance(body, dict):
            raise InvalidSessionResponse("status response is not an object")
        return body

    async def cancel_session(self, order_id: str) -> dict[str, Any]:
        """Authorized, idempotent cancellation for the existing staff flows."""
        self._require_enabled()
        status, body = await self._request_json(
            "POST",
            "/api/payments/checkout-sessions/cancel",
            json_body={"order_id": order_id},
            context={"order_id": order_id},
        )
        if status != 200:
            self._raise_for_status(status, body)
        if not isinstance(body, dict):
            raise InvalidSessionResponse("cancel response is not an object")
        return body

    # ------------------------------------------------------------ internals

    def _require_enabled(self) -> None:
        if not self._config.enabled:
            raise CheckoutDisabled("checkout is disabled by configuration")

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._config.api_secret}",
            "Content-Type": "application/json",
            "User-Agent": "avantas-bot-checkout/1.0",
            # The capability URL must never leak via a referrer.
            "Referrer-Policy": "no-referrer",
        }

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        context: Mapping[str, Any] | None = None,
    ) -> tuple[int, Any]:
        """Performs the HTTP call with bounded retries. Returns (status, body)."""
        if self._session is None:
            # Allow use without the async context manager.
            timeout = aiohttp.ClientTimeout(
                total=self._config.total_timeout_seconds,
                connect=self._config.connect_timeout_seconds,
            )
            self._session = aiohttp.ClientSession(timeout=timeout)
            self._owns_session = True

        attempts = self._config.max_retries + 1
        ctx = dict(context or {})
        last_error: str = "unknown"

        for attempt in range(attempts):
            try:
                async with self._session.request(
                    method,
                    f"{self._config.api_url}{path}",
                    json=json_body,
                    headers=self._headers(),
                ) as resp:
                    body: Any
                    try:
                        body = await resp.json(content_type=None)
                    except Exception:  # noqa: BLE001 - body is never logged
                        body = None
                    if resp.status < 500 and resp.status != 429:
                        _log(
                            "http_response",
                            method=method,
                            path=path,
                            http_status=resp.status,
                            attempt=attempt + 1,
                            **ctx,
                        )
                        return resp.status, body
                    last_error = f"http_{resp.status}"
                    retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
            except asyncio.TimeoutError:
                last_error = "timeout"
                retry_after = None
            except aiohttp.ClientError as exc:
                last_error = f"network:{type(exc).__name__}"
                retry_after = None

            if attempt + 1 >= attempts:
                break
            delay = self._backoff_delay(attempt, retry_after)
            _log(
                "retrying",
                method=method,
                path=path,
                attempt=attempt + 1,
                delay_ms=int(delay * 1000),
                reason=last_error,
                **ctx,
            )
            await self._sleep(delay)

        _log(
            "request_failed",
            method=method,
            path=path,
            attempts=attempts,
            reason=last_error,
            **ctx,
        )
        if last_error == "timeout":
            raise CheckoutTimeout(f"checkout request timed out after {attempts} attempts")
        if last_error.startswith("network:"):
            raise CheckoutNetworkError(
                f"checkout service unreachable after {attempts} attempts"
            )
        status = int(last_error.split("_", 1)[1]) if last_error.startswith("http_") else 0
        raise CheckoutApiError(status)

    def _backoff_delay(self, attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            # Honour server hints but never sleep longer than our own cap.
            return min(retry_after, self._config.backoff_max_seconds)
        base = min(
            self._config.backoff_base_seconds * (2**attempt),
            self._config.backoff_max_seconds,
        )
        return base * (0.5 + random.random())  # jitter in [0.5x, 1.5x)

    @staticmethod
    def _raise_for_status(status: int, body: Any) -> None:
        code: str | None = None
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict) and isinstance(error.get("code"), str):
                code = error["code"]
        if status in (401, 403):
            raise CheckoutAuthError(f"rejected by website (status {status})")
        raise CheckoutApiError(status, code)

    @staticmethod
    def _parse_session_response(body: Any, order: OrderFacts) -> CheckoutSessionResult:
        if not isinstance(body, dict):
            raise InvalidSessionResponse("create response is not an object")
        required = {
            "checkout_url": str,
            "checkout_token": str,
            "order_ref": str,
            "session_status": str,
            "expires_at": str,
        }
        for field, kind in required.items():
            if not isinstance(body.get(field), kind):
                raise InvalidSessionResponse(f"missing or invalid field {field!r}")
        if body["order_ref"] != order.order_id:
            raise InvalidSessionResponse("response order_ref does not match request")
        token = body["checkout_token"]
        if len(token) < 32:
            raise InvalidSessionResponse("checkout token too short")
        return CheckoutSessionResult(
            session_id=str(body.get("session_id", "")),
            order_id=body["order_ref"],
            checkout_url=body["checkout_url"],
            checkout_token=token,
            status=body["session_status"],
            expires_at=body["expires_at"],
            reused=bool(body.get("reused", False)),
        )


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    return seconds if seconds >= 0 else None


def derive_order_fingerprint(order: OrderFacts) -> str:
    """Stable non-reversible fingerprint for correlating logs with an order.

    Useful in operational alerts where the raw discord id should not appear.
    """
    material = f"{order.order_id}|{order.owner_discord_id}|{order.amount_paise}"
    return hashlib.sha256(material.encode()).hexdigest()[:16]
