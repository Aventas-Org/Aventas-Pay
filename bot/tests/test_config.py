"""Configuration tests: feature flag, validation, secret hiding."""

import pytest

from avantas_checkout import CheckoutClient, CheckoutConfig
from avantas_checkout.errors import CheckoutDisabled

SECRET = "integration-secret-value-1234"


def env(**overrides):
    base = {
        "AVENTAS_CHECKOUT_ENABLED": "true",
        "AVENTAS_WEBSITE_BASE_URL": "https://avantas.example",
        "AVENTAS_PAYMENT_API_URL": "https://avantas.example",
        "AVENTAS_PAYMENT_API_SECRET": SECRET,
    }
    base.update(overrides)
    return base


def test_disabled_by_default():
    cfg = CheckoutConfig.from_env({})
    assert cfg.enabled is False


def test_enabled_parses_all_values():
    cfg = CheckoutConfig.from_env(env())
    assert cfg.enabled is True
    assert cfg.base_url == "https://avantas.example"
    assert cfg.api_url == "https://avantas.example"
    assert cfg.api_secret == SECRET


def test_base_url_trailing_slash_is_stripped():
    cfg = CheckoutConfig.from_env(env(AVENTAS_WEBSITE_BASE_URL="https://x.example/"))
    assert cfg.base_url == "https://x.example"


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off", "False", "NO"])
def test_disabled_values(value):
    cfg = CheckoutConfig.from_env(env(AVENTAS_CHECKOUT_ENABLED=value))
    assert cfg.enabled is False


def test_unrecognized_flag_value_raises():
    with pytest.raises(CheckoutDisabled):
        CheckoutConfig.from_env(env(AVENTAS_CHECKOUT_ENABLED="maybe"))


@pytest.mark.parametrize(
    "override",
    [
        {"AVENTAS_WEBSITE_BASE_URL": ""},
        {"AVENTAS_PAYMENT_API_URL": ""},
        {"AVENTAS_PAYMENT_API_SECRET": ""},
        {"AVENTAS_PAYMENT_API_SECRET": "short"},
    ],
)
def test_enabled_with_incomplete_config_fails_fast(override):
    with pytest.raises(CheckoutDisabled):
        CheckoutConfig.from_env(env(**override))


def test_disabled_config_needs_no_secret():
    cfg = CheckoutConfig.from_env({"AVENTAS_CHECKOUT_ENABLED": "false"})
    assert cfg.enabled is False


def test_secret_is_not_reprd_or_strd():
    cfg = CheckoutConfig.from_env(env())
    assert SECRET not in repr(cfg)
    assert SECRET not in str(cfg)


def test_client_refuses_to_construct_when_disabled():
    cfg = CheckoutConfig.from_env({})
    with pytest.raises(CheckoutDisabled):
        CheckoutClient(cfg)


# ---------------------------------------------------------------------------
# The real Aventas-bot .env convention is unprefixed (REVIEWS_CHANNEL_ID,
# PAYMENT_EMAIL_USER, ...). Both naming schemes must work; AVENTAS_-prefixed
# wins when both are present.
# ---------------------------------------------------------------------------
def test_unprefixed_env_convention_is_accepted():
    cfg = CheckoutConfig.from_env(
        {
            "CHECKOUT_ENABLED": "true",
            "WEBSITE_BASE_URL": "https://avantas.example",
            "PAYMENT_API_URL": "https://avantas.example",
            "PAYMENT_API_SECRET": SECRET,
        }
    )
    assert cfg.enabled is True
    assert cfg.base_url == "https://avantas.example"
    assert cfg.api_url == "https://avantas.example"
    assert cfg.api_secret == SECRET


def test_prefixed_env_wins_over_unprefixed():
    cfg = CheckoutConfig.from_env(
        {
            "AVENTAS_CHECKOUT_ENABLED": "true",
            "AVENTAS_WEBSITE_BASE_URL": "https://prefixed.example",
            "WEBSITE_BASE_URL": "https://unprefixed.example",
            "AVENTAS_PAYMENT_API_URL": "https://prefixed.example",
            "PAYMENT_API_URL": "https://unprefixed.example",
            "AVENTAS_PAYMENT_API_SECRET": SECRET,
        }
    )
    assert cfg.base_url == "https://prefixed.example"
    assert cfg.api_url == "https://prefixed.example"


def test_unprefixed_disabled_flag_is_honoured():
    cfg = CheckoutConfig.from_env({"CHECKOUT_ENABLED": "false"})
    assert cfg.enabled is False


def test_unprefixed_incomplete_config_still_fails_fast():
    with pytest.raises(CheckoutDisabled):
        CheckoutConfig.from_env({"CHECKOUT_ENABLED": "true"})
