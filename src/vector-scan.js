// ══════════════════════════════════════════════════════════════════
// VECTOR SCAN ENGINE
// constructPath args: [0]=cmdArray, [1]=coordArray, [2]=transform?
// Confirmed opcodes: 13=moveTo(2 coords), 14=lineTo(2), 18=closePath(0)
// curveTo variants use 6 coords — opcode TBD, skip by coord count
// ══════════════════════════════════════════════════════════════════
let pdfCurrentPage=null, pdfCurrentViewport=null, pdfRenderScale=7.0;

async function extractVectorPaths(page, viewport){
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const fns = opList.fnArray;
  const ars = opList.argsArray;
  const [va,vb,vc,vd,ve,vf] = viewport.transform;

  // ── Graphics-state matrix stack ──
  // PDF content can reposition/rescale subsequent drawing through 'cm'
  // (OPS.transform), bracketed by 'q'/'Q' (OPS.save/OPS.restore) — and
  // critically, every Form XObject placement (OPS.paintFormXObjectBegin)
  // carries its own matrix too. Reusable blocks/symbols are placed almost
  // exactly this way: small local-coordinate geometry plus a placement
  // matrix that moves it to its actual position on the sheet. Without
  // tracking this stack, that local geometry gets transformed by the
  // page's viewport matrix alone and lands nowhere near where it's
  // actually drawn — which is why a real, correctly-sized template
  // selection can still come back with zero sub-paths inside it.
  let ctmStack=[[1,0,0,1,0,0]];
  function curCTM(){ return ctmStack[ctmStack.length-1]; }
  function composeMatrix(m1,m2){ // m1 ∘ m2 — apply m2 first, then m1
    return [
      m1[0]*m2[0]+m1[2]*m2[1],
      m1[1]*m2[0]+m1[3]*m2[1],
      m1[0]*m2[2]+m1[2]*m2[3],
      m1[1]*m2[2]+m1[3]*m2[3],
      m1[0]*m2[4]+m1[2]*m2[5]+m1[4],
      m1[1]*m2[4]+m1[3]*m2[5]+m1[5]
    ];
  }
  function tr(px,py){
    const m=curCTM();
    const ux=m[0]*px+m[2]*py+m[4], uy=m[1]*px+m[3]*py+m[5];
    return{x:va*ux+vc*uy+ve, y:vb*ux+vd*uy+vf};
  }
  let formXObjectCount=0, transformOpCount=0;

  // Real PDF.js operator-list opcodes inside a constructPath cmds array
  // (verified against the pdf.js OPS enum and real-world cmds output —
  // see pdf.js issue #16184 and discussion #18410). 10/11/12 are
  // save/restore/transform and never actually appear inside a cmds
  // array. The ones that do: curveTo/'c' (15, 6 coords: c1x,c1y,c2x,c2y,
  // endx,endy), curveTo2/'v' (16, 4 coords: c2x,c2y,endx,endy — c1 = the
  // current point), curveTo3/'y' (17, 4 coords: c1x,c1y,endx,endy — c2 =
  // the endpoint), and rectangle/'re' (19, 4 coords: rx,ry,rw,rh). The
  // previous mapping here (15 → 4 coords instead of 6, and no entry at
  // all for 19) silently corrupted every rectangle and every true bezier
  // curve, plus everything else parsed afterward in the same batch.
  const CMD_MOVETO=13, CMD_LINETO=14, CMD_CLOSEPATH=18, CMD_RECTANGLE=19;
  const CURVE_OPS=new Set([15,16,17]);
  const CURVE_COORDS={15:6,16:4,17:4};

  // Sample several points ALONG each bezier curve, not just its endpoint,
  // so round/curved symbols (drains, bolts, sumps) get a shape signature
  // and point-cloud detailed enough to match reliably instead of being
  // reduced to a handful of sparse cardinal points.
  const NUM_CURVE_SAMPLES=4;
  function sampleCubicBezier(p0,c1,c2,p3,n){
    const pts=[];
    for(let s=1;s<=n;s++){
      const t=s/n, mt=1-t;
      const a=mt*mt*mt, b=3*mt*mt*t, c=3*mt*t*t, d=t*t*t;
      pts.push({x:a*p0.x+b*c1.x+c*c2.x+d*p3.x, y:a*p0.y+b*c1.y+c*c2.y+d*p3.y});
    }
    return pts;
  }

  const paths=[];
  let pending=[]; // each entry: {pts:[...], hasCurve:bool}
  // 0.5px minimum was calibrated for 600 DPI (scale 6.0); scale it to the
  // actual render scale so large sheets (which render smaller, see
  // handleFile) don't lose legitimately small symbol details.
  const minDim=0.5*((pdfRenderScale||6.0)/6.0);
  let rectOpCount=0, curveOpCount=0;

  function commitPending(){
    for(const sp of pending){
      const pts=sp.pts;
      if(pts.length<2) continue;
      let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;
      for(const p of pts){
        if(p.x<x1)x1=p.x; if(p.y<y1)y1=p.y;
        if(p.x>x2)x2=p.x; if(p.y>y2)y2=p.y;
      }
      const w=x2-x1, h=y2-y1;
      // OR, not AND: a perfectly horizontal or vertical line (extremely
      // common in orthogonal CAD drafting — slab edges, leader lines,
      // cross-shaped symbol legs) has an EXACT zero in one dimension, and
      // the old AND test silently threw every one of those away no
      // matter how long it was.
      if(w>minDim||h>minDim)
        paths.push({points:pts,cx:(x1+x2)/2,cy:(y1+y2)/2,w,h,x1,y1,x2,y2,hasCurve:sp.hasCurve});
    }
    pending=[];
  }

  for(let i=0;i<fns.length;i++){
    const op=fns[i];

    if(op===OPS.constructPath){
      const cmds=ars[i][0];
      const coords=ars[i][1];
      let ci=0;
      let curSub=[];
      let curHasCurve=false;

      for(const cmd of cmds){
        if(cmd===CMD_MOVETO){
          if(curSub.length>1) pending.push({pts:[...curSub],hasCurve:curHasCurve});
          if(ci+1<coords.length){
            curSub=[tr(coords[ci],coords[ci+1])]; ci+=2;
          }
          curHasCurve=false;
        } else if(cmd===CMD_LINETO){
          if(ci+1<coords.length){
            curSub.push(tr(coords[ci],coords[ci+1])); ci+=2;
          }
        } else if(cmd===CMD_CLOSEPATH){
          if(curSub.length>0) curSub.push({...curSub[0]});
          if(curSub.length>1) pending.push({pts:[...curSub],hasCurve:curHasCurve});
          curSub=[];
          curHasCurve=false;
        } else if(cmd===CMD_RECTANGLE){
          // 're' is batched here as opcode 19 — it is NOT emitted as a
          // standalone top-level OPS.rectangle op in practice (the branch
          // below this loop is a defensive fallback that real-world PDFs
          // essentially never hit). Without this branch, every rectangle
          // (embed plates, sleeves, base plates — extremely common in
          // structural symbols) fell into the catch-all "unknown op" case:
          // silently dropped, AND its 4 coordinates never consumed, which
          // corrupted every point parsed afterward in the same batch.
          if(curSub.length>1) pending.push({pts:[...curSub],hasCurve:curHasCurve});
          if(ci+3<coords.length){
            const rx=coords[ci],ry=coords[ci+1],rw=coords[ci+2],rh=coords[ci+3];
            ci+=4; rectOpCount++;
            const p1=tr(rx,ry),p2=tr(rx+rw,ry),p3=tr(rx+rw,ry+rh),p4=tr(rx,ry+rh);
            pending.push({pts:[p1,p2,p3,p4,{...p1}],hasCurve:false});
          }
          curSub=[];
          curHasCurve=false;
        } else if(CURVE_OPS.has(cmd)){
          // Correct per-variant coordinate counts (op 15 was wrongly read
          // as 4 coords instead of 6, misreading the curve's 2nd control
          // point as its endpoint and desyncing everything parsed after
          // it in the batch), plus sampling several points along the
          // curve — not just its endpoint — for an accurate shape.
          const p0=curSub.length?curSub[curSub.length-1]:null;
          const need=CURVE_COORDS[cmd];
          if(p0&&ci+need-1<coords.length){
            curHasCurve=true; curveOpCount++;
            let c1,c2,end;
            if(cmd===15){
              c1=tr(coords[ci],coords[ci+1]); c2=tr(coords[ci+2],coords[ci+3]); end=tr(coords[ci+4],coords[ci+5]);
            } else if(cmd===16){
              c1=p0; c2=tr(coords[ci],coords[ci+1]); end=tr(coords[ci+2],coords[ci+3]);
            } else {
              c1=tr(coords[ci],coords[ci+1]); end=tr(coords[ci+2],coords[ci+3]); c2=end;
            }
            ci+=need;
            for(const pt of sampleCubicBezier(p0,c1,c2,end,NUM_CURVE_SAMPLES)) curSub.push(pt);
          } else {
            // No current point yet (curve is the first op in a subpath) —
            // still advance past its coordinates so everything parsed
            // after it stays in sync, even though we can't sample it.
            ci+=need;
          }
        } else {
          // Unknown op — nothing else here maps to coordinates, so don't advance
        }
      }
      if(curSub.length>1) pending.push({pts:[...curSub],hasCurve:curHasCurve});

    } else if(op===OPS.rectangle){
      // Defensive fallback only: real 're' operators are folded into
      // constructPath's cmds array (handled above via CMD_RECTANGLE) in
      // every pdf.js build this was tested against. Kept in case some
      // producer or future pdf.js version emits it standalone.
      rectOpCount++;
      const [rx,ry,rw,rh]=ars[i];
      const p1=tr(rx,ry),p2=tr(rx+rw,ry),p3=tr(rx+rw,ry+rh),p4=tr(rx,ry+rh);
      pending.push({pts:[p1,p2,p3,p4,{...p1}],hasCurve:false});

    } else if(
      op===OPS.stroke||op===OPS.fill||op===OPS.fillStroke||
      op===OPS.eoFill||op===OPS.eoFillStroke||op===OPS.endPath
    ){
      commitPending();

    } else if(op===OPS.save){
      ctmStack.push(curCTM().slice());
    } else if(op===OPS.restore){
      if(ctmStack.length>1) ctmStack.pop();
    } else if(op===OPS.transform){
      const m2=ars[i];
      if(Array.isArray(m2)&&m2.length>=6){
        transformOpCount++;
        ctmStack[ctmStack.length-1]=composeMatrix(curCTM(),m2);
      }
    } else if(op===OPS.paintFormXObjectBegin){
      formXObjectCount++;
      const args=ars[i];
      const m2=(args&&args[0]&&args[0].length>=6)?args[0]:[1,0,0,1,0,0];
      ctmStack.push(composeMatrix(curCTM(),m2));
    } else if(op===OPS.paintFormXObjectEnd){
      if(ctmStack.length>1) ctmStack.pop();
    }
  }
  commitPending();
  if(formXObjectCount>0||transformOpCount>0){
    console.log(`[QAQC diag] ${formXObjectCount} Form XObject placements and ${transformOpCount} 'cm' transforms processed — geometry inside these is now positioned using its actual placement matrix instead of the page's base transform alone.`);
  }
  console.log(`[QAQC diag] Vector extraction: ${rectOpCount} rectangle(s) and ${curveOpCount} curve segment(s) parsed into geometry (each curve sampled at ${NUM_CURVE_SAMPLES} points along its path).`);
  return paths;
}

function pathSig(path,vertexDedupDist=1.5){
  const {w,h,cx,cy,points}=path;
  if(!points||points.length<2) return null;
  const uniq=[points[0]];
  for(let i=1;i<points.length;i++){
    const p=points[i];
    if(Math.hypot(p.x-uniq[uniq.length-1].x,p.y-uniq[uniq.length-1].y)>vertexDedupDist) uniq.push(p);
  }
  let perim=0;
  for(let i=1;i<points.length;i++) perim+=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);
  const polyArea=Math.abs(points.reduce((s,p,i,a)=>{const n=a[(i+1)%a.length];return s+p.x*n.y-n.x*p.y;},0)/2);
  const circ=perim>0?(4*Math.PI*polyArea)/(perim*perim):0;
  // w/h is Infinity for a perfectly horizontal line (h=0) — now reachable
  // since the commitPending/templatePaths filters were changed from AND
  // to OR so axis-aligned lines aren't dropped. Two Infinity aspects
  // later divide to NaN in sigSim, which would silently make any two
  // axis-aligned lines un-matchable and undo that fix. A large-but-finite
  // sentinel keeps "very flat/tall" comparable to "very flat/tall"
  // without ever producing Infinity/Infinity.
  const aspect = h>1e-6 ? w/h : (w>1e-6 ? 1000 : 1);
  // diagLen = diagonal of the bounding box. For straight-line sub-paths,
  // this is rotation-invariant — the same physical line at 45° or 50°
  // has the same diagLen, unlike w or h individually which change with
  // angle. Used in computeImpliedScale for accurate scale estimation on
  // line-like template pieces.
  const diagLen=Math.hypot(w,h);
  return{cx,cy,w,h,aspect,nVerts:uniq.length,circ,polyArea,hasCurve:!!path.hasCurve,diagLen};
}

// sigSim takes an explicit swapAspect flag for the 90/270 rotation
// hypotheses (a shape's measured w/h literally swap under 90° rotation),
// and a hasCurve match term: a bezier-drawn circle reduced to just its
// curve endpoints is otherwise geometrically identical to a square (same
// vertex count, same circularity) -- this term tells them apart.
function sigSim(a,b,swapAspect){
  const bAspect = swapAspect ? 1/Math.max(b.aspect,0.0001) : b.aspect;
  const asp=1-Math.min(1,Math.abs(Math.log(Math.max(a.aspect,0.01)/Math.max(bAspect,0.01)))*2);
  const vrt=a.nVerts===b.nVerts?1:Math.max(0,1-Math.abs(a.nVerts-b.nVerts)*0.25);
  const crc=1-Math.min(1,Math.abs(a.circ-b.circ)*4);
  // min/max ratio is 0/0=NaN when both pieces are exactly flat in the
  // same axis (two axis-aligned lines, now reachable after the line-
  // filter fix) — treat "both zero in this axis" as a clean match for
  // that axis rather than letting NaN poison the whole score.
  const axisRatio=(d1,d2)=>(d1<=1e-6&&d2<=1e-6)?1:Math.min(d1,d2)/Math.max(d1,d2);
  const szR=axisRatio(a.w,b.w)*axisRatio(a.h,b.h);
  const curveMatch=a.hasCurve===b.hasCurve?1:0;
  return asp*0.25+vrt*0.2+crc*0.2+Math.sqrt(Math.max(0,szR))*0.15+curveMatch*0.2;
}

function rotateOffset(offX,offY,deg){
  switch(deg){
    case 0: return [offX,offY];
    case 45: {const c=Math.cos(Math.PI/4), s=Math.sin(Math.PI/4); return [c*offX-s*offY, s*offX+c*offY];}
    case 90: return [-offY,offX];
    case 135: {const c=Math.cos(3*Math.PI/4), s=Math.sin(3*Math.PI/4); return [c*offX-s*offY, s*offX+c*offY];}
    case 180: return [-offX,-offY];
    case 225: {const c=Math.cos(5*Math.PI/4), s=Math.sin(5*Math.PI/4); return [c*offX-s*offY, s*offX+c*offY];}
    case 270: return [offY,-offX];
    case 315: {const c=Math.cos(7*Math.PI/4), s=Math.sin(7*Math.PI/4); return [c*offX-s*offY, s*offX+c*offY];}
    default: {const r=deg*Math.PI/180, c=Math.cos(r), s=Math.sin(r); return [c*offX-s*offY, s*offX+c*offY];}
  }
}

// ── Ink-based clustering, replacing box-edge-based template inclusion ──
// The old approach decided "is this sub-path part of the template" purely
// by whether its center fell inside the box you dragged (plus a margin).
// That means the box's edges, not the ink's own structure, decided what
// counted — which is exactly why dragging the same symbol slightly
// tighter or looser produced wildly different sub-path counts, and why
// no two people would ever get the same result by hand. This instead
// groups the page's geometry by what's actually physically clustered
// together, and uses that grouping — not the box — to define the symbol.

// Minimum distance from a point to a line segment.
function distPointToSeg(px,py,ax,ay,bx,by){
  const dx=bx-ax, dy=by-ay;
  const lenSq=dx*dx+dy*dy;
  if(lenSq===0) return Math.hypot(px-ax,py-ay);
  let t=((px-ax)*dx+(py-ay)*dy)/lenSq;
  t=Math.max(0,Math.min(1,t));
  return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
}

// Minimum distance between two sub-paths, measured against their actual
// strokes (the segments connecting consecutive points), not just their
// corner vertices — a point near the middle of a long straight edge
// would otherwise register as far away just because it's far from that
// edge's two endpoints.
function minPathDist(a,b){
  const segsOf=p=>p.points.length<2?[[p.points[0],p.points[0]]]:p.points.slice(0,-1).map((pt,i)=>[pt,p.points[i+1]]);
  const aSegs=segsOf(a), bSegs=segsOf(b);
  let best=Infinity;
  for(const [a1,a2] of aSegs){
    for(const [b1,b2] of bSegs){
      const d=Math.min(
        distPointToSeg(a1.x,a1.y,b1.x,b1.y,b2.x,b2.y),
        distPointToSeg(a2.x,a2.y,b1.x,b1.y,b2.x,b2.y),
        distPointToSeg(b1.x,b1.y,a1.x,a1.y,a2.x,a2.y),
        distPointToSeg(b2.x,b2.y,a1.x,a1.y,a2.x,a2.y)
      );
      if(d<best) best=d;
      if(best===0) return 0;
    }
  }
  return best;
}

function median(arr){
  const s=[...arr].sort((a,b)=>a-b);
  const n=s.length;
  return n%2 ? s[(n-1)/2] : (s[n/2-1]+s[n/2])/2;
}

// Grows a cluster outward from a seed set, one nearest still-unclaimed
// sub-path at a time, stopping as soon as the next nearest thing is a
// meaningfully bigger jump than what's been typical in THIS growth so
// far — anchored to the seed's own local scale, not a single global
// distance guessed in advance. This is what lets a too-tight drag still
// recover the full symbol (growth reaches out and finds the rest), and
// what lets a too-loose drag avoid sweeping in unrelated nearby content
// (growth simply never crosses the real gap to get there). jumpMultiplier
// and floorDist were tuned against synthetic test scenarios — see the
// accompanying test notes — and verified to reliably recover a fully
// connected cluster while never leaking into clearly separate content.
// envelopeCapW/H is a hard backstop: growth refuses to expand the
// included set's own bounding envelope past these dimensions no matter
// how "typical" each individual jump looks, which guards against
// tunneling step-by-step through a long run of regularly-spaced content
// like hatching, where every single jump looks locally normal even
// though the cumulative path has wandered far from the seed.
// maxConsecutiveZero is a second, separate backstop for a failure mode
// the jump-ratio rule structurally can't see: once recent absorptions
// are all at distance ~0, the "typical recent distance" floors out at
// floorDist instead of shrinking further, so the bar for the NEXT
// absorption stays at a constant floorDist*jumpMultiplier no matter how
// many zero-distance pieces have already been swallowed — there's no
// rising signal for it to react to. Real symbols do have genuinely
// touching pieces (a square's corners, a leader line against an
// outline), so a short run of these is normal and expected, but
// font-rendered text breaks into dozens of overlapping curve fragments
// that chain through at literal 0.0px each step, which is a
// qualitatively different scale of touching than ordinary symbol
// construction. This cap stops counting once a single larger jump
// resets it, so it only fires on a long unbroken run, not on a
// legitimately-touching symbol that has a few separate touching pairs.
function growClusterFromSeed(pool,seedIndices,jumpMultiplier,floorDist,envelopeCapW,envelopeCapH,maxConsecutiveZero){
  const included=new Set(seedIndices);
  const absorbed=[];
  const cache=new Map();
  function dist(i,j){
    const key=i<j?i+'_'+j:j+'_'+i;
    if(cache.has(key)) return cache.get(key);
    const d=minPathDist(pool[i],pool[j]);
    cache.set(key,d);
    return d;
  }
  function envelopeOf(idxSet){
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const i of idxSet){
      const p=pool[i];
      const hw=p.w/2, hh=p.h/2;
      minX=Math.min(minX,p.cx-hw); maxX=Math.max(maxX,p.cx+hw);
      minY=Math.min(minY,p.cy-hh); maxY=Math.max(maxY,p.cy+hh);
    }
    return {w:maxX-minX,h:maxY-minY};
  }
  const ZERO_EPS=floorDist*0.3;
  let envelopeCapHit=false, zeroStreakHit=false, consecutiveZero=0;
  while(true){
    let bestIdx=-1,bestDist=Infinity;
    for(let i=0;i<pool.length;i++){
      if(included.has(i)) continue;
      const cand=pool[i];
      let d=Infinity;
      for(const j of included){
        const other=pool[j];
        // cheap bbox-gap pre-filter before the expensive segment check
        const gapX=Math.max(0,Math.max(cand.cx-cand.w/2,other.cx-other.w/2)-Math.min(cand.cx+cand.w/2,other.cx+other.w/2));
        const gapY=Math.max(0,Math.max(cand.cy-cand.h/2,other.cy-other.h/2)-Math.min(cand.cy+cand.h/2,other.cy+other.h/2));
        if(gapX>d||gapY>d) continue;
        const dd=dist(i,j);
        if(dd<d) d=dd;
        if(d===0) break;
      }
      if(d<bestDist){bestDist=d;bestIdx=i;}
    }
    if(bestIdx===-1) break;
    const recentTypical=absorbed.length>0?Math.max(floorDist,median(absorbed.slice(-5))):floorDist;
    if(bestDist>recentTypical*jumpMultiplier) break;
    if(bestDist<=ZERO_EPS){
      consecutiveZero++;
      if(consecutiveZero>maxConsecutiveZero){ zeroStreakHit=true; break; }
    } else {
      consecutiveZero=0;
    }
    const testEnv=envelopeOf([...included,bestIdx]);
    if(testEnv.w>envelopeCapW||testEnv.h>envelopeCapH){ envelopeCapHit=true; break; }
    included.add(bestIdx);
    absorbed.push(bestDist);
  }
  return {included:[...included],absorbed,envelopeCapHit,zeroStreakHit};
}

