"""Sandbox-only PayPal subscription checkout. Never grants paid entitlements."""
import os
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit
import httpx
from fastapi import HTTPException, Depends, Request
from pydantic import BaseModel

BASE = 'https://api-m.sandbox.paypal.com'

class Checkout(BaseModel):
    plan_code: str


def install(app, current_user, dbconn, plans):
    def config():
        return (os.getenv('PAYPAL_MODE', 'sandbox') == 'sandbox' and
                os.getenv('BILLING_ENABLED', '').lower() == 'true' and
                all(os.getenv(k) for k in ('PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET','PAYPAL_WEBHOOK_ID','PAYPAL_RETURN_BASE')))

    def plan_id(code):
        return os.getenv('PAYPAL_PLAN_' + code.upper(), '')

    def call(method, path, body=None):
        if not config():
            raise HTTPException(503, 'PayPal Sandbox ist nicht eingerichtet.')
        try:
            with httpx.Client(timeout=20, follow_redirects=False) as client:
                token = client.post(BASE + '/v1/oauth2/token', auth=(os.environ['PAYPAL_CLIENT_ID'], os.environ['PAYPAL_CLIENT_SECRET']), data={'grant_type':'client_credentials'})
                token.raise_for_status()
                response = client.request(method, BASE + path, json=body, headers={'Authorization':'Bearer '+token.json()['access_token']})
                response.raise_for_status()
                return response.json() if response.content else {}
        except (httpx.HTTPError, ValueError, KeyError):
            raise HTTPException(502, 'PayPal Sandbox konnte die Anfrage nicht bearbeiten.')

    def rows(owner):
        with dbconn() as db:
            return [dict(r) for r in db.execute('SELECT external_subscription_id,plan_code,status,current_period_end FROM billing_subscriptions WHERE owner_id=? AND provider=? ORDER BY updated_at DESC',(owner,'paypal_sandbox')).fetchall()]

    def sync(row):
        ident = row['external_subscription_id']
        if not re.fullmatch(r'I-[A-Za-z0-9-]+', ident):
            raise HTTPException(400, 'Ungültige Abo-ID.')
        data = call('GET','/v1/billing/subscriptions/'+ident)
        if data.get('id') != ident or data.get('plan_id') != plan_id(row['plan_code']):
            raise HTTPException(409, 'PayPal Tarif stimmt nicht überein.')
        status = data.get('status','UNKNOWN')
        end = data.get('billing_info',{}).get('next_billing_time')
        with dbconn() as db:
            db.execute('UPDATE billing_subscriptions SET status=?,current_period_end=?,updated_at=? WHERE provider=? AND external_subscription_id=?',(status,end,datetime.now(timezone.utc).isoformat(),'paypal_sandbox',ident))
        return status

    @app.get('/api/billing/overview')
    def overview(user: dict = Depends(current_user)):
        return {'billing_enabled':bool(config()),'mode':'sandbox','current_plan':'Testbetrieb','subscription_status':'sandbox_only','draft_plans':[dict(p,checkout_ready=bool(config() and plan_id(p['code']))) for p in plans], 'currency':'EUR','subscriptions':rows(user['id'])}

    @app.post('/api/billing/paypal/checkout')
    def checkout(req: Checkout, user: dict = Depends(current_user)):
        if not config():
            raise HTTPException(503,'Sandbox nicht aktiviert.')
        plan = next((p for p in plans if p['code']==req.plan_code),None)
        if not plan or not plan_id(req.plan_code):
            raise HTTPException(400,'Tarif nicht eingerichtet.')
        base = os.environ['PAYPAL_RETURN_BASE'].rstrip('/')
        parsed = urlsplit(base)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
            raise HTTPException(503,'PAYPAL_RETURN_BASE muss eine HTTPS-Origin sein.')
        # Validate actual provider plan against displayed price and monthly interval.
        pid = plan_id(req.plan_code)
        if not re.fullmatch(r'P-[A-Za-z0-9-]+',pid):
            raise HTTPException(503,'Ungültige Plan-ID.')
        remote = call('GET','/v1/billing/plans/'+pid)
        cycles = remote.get('billing_cycles',[])
        cycle = cycles[0] if len(cycles)==1 else {}
        price = cycle.get('pricing_scheme',{}).get('fixed_price',{})
        from decimal import Decimal, InvalidOperation
        try:
            valid_price = Decimal(str(price.get('value'))) == Decimal(str(plan['monthly_eur']))
        except InvalidOperation:
            valid_price = False
        if not (remote.get('status')=='ACTIVE' and cycle.get('tenure_type')=='REGULAR' and cycle.get('total_cycles')==0 and cycle.get('frequency')=={'interval_unit':'MONTH','interval_count':1} and price.get('currency_code')=='EUR' and valid_price and remote.get('payment_preferences',{}).get('setup_fee',{}).get('value','0') in ('0','0.0','0.00') and not remote.get('taxes',{}).get('percentage','0') not in ('0','0.0','0.00')):
            raise HTTPException(409,'PayPal Tarif muss dem angezeigten Monatsbetrag ohne Zusatzgebühren entsprechen.')
        data = call('POST','/v1/billing/subscriptions',{'plan_id':pid,'application_context':{'brand_name':'TimeSave Social by Solvetec','user_action':'SUBSCRIBE_NOW','return_url':base+'/','cancel_url':base+'/'}})
        ident = data.get('id','')
        approval = next((x.get('href','') for x in data.get('links',[]) if x.get('rel')=='approve'),'')
        url = urlsplit(approval)
        if not re.fullmatch(r'I-[A-Za-z0-9-]+',ident) or url.scheme!='https' or url.hostname!='www.sandbox.paypal.com' or url.username or url.password:
            raise HTTPException(502,'Ungültige PayPal Antwort.')
        with dbconn() as db:
            db.execute('INSERT INTO billing_subscriptions(id,owner_id,provider,external_subscription_id,plan_code,status,updated_at) VALUES(?,?,?,?,?,?,?)',(uuid.uuid4().hex,user['id'],'paypal_sandbox',ident,req.plan_code,'APPROVAL_PENDING',datetime.now(timezone.utc).isoformat()))
        return {'approval_url':approval}

    @app.post('/api/billing/paypal/refresh')
    def refresh(user: dict = Depends(current_user)):
        for row in rows(user['id']):
            sync(row)
        return {'subscriptions':rows(user['id'])}

    @app.post('/api/billing/paypal/webhook')
    async def webhook(request: Request):
        if not config():
            raise HTTPException(503,'Sandbox nicht aktiviert.')
        from starlette.concurrency import run_in_threadpool
        event = await request.json()
        headers = {k:request.headers.get('paypal-'+k.replace('_','-'),'') for k in ('auth_algo','cert_url','transmission_id','transmission_sig','transmission_time')}
        if not all(headers.values()):
            raise HTTPException(400,'PayPal Signatur fehlt.')
        result = await run_in_threadpool(call,'POST','/v1/notifications/verify-webhook-signature',dict(headers,webhook_id=os.environ['PAYPAL_WEBHOOK_ID'],webhook_event=event))
        if result.get('verification_status')!='SUCCESS':
            raise HTTPException(400,'PayPal Signatur ungültig.')
        resource = event.get('resource',{})
        kind = event.get('event_type','')
        ident = resource.get('id') if kind.startswith('BILLING.SUBSCRIPTION.') else resource.get('billing_agreement_id')
        with dbconn() as db:
            row = db.execute('SELECT external_subscription_id,plan_code FROM billing_subscriptions WHERE provider=? AND external_subscription_id=?',('paypal_sandbox',ident)).fetchone()
        if row:
            await run_in_threadpool(sync,dict(row))
        return {'ok':True}
