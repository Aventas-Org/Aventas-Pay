"""Whitespace-only authoritative credentials must fail closed."""
import pytest

from avantas_checkout import CheckoutConfig
from avantas_checkout.errors import CheckoutDisabled


@pytest.mark.parametrize("blank", [" " * 16, "\t" * 16, "\n" * 32, " \t\n" * 16])
def test_whitespace_only_prefixed_secret_is_not_a_usable_credential(blank):
    with pytest.raises(CheckoutDisabled):
        CheckoutConfig.from_env({
            "AVENTAS_CHECKOUT_ENABLED": "true",
            "AVENTAS_WEBSITE_BASE_URL": "https://checkout.example",
            "AVENTAS_PAYMENT_API_URL": "https://checkout.example",
            "AVENTAS_PAYMENT_API_SECRET": blank,
            "PAYMENT_API_SECRET": "synthetic-legacy-secret-1234567890",
        })


def test_nonblank_prefixed_secret_is_preserved_exactly():
    secret = "  synthetic-secret-with-significant-padding  "
    cfg = CheckoutConfig.from_env({
        "AVENTAS_CHECKOUT_ENABLED": "true",
        "AVENTAS_WEBSITE_BASE_URL": "https://checkout.example",
        "AVENTAS_PAYMENT_API_URL": "https://checkout.example",
        "AVENTAS_PAYMENT_API_SECRET": secret,
        "PAYMENT_API_SECRET": "synthetic-legacy-secret-1234567890",
    })
    assert cfg.api_secret == secret