async function runVectorScan(){
  if(!pdfCurrentPage){showError('Upload a PDF first.');return;}
  if(!templateCanvas){showError('Select a template first (Step 1).');return;}
  if(!templateSelBox){showError('Template selection missing — re-select.');return;}

  document.getElementById('vectorBtn').disabled=true;
  findBtn.disabled=true;
  findings=[];rejectedFindings=[];findingsWrap.style.display='none';bottomBar.classList.remove('visible');
  progressWrap.style.display='block';progressBar.style.width='0%';
  hideError();

  try{
    progressLabel.textContent='Extracting vector paths from PDF...';
    progressBar.style.width='15%';
    await new Promise(r=>setTimeout(r,0));

    const paths=await extractVectorPaths(pdfCurrentPage,pdfCurrentViewport);
    progressBar.style.width='45%';
    progressLabel.textContent=`${paths.length} paths extracted — finding template shape...`;
    await new Promise(r=>setTimeout(r,0));

    if(paths.length===0){
      showError('Still 0 paths. The constructPath coord parsing may have an offset issue — report this.');
      progressWrap.style.display='none';
      document.getElementById('vectorBtn').disabled=false;
      findBtn.disabled=false;
      return;
    }

    // ── NORMALIZED BOX: Use tight bounding box around actual template ink ──
    // FIX: Big box vs small box inconsistency — normalize to the actual symbol bounds
    // instead of using the user's selection box, which varies based on how they drew it.
    // This makes results consistent: big box + small box = same matches.
    // NOTE: Use ORIGINAL templateSelBox for eraser coordinate system (before auto-crop adjustment)
    let tx1=templateSelBoxOriginal.x1, ty1=templateSelBoxOriginal.y1;
    let tx2=templateSelBoxOriginal.x2, ty2=templateSelBoxOriginal.y2;

    // Find tight bounds of actual template pixels (the cropped symbol)
    if(templateCanvas) {
      const tc=templateCanvas.getContext('2d');
      const imgData=tc.getImageData(0,0,templateCanvas.width,templateCanvas.height);
      const data=imgData.data;
      let minX=templateCanvas.width, maxX=0, minY=templateCanvas.height, maxY=0;
      for(let i=3;i<data.length;i+=4) { // check alpha channel
        if(data[i]>0) {
          const pixIdx=(i-3)/4;
          const x=pixIdx%templateCanvas.width;
          const y=Math.floor(pixIdx/templateCanvas.width);
          minX=Math.min(minX,x);maxX=Math.max(maxX,x);
          minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        }
      }
      if(minX<=maxX&&minY<=maxY) {
        // Found actual ink bounds — use those instead of user's box
        const origSelW=tx2-tx1, origSelH=ty2-ty1;
        tx1=templateSelBox.x1+minX;
        ty1=templateSelBox.y1+minY;
        tx2=templateSelBox.x1+maxX+1;
        ty2=templateSelBox.y1+maxY+1;
      }
    }

    const selW=tx2-tx1, selH=ty2-ty1;

    // A generous candidate pool — for performance only. It does NOT
    // decide what's included; the clustering below does that based on
    // the ink's own structure. It only needs to be wide enough that
    // growth never runs out of nearby candidates to consider before its
    // own envelope cap would have stopped it anyway.
    const poolPad=Math.max(selW,selH)*5;
    const candidatePool=paths.filter(p=>
      p.cx>=tx1-poolPad&&p.cx<=tx2+poolPad&&
      p.cy>=ty1-poolPad&&p.cy<=ty2+poolPad&&
      (p.w>1||p.h>1)
    );

    if(candidatePool.length===0){
      showError(`${paths.length} paths found but none in selection. Try selecting more tightly around the symbol.`);
      progressWrap.style.display='none';
      document.getElementById('vectorBtn').disabled=false;
      findBtn.disabled=false;
      return;
    }

    // The seed: candidate-pool paths whose own center actually falls
    // inside the box you dragged — no padding here, this is purely the
    // starting point for growth, not the final answer. What ultimately
    // gets included is decided by the clustering below, not by this box.
    const seedIndices=[];
    candidatePool.forEach((p,i)=>{
      if(p.cx>=tx1&&p.cx<=tx2&&p.cy>=ty1&&p.cy<=ty2) seedIndices.push(i);
    });

    if(seedIndices.length===0){
      showError(`${paths.length} paths found but none in selection. Try selecting more tightly around the symbol.`);
      progressWrap.style.display='none';
      document.getElementById('vectorBtn').disabled=false;
      findBtn.disabled=false;
      return;
    }

    const clusterFloorDist=2.5*((pdfRenderScale||7.0)/7.0);
    const clusterJumpMultiplier=5;
    const envelopeCap=Math.max(selW,selH)*4+30;
    // A run of touching pieces longer than this is treated as tunneling
    // through dense, repetitive content (font-rendered text is the
    // common real-world case) rather than legitimate symbol construction
    // — see the comment on growClusterFromSeed for why the jump-ratio
    // rule alone can't catch this.
    const maxConsecutiveZero=6;
    const growthResult=growClusterFromSeed(candidatePool,seedIndices,clusterJumpMultiplier,clusterFloorDist,envelopeCap,envelopeCap,maxConsecutiveZero);
    let templatePaths=growthResult.included.map(i=>candidatePool[i]);

    // ── Respect manual erasing from "Clean up template" ──
    // Until now this had two real gaps. First, anything erased was only
    // ever judged against a MAJORITY of that piece's points that happened
    // to land inside the captured crop — so the exact same erasing,
    // painted the same way around the symbol every time, could produce a
    // smaller erased percentage once a bigger drag box pulled in more
    // unerased far-away territory for the same stray line to hide behind.
    // A low, fixed threshold instead of a majority removes that box-size
    // dilution. Second, ink clustering can grow a piece in from entirely
    // outside the box that was dragged — somewhere never rendered into
    // this canvas, never seen, never erasable — and the old rule defaulted
    // to KEEPING anything it had zero erase information on. That's
    // backwards: if it was never visible, it shouldn't get a free pass.
    // Use originalTemplateCanvas (uncropped) for eraser check, not the auto-cropped templateCanvas
    const eraserCanvas = originalTemplateCanvas || templateCanvas; // fallback to templateCanvas if original not available
    const erasedTW=eraserCanvas.width, erasedTH=eraserCanvas.height;
    const erasedAlpha=eraserCanvas.getContext('2d').getImageData(0,0,erasedTW,erasedTH).data;
    let transparentPixelCount=0;
    for(let i=3;i<erasedAlpha.length;i+=4) if(erasedAlpha[i]===0) transparentPixelCount++;
    const isErasedAt=(px,py)=>{
      const lx=Math.round(px-tx1), ly=Math.round(py-ty1);
      if(lx<0||ly<0||lx>=erasedTW||ly>=erasedTH) return null; // outside the captured crop — never visible, never erasable
      return erasedAlpha[(ly*erasedTW+lx)*4+3]===0;
    };
    const beforeEraseFilter=templatePaths.length;
    const ERASE_EXCLUDE_FRAC=0.4; // increased to 40% — erasing a few background lines should NOT exclude the sub-path
    let pathsWithAnyErasedPoint=0, pathsExcludedByErasing=0, pathsOffCanvasExcluded=0;
    templatePaths=templatePaths.filter(p=>{
      let erased=0,known=0;
      for(const pt of p.points){
        const e=isErasedAt(pt.x,pt.y);
        if(e===null) continue;
        known++; if(e) erased++;
      }
      if(known===0){ pathsOffCanvasExcluded++; return false; } // never visible in the crop — don't smuggle it in
      const anyErased=erased>0, excluded=(erased/known)>ERASE_EXCLUDE_FRAC;
      if(anyErased) pathsWithAnyErasedPoint++;
      if(excluded) pathsExcludedByErasing++;
      return !excluded;
    });
    const erasedExcludedCount=beforeEraseFilter-templatePaths.length;
    console.log(`[QAQC diag] Eraser check: templateCanvas is ${erasedTW}×${erasedTH}px, ${transparentPixelCount}/${erasedTW*erasedTH} px (${(transparentPixelCount/(erasedTW*erasedTH)*100).toFixed(1)}%) fully transparent at scan time. ${pathsWithAnyErasedPoint}/${beforeEraseFilter} sub-paths touch an erased pixel at all; ${pathsExcludedByErasing}/${beforeEraseFilter} exceed the ${(ERASE_EXCLUDE_FRAC*100).toFixed(0)}% threshold and are excluded for that; ${pathsOffCanvasExcluded}/${beforeEraseFilter} were entirely outside the captured crop and excluded on that basis alone.`);

    if(templatePaths.length===0){
      showError(`All ${beforeEraseFilter} sub-paths in this selection were erased in the cleanup editor — nothing left to match against. Restore some of the symbol's real ink, or re-select.`);
      progressWrap.style.display='none';
      document.getElementById('vectorBtn').disabled=false;
      findBtn.disabled=false;
      return;
    }

    // ── Diagnostic: what's actually inside this selection? ──
    // A real single small symbol should be a handful of sub-paths. A count
    // in the hundreds usually means either (a) the candidate pool/seed
    // swept in more of the drawing than intended, or (b) something inside
    // the selection — commonly hatch-fill line segments or font-outlined
    // text — explodes into many tiny separate sub-paths even within a
    // genuinely tight box. Logged every run so this is diagnosable from
    // real files instead of guessed at from the result count alone.
    {
      const ws=templatePaths.map(p=>p.w), hs=templatePaths.map(p=>p.h);
      const pts=templatePaths.map(p=>p.points?p.points.length:0);
      const curveCount=templatePaths.filter(p=>p.hasCurve).length;
      const tinyCount=templatePaths.filter(p=>p.w<2||p.h<2).length;
      const avg=arr=>arr.reduce((a,b)=>a+b,0)/arr.length;
      const fmt=n=>Number.isFinite(n)?n.toFixed(2):'n/a';
      const absorbedCount=growthResult.absorbed.length;
      const absorbedStats=absorbedCount>0
        ? `min ${Math.min(...growthResult.absorbed).toFixed(1)} · median ${median(growthResult.absorbed).toFixed(1)} · max ${Math.max(...growthResult.absorbed).toFixed(1)}px`
        : 'none (seed alone, nothing grown beyond it)';
      console.log(`[QAQC diag] Template capture #${templateCaptureId} — Ink clustering: candidate pool ${candidatePool.length} paths, seed (inside drag box) ${seedIndices.length} paths → grew to ${growthResult.included.length} sub-paths (${absorbedCount} absorbed, distances: ${absorbedStats})${growthResult.envelopeCapHit?' — hit the envelope cap, growth stopped defensively':''}${growthResult.zeroStreakHit?' — hit the consecutive-touching cap (likely tunneled into dense content like text), growth stopped defensively':''}, ${erasedExcludedCount} erased in cleanup, ${beforeEraseFilter} before erase filter.`);
      console.log(`[QAQC diag]   size (w×h) in canvas px: min ${Math.min(...ws).toFixed(2)}×${Math.min(...hs).toFixed(2)} · mean ${fmt(avg(ws))}×${fmt(avg(hs))} · max ${Math.max(...ws).toFixed(2)}×${Math.max(...hs).toFixed(2)}`);
      console.log(`[QAQC diag]   vertices per sub-path: min ${Math.min(...pts)} · mean ${fmt(avg(pts))} · max ${Math.max(...pts)}`);
      console.log(`[QAQC diag]   ${tinyCount}/${templatePaths.length} sub-paths are under 2px in both dimensions (hairline/hatch-fragment territory) · ${curveCount}/${templatePaths.length} contain a bezier curve (font-outline territory)`);
    }

    // The 1.5px vertex-merge tolerance below was calibrated for 600 DPI
    // (scale 6.0). Large sheets now render at a lower scale to stay
    // pannable (see handleFile), so scale this tolerance down to match —
    // otherwise small symbols would lose fine detail (close-together
    // vertices getting merged) purely because the sheet rendered smaller.
    const renderScale=pdfRenderScale||6.0;
    const vertexDedupDist=1.5*(renderScale/6.0);

    // True symbol centroid, AREA-WEIGHTED across template sub-paths.
    // A plain average of sub-path centroids treats a thin leader-line
    // stub or a stray fragment exactly as heavily as the symbol's actual
    // outline — one small off-center piece pulls the computed center
    // toward whichever side it sits on. Weighting by each sub-path's own
    // enclosed area (near-zero for thin open lines, large for the real
    // outline/fill) makes the substantial shape dominate, which is what
    // should determine where the marker actually gets placed.
    const rawTmplSigs=templatePaths.map(p=>({p,sig:pathSig(p,vertexDedupDist)})).filter(t=>t.sig);
    let wSum=0,wCx=0,wCy=0;
    for(const {p,sig} of rawTmplSigs){
      const w=Math.max(sig.polyArea,1);
      wSum+=w; wCx+=w*p.cx; wCy+=w*p.cy;
    }
    const tmplCx=wCx/wSum, tmplCy=wCy/wSum;

    // Signature + centroid offset of each template sub-path
    const tmplSigs=rawTmplSigs.map(({p,sig})=>({
      sig,
      offX:p.cx-tmplCx,
      offY:p.cy-tmplCy
    }));

    // Overall envelope of the template's own geometry — the union
    // bounding box across all its sub-paths. Used later to check whether
    // a candidate's matched real pieces, taken TOGETHER, span a similar
    // overall shape and size to the template — not just that each piece
    // individually resembles some piece of the template. A handful of
    // unrelated nearby lines can each look locally similar to individual
    // template pieces while the group, as a whole, has a totally
    // different silhouette than the real symbol.
    let tEnvX1=Infinity,tEnvY1=Infinity,tEnvX2=-Infinity,tEnvY2=-Infinity;
    for(const p of templatePaths){
      if(p.x1<tEnvX1)tEnvX1=p.x1; if(p.y1<tEnvY1)tEnvY1=p.y1;
      if(p.x2>tEnvX2)tEnvX2=p.x2; if(p.y2>tEnvY2)tEnvY2=p.y2;
    }
    const templateEnvW=tEnvX2-tEnvX1, templateEnvH=tEnvY2-tEnvY1;

    // Full point cloud of the template's own geometry, in template-local
    // coordinates (relative to its own centroid) — every vertex from
    // every sub-path, not just the ones that end up voting. This is what
    // the shape-overlay check transforms onto each candidate location.
    const templatePoints=[];
    for(const p of templatePaths){
      for(const pt of p.points) templatePoints.push({x:pt.x-tmplCx,y:pt.y-tmplCy});
    }

    progressLabel.textContent=`Template has ${tmplSigs.length} sub-paths — scanning ${paths.length} paths...`;
    progressBar.style.width='60%';
    await new Promise(r=>setTimeout(r,0));

    // ── Precompute signatures once (was recomputed per template sub-path) ──
    const sigs=paths.map(p=>pathSig(p,vertexDedupDist));

    // The largest-area template sub-path is almost always the most
    // distinctive piece (e.g. the outline, vs several near-identical bolt
    // holes) — require it to be part of any accepted match. Without this,
    // a symbol made of repeated near-identical small features can hit the
    // vote threshold from coincidental agreement among unrelated shapes,
    // since any one of those repeats can stand in for any other.
    let anchorIdx=0, anchorArea=-1;
    tmplSigs.forEach((t,i)=>{const a=t.sig.w*t.sig.h; if(a>anchorArea){anchorArea=a;anchorIdx=i;}});

    // Weight each template sub-path by how distinctive it's likely to
    // be, instead of treating all of them as equally informative votes.
    // A symbol made of one big outline plus a swarm of tiny hairline or
    // hatch/dash fragments (common with dashed borders, hatched fills,
    // or stick-style fonts) had every one of those fragments counting
    // just as much as the outline toward the vote threshold — meaning a
    // real second instance could only be recognized by re-matching
    // nearly EVERY tiny fragment too, which is exactly the kind of fine
    // detail print/scan noise loses first. Floored so nothing drops to
    // zero influence, capped so one big piece can't single-handedly
    // carry the whole vote on its own.
    function subpathWeight(sig){ return Math.min(5,Math.max(0.3,Math.max(sig.w,sig.h)/8)); }
    const subpathWeights=tmplSigs.map(t=>subpathWeight(t.sig));
    const totalSubpathWeight=subpathWeights.reduce((a,b)=>a+b,0);
    // A sub-path under ~4px in its longer dimension is the hairline/dash/
    // hatch-fragment territory the diagnostic above calls out — its
    // measured size is small enough that ordinary print/scan noise
    // becomes a large RELATIVE error in its implied scale, even for a
    // genuinely correct match. Used below to keep that noise out of the
    // scale-consistency check when there are enough bigger pieces to
    // judge consistency from instead.
    const substantialIdxs=tmplSigs.map((t,i)=>i).filter(i=>Math.max(tmplSigs[i].sig.w,tmplSigs[i].sig.h)>=4);

    // Separate weighting, used only for WHERE the marker lands (not for
    // deciding whether something counts as a match at all — that's
    // subpathWeight above). A straight line has exactly zero enclosed
    // area regardless of how long it is, while a real closed shape (the
    // outline, a filled hole) has substantial area — so this naturally
    // lets the actual outline govern the estimated position almost
    // entirely, instead of an equal-weight average across however many
    // generic line fragments happened to vote this time, which is what
    // was pulling markers off-center whenever a different, asymmetric
    // subset of the template's fragments voted from one run to the next.
    const positionWeights=tmplSigs.map(t=>Math.max(t.sig.polyArea,1));

    // Sensitivity slider now actually does something in vector mode (it
    // previously only affected the pixel engine). Anchored at the
    // slider's own default (35) to reproduce the exact fixed values this
    // used to have (THRESH=0.58, vote fraction=0.45), so this change alone
    // doesn't shift results for anyone who hasn't touched the slider —
    // moving it right tightens both the per-sub-path similarity floor and
    // the fraction of sub-paths required to agree; moving it left loosens
    // both.
    const sliderVal=parseInt(document.getElementById('threshold')?.value||'35');
    const THRESH=Math.min(0.90,Math.max(0.30, 0.58+(sliderVal-35)*0.00367));
    // Recalibrated against confirmed ground truth from a real scan: at the
    // old default (voteFrac=0.45), two confirmed false positives both
    // landed at exactly 12/25 votes — the bare minimum the old threshold
    // allowed — while every confirmed-real match had 14+ votes with real
    // margin. 0.56 puts the floor at 14/25, sitting exactly in that gap.
    const voteFrac=Math.min(0.80,Math.max(0.30, 0.56+(sliderVal-35)*0.0035));
    // Tight-ish tolerance for "do these sub-path votes refer to the same
    // instance" — sub-path offsets are coordinate math, not noisy
    // measurement, but real drawings still have some jitter between
    // nominally-identical instances (rendering/export quirks, slightly
    // different stroke handling), so this isn't as tight as pure math
    // would allow.
    const AGREE_DIST=Math.max(selW,selH)*0.3;
    // Looser tolerance only for merging duplicate final detections (e.g.
    // across the 4 rotation hypotheses below).
    const DEDUP_DIST=Math.max(selW,selH)*0.9;
    // Tiny epsilon guards against floating-point overshoot — e.g.
    // 25*0.56 evaluates to 14.000000000000002 in JS, which Math.ceil would
    // otherwise round up to 15 instead of the intended 14.
    // The acceptance gate below is measured against total
    // distinctiveness-weight rather than a flat sub-path count (see
    // subpathWeight above), so a template that's mostly tiny hairline/
    // dash/hatch fragments doesn't need nearly all of them to
    // individually re-align before its few genuinely distinctive pieces
    // (the outline, the anchor) are allowed to count for what they're
    // worth. A minimal floor of 3 distinct sub-paths is still required
    // regardless of weight, so one or two large pieces alone can't fully
    // satisfy this on their own.
    const VOTE_WEIGHT_THRESH=totalSubpathWeight*voteFrac;

    // Normalized -1..+1 dial built from the same Sensitivity slider,
    // matching its asymmetric range (15 units from default down to 20,
    // 60 units from default up to 95): +1 at the loosest setting, 0 at
    // the slider's own default (35, reproducing the original fixed
    // calibration below exactly), -1 at the strictest. THRESH and
    // voteFrac above already respond to the slider — this lets the three
    // full-shape gates below respond to it too, since previously a real
    // match that only narrowly failed one of THOSE (most often the
    // overlay-coverage check) couldn't be recovered no matter how far
    // the slider was pushed toward "finds more." Safe to connect now
    // that the vote-selection step prefers cluster-consistent votes over
    // raw highest score — that's what made a flood of loosely-admitted
    // candidates actually risky before.
    const loosen = sliderVal<35 ? (35-sliderVal)/15 : -(sliderVal-35)/60;

    // How much the implied scale is allowed to vary across a single
    // cluster's voting sub-paths before it's treated as a coincidental
    // pile of unrelated fragments rather than one real symbol. 2.2 means
    // the "biggest-implied-scale" piece can be at most 2.2x the
    // "smallest-implied-scale" piece at the slider's default — generous
    // enough for real print/render noise, strict enough to catch
    // fragments at genuinely different real-world sizes. Ranges from
    // 1.8 (strictest) to 3.2 (loosest) as the slider moves.
    const MAX_SCALE_SPREAD=2.2+(loosen>=0?loosen*1.0:loosen*0.4);
    // How far the matched cluster's overall envelope (combined bounding
    // box of every voting piece) can differ from the template's own
    // envelope, predicted at this cluster's average implied scale. 1.6
    // at the slider's default means the real envelope can be at most
    // 1.6x too big or too small in either dimension before it's treated
    // as the wrong overall shape. Ranges from 1.35 to 2.4 with the
    // slider.
    const MAX_ENVELOPE_RATIO=1.6+(loosen>=0?loosen*0.8:loosen*0.25);
    // Fraction of the template's own points that must have real geometry
    // sitting within tolerance at a candidate's estimated position/scale/
    // rotation. This is the actual full-shape-overlay test — the most
    // direct defense against "found something with enough votes, but it
    // doesn't really look like the template." It used to loosen all the
    // way down to 0.60 alongside the other gates whenever sensitivity
    // was pushed low for recall, which let through exactly the kind of
    // false positive this check exists to catch — busy/cluttered areas
    // can rack up enough coincidental coverage to clear a low bar even
    // though they don't actually look like the symbol. Keeping this
    // floor close to the original calibrated value (and safely above
    // the 63-75% range where confirmed-wrong matches sat in a prior
    // ground-truth test) means pushing sensitivity low for recall no
    // longer comes at the cost of this specific safety net.
    // Coefficient increased from 0.07 to 0.125 so the slider actually
    // reaches useful sensitivity levels for simple (line-based) templates:
    // at slider=5 this now drops to 0.50 instead of 0.61, which catches
    // real matches that sit at ~55-60% coverage. The MIN_EXPLAINED_FRAC
    // check below (rejecting clusters with <25% of ink explained by the
    // template) still protects against false positives whose low coverage
    // comes from shape mismatch rather than slight positional error.
    const MIN_OVERLAY_COVERAGE=Math.max(0.75, 0.65+(loosen>=0?-loosen*0.125:-loosen*0.08)); // raised floor to filter false positives
    // The reverse half of the shape-overlay test: how much of the real
    // ink specifically inside the template's own footprint has to be
    // explained by the template's shape, rather than being other
    // unrelated stuff that happens to be densely co-located there. Kept
    // deliberately lenient — tested against a busy-but-genuinely-correct
    // case (a real symbol with other nearby elements passing close by)
    // explaining ~87% of nearby ink, versus a genuine false positive in
    // coincidental clutter explaining only ~15% — so a floor around 0.35
    // to 0.55 catches the latter with a wide safety margin against ever
    // rejecting the former.
    const MIN_EXPLAINED_FRAC=Math.max(0.55, 0.40-loosen*0.10); // raised floor to require 55% minimum explanation
    // Minimum individual match quality required from the anchor piece
    // alone (the template's biggest, most distinctive sub-path — almost
    // always its outline). Verified against real hand-checked results:
    // confirmed true matches sat at 94-100% anchor score, confirmed
    // false positives sat at 59-67%, with a clean gap and nothing in
    // between. Kept mostly fixed rather than tracking the recall slider
    // closely, since this is a shape-identity check, not a "how much
    // evidence is there" check.
    const MIN_ANCHOR_SCORE=Math.max(0.90, 0.60-loosen*0.10); // raised to 90% to require true match quality (94-100%)
    // What fraction of a cluster's (substantial) voting pieces need to
    // agree on roughly the same scale, anchored to their MEDIAN rather
    // than requiring literally every single one to agree with every
    // other. A plain min/max-across-everyone check has zero tolerance
    // for even one noisy or hijacked vote — one bad piece in an
    // otherwise perfectly consistent cluster fails the whole match.
    // 0.7 at the slider's default tolerates a single outlier in a
    // typical-sized cluster while still rejecting a genuinely scattered,
    // coincidental pile of unrelated fragments. Ranges from 0.40
    // (loosest) to 0.85 (strictest) with the slider.
    const MIN_SCALE_AGREE_FRAC=Math.max(0.25, 0.65-loosen*0.15); // lowered for erased symbols
    const cellSize=AGREE_DIST;
    const cellKeyFor=(cx,cy)=>Math.round(cx/cellSize)+','+Math.round(cy/cellSize);

    // A purely horizontal or vertical template/candidate sub-path has an
    // EXACT zero in one dimension — now reachable here since the AND→OR
    // fix above lets axis-aligned lines into `paths`/`templatePaths` for
    // the first time. The two helpers below keep the per-axis size gate
    // and the implied-scale estimate sane in that case instead of
    // wrongly rejecting on float residue or producing NaN.
    function dimOK(pathDim,effDim){
      if(effDim<=1e-6) return pathDim<=0.75; // axis-aligned: absolute tolerance in canvas px, not a ratio
      return pathDim>=effDim*0.3&&pathDim<=effDim*3.5;
    }
    function computeImpliedScale(pathW,pathH,effW,effH,pathDiag,effDiag,lineLike){
      // For line-like sub-paths (open paths, few vertices, tiny polyArea),
      // use diagLen instead of w/h separately. A line's bounding-box
      // diagonal is rotation-invariant — the same physical line at 45° or
      // 50° has the same diagLen but very different w and h, so using
      // sqrt(pathW/effW * pathH/effH) produces an angle-dependent, noisy
      // scale estimate that skews the overlay transform and drops real
      // triangle/line-based matches below the coverage threshold.
      if(lineLike&&effDiag>1e-6) return pathDiag/effDiag;
      const wOK=effW>1e-6, hOK=effH>1e-6;
      if(wOK&&hOK) return Math.sqrt((pathW/effW)*(pathH/effH));
      if(wOK) return pathW/effW;
      if(hOK) return pathH/effH;
      return 1;
    }

    // Diagnostics so a "no matches" result is debuggable instead of a dead
    // end: how many paths each template sub-path matched anywhere in the
    // drawing (regardless of clustering), and the single best near-miss
    // cluster even if it didn't clear the vote threshold or lack the anchor.
    const subpathHitCounts=new Array(tmplSigs.length).fill(0);
    let bestNearMiss=null;
    let scaleRejectCount=0; // clusters that had enough votes + the anchor, but failed the scale-consistency check below
    let bestScaleNearMiss=null; // the scale-rejected cluster that came closest to passing, for diagnostics
    let envelopeRejectCount=0; // clusters that passed scale-consistency but failed the overall-shape envelope check below
    let overlayRejectCount=0; // clusters that passed everything above but failed the full shape-overlay check
    let explainedRejectCount=0; // clusters that passed coverage but had too much unexplained extra ink in the template's own footprint
    let anchorRejectCount=0; // clusters whose single biggest/most-distinctive piece didn't individually match well enough, regardless of how the rest voted

    // Structural symbols (hold-downs, etc.) commonly get inserted at
    // different rotations depending on wall direction, so each candidate
    // location is tested at 0/90/180/270°. Each rotation runs as a FULLY
    // INDEPENDENT vote pass — votes from "outline matched assuming 0°"
    // must never corroborate "bolt matched assuming 90°", since those are
    // contradictory hypotheses about the same instance.
    function runForRotation(deg){
      const swap=(deg===90||deg===270);
      const grid=new Map(); // "gx,gy" -> Map(subpathIdx -> {cx,cy,score})
      function castVote(cx,cy,subpathIdx,score,rawX,rawY,impliedScale,x1,y1,x2,y2){
        const key=cellKeyFor(cx,cy);
        let cell=grid.get(key);
        if(!cell){cell=new Map();grid.set(key,cell);}
        const existing=cell.get(subpathIdx);
        if(!existing||score>existing.score) cell.set(subpathIdx,{cx,cy,score,rawX,rawY,impliedScale,x1,y1,x2,y2});
      }
      for(let ti=0;ti<tmplSigs.length;ti++){
        const {sig:tSig,offX,offY}=tmplSigs[ti];
        const effW=swap?tSig.h:tSig.w, effH=swap?tSig.w:tSig.h;
        const [rOffX,rOffY]=rotateOffset(offX,offY,deg);
        for(let pi=0;pi<paths.length;pi++){
          const path=paths[pi];
          if(!dimOK(path.w,effW)) continue;
          if(!dimOK(path.h,effH)) continue;
          const sig=sigs[pi];
          if(!sig) continue;
          const score=sigSim({...tSig,w:effW,h:effH},sig,swap);
          if(score>=THRESH){
            // How much bigger/smaller this real piece is than its
            // corresponding template piece. A real instance is one rigid
            // printed block — every sub-path that belongs to it should
            // imply close to the SAME scale.
            // For line-like sub-paths, use diagLen for rotation-invariant
            // scale estimation (see computeImpliedScale comment).
            const effDiag=Math.hypot(effW,effH);
            const lineLike=tSig.polyArea<10&&tSig.nVerts<=3&&sig.polyArea<10&&sig.nVerts<=3;
            const impliedScale=computeImpliedScale(path.w,path.h,effW,effH,sig.diagLen,effDiag,lineLike);
            castVote(path.cx-rOffX,path.cy-rOffY,ti,score,path.cx,path.cy,impliedScale,path.x1,path.y1,path.x2,path.y2);
            subpathHitCounts[ti]++;
          }
        }
      }

      // Merge cells via neighbor lookup, not all-pairs: since cellSize ==
      // AGREE_DIST, two vote-centroids within AGREE_DIST can only ever land
      // in the same or an adjacent (3x3) grid cell. Adjacency narrows the
      // search space to O(occupied cells) instead of O(cells^2); the actual
      // merge decision still requires the precise centroid distance check
      // (adjacency alone is NOT sufficient — two occupied neighbor cells
      // can still have centroids further apart than AGREE_DIST).
      const cellKeys=[...grid.keys()];
      const cellCentroid=k=>{
        const m=grid.get(k); let sx=0,sy=0,n=0;
        for(const v of m.values()){sx+=v.cx;sy+=v.cy;n++;}
        return {x:sx/n,y:sy/n};
      };
      const centroids=new Map(cellKeys.map(k=>[k,cellCentroid(k)]));
      const parent=new Map(cellKeys.map(k=>[k,k]));
      function find(k){while(parent.get(k)!==k){k=parent.get(k);}return k;}
      function union(a,b){const ra=find(a),rb=find(b); if(ra!==rb) parent.set(ra,rb);}
      for(const k of cellKeys){
        const [gx,gy]=k.split(',').map(Number);
        const c1=centroids.get(k);
        for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
          if(dx===0&&dy===0) continue;
          const nk=(gx+dx)+','+(gy+dy);
          if(!grid.has(nk)) continue;
          const c2=centroids.get(nk);
          if(Math.hypot(c1.x-c2.x,c1.y-c2.y)<AGREE_DIST) union(k,nk);
        }
      }
      const groups=new Map();
      for(const k of cellKeys){const r=find(k); if(!groups.has(r))groups.set(r,[]); groups.get(r).push(k);}

      const out=[];
      for(const memberKeys of groups.values()){
        // Gather EVERY candidate vote for each subpath role across this
        // group's member cells. A single cell only ever keeps its own
        // best-scoring vote per role (that part is unchanged) — but two
        // DIFFERENT cells in the same connected group can each have
        // their own candidate for the SAME role, and that's genuine
        // competition between two different things on the sheet (one
        // real, one a coincidental lookalike elsewhere), not noise
        // within a single detection.
        const bySubIdx=new Map();
        for(const k of memberKeys) for(const [subIdx,v] of grid.get(k)){
          if(!bySubIdx.has(subIdx)) bySubIdx.set(subIdx,[]);
          bySubIdx.get(subIdx).push(v);
        }

        // Reference centroid built the old way (best score per role) —
        // used only to resolve the rarer contested roles below by
        // agreement with the rest of the cluster. Roles with just one
        // candidate (the overwhelming majority in practice) anchor this
        // estimate, so a single contested role can't skew it much.
        let nsx=0,nsy=0,nn=0;
        for(const votes of bySubIdx.values()){
          let best=votes[0];
          for(const v of votes) if(v.score>best.score) best=v;
          nsx+=best.cx; nsy+=best.cy; nn++;
        }
        const naiveCx=nsx/nn, naiveCy=nsy/nn;

        // For a role with more than one real candidate, prefer whichever
        // is closer to that reference point — i.e. agrees with where
        // the rest of the cluster says the symbol actually is — unless
        // a competitor's score is decisively higher (a real, large
        // margin of 0.07+, not the few-percent edge a coincidental
        // lookalike can win by chance). This is what stops one unrelated
        // nearby piece that happens to score marginally higher from
        // silently hijacking a role: a hijacked vote corrupts the whole
        // cluster's averaged position/scale estimate, which could then
        // fail the scale-spread or overlay checks below and reject an
        // otherwise-correct match over a single contested role.
        const merged=new Map();
        for(const [subIdx,votes] of bySubIdx){
          if(votes.length===1){ merged.set(subIdx,votes[0]); continue; }
          const sorted=[...votes].sort((p,q)=>
            Math.hypot(p.cx-naiveCx,p.cy-naiveCy)-Math.hypot(q.cx-naiveCx,q.cy-naiveCy)
          );
          let chosen=sorted[0];
          for(let vi=1;vi<sorted.length;vi++){
            if(sorted[vi].score>chosen.score+0.07) chosen=sorted[vi];
          }
          merged.set(subIdx,chosen);
        }
        let votedWeight=0; for(const subIdx of merged.keys()) votedWeight+=subpathWeights[subIdx];
        if(!bestNearMiss||votedWeight>bestNearMiss.weight){
          bestNearMiss={votes:merged.size,weight:votedWeight,hasAnchor:merged.has(anchorIdx),deg,subIdxs:[...merged.keys()]};
        }
        if(merged.size<3||votedWeight<VOTE_WEIGHT_THRESH) continue;
        const anchorVote=merged.get(anchorIdx);
        if(!anchorVote) continue;
        // The anchor is the template's single biggest, most distinctive
        // piece — usually the outline itself, not a number or hairline
        // fragment. A candidate can rack up a deceptively high overall
        // score and even decent overlay coverage from a pile of smaller,
        // less distinctive pieces all loosely agreeing, while the one
        // piece that actually defines the symbol's shape doesn't really
        // match at all. Confirmed against real, hand-verified results:
        // every true match had an anchor score of 94-100%, every
        // confirmed false positive sat at 59-67% — a clean gap with
        // nothing in between — so this catches exactly that signature
        // before any of the more expensive checks below even run.
        if(anchorVote.score<MIN_ANCHOR_SCORE){
          anchorRejectCount++;
          continue;
        }

        // Use the anchor's vote position as the primary center estimate,
        // with other votes as weighted corrections. A simple unweighted
        // mean is corrupted when a false vote from a generic sub-path
        // (lines match dozens of things on the sheet) happens to land
        // within AGREE_DIST of the true cluster — that one bad vote can
        // drag the mean enough that the overlay transform points at the
        // wrong location, producing near-zero coverage for a genuinely
        // correct match. The anchor is the largest, most distinctive
        // sub-path and least likely to produce a false match, so its
        // vote position is the most trustworthy single estimate.
        // Other votes contribute proportional to their subpathWeight.
        let wsx=0,wsy=0,wn=0,ss=0,n=0;
        for(const [si,v] of merged.entries()){
          const w=subpathWeights[si];
          wsx+=w*v.cx; wsy+=w*v.cy; wn+=w;
          ss+=v.score; n++;
        }
        const cx=wsx/wn, cy=wsy/wn;

        // Shape-consistency check: every voting sub-path implies a scale
        // (real matched size ÷ template piece size). For one real,
        // rigid symbol those should all cluster tightly. A coincidental
        // pile of unrelated nearby fragments — hatching, other small
        // symbols, dimension marks — has no reason to share a scale at
        // all, and can rack up MORE raw votes than a real instance
        // simply because a cluttered area has more stuff to coincide
        // with. This is the layer that catches that case.
        // Tiny pieces' implied scale is inherently much noisier than
        // big pieces' — the same small absolute measurement difference
        // (print/scan noise, anti-aliasing) is a huge RELATIVE scale
        // error on a 1px piece and barely moves the ratio on a 40px
        // piece. Judge consistency from the cluster's substantial voting
        // pieces when there are enough of them to judge from, instead of
        // letting a swarm of noisy hairline fragments — which is most of
        // what a real instance's OWN fragments are — dominate this check
        // and reject an otherwise-correct match.
        const votingSubstantial=[...merged.keys()].filter(si=>substantialIdxs.includes(si));
        const scaleSource=votingSubstantial.length>=3
          ? votingSubstantial.map(si=>merged.get(si))
          : [...merged.values()];
        const allScales=scaleSource.map(v=>v.impliedScale);
        // Median-anchored, majority-based instead of a plain min/max
        // ratio across every single voting piece — that older version
        // had zero tolerance for even one noisy or hijacked vote: one
        // bad piece in an otherwise perfectly consistent cluster failed
        // the whole match. This requires most (not all) of the
        // substantial pieces to agree with the cluster's own median
        // scale, so a single outlier can no longer single-handedly
        // sink an otherwise-correct match.
        const sortedScales=[...allScales].sort((a,b)=>a-b);
        const medScale=sortedScales.length%2
          ? sortedScales[(sortedScales.length-1)/2]
          : (sortedScales[sortedScales.length/2-1]+sortedScales[sortedScales.length/2])/2;
        const inBandScales=allScales.filter(s=>s<=medScale*MAX_SCALE_SPREAD&&s>=medScale/MAX_SCALE_SPREAD);
        const agreeFrac=inBandScales.length/allScales.length;
        if(agreeFrac<MIN_SCALE_AGREE_FRAC){
          scaleRejectCount++;
          if(!bestScaleNearMiss||agreeFrac>bestScaleNearMiss.agreeFrac){
            bestScaleNearMiss={agreeFrac,needed:MIN_SCALE_AGREE_FRAC,scales:allScales,deg};
          }
          continue;
        }
        // Use only the in-band scales for the actual estimate downstream
        // (envelope prediction, overlay transform) — an outlier vote
        // that was tolerated above still shouldn't be allowed to drag
        // the cluster's own scale estimate off-center.
        const scales=inBandScales;
        const avgScale=scales.reduce((a,b)=>a+b,0)/scales.length;

        // Overall-shape check: union the real bounding boxes of every
        // voting sub-path into one envelope — "everything that got
        // matched, taken together, occupies this much space, in this
        // shape." Scale the template's OWN envelope by this cluster's
        // average implied scale and compare. A coincidental pile of
        // fragments can each look locally similar to individual template
        // pieces while being spread out (or bunched up) very differently
        // overall than the real symbol actually is — this is the check
        // that catches that, independent of how well any individual
        // piece scored.
        let ux1=Infinity,uy1=Infinity,ux2=-Infinity,uy2=-Infinity;
        for(const v of merged.values()){
          if(v.x1<ux1)ux1=v.x1; if(v.y1<uy1)uy1=v.y1;
          if(v.x2>ux2)ux2=v.x2; if(v.y2>uy2)uy2=v.y2;
        }
        const envW=ux2-ux1, envH=uy2-uy1;
        const predictedW=(swap?templateEnvH:templateEnvW)*avgScale;
        const predictedH=(swap?templateEnvW:templateEnvH)*avgScale;
        const envRatioW=envW/predictedW, envRatioH=envH/predictedH;
        if(envRatioW<1/MAX_ENVELOPE_RATIO||envRatioW>MAX_ENVELOPE_RATIO||
           envRatioH<1/MAX_ENVELOPE_RATIO||envRatioH>MAX_ENVELOPE_RATIO){
          envelopeRejectCount++;
          continue;
        }

        // Full shape-overlay check — the direct version of "does this
        // actually look like my example." Everything above only looks at
        // aggregate stats of the PIECES that already happened to vote.
        // This instead takes the template's ENTIRE point cloud — every
        // vertex from every sub-path, voted or not — transforms it onto
        // this candidate's estimated position/scale/rotation, and checks
        // how much of it actually has real ink sitting where it should.
        // A coincidental cluster can satisfy every check above while
        // still being, point for point, a different shape; this is the
        // layer that catches that directly instead of inferring it.
        const searchRadius=Math.max(templateEnvW,templateEnvH)*avgScale*0.75;
        const nearbyPts=[];
        for(const p of paths){
          const dx=p.cx-cx, dy=p.cy-cy;
          const reach=searchRadius+Math.max(p.w,p.h);
          if(dx*dx+dy*dy<=reach*reach){
            for(const pt of p.points) nearbyPts.push(pt);
          }
        }
        const overlayTol=Math.max(vertexDedupDist*2, Math.max(templateEnvW,templateEnvH)*avgScale*0.10);
        const transformedTemplatePts=templatePoints.map(tp=>{
          const [rx,ry]=rotateOffset(tp.x,tp.y,deg);
          return {x:rx*avgScale+cx, y:ry*avgScale+cy};
        });
        let coveredCount=0;
        for(const ttp of transformedTemplatePts){
          let minDistSq=Infinity;
          for(const np of nearbyPts){
            const dd=(np.x-ttp.x)*(np.x-ttp.x)+(np.y-ttp.y)*(np.y-ttp.y);
            if(dd<minDistSq)minDistSq=dd;
            if(minDistSq<=overlayTol*overlayTol) break; // already close enough, stop early
          }
          if(minDistSq<=overlayTol*overlayTol) coveredCount++;
        }
        const coverage=coveredCount/transformedTemplatePts.length;
        if(coverage<MIN_OVERLAY_COVERAGE){
          overlayRejectCount++;
          continue;
        }

        // Reverse/symmetric half of the same test: of the real ink
        // sitting specifically within the template's OWN footprint (a
        // tighter radius than the generous one searched above, which is
        // deliberately wide for position-finding), how much of it is
        // actually explained by the template's shape? The check above
        // only ever asks "is there ink near every template point" — it
        // has no way to notice a candidate that ALSO has a pile of other,
        // unrelated ink densely packed into that same footprint, which
        // is exactly what a coincidental false positive sitting in a
        // busy/cluttered area looks like: enough real template-shaped
        // ink nearby to pass the check above, plus a lot of extra stuff
        // the template doesn't predict at all. A clean instance, or even
        // a real instance with OTHER stuff passing nearby but not densely
        // overlapping its own footprint, should still explain most of
        // what's actually inside that footprint.
        const footprintRadius=Math.max(templateEnvW,templateEnvH)*avgScale*0.55;
        let excludedAsErasedCount=0;
        const nearbyTight=nearbyPts.filter(np=>{
          const dx=np.x-cx, dy=np.y-cy;
          if(dx*dx+dy*dy>footprintRadius*footprintRadius) return false;
          // Ink that maps back onto a part of the template you erased —
          // or that was never inside the captured crop in the first
          // place — shouldn't count against this check either way. You
          // erase precisely because you expect that area to vary (an
          // elevation number is the clear case): without this, every
          // genuine match gets penalized for having SOME real number
          // drawn exactly where the template was told to stop caring.
          const invDeg=(360-deg)%360;
          const sx=(np.x-cx)/avgScale, sy=(np.y-cy)/avgScale;
          const [tlx,tly]=rotateOffset(sx,sy,invDeg);
          const erasedState=isErasedAt(tlx+tmplCx,tly+tmplCy);
          if(erasedState===true||erasedState===null){ excludedAsErasedCount++; return false; }
          return true;
        });
        let explainedCount=0;
        for(const np of nearbyTight){
          let minDistSq=Infinity;
          for(const ttp of transformedTemplatePts){
            const dd=(np.x-ttp.x)*(np.x-ttp.x)+(np.y-ttp.y)*(np.y-ttp.y);
            if(dd<minDistSq)minDistSq=dd;
            if(minDistSq<=overlayTol*overlayTol) break;
          }
          if(minDistSq<=overlayTol*overlayTol) explainedCount++;
        }
        const explainedFrac=nearbyTight.length===0?1:explainedCount/nearbyTight.length;
        if(explainedFrac<MIN_EXPLAINED_FRAC){
          explainedRejectCount++;
          continue;
        }

        // A separate, area-weighted position for DISPLAY only — computed
        // here, after every pass/fail decision above is already final,
        // so improving where the marker gets drawn can never change
        // which clusters get accepted in the first place. (An earlier
        // version of this used the weighted position for cx/cy directly,
        // which fed into the overlay-coverage check above and ended up
        // rejecting matches that used to pass — this avoids that.)
        let dsx=0,dsy=0,dsw=0;
        for(const [subIdx,v] of merged){
          const w=positionWeights[subIdx];
          dsx+=w*v.cx; dsy+=w*v.cy; dsw+=w;
        }
        const displayCx=dsx/dsw, displayCy=dsy/dsw;
        out.push({cx:displayCx,cy:displayCy,score:ss/n,votes:merged.size,votedWeight,anchorRawX:anchorVote.rawX,anchorRawY:anchorVote.rawY,anchorScore:anchorVote.score,overlayCoverage:coverage,explainedFrac,excludedAsErasedCount,rotDeg:deg});
      }
      return out;
    }

    let candidates=[];
    for(const deg of [0,90,180,270]){
      candidates=candidates.concat(runForRotation(deg));
      await new Promise(r=>setTimeout(r,0)); // yield so progress UI stays responsive
    }

    if(candidates.length===0){
      console.log('[QAQC diag] Per-sub-path hit counts across the whole drawing (all 4 rotations summed):',
        subpathHitCounts.map((c,i)=>`#${i}${i===anchorIdx?'(anchor/outline)':''}: ${c}`).join('  '));
      console.log('[QAQC diag] Best near-miss cluster:', bestNearMiss
        ? `${bestNearMiss.votes}/${tmplSigs.length} sub-paths agreed, weight ${bestNearMiss.weight.toFixed(2)}/${totalSubpathWeight.toFixed(2)} (needed ${VOTE_WEIGHT_THRESH.toFixed(2)}), anchor included: ${bestNearMiss.hasAnchor}, best at rotation ${bestNearMiss.deg}°, sub-path indices: [${bestNearMiss.subIdxs.join(',')}]`
        : 'no cluster formed at all — sub-paths never agreed on a position even loosely.');
      const hint=bestNearMiss
        ? `Best partial match: ${bestNearMiss.votes}/${tmplSigs.length} sub-paths agreed, weight ${bestNearMiss.weight.toFixed(2)}/${totalSubpathWeight.toFixed(2)} (needed ${VOTE_WEIGHT_THRESH.toFixed(2)}). Open the browser console for a full breakdown.`
        : 'No sub-paths agreed on any position at all. Open the browser console for a full breakdown.';
      showError(`No matching sub-paths found. ${hint}`);
      progressWrap.style.display='none';
      document.getElementById('vectorBtn').disabled=false;
      findBtn.disabled=false;
      return;
    }

    // Merge results across the 4 independent rotation hypotheses.
    // A near-symmetric template (a diamond is close to 180°-symmetric) can
    // legitimately pass the vote threshold under TWO different rotation
    // hypotheses for the exact same real instance — each hypothesis
    // subtracts a different offset, so they compute two different implied
    // centers for what is actually one symbol, and those can land further
    // apart than DEDUP_DIST. The anchor's raw measured position doesn't
    // depend on which rotation hypothesis produced the vote, so two
    // candidates sharing (near enough) the same anchor position are
    // provably the same real piece of geometry regardless of how far
    // apart their computed centers ended up — merge on EITHER signal.
    const ANCHOR_IDENTITY_DIST=Math.max(2,vertexDedupDist);
    candidates.sort((a,b)=>b.votes-a.votes||b.score-a.score);
    const deduped=[];
    for(const c of candidates){
      const near=deduped.find(d=>
        Math.hypot(d.cx-c.cx,d.cy-c.cy)<DEDUP_DIST ||
        Math.hypot(d.anchorRawX-c.anchorRawX,d.anchorRawY-c.anchorRawY)<ANCHOR_IDENTITY_DIST
      );
      if(!near) deduped.push(c);
    }

    const filtered=searchRegion
      ? deduped.filter(c=>c.cx>=searchRegion.x1&&c.cx<=searchRegion.x2&&c.cy>=searchRegion.y1&&c.cy<=searchRegion.y2)
      : deduped;

    const query=document.getElementById('queryInput').value.trim()||'Match';
    findings=filtered.map((c,i)=>({
      x:c.cx, y:c.cy, score:c.score,
      label:`${query} ${i+1}`, scale:1, rotDeg:c.rotDeg,
      detail:`${c.votes}/${tmplSigs.length} sub-paths matched`,
      votes:c.votes, anchorScore:c.anchorScore, overlayCoverage:c.overlayCoverage, explainedFrac:c.explainedFrac, excludedAsErasedCount:c.excludedAsErasedCount
    }));
    // Display order is by accuracy (score), separate from the internal
    // dedup pass above, which deliberately prefers vote-count over raw
    // score when deciding which of several near-duplicate candidates to
    // keep — that's a different, more robustness-oriented question than
    // "what should the user see first."
    findings.sort((a,b)=>b.score-a.score);
    findings.forEach((f,i)=>{ f.label=`${query} ${i+1}`; });

    console.log(`[QAQC diag] ${findings.length} matches, ranked by score (sliderVal=${sliderVal} → THRESH=${THRESH.toFixed(3)}, voteFrac=${voteFrac.toFixed(3)}). ${anchorRejectCount} rejected for a weak anchor-piece match (min ${Math.round(MIN_ANCHOR_SCORE*100)}% required from the outline piece alone), ${scaleRejectCount} cluster(s) rejected for inconsistent scale (need ${Math.round(MIN_SCALE_AGREE_FRAC*100)}% of substantial pieces within ${MAX_SCALE_SPREAD}x of the cluster's own median scale), ${envelopeRejectCount} rejected for wrong overall shape/size envelope (max ${MAX_ENVELOPE_RATIO}x off), ${overlayRejectCount} rejected for failing the full shape-overlay check (min ${Math.round(MIN_OVERLAY_COVERAGE*100)}% coverage required), ${explainedRejectCount} rejected for too much unexplained extra ink in the template's own footprint (min ${Math.round(MIN_EXPLAINED_FRAC*100)}% explained required), before reaching this list:`);
    if(bestScaleNearMiss){
      console.log(`[QAQC diag] Closest scale-rejected near-miss: ${Math.round(bestScaleNearMiss.agreeFrac*100)}% of pieces agreed (needed ${Math.round(bestScaleNearMiss.needed*100)}%) at rotation ${bestScaleNearMiss.deg}°. Implied scales: [${bestScaleNearMiss.scales.map(s=>s.toFixed(2)).join(', ')}]`);
    }
    findings.forEach((f,i)=>{
      console.log(`[QAQC diag]   #${i+1}: score=${Math.round(f.score*100)}% anchorScore=${Math.round((f.anchorScore||0)*100)}% overlayCoverage=${Math.round((f.overlayCoverage||0)*100)}% explainedFrac=${Math.round((f.explainedFrac||0)*100)}% (${f.excludedAsErasedCount||0} ink pts excused as erased/uncaptured template area) ${f.detail} pos=(${Math.round(f.x)},${Math.round(f.y)})`);
    });

    // Visual appearance check — re-ranks by how much each candidate
    // actually looks like the template at pixel level. Runs fast because
    // we only extract small patches at the N candidate locations, not the
    // full drawing. False positives that are random linework drop to the
    // bottom; real matches that look like the template rise to the top.
    progressLabel.textContent = 'Visual verification…';
    await visualVerifyFindings();

    progressBar.style.width='100%';
    progressWrap.style.display='none';

    // Extract nearby text for each finding (for text filtering)
    if (pdfCurrentPage && document.getElementById('ignoreTextChk')?.checked) {
      await extractTextForFindings();
    }

    // Apply pre-search text filtering if enabled
    if (preSearchTextLocations.length > 0) {
      // Use template size as search radius - symbols should be close to their text label
      const searchRadius = Math.max(templateCanvas?.width || 50, templateCanvas?.height || 50) * 0.75;
      const beforeCount = findings.length;
      findings = findings.filter(f => {
        return preSearchTextLocations.some(textLoc => {
          const dist = Math.hypot(textLoc.x - f.x, textLoc.y - f.y);
          return dist < searchRadius;
        });
      });
      console.log(`[QAQC search] Pre-search text filter: ${beforeCount} → ${findings.length} findings (searchRadius=${Math.round(searchRadius)}px, kept only those near specified text)`);
      preSearchTextLocations = []; // Clear for next search
    }

    drawMarkers();
    if(searchRegion) drawRegionBox();
    await renderFindings();
    mode='done';
    const vb=document.getElementById('verifyBtn');
    if(vb) vb.style.display=findings.length>0?'flex':'none';
    const rb=document.getElementById('reviewBtn');
    if(rb) rb.style.display=findings.length>0?'flex':'none';
    const qs=document.getElementById('qaqcSection');
    if(qs) qs.style.display=findings.length>0?'block':'none';
    showStatus(`Vector scan: ${findings.length} match${findings.length!==1?'es':''} · ${paths.length} total paths`);

  }catch(e){
    showError('Vector scan error: '+e.message);
    progressWrap.style.display='none';
  }
  document.getElementById('vectorBtn').disabled=false;
  findBtn.disabled=false;
}

