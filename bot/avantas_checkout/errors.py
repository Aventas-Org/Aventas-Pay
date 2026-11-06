"""Typed errors for the checkout client.

Every error is safe to catch at the Discord interaction layer: none of them
carry secrets, tokens or full response bodies, so formatting one into a log
line or an operator alert cannot leak sensitive material.
"""

from __future__ import annotations


class CheckoutError(Exception):
    """Base class for all checkout client failures."""


class CheckoutDisabled(CheckoutError):
    """Feature flag off; the caller must fall back to the manual UPI flow."""


class CheckoutAuthError(CheckoutError):
    """The website rejected the integration secret (401/403)."""


class CheckoutNetworkError(CheckoutError):
    """Connection failure (DNS, refused, reset) after bounded retries."""


class CheckoutTimeout(CheckoutError):
    """Request exceeded the configured timeout after bounded retries."""


class CheckoutOwnershipError(CheckoutError):
    """The interaction actor does not own the order; raised before any HTTP call."""


class CheckoutApiError(CheckoutError):
    """Non-auth HTTP failure (4xx/5xx) after bounded retries."""

    def __init__(self, status: int, code: str | None = None) -> None:
        super().__init__(f"checkout api error status={status} code={code or 'unknown'}")
        self.status = status
        self.code = code


class InvalidSessionResponse(CheckoutError):
    """The website returned a payload that does not match the Stage 1 contract."""
