#!/usr/bin/env python3
"""
Create an OpenSearch Serverless index using pure Python stdlib.
No boto3, no requests, no pip install required.
SigV4 signing is implemented with hmac + hashlib (both built-in).
"""
import sys
import json
import hashlib
import hmac
import datetime
import urllib.request
import urllib.error
import urllib.parse
import os
import subprocess


# ─── SigV4 helpers ────────────────────────────────────────────────────────────

def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode('utf-8'), hashlib.sha256).digest()


def _derive_signing_key(secret_key: str, date_stamp: str, region: str, service: str) -> bytes:
    k_date    = _sign(('AWS4' + secret_key).encode('utf-8'), date_stamp)
    k_region  = _sign(k_date, region)
    k_service = _sign(k_region, service)
    return _sign(k_service, 'aws4_request')


def _get_credentials():
    """
    Return (access_key, secret_key, session_token).
    Tries env vars first, then `aws configure export-credentials` (awscli v2).
    """
    access_key    = os.environ.get('AWS_ACCESS_KEY_ID', '')
    secret_key    = os.environ.get('AWS_SECRET_ACCESS_KEY', '')
    session_token = os.environ.get('AWS_SESSION_TOKEN', '')

    if access_key and secret_key:
        return access_key, secret_key, session_token

    # Fallback: awscli v2 credential export
    try:
        result = subprocess.run(
            ['aws', 'configure', 'export-credentials', '--format', 'env-no-export'],
            capture_output=True, text=True, check=True
        )
        for line in result.stdout.splitlines():
            if '=' not in line:
                continue
            k, _, v = line.partition('=')
            k = k.strip()
            v = v.strip()
            if k == 'AWS_ACCESS_KEY_ID':
                access_key = v
            elif k == 'AWS_SECRET_ACCESS_KEY':
                secret_key = v
            elif k == 'AWS_SESSION_TOKEN':
                session_token = v
    except Exception as exc:
        print(f"[ERROR] Cannot resolve AWS credentials: {exc}", file=sys.stderr)
        sys.exit(1)

    if not access_key or not secret_key:
        print("[ERROR] AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not found.", file=sys.stderr)
        sys.exit(1)

    return access_key, secret_key, session_token


def _signed_request(method: str, url: str, body: bytes, region: str, service: str = 'aoss'):
    """Build a urllib.request.Request with AWS SigV4 Authorization header."""
    access_key, secret_key, session_token = _get_credentials()

    parsed    = urllib.parse.urlparse(url)
    host      = parsed.netloc
    path      = parsed.path or '/'

    t          = datetime.datetime.utcnow()
    amz_date   = t.strftime('%Y%m%dT%H%M%SZ')
    date_stamp = t.strftime('%Y%m%d')

    payload_hash = hashlib.sha256(body).hexdigest()

    # Build canonical headers (must be sorted)
    canon_hdrs = {
        'content-type':        'application/json',
        'host':                host,
        'x-amz-content-sha256': payload_hash,
        'x-amz-date':          amz_date,
    }
    if session_token:
        canon_hdrs['x-amz-security-token'] = session_token

    sorted_keys      = sorted(canon_hdrs)
    canonical_headers = ''.join(f"{k}:{canon_hdrs[k]}\n" for k in sorted_keys)
    signed_headers    = ';'.join(sorted_keys)

    canonical_request = '\n'.join([
        method, path, '',          # method, path, empty query string
        canonical_headers,
        signed_headers,
        payload_hash,
    ])

    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign   = '\n'.join([
        'AWS4-HMAC-SHA256',
        amz_date,
        credential_scope,
        hashlib.sha256(canonical_request.encode('utf-8')).hexdigest(),
    ])

    signing_key = _derive_signing_key(secret_key, date_stamp, region, service)
    signature   = hmac.new(signing_key, string_to_sign.encode('utf-8'), hashlib.sha256).hexdigest()

    auth_header = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    all_headers = dict(canon_hdrs)
    all_headers['Authorization'] = auth_header

    return urllib.request.Request(url, data=body, headers=all_headers, method=method)


# ─── Main ─────────────────────────────────────────────────────────────────────

def create_index(endpoint: str, index_name: str, region: str = 'ap-southeast-2') -> int:
    url  = f"{endpoint.rstrip('/')}/{index_name}"
    body = json.dumps({
        "settings": {
            "index": {
                "knn": True
            }
        },
        "mappings": {
            "properties": {
                "embedding": {
                    "type": "knn_vector",
                    "dimension": 1024,
                    "method": {
                        "name": "hnsw",
                        "space_type": "l2",
                        "engine": "faiss",
                        "parameters": {"ef_construction": 256, "m": 16}
                    }
                },
                "content":  {"type": "text"},
                "metadata": {"type": "object", "enabled": False}
            }
        }
    }).encode('utf-8')

    req = _signed_request('PUT', url, body, region)

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"[OK]    Index '{index_name}' created successfully")
            return 0
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode('utf-8', errors='replace')
        if 'already_exists' in error_body or 'resource_already_exists' in error_body:
            print(f"[OK]    Index '{index_name}' already exists — skipping")
            return 0
        print(f"[ERROR] HTTP {exc.code} creating index", file=sys.stderr)
        print(f"        {error_body}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <collection_endpoint> [index_name] [region]",
              file=sys.stderr)
        sys.exit(1)

    _endpoint    = sys.argv[1]
    _index_name  = sys.argv[2] if len(sys.argv) > 2 else "iq-policy-index"
    _region      = sys.argv[3] if len(sys.argv) > 3 else "ap-southeast-2"

    sys.exit(create_index(_endpoint, _index_name, _region))
