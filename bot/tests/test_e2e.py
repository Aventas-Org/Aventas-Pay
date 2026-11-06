"""Cross-system end-to-end tests.

These start the REAL website implementation (website/test/e2e/server.ts: real
handlers, real SQL store, real migrations, real rate limiter) as a local Bun
HTTP server, then drive it with the REAL Python bot client used by the
Discord bot. Nothing in the request path is mocked.

What this proves end to end:
  * a valid order flow produces a checkout session with the persisted amount;
  * the public status endpoint serves exactly the stored recipient + amount and
    leaks no Discord identifier, secret or internal field;
  * repeated Discord clicks converge on one session (idempotency over the wire);
  * a wrong secret is rejected without retry;
  * cancellation is idempotent;
  * a PENDING session can never be observed as PAID, and nothing a "customer"
    can send changes that.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import urllib.error
import urllib.request

from avantas_checkout import (
    CheckoutApiError,
    CheckoutAuthError,
    CheckoutClient,
    CheckoutConfig,
    OrderFacts,
    PaymentProfile,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_SCRIPT = REPO_ROOT / "website" / "test" / "e2e" / "server.ts"

E2E_BOT_SECRET = "e2e-bot-secret-at-least-16-chars"
E2E_TOKEN_SECRET = "e2e-token-secret-at-least-16"

ORDER = OrderFacts(
    order_id="AVT-E2E-0001",
    owner_discord_id="123456789012345678",
    product_id="vp-1000",
    product_name="1000 Valorant Points",
    amount_paise=99900,
)
PROFILE = PaymentProfile(
    profile_id="primary", vpa="merchant@upi", display_name="Aventas Store"
)


def _wait_for_port(process: subprocess.Popen, timeout: float = 20.0) -> int:
    """Reads the server's ready line from stdout and returns the bound port."""
    deadline = time.time() + timeout
    assert process.stdout is not None
    while time.time() < deadline:
        line = process.stdout.readline()
        if not line:
            if process.poll() is not None:
                raise RuntimeError("e2e server exited before becoming ready")
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if payload.get("ready") and isinstance(payload.get("port"), int):
            return int(payload["port"])
    raise TimeoutError("e2e server did not become ready in time")