// ── Template matching — runs for one templateCanvas, returns findings ──
async function runMatchForTemplate(templateCanvasIn, labelPrefix, progressOffset, progressShare){

  const threshold=parseInt(document.getElementById('threshold').value)/100;
  const TW=templateCanvasIn.width,TH=templateCanvasIn.height;
  const IW=pdfCanvas.width,IH=pdfCanvas.height;

  const templateData=templateCanvasIn.getContext('2d').getImageData(0,0,TW,TH).data;
  const imageData=ctx.getImageData(0,0,IW,IH).data;

  function toGray(data, w, h) {
    const gray = new Float32Array(w*h);
    for (let i = 0; i < w*h; i++)
      gray[i] = (0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2]) / 255;
    return gray;
  }

  // Alpha weight mask (eraser support)
  const tAlphaBase = new Float32Array(TW*TH);
  for (let i = 0; i < TW*TH; i++) tAlphaBase[i] = templateData[i*4+3] / 255;

  // Compute base edge maps
  const tGrayRaw = toGray(templateData, TW, TH);
  const iGrayRaw = toGray(imageData, IW, IH);
  // Blur template slightly to tolerate 1-2px print/JPEG noise
  const tGrayBlurred = gaussianBlur(tGrayRaw, TW, TH, 1);
  const tEdgesBase = sobelEdges(tGrayBlurred, TW, TH);
  const iEdges = sobelEdges(iGrayRaw, IW, IH);

  // ── Rotation hypotheses ──
  // Test 4 cardinal rotations (0/90/180/270°). rotateMap90 is fast index permutation,
  // no interpolation loss. 45° angles would need costly pixel resampling.
  // Vector system tests 8 rotations—if you need finer rotation coverage, use "Vector Scan".
  const ROT_DEGS = [0, 90, 180, 270];
  const rotatedBase = { 0: { edge: tEdgesBase, alpha: tAlphaBase, gray: tGrayBlurred, w: TW, h: TH } };
  {
    let prev = rotatedBase[0];
    for (const deg of [90, 180, 270]) {
      const cur = {
        edge: rotateMap90(prev.edge, prev.w, prev.h),
        alpha: rotateMap90(prev.alpha, prev.w, prev.h),
        gray: rotateMap90(prev.gray, prev.w, prev.h),
        w: prev.h, h: prev.w
      };
      rotatedBase[deg] = cur;
      prev = cur;
    }
  }

  // Constrain scan to search region if defined
  const scanX1 = searchRegion ? Math.max(0, searchRegion.x1) : 0;
  const scanY1 = searchRegion ? Math.max(0, searchRegion.y1) : 0;
  const scanX2base = searchRegion ? Math.min(IW-TW, searchRegion.x2-TW) : IW-TW;
  const scanY2base = searchRegion ? Math.min(IH-TH, searchRegion.y2-TH) : IH-TH;

  // ── Multi-scale setup ──
  // Wide range: 70–130% catches more print/zoom/drafter variation. Each
  // scale is now built once per rotation hypothesis, so a candidate
  // location is scored against all four orientations and the best-fitting
  // one wins — the same independent-hypothesis principle as the vector
  // engine's runForRotation, just applied to pixel templates instead of
  // path signatures.
  const SCALES = [0.67, 0.80, 0.92, 1.05, 1.22, 1.45]; // removed 0.52 — too far from original, floods results with sub-half-size noise matches
  const scaledTemplates = [];
  for (const deg of ROT_DEGS) {
    const { edge: baseEdge, alpha: baseAlpha, w: baseW, h: baseH } = rotatedBase[deg];
    for (const s of SCALES) {
      const sw = Math.round(baseW * s), sh = Math.round(baseH * s);
      const scaledEdge  = scaleEdgeMap(baseEdge, baseW, baseH, sw, sh);
      const scaledAlpha = scaleEdgeMap(baseAlpha, baseW, baseH, sw, sh);
      // Blur the scaled alpha to avoid hard-edge mask aliasing
      const blurredAlpha = gaussianBlur(scaledAlpha, sw, sh, 0.5);

      // Precompute weighted template stats
      let wSum=0, wMean=0, wVar=0;
      for (let i = 0; i < sw*sh; i++) wSum += blurredAlpha[i];
      if (wSum < 4) continue;
      const tG = new Float32Array(sw*sh);
      const tW = new Float32Array(sw*sh);
      for (let i = 0; i < sw*sh; i++) {
        tG[i] = scaledEdge[i] * blurredAlpha[i];
        tW[i] = blurredAlpha[i];
        wMean += tW[i] * tG[i];
      }
      wMean /= wSum;
      for (let i = 0; i < sw*sh; i++) wVar += tW[i] * (tG[i]-wMean)**2;
      const wStd = Math.sqrt(wVar/wSum);
      // Total edge energy in the template (used for density gating)
      let tEdgeEnergy = 0;
      for (let i = 0; i < sw*sh; i++) tEdgeEnergy += scaledEdge[i];
      // Precompute a subsampled list of strong edge pixel positions for fast coverage checks
      const allStrong = [];
      for(let ty=0;ty<sh;ty++) for(let tx=0;tx<sw;tx++) if(tG[ty*sw+tx]>0.12) allStrong.push([tx,ty]);
      // Subsample to max 32 points, evenly distributed
      const step32 = Math.max(1, Math.ceil(allStrong.length/32));
      const strongSamples = allStrong.filter((_,i)=>i%step32===0).slice(0,32);
      scaledTemplates.push({ sw, sh, tG, tW, wSum, wMean, wStd, tEdgeEnergy, strongSamples, scale: s, rotDeg: deg });
    }
  }

  if(scaledTemplates.length===0){showError('Template is empty after erasing.');findBtn.disabled=false;progressWrap.style.display='none';return;}

  // ── Precompute integral image of iEdges for fast window sums ──
  // This lets us compute the total edge energy in any rectangle in O(1)
  // instead of O(w*h), which makes the variance gate essentially free.
  const iIntegral = new Float64Array((IW+1) * (IH+1));
  for (let y = 0; y < IH; y++) {
    for (let x = 0; x < IW; x++) {
      iIntegral[(y+1)*(IW+1)+(x+1)] =
        iEdges[y*IW+x]
        + iIntegral[y*(IW+1)+(x+1)]
        + iIntegral[(y+1)*(IW+1)+x]
        - iIntegral[y*(IW+1)+x];
    }
  }
  function windowEdgeSum(x, y, w, h) {
    const x2=x+w, y2=y+h;
    return iIntegral[y2*(IW+1)+x2] - iIntegral[y*(IW+1)+x2]
         - iIntegral[y2*(IW+1)+x]  + iIntegral[y*(IW+1)+x];
  }

  // ── Per-scale: precompute template active-pixel edge energy ──
  // We'll gate candidates by requiring their window edge sum to be at least
  // MIN_DENSITY_RATIO of the template's own edge energy. This kills blank-
  // region false positives where there simply aren't enough edges to match.
  const MIN_DENSITY_RATIO = 0.06; // very permissive: sub-path / sparse / faint symbols pass
  // No MAX_DENSITY_RATIO hard gate — busy areas (text, hatch) would kill valid matches

  // ── NCC scorer with variance gate ──
  function scoreAtScale(x, y, tmpl) {
    const { sw, sh, tG, tW, wSum, wMean, wStd, tEdgeEnergy } = tmpl;

    // GATE 1: edge density check via integral image — O(1), very cheap
    const winEnergy = windowEdgeSum(x, y, sw, sh);
    const ratio = winEnergy / tEdgeEnergy;
    // Only gate on minimum — skip blank regions that can't contain the symbol.
    // No upper gate: symbols embedded in busy text/hatch areas must still pass.
    if (ratio < MIN_DENSITY_RATIO) return -1;

    let pWSum=0, pWMean=0, pWVar=0, cross=0;
    for(let ty=0;ty<sh;ty++){
      for(let tx=0;tx<sw;tx++){
        const w=tW[ty*sw+tx]; if(w<0.05)continue;
        const pVal=iEdges[(y+ty)*IW+(x+tx)];
        pWSum+=w; pWMean+=w*pVal;
      }
    }
    if(pWSum<4)return -1;
    pWMean/=pWSum;

    for(let ty=0;ty<sh;ty++){
      for(let tx=0;tx<sw;tx++){
        const w=tW[ty*sw+tx]; if(w<0.05)continue;
        const pVal=iEdges[(y+ty)*IW+(x+tx)];
        pWVar+=w*(pVal-pWMean)**2;
        cross+=w*(tG[ty*sw+tx]-wMean)*(pVal-pWMean);
      }
    }
    const pWStd=Math.sqrt(pWVar/pWSum);

    // GATE 2: patch variance gate — only reject truly blank windows
    if(pWStd < 0.004) return -1;

    const denom=wStd*pWStd*pWSum;
    if(denom<0.001)return -1;
    return cross/denom;
  }

  // ── Coverage score: what fraction of template's strong edge pixels are present in the drawing? ──
  // This is the key fallback for simple shapes (triangles, etc.) in busy areas where NCC
  // gets diluted by surrounding text/lines. Uses integral image for O(1) local sums.
  // A match requires the template's edges to EXIST in the drawing within a small radius,
  // regardless of what else is around them.
  function coverageScore(x, y, tmpl) {
    const { sw, sh, tG } = tmpl;
    const R = 2; // pixel radius — edge must exist within 2px of template position
    let hits = 0, total = 0;
    for (let ty = 0; ty < sh; ty++) {
      for (let tx = 0; tx < sw; tx++) {
        const tval = tG[ty * sw + tx];
        if (tval < 0.15) continue; // only check strong template edges
        total++;
        // Use integral image to check if any edge exists within radius R
        const x0 = Math.max(0, x + tx - R), y0 = Math.max(0, y + ty - R);
        const x1 = Math.min(IW - 1, x + tx + R), y1 = Math.min(IH - 1, y + ty + R);
        const localSum = windowEdgeSum(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
        if (localSum > 0.08) hits++;
      }
    }
    if (total < 4) return 0;
    return hits / total;
  }

  // ── Composite final score: NCC × edge density similarity × shape match ──
  // Instead of just NCC (which is scale-free and rewards blank regions),
  // we multiply in two absolute measures so the final score rewards windows
  // that *look like* the template in structure AND quantity of edges AND shape.
  function compositePenalty(x, y, tmpl) {
    const { sw, sh, tEdgeEnergy } = tmpl;
    const winEnergy = windowEdgeSum(x, y, sw, sh);

    // 1. Edge density: penalise windows that are too SPARSE (symbol absent) OR too DENSE
    // (symbol buried in hatch/text — NCC is unreliable there). Busy-area penalty is
    // gentle (floor 0.70) so legitimate symbols near linework still pass.
    const densityRatio = winEnergy / tEdgeEnergy;
    const densityScore = densityRatio < 1
      ? Math.max(0.60, densityRatio)                              // sparse: ramp from 0.60
      : densityRatio > 3.0
        ? Math.max(0.70, 1.0 - (densityRatio - 3.0) * 0.06)     // busy: gentle penalty above 3× template density
        : 1.0;

    // 2. Aspect ratio of edge mass in the window, compared against the
    // template's aspect ratio AS ORIENTED for this rotation hypothesis —
    // a 90/270° template's effective aspect is the inverse of the
    // original, since sw/sh are already swapped for those rotations.
    const effTAspect = (tmpl.rotDeg === 90 || tmpl.rotDeg === 270) ? (TH / TW) : (TW / TH);
    let ex=0,ey=0,eSum=0;
    for(let ty=0;ty<sh;ty++){
      for(let tx=0;tx<sw;tx++){
        const v=iEdges[(y+ty)*IW+(x+tx)];
        ex+=tx*v; ey+=ty*v; eSum+=v;
      }
    }
    let shapeScore = 1.0;
    if(eSum > 0.001){
      ex/=eSum; ey/=eSum;
      let vx=0,vy=0;
      for(let ty=0;ty<sh;ty++){
        for(let tx=0;tx<sw;tx++){
          const v=iEdges[(y+ty)*IW+(x+tx)];
          vx+=v*(tx-ex)**2; vy+=v*(ty-ey)**2;
        }
      }
      vx/=eSum; vy/=eSum;
      const cAspect=(vy>0.001)?Math.sqrt(vx/vy):1;
      const aspectDiff=Math.abs(cAspect-effTAspect)/Math.max(effTAspect,1);
      shapeScore=Math.max(0.7, 1-aspectDiff*0.3);
    }

    return densityScore * shapeScore;
  }

  // ── HOG orientation histogram — adds rotation-tolerant shape descriptor ──
  // Divide template into a 4×4 grid of cells, compute dominant gradient
  // orientation in each cell. At candidate positions, compare orientation
  // histograms. High similarity → boost score. Low → mild penalty.
  // This catches symbols that NCC misses due to local contrast variation.
  const HOG_BINS = 8;
  function buildHOG(edgeMap, grayMap, W, H, x0, y0, bw, bh) {
    const hist = new Float32Array(HOG_BINS);
    const cx = bw / 2, cy = bh / 2;
    for (let ty = 1; ty < bh-1; ty++) {
      for (let tx = 1; tx < bw-1; tx++) {
        const px = x0+tx, py = y0+ty;
        if(px<1||py<1||px>=W-1||py>=H-1) continue;
        const gx = grayMap[py*W+(px+1)] - grayMap[py*W+(px-1)];
        const gy = grayMap[(py+1)*W+px] - grayMap[(py-1)*W+px];
        const mag = Math.sqrt(gx*gx+gy*gy);
        if(mag < 0.01) continue;
        let angle = Math.atan2(gy, gx);
        if(angle < 0) angle += Math.PI;
        const bin = Math.floor(angle / Math.PI * HOG_BINS) % HOG_BINS;
        hist[bin] += mag;
      }
    }
    // L2 normalize
    let norm = 0; for(let b=0;b<HOG_BINS;b++) norm+=hist[b]*hist[b];
    norm = Math.sqrt(norm)+1e-6;
    for(let b=0;b<HOG_BINS;b++) hist[b]/=norm;
    return hist;
  }
  function hogSimilarity(h1, h2) {
    let dot=0; for(let b=0;b<HOG_BINS;b++) dot+=h1[b]*h2[b];
    return dot; // 0–1
  }
  // Build one template HOG per rotation hypothesis, from that rotation's
  // own (correctly-sized) gray map. The previous version always read from
  // iGrayRaw — the whole-drawing buffer — while telling buildHOG to treat
  // it as if its row stride were TW, which samples the wrong pixels
  // entirely. Each rotation also needs its own histogram: a 90°-rotated
  // window's gradients are cyclically shifted relative to 0°'s, so
  // comparing against a single un-rotated tHOG would unfairly penalize
  // correctly-found 90/270° matches.
  const tHOGByRot = {};
  for (const deg of ROT_DEGS) {
    const { edge, gray, w, h } = rotatedBase[deg];
    tHOGByRot[deg] = buildHOG(edge, gray, w, h, 0, 0, w, h);
  }


  const TW0 = scaledTemplates[0].sw; // use base scale for step/dedup sizing
  const TH0 = scaledTemplates[0].sh;
  const stepSize = Math.max(2, Math.floor(Math.min(TW0, TH0) / 12));
  const coarseThresh = Math.max(0.05, threshold - 0.17); // tightened: was threshold-0.22 — too many low-NCC candidates survived to fine refinement
  const allCandidates = []; // {x, y, score, tmpl}

  // Count total coarse steps across all scales for progress
  let totalSteps = 0;
  for (const tmpl of scaledTemplates) {
    const sx2 = searchRegion ? Math.min(IW-tmpl.sw, searchRegion.x2-tmpl.sw) : IW-tmpl.sw;
    const sy2 = searchRegion ? Math.min(IH-tmpl.sh, searchRegion.y2-tmpl.sh) : IH-tmpl.sh;
    totalSteps += Math.ceil((sy2-scanY1)/stepSize) * Math.ceil((sx2-scanX1)/stepSize);
  }
  let stepsDone = 0;

  for (let si = 0; si < scaledTemplates.length; si++) {
    const tmpl = scaledTemplates[si];
    const sx2 = Math.max(scanX1, searchRegion ? Math.min(IW-tmpl.sw, searchRegion.x2-tmpl.sw) : IW-tmpl.sw);
    const sy2 = Math.max(scanY1, searchRegion ? Math.min(IH-tmpl.sh, searchRegion.y2-tmpl.sh) : IH-tmpl.sh);

    await new Promise(resolve => {
      let y = scanY1;
      function processChunk() {
        const chunkEnd = Math.min(y + stepSize * 6, sy2);
        for (; y <= chunkEnd; y += stepSize) {
          for (let x = scanX1; x <= sx2; x += stepSize) {
            const ncc = scoreAtScale(x, y, tmpl);
            if (ncc >= coarseThresh) allCandidates.push({x, y, score: ncc, tmpl});
            stepsDone++;
          }
        }
        const pct = progressOffset + (stepsDone / totalSteps) * 60 * progressShare;
        progressBar.style.width = pct.toFixed(1) + '%';
        progressLabel.textContent = `${labelPrefix} — ${tmpl.rotDeg}° @ ${Math.round(tmpl.scale*100)}%… ${Math.round((stepsDone/totalSteps)*100)}%`;
        if (y < sy2) { setTimeout(processChunk, 0); } else { resolve(); }
      }
      processChunk();
    });
  }

  // ── Local contrast normalization ──
  // Problem: a hold-down inside a hatch/wall zone scores lower than one in
  // open space because competing edges dilute its NCC. Fix: for each candidate,
  // compute the mean NCC of all candidates within a local neighborhood radius,
  // then boost the score relative to that local mean. This makes the matcher
  // rank symbols by "how much better than their surroundings" rather than
  // absolute score — so a good match inside a busy zone still wins locally.
  if (allCandidates.length > 1) {
    const NEIGHBORHOOD_PX = Math.max(TW, TH) * 4; // local radius
    for (let i = 0; i < allCandidates.length; i++) {
      const c = allCandidates[i];
      let localSum = 0, localCount = 0;
      for (let j = 0; j < allCandidates.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(allCandidates[j].x - c.x, allCandidates[j].y - c.y);
        if (d < NEIGHBORHOOD_PX) { localSum += allCandidates[j].score; localCount++; }
      }
      if (localCount > 0) {
        const localMean = localSum / localCount;
        // Boost score by how much it exceeds its local mean (capped at 25% boost)
        const localBoost = Math.min(1.25, 1 + Math.max(0, c.score - localMean) * 1.5);
        c.score *= localBoost;
      }
    }
  }


  progressLabel.textContent = 'Refining…';
  const refinedMap = new Map();
  let fineIdx = 0;
  await new Promise(resolve => {
    function processFineBatch() {
      const batchEnd = Math.min(fineIdx + 12, allCandidates.length);
      for (; fineIdx < batchEnd; fineIdx++) {
        const c = allCandidates[fineIdx];
        const tmpl = c.tmpl;
        const sx2f = searchRegion ? Math.min(IW-tmpl.sw, searchRegion.x2-tmpl.sw) : IW-tmpl.sw;
        const sy2f = searchRegion ? Math.min(IH-tmpl.sh, searchRegion.y2-tmpl.sh) : IH-tmpl.sh;
        let bestX=c.x, bestY=c.y, bestScore=c.score;
        const x0=Math.max(scanX1,c.x-stepSize), x1f=Math.min(sx2f,c.x+stepSize);
        const y0=Math.max(scanY1,c.y-stepSize), y1f=Math.min(sy2f,c.y+stepSize);
        for(let fy=y0;fy<=y1f;fy++){
          for(let fx=x0;fx<=x1f;fx++){
            const s=scoreAtScale(fx,fy,tmpl);
            if(s>bestScore){bestScore=s;bestX=fx;bestY=fy;}
          }
        }
        // HOG orientation check — boosts candidates whose gradient
        // structure matches, compared against the template HOG for THIS
        // candidate's matched rotation (not always 0°), so a correctly
        // found 90/270° match isn't penalized for not looking like the
        // unrotated symbol.
        const winHOG = buildHOG(iEdges, iGrayRaw, IW, IH, bestX, bestY, tmpl.sw, tmpl.sh);
        const hogSim = hogSimilarity(tHOGByRot[tmpl.rotDeg], winHOG);
        // HOG factor: widened discriminating range.
        // Floor lowered to 0.42 (was 0.50) so poor orientation matches actually hurt.
        // Ceiling raised slightly so good orientation matches still get a useful boost.
        // Result range: 0.42 (hogSim=0) → ~1.20 (hogSim=1.0)
        const hogFactor = Math.max(0.42, 0.42 + hogSim * 0.48 + (hogSim > 0.45 ? (hogSim-0.45)*0.50 : 0));

        // Composite penalty: only meaningful when NCC is borderline.
        const penalty = compositePenalty(bestX, bestY, tmpl);
        const penalised = bestScore >= 0.45
          ? bestScore * Math.max(0.75, penalty) * hogFactor
          : bestScore * penalty * hogFactor;

        // Coverage rescue: if NCC-based score is below threshold but the template's
        // edge pixels ARE present in the drawing (simple shapes in busy areas), promote it.
        // Tightened: coverage bar raised to 70% (was 55%) and requires NCC to already be
        // at least 45% of the threshold — prevents pure coverage from rescuing noise
        // where NCC is essentially zero (a hallmark of false positives in hatch/text areas).
        const cov = coverageScore(bestX, bestY, tmpl);
        const rescuable = penalised >= threshold * 0.45;
        const finalScore = (cov > 0.70 && rescuable) ? Math.max(penalised, cov * 0.82) : penalised;

        if(finalScore >= threshold){
          // Dedup key in base-scale coordinates
          const cellKey=`${Math.round(bestX/stepSize)},${Math.round(bestY/stepSize)}`;
          const existing=refinedMap.get(cellKey);
          if(!existing||finalScore>existing.score){
            refinedMap.set(cellKey,{x:bestX,y:bestY,score:finalScore,tmpl});
          }
        }
      }
      const pct=progressOffset + progressShare*(60 + (fineIdx/Math.max(1,allCandidates.length))*40);
      progressBar.style.width=pct.toFixed(1)+'%';
      progressLabel.textContent=`${labelPrefix} — refining… ${Math.round((fineIdx/Math.max(1,allCandidates.length))*100)}%`;
      if(fineIdx<allCandidates.length){setTimeout(processFineBatch,0);}else{resolve();}
    }
    processFineBatch();
  });

  const matches=[...refinedMap.values()];
  matches.sort((a,b)=>b.score-a.score);
  const kept=[];
  const minDist=Math.max(TW,TH)*0.5;
  for(const m of matches){
    const tooClose=kept.some(k=>Math.hypot(k.x-m.x,k.y-m.y)<minDist);
    if(!tooClose)kept.push(m);
  }

  function refineCenter(m) {
    const {tmpl} = m;
    const sx2f = searchRegion ? Math.min(IW-tmpl.sw, searchRegion.x2-tmpl.sw) : IW-tmpl.sw;
    const sy2f = searchRegion ? Math.min(IH-tmpl.sh, searchRegion.y2-tmpl.sh) : IH-tmpl.sh;
    const cx=m.x, cy=m.y, sc=m.score;
    const sx0=scoreAtScale(Math.max(scanX1,cx-1),cy,tmpl);
    const sx2=scoreAtScale(Math.min(sx2f,cx+1),cy,tmpl);
    const sy0=scoreAtScale(cx,Math.max(scanY1,cy-1),tmpl);
    const sy2=scoreAtScale(cx,Math.min(sy2f,cy+1),tmpl);
    const dX=sx0-2*sc+sx2, dY=sy0-2*sc+sy2;
    const dx=dX!==0?Math.max(-1,Math.min(1,0.5*(sx0-sx2)/dX)):0;
    const dy=dY!==0?Math.max(-1,Math.min(1,0.5*(sy0-sy2)/dY)):0;
    return {x:cx+dx+tmpl.sw/2, y:cy+dy+tmpl.sh/2};
  }

  return kept.map((m,i)=>{
    const c=refineCenter(m);
    return {x:c.x, y:c.y, score:m.score, label:`${labelPrefix} ${i+1}`, scale:m.tmpl.scale, rotDeg:m.tmpl.rotDeg};
  });
}

// ── Outer entry point: run for template 1 (and optionally template 2) ──
async function runTemplateMatch(){
  if(!templateCanvas){showError('Select a template first.');return;}
  findBtn.disabled=true;findingsWrap.style.display='none';bottomBar.classList.remove('visible');
  progressWrap.style.display='block';progressBar.style.width='0%';findings=[];rejectedFindings=[];_showBelowCutoff=false;_manualCutoff=null;

  const hasT2 = !!templateCanvas2;
  const share1 = hasT2 ? 0.55 : 1.0;
  const share2 = hasT2 ? 0.45 : 0;

  const results1 = await runMatchForTemplate(templateCanvas, 'Symbol', 0, share1);
  let results2 = [];
  if(hasT2){
    results2 = await runMatchForTemplate(templateCanvas2, 'Callout', share1*100, share2);
  }

  // Merge and renumber
  findings = [
    ...results1.map((f,i)=>({...f, label:`Match ${i+1}`})),
    ...results2.map((f,i)=>({...f, label:`T2 Match ${i+1}`}))
  ];

  progressWrap.style.display='none';
  progressBar.style.width='100%';

  // Extract nearby text for each finding (for text filtering)
  if (pdfCurrentPage && document.getElementById('ignoreTextChk')?.checked) {
    await extractTextForFindings();
  }

  drawMarkers();
  if(searchRegion) drawRegionBox();
  await renderFindings();
  findBtn.disabled=false;mode='done';
  const verifyBtn=document.getElementById('verifyBtn');
  if(verifyBtn) verifyBtn.style.display=findings.length>0?'flex':'none';
  const rb=document.getElementById('reviewBtn');
  if(rb) rb.style.display=findings.length>0?'flex':'none';
  const qs=document.getElementById('qaqcSection');
  if(qs) qs.style.display=findings.length>0?'block':'none';
}

// ── Debug scan: show heatmap of ALL scores so you can see why spots are missed ──
async function runDebugScan(){
  if(!templateCanvas){showError('Select a template first.');return;}
  debugMode=true;
  const debugBtn=document.getElementById('debugBtn');
  debugBtn.disabled=true; findBtn.disabled=true;
  findingsWrap.style.display='none'; bottomBar.classList.remove('visible');
  progressWrap.style.display='block'; progressBar.style.width='0%';

  const threshold=parseInt(document.getElementById('threshold').value)/100;
  const TW=templateCanvas.width, TH=templateCanvas.height;
  const IW=pdfCanvas.width, IH=pdfCanvas.height;

  function toGray(data,w,h){const g=new Float32Array(w*h);for(let i=0;i<w*h;i++)g[i]=(0.299*data[i*4]+0.587*data[i*4+1]+0.114*data[i*4+2])/255;return g;}

  const tData=templateCanvas.getContext('2d').getImageData(0,0,TW,TH).data;
  const iData=ctx.getImageData(0,0,IW,IH).data;
  const tAlpha=new Float32Array(TW*TH); for(let i=0;i<TW*TH;i++) tAlpha[i]=tData[i*4+3]/255;
  const tRaw=toGray(tData,TW,TH);
  const iRaw=toGray(iData,IW,IH);
  const tBlur=gaussianBlur(tRaw,TW,TH,1);
  const tEdges=sobelEdges(tBlur,TW,TH);
  const iEdges=sobelEdges(iRaw,IW,IH);

  // Build weighted template at 100% scale only (debug is for understanding, not exhaustive)
  const tG=new Float32Array(TW*TH), tW=new Float32Array(TW*TH);
  for(let i=0;i<TW*TH;i++){tG[i]=tEdges[i]*tAlpha[i];tW[i]=tAlpha[i];}
  let wSum=0,wMean=0,wVar=0;
  for(let i=0;i<TW*TH;i++) wSum+=tW[i];
  if(wSum<4){showError('Template empty.');debugBtn.disabled=false;findBtn.disabled=false;progressWrap.style.display='none';return;}
  for(let i=0;i<TW*TH;i++) wMean+=tW[i]*tG[i]; wMean/=wSum;
  for(let i=0;i<TW*TH;i++) wVar+=tW[i]*(tG[i]-wMean)**2;
  const wStd=Math.sqrt(wVar/wSum);

  // Expose score function so canvas clicks can probe it
  debugScoreAtFn=(px,py)=>{
    // px,py = canvas pixel coords; return raw NCC score (no penalties)
    const x=Math.round(px-TW/2), y=Math.round(py-TH/2);
    if(x<0||y<0||x+TW>IW||y+TH>IH) return null;
    let pWSum=0,pWMean=0,pWVar=0,cross=0;
    for(let ty=0;ty<TH;ty++) for(let tx=0;tx<TW;tx++){
      const w=tW[ty*TW+tx]; if(w<0.05) continue;
      const v=iEdges[(y+ty)*IW+(x+tx)]; pWSum+=w; pWMean+=w*v;
    }
    if(pWSum<4) return 0;
    pWMean/=pWSum;
    for(let ty=0;ty<TH;ty++) for(let tx=0;tx<TW;tx++){
      const w=tW[ty*TW+tx]; if(w<0.05) continue;
      const v=iEdges[(y+ty)*IW+(x+tx)]; pWVar+=w*(v-pWMean)**2; cross+=w*(tG[ty*TW+tx]-wMean)*(v-pWMean);
    }
    const pWStd=Math.sqrt(pWVar/pWSum);
    const denom=wStd*pWStd*pWSum;
    return denom<0.001?0:cross/denom;
  };

  // Scan at step=4 (fast, just for visualization)
  const DEBUG_STEP=4;
  const scanX1=searchRegion?Math.max(0,searchRegion.x1):0;
  const scanY1=searchRegion?Math.max(0,searchRegion.y1):0;
  const scanX2=searchRegion?Math.min(IW-TW,searchRegion.x2-TW):IW-TW;
  const scanY2=searchRegion?Math.min(IH-TH,searchRegion.y2-TH):IH-TH;
  const DEBUG_THRESH=0.12; // very low — show almost everything
  const hits=[]; // {x,y,score}
  const totalSteps=Math.ceil((scanY2-scanY1)/DEBUG_STEP)*Math.ceil((scanX2-scanX1)/DEBUG_STEP);
  let done=0;

  await new Promise(resolve=>{
    let y=scanY1;
    function chunk(){
      const end=Math.min(y+DEBUG_STEP*60,scanY2);
      for(;y<=end;y+=DEBUG_STEP){
        for(let x=scanX1;x<=scanX2;x+=DEBUG_STEP){
          let pWSum=0,pWMean=0,pWVar=0,cross=0;
          for(let ty=0;ty<TH;ty++) for(let tx=0;tx<TW;tx++){
            const w=tW[ty*TW+tx]; if(w<0.05) continue;
            const v=iEdges[(y+ty)*IW+(x+tx)]; pWSum+=w; pWMean+=w*v;
          }
          if(pWSum>=4){
            pWMean/=pWSum;
            for(let ty=0;ty<TH;ty++) for(let tx=0;tx<TW;tx++){
              const w=tW[ty*TW+tx]; if(w<0.05) continue;
              const v=iEdges[(y+ty)*IW+(x+tx)]; pWVar+=w*(v-pWMean)**2; cross+=w*(tG[ty*TW+tx]-wMean)*(v-pWMean);
            }
            const pWStd=Math.sqrt(pWVar/pWSum);
            const denom=wStd*pWStd*pWSum;
            if(denom>=0.001){
              const ncc=cross/denom;
              if(ncc>=DEBUG_THRESH) hits.push({x:x+TW/2,y:y+TH/2,score:ncc});
            }
          }
          done++;
        }
      }
      progressBar.style.width=(done/totalSteps*100).toFixed(1)+'%';
      progressLabel.textContent=`Debug scan… ${Math.round(done/totalSteps*100)}%`;
      if(y<scanY2) setTimeout(chunk,0); else resolve();
    }
    chunk();
  });

  // Draw heatmap overlay: dots colored by score
  // green=above threshold, yellow=close, red=low
  progressWrap.style.display='none';
  octx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
  if(searchRegion) drawRegionBox();

  hits.forEach(h=>{
    const s=Math.max(0,Math.min(1,h.score));
    let color;
    if(s>=threshold)       color=`rgba(29,158,117,0.75)`;   // green — would be caught
    else if(s>=threshold*0.7) color=`rgba(239,159,39,0.75)`; // orange — close miss
    else if(s>=threshold*0.4) color=`rgba(220,80,60,0.6)`;   // red — far miss
    else return; // too low, skip drawing
    octx.beginPath();
    octx.arc(h.x,h.y,Math.max(TW,TH)*0.3,0,Math.PI*2);
    octx.fillStyle=color; octx.fill();
  });

  // Sidebar: show score distribution summary
  const above=hits.filter(h=>h.score>=threshold).length;
  const close=hits.filter(h=>h.score>=threshold*0.7&&h.score<threshold).length;
  findingsWrap.style.display='block';
  document.getElementById('findingsCount').textContent=`Debug: ${hits.length} candidates`;
  findingList.innerHTML=`
    <div style="font-size:12px;line-height:1.8;padding:4px 0;color:#444;">
      <div>🟢 <b>${above}</b> above threshold (${Math.round(threshold*100)}%) — <i>would be caught</i></div>
      <div>🟠 <b>${close}</b> close miss (${Math.round(threshold*0.7*100)}%–${Math.round(threshold*100)}%)</div>
      <div style="margin-top:8px;color:#888;font-size:11px;">
        <b>Click any spot on the drawing</b> to see its exact NCC score.<br>
        If missed symbols show orange/red, lower the threshold.<br>
        If they don't show at all, the template doesn't match — try re-selecting it more tightly.
      </div>
    </div>
    <div id="probeResult" style="margin-top:10px;padding:10px;background:#f5f4f0;border-radius:8px;font-size:13px;display:none;"></div>
    <div style="margin-top:12px;">
      <button onclick="exitDebug()" style="width:100%;padding:8px;font-size:13px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;">← Exit debug mode</button>
    </div>`;
  bottomBar.classList.remove('visible');
  debugBtn.disabled=false; findBtn.disabled=false;
  mode='debug';
  showBanner('Debug: click any symbol to see its NCC score');
}

