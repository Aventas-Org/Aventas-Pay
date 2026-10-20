"""Aventas Stage 1 bot-side checkout client.

This package is designed to be dropped into Aventas-Org/Aventas-bot as
``services/checkout_service.py`` (single module) once repository access is
available. It depends only on aiohttp plus the standard library and talks to
the website's checkout-session API over the dedicated integration secret.

Nothing in this package logs the bot token, the integration secret or a
checkout token, and no exception path formats a full request body.
"""

from .config import CheckoutConfig
from .errors import (
    CheckoutApiError,
    CheckoutAuthError,
    CheckoutDisabled,
    CheckoutError,
    CheckoutNetworkError,
    CheckoutOwnershipError,
    CheckoutTimeout,
    InvalidSessionResponse,
)
from .client import CheckoutClient, CheckoutSessionResult, OrderFacts, PaymentProfile

__all__ = [
    "CheckoutClient",
    "CheckoutConfig",
    "CheckoutSessionResult",
    "OrderFacts",
    "PaymentProfile",
    "CheckoutApiError",
    "CheckoutAuthError",
    "CheckoutDisabled",
    "CheckoutError",
    "CheckoutNetworkError",
    "CheckoutOwnershipError",
    "CheckoutTimeout",
    "InvalidSessionResponse",
]
