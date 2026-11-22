"""Offline tests of the actual discovery functions, without starting the app."""
import ast
import asyncio
import re
import unittest
from pathlib import Path
import httpx

source=ast.parse((Path(__file__).resolve().parents[1]/'app/main.py').read_text())
names={'require_ok','redact_error','meta_edge','instagram_unified_discover'}
ns={'httpx':httpx,'re':re,'GRAPH':'https://graph.facebook.com/v26.0'}
exec(compile(ast.Module(body=[n for n in source.body if getattr(n,'name',None) in names],type_ignores=[]),'<discovery>','exec'),ns)

class DiscoveryTest(unittest.IsolatedAsyncioTestCase):
    async def discover(self, routes):
        def handler(req):
            self.assertEqual(req.headers['Authorization'],'Bearer test-token')
            path=req.url.path.removeprefix('/v26.0/')
            body=routes.get((path,req.url.params.get('after')),routes.get(path,{'data':[]}))
            return httpx.Response(400 if 'error' in body else 200,json=body)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await ns['instagram_unified_discover'](client,'test-token')
    async def test_portfolio_and_page_deduplicate(self):
        self.assertEqual(await self.discover({'me/businesses':{'data':[{'id':'111111'}]},'111111/owned_instagram_accounts':{'data':[{'id':'222222'}]},'me/accounts':{'data':[{'instagram_business_account':{'id':'222222'}}]},'222222':{'id':'222222','username':'example'}}),[{'id':'222222','username':'example'}])
    async def test_pagination(self):
        result=await self.discover({'me/assigned_instagram_accounts':{'data':[{'id':'222222'}],'paging':{'next':'unused','cursors':{'after':'second'}}},('me/assigned_instagram_accounts','second'):{'data':[{'id':'333333'}]},'222222':{'id':'222222','username':'one'},'333333':{'id':'333333','username':'two'}})
        self.assertEqual(len(result),2)
    async def test_no_profile_access(self):
        with self.assertRaisesRegex(RuntimeError,'kein bestätigter Profilzugriff'):
            await self.discover({'me/accounts':{'data':[{'instagram_business_account':{'id':'222222'}}]},'222222':{'error':{'message':'denied'}}})
    async def test_empty(self):
        with self.assertRaisesRegex(RuntimeError,'Kein Instagram-Profil'):
            await self.discover({})

if __name__=='__main__': unittest.main()
