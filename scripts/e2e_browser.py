#!/usr/bin/env python3
import json, time, uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'examples' / 'e2e-customer-profile' / 'web'
OUT = ROOT / 'artifacts' / 'e2e-customer-profile'
OUT.mkdir(parents=True, exist_ok=True)

def now_iso():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def trace_variant(filename, run_index=1):
    events = []
    seq = 0
    req_meta = {}
    started = now_iso()
    def next_seq():
        nonlocal seq
        seq += 1
        return seq
    def add(event):
        events.append(event)
    html = (WEB / filename).read_text()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1280, 'height': 720}, locale='pt-BR')
        page = context.new_page()
        def router(route):
            req = route.request
            path = urlparse(req.url).path
            if path == '/api/customers/123':
                route.fulfill(status=204, headers={'content-type':'application/json','access-control-allow-origin':'*','access-control-allow-methods':'PUT,POST,OPTIONS','access-control-allow-headers':'content-type'}, body='')
            else:
                route.fulfill(status=404, headers={'access-control-allow-origin':'*'}, body='not found')
        page.route('**/*', router)
        def on_request(request):
            if '/api/' not in request.url or request.method == 'OPTIONS': return
            correlation = str(uuid.uuid4())
            req_meta[request] = correlation
            s = next_seq()
            payload = request.post_data_json if request.post_data else None
            add({'type':'HTTP_REQUEST','eventId':f'evt_{s}','timestampMs':int(time.time()*1000),'sequenceIndex':s,
                 'correlationId':correlation,'method':request.method,'url':request.url,'headers':request.headers,'payload':payload})
        def on_response(response):
            request = response.request
            correlation = req_meta.get(request)
            if not correlation: return
            s = next_seq()
            add({'type':'HTTP_RESPONSE','eventId':f'evt_{s}','timestampMs':int(time.time()*1000),'sequenceIndex':s,
                 'correlationId':correlation,'method':request.method,'url':request.url,'statusCode':response.status,
                 'headers':response.headers,'body':None,'requestToResponseEndMs':0})
        def on_failed(request):
            correlation = req_meta.get(request)
            if not correlation: return
            s = next_seq()
            add({'type':'HTTP_FAILED','eventId':f'evt_{s}','timestampMs':int(time.time()*1000),'sequenceIndex':s,
                 'correlationId':correlation,'method':request.method,'url':request.url,'errorText':str(request.failure or 'failed')})
        page.on('request', on_request)
        page.on('response', on_response)
        page.on('requestfailed', on_failed)
        page.set_content(html)
        before_url = page.url
        page.get_by_role('textbox', name='Email').fill('new@example.com')
        s = next_seq(); add({'type':'USER_INTERACTION','eventId':f'evt_{s}','timestampMs':int(time.time()*1000),'sequenceIndex':s,
                             'stepId':'fill-email','action':'fill','targetAriaRole':'textbox','targetAriaName':'Email','inputValue':'new@example.com'})
        with page.expect_response(lambda r: '/api/customers/123' in r.url and r.request.method != 'OPTIONS') as info:
            page.get_by_role('button', name='Salvar').click()
        s = next_seq(); add({'type':'USER_INTERACTION','eventId':f'evt_{s}','timestampMs':int(time.time()*1000),'sequenceIndex':s,
                             'stepId':'save','action':'click','targetAriaRole':'button','targetAriaName':'Salvar'})
        page.get_by_role('status').wait_for(state='visible')
        try:
            aria = page.locator('body').aria_snapshot()
            s = next_seq(); add({'type':'ARIA_STATE_CHANGE','eventId':f'evt_{s}','timestampMs':int(time.time()*1000),'sequenceIndex':s,
                                 'triggerEventId':'save','rawYamlTree':aria,'jsonTree':{}})
        except Exception:
            pass
        context.close(); browser.close()
    return {
        'scenarioId':'customer-profile.update-email','runIndex':run_index,'startedAt':started,
        'events': sorted(events, key=lambda e:e['sequenceIndex']),
        'environment': {'browser':'chromium','viewport':{'width':1280,'height':720},'locale':'pt-BR'},
        'sanitization': {'version':'fixture-v1','appliedAt':now_iso(),'redactionsCount':0}
    }

def main():
    variants = {
        'source': 'source.html',
        'target': 'target.html',
        'target-regression': 'target-regression.html',
    }
    for name, filename in variants.items():
        trace = trace_variant(filename)
        path = OUT / f'{name}.sanitized.json'
        path.write_text(json.dumps(trace, indent=2, ensure_ascii=False) + '\n')
        print(path)

if __name__ == '__main__': main()
