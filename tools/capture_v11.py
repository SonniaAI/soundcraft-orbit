#!/usr/bin/env python3
"""Orbit v1.1 verification: strict glyph-box collision audit + fresh screenshots."""
import asyncio, base64, json
import websockets, urllib.request

CDP = "http://127.0.0.1:18800"
URL = "http://127.0.0.1:8137/index.html"
OUT = "/home/node/.openclaw/workspaces/product-lead/media/orbit-v11"

tabs = json.load(urllib.request.urlopen(CDP + "/json/list"))
page = next(t for t in tabs if t.get("type") == "page")
WS = page["webSocketDebuggerUrl"]

AUDIT_JS = r"""
(function(){
  const MONO='ui-monospace, SFMono-Regular, Menlo, monospace';
  const SANS='"Avenir Next", "Segoe UI", system-ui, sans-serif';
  function glyphBox(str, mm, opts, x, y){
    const px=mm*S;
    ctx.font=(opts.weight||500)+' '+px+'px '+(opts.mono?MONO:SANS);
    let x0;
    if(opts.tracking){
      const chars=[...str];
      const total=chars.reduce((a,c)=>a+ctx.measureText(c).width+px*opts.tracking,0)-px*opts.tracking;
      x0=opts.align==='center'?x-total/2:opts.align==='right'?x-total:x;
      var x1=x0+total;
    } else {
      const w=ctx.measureText(str).width;
      x0=opts.align==='center'?x-w/2:opts.align==='right'?x-w:x;
      var x1=x0+w;
    }
    const bl=opts.baseline||'alphabetic';
    let y0,y1;
    if(bl==='middle'){y0=y-px*0.6;y1=y+px*0.6;}
    else {y0=y-px*0.78;y1=y+px*0.28;}
    return [x0,y0,x1,y1];
  }
  function inter(a,b,tol){
    tol=tol||0;
    return !(a[2]+tol<=b[0]||b[2]+tol<=a[0]||a[3]+tol<=b[1]||b[3]+tol<=a[1]);
  }
  const issues=[];
  const name=(n)=>n;
  // ---- collect glyph boxes ----
  const bars=DATA.session.bars;
  const [rcx,rcy]=proj(RING.x,RING.y,RING.d);
  const R=RING.r*S,T=RING.th*S,seg=360/bars;
  const numBoxes=[];
  for(let k=0;k<bars;k++){
    const mid=(-Math.PI/2+(k+0.5)*seg*Math.PI/180);
    const tx=rcx+Math.cos(mid)*(R+T*0.9),ty=rcy+Math.sin(mid)*(R+T*0.9);
    numBoxes.push({n:'bar-num-'+(k+1),b:glyphBox(String(k+1),10,{align:'center',baseline:'middle'},tx,ty)});
  }
  const titleBox=glyphBox(DATA.session.name.toUpperCase(),16,{align:'center',tracking:0.22,weight:700},rcx,rcy-(RING.r+RING.th+12)*S);
  const tracksBox=glyphBox(materialTracks().length+'/'+DATA.tracks.length+' TRACKS',12.5,{align:'center',tracking:0.18},rcx,rcy-34*S);
  const bpmBox=glyphBox(String(Math.round(DATA.session.bpm)),34,{align:'center',weight:700},rcx,rcy+8*S);
  const bpmCapBox=glyphBox('BPM',12,{align:'center',tracking:0.28},rcx,rcy+32*S);
  // ---- ring text collisions ----
  for(const nb of numBoxes) if(inter(titleBox,nb.b)) issues.push('title-overlaps-'+nb.n);
  for(const nb of numBoxes) if(inter(nb.b,tracksBox)||inter(nb.b,bpmBox)||inter(nb.b,bpmCapBox)) issues.push(nb.n+'-overlaps-center-stack');
  if(inter(tracksBox,bpmBox)) issues.push('tracks-overlaps-bpm');
  if(inter(bpmBox,bpmCapBox)) issues.push('bpm-overlaps-bpm-caption');
  // ---- ring band vs cards (2D annulus vs rect) ----
  const cards=sortedCards().map(({t,g},i)=>{const [cx,cy]=proj(g.x,g.y,g.d);const w=CARD.w*S,h=CARD.h*S;return {n:'card-'+t.name,r:[cx-w/2,cy-h/2,cx+w/2,cy+h/2],cx,cy,w,h};});
  const inner=R-T;
  for(const c of cards){
    const nx=Math.max(Math.min(c.cx,rcx),Math.min(rcx,c.r[2]))||rcx;
    const qx=Math.max(c.r[0],Math.min(rcx,c.r[2]));
    const qy=Math.max(c.r[1],Math.min(rcy,c.r[3]));
    const dq=Math.hypot(rcx-qx,rcy-qy);
    const corners=[[c.r[0],c.r[1]],[c.r[2],c.r[1]],[c.r[0],c.r[3]],[c.r[2],c.r[3]]];
    const dMax=Math.max(...corners.map(p=>Math.hypot(rcx-p[0],rcy-p[1])));
    if(dq<=R+1&&dMax>=inner-1) issues.push('ring-band-overlaps-'+c.n);
    // bar numbers vs cards
    for(const nb of numBoxes) if(inter(nb.b,c.r)) issues.push(nb.n+'-overlaps-'+c.n);
    // title vs cards
    if(inter(titleBox,c.r)) issues.push('ring-title-overlaps-'+c.n);
  }
  // ---- cards pairwise ----
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){
    if(inter(cards[i].r,cards[j].r,1)) issues.push(cards[i].n+'-overlaps-'+cards[j].n);
  }
  // ---- plaque ----
  const [pcx,pcy]=proj(PLAQUE.x,PLAQUE.y,PLAQUE.d);
  const pr=[pcx-PLAQUE.w*S/2,pcy-PLAQUE.h*S/2,pcx+PLAQUE.w*S/2,pcy+PLAQUE.h*S/2];
  for(const c of cards) if(inter(pr,c.r,1)) issues.push('plaque-overlaps-'+c.n);
  // plaque text lines inside plaque box
  const pLines=[
    glyphBox('MIX BOUNCE',11,{tracking:0.3},pr[0]+17*S,pr[1]+24*S),
    glyphBox(DATA.bounces[0].lufs.toFixed(1),34,{weight:700,mono:true},pr[0]+17*S,pr[1]+66*S),
    glyphBox('PK '+DATA.bounces[0].peakDb.toFixed(1)+' dBFS · TP '+DATA.bounces[0].truePeakDb.toFixed(1)+' dBTP',12,{mono:true},pr[0]+17*S,pr[1]+88*S),
    glyphBox('just now · '+(DATA.bounces[0].bytes/1e6).toFixed(1)+' MB · '+DATA.bounces[0].seconds.toFixed(1)+' s',11,{mono:true},pr[0]+17*S,pr[1]+106*S)
  ];
  for(let i=0;i<pLines.length;i++){const L=pLines[i];if(L[0]<pr[0]+2||L[2]>pr[2]-2||L[1]<pr[1]+2||L[3]>pr[3]-2) issues.push('plaque-line-'+i+'-escapes-plaque');}
  for(let i=0;i<pLines.length-1;i++) if(inter(pLines[i],pLines[i+1],1)) issues.push('plaque-line-'+i+'-hits-line-'+(i+1));
  // ---- FOV frame + label ----
  const [fx0,fy0]=proj(-FOV_HALF_W,FOV_HALF_H);
  const [fx1,fy1]=proj(FOV_HALF_W,-FOV_HALF_H);
  if(fx0<0||fy0<18||fx1>W||fy1>H) issues.push('fov-frame-clipped ['+Math.round(fx0)+','+Math.round(fy0)+','+Math.round(fx1)+','+Math.round(fy1)+'] W='+W+' H='+H);
  const fovLabel=glyphBox('SNAP SPECTACLES FOV '+FOV_H+'° × '+FOV_V+'° @ '+D0/1000+' m — outside = not rendered on glasses',11.5,{align:'center',tracking:0.08},(fx0+fx1)/2,fy0-10);
  if(fovLabel[1]<0) issues.push('fov-label-clipped-top');
  // fov label vs session title (horizontal overlap possible only if same y zone)
  if(inter(fovLabel,titleBox)) issues.push('fov-label-overlaps-ring-title');
  // ---- stage inside frame ----
  const stage=[Math.min(...cards.map(c=>c.r[0]),pr[0],rcx-R-T*0.9-14*S),Math.min(...cards.map(c=>c.r[1]),pr[1],titleBox[1]),Math.max(...cards.map(c=>c.r[2]),pr[2],rcx+R+T*0.9+14*S),Math.max(...cards.map(c=>c.r[3]),pr[3],rcy+40*S)];
  if(stage[0]<fx0+2||stage[1]<fy0+16||stage[2]>fx1-2||stage[3]>fy1-2) issues.push('stage-escapes-fov-frame ['+stage.map(Math.round)+']');
  // ---- DOM: legend vs topbar, legend inside window ----
  const lb=document.getElementById('legend').getBoundingClientRect();
  const tb=document.getElementById('topbar').getBoundingClientRect();
  if(lb.top<tb.bottom-2) issues.push('legend-overlaps-topbar');
  if(lb.right>W-4||lb.bottom>H-4||lb.left<0) issues.push('legend-escapes-window');
  // legend vs fov frame top line? legend must sit inside frame horizontally near right edge but below label
  if(lb.left<fx1&&lb.top<fy0+4&&lb.bottom>fy0) issues.push('legend-straddles-fov-top-line');
  // ---- viewport sanity ----
  return JSON.stringify({issues, S:Math.round(S*1000), frame:[Math.round(fx0),Math.round(fy0),Math.round(fx1),Math.round(fy1)], stage:stage.map(Math.round)});
})()
"""

