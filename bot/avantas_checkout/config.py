"""Environment configuration for the bot-side checkout client.

Naming follows the Stage 1 brief. The secret is read once at construction and
is never included in ``repr``/``str`` so accidental logging of the config
object cannot leak it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from .errors import CheckoutDisabled

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off", ""}

# The Aventas-bot repository's established .env convention is unprefixed names
# (REVIEWS_CHANNEL_ID, PAYMENT_EMAIL_USER, ...). Stage 1 introduced the
# AVENTAS_-prefixed names from the integration brief; both are accepted so the
# client drops into the real bot's .env without renaming anything. The
# AVENTAS_-prefixed name always wins when both are present.
_ENV_ALIASES: dict[str, str] = {
    "AVENTAS_CHECKOUT_ENABLED": "CHECKOUT_ENABLED",
    "AVENTAS_WEBSITE_BASE_URL": "WEBSITE_BASE_URL",
    "AVENTAS_PAYMENT_API_URL": "PAYMENT_API_URL",
    "AVENTAS_PAYMENT_API_SECRET": "PAYMENT_API_SECRET",
    "AVENTAS_CHECKOUT_CONNECT_TIMEOUT": "CHECKOUT_CONNECT_TIMEOUT",
    "AVENTAS_CHECKOUT_TOTAL_TIMEOUT": "CHECKOUT_TOTAL_TIMEOUT",
    "AVENTAS_CHECKOUT_MAX_RETRIES": "CHECKOUT_MAX_RETRIES",
    "AVENTAS_CHECKOUT_TTL_SECONDS": "CHECKOUT_TTL_SECONDS",
}


# An explicitly blank authoritative value must NEVER reactivate a legacy
# checkout flag/secret/origin. Optional numeric knobs keep their old
# empty-as-unspecified fallback to avoid changing operational defaults.
_SECURITY_OVERRIDES = frozenset({
    "AVENTAS_CHECKOUT_ENABLED",
    "AVENTAS_WEBSITE_BASE_URL",
    "AVENTAS_PAYMENT_API_URL",
    "AVENTAS_PAYMENT_API_SECRET",
})


def _lookup(
    source: "dict[str, str] | os._Environ[str]", name: str, default: str = ""
) -> str:
    """Read the prefixed value first, failing closed on explicit blank payment settings."""
    if name in _SECURITY_OVERRIDES and name in source:
        value = source[name]
        return "" if value is None else str(value)
    value = source.get(name)
    if value is not None and str(value).strip() != "":
        return str(value)
    alias = _ENV_ALIASES.get(name)
    if alias:
        fallback = source.get(alias)
        if fallback is not None and str(fallback).strip() != "":
            return str(fallback)
    return default


def _checkout_origin(value: str) -> str:
    """HTTPS origin only; plain HTTP is reserved for loopback integration tests."""
    try:
        p = urlsplit(value)
        local_http = p.scheme == "http" and p.hostname in {"127.0.0.1", "localhost", "::1"}
        if (any(c.isspace() for c in value) or any(c in value for c in "\\?#") or
                p.username is not None or p.password is not None or
                p.path not in {"", "/"} or not p.hostname or
                (p.scheme != "https" and not local_http) or p.port == 0):
            raise ValueError("invalid origin")
        return value.rstrip("/")
    except ValueError:
        raise CheckoutDisabled("checkout URL must be an HTTPS origin without credentials, path, query or fragment") from None


@dataclass(frozen=True)
class CheckoutConfig:
    """Validated configuration for talking to the Aventas website."""

    enabled: bool
    base_url: str
    api_url: str
    _api_secret: str = field(repr=False, default="")
    connect_timeout_seconds: float = 5.0
    total_timeout_seconds: float = 10.0
    max_retries: int = 2
    backoff_base_seconds: float = 0.5
    backoff_max_seconds: float = 8.0
    ttl_seconds: int = 1800

    def __post_init__(self) -> None:
        if not self.enabled:
            return
        problems: list[str] = []
        if not self.base_url:
            problems.append("AVENTAS_WEBSITE_BASE_URL")
        if not self.api_url:
            problems.append("AVENTAS_PAYMENT_API_URL")
        if len(self._api_secret) < 16:
            problems.append("AVENTAS_PAYMENT_API_SECRET (min 16 chars)")
        if problems:
            raise CheckoutDisabled(
                "checkout enabled but configuration incomplete: " + ", ".join(problems)
            )

        object.__setattr__(self, "base_url", _checkout_origin(self.base_url))
        object.__setattr__(self, "api_url", _checkout_origin(self.api_url))

    @property
    def api_secret(self) -> str:
        return self._api_secret

    @classmethod
    def from_env(cls, env: dict[str, str] | os._Environ[str] | None = None) -> "CheckoutConfig":
        source = env if env is not None else os.environ
        raw_enabled = _lookup(source, "AVENTAS_CHECKOUT_ENABLED").strip().lower()
        if raw_enabled in _FALSE:
            enabled = False
        elif raw_enabled in _TRUE:
            enabled = True
        else:
            # Environment values are untrusted and can contain copied secrets;
            # never include them in exception text or operator alerts.
            raise CheckoutDisabled("checkout enable flag has unrecognized value")
        base_url = _lookup(source, "AVENTAS_WEBSITE_BASE_URL").strip().rstrip("/")
        api_url = _lookup(source, "AVENTAS_PAYMENT_API_URL").strip()
        return cls(
            enabled=enabled,
            base_url=base_url,
            api_url=api_url,
            _api_secret=_lookup(source, "AVENTAS_PAYMENT_API_SECRET"),
            connect_timeout_seconds=float(_lookup(source, "AVENTAS_CHECKOUT_CONNECT_TIMEOUT", "5")),
            total_timeout_seconds=float(_lookup(source, "AVENTAS_CHECKOUT_TOTAL_TIMEOUT", "10")),
            max_retries=int(_lookup(source, "AVENTAS_CHECKOUT_MAX_RETRIES", "2")),
            ttl_seconds=int(_lookup(source, "AVENTAS_CHECKOUT_TTL_SECONDS", "1800")),
        )