function exitDebug(){
  debugMode=false; debugScoreAtFn=null; mode='ready';
  octx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
  findingsWrap.style.display='none';
  hideBanner();
  drawMarkers(); if(searchRegion) drawRegionBox();
}

function drawMarkers(highlightIdx=-1){
  octx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);

  // ── Persistent item markup boxes (always drawn, one color per item) ──
  if (typeof inspectionItems !== 'undefined' && inspectionItems.length) {
    const canDeleteViaCanvas = !(typeof isInManualMarkupMode!=='undefined'&&isInManualMarkupMode) && !(typeof isInVectorReviewMode!=='undefined'&&isInVectorReviewMode);
    inspectionItems.forEach(item => {
      if (!item.boxes || !item.boxes.length) return;
      const isSel = currentSelectedItem && currentSelectedItem.id === item.id;
      octx.strokeStyle = item.color;
      octx.fillStyle = item.color;
      octx.lineWidth = isSel ? 4 : 3;
      item.boxes.forEach(b => {
        octx.globalAlpha = isSel ? 0.28 : 0.18;
        octx.fillRect(b.x, b.y, b.w, b.h);
        octx.globalAlpha = isSel ? 1 : 0.85;
        octx.strokeRect(b.x, b.y, b.w, b.h);
      });
      octx.globalAlpha = 1;
      // Delete badge on the selected item's own markups only — a plain
      // click on one removes it in place (see hitTestItemDeleteBadge).
      if (isSel && canDeleteViaCanvas) {
        // Fixed on-screen size regardless of zoom/resolution — canvas-space
        // radius must shrink as you zoom in (scale grows) to stay ~6px on screen.
        const delR = 6 / (typeof scale!=='undefined'&&scale?scale:1);
        item.boxes.forEach(b => {
          const cx = b.x + b.w, cy = b.y;
          octx.beginPath(); octx.arc(cx, cy, delR, 0, Math.PI * 2);
          octx.fillStyle = '#dc2626'; octx.fill();
          octx.lineWidth = Math.max(delR * 0.15, 1);
          octx.strokeStyle = '#fff'; octx.stroke();
          octx.lineWidth = Math.max(delR * 0.28, 1.5);
          const o = delR * 0.4;
          octx.beginPath();
          octx.moveTo(cx - o, cy - o); octx.lineTo(cx + o, cy + o);
          octx.moveTo(cx + o, cy - o); octx.lineTo(cx - o, cy + o);
          octx.stroke();
        });
      }
    });
  }

  if (typeof _detailRect !== 'undefined' && _detailRect) {
    octx.strokeStyle = '#2563eb';
    octx.lineWidth = 2;
    octx.setLineDash([9, 5]);
    octx.strokeRect(_detailRect.x, _detailRect.y, _detailRect.w, _detailRect.h);
    octx.setLineDash([]);
  }

  if (typeof isInManualMarkupMode !== 'undefined' && isInManualMarkupMode) {
    // Live preview while dragging
    if (manualBoxStart && manualBoxEnd) {
      octx.strokeStyle = currentSelectedItem ? currentSelectedItem.color : '#ef4444';
      octx.globalAlpha = 0.55;
      octx.lineWidth = 2;
      octx.setLineDash([6, 4]);
      octx.strokeRect(manualBoxStart.x, manualBoxStart.y,
                      manualBoxEnd.x - manualBoxStart.x,
                      manualBoxEnd.y - manualBoxStart.y);
      octx.setLineDash([]);
      octx.globalAlpha = 1;
    }
    return; // Skip template-matching markers while marking up
  }
  const W=overlayCanvas.width, H=overlayCanvas.height;
  if(templateCanvas&&templateSelBox&&mode!=='idle'){
    const {x1,y1,x2,y2}=templateSelBox;
    octx.strokeStyle='#EF9F27';octx.lineWidth=Math.max(W,H)*0.002;
    octx.setLineDash([6,3]);octx.strokeRect(x1,y1,x2-x1,y2-y1);octx.setLineDash([]);
  }
  const TW=templateCanvas?templateCanvas.width:20, TH=templateCanvas?templateCanvas.height:20;
  const hw=TW*0.55, hh=TH*0.55;
  const fs=Math.max(W,H)*0.0045; // much smaller font

  // Use filtered findings for display if available, otherwise fall back to all findings
  const findingsToDisplay = filteredFindingsForDisplay.length > 0 ? filteredFindingsForDisplay : findings;
  const _cutAt = detectScoreCutoff(findingsToDisplay);
  findingsToDisplay.forEach((f,i)=>{
    // Don't draw markers for probable false positives while they're collapsed
    if(!_showBelowCutoff && i>=_cutAt) return;
    const isActive=i===highlightIdx;
    const baseColor=f.typeColor||'#0d9488';
    const x=f.x-hw, y=f.y-hh, w=hw*2, h=hh*2;

    // Draw template overlay (only for active/highlighted match)
    if(isActive && templateCanvas) {
      // Calculate best-fit scale & rotation if not already known
      if (!f._overlayCalced) {
        const fit = findBestScaleRotation(f, templateCanvas, pdfCanvas);
        f.scale = fit.scale;
        f.rotDeg = fit.rotDeg;
        f._overlayCalced = true;
      }

      const scale = (f.scale || 1.0);
      const rotDeg = (f.rotDeg || 0);

      const scaledW = Math.round(templateCanvas.width * scale);
      const scaledH = Math.round(templateCanvas.height * scale);

      octx.save();
      octx.globalAlpha = 0.4;
      octx.translate(f.x, f.y);
      if(rotDeg !== 0) octx.rotate((rotDeg * Math.PI) / 180);
      octx.drawImage(templateCanvas, -scaledW/2, -scaledH/2, scaledW, scaledH);
      octx.restore();
    }

    // Semi-transparent highlight — subtle, see-through
    octx.globalAlpha=isActive?0.28:0.13;
    octx.fillStyle=isActive?'#1e3a5f':baseColor;
    octx.fillRect(x,y,w,h);
    // Thin border outline
    octx.globalAlpha=isActive?0.9:0.55;
    octx.strokeStyle=isActive?'#1e3a5f':baseColor;
    octx.lineWidth=Math.max(W,H)*0.001;
    octx.strokeRect(x,y,w,h);
    // Tiny number tag — just above top-left corner, outside the box.
    // Uses the finding's stable number (assigned once at scan time) rather
    // than its live array index, so accepting one suggestion doesn't
    // renumber every suggestion after it.
    octx.font=`500 ${fs}px Inter,-apple-system,sans-serif`;
    octx.textAlign='center'; octx.textBaseline='middle';
    const lbl=String(f._stableNum||(i+1));
    const bw=Math.max(fs*1.6, octx.measureText(lbl).width+fs*0.8);
    const bh=fs*1.5;
    octx.globalAlpha=isActive?0.85:0.65;
    octx.fillStyle=isActive?'#1e3a5f':baseColor;
    roundRect(octx,x,y-bh-2,bw,bh,2);
    octx.fill();
    octx.globalAlpha=1;
    octx.fillStyle='#fff';
    octx.fillText(lbl,x+bw/2,y-bh/2-2);
    octx.globalAlpha=1;
  });
  // Draw legend if types are assigned
  if(currentTypeMap.length>0) drawLegend();
  // Draw active placement overlay on top of everything
  if(activePlacement) renderPlacementOnOverlay();
}

function drawLegend(){
  if(!currentTypeMap.length) return;
  const W=overlayCanvas.width, H=overlayCanvas.height;
  const pad=Math.max(W,H)*0.012;
  const rowH=Math.max(W,H)*0.018;
  const swatchSz=rowH*0.65;
  const fontSize=rowH*0.55;
  const innerPad=rowH*0.5;

  octx.font=`600 ${fontSize}px Inter,-apple-system,sans-serif`;
  octx.textBaseline='middle';

  // Measure widest label
  let maxLabelW=0;
  currentTypeMap.forEach(({typeKey,count})=>{
    const txt=`${typeKey}  ×${count}`;
    const w=octx.measureText(txt).width;
    if(w>maxLabelW) maxLabelW=w;
  });

  const boxW=swatchSz+innerPad*0.5+maxLabelW+innerPad*2;
  const boxH=innerPad*1.2 + currentTypeMap.length*rowH + (currentTypeMap.length-1)*rowH*0.3 + innerPad*0.8;

  // Position: top-right, inset from edge
  const bx=W-boxW-pad;
  const by=pad;

  // Background panel
  octx.globalAlpha=0.88;
  octx.fillStyle='#ffffff';
  roundRect(octx,bx,by,boxW,boxH,Math.max(W,H)*0.004);
  octx.fill();
  octx.globalAlpha=0.35;
  octx.strokeStyle='#1e3a5f';
  octx.lineWidth=Math.max(W,H)*0.0006;
  octx.stroke();
  octx.globalAlpha=1;

  // Title
  octx.font=`700 ${fontSize*0.82}px Inter,-apple-system,sans-serif`;
  octx.fillStyle='#6b7280';
  octx.textAlign='left';
  octx.fillText('SYMBOL TYPES', bx+innerPad, by+innerPad*0.9);

  // Rows
  currentTypeMap.forEach(({typeKey,color,count},i)=>{
    const rowY=by+innerPad*1.5+i*(rowH+rowH*0.3);
    // Swatch
    octx.globalAlpha=0.9;
    octx.fillStyle=color;
    roundRect(octx,bx+innerPad,rowY+rowH*0.18,swatchSz,swatchSz,2);
    octx.fill();
    octx.globalAlpha=1;
    // Label
    octx.font=`600 ${fontSize}px Inter,-apple-system,sans-serif`;
    octx.fillStyle='#111827';
    octx.textAlign='left';
    octx.fillText(typeKey, bx+innerPad+swatchSz+innerPad*0.5, rowY+rowH*0.5);
    // Count
    const keyW=octx.measureText(typeKey).width;
    octx.font=`400 ${fontSize*0.85}px Inter,-apple-system,sans-serif`;
    octx.fillStyle='#6b7280';
    octx.fillText(`×${count}`, bx+innerPad+swatchSz+innerPad*0.5+keyW+fontSize*0.4, rowY+rowH*0.5);
  });
  octx.globalAlpha=1;
}

function roundRect(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.lineTo(x+w-r,y);c.quadraticCurveTo(x+w,y,x+w,y+r);c.lineTo(x+w,y+h-r);c.quadraticCurveTo(x+w,y+h,x+w-r,y+h);c.lineTo(x+r,y+h);c.quadraticCurveTo(x,y+h,x,y+h-r);c.lineTo(x,y+r);c.quadraticCurveTo(x,y,x+r,y);c.closePath();}

// ── Visual appearance verification ──
// After the vector scan finds candidates by path geometry, this step
// extracts a small patch from the drawing at each candidate location and
// compares it to the template using edge-based NCC. Candidates that look
// nothing like the template (random linework, different shapes) get a
// near-zero visual score and collapse below the auto-cutoff.
// Only patches at the N candidate locations are computed — never the full
// drawing — so this adds less than a second to the scan.
// ── Visual verification helpers ───────────────────────────────────────────

// Convert RGBA ImageData to grayscale Float32Array.
// CRITICAL: transparent pixels (alpha < 32) → white (1.0).
// templateCanvas has background removed (transparent), so ignoring alpha
// was making the template read as all-black garbage in every prior check.
function toGrayAlpha(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (data[i*4+3] < 32) { g[i] = 1.0; continue; }
    g[i] = (0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2]) / 255;
  }
  return g;
}

// Box-filter downsample.
function downsampleGray(gray, W, H, dW, dH) {
  const out = new Float32Array(dW * dH);
  const sx = W / dW, sy = H / dH;
  for (let dy = 0; dy < dH; dy++) {
    const y0 = Math.floor(dy*sy), y1 = Math.min(H, Math.ceil((dy+1)*sy));
    for (let dx = 0; dx < dW; dx++) {
      const x0 = Math.floor(dx*sx), x1 = Math.min(W, Math.ceil((dx+1)*sx));
      let sum=0, cnt=0;
      for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++){sum+=gray[y*W+x];cnt++;}
      out[dy*dW+dx] = cnt>0 ? sum/cnt : 1.0;
    }
  }
  return out;
}

// ── Main visual verification ──────────────────────────────────────────────
// Two previous approaches failed:
//  - NCC: 90% white background dominates — both images agree on white everywhere
//  - Binary ink overlap alone: drawing has 25-35% ambient ink (walls everywhere),
//    so ~30% of template ink pixels land on drawing ink purely by chance.
//
// Solution — ink × white combined score:
//   inkScore  = fraction of template INK pixels that hit ink in the drawing
//   whiteScore= fraction of template WHITE pixels that are also white in drawing
//   combined  = inkScore × whiteScore
//
// A false positive in a busy wall region: some template ink pixels hit
// wall ink (inkScore ok), but template white areas are FILLED with walls
// (whiteScore collapses → combined near zero).
// A real shear wall: ink lines align + open space around symbol is actually
// open → both scores good → combined 0.4-0.6.
//
// Also switched DS from 4 to 2: at 4× downsample, 2px-wide construction
// lines average to 0.875 gray, above any reasonable ink threshold → invisible.
// At 2×, same line averages to 0.5 → clearly detected.
async function visualVerifyFindings() {
  if (!templateCanvas || findings.length === 0) return;

  const TW = templateCanvas.width, TH = templateCanvas.height;
  const IW = pdfCanvas.width, IH = pdfCanvas.height;

  const DS    = 1.5;  // 1.5× downsample — preserve detail for thin symbols
  const INK   = 0.75; // gray < INK   → ink pixel (slightly higher tolerance for thin lines)
  const WHITE = 0.85; // gray > WHITE → clear white pixel (more forgiving)
  const PAD   = 40;   // search ±40px around centroid to handle drift
  const STEP  = 3;    // step in downsampled px (finer grid for detail)

  const dtw = Math.max(8, Math.round(TW / DS));
  const dth = Math.max(8, Math.round(TH / DS));
  const N   = dtw * dth;

  const ignoringText = document.getElementById('ignoreTextChk')?.checked && _templateTextRegions.length > 0;

  // Template: alpha-correct gray → optional text mask → downsample
  const tRaw  = templateCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, TW, TH).data;
  let   tGray = toGrayAlpha(tRaw, TW, TH);
  if (ignoringText) tGray = applyTextMaskToGray(tGray, TW, TH, _templateTextRegions);
  const tDown = downsampleGray(tGray, TW, TH, dtw, dth);

  // Build ink / white / neutral masks for the template
  const tMask = new Int8Array(N); // 1=ink, -1=white, 0=neutral
  let tInkCnt=0, tWhtCnt=0;
  for (let i=0;i<N;i++) {
    if      (tDown[i] < INK)   { tMask[i] =  1; tInkCnt++; }
    else if (tDown[i] > WHITE)  { tMask[i] = -1; tWhtCnt++; }
  }

  // Need reasonable ink and white regions to be meaningful
  if (tInkCnt < N*0.005 || tWhtCnt < N*0.10) return;

  for (const f of findings) {
    // For template-matched findings: use the actual scale/rotation that was found
    // For vector findings: fall back to fixed 1x/0° check
    const tmplScale = f.scale || 1.0;
    const tmplRot = f.rotDeg || 0;

    // Scale the template region accordingly
    const scaledTW = Math.round(TW * tmplScale);
    const scaledTH = Math.round(TH * tmplScale);
    const sx = Math.round(f.x - scaledTW/2) - PAD;
    const sy = Math.round(f.y - scaledTH/2) - PAD;
    const sw = scaledTW + PAD*2;
    const sh = scaledTH + PAD*2;

    if (sx<0||sy<0||sx+sw>IW||sy+sh>IH) { f.visualScore=0.5; continue; }

    const pRaw  = ctx.getImageData(sx, sy, sw, sh).data;
    const pGray = toGrayAlpha(pRaw, sw, sh);
    const dsw   = Math.round(sw / DS);
    const dsh   = Math.round(sh / DS);
    const pDown = downsampleGray(pGray, sw, sh, dsw, dsh);

    // For rotations: check at the correct angle
    let best = 0;
    const dstw = Math.round(scaledTW / DS);
    const dsth = Math.round(scaledTH / DS);

    // For cardinal rotations (0/90/180/270), rotate the template mask accordingly
    let checkMask = tMask;
    let checkW = dtw, checkH = dth;
    if (tmplRot === 90 || tmplRot === 270) {
      // Swap dimensions for 90/270
      checkW = dth;
      checkH = dtw;
    }

    for (let oy=0; oy+checkH<=dsh; oy+=STEP) {
      for (let ox=0; ox+checkW<=dsw; ox+=STEP) {
        let inkHit=0, whtHit=0;
        for (let y=0; y<checkH; y++) {
          for (let x=0; x<checkW; x++) {
            let mx, my;
            // Apply rotation to template indices
            if (tmplRot === 0) {
              mx = x; my = y;
            } else if (tmplRot === 90) {
              mx = y; my = dtw - 1 - x; // Rotate 90: (x,y) → (y, W-1-x)
            } else if (tmplRot === 180) {
              mx = dtw - 1 - x; my = dth - 1 - y; // Rotate 180
            } else if (tmplRot === 270) {
              mx = dth - 1 - y; my = x; // Rotate 270: (x,y) → (H-1-y, x)
            } else {
              continue;
            }
            const tr = my * dtw + mx;
            if (tr < 0 || tr >= tMask.length) continue;
            const m = tMask[tr];
            const pr = (oy + y) * dsw + ox;
            if (pr < 0 || pr >= pDown.length) continue;
            const p = pDown[pr];
            if      (m===1  && p<INK)   inkHit++; // template ink → drawing ink
            else if (m===-1 && p>WHITE) whtHit++; // template white → drawing white
          }
        }
        const sc = (inkHit/tInkCnt) * (whtHit/tWhtCnt);
        if (sc>best) best=sc;
      }
    }

    f.visualScore = best;
  }

  // ── ADAPTIVE GAP DETECTION: Find the natural cliff between real and false positives ──
  // Vector scan finds everything (excellent recall). Visual score separates signal from noise.
  // Strategy: Detect the largest gap in visual score distribution — that's where real ends & fake begins.
  // This adapts per search without symbol-specific thresholds.

  const rejectedCount = findings.length;

  // Adaptive gap: find natural cliff between real matches and false positives
  if (findings.length > 1) {
    const sorted = [...findings].sort((a, b) => (b.visualScore ?? 0.5) - (a.visualScore ?? 0.5));
    let maxGap = 0, gapThreshold = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = (sorted[i].visualScore ?? 0.5) - (sorted[i+1].visualScore ?? 0.5);
      if (gap > maxGap) {
        maxGap = gap;
        gapThreshold = ((sorted[i].visualScore ?? 0.5) + (sorted[i+1].visualScore ?? 0.5)) / 2;
      }
    }
    if (maxGap > 0.04) {
      findings = findings.filter(f => (f.visualScore ?? 0.5) >= gapThreshold);
      console.log(`[QAQC adaptive gap] Gap threshold: ${(gapThreshold*100).toFixed(1)}% (gap size: ${(maxGap*100).toFixed(1)}%) — kept ${findings.length} findings`);
    } else {
      console.log(`[QAQC adaptive gap] No significant gap found (max: ${(maxGap*100).toFixed(1)}%) — keeping all findings`);
    }
  }

  findings.sort((a, b) => b.score - a.score);
  const query = document.getElementById('queryInput')?.value.trim() || 'Match';
  findings.forEach((f, i) => { f.label = `${query} ${i+1}`; });

  console.log(`[QAQC adaptive gap] Rejected ${rejectedCount - findings.length}/${rejectedCount} findings as false positives`);
}

// ── Auto-cutoff: where do real matches end and false positives begin? ──
// Finds the largest relative drop between consecutive scores. When scores
// fall off a cliff (real→fake boundary), that gap is the right cutoff.
// Returns the index of the first probable false positive (keep 0..cutAt-1).
let _showBelowCutoff = false;
let _manualCutoff = null; // null = use auto-detect; number = user-adjusted

// ── Text-ignore mask ──
// Stores bounding boxes (in template-local canvas px) of text items that
// fall inside the template selection. When "Ignore text" is on, these
// regions are whited-out in both template and each patch before NCC so
// label variations (SW1 vs SW2) don't affect the match score.
let _templateTextRegions = []; // [{rx,ry,rw,rh,text}]
let _templateDetectedTexts = []; // unique text strings found (e.g., ["HD-1", "HD-2", "HD-3"])

// Extract text from template area using same mechanism as text search
async function extractTemplateText() {
  if (!pdfCurrentPage || !pdfCurrentViewport || !templateSelBoxOriginal) return;

  const cnt = document.getElementById('ignoreTextCount');
  if (cnt) cnt.textContent = '(Finding text in area...)';

  try {
    // Get ALL text from the page (same as text search feature)
    const tc = await pdfCurrentPage.getTextContent();
    const vp = pdfCurrentViewport;

    // CRITICAL: Use viewport's scale, not cached pdfRenderScale
    // The viewport scale is the definitive scale used for convertToViewportPoint()
    const viewportScale = vp.scale || pdfRenderScale || 7.0;

    const { x1, y1, x2, y2 } = templateSelBoxOriginal;
    const padding = Math.max(x2 - x1, y2 - y1) * 0.3; // search area with 30% padding

    const textSet = new Set();

    // Filter to only text items inside/near the template selection box
    tc.items.forEach(item => {
      if (!item.str || !item.str.trim()) return;

      // Convert PDF coordinates to canvas coordinates using the viewport's scale
      // convertToViewportPoint() returns coordinates at viewport.scale
      const pt = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
      const textX = pt[0];
      const textY = pt[1];

      // Check if text falls within template box + padding
      if (textX >= x1 - padding && textX <= x2 + padding &&
          textY >= y1 - padding && textY <= y2 + padding) {
        const textStr = item.str.trim();
        textSet.add(textStr);
      }
    });

    _templateDetectedTexts = Array.from(textSet).slice(0, 15); // limit to 15 for display

    if (_templateDetectedTexts.length > 0) {
      if (cnt) cnt.textContent = `(Found: ${_templateDetectedTexts.join(', ')})`;
      console.log(`[QAQC text] Found ${_templateDetectedTexts.length} text items in template area`);
    } else {
      if (cnt) cnt.textContent = '(No text in this area)';
    }
  } catch (e) {
    console.log('[QAQC text] Error extracting text:', e.message);
    if (cnt) cnt.textContent = '(Text search failed)';
  }
}

// Extract text near each found symbol location for filtering purposes
async function extractTextForFindings() {
  if (!pdfCurrentPage || !findings || findings.length === 0) return;

  try {
    const textContent = await pdfCurrentPage.getTextContent();
    const vp = pdfCurrentViewport;
    if (!vp) return;

    // CRITICAL: Use viewport's scale, not cached pdfRenderScale
    const viewportScale = vp.scale || pdfRenderScale || 7.0;

    // For each finding, extract nearby text (within a search radius)
    findings.forEach(f => {
      f.nearbyText = [];
      const searchRadius = Math.max(100, templateCanvas?.width || 50) * 1.5; // generous search radius

      textContent.items.forEach(item => {
        if (!item.str || !item.str.trim()) return;
        const pt = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
        const cx = pt[0];
        const cy = pt[1];

        // Check if this text is near the finding
        const dist = Math.hypot(cx - f.x, cy - f.y);
        if (dist < searchRadius) {
          f.nearbyText.push(item.str.trim());
        }
      });
    });
  } catch (e) {
    console.log('[QAQC text] Failed to extract text for findings:', e.message);
  }
}

function updateTemplateTextMask(tc) {
  // Use the same simple logic as extractTemplateText() to ensure consistency
  if (!templateSelBoxOriginal || !pdfCurrentViewport) {
    console.log(`[QAQC text mask] Early return: selBox=${!!templateSelBoxOriginal}, vp=${!!pdfCurrentViewport}`);
    return;
  }

  _templateTextRegions = [];
  const vp = pdfCurrentViewport;
  // CRITICAL: Use viewport's scale, not cached pdfRenderScale
  const viewportScale = vp.scale || pdfRenderScale || 7.0;
  const { x1, y1, x2, y2 } = templateSelBoxOriginal;
  const padding = Math.max(x2 - x1, y2 - y1) * 0.3;
  const textSet = new Set();

  console.log(`[QAQC text mask] Searching in box: x1=${x1}, y1=${y1}, x2=${x2}, y2=${y2}, padding=${padding}, viewportScale=${viewportScale}, total items=${tc.items.length}`);

  // Find text items in/near the template box (same logic as extractTemplateText)
  tc.items.forEach((item, idx) => {
    if (!item.str || !item.str.trim()) return;
    const pt = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
    const textX = pt[0];
    const textY = pt[1];

    if (idx < 5) console.log(`[QAQC text mask] Item ${idx}: "${item.str}" at (${textX.toFixed(0)}, ${textY.toFixed(0)})`);

    // Check if text falls within template box + padding
    if (textX >= x1 - padding && textX <= x2 + padding &&
        textY >= y1 - padding && textY <= y2 + padding) {
      const textStr = item.str.trim();
      textSet.add(textStr);
      // Store a simple region entry for masking purposes
      _templateTextRegions.push({ text: textStr });
      console.log(`[QAQC text mask] ✓ Match: "${textStr}"`);
    }
  });

  _templateDetectedTexts = Array.from(textSet).sort();
  console.log(`[QAQC text mask] ${_templateTextRegions.length} text region(s) in template, texts: ${_templateDetectedTexts.join(', ')}`);

  // Update UI
  const lbl = document.getElementById('ignoreTextLabel');
  const cnt = document.getElementById('ignoreTextCount');
  if (lbl) lbl.style.display = 'flex';
  if (cnt) cnt.textContent = _templateTextRegions.length > 0
    ? `(Found: ${_templateDetectedTexts.join(', ')})`
    : '(No text detected)';
}

function onIgnoreTextChange() {
  // If user re-enables and we haven't populated the mask yet, try now
  if (document.getElementById('ignoreTextChk')?.checked && _templateTextRegions.length === 0 && pdfCurrentPage && templateSelBox) {
    pdfCurrentPage.getTextContent().then(tc => updateTemplateTextMask(tc)).catch(() => {});
  }
  // Re-render findings when filter settings change
  if (findings && findings.length > 0) {
    renderFindings();
  }
}

function updateTextFilterBoxVisibility() {
  // Re-render findings when any filter settings change
  // (filter box is now always visible, not conditionally hidden)
  if (findings && findings.length > 0) {
    renderFindings();
  }
}

// Returns a copy of `gray` (Float32Array, w×h) with mask rectangles set to 1.0 (white)
function applyTextMaskToGray(gray, w, h, mask) {
  if (!mask || mask.length === 0) return gray;
  const out = gray.slice();
  for (const { rx, ry, rw, rh } of mask) {
    for (let my = ry; my < ry + rh && my < h; my++) {
      for (let mx = rx; mx < rx + rw && mx < w; mx++) {
        out[my * w + mx] = 1.0; // white
      }
    }
  }
  return out;
}

// Helper: Find all text locations on the page for a given search query
// Returns array of {str, x, y} objects representing text found on the PDF
async function findTextLocationsForFilter(searchQuery) {
  if (!pdfCurrentPage || !pdfCurrentViewport || !searchQuery) {
    console.log('[QAQC filter] Early return: page=', !!pdfCurrentPage, 'vp=', !!pdfCurrentViewport, 'query=', searchQuery);
    return [];
  }

  try {
    // Get all text from the page (same method as text search)
    const tc = await pdfCurrentPage.getTextContent();
    const textItems = tc.items.filter(i => i.str && i.str.trim());

    // Filter by query and convert to canvas coordinates
    const q = searchQuery.toLowerCase();
    const vp = pdfCurrentViewport;

    const results = textItems
      .filter(i => i.str.trim().toLowerCase() === q) // Exact match (trimmed) only, not substring
      .map(i => {
        const pt = vp.convertToViewportPoint(i.transform[4], i.transform[5]);
        return {
          str: i.str.trim(),
          x: pt[0],
          y: pt[1]
        };
      });

    console.log(`[QAQC filter] Searched for "${searchQuery}" in ${textItems.length} total text items`);
    console.log(`[QAQC filter] Found ${results.length} instances of "${searchQuery}" (substring match):`, results.map(r => `"${r.str}" at (${Math.round(r.x)}, ${Math.round(r.y)})`));

    if (results.length === 0) {
      console.warn(`[QAQC filter] WARNING: No text "${searchQuery}" found on page! Check if text extraction is working.`);
    }
    return results;
  } catch (e) {
    console.log('[QAQC filter] Error finding text locations:', e.message);
    return [];
  }
}

function applyTextFilter(findingsList) {
  // Get filter settings
  const ignoreTextChk = document.getElementById('ignoreTextChk')?.checked;
  const filterByTextChk = document.getElementById('filterByTextChk')?.checked;
  const filterByHasTextChk = document.getElementById('filterByHasTextChk')?.checked;
  const textFilterInput = (document.getElementById('textFilterInput')?.value || '').trim();

  // No filters active: return all findings
  if (!ignoreTextChk && !filterByTextChk && !filterByHasTextChk) {
    return findingsList;
  }

  const hasTemplateText = _templateTextRegions && _templateTextRegions.length > 0;

  // Parse comma-separated text filter values
  const filterTexts = textFilterInput
    ? textFilterInput.split(',').map(s => s.trim()).filter(s => s.length > 0)
    : [];

  // For text-based filtering, we need text locations cached from the last search
  // This will be populated by filterFindingsByTextAsync when needed
  const textLocations = window._cachedTextLocations || [];

  console.log(`[QAQC applyTextFilter] ignoreText=${ignoreTextChk}, filterByText=${filterByTextChk}, filterByHasText=${filterByHasTextChk}`);
  console.log(`[QAQC applyTextFilter] textFilterInput="${textFilterInput}", textLocations=${textLocations.length}, findings=${findingsList.length}`);

  let resultCount = 0;

  const filtered = findingsList.filter(f => {
    // FILTER 1: "Ignore text inside" - if template has text, only keep findings with text
    if (ignoreTextChk && hasTemplateText && (!f.nearbyText || f.nearbyText.length === 0)) {
      return false;
    }

    // FILTER 2: "Only find matches with this text" - filter by proximity to text locations
    if (filterByTextChk && filterTexts.length > 0) {
      if (textLocations.length === 0) {
        console.log(`[QAQC applyTextFilter] WARNING: filterByText enabled but no text locations found for: ${filterTexts.join(', ')}`);
        return false; // No text found - filter out this match
      }

      // Search radius: at least as wide as the template was, or 150px minimum
      const searchRadius = Math.max(150, (templateCanvas?.width || 50) * 2);

      // Only keep if this finding is near one of the found text locations
      const isNearText = textLocations.some(textLoc => {
        const dist = Math.hypot(textLoc.x - f.x, textLoc.y - f.y);
        return dist < searchRadius;
      });

      if (!isNearText) {
        console.log(`[QAQC applyTextFilter] Filtering out match at (${Math.round(f.x)}, ${Math.round(f.y)}) - not near any of ${textLocations.length} text locations, searchRadius=${searchRadius}`);
        return false;
      }
    }

    // FILTER 3: "Only find matches with text inside" - DISABLED for now due to coordinate system issues
    // TODO: Fix text extraction and re-enable this filter
    // if (filterByHasTextChk && (!f.nearbyText || f.nearbyText.length === 0)) {
    //   return false;
    // }

    // Passed all filters
    resultCount++;
    return true;
  });

  console.log(`[QAQC applyTextFilter] Result: ${resultCount} of ${findingsList.length} findings passed filters`);
  return filtered;
}

