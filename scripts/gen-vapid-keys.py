#!/usr/bin/env python3
"""Generate a VAPID keypair for Web Push. Run once, ever.

    python3 scripts/gen-vapid-keys.py

Prints the two lines to add to docker/api.env. Rotating these invalidates every
existing push subscription — every user would silently stop receiving reminders
until they re-subscribed — so treat the private key as permanent and back it up
to Vaultwarden rather than regenerating it.
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def main():
    key = ec.generate_private_key(ec.SECP256R1())

    # Public key: uncompressed EC point, which is what the browser's
    # applicationServerKey expects.
    public_numbers = key.public_key().public_numbers()
    pub = b'\x04' + public_numbers.x.to_bytes(32, 'big') + public_numbers.y.to_bytes(32, 'big')

    # pywebpush takes the private key as a DER-encoded PKCS8 blob, base64url'd.
    der = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )

    print('Add these to docker/api.env (and back the private key up to Vaultwarden):\n')
    print(f'VAPID_PUBLIC_KEY={b64(pub)}')
    print(f'VAPID_PRIVATE_KEY={b64(der)}')
    print('VAPID_SUBJECT=mailto:hello@myglpshot.com')


if __name__ == '__main__':
    main()