async def main():
    async with websockets.connect(WS, max_size=64 * 2**20) as ws:
        _id = 0
        async def cmd(method, params=None):
            nonlocal _id
            _id += 1
            await ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == _id:
                    if "error" in msg: raise RuntimeError(f"{method}: {msg['error']}")
                    return msg.get("result", {})
        async def evaluate(expr):
            r = await cmd("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
            v = r.get("result", {})
            if v.get("subtype") == "error": raise RuntimeError(v.get("description", "eval error"))
            return v.get("value")
        async def shot(name):
            r = await cmd("Page.captureScreenshot", {"format": "png"})
            open(f"{OUT}/{name}.png", "wb").write(base64.b64decode(r["data"]))
            print("saved", name)
        await cmd("Page.enable"); await cmd("Runtime.enable")

        for w, h, tag in [(1366, 768, "1366x768"), (1920, 1080, "1920x1080"), (1024, 640, "1024x640")]:
            await cmd("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False})
            await evaluate("try{localStorage.setItem('orbit.tour.v11','seen')}catch(e){}")
            await cmd("Page.navigate", {"url": URL})
            await asyncio.sleep(2.0)
            audit = await evaluate(AUDIT_JS)
            print(f"== {tag} ==")
            print(audit)
            if tag == "1366x768":
                await shot("overview-1366x768")
            if tag == "1920x1080":
                await shot("overview-1920x1080")

        # tour step shots at 1366
        await cmd("Emulation.setDeviceMetricsOverride", {"width": 1366, "height": 768, "deviceScaleFactor": 1, "mobile": False})
        await evaluate("try{localStorage.removeItem('orbit.tour.v11')}catch(e){}; tourStart()")
        await asyncio.sleep(0.8)
        for i in range(1, 7):
            await shot(f"tour-step-{i}-1366")
            state = await evaluate("document.getElementById('tourStep').textContent")
            print("step shot:", state)
            if i < 6:
                await evaluate("tourAdvance()")
                await asyncio.sleep(0.55)
        # tour never blocks play: click PLAY during tour
        r = await evaluate("(function(){btnPlay.click();const t=btnPlay.textContent;btnPlay.click();return t;})()")
        print("play-toggle-during-tour:", r)
        await evaluate("tourEnd()")
        await asyncio.sleep(0.4)
        print("DONE")

asyncio.run(main())