// Async version of filtering that handles text location lookup
async function filterFindingsByTextAsync(findingsList) {
  // Get filter settings
  const filterByTextChk = document.getElementById('filterByTextChk')?.checked;
  const textFilterInput = (document.getElementById('textFilterInput')?.value || '').trim();

  console.log(`[QAQC filterAsync] Starting: filterByTextChk=${filterByTextChk}, textFilterInput="${textFilterInput}"`);

  // If text-based filtering is active, look up text locations first
  if (filterByTextChk && textFilterInput) {
    const filterTexts = textFilterInput.split(',').map(s => s.trim()).filter(s => s.length > 0);
    console.log(`[QAQC filterAsync] Searching for texts:`, filterTexts);

    // Find all text locations for each filter term
    let allTextLocations = [];
    for (const filterText of filterTexts) {
      const locs = await findTextLocationsForFilter(filterText);
      console.log(`[QAQC filterAsync] Found ${locs.length} locations for "${filterText}"`);
      allTextLocations = allTextLocations.concat(locs);
    }

    // Cache for use in applyTextFilter
    window._cachedTextLocations = allTextLocations;
    console.log(`[QAQC filterAsync] Total text locations cached: ${allTextLocations.length}`);
  } else {
    window._cachedTextLocations = [];
    console.log(`[QAQC filterAsync] No text filtering active, clearing cache`);
  }

  // Text-based "only with text" filtering disabled for now — coordinate system issues
  // TODO: Fix coordinate transformation for reliable text extraction

  // Now apply the filter
  return applyTextFilter(findingsList);
}

function detectScoreCutoff(findings) {
  if (_manualCutoff !== null) return Math.min(_manualCutoff, findings.length);
  // DISABLED: Adaptive gap cutoff removed in favor of visual overlap validation
  // Show ALL matches and let overlap checking filter them
  return findings.length;
}

// Find best scale & rotation for a vector match by trying candidates and measuring overlap
function findBestScaleRotation(finding, templateCanvas, pdfCanvas) {
  if (!templateCanvas || !pdfCanvas) return { scale: 1.0, rotDeg: 0 };

  const pctx = pdfCanvas.getContext('2d');
  const TW = templateCanvas.width, TH = templateCanvas.height;
  const pad = Math.max(TW, TH) * 0.5;

  const sx = Math.max(0, Math.round(finding.x - TW/2 - pad));
  const sy = Math.max(0, Math.round(finding.y - TH/2 - pad));
  const sw = Math.min(pdfCanvas.width - sx, Math.round(TW + pad*2));
  const sh = Math.min(pdfCanvas.height - sy, Math.round(TH + pad*2));

  if (sw <= 10 || sh <= 10) return { scale: 1.0, rotDeg: 0 };

  const pdfRegion = pctx.getImageData(sx, sy, sw, sh).data;

  let bestOverlap = 0, bestScale = 1.0, bestRot = 0;
  const SCALES = [0.80, 0.92, 1.0, 1.05, 1.22];
  const ROTS = [0, 45, 90, 135, 180, 225, 270, 315]; // Test all 8 rotations like vector system

  try {
    for (const scale of SCALES) {
      for (const rot of ROTS) {
        const angle = (rot * Math.PI) / 180;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const rotW = Math.round(Math.abs(TW * cos) + Math.abs(TH * sin));
        const rotH = Math.round(Math.abs(TW * sin) + Math.abs(TH * cos));

        const rotCanvas = document.createElement('canvas');
        rotCanvas.width = rotW;
        rotCanvas.height = rotH;
        const rctx = rotCanvas.getContext('2d');
        rctx.translate(rotW / 2, rotH / 2);
        rctx.rotate(angle);
        rctx.drawImage(templateCanvas, -TW / 2, -TH / 2);

        const matchCanvas = document.createElement('canvas');
        matchCanvas.width = sw;
        matchCanvas.height = sh;
        const mctx = matchCanvas.getContext('2d');

        const scaledW = Math.round(rotW * scale);
        const scaledH = Math.round(rotH * scale);
        const offsetX = (sw - scaledW) / 2;
        const offsetY = (sh - scaledH) / 2;

        mctx.drawImage(rotCanvas, offsetX, offsetY, scaledW, scaledH);
        const mData = mctx.getImageData(0, 0, sw, sh).data;

        let overlap = 0, total = 0;
        for (let i = 0; i < mData.length; i += 4) {
          if (mData[i + 3] > 100) {
            total++;
            if (pdfRegion[i + 3] > 100) overlap++;
          }
        }

        if (total > 0) {
          const score = overlap / total;
          if (score > bestOverlap) {
            bestOverlap = score;
            bestScale = scale;
            bestRot = rot;
          }
        }
      }
    }
  } catch (e) {}

  return { scale: bestScale, rotDeg: bestRot };
}

// Calculate visual overlap: extract region, scale template to match, compare pixels across all rotations
function calculateOverlapPercentage(finding, templateCanvas, pdfCanvas, pdfRenderScale) {
  if (!templateCanvas || !pdfCanvas) return 0;

  const pctx = pdfCanvas.getContext('2d');
  const templateW = templateCanvas.width;
  const templateH = templateCanvas.height;
  const pad = Math.max(templateW, templateH) * 0.5;

  // Extract region from PDF centered on finding
  const sx = Math.max(0, Math.round(finding.x - templateW / 2 - pad));
  const sy = Math.max(0, Math.round(finding.y - templateH / 2 - pad));
  const regionW = Math.round(templateW + pad * 2);
  const regionH = Math.round(templateH + pad * 2);

  const sw = Math.min(pdfCanvas.width - sx, regionW);
  const sh = Math.min(pdfCanvas.height - sy, regionH);

  if (sw <= 10 || sh <= 10) return 0;

  try {
    // Get PDF region pixels
    const pdfRegionData = pctx.getImageData(sx, sy, sw, sh);
    const pData = pdfRegionData.data;

    let bestOverlap = 0;
    let bestRot = 0;

    // Try all 8 rotations
    for (let rot = 0; rot < 8; rot++) {
      const angle = rot * 45;

      // Create rotated template
      const rotCanvas = document.createElement('canvas');
      const cos = Math.cos((angle * Math.PI) / 180);
      const sin = Math.sin((angle * Math.PI) / 180);
      const rotW = Math.round(Math.abs(templateW * cos) + Math.abs(templateH * sin));
      const rotH = Math.round(Math.abs(templateW * sin) + Math.abs(templateH * cos));

      rotCanvas.width = rotW;
      rotCanvas.height = rotH;
      const rctx = rotCanvas.getContext('2d');
      rctx.translate(rotW / 2, rotH / 2);
      rctx.rotate((angle * Math.PI) / 180);
      rctx.drawImage(templateCanvas, -templateW / 2, -templateH / 2);

      // Create canvas matching PDF region size, scale template into it
      const matchCanvas = document.createElement('canvas');
      matchCanvas.width = sw;
      matchCanvas.height = sh;
      const mctx = matchCanvas.getContext('2d');

      // Scale rotated template to fit region
      const scaleX = sw / rotW;
      const scaleY = sh / rotH;
      const scale = Math.min(scaleX, scaleY, 1.2); // Don't upscale too much

      const scaledW = Math.round(rotW * scale);
      const scaledH = Math.round(rotH * scale);
      const offsetX = (sw - scaledW) / 2;
      const offsetY = (sh - scaledH) / 2;

      mctx.drawImage(rotCanvas, offsetX, offsetY, scaledW, scaledH);
      const mData = mctx.getImageData(0, 0, sw, sh).data;

      // Pixel-by-pixel comparison: template coverage + extra ink penalty
      let templateInkPixels = 0;
      let intersectionPixels = 0;
      let extraInkPixels = 0;

      for (let i = 0; i < mData.length; i += 4) {
        const tAlpha = mData[i + 3];
        const pAlpha = pData[i + 3];
        const tHasInk = tAlpha > 100;
        const pHasInk = pAlpha > 100;

        if (tHasInk) templateInkPixels++;
        if (tHasInk && pHasInk) intersectionPixels++;
        if (!tHasInk && pHasInk) extraInkPixels++;
      }

      if (templateInkPixels > 0) {
        const templateCoverage = intersectionPixels / templateInkPixels;
        const extraInkRatio = extraInkPixels / templateInkPixels;
        // Penalize extra ink: if it has more extra ink than template ink, score drops fast
        const overlap = templateCoverage * Math.max(0, 1 - extraInkRatio * 0.3);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestRot = angle;
        }
      }
    }

    if (finding.label && finding.label.includes('1')) {
      console.log(`[QAQC overlap DEBUG] ${finding.label}: region=${sw}×${sh}, best_overlap=${(bestOverlap*100).toFixed(1)}%, rot=${bestRot}°`);
    }
    finding.bestRotation = bestRot;
    return bestOverlap;
  } catch (e) {
    console.log('[QAQC overlap] Error:', e.message);
    return 0;
  }
}

async function renderFindings(){
  findingsWrap.style.display='block';bottomBar.classList.add('visible');

  // Apply text filter with async text location lookup for "only find matches with this text"
  let filteredFindings = await filterFindingsByTextAsync(findings);

  // DISABLED: Visual overlap validation was too problematic
  // The vector matching system (overlayCoverage, explainedFrac filters) already handles false positive rejection
  console.log(`[QAQC overlap] DISABLED - relying on vector matching system's built-in filters`);

  // Get filter settings early for reuse
  const filterByTextChk = document.getElementById('filterByTextChk')?.checked;
  const textFilterInput = (document.getElementById('textFilterInput')?.value || '').trim();
  const filterByHasTextChk = document.getElementById('filterByHasTextChk')?.checked;

  // If text filtering is active and findings were filtered, permanently remove non-matching findings
  if (filterByTextChk && textFilterInput && filteredFindings.length < findings.length) {
    console.log(`[QAQC filter] Removing ${findings.length - filteredFindings.length} non-matching findings from array`);
    // Replace findings array with only the filtered ones
    findings = filteredFindings;
    activeIdx = -1; // Reset active selection since indices changed
  }

  // Show "Add more markups" button whenever there are findings
  const ammBtn=document.getElementById('addMoreMarkupsBtn');
  if(ammBtn) ammBtn.style.display=filteredFindings.length>0?'':'none';
  const cutAt = detectScoreCutoff(filteredFindings);
  const belowCount = filteredFindings.length - cutAt;
  const hasCutoff = cutAt < filteredFindings.length;

  // Header: show confident count + toggle if there are probable false positives
  let countText = hasCutoff
    ? `${cutAt} confident match${cutAt!==1?'es':''}`
    : `${filteredFindings.length} match${filteredFindings.length!==1?'es':''} found`;

  // Add filter info to count if any text filter is active
  const filterText = textFilterInput;

  if (filterByTextChk && filterText) {
    countText += ` with text: ${filterText.split(',').map(s => s.trim()).join(', ')}`;
  } else if (filterByHasTextChk) {
    countText += ` (with text)`;
  } else if (filterText && document.getElementById('ignoreTextChk')?.checked) {
    countText += ` containing "${filterText}"`;
  }
  document.getElementById('findingsCount').textContent = countText;

  findingList.innerHTML='';
  updateCalibSummary();
  if(filteredFindings.length===0){
    let noMatchMsg = 'No matches';
    if (filterByTextChk && filterText) {
      noMatchMsg = `No matches with text: ${filterText.split(',').map(s => s.trim()).join(', ')} — try different text.`;
    } else if (filterByHasTextChk) {
      noMatchMsg = 'No matches with text — try unchecking the filter or lowering sensitivity.';
    } else if (filterText && document.getElementById('ignoreTextChk')?.checked) {
      noMatchMsg = `No matches containing "${filterText}" — try different text or leave blank for all variants.`;
    } else {
      noMatchMsg = 'No matches — try lowering sensitivity.';
    }
    findingList.innerHTML=`<div style="font-size:13px;color:#888;padding:8px 0">${noMatchMsg}</div>`;
    return;
  }

  let lastTypeKey=null;
  filteredFindings.forEach((f,i)=>{
    // Insert type group header when type changes
    if(f.typeKey&&f.typeKey!==lastTypeKey){
      lastTypeKey=f.typeKey;
      const hdr=document.createElement('div');
      hdr.style.cssText=`display:flex;align-items:center;gap:6px;margin:${i===0?'0':'8px'} 0 4px;`;
      const dot=document.createElement('span');
      dot.style.cssText=`display:inline-block;width:9px;height:9px;border-radius:2px;background:${f.typeColor||'#0d9488'};flex-shrink:0;`;
      const lbl=document.createElement('span');
      lbl.style.cssText='font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;';
      lbl.textContent=`Type ${f.typeKey}`;
      hdr.appendChild(dot); hdr.appendChild(lbl);
      findingList.appendChild(hdr);
    }

    // Insert separator + toggle + manual adjustment at the cutoff boundary
    if(hasCutoff && i===cutAt){
      const sep=document.createElement('div');
      sep.style.cssText='margin:8px 0 6px;border-top:2px dashed #f59e0b;padding-top:6px;';

      // ▲/▼ manual cutoff adjustment row
      const adjRow=document.createElement('div');
      adjRow.style.cssText='display:flex;align-items:center;gap:5px;margin-bottom:5px;';
      const makeAdj=(label,title,fn)=>{
        const b=document.createElement('button');
        b.textContent=label; b.title=title;
        b.style.cssText='padding:2px 8px;font-size:12px;font-weight:700;background:#fff7e6;border:1px solid #f59e0b;border-radius:5px;cursor:pointer;color:#92400e;';
        b.onclick=fn; return b;
      };
      adjRow.appendChild(makeAdj('▲ More confident','Move cutoff up — include next item as confident',()=>{
        _manualCutoff=Math.min(findings.length, cutAt+1); _showBelowCutoff=false; renderFindings(); drawMarkers(activeIdx);
      }));
      adjRow.appendChild(makeAdj('▼ Fewer confident','Move cutoff down — move last item to false positives',()=>{
        _manualCutoff=Math.max(1, cutAt-1); _showBelowCutoff=false; renderFindings(); drawMarkers(activeIdx);
      }));
      if(_manualCutoff!==null){
        const resetBtn=document.createElement('button');
        resetBtn.textContent='↺ Auto'; resetBtn.title='Reset to auto-detected cutoff';
        resetBtn.style.cssText='padding:2px 8px;font-size:11px;background:none;border:1px solid #ccc;border-radius:5px;cursor:pointer;color:#888;margin-left:2px;';
        resetBtn.onclick=()=>{ _manualCutoff=null; _showBelowCutoff=false; renderFindings(); drawMarkers(activeIdx); };
        adjRow.appendChild(resetBtn);
      }
      sep.appendChild(adjRow);

      const toggleBtn=document.createElement('button');
      toggleBtn.id='cutoffToggleBtn';
      toggleBtn.style.cssText='width:100%;padding:6px 10px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;font-size:11px;font-weight:600;color:#92400e;cursor:pointer;text-align:left;';
      toggleBtn.textContent=_showBelowCutoff
        ? `▲ Hide ${belowCount} possible false positive${belowCount!==1?'s':''}`
        : `▼ Show ${belowCount} possible false positive${belowCount!==1?'s':''}`;
      toggleBtn.onclick=()=>{ _showBelowCutoff=!_showBelowCutoff; renderFindings(); };
      sep.appendChild(toggleBtn);
      findingList.appendChild(sep);
      if(!_showBelowCutoff) return; // skip the rest of the list
    }

    // Skip items below cutoff when collapsed
    if(hasCutoff && i>=cutAt && !_showBelowCutoff) return;

    const div=document.createElement('div');div.className='finding-item';div.onclick=()=>activateFinding(i);
    // Dim probable false positives
    if(hasCutoff && i>=cutAt) div.style.opacity='0.55';
    const extras=[];
    if(f.detail) extras.push(f.detail);
    if(f.visualScore!=null) extras.push(`visual ${Math.round(f.visualScore*100)}%`);
    if(f.scale&&f.scale!==1) extras.push(Math.round(f.scale*100)+'% scale');
    if(f.rotDeg) extras.push(f.rotDeg+'° rotated');
    const badgeColor=f.typeColor||'var(--green)';
    div.innerHTML=`<div class="finding-num" id="fnum-${i}" style="background:${badgeColor}">${i+1}</div><div style="flex:1"><div class="finding-score">${f.label}</div><div class="finding-pos">Score: ${Math.round(f.score*100)}%${extras.length?' · '+extras.join(' · '):''}</div></div><div class="finding-reject" title="Mark as not a match">✕</div>`;
    div.querySelector('.finding-reject').onclick=(e)=>{e.stopPropagation();rejectFinding(i);};
    findingList.appendChild(div);
  });

  // Store filtered findings for marker display and redraw markers to show only filtered results
  filteredFindingsForDisplay = filteredFindings;
  drawMarkers(activeIdx);
}

// Prepare text-based filtering BEFORE running a search
async function prepareTextFilterForSearch() {
  preSearchTextLocations = [];

  const filterByTextChk = document.getElementById('filterByTextChk')?.checked;
  const textFilterInput = (document.getElementById('textFilterInput')?.value || '').trim();

  if (filterByTextChk && textFilterInput && pdfCurrentPage && pdfCurrentViewport) {
    const filterTexts = textFilterInput.split(',').map(s => s.trim()).filter(s => s.length > 0);

    console.log(`[QAQC pre-search] Text filtering enabled for: ${filterTexts.join(', ')}`);

    // Find all text locations for filtering
    for (const filterText of filterTexts) {
      const locs = await findTextLocationsForFilter(filterText);
      preSearchTextLocations = preSearchTextLocations.concat(locs);
    }

    console.log(`[QAQC pre-search] Found ${preSearchTextLocations.length} text locations to filter by`);
  }
}

// Sort findings by their nearby text (for organized inspection)
function sortFindingsByText(findingsArray) {
  return findingsArray.sort((a, b) => {
    const textA = (a.nearbyText?.[0] || '').toString().toLowerCase();
    const textB = (b.nearbyText?.[0] || '').toString().toLowerCase();

    // Try numeric comparison first (e.g., "SF1" vs "SF10")
    const numA = parseInt(textA.replace(/\D/g, ''));
    const numB = parseInt(textB.replace(/\D/g, ''));

    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
      return numA - numB; // Numeric sort
    }

    return textA.localeCompare(textB); // Alphabetic sort
  });
}

// Mark a finding as wrong: pull it out of the active list, keep it around
// only to compute the live score gap below, and redraw immediately so the
// canvas always matches what's in the list.
function rejectFinding(i){
  const removed=findings.splice(i,1)[0];
  if(removed) rejectedFindings.push(removed);
  if(activeIdx===i) activeIdx=-1; else if(activeIdx>i) activeIdx--;
  renderFindings();
  drawMarkers(activeIdx);
  if(searchRegion) drawRegionBox();
}

// Shows the gap (or lack of one) between confirmed-wrong and still-kept
// matches, live, as the user marks things — this is the same check we did
// manually from console output, generalized to any symbol or engine.
function updateCalibSummary(){
  const el=document.getElementById('calibSummary');
  if(!el) return;
  if(rejectedFindings.length===0){ el.style.display='none'; el.className='calib-summary'; return; }
  const highestRejected=Math.max(...rejectedFindings.map(f=>f.score));
  const lowestKept=findings.length?Math.min(...findings.map(f=>f.score)):null;
  const hasVotes=rejectedFindings.every(f=>f.votes!=null)&&findings.every(f=>f.votes!=null);
  const hasOverlay=rejectedFindings.every(f=>f.overlayCoverage!=null)&&findings.every(f=>f.overlayCoverage!=null);

  let txt=`${rejectedFindings.length} marked wrong · highest of those scored ${Math.round(highestRejected*100)}%`;
  if(hasVotes) txt+=` (${Math.max(...rejectedFindings.map(f=>f.votes))} votes)`;

  el.className='calib-summary';
  let scoreGapClean=null;
  if(lowestKept!==null){
    txt+=` · lowest still-kept match: ${Math.round(lowestKept*100)}%`;
    if(hasVotes) txt+=` (${Math.min(...findings.map(f=>f.votes))} votes)`;
    scoreGapClean=highestRejected<lowestKept;
  }

  // Shape-overlay coverage is often a much sharper signal than score or
  // vote count for simple/generic symbols (short lines, small marks),
  // where most candidates end up with near-identical scores and full
  // vote counts — surface it explicitly whenever it's available.
  let overlayGapClean=null;
  if(hasOverlay){
    const highestRejOverlay=Math.max(...rejectedFindings.map(f=>f.overlayCoverage));
    const lowestKeptOverlay=findings.length?Math.min(...findings.map(f=>f.overlayCoverage)):null;
    txt+=`. Shape-overlay: highest rejected ${Math.round(highestRejOverlay*100)}%`;
    if(lowestKeptOverlay!==null){
      txt+=`, lowest kept ${Math.round(lowestKeptOverlay*100)}%`;
      overlayGapClean=highestRejOverlay<lowestKeptOverlay;
    }
  }

  const cleanSignals=[];
  if(scoreGapClean===true) cleanSignals.push('score');
  if(overlayGapClean===true) cleanSignals.push('shape-overlay');
  if(cleanSignals.length){
    txt+=` — ${cleanSignals.join(' and ')} cleanly separate${cleanSignals.length===1?'s':''} them, safe to tighten there.`;
    el.classList.add('gap');
  } else if(scoreGapClean===false||overlayGapClean===false){
    txt+=' — these overlap on every available signal, no clean cutoff yet.';
    el.classList.add('overlap');
  }
  el.textContent=txt;
  el.style.display='block';
}

function activateFinding(i){
  activeIdx=activeIdx===i?-1:i;
  document.querySelectorAll('.finding-item').forEach((el,idx)=>{el.classList.toggle('active',idx===activeIdx);const n=document.getElementById('fnum-'+idx);if(n)n.classList.toggle('active',idx===activeIdx);});
  drawMarkers(activeIdx);
  if(activeIdx>=0){const f=findings[activeIdx];const vp=zoomViewport.getBoundingClientRect();panX=vp.width/2-f.x*scale;panY=vp.height/2-f.y*scale;applyTransform();}
}

// ── Review mode ──
let reviewIdx=0, reviewDecisions=[], reviewQueue=[];
let qaqcReviewPending=false; // when true, endReviewMode chains into type verification

// ── Type color palette (applied after AI JSON is pasted) ──
const TYPE_COLORS=['#2563eb','#dc2626','#d97706','#7c3aed','#0891b2','#be185d','#65a30d','#9333ea','#0e7490','#b45309'];
let currentTypeMap=[]; // [{typeKey,color,count}] — persists so legend survives redraws

function applyTypeColorsFromJSON(jsonStr){
  if(!jsonStr||!jsonStr.trim()) return;
  let qaqcData;
  try{ qaqcData=JSON.parse(jsonStr); }
  catch(e){ return; } // silent on malformed
  const types=Object.keys(qaqcData);
  if(!types.length) return;

  // Assign each finding a typeKey and typeColor sequentially by count
  let cursor=0;
  types.forEach((typeKey,ti)=>{
    const count=(qaqcData[typeKey].count)||0;
    const color=TYPE_COLORS[ti%TYPE_COLORS.length];
    for(let i=0;i<count&&cursor<findings.length;i++,cursor++){
      findings[cursor].typeKey=typeKey;
      findings[cursor].typeColor=color;
      findings[cursor].typeIndex=ti;
    }
  });
  // Any leftover findings get the last type
  if(cursor<findings.length){
    const lastTi=types.length-1;
    for(;cursor<findings.length;cursor++){
      findings[cursor].typeKey=types[lastTi]||'?';
      findings[cursor].typeColor=TYPE_COLORS[lastTi%TYPE_COLORS.length];
      findings[cursor].typeIndex=lastTi;
    }
  }

  // Re-sort: by typeIndex, then by score descending within each type
  findings.sort((a,b)=>{
    const ti=(a.typeIndex??999)-(b.typeIndex??999);
    return ti!==0?ti:b.score-a.score;
  });

  // Build type map for legend
  currentTypeMap=types.map((typeKey,ti)=>({
    typeKey,
    color:TYPE_COLORS[ti%TYPE_COLORS.length],
    count:(qaqcData[typeKey].count)||0
  }));

  drawMarkers(activeIdx);
  if(searchRegion) drawRegionBox();
  renderFindings();
}

async function startReviewMode(){
  // Show overlay immediately with a loading state so there's no blank gap
  const overlay=document.getElementById('reviewOverlay');
  const rc=document.getElementById('reviewCanvas');
  overlay.style.display='flex';
  document.getElementById('reviewSummary').style.display='none';
  document.getElementById('reviewTitle').textContent='Loading review…';
  document.getElementById('reviewProgress').textContent='Preparing all scans…';
  rc.width=320; rc.height=200;
  const rctx=rc.getContext('2d');
  rctx.fillStyle='#f3f4f6'; rctx.fillRect(0,0,rc.width,rc.height);
  rctx.fillStyle='#9ca3af'; rctx.font='14px sans-serif'; rctx.textAlign='center'; rctx.textBaseline='middle';
  rctx.fillText('Loading…', rc.width/2, rc.height/2);

  // Build a unified review queue across ALL stacked sessions
  reviewQueue=[];
  const lastScan=qaqcSession[qaqcSession.length-1];
  for(const scan of qaqcSession){
    // Text search scans are always correct — skip review
    if(scan.isTextSearch) continue;
    const isLive=(scan===lastScan);
    // Use pdfCanvas for the live scan; load baseImg for older ones
    const bgEl=isLive ? pdfCanvas : await new Promise(res=>{
      const img=new Image(); img.onload=()=>res(img); img.src=scan.baseImg;
    });
    const TW=scan.templateSize?.w||(templateCanvas?.width||60);
    const TH=scan.templateSize?.h||(templateCanvas?.height||60);
    const snaps=scan.findingsSnap||[];
    snaps.forEach((f,fi)=>{
      reviewQueue.push({scan, findingIdx:fi, finding:f, bgEl, TW, TH, isLive});
    });
  }
  if(reviewQueue.length===0){
    overlay.style.display='none';
    // If this was triggered as part of the QAQC flow, continue to next step
    if(qaqcReviewPending){ qaqcReviewPending=false; startTypeVerification(); return; }
    if(pendingFieldExport){ const doField=pendingFieldExport; pendingFieldExport=false; if(doField) doExportToFieldApp(); return; }
    showError('No matches to review.'); return;
  }
  reviewIdx=0;
  reviewDecisions=new Array(reviewQueue.length).fill(null);
  renderReviewCard();
}

function renderReviewCard(){
  const item=reviewQueue[reviewIdx];
  const f=item.finding;
  const total=reviewQueue.length;
  const TW=item.TW, TH=item.TH;
  const pad=Math.max(TW,TH)*1.2;
  const cropW=Math.round(TW+pad*2), cropH=Math.round(TH+pad*2);
  const sx=Math.round(f.x-TW/2-pad), sy=Math.round(f.y-TH/2-pad);

  const rc=document.getElementById('reviewCanvas');
  const displayScale=Math.min(480/cropW, 320/cropH, 3);
  rc.width=Math.round(cropW*displayScale);
  rc.height=Math.round(cropH*displayScale);
  const rctx=rc.getContext('2d');
  rctx.imageSmoothingEnabled=true; rctx.imageSmoothingQuality='high';
  rctx.drawImage(item.bgEl,sx,sy,cropW,cropH,0,0,rc.width,rc.height);
  const markerX=(f.x-sx)*displayScale, markerY=(f.y-sy)*displayScale;
  const r=Math.max(rc.width,rc.height)*0.04;
  rctx.beginPath(); rctx.arc(markerX,markerY,r,0,Math.PI*2);
  rctx.strokeStyle='#1a7a4a'; rctx.lineWidth=r*0.35; rctx.stroke();
  rctx.strokeStyle='rgba(26,122,74,0.5)'; rctx.lineWidth=1;
  rctx.beginPath(); rctx.moveTo(markerX-r*2,markerY); rctx.lineTo(markerX+r*2,markerY); rctx.stroke();
  rctx.beginPath(); rctx.moveTo(markerX,markerY-r*2); rctx.lineTo(markerX,markerY+r*2); rctx.stroke();

  const scanLabel=qaqcSession.length>1?` — ${item.scan.query}`:'';
  document.getElementById('reviewTitle').textContent=`Match #${reviewIdx+1}${scanLabel}`;
  document.getElementById('reviewProgress').textContent=`${reviewIdx+1} of ${total} · ${reviewDecisions.filter(d=>d===true).length} kept · ${reviewDecisions.filter(d=>d===false).length} rejected`;
  document.getElementById('reviewScore').textContent=`${Math.round(f.score*100)}%`;
  document.getElementById('reviewDetail').textContent=f.detail||'';
  document.getElementById('reviewProgressBar').style.width=`${(reviewIdx/total)*100}%`;
  document.getElementById('keepBtn').style.opacity=reviewDecisions[reviewIdx]===false?'0.5':'1';
  document.getElementById('rejectBtn').style.opacity=reviewDecisions[reviewIdx]===true?'0.5':'1';
  const bb=document.getElementById('reviewBackBtn');
  if(bb){ bb.disabled=(reviewIdx===0); bb.style.opacity=reviewIdx===0?'0.35':'1'; }
}

function reviewDecision(keep){
  reviewDecisions[reviewIdx]=keep;
  reviewIdx++;
  if(reviewIdx>=reviewQueue.length){
    // Apply decisions to each scan's findingsSnap independently
    const rejectedByQuery={};
    reviewQueue.forEach((item,i)=>{
      if(reviewDecisions[i]===false){
        const k=item.scan.query;
        if(!rejectedByQuery[k]) rejectedByQuery[k]=new Set();
        rejectedByQuery[k].add(item.findingIdx);
      }
    });
    for(const scan of qaqcSession){
      if(scan.isTextSearch) continue; // text search counts are fixed — not reviewed
      const rejSet=rejectedByQuery[scan.query];
      if(scan.findingsSnap){
        scan.findingsSnap=scan.findingsSnap.filter((_,i)=>!rejSet?.has(i));
        scan.findingsCount=scan.findingsSnap.length;
        scan.types.forEach(t=>{ t.count=scan.findingsSnap.filter(f=>f.typeKey===(t.typeKey||t.type)).length; });
      }
      if(scan===qaqcSession[qaqcSession.length-1]){
        // Sync live findings with the last session's updated snap
        const kept=scan.findingsSnap||[];
        const keptSet=new Set(kept.map(f=>`${Math.round(f.x)},${Math.round(f.y)}`));
        findings=findings.filter(f=>keptSet.has(`${Math.round(f.x)},${Math.round(f.y)}`));
        // Sort findings by nearby text for organized inspection
        findings=sortFindingsByText(findings);
      }
    }
    drawMarkers(activeIdx);
    if(searchRegion) drawRegionBox();
    renderFindings();
    document.getElementById('reviewProgressBar').style.width='100%';
    const keptTotal=reviewDecisions.filter(d=>d!==false).length;
    const rejTotal=reviewDecisions.filter(d=>d===false).length;
    const summary=document.getElementById('reviewSummary');
    summary.style.display='block';
    const nextLabel=qaqcReviewPending?' Continuing to type verification…':'';
    summary.textContent=`✓ Review complete — ${keptTotal} kept, ${rejTotal} rejected.${nextLabel}`;
    setTimeout(()=>{
      const doField=pendingFieldExport; // capture before endReviewMode clears it
      endReviewMode();
      if(qaqcReviewPending){ qaqcReviewPending=false; startTypeVerification(); }
      else if(doField){ doExportToFieldApp(); }
    },1500);
    return;
  }
  renderReviewCard();
}

function endReviewMode(){
  document.getElementById('reviewOverlay').style.display='none';
  pendingFieldExport=false; // clear if user exits review early
}

function goBackInReview(){
  if(reviewIdx<=0) return;
  reviewIdx--;
  renderReviewCard();
  const bb=document.getElementById('reviewBackBtn');
  if(bb){ bb.disabled=(reviewIdx===0); bb.style.opacity=reviewIdx===0?'0.35':'1'; }
}

// Keyboard shortcuts for review mode
document.addEventListener('keydown',e=>{
  if(manualMarkupMode&&e.key==='Escape'){ endManualMarkup(); return; }
  if((mode==='placing'||mode==='detail-resize')&&e.key==='Escape'){ cancelPlacedDetail(); return; }
  if(document.getElementById('reviewOverlay').style.display==='none') return;
  if(e.key==='ArrowRight'||e.key==='y'||e.key==='Y') reviewDecision(true);
  if(e.key==='ArrowLeft'||e.key==='n'||e.key==='N') reviewDecision(false);
  if(e.key==='Backspace') goBackInReview();
  if(e.key==='Escape') endReviewMode();
});

// ── QAQC Template Builder ──

// Re-render a marked-up drawing with type-colored circles from stored findings snapshot
// Build a readable crops grid for AI type-reading — wider padding so type labels are visible
function buildTypeReadingGrid(){
  const TW=templateCanvas?templateCanvas.width:60;
  const TH=templateCanvas?templateCanvas.height:60;
  const pad=Math.max(TW,TH)*1.8; // padding to capture type labels near the symbol
  const cropW=Math.round(TW+pad*2), cropH=Math.round(TH+pad*2);
  const cols=Math.min(findings.length,6);
  const rows=Math.ceil(findings.length/cols);
  const gridCanvas=document.createElement('canvas');
  gridCanvas.width=cols*cropW; gridCanvas.height=rows*cropH;
  const gc=gridCanvas.getContext('2d');
  gc.fillStyle='#f8f8f8'; gc.fillRect(0,0,gridCanvas.width,gridCanvas.height);
  findings.forEach((f,i)=>{
    const col=i%cols, row=Math.floor(i/cols);
    const sx=Math.max(0,Math.round(f.x-TW/2-pad));
    const sy=Math.max(0,Math.round(f.y-TH/2-pad));
    const dx=col*cropW, dy=row*cropH;
    gc.drawImage(pdfCanvas,sx,sy,cropW,cropH,dx,dy,cropW,cropH);
    gc.strokeStyle='#bbb'; gc.lineWidth=1; gc.strokeRect(dx,dy,cropW,cropH);
    // Circle number badge
    gc.fillStyle='rgba(0,0,0,0.75)'; gc.fillRect(dx+2,dy+2,26,19);
    gc.fillStyle='#fff'; gc.font='bold 13px sans-serif';
    gc.textAlign='left'; gc.textBaseline='top';
    gc.fillText(String(i+1),dx+5,dy+4);
  });
  // Scale to max 1800px wide — readable but not enormous
  let finalGrid=gridCanvas;
  if(gridCanvas.width>1800){
    const sc=1800/gridCanvas.width;
    const scaled=document.createElement('canvas');
    scaled.width=Math.round(gridCanvas.width*sc); scaled.height=Math.round(gridCanvas.height*sc);
    scaled.getContext('2d').drawImage(gridCanvas,0,0,scaled.width,scaled.height);
    finalGrid=scaled;
  }
  return finalGrid.toDataURL('image/jpeg',0.88);
}

function renderColoredMarkedImg(baseImg,findingsSnap,templateW,templateH){
  return new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      const W=img.width,H=img.height;
      const mc=document.createElement('canvas');
      mc.width=W; mc.height=H;
      const mctx=mc.getContext('2d');
      mctx.drawImage(img,0,0);
      const hw=templateW*0.55,hh=templateH*0.55;
      const fs=Math.max(W,H)*0.0045;
      findingsSnap.forEach((f,i)=>{
        const color=f.typeColor||'#0d9488';
        const x=f.x-hw,y=f.y-hh,w=hw*2,h=hh*2;
        mctx.globalAlpha=0.13; mctx.fillStyle=color; mctx.fillRect(x,y,w,h);
        mctx.globalAlpha=0.55; mctx.strokeStyle=color; mctx.lineWidth=Math.max(W,H)*0.001; mctx.strokeRect(x,y,w,h);
        const lbl=String(i+1);
        mctx.font=`500 ${fs}px Inter,-apple-system,sans-serif`;
        mctx.textAlign='center'; mctx.textBaseline='middle';
        const bw=Math.max(fs*1.6,mctx.measureText(lbl).width+fs*0.8),bh=fs*1.5;
        mctx.globalAlpha=0.65; mctx.fillStyle=color;
        mctx.fillRect(x,y-bh-2,bw,bh);
        mctx.globalAlpha=1; mctx.fillStyle='#fff';
        mctx.fillText(lbl,x+bw/2,y-bh/2-2);
        mctx.globalAlpha=1;
      });
      resolve(mc.toDataURL('image/jpeg',0.85));
    };
    img.src=baseImg;
  });
}

