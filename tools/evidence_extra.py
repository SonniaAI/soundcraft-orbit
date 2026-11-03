import asyncio, base64, json, urllib.request, websockets
CDP="http://127.0.0.1:18800"; URL="http://127.0.0.1:8137/index.html"
OUT="/home/node/.openclaw/workspaces/product-lead/media/orbit-v11"
tabs=json.load(urllib.request.urlopen(CDP+"/json/list"))
WS=next(t for t in tabs if t.get("type")=="page")["webSocketDebuggerUrl"]
async def main():
    async with websockets.connect(WS, max_size=64*2**20) as ws:
        _id=0
        async def cmd(m,p=None):
            nonlocal _id; _id+=1
            await ws.send(json.dumps({"id":_id,"method":m,"params":p or {}}))
            while True:
                msg=json.loads(await ws.recv())
                if msg.get("id")==_id: return msg.get("result",{})
        async def ev(e):
            r=await cmd("Runtime.evaluate",{"expression":e,"awaitPromise":True,"returnByValue":True})
            v=r.get("result",{})
            if v.get("subtype")=="error": raise RuntimeError(v.get("description"))
            return v.get("value")
        async def shot(n):
            r=await cmd("Page.captureScreenshot",{"format":"png"})
            open(f"{OUT}/{n}.png","wb").write(base64.b64decode(r["data"])); print("saved",n)
        await cmd("Page.enable"); await cmd("Runtime.enable")
        await cmd("Emulation.setDeviceMetricsOverride",{"width":1366,"height":768,"deviceScaleFactor":1,"mobile":False})
        await ev("try{localStorage.setItem('orbit.tour.v11','seen')}catch(e){}")
        await cmd("Page.navigate",{"url":URL}); await asyncio.sleep(1.8)
        # step-5 ruler assertions
        await ev("try{localStorage.removeItem('orbit.tour.v11')}catch(e){}; tourStart()")
        await asyncio.sleep(0.4)
        for _ in range(4): await ev("tourAdvance()"); await asyncio.sleep(0.3)
        st=await ev("(function(){const s=TOUR_STEPS[tourIdx];const r=s.targets()[0];return JSON.stringify({step:document.getElementById('tourStep').textContent,rulerOn:showRuler,btnOn:btnRuler.classList.contains('on'),spot:[Math.round(r.l),Math.round(r.t),Math.round(r.w),Math.round(r.h)]})})()")
        print("step5:", st)
        await ev("tourEnd()")
        # fresh ruler + inspect evidence
        await ev("btnRuler.click()"); await asyncio.sleep(0.3)
        await shot("ruler-on-1366")
        await ev("btnRuler.click()")
        c=await ev("(function(){const c=sortedCards()[sortedCards().length-1];const [cx,cy]=proj(c.g.x,c.g.y,c.g.d);return JSON.stringify([Math.round(cx),Math.round(cy)])})()")
        cx,cy=json.loads(c)
        await ev("(function(){var el=document.elementFromPoint(" + str(cx) + "," + str(cy) + ");el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:" + str(cx) + ",clientY:" + str(cy) + "}))})()")
        await asyncio.sleep(0.5)
        print("inspect-open:", await ev("!document.getElementById('inspect').classList.contains('hidden')"))
        await shot("inspect-open-1366")
        # tour replay via button after done-flag set
        await ev("document.getElementById('btnTour').click()"); await asyncio.sleep(0.4)
        print("replay:", await ev("document.getElementById('tourStep').textContent"))
        await ev("document.getElementById('tourSkip').click()")
        print("skip-sets-flag:", await ev("localStorage.getItem('orbit.tour.v11')"))
        print("DONE")
asyncio.run(main())
