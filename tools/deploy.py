#!/usr/bin/env python3
"""
ابزار کمکی استقرار SubTube روی Cloudflare Workers (نسخه عمومی و پاک‌سازی‌شده)

این اسکریپت سورس src/index.js را با API کلادفلر روی Worker شما بارگذاری می‌کند
و Bindingهای فعلی Worker (از جمله سکرت‌ها) را دست‌نخورده نگه می‌دارد:
سکرت‌ها در متادیتای آپلود فهرست نمی‌شوند تا مقدارشان حفظ شود.

استفاده:
    CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...  python3 tools/deploy.py

متغیرهای محیطی:
    CLOUDFLARE_API_TOKEN   توکن API کلادفلر با دسترسی Workers Scripts: Edit
    CLOUDFLARE_ACCOUNT_ID  شناسه حساب کلادفلر شما
    SUBTUBE_SCRIPT_NAME    نام Worker (پیش‌فرض: subtube-bot)

نکته: راه اصلی و پیشنهادی استقرار، Wrangler است (docs/INSTALL_FA.md).
این اسکریپت فقط یک راه جایگزین سبک است.
"""
import json
import os
import sys
import urllib.request
import urllib.error

TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
SCRIPT = os.environ.get("SUBTUBE_SCRIPT_NAME", "subtube-bot")
BASE = "https://api.cloudflare.com"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def api(method, path, data=None, content_type=None):
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode("utf-8", "replace"))


def main():
    if not TOKEN or not ACCOUNT:
        print("خطا: CLOUDFLARE_API_TOKEN و CLOUDFLARE_ACCOUNT_ID را تنظیم کنید.")
        sys.exit(1)

    # خواندن تنظیمات فعلی Worker برای حفظ Bindingها
    settings = api("GET", f"/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/settings")
    if not settings.get("success"):
        print("خواندن تنظیمات Worker ناموفق بود:", settings.get("errors"))
        sys.exit(1)
    current = settings["result"]

    bindings = []
    for b in current.get("bindings", []):
        if b["type"] == "secret_text":
            continue  # سکرتِ فهرست‌نشده سر جایش می‌ماند؛ هرگز مقدارش را نمی‌فرستیم
        nb = {"name": b["name"], "type": b["type"]}
        for k in ("database_id", "namespace_id", "text", "queue_name"):
            if k in b:
                nb[k] = b[k]
        bindings.append(nb)

    metadata = {
        "main_module": "index.js",
        "compatibility_date": current.get("compatibility_date", "2024-11-01"),
        "compatibility_flags": current.get("compatibility_flags", []),
        "usage_model": current.get("usage_model", "standard"),
        "bindings": bindings,
    }

    code = open(os.path.join(ROOT, "src", "index.js"), "rb").read()
    boundary = "----subtube-public-deploy"
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n".encode() + json.dumps(metadata).encode() + b"\r\n")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"index.js\"; filename=\"index.js\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode() + code + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())

    out = api("PUT", f"/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}",
              data=b"".join(parts), content_type=f"multipart/form-data; boundary={boundary}")
    print("success:", out.get("success"), "| errors:", out.get("errors"))
    res = out.get("result") or {}
    print("script:", res.get("id"), "| modified:", res.get("modified_on"))


if __name__ == "__main__":
    main()
