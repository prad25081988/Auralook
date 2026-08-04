"""
generate_vapid.py — Generates a fresh VAPID key pair for Web Push
notifications. Run this once, copy the output into your Render
environment variables, then you can delete this file.

Usage:
    python generate_vapid.py
"""

from py_vapid import Vapid02
import base64

vapid = Vapid02()
vapid.generate_keys()

private_pem = vapid.private_pem().decode()

public_numbers = vapid.public_key.public_numbers()
x = public_numbers.x.to_bytes(32, "big")
y = public_numbers.y.to_bytes(32, "big")
public_bytes = b"\x04" + x + y
public_b64url = base64.urlsafe_b64encode(public_bytes).decode().rstrip("=")

print("=" * 60)
print("Copy these into Render → Environment tab")
print("=" * 60)
print()
print("VAPID_PRIVATE_KEY:")
print(private_pem)
print("VAPID_PUBLIC_KEY:")
print(public_b64url)
print()
print("=" * 60)
print("Done. You can delete this file now.")
print("=" * 60)