"""Local experimental adapter for the pinned omkarcloud scraper; no paid API."""
import argparse
import pathlib
import re
import sys
import json
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

ROOT = pathlib.Path(__file__).resolve().parents[1]
bundled = ROOT / '.runtime/amazon-scraper-bundled'
sys.path.insert(0, str(bundled if bundled.is_dir() else ROOT / '.runtime/omkar-amazon-scraper'))
import bottle
from bs4 import BeautifulSoup
from cheroot import wsgi
from amazon import fetch, parsers, sites

fetch.TIMEOUT = 15
fetch.RETRIES = 0
fetch.BLOCK_RETRIES = 1
fetch.CLICK_THROUGHS = 0
_original_location = fetch.set_location
_original_waf_check = fetch.is_waf_challenge


def refuse_verification(*_args, **_kwargs):
    raise fetch.AmazonBlocked('Amazon verification required; no challenge submitted')


def stop_on_waf_challenge(response):
    if _original_waf_check(response):
        refuse_verification()
    return False


# The pinned dependency can submit verification forms and PoW by default.
# This workspace only reads ordinary public pages and stops at those boundaries.
fetch.click_through = refuse_verification
fetch._solve_pow = refuse_verification
fetch.is_waf_challenge = stop_on_waf_challenge


def set_location(session, postal_code=None):
    previous = session.located
    changed = _original_location(session, postal_code)
    if not changed:
        session.located = previous  # Upstream incorrectly caches failed changes.
    return changed


fetch.set_location = set_location
app = bottle.Bottle()


def location(html, zipcode):
    soup = BeautifulSoup(html, 'lxml')
    visible = ' '.join(n.get_text(' ', strip=True) for n in soup.select(
        '#glow-ingress-line1, #glow-ingress-line2'))
    return {'requested_postal_code': zipcode, 'visible_delivery_location': visible,
            'verified': bool(re.search(r'(?<!\d)' + re.escape(zipcode) + r'(?!\d)', visible))}


def collect(kind, value, zipcode):
    started = time.monotonic()
    if not re.fullmatch(r'\d{5}', zipcode):
        raise ValueError('US postal_code must contain five digits')
    if kind == 'product' and not re.fullmatch(r'[A-Z0-9]{10}', value):
        raise ValueError('product must be a 10-character ASIN')
    if kind == 'search' and not 1 <= len(value.strip()) <= 250:
        raise ValueError('query must contain 1 to 250 characters')
    # Isolate each request: another merchant or a previous request may use another ZIP.
    fetch.drop_session('US')
    path = '/dp/' + value if kind == 'product' else '/s'
    params = None if kind == 'product' else {'k': value}
    html = fetch.page('US', path, params, postal_code=zipcode)
    delivery = location(html, zipcode)
    if not delivery['verified']:
        # One bounded retry; verify rendered location instead of trusting cached state.
        fetch.drop_session('US')
        fetch.ensure_location('US', postal_code=zipcode)
        html = fetch.page('US', path, params, postal_code=zipcode)
        delivery = location(html, zipcode)
    site = sites.site('US')
    data = parsers.product_page(html, site) if kind == 'product' else parsers.search_page(html, site)
    missing = []
    if kind == 'product':
        missing = [key for key in ('title', 'bullets', 'details', 'description') if not data.get(key)]
        if not (data.get('price') or {}).get('amount'):
            missing.append('price')
    return {'provider': 'omkar-local', 'fetched_at': datetime.now(timezone.utc).isoformat(),
            'source_url': 'https://www.amazon.com' + path + ('?' + urlencode(params) if params else ''),
            'elapsed_ms': round((time.monotonic() - started) * 1000),
            'delivery': delivery, 'missing_fields': missing,
            'price_region_verified': delivery['verified'], 'data': data,
            'notes': ['Page claims may conflict across variants; verify pack size and material before comparison.',
                      'Missing title does not establish that the product was removed.']}


@app.get('/health')
def health():
    return {'status': 'ok', 'provider': 'omkar-local', 'experimental': True}


@app.get('/products/details')
@app.get('/search')
def endpoint():
    kind = 'search' if bottle.request.path == '/search' else 'product'
    value = bottle.request.query.get('query' if kind == 'search' else 'product', '')
    try:
        return collect(kind, value, bottle.request.query.get('postal_code', '10001'))
    except ValueError as exc:
        bottle.response.status = 400
        return {'error': str(exc)}
    except Exception as exc:
        bottle.response.status = 502
        return {'error': type(exc).__name__, 'message': 'Amazon page could not be retrieved; no data inferred.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8792)
    parser.add_argument('--collect', action='store_true')
    args = parser.parse_args()
    if args.collect:
        request = json.load(sys.stdin)
        try:
            print(json.dumps(collect(request['kind'], request['value'], request['postal_code'])))
        except Exception as exc:
            name = type(exc).__name__
            print(json.dumps({'error': {'code': 'AMAZON_BLOCKED' if 'Blocked' in name else 'AMAZON_FETCH_FAILED',
                                       'type': name, 'message': 'Amazon page could not be retrieved; no data inferred.'},
                              'failed_at': datetime.now(timezone.utc).isoformat()}))
            sys.exit(1)
    else:
        wsgi.Server(('127.0.0.1', args.port), app, numthreads=2).start()