function hexToRgb(hex){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return[r,g,b];}

// ── Step ①: Add scan to session (instant, no AI) ──
function addToQaqcSession(){
  if(findings.length===0){ showError('No findings to add.'); return; }
  const query=document.getElementById('queryInput').value.trim()||'Symbol';

  // Full-res marked-up drawing (for PDF)
  const markedCanvas=document.createElement('canvas');
  markedCanvas.width=pdfCanvas.width; markedCanvas.height=pdfCanvas.height;
  const mctx=markedCanvas.getContext('2d');
  mctx.drawImage(pdfCanvas,0,0); mctx.drawImage(overlayCanvas,0,0);
  const markedUpImg=markedCanvas.toDataURL('image/jpeg',0.85);

  // Thumbnail (for AI call later — 700px wide, very compressed)
  const thumbC=document.createElement('canvas');
  const ts=Math.min(700/pdfCanvas.width,1);
  thumbC.width=Math.round(pdfCanvas.width*ts); thumbC.height=Math.round(pdfCanvas.height*ts);
  const ttx=thumbC.getContext('2d');
  ttx.drawImage(pdfCanvas,0,0,thumbC.width,thumbC.height);
  ttx.drawImage(overlayCanvas,0,0,thumbC.width,thumbC.height);
  const thumbImg=thumbC.toDataURL('image/jpeg',0.40);

  // Detail legend snapshot
  let detailImg=null;
  if(detailLegendCaptured){
    const dlc=document.getElementById('detailLegendCanvas');
    if(dlc) detailImg=dlc.toDataURL('image/jpeg',0.85);
  }

  // Base drawing (no overlay) + findings snapshot — used to re-render with type colors after AI
  const baseImg=pdfCanvas.toDataURL('image/jpeg',0.75);
  const findingsSnap=findings.map(f=>({x:f.x,y:f.y,score:f.score}));
  const templateSize={w:templateCanvas?templateCanvas.width:20,h:templateCanvas?templateCanvas.height:20};
  // Crops grid — wide-padded crops of every finding so AI can read the type label on each symbol
  const cropsGrid=buildTypeReadingGrid();

  const searchRegionSnap=searchRegion?{...searchRegion}:null;
  qaqcSession.push({query,findingsCount:findings.length,markedUpImg,thumbImg,detailImg,types:[],findingsSnap,baseImg,templateSize,cropsGrid,searchRegionSnap,timestamp:new Date().toLocaleString()});

  const statusEl=document.getElementById('qaqcSessionStatus');
  statusEl.style.display='block';
  statusEl.textContent=`${qaqcSession.length} scan${qaqcSession.length!==1?'s':''} queued: ${qaqcSession.map(s=>`${s.query} (${s.findingsCount})${s.isTextSearch?' · text search':''}`).join(' · ')}`;
  document.getElementById('createQaqcBtn').style.display='block';
  document.getElementById('clearQaqcBtn').style.display='block';
  const lastScan=qaqcSession[qaqcSession.length-1];
  if(lastScan&&!lastScan.isTextSearch) document.getElementById('addMissedBtn').style.display='block';
  showStatus(`"${query}" added — ${findings.length} findings. Do another scan or click Analyze & Create.`);
}

function startManualMarkup(){
  manualMarkupMode=true;
  zoomViewport.style.cursor='crosshair';
  zoomViewport.classList.add('selecting');
  document.getElementById('addMoreMarkupsBtn').style.display='none';
  document.getElementById('doneManualBtn').style.display='';
  showBanner('Click on any missed symbols to add them — click ✓ Done when finished');
}

function endManualMarkup(){
  manualMarkupMode=false;
  zoomViewport.style.cursor='grab';
  zoomViewport.classList.remove('selecting');
  document.getElementById('addMoreMarkupsBtn').style.display='';
  document.getElementById('doneManualBtn').style.display='none';
  hideBanner();
  renderFindings();
}

// ── Add missed instances to an already-saved session entry ──
let addMissedSessionIdx = -1;

function startAddMissedToSession(sessionIdx){
  if(sessionIdx<0||sessionIdx>=qaqcSession.length){ showError('No session to patch.'); return; }
  addMissedSessionIdx=sessionIdx;
  manualMarkupMode=true;
  zoomViewport.style.cursor='crosshair';
  zoomViewport.classList.add('selecting');
  document.getElementById('addMissedDoneBtn').style.display='';
  showBanner(`Adding missed instances to "${qaqcSession[sessionIdx].query}" — click each missed symbol, then ✓ Done`);
}

function endAddMissedToSession(){
  const idx=addMissedSessionIdx;
  addMissedSessionIdx=-1;
  manualMarkupMode=false;
  zoomViewport.style.cursor='grab';
  zoomViewport.classList.remove('selecting');
  document.getElementById('addMissedDoneBtn').style.display='none';
  hideBanner();
  if(idx>=0&&idx<qaqcSession.length){
    const s=qaqcSession[idx];
    // Regenerate markedUpImg with updated findingsSnap
    if(s.baseImg&&s.findingsSnap&&s.templateSize){
      renderColoredMarkedImg(s.baseImg,s.findingsSnap,s.templateSize.w,s.templateSize.h).then(img=>{ s.markedUpImg=img; });
    }
    const statusEl=document.getElementById('qaqcSessionStatus');
    statusEl.textContent=`${qaqcSession.length} scan${qaqcSession.length!==1?'s':''} queued: ${qaqcSession.map(s=>`${s.query} (${s.findingsCount})${s.isTextSearch?' · text search':''}`).join(' · ')}`;
  }
  renderFindings();
}

// ── Step ②: AI analysis + PDF generation ──
let includeAIQuestions=true;

function promptAiQuestionsChoice(){
  if(qaqcSession.length===0){ showError('No scans added to session yet.'); return; }
  const apiKey=(document.getElementById('claudeApiKeyInput')?.value||'').replace(/\s/g,'');
  if(!apiKey){ showError('Enter your Claude API key — get one at console.anthropic.com (separate from claude.ai login).'); return; }
  // Only offer AI questions if a detail image was captured — otherwise skip straight to analysis
  const hasDetail=qaqcSession.some(s=>!s.isTextSearch&&s.detailImg);
  if(!hasDetail){
    includeAIQuestions=false;
    createQaqcTemplate();
    return;
  }
  document.getElementById('aiQuestionsChoiceOverlay').style.display='flex';
}


// Extracts the first balanced {...} object from Claude's response text.
// A plain /\{[\s\S]*\}/ regex is greedy — it matches from the first "{" to
// the LAST "}" anywhere in the response, so any trailing note the model
// adds after the JSON (or a stray "}" mentioned in prose) gets swallowed
// into the "JSON" and breaks JSON.parse. This tracks brace depth (and
// skips over quoted strings, so braces inside answer text don't count)
// and stops at the first object that actually balances.
function extractFirstJsonObject(text){
  const start=text.indexOf('{');
  if(start<0) return null;
  let depth=0, inStr=false, esc=false;
  for(let i=start;i<text.length;i++){
    const ch=text[i];
    if(inStr){
      if(esc) esc=false;
      else if(ch==='\\') esc=true;
      else if(ch==='"') inStr=false;
      continue;
    }
    if(ch==='"'){ inStr=true; continue; }
    if(ch==='{') depth++;
    else if(ch==='}'){ depth--; if(depth===0) return text.slice(start,i+1); }
  }
  return null;
}

async function createQaqcTemplate(){
  if(qaqcSession.length===0){ showError('No scans added to session yet.'); return; }

  const apiKey=(document.getElementById('claudeApiKeyInput')?.value||'').replace(/\s/g,'');
  if(!apiKey){ showError('Enter your Claude API key — get one at console.anthropic.com (separate from claude.ai login).'); return; }

  const btn=document.getElementById('createQaqcBtn');
  btn.disabled=true; btn.textContent='Analyzing with AI…';
  showStatus('Sending to Claude for analysis…',true);
  hideError();

  try{
    // ── AI calls: one focused request PER ITEM, so items never mix ──
    // (Previously all items were bundled into one giant call with a shared
    // instruction to "sort each scan independently" — with a fast/cheap model
    // and many images in one context, that's exactly where cross-item
    // contamination creeps in. One call per item makes separation structural
    // instead of relying on the model following instructions.)

    // Legend first (if captured) — only use detail images from TEMPLATE scans, never text search
    const legendSession=qaqcSession.find(s=>!s.isTextSearch&&s.detailImg);

    const templateScans=qaqcSession.filter(s=>!s.isTextSearch&&s.baseImg);
    const aiModel=(document.getElementById('aiModelSelect')?.value)||'claude-haiku-4-5-20251001';
    const isSonnet=aiModel.includes('sonnet');
    const modelLabel=isSonnet?'Sonnet':'Haiku';
    let totalInTok=0, totalOutTok=0;
    const tc=document.getElementById('tokenCounter');

    for(let scanIdx=0;scanIdx<templateScans.length;scanIdx++){
      const s=templateScans[scanIdx];

      // Ask before spending an AI call — some items (e.g. shear walls) are
      // all one type and sorting is just noise. Skip straight to a single
      // type if the user says no, or if there's only one markup anyway.
      const shouldSort = s.findingsSnap.length>1 && await askShouldSortItem(s.query, s.findingsSnap.length);
      if(!shouldSort){
        s.types=[{type:s.query,typeKey:'1',autoNamed:true,count:s.findingsSnap.length,questions:[],description:s.manualNote||''}];
        if(s.findingsSnap) s.findingsSnap.forEach(f=>{ f.typeKey='1'; f.typeColor=TYPE_COLORS[0]; f.typeIndex=0; });
        if(s.baseImg&&s.findingsSnap&&s.templateSize){
          s.markedUpImg=await renderColoredMarkedImg(s.baseImg,s.findingsSnap,s.templateSize.w,s.templateSize.h);
        }
        continue;
      }

      showStatus(`Sending "${s.query}" to Claude for analysis… (${scanIdx+1}/${templateScans.length})`,true);

      const scanMsgContent=[];
      if(legendSession){
        scanMsgContent.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:legendSession.detailImg.split(',')[1]}});
        scanMsgContent.push({type:'text',text:'LEGEND IMAGE: The detail legend / keynote schedule. Read it to identify all symbol type designators (e.g. 1, 2, 3 or A, B, C).'});
      }

      const baseImgEl=await new Promise(res=>{
        const img=new Image();
        img.onload=()=>res(img);
        img.onerror=()=>res(null);            // never hang on a bad/absent image
        setTimeout(()=>res(null),15000);      // hard timeout backstop
        img.src=s.baseImg;
      });
      if(!baseImgEl){ console.warn('[QAQC] sheet image failed to load, skipping:',s.query); continue; }

      // ── Crop tuning ──
      // PAD_RATIO: extra context around each box, as a fraction of the box size
      //   per side. 0.35 keeps the nearby type designator in frame while letting
      //   the symbol dominate. (Was 1.8 -> crop was 4.6x the box, symbol ~22% of frame.)
      // TARGET_PX: long edge of each crop sent to the model. Claude's vision caps
      //   around 1568px, so 1100 is near the useful ceiling without wasting tokens.
      const PAD_RATIO=0.35, TARGET_PX=1100, MAX_UPSCALE=10;
      const TW=s.templateSize.w, TH=s.templateSize.h;
      const maxPx=TARGET_PX;
      const maxCrops=25; // safety cap — beyond this fall back to grid
      // Crop from the live canvas when it's the same sheet: avoids re-compressing
      // an already-lossy JPEG snapshot.
      const cropSrc=(typeof pdfCanvas!=='undefined'&&pdfCanvas&&
                     pdfCanvas.width===baseImgEl.naturalWidth&&
                     pdfCanvas.height===baseImgEl.naturalHeight)?pdfCanvas:baseImgEl;
      const snaps=s.findingsSnap.slice(0,maxCrops);
      scanMsgContent.push({type:'text',text:`${s.findingsSnap.length} symbols below, each labeled with its circle number.`});
      snaps.forEach((f,fi)=>{
        // Manual markups carry their own box size — crop each to its own bounds
        const fw=f.w||TW, fh=f.h||TH;
        const fpad=Math.max(fw,fh)*PAD_RATIO;
        const cW=Math.round(fw+fpad*2), cH=Math.round(fh+fpad*2);
        const sc=Math.min(Math.max(maxPx/cW, maxPx/cH), MAX_UPSCALE);
        const cc=document.createElement('canvas');
        cc.width=Math.round(cW*sc); cc.height=Math.round(cH*sc);
        const ccx=cc.getContext('2d');
        ccx.imageSmoothingEnabled=true; ccx.imageSmoothingQuality='high';
        const sx=Math.max(0,Math.round(f.x-fw/2-fpad));
        const sy=Math.max(0,Math.round(f.y-fh/2-fpad));
        ccx.drawImage(cropSrc,sx,sy,cW,cH,0,0,cc.width,cc.height);
        const cropB64=cc.toDataURL('image/jpeg',0.95).split(',')[1];
        scanMsgContent.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:cropB64}});
        scanMsgContent.push({type:'text',text:`Circle #${fi+1}`});
      });

      scanMsgContent.push({type:'text',text:`You are sorting circled symbols found on a construction drawing, all belonging to the item type "${s.query}" — ${snaps.length} symbol(s) above, each labeled with its circle number.

YOUR JOB: sort the circles into TYPES, so identical items land in the same type and different items land in different types.

STEP 1 — Examine every crop. Two things distinguish one type from another:
  (a) A printed designator on or beside the symbol — a number or letter such as 1, 2, 3, 4 or A, B, C. A hold-down stamped "4" is type 4.
  (b) The visual form of the symbol itself — shape, size, hatching, bolt/fastener count, connection style, orientation.

STEP 2 — Group circles showing the SAME item into one type. Circles that differ — different printed designator, OR a visibly different symbol — go into SEPARATE types. Do not lump everything into a single type just because designators are hard to read: if the symbols visibly differ, split them. Equally, do not invent distinctions that aren't there — if every crop truly shows the same item, one type is correct.

STEP 3 — Key each type by its printed designator when one exists, using the bare character ("4", not "Type 4"). If no designator is visible, key the types "1", "2", "3"… in the order you encounter them.

STEP 4 — Give every type a short descriptive name in "name" saying what the item actually is, using the detail legend if one was provided. Examples: "Type 4 Hold Down", "HDU8 Hold Down", "Double-bolt Anchor". If you genuinely cannot tell, fall back to "${s.query}".

STEP 5 — Every circle number must appear in exactly one type.

${includeAIQuestions&&legendSession?'For each type, write up to 5 specific field inspection questions grounded in the detail legend image provided. Use the detail to understand what the symbol represents (connections, fasteners, clearances, materials, embedment, etc.) and write questions a structural or site inspector would ask when verifying that item in the field. Do not make up product names or specification numbers that are not visible — but DO write practical questions based on what the detail shows.':'Leave the questions array empty [] for every type — the user has not provided a detail image.'}

Respond with ONLY valid JSON, no explanation or markdown:
{"4":{"name":"Type 4 Hold Down","circles":[1,3,5],"questions":["Q1?"]},"6":{"name":"Type 6 Hold Down","circles":[2,4],"questions":["Q1?"]}}

Every circle number must appear in exactly one type.`});

      // "Failed to fetch" is a network-level failure (dropped connection,
      // transient DNS/TLS hiccup) rather than an API error — worth a couple
      // of quiet retries before giving up and losing the whole run.
      let resp, lastNetErr;
      for(let attempt=0;attempt<3;attempt++){
        try{
          resp=await fetch('https://api.anthropic.com/v1/messages',{
            method:'POST',
            headers:{'x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true','content-type':'application/json'},
            body:JSON.stringify({model:aiModel,max_tokens:2000,messages:[{role:'user',content:scanMsgContent}]})
          });
          lastNetErr=null;
          break;
        }catch(networkErr){
          lastNetErr=networkErr;
          if(attempt<2){ showStatus(`Network hiccup sending "${s.query}" — retrying… (${attempt+1}/2)`,true); await new Promise(r=>setTimeout(r,1200)); }
        }
      }
      if(lastNetErr) throw new Error(`Network error for "${s.query}" after 3 attempts: ${lastNetErr.message}`);
      if(!resp.ok){ const e=await resp.text(); throw new Error(`API ${resp.status} for "${s.query}": ${e.slice(0,200)}`); }

      const apiData=await resp.json();
      const usage=apiData.usage||{};
      totalInTok+=usage.input_tokens||0; totalOutTok+=usage.output_tokens||0;
      const costUSD=((totalInTok/1e6)*(isSonnet?3:1))+((totalOutTok/1e6)*(isSonnet?15:5));
      if(tc){ tc.style.display='block'; tc.textContent=`${modelLabel}: ${totalInTok.toLocaleString()} in · ${totalOutTok.toLocaleString()} out · $${costUSD.toFixed(5)}`; }

      const rawText=apiData.content?.[0]?.text?.trim()||'';
      const jsonStr=extractFirstJsonObject(rawText);
      if(!jsonStr) throw new Error(`No JSON in AI response for "${s.query}": `+rawText.slice(0,200));
      const scanData=JSON.parse(jsonStr);

      // ── Apply this item's types immediately — scoped to this scan only ──
      Object.keys(scanData).forEach(k=>{ if(Array.isArray(scanData[k])) scanData[k]={circles:scanData[k]}; });
      const typeKeys=Object.keys(scanData);
      typeKeys.forEach((typeKey,ti)=>{
        const color=TYPE_COLORS[ti%TYPE_COLORS.length];
        (scanData[typeKey].circles||[]).forEach(circNum=>{
          const idx=circNum-1;
          if(s.findingsSnap&&s.findingsSnap[idx]){
            s.findingsSnap[idx].typeKey=typeKey;
            s.findingsSnap[idx].typeColor=color;
            s.findingsSnap[idx].typeIndex=ti;
          }
        });
      });
      if(s.findingsSnap) s.findingsSnap.forEach(f=>{
        if(!f.typeKey&&typeKeys.length>0){
          const ti=typeKeys.length-1;
          f.typeKey=typeKeys[ti]; f.typeColor=TYPE_COLORS[ti%TYPE_COLORS.length]; f.typeIndex=ti;
        }
      });
      s.types=typeKeys.map((typeKey,ti)=>{
        const aiName=String(scanData[typeKey].name||'').trim();
        const isGenericKey=(typeKey==='1'||typeKey==='undefined')&&typeKeys.length===1;
        return {
          type: aiName || (isGenericKey ? s.query : typeKey),
          typeKey: typeKey,
          autoNamed: !aiName && isGenericKey,
          count:(scanData[typeKey].circles||[]).length,
          questions:scanData[typeKey].questions||[],
          description: s.manualNote||''
        };
      });
      if(s.types.length===0) s.types=[{type:s.query,typeKey:'1',autoNamed:true,count:s.findingsCount,questions:[],description:s.manualNote||''}];
      if(s.findingsSnap){
        s.types.forEach(t=>{
          const actual=s.findingsSnap.filter(f=>f.typeKey===t.typeKey).length;
          if(actual>0) t.count=actual;
        });
      }
      if(s.baseImg&&s.findingsSnap&&s.templateSize){
        s.markedUpImg=await renderColoredMarkedImg(s.baseImg,s.findingsSnap,s.templateSize.w,s.templateSize.h);
      }
    }

    // Generate questions for text search scans — only when a detail image exists and user opted in
    const textScans=qaqcSession.filter(s=>s.isTextSearch);
    if(textScans.length>0&&includeAIQuestions&&legendSession){
      try{
        const tqPrompt=textScans.map(s=>`"${s.query}" (${s.findingsCount} instance${s.findingsCount!==1?'s':''})`).join(', ');
        const tqResp=await fetch('https://api.anthropic.com/v1/messages',{
          method:'POST',
          headers:{'x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true','content-type':'application/json'},
          body:JSON.stringify({model:aiModel,max_tokens:800,messages:[{role:'user',content:`You are a construction field inspector. For each of these callout types found on a drawing, write exactly 4 practical field inspection questions a site inspector would ask. Keep questions concise and specific.

Callout types: ${tqPrompt}

Respond ONLY with valid JSON: {"calloutName": ["Q1?","Q2?","Q3?","Q4?"], ...}`}]})
        });
        if(tqResp.ok){
          const tqData=await tqResp.json();
          const tqText=tqData.content?.[0]?.text?.trim()||'';
          const tqJsonStr=extractFirstJsonObject(tqText);
          if(tqJsonStr){
            const tqJson=JSON.parse(tqJsonStr);
            textScans.forEach(s=>{
              s.types=[{type:s.query,autoNamed:true,count:s.findingsCount,
                questions:tqJson[s.query]||tqJson[Object.keys(tqJson).find(k=>k.toLowerCase()===s.query.toLowerCase())]||[]}];
            });
          }
        }
      }catch(e){ /* silent — fall back to empty questions */ }
    }
    // Always ensure all text scans have types set (even if no detail / AI skipped)
    textScans.forEach(s=>{ if(!s.types||!s.types.length) s.types=[{type:s.query,autoNamed:true,count:s.findingsCount,questions:[]}]; });

    // Apply colors to live findings on screen (last session = most recent scan) —
    // types were already assigned to each scan's findingsSnap inline in the loop above.
    const lastS=qaqcSession[qaqcSession.length-1];
    if(lastS&&lastS.findingsSnap&&lastS.findingsSnap.length===findings.length){
      lastS.findingsSnap.forEach((sf,i)=>{ if(findings[i]){ findings[i].typeKey=sf.typeKey; findings[i].typeColor=sf.typeColor; findings[i].typeIndex=sf.typeIndex; }});
      currentTypeMap=(lastS.types||[]).map(t=>({typeKey:t.typeKey,color:TYPE_COLORS[(t.typeIndex||0)%TYPE_COLORS.length],count:t.count}));
      drawMarkers(activeIdx);
      if(searchRegion) drawRegionBox();
      renderFindings();
    }

  } catch(err){
    showError('AI analysis failed: '+err.message);
    btn.disabled=false; btn.innerHTML='📱 Create Inspection';
    return;
  }

  // AI done — re-enable button, then go straight to type verification.
  // (No more one-by-one "Review Match" step here — that was built for
  // verifying vector-scan template matches one at a time, which is pointless
  // for manual markups the user already drew intentionally.)
  btn.disabled=false; btn.innerHTML='📱 Create Inspection';
  showStatus('AI analysis complete — reviewing types now…', true);
  startTypeVerification();
}

function confirmTypesAndGeneratePdf(){
  document.getElementById('typeVerifyOverlay').style.display='none';
  showTemplatePreview(includeAIQuestions);
}

async function generateQaqcPdf(){
  // Gather project info
  const projectName=prompt('Project name:','')||'';
  const sheetNumber=prompt('Sheet number (e.g. S1.0):','')||'';
  const inspector=prompt('Inspector name:','')||'';
  const today=new Date().toLocaleDateString();

  // Check jsPDF is available
  const jspdfLib = window.jspdf || window.jsPDF;
  const jsPDF = jspdfLib ? (jspdfLib.jsPDF || jspdfLib) : null;
  if(!jsPDF){
    showError('PDF library not loaded — check your internet connection and try again.');
    return;
  }

  showStatus('Building PDF — rendering type previews…', true);

  // ── Pre-render example crops for each type ──
  for(const scan of qaqcSession){
    if(!scan.baseImg||!scan.findingsSnap||!scan.templateSize) continue;
    const baseImgEl=await new Promise(res=>{ const img=new Image(); img.onload=()=>res(img); img.src=scan.baseImg; });
    const TW=scan.templateSize.w, TH=scan.templateSize.h;
    const pad=Math.max(TW,TH)*0.4;
    const cropW=Math.round(TW+pad*2), cropH=Math.round(TH+pad*2);
    const dispPx=300;
    const cropScale=Math.max(dispPx/cropW, dispPx/cropH);
    for(const t of scan.types){
      const firstFinding=scan.findingsSnap.find(f=>f.typeKey===t.type);
      if(firstFinding){
        try{
          const cc=document.createElement('canvas');
          cc.width=Math.round(cropW*cropScale); cc.height=Math.round(cropH*cropScale);
          const ccx=cc.getContext('2d');
          const sx=Math.max(0,Math.round(firstFinding.x-TW/2-pad));
          const sy=Math.max(0,Math.round(firstFinding.y-TH/2-pad));
          ccx.drawImage(baseImgEl,sx,sy,cropW,cropH,0,0,cc.width,cc.height);
          t.exampleCrop=cc.toDataURL('image/jpeg',0.9);
        }catch(e){ console.warn('Crop render error:',e); }
      }
    }
    // Pre-render search region crop if available
    if(scan.searchRegionSnap&&scan.markedUpImg){
      try{
        const markupEl=await new Promise(res=>{ const img=new Image(); img.onload=()=>res(img); img.src=scan.markedUpImg; });
        const {x1,y1,x2,y2}=scan.searchRegionSnap;
        const rw=Math.round(x2-x1), rh=Math.round(y2-y1);
        if(rw>10&&rh>10){
          const rc=document.createElement('canvas');
          rc.width=rw; rc.height=rh;
          rc.getContext('2d').drawImage(markupEl,x1,y1,rw,rh,0,0,rw,rh);
          scan.regionCropImg=rc.toDataURL('image/jpeg',0.88);
        }
      }catch(e){ console.warn('Region crop error:',e); }
    }
  }

  try{
  const doc = new jsPDF({ orientation:'landscape', unit:'mm', format:'letter' });
  const PW=279, PH=216, M=12; // letter landscape mm, 12mm margins

  // ── Page 1: Header + summary table ──
  // Header bar
  doc.setFillColor(26,26,26); doc.rect(M,M,PW-M*2,14,'F');
  doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(13);
  doc.text('QAQC FIELD INSPECTION TEMPLATE',M+4,M+9);
  doc.setFontSize(8); doc.setFont('helvetica','normal');
  doc.text(`${projectName||''}  ·  Sheet: ${sheetNumber||'—'}  ·  Inspector: ${inspector||'—'}  ·  Date: ${today}`, M+4, M+13);

  // Table using autoTable
  const tableRows=[];
  let rn=1;
  qaqcSession.forEach(scan=>{
    scan.types.forEach((t,ti)=>{
      const [r,g,b]=hexToRgb(TYPE_COLORS[ti%TYPE_COLORS.length])||[60,60,60];
      // Type header row — one per type, shows real count
      tableRows.push([{
        content:t.autoNamed ? `${t.type}  (${t.count} instance${t.count!==1?'s':''})` : `${scan.query} — Type ${t.type}  (${t.count} instance${t.count!==1?'s':''})`,
        colSpan:7,
        styles:{fillColor:[r,g,b], textColor:[255,255,255], fontStyle:'bold', fontSize:8.5}
      }]);
      // Questions as edited in template preview (count question is already first)
      t.questions.forEach(q=>{
        tableRows.push([rn++, q, '', '','','','']);
      });
    });
  });
  // Blank rows
  tableRows.push([{content:'Additional Field Notes', colSpan:7, styles:{fillColor:[235,235,235], fontStyle:'bold', fontSize:7, textColor:[80,80,80]}}]);
  for(let i=0;i<2;i++) tableRows.push([rn++,'','','','','','']);

  const checkCols=[3,4,5]; // Pass, Fail, N/A column indices
  doc.autoTable({
    startY: M+18,
    head:[['#','Inspection Item','Inspector Notes','Pass','Fail','N/A','PE Notes']],
    body: tableRows,
    styles:{fontSize:8, cellPadding:2.5, valign:'middle', overflow:'linebreak', minCellHeight:7},
    headStyles:{fillColor:[26,26,26], textColor:[255,255,255], fontStyle:'bold', fontSize:8},
    columnStyles:{
      0:{cellWidth:8, halign:'center', fontStyle:'bold'},
      1:{cellWidth:108},
      2:{cellWidth:42},
      3:{cellWidth:14, halign:'center'},
      4:{cellWidth:14, halign:'center'},
      5:{cellWidth:14, halign:'center'},
      6:{cellWidth:42}
    },
    alternateRowStyles:{fillColor:[247,247,247]},
    margin:{left:M, right:M},
    theme:'grid',
    didParseCell:(data)=>{
      // Section header rows — enforce fill color
      if(data.row.raw&&data.row.raw[0]&&typeof data.row.raw[0]==='object'&&data.row.raw[0].colSpan){
        data.cell.styles.fillColor=data.row.raw[0].styles.fillColor;
        data.cell.styles.textColor=data.row.raw[0].styles.textColor||[255,255,255];
      }
    },
    didDrawCell:(data)=>{
      // Draw actual checkbox squares in Pass/Fail/N/A columns
      if(data.section==='body' && checkCols.includes(data.column.index)){
        // Skip section header rows
        if(data.row.raw&&data.row.raw[0]&&typeof data.row.raw[0]==='object'&&data.row.raw[0].colSpan) return;
        const boxSize=4;
        const bx=data.cell.x+(data.cell.width-boxSize)/2;
        const by=data.cell.y+(data.cell.height-boxSize)/2;
        const colors=[[20,122,74],[192,57,43],[100,100,100]];
        const ci=checkCols.indexOf(data.column.index);
        doc.setDrawColor(...colors[ci]);
        doc.setLineWidth(0.4);
        doc.rect(bx,by,boxSize,boxSize);
      }
    }
  });

  // Notes box
  const afterTable = doc.lastAutoTable.finalY + 4;
  doc.setFontSize(7); doc.setFont('helvetica','bold'); doc.setTextColor(255,255,255);
  doc.setFillColor(26,26,26); doc.rect(M, afterTable, PW-M*2, 5, 'F');
  doc.text('GENERAL NOTES', M+2, afterTable+3.5);
  doc.setFillColor(255,255,255); doc.setDrawColor(180,180,180);
  doc.rect(M, afterTable+5, PW-M*2, 18, 'FD');

  // Signature block
  const sigY = afterTable + 26;
  if(sigY < PH - 20){
    const sigLabels=['Inspector Signature','Inspector Name (Print)','PE / EOR Signature','Date of Inspection','Date of PE Review'];
    const sigW=(PW-M*2)/sigLabels.length;
    doc.setTextColor(0,0,0); doc.setDrawColor(120,120,120); doc.setFont('helvetica','normal'); doc.setFontSize(7);
    sigLabels.forEach((lbl,i)=>{
      const sx=M+i*sigW;
      doc.line(sx+2, sigY+10, sx+sigW-4, sigY+10);
      doc.text(lbl, sx+2, sigY+14);
    });
  }

  // ── Subsequent pages: one per scan ──
  for(const scan of qaqcSession){
    doc.addPage('letter','landscape');

    // Page header
    doc.setFillColor(26,26,26); doc.rect(M,M,PW-M*2,10,'F');
    doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(11);
    doc.text(scan.query, M+4, M+7);
    doc.setFont('helvetica','normal'); doc.setFontSize(7);
    const total=scan.types.reduce((a,t)=>a+t.count,0);
    doc.text(`${projectName} · Sheet ${sheetNumber||'—'} · ${total} instances found · ${scan.types.map(t=>(t.autoNamed?`${t.type}: ${t.count}`:`Type ${t.type}: ${t.count})`)).join(' · ')}`, M+4, M+10);

    let contentY = M+14;

    // ── Type reference strip — example crop + detail name per type ──
    if(scan.types.length>0 && scan.types.some(t=>t.exampleCrop)){
      const cropMm=28, labelH=8, cellW=cropMm+4, cellPad=3;
      const stripH=cropMm+labelH;

      scan.types.forEach((t,ti)=>{
        const color=TYPE_COLORS[ti%TYPE_COLORS.length];
        const [r,g,b]=hexToRgb(color)||[13,148,136];
        const cellX=M+ti*(cellW+cellPad);

        // Background swatch bar
        doc.setFillColor(r,g,b); doc.rect(cellX,contentY,cellW,4,'F');

        // Label
        doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(7);
        doc.text(t.autoNamed ? t.type : `Type ${t.type}`, cellX+1, contentY+2.8);

        // Detail name (query) below swatch — omit if autoNamed since type IS the query
        doc.setTextColor(40,40,40); doc.setFont('helvetica','normal'); doc.setFontSize(5.5);
        const detailLabel=t.autoNamed ? `${t.count} instance${t.count!==1?'s':''}` : `${scan.query}  ·  ${t.count} instance${t.count!==1?'s':''}`;
        doc.text(detailLabel, cellX, contentY+4+3.5, {maxWidth:cellW});

        // Example crop image
        if(t.exampleCrop){
          try{
            const imgY=contentY+4+5;
            doc.addImage(t.exampleCrop,'JPEG',cellX,imgY,cropMm,cropMm,'','FAST');
            doc.setDrawColor(r,g,b); doc.setLineWidth(0.4);
            doc.rect(cellX,imgY,cropMm,cropMm);
          }catch(e){ console.warn('Crop img error:',e); }
        }
      });
      contentY+=stripH+6;
    }

    // Detail legend image — preserve aspect ratio
    if(scan.detailImg){
      try{
        const dlc=document.getElementById('detailLegendCanvas');
        const imgW=dlc&&dlc.width?dlc.width:800, imgH=dlc&&dlc.height?dlc.height:200;
        const maxW=PW-M*2, maxH=28;
        const ratio=Math.min(maxW/imgW, maxH/imgH);
        const dw=imgW*ratio, dh=imgH*ratio;
        doc.addImage(scan.detailImg,'JPEG',M,contentY,dw,dh,'','FAST');
        doc.setTextColor(120,120,120); doc.setFontSize(6);
        doc.text('Reference detail / keynote legend', M, contentY+dh+2.5);
        contentY+=dh+5;
      }catch(e){ console.warn('Detail img error:',e); }
    }

    // ── Drawings section: full markup + region crop side by side (or stacked) ──
    const hasRegion=!!(scan.regionCropImg);
    const drawAreaW=PW-M*2;
    const drawAreaH=PH-contentY-M-6;

    if(scan.markedUpImg){
      try{
        const imgW=pdfCanvas.width||7000, imgH=pdfCanvas.height||5000;
        if(hasRegion){
          // Side by side: full markup on left (60%), region crop on right (38%)
          const leftW=Math.round(drawAreaW*0.60);
          const rightW=drawAreaW-leftW-4;

          // Full markup
          const ratioL=Math.min(leftW/imgW, drawAreaH/imgH);
          const dwL=imgW*ratioL, dhL=imgH*ratioL;
          doc.addImage(scan.markedUpImg,'JPEG',M,contentY,dwL,dhL,'','FAST');
          doc.setTextColor(120,120,120); doc.setFontSize(5.5); doc.setFont('helvetica','normal');
          doc.text('Full sheet — color-coded markers by type', M, contentY+dhL+2.5);

          // Region crop
          const {x1,y1,x2,y2}=scan.searchRegionSnap;
          const rw=x2-x1, rh=y2-y1;
          const ratioR=Math.min(rightW/rw, drawAreaH/rh);
          const dwR=rw*ratioR, dhR=rh*ratioR;
          const rxStart=M+leftW+4;
          doc.addImage(scan.regionCropImg,'JPEG',rxStart,contentY,dwR,dhR,'','FAST');
          doc.setDrawColor(180,180,180); doc.setLineWidth(0.3);
          doc.rect(rxStart,contentY,dwR,dhR);
          doc.text('Search area view', rxStart, contentY+dhR+2.5);
        } else {
          // Full markup only
          const ratio=Math.min(drawAreaW/imgW, drawAreaH/imgH);
          const dw=imgW*ratio, dh=imgH*ratio;
          const dx=M+(drawAreaW-dw)/2;
          doc.addImage(scan.markedUpImg,'JPEG',dx,contentY,dw,dh,'','FAST');
          doc.setTextColor(120,120,120); doc.setFontSize(6); doc.setFont('helvetica','normal');
          doc.text('Numbered markers correspond to inspection table · Color-coded by type', M, PH-M-1);
        }
      }catch(e){ console.warn('Drawing img error:',e); }
    }
  }

  doc.save(`QAQC-${(projectName||'project').replace(/\s+/g,'-')}-${sheetNumber||'sheet'}.pdf`);
  showStatus('QAQC PDF downloaded successfully.');
  } catch(err){
    console.error('[QAQC] PDF generation error:', err);
    showError('PDF generation failed: ' + err.message + ' — check the browser console for details.');
  }
}

