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


@pytest.mark.parametrize("blank", ["", "  "])
def test_blank_authoritative_flag_never_reenables_legacy_checkout(blank):
    cfg = CheckoutConfig.from_env({
        "AVENTAS_CHECKOUT_ENABLED": blank,
        "CHECKOUT_ENABLED": "true",
        "WEBSITE_BASE_URL": "https://legacy.example",
        "PAYMENT_API_URL": "https://legacy.example",
        "PAYMENT_API_SECRET": SECRET,
    })
    assert cfg.enabled is False


@pytest.mark.parametrize(("prefixed", "alias"), [
    ("AVENTAS_WEBSITE_BASE_URL", "WEBSITE_BASE_URL"),
    ("AVENTAS_PAYMENT_API_URL", "PAYMENT_API_URL"),
    ("AVENTAS_PAYMENT_API_SECRET", "PAYMENT_API_SECRET"),
])
def test_blank_authoritative_payment_field_never_falls_back(prefixed, alias):
    with pytest.raises(CheckoutDisabled):
        CheckoutConfig.from_env(env(**{
            prefixed: "",
            alias: SECRET if "SECRET" in prefixed else "https://legacy.example",
        }))


def test_unknown_flag_never_echoes_untrusted_environment_value():
    sensitive = "private-merchant-key-should-not-appear"
    with pytest.raises(CheckoutDisabled) as exc:
        CheckoutConfig.from_env(env(AVENTAS_CHECKOUT_ENABLED=sensitive))
    assert sensitive not in str(exc.value)
    assert "unrecognized" in str(exc.value)


def test_optional_numeric_empty_still_falls_back_to_legacy_alias():
    cfg = CheckoutConfig.from_env(
        env(AVENTAS_CHECKOUT_MAX_RETRIES="", CHECKOUT_MAX_RETRIES="3")
    )
    assert cfg.max_retries == 3


def test_unprefixed_disabled_flag_is_honoured():
    cfg = CheckoutConfig.from_env({"CHECKOUT_ENABLED": "false"})
    assert cfg.enabled is False


def test_unprefixed_incomplete_config_still_fails_fast():
    with pytest.raises(CheckoutDisabled):
        CheckoutConfig.from_env({"CHECKOUT_ENABLED": "true"})


@pytest.mark.parametrize("field", ["AVENTAS_WEBSITE_BASE_URL", "AVENTAS_PAYMENT_API_URL"])
@pytest.mark.parametrize("url", [
    "http://merchant.example", "https://user:password@merchant.example",
    "https://merchant.example/api", "https://merchant.example?x=1",
    "https://merchant.example#fragment", "//merchant.example", "file:///tmp/checkout",
    "https://merchant.example\\evil", "https://merchant.example:invalid", "https://merchant.example:0",
])
def test_unsafe_checkout_origins_fail_closed_without_echoing_url(field, url):
    with pytest.raises(CheckoutDisabled) as error:
        CheckoutConfig.from_env(env(**{field: url}))
    assert "password" not in str(error.value)
    assert "merchant.example" not in str(error.value)


def test_api_origin_trailing_slash_is_normalized():
    cfg = CheckoutConfig.from_env(env(AVENTAS_PAYMENT_API_URL="https://avantas.example/"))
    assert cfg.api_url == "https://avantas.example"


@pytest.mark.parametrize(
    ("setting", "unsafe"),
    [
        ("AVENTAS_CHECKOUT_CONNECT_TIMEOUT", "secret-dont-log-timeout"),
        ("AVENTAS_CHECKOUT_TOTAL_TIMEOUT", "nan"),
        ("AVENTAS_CHECKOUT_CONNECT_TIMEOUT", "inf"),
        ("AVENTAS_CHECKOUT_TOTAL_TIMEOUT", "0"),
        ("AVENTAS_CHECKOUT_CONNECT_TIMEOUT", "-10"),
        ("AVENTAS_CHECKOUT_CONNECT_TIMEOUT", "121"),
        ("AVENTAS_CHECKOUT_TOTAL_TIMEOUT", "301"),
        ("AVENTAS_CHECKOUT_MAX_RETRIES", "receipt-reference-1234"),
        ("AVENTAS_CHECKOUT_MAX_RETRIES", "-1"),
        ("AVENTAS_CHECKOUT_MAX_RETRIES", "6"),
        ("AVENTAS_CHECKOUT_MAX_RETRIES", "9" * 400),
        ("AVENTAS_CHECKOUT_TTL_SECONDS", "secret-dont-log-ttl"),
        ("AVENTAS_CHECKOUT_TTL_SECONDS", "-1"),
        ("AVENTAS_CHECKOUT_TTL_SECONDS", "7201"),
        ("AVENTAS_CHECKOUT_TTL_SECONDS", "9" * 400),
    ],
)
def test_invalid_numeric_checkout_env_fails_closed_without_echoing_value(setting, unsafe):
    with pytest.raises(CheckoutDisabled) as error:
        CheckoutConfig.from_env(env(**{setting: unsafe}))
    assert setting in str(error.value)
    assert unsafe not in str(error.value)


def test_invalid_optional_numeric_settings_do_not_break_disabled_manual_fallback():
    cfg = CheckoutConfig.from_env({
        "AVENTAS_CHECKOUT_ENABLED": "false",
        "AVENTAS_CHECKOUT_MAX_RETRIES": "merchant-secret-do-not-echo",
        "AVENTAS_CHECKOUT_TOTAL_TIMEOUT": "nan",
    })
    assert cfg.enabled is False
    assert cfg.api_secret == ""


def test_legacy_ttl_remains_accepted_but_hard_capped_to_two_minutes():
    cfg = CheckoutConfig.from_env(env(AVENTAS_CHECKOUT_TTL_SECONDS="1800"))
    assert cfg.ttl_seconds == 120


def test_valid_numeric_aliases_and_zero_retry_budget():
    cfg = CheckoutConfig.from_env(env(
        AVENTAS_CHECKOUT_CONNECT_TIMEOUT="",
        CONNECT_TIMEOUT="0.5",
        AVENTAS_CHECKOUT_TOTAL_TIMEOUT="",
        TOTAL_TIMEOUT="2.5",
        AVENTAS_CHECKOUT_MAX_RETRIES="0",
    ))
    assert cfg.connect_timeout_seconds == 0.5
    assert cfg.total_timeout_seconds == 2.5
    assert cfg.max_retries == 0


@pytest.mark.parametrize("override", [
    {"max_retries": -1},
    {"max_retries": True},
    {"ttl_seconds": -20},
    {"ttl_seconds": 121},
    {"connect_timeout_seconds": float("nan")},
    {"total_timeout_seconds": float("inf")},
    {"total_timeout_seconds": 0},
    {"connect_timeout_seconds": 15, "total_timeout_seconds": 10},
    {"backoff_base_seconds": 10, "backoff_max_seconds": 1},
    {"backoff_max_seconds": float("nan")},
])
def test_direct_checkout_config_construction_rejects_invalid_numeric_options(override):
    with pytest.raises(CheckoutDisabled):
        CheckoutConfig(
            enabled=True,
            base_url="https://avantas.example",
            api_url="https://avantas.example",
            _api_secret=SECRET,
            **override,
        )
