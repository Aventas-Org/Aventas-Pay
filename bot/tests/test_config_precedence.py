"""Fail-closed environment precedence at the checkout integration boundary."""
import pytest

from avantas_checkout import CheckoutConfig
from avantas_checkout.errors import CheckoutDisabled

SECRET = "synthetic-legacy-secret-1234567890"


def legacy_config(**overrides):
    values = {
        "CHECKOUT_ENABLED": "true",
        "WEBSITE_BASE_URL": "https://legacy.example",
        "PAYMENT_API_URL": "https://legacy.example",
        "PAYMENT_API_SECRET": SECRET,
    }
    values.update(overrides)
    return values


@pytest.mark.parametrize("value", ["", " ", "\t", "false", "off"])
def test_prefixed_disable_never_inherits_legacy_true(value):
    cfg = CheckoutConfig.from_env(legacy_config(AVENTAS_CHECKOUT_ENABLED=value))
    assert cfg.enabled is False


@pytest.mark.parametrize("value", ["", " ", "\t", "\n" * 32])
def test_blank_prefixed_secret_cannot_inherit_legacy_secret(value):
    with pytest.raises(CheckoutDisabled) as error:
        CheckoutConfig.from_env(legacy_config(
            AVENTAS_CHECKOUT_ENABLED="true", AVENTAS_PAYMENT_API_SECRET=value,
        ))
    assert SECRET not in str(error.value)


@pytest.mark.parametrize("field", ["AVENTAS_WEBSITE_BASE_URL", "AVENTAS_PAYMENT_API_URL"])
@pytest.mark.parametrize("value", ["", " ", "\t"])
def test_blank_prefixed_origin_cannot_inherit_legacy_origin(field, value):
    values = legacy_config(AVENTAS_CHECKOUT_ENABLED="true")
    values[field] = value
    with pytest.raises(CheckoutDisabled):
        CheckoutConfig.from_env(values)


def test_legacy_only_configuration_remains_supported():
    cfg = CheckoutConfig.from_env(legacy_config())
    assert cfg.enabled is True
    assert cfg.base_url == "https://legacy.example"
    assert cfg.api_url == "https://legacy.example"
    assert cfg.api_secret == SECRET


@pytest.mark.parametrize("field,attribute,legacy,default", [
    ("CHECKOUT_CONNECT_TIMEOUT", "connect_timeout_seconds", "7", 5),
    ("CHECKOUT_TOTAL_TIMEOUT", "total_timeout_seconds", "12", 10),
    ("CHECKOUT_MAX_RETRIES", "max_retries", "3", 2),
    ("CHECKOUT_TTL_SECONDS", "ttl_seconds", "300", 1800),
])
def test_blank_optional_tuning_keeps_legacy_and_default_behavior(field, attribute, legacy, default):
    values = legacy_config(**{"AVENTAS_" + field: ""})
    assert getattr(CheckoutConfig.from_env(values), attribute) == default
    values[field] = legacy
    assert getattr(CheckoutConfig.from_env(values), attribute) == float(legacy)


def test_invalid_flag_does_not_echo_environment_value():
    value = "synthetic-sensitive-value-not-for-logs"
    with pytest.raises(CheckoutDisabled) as error:
        CheckoutConfig.from_env(legacy_config(AVENTAS_CHECKOUT_ENABLED=value))
    assert value not in str(error.value)
    assert value not in repr(error.value)