async function startTypeVerification(){
  _updateTypeVerifyBtn();
  // If every non-text scan has ≤1 type, nothing to verify — go straight to next step
  const verifiableScans = qaqcSession.filter(s => !s.isTextSearch && s.types && s.types.length > 1);
  if(verifiableScans.length === 0){
    if(_inspectionMode) await confirmTypesAndCreateInspection();
    else confirmTypesAndGeneratePdf();
    return;
  }

  const body=document.getElementById('typeVerifyBody');
  body.innerHTML='<div style="text-align:center;padding:24px;color:#9ca3af;font-size:12px;">Building type previews…</div>';
  document.getElementById('typeVerifyOverlay').style.display='block';
  await new Promise(r=>setTimeout(r,30));
  body.innerHTML='';

  // Instruction hint
  const hint=document.createElement('div');
  hint.style.cssText='font-size:11px;color:#6b7280;margin-bottom:12px;padding:8px 10px;background:#f3f4f6;border-radius:6px;';
  hint.textContent='Click any symbol to reassign it to a different type.';
  body.appendChild(hint);

  for(const scan of qaqcSession){
    if(scan.isTextSearch) continue; // text search scans skip type verification
    if(qaqcSession.length>1){
      const scanHdr=document.createElement('div');
      scanHdr.style.cssText='font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;margin:4px 0 10px;padding-top:4px;';
      scanHdr.textContent=scan.query;
      body.appendChild(scanHdr);
    }

    const baseImgEl=await new Promise(res=>{
      const img=new Image(); img.onload=()=>res(img); img.src=scan.baseImg;
    });

    // Helper: render a single type row (reused for initial render and addNewType)
    function renderTypeRow(t, typeIdx){
      const matchKey=t.typeKey||t.type; // original AI key — used for findingsSnap matching
      const typeKey=t.type;             // display name — used for labels
      const color=TYPE_COLORS[typeIdx%TYPE_COLORS.length];
      const TW=scan.templateSize.w, TH=scan.templateSize.h;
      const pad=Math.max(TW,TH)*0.35;
      const cropW=Math.round(TW+pad*2), cropH=Math.round(TH+pad*2);
      const dispSz=150;
      const scale=dispSz/cropW;

      const typeRow=document.createElement('div');
      typeRow.style.cssText='background:#f9fafb;border-radius:8px;padding:10px 12px;margin-bottom:10px;border-left:3px solid '+color+';';

      const typeHdr=document.createElement('div');
      typeHdr.style.cssText='display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;';

      const swatch=document.createElement('span');
      swatch.style.cssText=`display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0;`;

      // Editable type label
      const labelSpan=document.createElement('span');
      labelSpan.className='type-label-text';
      labelSpan.style.cssText='font-size:12px;font-weight:700;color:#111;cursor:pointer;border-bottom:1px dashed #ccc;padding-bottom:1px;';
      labelSpan.title='Click to rename';
      labelSpan.textContent=t.autoNamed ? typeKey : `Type ${typeKey}`;
      labelSpan.addEventListener('click',()=>{
        const inp=document.createElement('input');
        inp.type='text'; inp.value=typeKey;
        inp.style.cssText='font-size:12px;font-weight:700;border:1px solid #2563eb;border-radius:4px;padding:1px 5px;width:60px;outline:none;';
        labelSpan.replaceWith(inp);
        inp.focus(); inp.select();
        const commit=()=>{
          const newKey=inp.value.trim();
          inp.replaceWith(labelSpan);
          if(newKey&&newKey!==typeKey) renameType(scan,matchKey,newKey,typeRow,strip,countEl);
          else labelSpan.textContent=t.autoNamed ? typeKey : `Type ${scan.findingsSnap.find(f=>f.typeKey===matchKey)?.typeKey||typeKey}`;
        };
        inp.addEventListener('blur',commit);
        inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); commit(); } if(e.key==='Escape'){ inp.replaceWith(labelSpan); } });
      });

      const countEl=document.createElement('span');
      countEl.dataset.typecount=`${scan.query}-${matchKey}`;
      countEl.style.cssText='font-size:11px;color:#9ca3af;';
      countEl.textContent=`${t.count} instance${t.count!==1?'s':''}`;

      // Remove type button
      const removeBtn=document.createElement('button');
      removeBtn.style.cssText='margin-left:auto;flex-shrink:0;border:none;background:none;color:#9ca3af;cursor:pointer;font-size:11px;padding:2px 5px;border-radius:4px;';
      removeBtn.textContent='✕ Remove';
      removeBtn.title='Remove this type and its findings';
      removeBtn.addEventListener('mouseenter',()=>{ removeBtn.style.background='#fee2e2'; removeBtn.style.color='#b91c1c'; });
      removeBtn.addEventListener('mouseleave',()=>{ removeBtn.style.background='none'; removeBtn.style.color='#9ca3af'; });
      removeBtn.addEventListener('click',()=>{
        if(!confirm(`Remove "${typeKey}" and its ${t.count} finding${t.count!==1?'s':''}? They will be excluded from the PDF.`)) return;
        // Remove from scan.types
        const tIdx=scan.types.findIndex(x=>x.type===typeKey);
        if(tIdx>=0) scan.types.splice(tIdx,1);
        // Remove findings with this typeKey from findingsSnap (use matchKey for f.typeKey comparison)
        if(scan.findingsSnap) scan.findingsSnap=scan.findingsSnap.filter(f=>f.typeKey!==matchKey);
        scan.findingsCount=scan.findingsSnap?scan.findingsSnap.length:0;
        // Remove from live findings if this is the last session
        const lastS=qaqcSession[qaqcSession.length-1];
        if(scan===lastS){
          findings=findings.filter(f=>f.typeKey!==matchKey);
          currentTypeMap=currentTypeMap.filter(m=>m.typeKey!==matchKey);
          drawMarkers(activeIdx); renderFindings();
        }
        // Re-render markedUpImg async
        if(scan.baseImg&&scan.findingsSnap&&scan.templateSize){
          renderColoredMarkedImg(scan.baseImg,scan.findingsSnap,scan.templateSize.w,scan.templateSize.h).then(img=>{ scan.markedUpImg=img; });
        }
        typeRow.remove();
      });

      typeHdr.appendChild(swatch);
      typeHdr.appendChild(labelSpan);
      typeHdr.appendChild(countEl);
      typeHdr.appendChild(removeBtn);
      typeRow.appendChild(typeHdr);

      const strip=document.createElement('div');
      strip.dataset.typestrip=`${scan.query}-${matchKey}`;
      strip.style.cssText='display:flex;gap:5px;flex-wrap:wrap;min-height:20px;';

      (scan.findingsSnap||[]).forEach((f,idx)=>{
        if(f.typeKey!==matchKey) return;
        strip.appendChild(buildCropWrapper(scan,idx,f,baseImgEl,cropW,cropH,scale,color,pad,TW,TH));
      });

      typeRow.appendChild(strip);
      return typeRow;
    }

    // Render all existing type rows
    for(let ti=0;ti<scan.types.length;ti++){
      body.appendChild(renderTypeRow(scan.types[ti],ti));
    }

    // "+ Add type" button
    const addTypeBtn=document.createElement('button');
    addTypeBtn.style.cssText='display:flex;align-items:center;gap:5px;padding:7px 12px;border:1px dashed #d1d5db;background:none;border-radius:7px;font-size:11px;color:#6b7280;cursor:pointer;margin-bottom:10px;';
    addTypeBtn.innerHTML='＋ Add type';
    addTypeBtn.addEventListener('click',()=>{
      const key=prompt('New type label (number or letter):','');
      if(!key||!key.trim()) return;
      const trimmed=key.trim();
      if(scan.types.find(t=>t.type===trimmed)){ alert(`Type "${trimmed}" already exists.`); return; }
      const newTypeIdx=scan.types.length;
      scan.types.push({type:trimmed,count:0,questions:[]});
      const newRow=renderTypeRow(scan.types[newTypeIdx],newTypeIdx);
      body.insertBefore(newRow,addTypeBtn);
    });
    body.appendChild(addTypeBtn);

    if(scan!==qaqcSession[qaqcSession.length-1]){
      const hr=document.createElement('hr');
      hr.style.cssText='border:none;border-top:1px solid #e5e7eb;margin:12px 0;';
      body.appendChild(hr);
    }
  }
}

function buildCropWrapper(scan,idx,f,baseImgEl,cropW,cropH,scale,color,pad,TW,TH){
  const wrapper=document.createElement('div');
  wrapper.style.cssText='position:relative;display:inline-block;';

  const c=document.createElement('canvas');
  c.width=Math.round(cropW*scale);
  c.height=Math.round(cropH*scale);
  c.style.cssText=`border-radius:4px;border:2px solid ${color};display:block;cursor:pointer;`;
  c.title=`#${idx+1} — click to reassign`;
  c.dataset.finding=`${scan.query}-${idx}`;

  const ctx=c.getContext('2d');
  ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
  const sx=Math.max(0,Math.round(f.x-TW/2-pad));
  const sy=Math.max(0,Math.round(f.y-TH/2-pad));
  ctx.drawImage(baseImgEl,sx,sy,cropW,cropH,0,0,c.width,c.height);
  ctx.fillStyle='rgba(0,0,0,0.72)'; ctx.fillRect(0,0,18,14);
  ctx.fillStyle='#fff'; ctx.font='bold 9px sans-serif';
  ctx.textAlign='left'; ctx.textBaseline='top';
  ctx.fillText(String(idx+1),2,2);

  c.addEventListener('click',()=>{
    document.querySelectorAll('.tv-picker').forEach(p=>p.remove());
    const picker=document.createElement('div');
    picker.className='tv-picker';
    picker.style.cssText='position:absolute;top:100%;left:0;z-index:300;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,0.18);min-width:120px;margin-top:3px;';
    const lbl=document.createElement('div');
    lbl.style.cssText='font-size:9px;color:#9ca3af;padding:2px 4px 4px;border-bottom:1px solid #f3f4f6;margin-bottom:2px;';
    lbl.textContent=`Move #${idx+1} to:`;
    picker.appendChild(lbl);
    scan.types.forEach(t=>{
      const ti=scan.types.indexOf(t);
      const btnColor=TYPE_COLORS[ti%TYPE_COLORS.length];
      const pbtn=document.createElement('button');
      pbtn.style.cssText='display:flex;align-items:center;gap:6px;padding:5px 8px;border:none;background:none;cursor:pointer;border-radius:4px;font-size:11px;color:#111;width:100%;text-align:left;';
      pbtn.innerHTML=`<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${btnColor};flex-shrink:0;"></span>Type ${t.type}`;
      pbtn.onmouseenter=()=>pbtn.style.background='#f3f4f6';
      pbtn.onmouseleave=()=>pbtn.style.background='none';
      pbtn.onclick=(e)=>{ e.stopPropagation(); picker.remove(); reassignFinding(scan,idx,t.type,c); };
      picker.appendChild(pbtn);
    });
    wrapper.appendChild(picker);
    setTimeout(()=>document.addEventListener('click',()=>picker.remove(),{once:true}),0);
  });

  wrapper.appendChild(c);
  return wrapper;
}

function renameType(scan,oldKey,newKey,typeRowEl,stripEl,countEl){
  if(!newKey||newKey===oldKey) return;
  if(scan.types.find(t=>t.type===newKey)){ alert(`Type "${newKey}" already exists.`); return; }

  // Update findingsSnap
  scan.findingsSnap.forEach(f=>{ if(f.typeKey===oldKey) f.typeKey=newKey; });

  // Update scan.types
  const t=scan.types.find(t=>t.type===oldKey);
  if(t) t.type=newKey;

  // Update the label span text
  const lbl=typeRowEl?.querySelector('.type-label-text');
  if(lbl) lbl.textContent=`Type ${newKey}`;

  // Update data attributes so reassign continues to work
  if(stripEl) stripEl.dataset.typestrip=`${scan.query}-${newKey}`;
  if(countEl){ countEl.dataset.typecount=`${scan.query}-${newKey}`; }

  // Update live screen
  const lastS=qaqcSession[qaqcSession.length-1];
  if(scan===lastS){
    findings.forEach(f=>{ if(f.typeKey===oldKey) f.typeKey=newKey; });
    currentTypeMap.forEach(m=>{ if(m.typeKey===oldKey) m.typeKey=newKey; });
    drawMarkers(activeIdx); renderFindings();
  }

  // Re-render PDF image
  if(scan.baseImg&&scan.findingsSnap&&scan.templateSize){
    renderColoredMarkedImg(scan.baseImg,scan.findingsSnap,scan.templateSize.w,scan.templateSize.h)
      .then(img=>{ scan.markedUpImg=img; });
  }
}

function reassignFinding(scan,findingIdx,newTypeKey,canvasEl){
  const oldTypeKey=scan.findingsSnap[findingIdx].typeKey;
  if(oldTypeKey===newTypeKey) return;
  const newTypeIdx=scan.types.findIndex(t=>t.type===newTypeKey);
  const newColor=TYPE_COLORS[Math.max(0,newTypeIdx)%TYPE_COLORS.length];

  // Update snap
  scan.findingsSnap[findingIdx].typeKey=newTypeKey;
  scan.findingsSnap[findingIdx].typeColor=newColor;
  scan.findingsSnap[findingIdx].typeIndex=newTypeIdx;

  // Recount (use matchKey = t.typeKey||t.type for f.typeKey comparison)
  scan.types.forEach(t=>{ const mk=t.typeKey||t.type; t.count=scan.findingsSnap.filter(f=>f.typeKey===mk).length; });

  // Move wrapper in DOM
  const newStrip=document.querySelector(`[data-typestrip="${scan.query}-${newTypeKey}"]`);
  if(newStrip&&canvasEl.parentElement){
    canvasEl.style.borderColor=newColor;
    newStrip.appendChild(canvasEl.parentElement);
  }

  // Update count labels (data-typecount stores matchKey)
  scan.types.forEach(t=>{
    const mk=t.typeKey||t.type;
    const el=document.querySelector(`[data-typecount="${scan.query}-${mk}"]`);
    if(el) el.textContent=`${t.count} instance${t.count!==1?'s':''}`;
  });

  // Update live screen if this is the active scan
  const lastS=qaqcSession[qaqcSession.length-1];
  if(scan===lastS&&findings[findingIdx]){
    findings[findingIdx].typeKey=newTypeKey;
    findings[findingIdx].typeColor=newColor;
    findings[findingIdx].typeIndex=newTypeIdx;
    currentTypeMap=scan.types.map((t,ti)=>({typeKey:t.type,color:TYPE_COLORS[ti%TYPE_COLORS.length],count:t.count}));
    drawMarkers(activeIdx);
    renderFindings();
  }

  // Re-render PDF image async
  if(scan.baseImg&&scan.findingsSnap&&scan.templateSize){
    renderColoredMarkedImg(scan.baseImg,scan.findingsSnap,scan.templateSize.w,scan.templateSize.h)
      .then(img=>{ scan.markedUpImg=img; });
  }
}

function showTemplatePreview(includeAI){
  const body=document.getElementById('templatePreviewBody');
  body.innerHTML='';

  qaqcSession.forEach(scan=>{
    if(qaqcSession.length>1){
      const scanHdr=document.createElement('div');
      scanHdr.style.cssText='display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;padding:6px 10px;background:#f3f4f6;border-radius:5px;';
      const nameSpan=document.createElement('span');
      nameSpan.textContent=scan.query;
      const badge=document.createElement('span');
      badge.textContent=scan.isTextSearch?'TEXT SEARCH':'TEMPLATE MATCH';
      badge.style.cssText=`font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;letter-spacing:0.05em;color:#fff;background:${scan.isTextSearch?'#0891b2':'#7c3aed'};`;
      scanHdr.appendChild(nameSpan);
      scanHdr.appendChild(badge);
      body.appendChild(scanHdr);
    }

    scan.types.forEach((t,ti)=>{
      const color=TYPE_COLORS[ti%TYPE_COLORS.length];
      const typeSection=document.createElement('div');
      typeSection.style.cssText=`margin-bottom:18px;border-left:3px solid ${color};padding-left:12px;`;

      // Type header
      const typeHdr=document.createElement('div');
      typeHdr.style.cssText='display:flex;align-items:center;gap:7px;margin-bottom:10px;';
      typeHdr.innerHTML=`<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0;"></span>`+
        `<span style="font-size:13px;font-weight:700;color:#111;">${t.autoNamed ? t.type : `Type ${t.type}`}</span>`+
        `<span style="font-size:12px;color:#9ca3af;">${t.count} instance${t.count!==1?'s':''}</span>`;
      typeSection.appendChild(typeHdr);

      // Build combined question list: count question first, then AI questions if included
      const countQ=t.autoNamed
        ? `Is there the correct amount of ${t.type}? (${t.count} instance${t.count!==1?'s':''} expected)`
        : `Is there the correct amount of Type ${t.type} ${scan.query}? (${t.count} instance${t.count!==1?'s':''} expected)`;
      const allQs=[countQ,...(includeAI?t.questions:[])];
      // Replace t.questions so PDF generation uses whatever survives editing
      t.questions=allQs;

      const qContainer=document.createElement('div');
      t.questions.forEach(q=>{ qContainer.appendChild(buildQuestionRow(t,q)); });
      typeSection.appendChild(qContainer);

      // + Add question
      const addBtn=document.createElement('button');
      addBtn.style.cssText='display:flex;align-items:center;gap:4px;padding:5px 10px;border:1px dashed #d1d5db;background:none;border-radius:5px;font-size:12px;color:#6b7280;cursor:pointer;margin-top:6px;';
      addBtn.textContent='＋ Add question';
      addBtn.addEventListener('click',()=>{
        const nq=prompt('New inspection question:');
        if(!nq||!nq.trim()) return;
        t.questions.push(nq.trim());
        qContainer.appendChild(buildQuestionRow(t,nq.trim()));
      });
      typeSection.appendChild(addBtn);
      body.appendChild(typeSection);
    });

    if(scan!==qaqcSession[qaqcSession.length-1]){
      const hr=document.createElement('hr');
      hr.style.cssText='border:none;border-top:1px solid #e5e7eb;margin:14px 0;';
      body.appendChild(hr);
    }
  });

  document.getElementById('templatePreviewOverlay').style.display='block';
}

function buildQuestionRow(typeObj,q){
  const row=document.createElement('div');
  row.style.cssText='display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:6px;margin-bottom:4px;background:#fff;border:1px solid #e5e7eb;';
  const xBtn=document.createElement('button');
  xBtn.style.cssText='flex-shrink:0;border:none;background:none;color:#9ca3af;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:3px;margin-top:1px;';
  xBtn.textContent='✕';
  xBtn.title='Discard question';
  xBtn.addEventListener('mouseenter',()=>{ xBtn.style.background='#fee2e2'; xBtn.style.color='#b91c1c'; });
  xBtn.addEventListener('mouseleave',()=>{ xBtn.style.background='none'; xBtn.style.color='#9ca3af'; });
  xBtn.addEventListener('click',()=>{
    const idx=typeObj.questions.indexOf(q);
    if(idx>=0) typeObj.questions.splice(idx,1);
    row.remove();
  });
  const span=document.createElement('span');
  span.style.cssText='font-size:13px;color:#374151;flex:1;line-height:1.55;';
  span.textContent=q;
  row.appendChild(xBtn);
  row.appendChild(span);
  return row;
}

function clearQaqcSession(){
  qaqcSession=[];
  document.getElementById('qaqcSessionStatus').style.display='none';
  document.getElementById('createQaqcBtn').style.display='none';
  document.getElementById('clearQaqcBtn').style.display='none';
  document.getElementById('addMissedBtn').style.display='none';
  document.getElementById('addMissedDoneBtn').style.display='none';
  showStatus('QAQC session cleared.');
}
let textSearchItems=[]; // cached from last getTextContent call
let textSearchHighlights=[]; // current highlighted items

async function extractTextWithOCR(){
  if(!pdfCurrentPage){ return []; }
  try{
    document.getElementById('textSearchStatus').textContent='Running OCR on page...';
    const scale=2; // render at higher res for better OCR
    const viewport=pdfCurrentPage.getViewport({scale});
    const canvas=document.createElement('canvas');
    const ctx=canvas.getContext('2d');
    canvas.width=viewport.width;
    canvas.height=viewport.height;
    const renderTask=pdfCurrentPage.render({canvasContext:ctx, viewport});
    await renderTask.promise;

    // Wait for Tesseract to be ready
    if(!window.Tesseract){
      document.getElementById('textSearchStatus').textContent='Loading OCR library...';
      await new Promise(r=>setTimeout(r,1000));
    }

    const result=await Tesseract.recognize(canvas,'eng');
    const {data}=result;

    // Extract words with their bounding boxes
    const results=[];
    const allWords=[];
    if(data.words && data.words.length>0){
      data.words.forEach(wordData=>{
        allWords.push({text:wordData.text, conf:wordData.confidence});
        if(wordData.text && wordData.text.trim().length>0){
          // Tesseract bbox is in the rendered canvas space (at scale 2)
          // Convert to PDF space: divide by render scale (2)
          const pdfX=(wordData.bbox.x0 + wordData.bbox.x1)/(2*2);
          const pdfY=(wordData.bbox.y0 + wordData.bbox.y1)/(2*2);

          // Convert PDF space to canvas/viewport space using pdfRenderScale
          const canvasX=pdfX*pdfRenderScale;
          const canvasY=pdfY*pdfRenderScale;

          results.push({
            str:wordData.text.trim(),
            x:canvasX,
            y:canvasY,
            transform:null // Mark as OCR result
          });
        }
      });
    }
    console.log('[OCR] Extracted',results.length,'text items from page with coordinates (pdfRenderScale='+pdfRenderScale+')');

    // Check for specific numbers
    const hasNumbers = allWords.filter(w => /\d+/.test(w.text));
    console.log('[OCR] Found',hasNumbers.length,'items with numbers');
    console.log('[OCR] Number items:', hasNumbers.slice(0, 50).map(w => `"${w.text}"(${Math.round(w.confidence)}%)`).join(', '));

    // Also log some random samples to verify extraction is working
    const samples = allWords.slice(Math.max(0, Math.floor(allWords.length/4)), Math.max(0, Math.floor(allWords.length/4)+20));
    console.log('[OCR] Samples from middle:', samples.map(w => `"${w.text}"`).join(', '));

    return results;
  }catch(e){
    console.error('[OCR Error]',e.message);
    document.getElementById('textSearchStatus').textContent='OCR failed: '+e.message;
    return [];
  }
}

async function runTextSearch(){
  const query=document.getElementById('textSearchInput').value.trim();
  if(!query){ clearTextSearch(); return; }
  if(!pdfCurrentPage||!pdfCurrentViewport){ document.getElementById('textSearchStatus').textContent='Upload a PDF first.'; return; }
  document.getElementById('textSearchStatus').textContent='Searching...';

  if(textSearchItems.length===0){
    // Get embedded text
    const tc=await pdfCurrentPage.getTextContent();
    textSearchItems=tc.items.filter(i=>i.str&&i.str.trim());
    console.log('[TextSearch] Embedded text items:',textSearchItems.length);

    // Also run OCR to catch all text
    console.log('[TextSearch] Running OCR in parallel...');
    const ocrItems=await extractTextWithOCR();
    console.log('[TextSearch] OCR found:',ocrItems.length,'items');

    // Merge both sources
    textSearchItems=[...textSearchItems, ...ocrItems];
    console.log('[TextSearch] Total combined items:',textSearchItems.length);
  }

  const q=query.toLowerCase();
  const vp=pdfCurrentViewport;
  // convertToViewportPoint returns coordinates in the viewport's own pixel
  // space. Since the viewport was created at pdfRenderScale (= finalScale),
  // these ARE already canvas pixel coordinates — no further multiplication.
  textSearchHighlights=textSearchItems.filter(i=>i.str.toLowerCase().includes(q)).map((i,idx)=>{
    let x=0,y=0;
    if(i.transform){
      const pt=vp.convertToViewportPoint(i.transform[4], i.transform[5]);
      x=pt[0];y=pt[1];
    }else if(i.x!==undefined && i.y!==undefined){
      // OCR results already have coordinates from Tesseract
      x=i.x;
      y=i.y;
    }
    return {
      str:i.str.trim(),
      x:x,
      y:y,
      transform:i.transform
    };
  });

  drawTextHighlights();
  const resultsEl=document.getElementById('textSearchResults');
  document.getElementById('textSearchStatus').textContent=`${textSearchHighlights.length} match${textSearchHighlights.length!==1?'es':''} found`;
  resultsEl.innerHTML=textSearchHighlights.slice(0,50).map((h,i)=>
    `<div style="padding:2px 0;border-bottom:1px solid #f0f0f0;cursor:pointer;color:#378ADD;" onclick="panToTextResult(${i})">
      ${i+1}. "${h.str}" (${Math.round(h.x)},${Math.round(h.y)})
    </div>`
  ).join('');
  const addBtn=document.getElementById('textSearchAddBtn');
  if(addBtn) addBtn.style.display=textSearchHighlights.length>0?'block':'none';
  const detailWrap=document.getElementById('textSearchDetailWrap');
  if(detailWrap) detailWrap.style.display=textSearchHighlights.length>0?'block':'none';
}

function drawTextHighlights(){
  // Remove the old separate highlight canvas if it exists
  const old=document.getElementById('textHighlightCanvas');
  if(old) old.remove();
  // Redraw regular markers first, then layer text search results on top
  drawMarkers(activeIdx);
  if(searchRegion) drawRegionBox();
  if(textSearchHighlights.length===0) return;
  const W=overlayCanvas.width, H=overlayCanvas.height;
  const r=Math.max(W,H)*0.008; // smaller than template markers so they're distinct
  textSearchHighlights.forEach((h,i)=>{
    octx.globalAlpha=0.9;
    // circle
    octx.beginPath();octx.arc(h.x,h.y,r,0,Math.PI*2);
    octx.strokeStyle='#E8600A';octx.lineWidth=r*0.3;octx.stroke();
    // label badge above
    const fs=Math.max(W,H)*0.009;
    octx.font=`600 ${fs}px -apple-system,sans-serif`;
    octx.textAlign='center';octx.textBaseline='middle';
    const lbl=`"${h.str}"`;
    const tw=octx.measureText(lbl).width;
    const bw=tw+fs*0.8, bh=fs*1.4, bx=h.x-bw/2, by=h.y-r-bh-fs*0.3;
    octx.fillStyle='#E8600A';
    roundRect(octx,bx,by,bw,bh,3);octx.fill();
    octx.fillStyle='#fff';octx.globalAlpha=1;
    octx.fillText(lbl,h.x,by+bh/2);
  });
  octx.globalAlpha=1;
}

function clearTextSearch(){
  textSearchHighlights=[];
  const old=document.getElementById('textHighlightCanvas');
  if(old) old.remove();
  drawMarkers(activeIdx);
  if(searchRegion) drawRegionBox();
  document.getElementById('textSearchStatus').textContent='';
  document.getElementById('textSearchResults').innerHTML='';
  document.getElementById('textSearchInput').value='';
  const addBtn=document.getElementById('textSearchAddBtn');
  if(addBtn) addBtn.style.display='none';
  const detailWrap=document.getElementById('textSearchDetailWrap');
  if(detailWrap) detailWrap.style.display='none';
  clearTextSearchDetail();
}

function handleTextSearchDetailUpload(e){
  const file=e.target.files&&e.target.files[0];
  if(!file) return;
  const reader=new FileReader();
  reader.onload=ev=>{
    textSearchDetailDataUrl=ev.target.result;
    const img=document.getElementById('textSearchDetailImg');
    if(img){ img.src=textSearchDetailDataUrl; }
    const preview=document.getElementById('textSearchDetailPreview');
    if(preview) preview.style.display='block';
    const clearBtn=document.getElementById('textSearchDetailClearBtn');
    if(clearBtn) clearBtn.style.display='';
  };
  reader.readAsDataURL(file);
  // Reset input so same file can be re-selected
  e.target.value='';
}

function clearTextSearchDetail(){
  textSearchDetailDataUrl=null;
  const img=document.getElementById('textSearchDetailImg');
  if(img) img.src='';
  const preview=document.getElementById('textSearchDetailPreview');
  if(preview) preview.style.display='none';
  const clearBtn=document.getElementById('textSearchDetailClearBtn');
  if(clearBtn) clearBtn.style.display='none';
}

function addTextSearchToScan(){
  if(!textSearchHighlights.length){ showError('No text matches to add.'); return; }
  const name=prompt('Name this scan (e.g. "Hold-down callouts"):','');
  if(!name||!name.trim()) return;

  // Push directly — bypass canvas-dependent addToQaqcSession for text search
  const snap=textSearchHighlights.map(h=>({x:h.x,y:h.y,score:1,label:h.str}));
  qaqcSession.push({
    query:name.trim(), findingsCount:snap.length,
    markedUpImg:null, thumbImg:null, detailImg:textSearchDetailDataUrl||null,
    types:[], findingsSnap:snap, baseImg:null,
    templateSize:{w:20,h:20}, cropsGrid:null,
    searchRegionSnap:searchRegion?{...searchRegion}:null,
    timestamp:new Date().toLocaleString(), isTextSearch:true
  });
  clearTextSearchDetail();

  // Show QAQC section + session status + buttons
  const qs=document.getElementById('qaqcSection');
  if(qs) qs.style.display='block';
  const statusEl=document.getElementById('qaqcSessionStatus');
  if(statusEl){
    statusEl.style.display='block';
    statusEl.textContent=`${qaqcSession.length} scan${qaqcSession.length!==1?'s':''} queued: ${qaqcSession.map(s=>`${s.query} (${s.findingsCount})${s.isTextSearch?' · text search':''}`).join(' · ')}`;
  }
  document.getElementById('createQaqcBtn').style.display='block';
  document.getElementById('clearQaqcBtn').style.display='block';
  showStatus(`"${name.trim()}" added — ${snap.length} text match${snap.length!==1?'es':''}.`);

  clearTextSearch();
}

function panToTextResult(i){
  const h=textSearchHighlights[i];
  if(!h) return;
  // Pan the viewport to center on this result
  const vp=document.getElementById('zoomViewport');
  const vpW=vp.clientWidth, vpH=vp.clientHeight;
  panX=vpW/2-h.x*currentScale;
  panY=vpH/2-h.y*currentScale;
  applyTransform();
}

// Also wire Enter key in the search box
document.addEventListener('DOMContentLoaded',()=>{
  const inp=document.getElementById('textSearchInput');
  if(inp) inp.addEventListener('keydown',e=>{ if(e.key==='Enter') runTextSearch(); });
});

// Clear cached text items when a new PDF is loaded
function clearTextCache(){ textSearchItems=[]; textSearchHighlights=[]; }
let isSelectingDetailLegend=false;

function startDetailLegendSelect(){
  isSelectingDetailLegend=true;
  mode='selecting';
  selStart=null; selEnd=null;
  selBand.style.display='none';
  selBandSize.style.display='none';
  zoomViewport.style.cursor='crosshair';
  zoomViewport.classList.add('selecting');
  showBanner('Drag a box around the detail legend or schedule that describes your symbol types');
}

function captureDetailLegend(){
  if(!selStart||!selEnd) return;
  const x1=Math.round(Math.min(selStart.x,selEnd.x)), y1=Math.round(Math.min(selStart.y,selEnd.y));
  const x2=Math.round(Math.max(selStart.x,selEnd.x)), y2=Math.round(Math.max(selStart.y,selEnd.y));
  const w=x2-x1, h=y2-y1;
  if(w<8||h<8){ showError('Selection too small.'); isSelectingDetailLegend=false; return; }
  const dlc=document.getElementById('detailLegendCanvas');
  dlc.width=w; dlc.height=h;
  dlc.getContext('2d').drawImage(pdfCanvas,x1,y1,w,h,0,0,w,h);
  dlc.style.display='block';
  document.getElementById('detailCapturedMsg').style.display='block';
  document.getElementById('detailExportHint')?.style && (document.getElementById('detailExportHint').style.display='block');
  detailLegendCaptured=true;
  _detailRect={x:x1,y:y1,w:w,h:h};
  const _dcb=document.getElementById('detailClearBtn'); if(_dcb) _dcb.style.display='block';
  inspectionItems.forEach(it=>{ if(it.inSession) it.detailImg=_captureDetailImg(); });
  if(typeof syncSessionFromItems==='function') syncSessionFromItems();
  isSelectingDetailLegend=false;
  mode='ready';
  zoomViewport.style.cursor='grab';
  zoomViewport.classList.remove('selecting');
  selBand.style.display='none'; selBandSize.style.display='none';
  hideBanner(); hideError();
  drawMarkers();
}

function clearDetailLegend(){
  detailLegendCaptured=false;
  _detailRect=null;
  const _dcb=document.getElementById('detailClearBtn'); if(_dcb) _dcb.style.display='none';
  inspectionItems.forEach(it=>{ it.detailImg=null; });
  if(typeof syncSessionFromItems==='function') syncSessionFromItems();
  if(typeof drawMarkers==='function') drawMarkers();
  const dlc=document.getElementById('detailLegendCanvas');
  dlc.style.display='none';
  dlc.width=0; dlc.height=0;
  document.getElementById('detailCapturedMsg').style.display='none';
  document.getElementById('detailExportHint')?.style && (document.getElementById('detailExportHint').style.display='none');
}

function skipDetailLegend(){
  clearDetailLegend();
  showStatus('No detail legend — findings will be exported without classification context.');
}

// ── Export numbered grid for AI verification in Claude chat ──
// ── Build a PDF of all match crops (sent to Claude as a document) ──
function buildVerificationGridPdfBase64(){
  const jspdfLib=window.jspdf||window.jsPDF;
  const jsPDF=jspdfLib?(jspdfLib.jsPDF||jspdfLib):null;
  if(!jsPDF) throw new Error('jsPDF not loaded — check internet connection.');

  const TW=templateCanvas?templateCanvas.width:60;
  const TH=templateCanvas?templateCanvas.height:60;
  const pad=Math.max(TW,TH)*0.5;
  const cropW=Math.round(TW+pad*2), cropH=Math.round(TH+pad*2);

  const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  const PW=297, PH=210, M=10;
  const cols=8;
  const cellW=(PW-M*2)/cols;
  const cellH=cellW*(cropH/cropW);
  const labelH=5;
  const rowsPerPage=Math.max(1,Math.floor((PH-M*2)/(cellH+labelH+2)));

  findings.forEach((f,i)=>{
    const pagePos=i%(cols*rowsPerPage);
    if(i>0&&pagePos===0) doc.addPage('a4','landscape');
    const col=pagePos%cols;
    const row=Math.floor(pagePos/cols);

    const cc2=document.createElement('canvas');
    cc2.width=cropW; cc2.height=cropH;
    const cctx=cc2.getContext('2d');
    const sx=Math.round(f.x-TW/2-pad), sy=Math.round(f.y-TH/2-pad);
    cctx.drawImage(pdfCanvas,sx,sy,cropW,cropH,0,0,cropW,cropH);

    const x=M+col*cellW;
    const y=M+row*(cellH+labelH+2);
    doc.addImage(cc2.toDataURL('image/jpeg',0.85),'JPEG',x,y,cellW,cellH);
    doc.setFontSize(6); doc.setTextColor(60,60,60);
    doc.text(`#${i+1}`,x+1,y+cellH+labelH);
  });

  return doc.output('datauristring').split(',')[1];
}

