"""Checkout client tests.

These run against a real local aiohttp server, so timeouts, connection
handling, retry counts and idempotency-key propagation are exercised for real
rather than mocked away.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import replace

import pytest
from aiohttp import web

from avantas_checkout import (
    CheckoutApiError,
    CheckoutAuthError,
    CheckoutClient,
    CheckoutConfig,
    CheckoutNetworkError,
    CheckoutOwnershipError,
    CheckoutTimeout,
    InvalidSessionResponse,
    OrderFacts,
    PaymentProfile,
)

SECRET = "integration-secret-value-1234"
TOKEN = "tok_" + "a" * 43

ORDER = OrderFacts(
    order_id="AVT-2026-000123",
    owner_discord_id="123456789012345678",
    product_id="vp-1000",
    product_name="1000 Valorant Points",
    amount_paise=99900,
)
PROFILE = PaymentProfile(profile_id="primary", vpa="merchant@upi", display_name="Aventas Store")


def make_config(api_url: str, **overrides) -> CheckoutConfig:
    values = dict(
        enabled=True,
        base_url="https://avantas.example",
        api_url=api_url,
        _api_secret=SECRET,
        max_retries=2,
        backoff_base_seconds=0.01,
        backoff_max_seconds=0.05,
    )
    values.update(overrides)
    return CheckoutConfig(**values)


class RecordingServer:
    """Local aiohttp server whose behaviour is driven by a mutable scenario."""

    def __init__(self):
        self.requests: list[dict] = []
        self.scenario = "ok"
        self._app = web.Application()
        self._app.router.add_post("/api/payments/checkout-sessions", self._create)
        self._app.router.add_get(
            "/api/payments/checkout-sessions/{token}", self._status
        )
        self._app.router.add_post("/api/payments/checkout-sessions/cancel", self._cancel)
        self._runner = None
        self.port = None

    async def start(self):
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        self.port = self._runner.addresses[0][1]
        return self

    async def stop(self):
        if self._runner:
            await self._runner.cleanup()

    @property
    def url(self) -> str:
        # Base URL only: the client appends the /api/... paths itself.
        return f"http://127.0.0.1:{self.port}"

    async def _create(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = None
        self.requests.append(
            {
                "path": request.path,
                "method": request.method,
                "auth": request.headers.get("Authorization"),
                "body": body,
            }
        )
        scenario = self.scenario
        if scenario == "unauthorized":
            return web.json_response(
                {"error": {"code": "UNAUTHORIZED", "message": "Authentication failed."}},
                status=401,
            )
        if scenario == "server_error_twice":
            already_failed = sum(1 for _ in self.requests)
            if already_failed <= 2:
                return web.json_response({"error": {"code": "INTERNAL_ERROR"}}, status=500)
        if scenario == "server_error_always":
            return web.json_response({"error": {"code": "INTERNAL_ERROR"}}, status=500)
        if scenario == "slow":
            await asyncio.sleep(2.0)
        if scenario == "bad_payload":
            return web.json_response({"unexpected": True}, status=201)
        if scenario == "wrong_order":
            return web.json_response(
                self._ok_payload(order_ref="AVT-OTHER"), status=201
            )
        return web.json_response(self._ok_payload(), status=201)

    def _ok_payload(self, order_ref: str | None = None) -> dict:
        return {
            "order_ref": order_ref or ORDER.order_id,
            "product": {"name": ORDER.product_name},
            "amount_paise": ORDER.amount_paise,
            "amount_display": "999.00",
            "currency": "INR",
            "upi": {"vpa": PROFILE.vpa, "display_name": PROFILE.display_name},
            "qr_payload": "upi://pay?pa=merchant%40upi",
            "expires_at": "2026-10-20T10:30:00.000Z",
            "session_status": "PENDING",
            "checkout_token": TOKEN,
            "checkout_url": f"https://avantas.example/checkout/{TOKEN}",
            "reused": False,
        }

    async def _status(self, request: web.Request) -> web.Response:
        self.requests.append({"path": request.path, "method": "GET", "auth": None, "body": None})
        return web.json_response({"status": "PENDING"}, status=200)

    async def _cancel(self, request: web.Request) -> web.Response:
        self.requests.append({"path": request.path, "method": "POST", "auth": None, "body": None})
        return web.json_response({"status": "CANCELLED"}, status=200)


@pytest.fixture
async def server():
    srv = await RecordingServer().start()
    yield srv
    await srv.stop()


def no_sleep(_delay: float):
    return asyncio.sleep(0)


async def create_client(srv: RecordingServer, **cfg_overrides) -> CheckoutClient:
    cfg = make_config(srv.url, **cfg_overrides)
    client = CheckoutClient(cfg, sleep=no_sleep)
    await client.__aenter__()
    return client


# --------------------------------------------------------------- ownership

async def test_ownership_mismatch_raises_before_any_http(server):
    client = await create_client(server)
    with pytest.raises(CheckoutOwnershipError):
        await client.create_checkout_session(
            ORDER, PROFILE, actor_discord_id="999999999999999999"
        )
    assert server.requests == []  # no round trip at all
    await client.__aexit__()


async def test_owner_mismatch_does_not_leak_order_details(server):
    client = await create_client(server)
    with pytest.raises(CheckoutOwnershipError) as excinfo:
        await client.create_checkout_session(
            ORDER, PROFILE, actor_discord_id="999999999999999999"
        )
    assert ORDER.order_id not in str(excinfo.value)
    await client.__aexit__()


# -------------------------------------------------------------- amount/auth

async def test_persisted_amount_is_what_is_sent(server):
    client = await create_client(server)
    await client.create_checkout_session(ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id)
    sent = server.requests[0]["body"]
    assert sent["amount_paise"] == ORDER.amount_paise == 99900
    assert sent["currency"] == "INR"
    await client.__aexit__()


async def test_non_positive_amount_rejected_locally(server):
    client = await create_client(server)
    bad = replace(ORDER, amount_paise=0)
    with pytest.raises(InvalidSessionResponse):
        await client.create_checkout_session(bad, PROFILE, actor_discord_id=ORDER.owner_discord_id)
    assert server.requests == []
    await client.__aexit__()


async def test_secret_is_sent_and_401_is_auth_error(server):
    client = await create_client(server)
    server.scenario = "unauthorized"
    with pytest.raises(CheckoutAuthError):
        await client.create_checkout_session(ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id)
    assert server.requests[0]["auth"] == f"Bearer {SECRET}"
    # 401 must not be retried.
    assert len(server.requests) == 1
    await client.__aexit__()


# ------------------------------------------------------------------ retries

async def test_5xx_retries_bounded_then_fails(server):
    client = await create_client(server, max_retries=2)
    server.scenario = "server_error_always"
    with pytest.raises(CheckoutApiError) as excinfo:
        await client.create_checkout_session(ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id)
    assert excinfo.value.status == 500
    assert len(server.requests) == 3  # initial + 2 retries
    await client.__aexit__()


async def test_5xx_then_success_succeeds_with_same_idempotency_key(server):
    client = await create_client(server, max_retries=2)
    server.scenario = "server_error_twice"
    result = await client.create_checkout_session(
        ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id
    )
    assert result.checkout_url.endswith(result.checkout_token)
    assert len(server.requests) == 3
    keys = {r["body"]["idempotency_key"] for r in server.requests}
    assert keys == {f"{ORDER.order_id}:checkout-session"}
    await client.__aexit__()


async def test_timeout_raises_checkout_timeout_after_bounded_attempts(server):
    client = await create_client(
        server,
        max_retries=1,
        total_timeout_seconds=0.2,
        connect_timeout_seconds=0.2,
    )
    server.scenario = "slow"
    with pytest.raises(CheckoutTimeout):
        await client.create_checkout_session(ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id)
    assert len(server.requests) == 2  # initial + 1 retry
    await client.__aexit__()


async def test_unreachable_api_is_bounded_transport_failure():
    cfg = make_config(
        "http://127.0.0.1:9/api",
        max_retries=1,
        connect_timeout_seconds=0.2,
        total_timeout_seconds=0.2,
    )
    client = CheckoutClient(cfg, sleep=no_sleep)
    async with client:
        # A closed port may fail immediately or time out behind a local firewall.
        with pytest.raises((CheckoutNetworkError, CheckoutTimeout)):
            await client.create_checkout_session(ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id)


async def test_4xx_is_not_retried(server):
    client = await create_client(server, max_retries=3)
    server.scenario = "bad_payload"
    with pytest.raises(InvalidSessionResponse):
        await client.create_checkout_session(ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id)
    assert len(server.requests) == 1
    await client.__aexit__()


# --------------------------------------------------------------- idempotency

async def test_duplicate_clicks_send_identical_idempotency_key(server):
    client = await create_client(server)
    for _ in range(3):
        await client.create_checkout_session(
            ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id
        )
    keys = {r["body"]["idempotency_key"] for r in server.requests}
    assert len(keys) == 1
    await client.__aexit__()


async def test_order_ref_mismatch_is_invalid(server):
    client = await create_client(server)
    server.scenario = "wrong_order"
    with pytest.raises(InvalidSessionResponse):
        await client.create_checkout_session(ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id)
    await client.__aexit__()


# ----------------------------------------------------------------- logging

async def test_logs_never_contain_secret_token_or_body(server, caplog):
    client = await create_client(server)
    with caplog.at_level(logging.DEBUG):
        await client.create_checkout_session(
            ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id
        )
    blob = "\n".join(
        f"{r.getMessage()} {r.__dict__.get('extra', '')}" for r in caplog.records
    )
    all_text = caplog.text + blob
    assert SECRET not in all_text
    assert TOKEN not in all_text
    assert ORDER.owner_discord_id not in all_text
    assert ORDER.product_name not in all_text  # no full body echoes
    await client.__aexit__()


async def test_status_and_cancel_work(server):
    client = await create_client(server)
    status = await client.get_session_status(TOKEN)
    assert status["status"] == "PENDING"
    cancelled = await client.cancel_session(ORDER.order_id)
    assert cancelled["status"] == "CANCELLED"
    await client.__aexit__()