@pytest.fixture(scope="module")
def base_url():
    env = dict(os.environ)
    env["E2E_BOT_SECRET"] = E2E_BOT_SECRET
    env["E2E_TOKEN_SECRET"] = E2E_TOKEN_SECRET
    process = subprocess.Popen(
        [shutil.which("bun") or "bun", "run", str(SERVER_SCRIPT)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=str(REPO_ROOT / "website"),
    )
    try:
        port = _wait_for_port(process)
        url = f"http://127.0.0.1:{port}"
        # The checkout_url embedded in responses should point at this server.
        env["E2E_WEBSITE_BASE"] = url
        yield url
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


def make_client(base_url: str, secret: str = E2E_BOT_SECRET, **overrides) -> CheckoutClient:
    values = dict(
        enabled=True,
        base_url=base_url,
        api_url=base_url,
        _api_secret=secret,
        max_retries=1,
        backoff_base_seconds=0.01,
        backoff_max_seconds=0.05,
        total_timeout_seconds=5.0,
        connect_timeout_seconds=2.0,
    )
    values.update(overrides)
    config = CheckoutConfig(**values)
    return CheckoutClient(config)


def public_status(base_url: str, token: str) -> tuple[int, dict]:
    """Fetches the public status endpoint the checkout page uses (no auth)."""
    req = urllib.request.Request(
        f"{base_url}/api/payments/checkout-sessions/{token}",
        headers={"accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode() or "{}")


async def test_full_checkout_flow(base_url):
    async with make_client(base_url) as client:
        result = await client.create_checkout_session(
            ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id
        )
        assert result.status == "PENDING"
        assert result.checkout_url.endswith(result.checkout_token)
        assert result.checkout_url.startswith(base_url)

        # The customer's browser view: unauthenticated GET with just the token.
        http_status, body = public_status(base_url, result.checkout_token)
        assert http_status == 200
        assert body["status"] == "PENDING"
        assert body["order_ref"] == ORDER.order_id
        assert body["amount_paise"] == ORDER.amount_paise == 99900
        assert body["upi"] == {"vpa": "merchant@upi", "display_name": "Aventas Store"}
        # QR payload encodes exactly the stored recipient and amount.
        assert "pa=merchant%40upi" in body["qr_payload"]
        assert "am=999.00" in body["qr_payload"]

        # No private data crosses the public boundary.
        blob = json.dumps(body)
        assert ORDER.owner_discord_id not in blob
        assert "discord" not in blob.lower()
        assert E2E_BOT_SECRET not in blob
        assert E2E_TOKEN_SECRET not in blob
        for forbidden in (
            "idempotency_key",
            "token_hash",
            "payment_profile_id",
            "session_id",
            "provider_transaction_ref",
        ):
            assert forbidden not in body


async def test_duplicate_clicks_converge_over_the_wire(base_url):
    async with make_client(base_url) as client:
        first = await client.create_checkout_session(
            ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id
        )
        second = await client.create_checkout_session(
            ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id
        )
        assert second.checkout_url == first.checkout_url
        assert second.reused is True
        # Both URLs serve the same live session.
        assert public_status(base_url, first.checkout_token)[1]["status"] == "PENDING"


async def test_wrong_secret_rejected_over_the_wire(base_url):
    async with make_client(base_url, secret="wrong-secret-value-here") as client:
        with pytest.raises(CheckoutAuthError):
            await client.create_checkout_session(
                ORDER, PROFILE, actor_discord_id=ORDER.owner_discord_id
            )


async def test_cancel_is_idempotent_over_the_wire(base_url):
    order = OrderFacts(
        order_id="AVT-E2E-CANCEL",
        owner_discord_id=ORDER.owner_discord_id,
        product_id="vp-500",
        product_name="500 Valorant Points",
        amount_paise=49900,
    )
    async with make_client(base_url) as client:
        created = await client.create_checkout_session(
            order, PROFILE, actor_discord_id=order.owner_discord_id
        )
        first = await client.cancel_session(order.order_id)
        second = await client.cancel_session(order.order_id)
        assert first["status"] == "CANCELLED"
        assert second["status"] == "CANCELLED"
        # The customer view reflects the terminal state and stays terminal.
        _, body = public_status(base_url, created.checkout_token)
        assert body["status"] == "CANCELLED"
        _, again = public_status(base_url, created.checkout_token)
        assert again["status"] == "CANCELLED"


async def test_pending_session_can_never_be_observed_as_paid(base_url):
    """No customer-reachable input can flip a session to PAID."""
    order = OrderFacts(
        order_id="AVT-E2E-PENDING",
        owner_discord_id=ORDER.owner_discord_id,
        product_id="vp-2000",
        product_name="2000 Valorant Points",
        amount_paise=199900,
    )
    async with make_client(base_url) as client:
        created = await client.create_checkout_session(
            order, PROFILE, actor_discord_id=order.owner_discord_id
        )

    token = created.checkout_token
    base = f"{base_url}/api/payments/checkout-sessions"

    # Attempt forged transitions through every public-facing mutating vector.
    for method, path, payload in (
        ("POST", f"{base}/{token}", {"status": "PAID"}),
        ("PUT", f"{base}/{token}", {"status": "PAID"}),
        ("PATCH", f"{base}/{token}", {"status": "PAID"}),
        ("POST", f"{base}", {"order_id": order.order_id, "status": "PAID"}),
    ):
        req = urllib.request.Request(
            path,
            data=json.dumps(payload).encode() if payload else None,
            headers={"content-type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                assert resp.status >= 400  # must not be accepted
        except urllib.error.HTTPError as exc:
            assert exc.code in (401, 404, 405, 413)

    # Query-string smuggling is ignored: the read endpoint reports stored state.
    status, body = public_status(base_url, token)
    assert status == 200
    assert body["status"] == "PENDING"
    req = urllib.request.Request(
        f"{base}/{token}?status=PAID&session_status=PAID",
        headers={"accept": "application/json"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert json.loads(resp.read().decode())["status"] == "PENDING"

    # Still PENDING afterwards; payment was never "confirmed".
    assert public_status(base_url, token)[1]["status"] == "PENDING"


async def test_unknown_token_is_generic_404(base_url):
    status, body = public_status(base_url, "B" * 43)
    assert status == 404
    assert body["error"]["code"] == "NOT_FOUND"
    assert body["error"]["message"] == "Checkout session not found."


async def test_ownership_enforced_before_network(base_url):
    async with make_client(base_url) as client:
        from avantas_checkout import CheckoutOwnershipError

        with pytest.raises(CheckoutOwnershipError):
            await client.create_checkout_session(
                ORDER, PROFILE, actor_discord_id="999999999999999999"
            )


def _verify(base_url: str, order_id: str, provider_ref: str, secret: str = E2E_BOT_SECRET):
    """Calls the server-to-server verify endpoint the way the bot's existing
    post-verification hook would (staff-approved or Slice-email-matched)."""
    req = urllib.request.Request(
        f"{base_url}/api/payments/checkout-sessions/verify",
        data=json.dumps({"order_id": order_id, "provider_transaction_ref": provider_ref}).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {secret}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode() or "{}")


async def test_verified_payment_marks_session_paid_end_to_end(base_url):
    """The full Stage 3 bridge: create -> trusted verification -> PAID visible
    to the customer, with the public view still minimal."""
    order = OrderFacts(
        order_id="AVT-E2E-VERIFY",
        owner_discord_id=ORDER.owner_discord_id,
        product_id="vp-1000",
        product_name="1000 Valorant Points",
        amount_paise=99900,
    )
    async with make_client(base_url) as client:
        created = await client.create_checkout_session(
            order, PROFILE, actor_discord_id=order.owner_discord_id
        )
        assert public_status(base_url, created.checkout_token)[1]["status"] == "PENDING"

    # Verification happened bot-side (staff role or Slice email); now recorded.
    status, body = _verify(base_url, order.order_id, "UTR-E2E-VERIFY1")
    assert status == 200
    assert body["status"] == "PAID"

    pub = public_status(base_url, created.checkout_token)[1]
    assert pub["status"] == "PAID"
    # The public PAID view still leaks nothing.
    assert "provider_transaction_ref" not in pub
    assert order.owner_discord_id not in json.dumps(pub)

    # Idempotent replay of the same verification is a no-op success.
    replay_status, replay_body = _verify(base_url, order.order_id, "UTR-E2E-VERIFY1")
    assert replay_status == 200
    assert replay_body["status"] == "PAID"

    # A DIFFERENT receipt cannot re-verify or overwrite the paid state.
    mismatch_status, _ = _verify(base_url, order.order_id, "UTR-E2E-OTHER9")
    assert mismatch_status == 409

    # Wrong secret cannot verify.
    forged_status, _ = _verify(base_url, order.order_id, "UTR-E2E-FORGED", secret="wrong-secret-value-here")
    assert forged_status == 401
    assert public_status(base_url, created.checkout_token)[1]["status"] == "PAID"


async def test_provider_reference_cannot_pay_two_orders(base_url):
    orders = [
        OrderFacts(
            order_id=f"AVT-E2E-REF-{n}", owner_discord_id=ORDER.owner_discord_id,
            product_id="vp-1000", product_name="1000 Valorant Points", amount_paise=99900,
        )
        for n in (1, 2)
    ]
    async with make_client(base_url) as client:
        sessions = [
            await client.create_checkout_session(order, PROFILE, actor_discord_id=order.owner_discord_id)
            for order in orders
        ]
    assert _verify(base_url, orders[0].order_id, "FAKE-ONE-RECEIPT")[0] == 200
    assert _verify(base_url, orders[1].order_id, "FAKE-ONE-RECEIPT")[0] == 409
    assert public_status(base_url, sessions[0].checkout_token)[1]["status"] == "PAID"
    assert public_status(base_url, sessions[1].checkout_token)[1]["status"] == "PENDING"
