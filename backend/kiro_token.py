# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""The Kiro sign-in this app calls the BFF with: Kiro Crew's own, from its sign-in vault.

This is the call Kiro Crew makes to answer the engine's ``_kiro/auth/getAccessToken``:
``KasAuthProvider`` over the gateway's vault with the ``KIRO_API_KEY`` bypass off. It
resolves the stored identity, renews it under the cross-process lock when it is inside
the refresh margin, and never returns the refresh token.

App Kit documents ``kiro_crew`` imports as for built-in apps only. This app imports it
anyway, on purpose: it is the one way to the signed-in identity, and enabled app hooks
already run with the gateway's privileges. The import is deferred to first use.

The token is a credential: it is held for one request, never logged, never persisted and
never put in an exception message.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

#: The ``X-Kiro-Idp`` value the BFF accepts for each sign-in provider. ``Internal`` has no
#: value of its own: the BFF routes it as ``AWSIdC``.
_IDP_HEADER = {
    "Google": "Google",
    "Github": "Github",
    "BuilderId": "BuilderId",
    "Enterprise": "AWSIdC",
    "Internal": "AWSIdC",
    "ExternalIdp": "ExternalOIDC",
}
#: The ``TokenType`` a sign-in declares.
_TOKEN_TYPE = {"external_idp": "EXTERNAL_IDP", "IdC": "SSO_OIDC"}


class NotSignedIn(Exception):
    """Kiro Crew holds no usable Kiro sign-in."""


class SignInUnavailable(Exception):
    """The stored sign-in could not be read or renewed. The message names no value."""


@dataclass(frozen=True)
class KiroCredential:
    """One resolved sign-in. ``repr`` hides the token."""

    access_token: str
    idp: str
    profile_arn: str | None = None
    token_type: str | None = None

    def __repr__(self) -> str:
        return (
            f"KiroCredential(access_token=<redacted>, idp={self.idp!r}, "
            f"profile_arn={self.profile_arn!r}, token_type={self.token_type!r})"
        )

    def headers(self) -> dict[str, str]:
        """The BFF identity headers."""
        out = {"Authorization": f"Bearer {self.access_token}", "X-Kiro-Idp": self.idp}
        if self.profile_arn:
            out["X-Kiro-Profile-Arn"] = self.profile_arn
        if self.token_type:
            out["TokenType"] = self.token_type
        return out


def _vault() -> tuple[Any, Any]:
    """``(store, provider)`` over the gateway's sign-in vault, imported on first use."""
    from kiro_crew.auth.bridge import default_token_store
    from kiro_crew.auth.provider import KasAuthProvider

    store = default_token_store()
    return store, KasAuthProvider(store, allow_env_api_key=False)


def _credential(token: Any) -> KiroCredential:
    from kiro_crew.auth.provider import kas_profile_arn

    idp = _IDP_HEADER.get(getattr(token, "provider", None) or "")
    if idp is None:
        raise SignInUnavailable("the stored Kiro sign-in names a provider the BFF does not accept")
    return KiroCredential(
        access_token=token.access_token,
        idp=idp,
        profile_arn=kas_profile_arn(token),
        token_type=_TOKEN_TYPE.get(getattr(token, "auth_method", None) or ""),
    )


class VaultTokenSource:
    """The signed-in identity, re-read from the vault on every call."""

    def __init__(self, vault: Callable[[], tuple[Any, Any]] = _vault) -> None:
        self._vault = vault

    async def credential(self, *, rejected: KiroCredential | None = None) -> KiroCredential:
        """The current credential. *rejected* forces a renewal of a token the BFF refused."""
        try:
            from kiro_crew.auth.provider import NotAuthenticated
            from kiro_crew.auth.refresh import IdentitySignedOut, ensure_fresh
        except ImportError:
            raise SignInUnavailable(
                "this Kiro Crew has no Kiro sign-in vault (kiro_crew.auth); update Kiro Crew"
            ) from None

        try:
            store, provider = self._vault()
            if rejected is None:
                token = await provider.current()
            else:
                stored = await asyncio.to_thread(store.resolve)
                if stored is None:
                    raise NotAuthenticated("no stored Kiro credential")
                import aiohttp

                async with aiohttp.ClientSession() as session:
                    token = await ensure_fresh(
                        store, stored, session=session, rejected_access_token=rejected.access_token
                    )
        except (NotAuthenticated, IdentitySignedOut):
            raise NotSignedIn("no Kiro sign-in is stored") from None
        except SignInUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - a refresh error can quote response bytes
            raise SignInUnavailable(
                f"the Kiro sign-in could not be read or renewed ({type(exc).__name__})"
            ) from None
        if not getattr(token, "access_token", None):
            raise NotSignedIn("the stored Kiro sign-in has no access token")
        return _credential(token)