// ── Build a grid image of all findings (kept for exportVerificationGrid) ──
function buildVerificationGridDataUrl(){
  const TW=templateCanvas?templateCanvas.width:60;
  const TH=templateCanvas?templateCanvas.height:60;
  const pad=Math.max(TW,TH)*0.5;
  const cropW=Math.round(TW+pad*2), cropH=Math.round(TH+pad*2);
  const cols=Math.min(findings.length,8);
  const rows=Math.ceil(findings.length/cols);
  const gridCanvas=document.createElement('canvas');
  gridCanvas.width=cols*cropW; gridCanvas.height=rows*cropH;
  const gc=gridCanvas.getContext('2d');
  gc.fillStyle='#fff'; gc.fillRect(0,0,gridCanvas.width,gridCanvas.height);
  findings.forEach((f,i)=>{
    const col=i%cols, row=Math.floor(i/cols);
    const sx=Math.round(f.x-TW/2-pad), sy=Math.round(f.y-TH/2-pad);
    const dx=col*cropW, dy=row*cropH;
    gc.drawImage(pdfCanvas,sx,sy,cropW,cropH,dx,dy,cropW,cropH);
    gc.strokeStyle='#ccc'; gc.lineWidth=1; gc.strokeRect(dx,dy,cropW,cropH);
    gc.fillStyle='rgba(0,0,0,0.7)'; gc.fillRect(dx,dy,24,18);
    gc.fillStyle='#fff'; gc.font='bold 12px sans-serif';
    gc.textAlign='left'; gc.textBaseline='top';
    gc.fillText(String(i+1),dx+3,dy+2);
  });
  let finalGrid=gridCanvas;
  if(gridCanvas.width>1600){
    const sc=1600/gridCanvas.width;
    const scaled=document.createElement('canvas');
    scaled.width=Math.round(gridCanvas.width*sc); scaled.height=Math.round(gridCanvas.height*sc);
    scaled.getContext('2d').drawImage(gridCanvas,0,0,scaled.width,scaled.height);
    finalGrid=scaled;
  }
  return finalGrid.toDataURL('image/jpeg',0.90);
}

// ── Build a 3x enlarged template image for context ──
function buildTemplateDataUrl(){
  if(!templateCanvas) return null;
  const tScale=3;
  const tExp=document.createElement('canvas');
  tExp.width=templateCanvas.width*tScale; tExp.height=templateCanvas.height*tScale;
  const tc=tExp.getContext('2d');
  tc.fillStyle='#fff'; tc.fillRect(0,0,tExp.width,tExp.height);
  tc.imageSmoothingEnabled=false;
  tc.drawImage(templateCanvas,0,0,tExp.width,tExp.height);
  return tExp.toDataURL('image/jpeg',0.95);
}

function exportVerificationGrid() {
  if (findings.length === 0) { showError('No matches to export.'); return; }

  try {
    const query = document.getElementById('queryInput').value.trim() || 'the symbol';
    const TW = templateCanvas ? templateCanvas.width : 60;
    const TH = templateCanvas ? templateCanvas.height : 60;
    const pad = Math.max(TW, TH) * 0.5;
    const cropW = Math.round(TW + pad * 2);
    const cropH = Math.round(TH + pad * 2);

    const cols = Math.min(findings.length, 8);
    const rows = Math.ceil(findings.length / cols);
    const gridCanvas = document.createElement('canvas');
    gridCanvas.width = cols * cropW;
    gridCanvas.height = rows * cropH;
    const gc = gridCanvas.getContext('2d');
    gc.fillStyle = '#fff';
    gc.fillRect(0, 0, gridCanvas.width, gridCanvas.height);

    findings.forEach((f, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const sx = Math.round(f.x - TW/2 - pad), sy = Math.round(f.y - TH/2 - pad);
      const dx = col * cropW, dy = row * cropH;
      gc.drawImage(pdfCanvas, sx, sy, cropW, cropH, dx, dy, cropW, cropH);
      gc.strokeStyle = '#ccc'; gc.lineWidth = 1;
      gc.strokeRect(dx, dy, cropW, cropH);
      gc.fillStyle = 'rgba(0,0,0,0.7)';
      gc.fillRect(dx, dy, 24, 18);
      gc.fillStyle = '#fff'; gc.font = 'bold 12px sans-serif';
      gc.textAlign = 'left'; gc.textBaseline = 'top';
      gc.fillText(String(i+1), dx+3, dy+2);
    });

    // Downscale if too wide
    let finalGrid = gridCanvas;
    if (gridCanvas.width > 1600) {
      const sc = 1600 / gridCanvas.width;
      const scaled = document.createElement('canvas');
      scaled.width = Math.round(gridCanvas.width * sc);
      scaled.height = Math.round(gridCanvas.height * sc);
      scaled.getContext('2d').drawImage(gridCanvas, 0, 0, scaled.width, scaled.height);
      finalGrid = scaled;
    }

    const a = document.createElement('a');
    a.download = `verify-grid-${findings.length}matches.jpg`;
    a.href = finalGrid.toDataURL('image/jpeg', 0.90);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Also export the template preview so Claude can compare against it
    if(templateCanvas){
      // Draw template on white background at 3x for visibility
      const tScale=3;
      const tExp=document.createElement('canvas');
      tExp.width=templateCanvas.width*tScale; tExp.height=templateCanvas.height*tScale;
      const tc=tExp.getContext('2d');
      tc.fillStyle='#fff'; tc.fillRect(0,0,tExp.width,tExp.height);
      tc.imageSmoothingEnabled=false;
      tc.drawImage(templateCanvas,0,0,tExp.width,tExp.height);
      const ta=document.createElement('a');
      ta.download=`template-symbol.jpg`;
      ta.href=tExp.toDataURL('image/jpeg',0.95);
      document.body.appendChild(ta); ta.click(); document.body.removeChild(ta);
    }

    // Also export the detail legend if one was captured
    if(detailLegendCaptured){
      const dlc=document.getElementById('detailLegendCanvas');
      const b=document.createElement('a');
      b.download=`detail-legend.jpg`;
      b.href=dlc.toDataURL('image/jpeg',0.92);
      document.body.appendChild(b);
      b.click();
      document.body.removeChild(b);
      showStatus(`3 files exported: grid, template symbol, detail legend. Upload ALL to Claude — it will verify each cell matches the template, read the labels, and extract specs from the legend.`);
    } else {
      showStatus(`2 files exported: grid + template symbol. Upload both to Claude — it will verify each cell matches the template and read the labels.`);
    }
  } catch(err) {
    showError('Export failed: ' + err.message);
  }
}

function resetAll(){
  findings=[];rejectedFindings=[];activeIdx=-1;templateCanvas=null;originalTemplateCanvas=null;templateCanvas2=null;
  templateSelBox=null;templateSelBox2=null;
  templateCaptureId=0;
  const badge=document.getElementById('captureIdBadge'); if(badge) badge.textContent='No template captured yet';
  debugMode=false;debugScoreAtFn=null;pdfCurrentPage=null;pdfCurrentViewport=null;pdfRenderScale=7.0;
  mode='idle';selStart=selEnd=null;searchRegion=null;
  octx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
  selBand.style.display='none';selBandSize.style.display='none';
  instrSelect.classList.remove('active');instrReady.classList.remove('active');
  examplePreview.style.display='none';step2Wrap.style.display='none';
  document.getElementById('regionPreview').style.display='none';
  document.getElementById('template2Wrap').style.display='none';
  document.getElementById('addTemplate2Hint').style.display='none';
  document.getElementById('detailCaptureWrap').style.display='none';
  clearDetailLegend();
  findingsWrap.style.display='none';bottomBar.classList.remove('visible');
  progressWrap.style.display='none';zoomViewport.style.cursor='grab';zoomViewport.classList.remove('selecting');
  findBtn.disabled=false;document.getElementById('step1Btn').disabled=false;
  document.getElementById('verifyBtn')?.style && (document.getElementById('verifyBtn').style.display='none');
  // Clear placement state (but keep detailsFolder — persists across drawings)
  activePlacement=null; placingDetail=null;
  document.getElementById('detailPlacementBar').style.display='none';
  document.getElementById('detailFolderPanel').style.display='none';
  // Restore upload overlay so user can drop a new file
  uploadOverlay.classList.remove('hidden');
  // Show items management UI
  document.getElementById('itemsManagementUI').style.display = 'block';
  document.getElementById('sidebarOriginal').style.display = 'none';
  document.getElementById('methodOptionsUI').style.display = 'none';
  document.getElementById('markupsListUI').style.display = 'none';
  hideError();hideStatus();hideBanner();
}

function exportImage(){
  const merged=document.createElement('canvas');merged.width=pdfCanvas.width;merged.height=pdfCanvas.height;
  const mc=merged.getContext('2d');mc.drawImage(pdfCanvas,0,0);mc.drawImage(overlayCanvas,0,0);
  const a=document.createElement('a');a.download='qaqc-markup.jpg';a.href=merged.toDataURL('image/jpeg',0.95);a.click();
}

function exportToFieldApp(){
  const hasVisualFindings = findings.length > 0;

  // Gather text findings: from already-added sessions OR from live search results
  const textSessions = qaqcSession.filter(s => s.isTextSearch && (s.findingsSnap||[]).length > 0);
  const liveText = (typeof textSearchHighlights !== 'undefined') ? textSearchHighlights : [];
  const hasTextFindings = textSessions.length > 0 || liveText.length > 0;

  if(!hasVisualFindings && !hasTextFindings){
    alert('Run a scan or a text search first before exporting.'); return;
  }

  // ── Text-search-only path — no review needed ──
  if(!hasVisualFindings){
    const COLOR_CYCLE = ['#2563eb','#dc2626','#d97706','#7c3aed','#0891b2','#be185d','#65a30d'];
    findings = [];

    // Use already-added sessions first
    textSessions.forEach((scan, si) => {
      const color = COLOR_CYCLE[si % COLOR_CYCLE.length];
      (scan.findingsSnap||[]).forEach((f, i) => {
        findings.push({ x:f.x, y:f.y, score:1,
          label: f.label||(scan.query+' '+(i+1)),
          typeKey: scan.query, typeColor: color, typeIndex: si });
      });
      if(!scan.types||!scan.types.length)
        scan.types=[{type:scan.query,typeKey:scan.query,autoNamed:true,count:(scan.findingsSnap||[]).length,questions:[]}];
    });

    // If no sessions yet, pull from live textSearchHighlights
    if(!textSessions.length && liveText.length){
      const query = (document.getElementById('textSearchInput')?.value||'Text Search').trim();
      const color = COLOR_CYCLE[0];
      liveText.forEach((h, i) => {
        findings.push({ x:h.x, y:h.y, score:1,
          label: h.str||(query+' '+(i+1)),
          typeKey: query, typeColor: color, typeIndex: 0 });
      });
      qaqcSession.push({
        query, isTextSearch:true, findingsCount:liveText.length,
        findingsSnap: liveText.map(h=>({x:h.x,y:h.y,score:1,label:h.str})),
        types:[{type:query,typeKey:query,autoNamed:true,count:liveText.length,questions:[]}],
        templateSize:{w:20,h:20}, baseImg:null
      });
    }

    showBanner('Creating inspection…');
    doExportToFieldApp();
    return;
  }

  // ── Visual scan path ──
  pendingFieldExport = true;
  const hasSnaps = qaqcSession.some(s => !s.isTextSearch && (s.findingsSnap||[]).length > 0);
  if(!hasSnaps){
    const TW = templateCanvas ? templateCanvas.width : 60;
    const TH = templateCanvas ? templateCanvas.height : 60;
    const textOnly = qaqcSession.filter(s => s.isTextSearch);
    qaqcSession = [...textOnly, {
      query:'Inspection', isTextSearch:false, baseImg:null,
      findingsSnap: findings.slice(),
      templateSize:{w:TW,h:TH}, types:[]
    }];
  }
  showBanner("Review each markup — keep or reject, then your inspection will be created");
  startReviewMode();
}

// Flatten everything in the session (manual items + template/text scans) into
// one export list. Falls back to the legacy global `findings` for the old flow.
function _buildExportFindings(){
  const out=[];
  if(typeof qaqcSession!=='undefined' && qaqcSession.length){
    qaqcSession.forEach(scan=>{
      // AI returns types as 1-based circle numbers into findingsSnap
      const circleType={};
      (scan.types||[]).forEach(t=>{
        const key=t.typeKey||t.type;
        (t.circles||[]).forEach(c=>{ circleType[c]=key; });
      });
      (scan.findingsSnap||[]).forEach((f,i)=>{
        out.push({
          x:f.x, y:f.y,
          w:f.w||null, h:f.h||null,
          score:f.score||1,
          label:f.label||(scan.query+' '+(i+1)),
          typeKey:f.typeKey||circleType[i+1]||scan.query,
          typeColor:f.typeColor||scan.color||null,
          query:scan.query
        });
      });
    });
  }
  if(!out.length && typeof findings!=='undefined' && findings.length){
    findings.forEach((f,i)=>out.push({
      x:f.x, y:f.y, w:null, h:null,
      score:f.score||1,
      label:f.label||('Match #'+(i+1)),
      typeKey:f.typeKey||null, typeColor:f.typeColor||null, query:null
    }));
  }
  return out;
}

function doExportToFieldApp(){
  const exportFindings=_buildExportFindings();
  if(!exportFindings.length){ showBanner('No markups to export — add at least one item to the session.'); return; }
  showStatus('Preparing field app export…', true);

  // ── Build typeInfo map from qaqcSession ──
  // Each type gets its display name, color, and AI-generated inspection questions
  const typeInfoMap = {};
  qaqcSession.forEach(scan => {
    (scan.types || []).forEach((t, ti) => {
      const key = t.typeKey || t.type;
      if (!typeInfoMap[key]) {
        typeInfoMap[key] = {
          name: t.autoNamed ? scan.query : (t.type || key),
          color: TYPE_COLORS[ti % TYPE_COLORS.length],
          questions: t.questions || [],
          description: t.description || '',
          query: scan.query
        };
      }
    });
  });

  // Manual items (and anything the AI didn't classify) still need a typeInfo entry
  exportFindings.forEach(f=>{
    if(f.typeKey && !typeInfoMap[f.typeKey]){
      typeInfoMap[f.typeKey]={
        name: f.query||f.typeKey,
        color: f.typeColor||'#0d9488',
        questions: [], description: '',
        query: f.query||f.typeKey
      };
    }
  });

  // ── Template reference image ──
  const templateDataUrl = templateCanvas ? templateCanvas.toDataURL('image/png') : null;

  // Resize drawing — cap longest side at 5000px so inspections stay sharp when zoomed in
  const MAX = 5000;
  const longestSide = Math.max(pdfCanvas.width, pdfCanvas.height);
  const ratio = Math.min(1, MAX / longestSide);
  const W = Math.round(pdfCanvas.width * ratio);
  const H = Math.round(pdfCanvas.height * ratio);
  const thumb = document.createElement('canvas');
  thumb.width = W; thumb.height = H;
  const tc = thumb.getContext('2d');
  tc.drawImage(pdfCanvas, 0, 0, W, H);
  const imageDataUrl = thumb.toDataURL('image/jpeg', 0.90);

  // Template half-dimensions for marker box sizing
  const TW = templateCanvas ? templateCanvas.width : 40;
  const TH = templateCanvas ? templateCanvas.height : 40;
  const hw = TW * 0.55, hh = TH * 0.55;

  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    drawingName: document.title || 'Drawing',
    imageWidth: W,
    imageHeight: H,
    imageDataUrl,
    templateDataUrl,   // reference symbol image
    typeInfo: typeInfoMap, // AI type metadata
    findings: exportFindings.map((f, i) => {
      const tInfo = typeInfoMap[f.typeKey] || {};
      const bw = f.w || (hw * 2), bh = f.h || (hh * 2);
      return {
        id: i,
        label: f.label || ('Match #' + (i + 1)),
        typeKey: f.typeKey || null,
        typeName: tInfo.name || f.typeKey || f.label || ('Match #' + (i + 1)),
        description: tInfo.description || '',
        questions: tInfo.questions || [],
        questionChecks: (tInfo.questions || []).map(() => null),
        score: Math.round((f.score || 1) * 100),
        color: f.typeColor || tInfo.color || '#0d9488',
        xPct: f.x / pdfCanvas.width,
        yPct: f.y / pdfCanvas.height,
        wPct: bw / pdfCanvas.width,
        hPct: bh / pdfCanvas.height,
        photos: [],
        notes: '',
        status: null  // null=unchecked, 'pass', 'fail'
      };
    })
  };
  const jsonStr = JSON.stringify(payload);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  hideStatus();

  // Save to Supabase if logged in, otherwise fall back to local download
  if (_sb && _sbUser) {
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const name = (payload.drawingName||'inspection').replace(/[^a-z0-9_\-]/gi,'_');
    const path = _sbUser.id + '/' + ts + '_' + name + '.json';
    _sb.storage.from('inspections').upload(path, blob, { contentType: 'application/json', upsert: false })
      .then(({ error }) => {
        if (error) {
          // Fall back to download if upload fails
          const a = document.createElement('a');
          a.download = 'inspection.json'; a.href = URL.createObjectURL(blob); a.click();
          showBanner('⚠️ Cloud save failed — downloaded locally instead');
        } else {
          showBanner('✓ Inspection created — open the Field App on your phone to access it');
        }
      });
  } else {
    // Not logged in — download locally
    const a = document.createElement('a');
    a.download = 'inspection.json'; a.href = URL.createObjectURL(blob); a.click();
    showBanner('📱 inspection.json downloaded — log in to save inspections to the cloud');
  }
}

// ── Import field report JSON + generate PDF ──
function importFieldReport(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const payload = JSON.parse(ev.target.result);
      if (!payload.findings || !payload.imageDataUrl) throw new Error('Not a valid field report file.');
      generateFieldReport(payload);
    } catch(e) {
      showError('Could not read field report: ' + e.message);
    }
  };
  reader.readAsText(file);
}

async function generateFieldReport(payload) {
  const jspdfLib = window.jspdf || window.jsPDF;
  const jsPDF = jspdfLib ? (jspdfLib.jsPDF || jspdfLib) : null;
  if (!jsPDF) { showError('PDF library not loaded — check your internet connection.'); return; }

  showStatus('Building field report…', true);

  // Prefer the original full-res pdfCanvas if a drawing is already loaded in the app —
  // it's much sharper than the 2000px compressed JPEG embedded in the field JSON.
  const useNativeCanvas = pdfCanvas && pdfCanvas.width > 100;
  const NW = useNativeCanvas ? pdfCanvas.width  : payload.imageWidth  || 2000;
  const NH = useNativeCanvas ? pdfCanvas.height : payload.imageHeight || 1000;

  // Still need an Image for the overview page (addImage requires Image or dataUrl)
  const drawingImg = await new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = useNativeCanvas ? pdfCanvas.toDataURL('image/jpeg', 0.92) : payload.imageDataUrl;
  });

  // Pre-render a zoomed crop for each finding
  for (const f of payload.findings) {
    const cx = f.xPct * NW, cy = f.yPct * NH;
    const fw = f.wPct * NW, fh = f.hPct * NH;
    const pad = Math.max(fw, fh) * 1.4;
    const sx = Math.max(0, cx - fw/2 - pad);
    const sy = Math.max(0, cy - fh/2 - pad);
    const sw = Math.min(NW - sx, fw + pad*2);
    const sh = Math.min(NH - sy, fh + pad*2);
    const SIZE = 1200; // high-res crop for sharp PDF output
    const cc = document.createElement('canvas');
    cc.width = SIZE; cc.height = SIZE;
    const ctx = cc.getContext('2d');
    ctx.fillStyle = '#f4f6fa';
    ctx.fillRect(0, 0, SIZE, SIZE);
    const sc = Math.min(SIZE/sw, SIZE/sh);
    const dw = Math.round(sw*sc), dh = Math.round(sh*sc);
    // Draw from native canvas if available, else from the loaded Image
    ctx.drawImage(useNativeCanvas ? pdfCanvas : drawingImg, sx, sy, sw, sh, (SIZE-dw)/2, (SIZE-dh)/2, dw, dh);
    // Circle marker
    const mx = (cx-sx)*sc + (SIZE-dw)/2;
    const my = (cy-sy)*sc + (SIZE-dh)/2;
    ctx.beginPath(); ctx.arc(mx, my, SIZE*0.045, 0, Math.PI*2);
    const col = f.status==='pass'?'#16a34a':f.status==='fail'?'#dc2626':(f.color||'#0d9488');
    ctx.strokeStyle = col; ctx.lineWidth = Math.round(SIZE*0.008); ctx.stroke();
    ctx.fillStyle = col; ctx.globalAlpha = 0.15;
    ctx.fill(); ctx.globalAlpha = 1;
    f._crop = cc.toDataURL('image/jpeg', 0.92);

    // Pre-load each field photo to get its natural dimensions (for aspect-ratio-correct PDF placement)
    f._photoSizes = [];
    for (const photoUrl of (f.photos || [])) {
      const dims = await new Promise(res => {
        const pi = new Image();
        pi.onload = () => res({ w: pi.naturalWidth, h: pi.naturalHeight });
        pi.onerror = () => res({ w: 1, h: 1 });
        pi.src = photoUrl;
      });
      f._photoSizes.push(dims);
    }
  }

  const projectName = prompt('Project name:', '') || '';
  const inspector   = prompt('Inspector name:', '') || '';
  const today = new Date().toLocaleDateString();

  const doc = new jsPDF({ orientation:'landscape', unit:'mm', format:'letter' });
  const PW=279, PH=216, M=14;

  const total      = payload.findings.length;
  const passed     = payload.findings.filter(f=>f.status==='pass').length;
  const failed     = payload.findings.filter(f=>f.status==='fail').length;
  const notDone    = total - passed - failed;
  const passPct    = total ? Math.round(passed/total*100) : 0;

  // ── Page 1: Summary + overview ──
  // Header bar
  doc.setFillColor(15,39,68);
  doc.rect(M,M,PW-M*2,18,'F');
  doc.setTextColor(255,255,255);
  doc.setFont('helvetica','bold'); doc.setFontSize(15);
  doc.text('QAQC FIELD INSPECTION REPORT', M+5, M+10);
  doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
  doc.text(`Project: ${projectName||'—'}  ·  Inspector: ${inspector||'—'}  ·  Date: ${today}`, M+5, M+16);

  // Stat boxes
  const statY = M+24, statW = (PW-M*2)/4, statH = 28;
  const statDefs = [
    { label:'PASSED',      val:passed,  bg:[220,252,231], fg:[22,163,74]  },
    { label:'FAILED',      val:failed,  bg:[254,226,226], fg:[220,38,38]  },
    { label:'NOT REVIEWED',val:notDone, bg:[243,244,246], fg:[100,116,139]},
    { label:'PASS RATE',   val:passPct+'%', bg:[239,246,255], fg:[37,99,235]},
  ];
  statDefs.forEach((s,i) => {
    const x = M + i*(statW);
    doc.setFillColor(...s.bg); doc.roundedRect(x, statY, statW-3, statH, 2,2,'F');
    doc.setTextColor(...s.fg); doc.setFont('helvetica','bold'); doc.setFontSize(22);
    doc.text(String(s.val), x+statW/2-1.5, statY+17, {align:'center'});
    doc.setFontSize(7); doc.text(s.label, x+statW/2-1.5, statY+24, {align:'center'});
  });

  // Drawing overview with dots
  const ovY = statY+statH+6, ovH = PH-ovY-M, ovW = PW-M*2;
  const imgAR = NW/NH, boxAR = ovW/ovH;
  let iw, ih;
  if(imgAR>boxAR){ iw=ovW; ih=ovW/imgAR; } else { ih=ovH; iw=ovH*imgAR; }
  const ix=M+(ovW-iw)/2, iy=ovY+(ovH-ih)/2;
  doc.addImage(payload.imageDataUrl,'JPEG',ix,iy,iw,ih);
  // Draw finding dots
  payload.findings.forEach((f,i) => {
    const dx = ix + f.xPct*iw, dy = iy + f.yPct*ih;
    const [r,g,b] = f.status==='pass'?[22,163,74]:f.status==='fail'?[220,38,38]:[150,150,150];
    doc.setFillColor(r,g,b); doc.circle(dx, dy, 2.2,'F');
    doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(4.5);
    doc.text(String(i+1), dx, dy+1.2, {align:'center'});
  });

  // ── Page 2: Type breakdown + inspection questions (same format as QAQC checklist) ──
  const typeInfo = payload.typeInfo || {};
  const typeKeys = Object.keys(typeInfo);
  if (typeKeys.length > 0 && typeof doc.autoTable === 'function') {
    doc.addPage();

    // Page header
    doc.setFillColor(15,39,68);
    doc.rect(M, M, PW-M*2, 14, 'F');
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold'); doc.setFontSize(12);
    doc.text('INSPECTION CHECKLIST & FIELD RESULTS', M+4, M+9);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
    doc.text(`Project: ${projectName||'—'}  ·  Inspector: ${inspector||'—'}  ·  Date: ${today}`, M+4, M+13);

    const tableRows = [];
    let qn = 1;

    typeKeys.forEach(typeKey => {
      const tInfo = typeInfo[typeKey];
      const typeFindings = payload.findings.filter(f => f.typeKey === typeKey);
      const typePassed  = typeFindings.filter(f => f.status === 'pass').length;
      const typeFailed  = typeFindings.filter(f => f.status === 'fail').length;
      const typeTotal   = typeFindings.length;
      const [r,g,b] = hexToRgb(tInfo.color || '#0d9488') || [13,148,136];

      // Type header row
      const passRate = typeTotal ? Math.round(typePassed/typeTotal*100) : 0;
      tableRows.push([{
        content: `${tInfo.name}  —  ${typeTotal} instance${typeTotal!==1?'s':''}  ·  ✓ ${typePassed} passed  ·  ✗ ${typeFailed} failed  ·  ${passRate}% pass rate`,
        colSpan: 6,
        styles: { fillColor:[r,g,b], textColor:[255,255,255], fontStyle:'bold', fontSize:8.5 }
      }]);

      const questions = tInfo.questions || [];
      if (questions.length === 0) {
        tableRows.push([{ content:'No inspection questions defined for this type.', colSpan:6,
          styles:{ textColor:[150,150,150], fontSize:7, fontStyle:'italic', cellPadding:3 } }]);
      } else {
        questions.forEach((q, qi) => {
          // Tally yes/no/unchecked across all findings of this type
          let yes=0, no=0;
          typeFindings.forEach(f => {
            const chk = (f.questionChecks||[])[qi];
            if(chk===true) yes++; else if(chk===false) no++;
          });
          const tally = typeTotal > 1
            ? (yes+no > 0 ? `${yes} Yes / ${no} No` : '—')
            : '';
          tableRows.push([qn++, q, tally, '', '', '']);
        });
      }
    });

    // Extra notes rows
    tableRows.push([{ content:'Additional Field Notes', colSpan:6,
      styles:{ fillColor:[235,235,235], fontStyle:'bold', fontSize:7, textColor:[80,80,80] } }]);
    for(let i=0;i<3;i++) tableRows.push([qn++,'','','','','']);

    doc.autoTable({
      startY: M+16,
      head:[['#','Inspection Item','Field Tally','Pass','Fail','PE Notes']],
      body: tableRows,
      styles:{ fontSize:8, cellPadding:2.5, valign:'middle', overflow:'linebreak', minCellHeight:7 },
      headStyles:{ fillColor:[26,26,26], textColor:[255,255,255], fontStyle:'bold', fontSize:8 },
      columnStyles:{
        0:{ cellWidth:8,  halign:'center', fontStyle:'bold' },
        1:{ cellWidth:'auto' },
        2:{ cellWidth:28, halign:'center', textColor:[60,80,100] },
        3:{ cellWidth:14, halign:'center' },
        4:{ cellWidth:14, halign:'center' },
        5:{ cellWidth:30 },
      },
      margin:{ top:M, left:M, right:M },
      didDrawCell(data) {
        // Draw checkbox squares in Pass/Fail columns for question rows
        if((data.column.index===3||data.column.index===4) && data.row.section==='body' && typeof data.row.raw[0]==='number'){
          const {x,y,width,height} = data.cell;
          const sz=4, bx=x+width/2-sz/2, by=y+height/2-sz/2;
          doc.setDrawColor(180,180,180); doc.setLineWidth(0.3);
          doc.rect(bx,by,sz,sz,'S');
        }
      }
    });
  }

  // ── Finding cards — 3 cols × 2 rows = 6 per page ──
  const COLS=3, ROWS=2;
  const GAP=4;
  const cardW=(PW-M*2-(COLS-1)*GAP)/COLS;
  const cardH=(PH-M*2-(ROWS-1)*GAP)/ROWS;

  doc.addPage();
  let ci=0;
  for(const [i,f] of payload.findings.entries()) {
    if(ci>0 && ci%(COLS*ROWS)===0) doc.addPage();
    const col = ci%COLS, row = Math.floor((ci%(COLS*ROWS))/COLS);
    const cx2 = M + col*(cardW+GAP), cy2 = M + row*(cardH+GAP);

    // Card bg
    doc.setFillColor(248,250,252); doc.roundedRect(cx2,cy2,cardW,cardH,2,2,'F');
    doc.setDrawColor(220,226,239); doc.setLineWidth(0.25);
    doc.roundedRect(cx2,cy2,cardW,cardH,2,2,'S');

    // Status bar
    const [sr,sg,sb] = f.status==='pass'?[22,163,74]:f.status==='fail'?[220,38,38]:[160,160,160];
    doc.setFillColor(sr,sg,sb);
    doc.roundedRect(cx2,cy2,cardW,9,2,2,'F');
    doc.rect(cx2,cy2+5,cardW,4,'F');
    doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(8);
    const statusTxt = f.status==='pass'?'✓  PASS':f.status==='fail'?'✗  FAIL':'○  NOT REVIEWED';
    doc.text(`#${i+1}  ${statusTxt}`, cx2+3, cy2+6);

    // Label + score row
    const headerH = 9;
    const labelY = cy2 + headerH + 5;
    doc.setTextColor(26,34,52); doc.setFont('helvetica','bold'); doc.setFontSize(7.5);
    const lbl = (f.label||'Match #'+(i+1));
    doc.text(lbl.length>32?lbl.slice(0,29)+'…':lbl, cx2+3, labelY);
    doc.setFont('helvetica','normal'); doc.setFontSize(6); doc.setTextColor(90,100,120);
    doc.text('Confidence: '+f.score+'%', cx2+3, labelY+5);

    // Notes (below label, before images)
    const notesH = f.notes ? 8 : 0;
    const notesY = labelY + 7;
    if(f.notes) {
      doc.setTextColor(50,60,80); doc.setFont('helvetica','italic'); doc.setFontSize(6);
      const note = f.notes.length>80?f.notes.slice(0,77)+'…':f.notes;
      const noteLines = doc.splitTextToSize(note, cardW-6);
      doc.text(noteLines.slice(0,2), cx2+3, notesY+3);
    }

    // ── Image area: two columns side by side ──
    const imgAreaY = notesY + notesH + 2;
    const imgAreaH = cardH - (imgAreaY - cy2) - 2;
    const hasPhoto = f.photos && f.photos.length > 0;

    if (hasPhoto) {
      // Split: drawing crop left (48%), field photo right (48%), gap 4%
      const colGap = 2;
      const halfW = (cardW - 4 - colGap) / 2;

      // Left: drawing crop label + image
      doc.setFontSize(5.5); doc.setFont('helvetica','bold'); doc.setTextColor(140,150,170);
      doc.text('DRAWING', cx2+2, imgAreaY+4);
      const cropBoxY = imgAreaY + 6;
      const cropBoxH = imgAreaH - 6;
      if(f._crop) doc.addImage(f._crop,'JPEG', cx2+2, cropBoxY, halfW, cropBoxH);

      // Right: field photo label + image (aspect-ratio correct)
      const photoColX = cx2 + 2 + halfW + colGap;
      doc.setFontSize(5.5); doc.setFont('helvetica','bold'); doc.setTextColor(140,150,170);
      doc.text('FIELD PHOTO', photoColX, imgAreaY+4);
      const photoBoxY = imgAreaY + 6;
      const photoBoxH = imgAreaH - 6;
      try {
        const ps = (f._photoSizes && f._photoSizes[0]) || { w: 4, h: 3 };
        const photoAR = ps.w / ps.h;
        let pw, ph;
        if (photoAR > halfW / photoBoxH) { pw = halfW; ph = halfW / photoAR; }
        else                              { ph = photoBoxH; pw = photoBoxH * photoAR; }
        const px = photoColX + (halfW - pw) / 2;
        const py = photoBoxY + (photoBoxH - ph) / 2;
        doc.addImage(f.photos[0], 'JPEG', px, py, pw, ph);
        if(f.photos.length > 1) {
          doc.setFillColor(0,0,0,0.6); doc.setTextColor(255,255,255);
          doc.setFontSize(5.5); doc.setFont('helvetica','bold');
          doc.text(`+${f.photos.length-1}`, photoColX+halfW-8, photoBoxY+photoBoxH-2);
        }
      } catch(e) { /* skip bad photo */ }

    } else {
      // No photo — drawing crop takes full width
      doc.setFontSize(5.5); doc.setFont('helvetica','bold'); doc.setTextColor(140,150,170);
      doc.text('DRAWING', cx2+2, imgAreaY+4);
      if(f._crop) doc.addImage(f._crop,'JPEG', cx2+2, imgAreaY+6, cardW-4, imgAreaH-6);
    }
    ci++;
  }

  doc.save('field_inspection_report.pdf');
  hideStatus();
  showBanner('✓ Field inspection report PDF saved');
}

function setQuery(q){document.getElementById('queryInput').value=q;}
function showError(msg){errorEl.textContent=msg;errorEl.style.display='block';}
function hideError(){errorEl.style.display='none';}
function showStatus(msg,loading=false){statusEl.style.display='flex';statusEl.innerHTML=loading?`<div class="spinner"></div>${msg}`:msg;}
function hideStatus(){statusEl.style.display='none';}
function showBanner(msg){canvasBanner.textContent=msg;canvasBanner.classList.add('visible');}
function hideBanner(){canvasBanner.classList.remove('visible');}
function startSelecting(){
  const query=document.getElementById('queryInput').value.trim();
  if(!query){showError('Name what you are looking for first.');return;}
  hideError();mode='selecting';zoomViewport.style.cursor='crosshair';zoomViewport.classList.add('selecting');
  instrSelect.classList.add('active');instrReady.classList.remove('active');
  examplePreview.style.display='none';step2Wrap.style.display='none';
  findingsWrap.style.display='none';bottomBar.classList.remove('visible');
  findings=[];rejectedFindings=[];templateCanvas=null;originalTemplateCanvas=null;templateSelBox=null;
  octx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
  showBanner('Zoom in on the symbol, then drag to select it tightly');
}
function reselect(){templateCanvas=null;originalTemplateCanvas=null;templateSelBox=null;startSelecting();}

