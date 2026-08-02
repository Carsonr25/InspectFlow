// ═══════════════════════════════════════════════════════════════════
//  FIELD APP VIEWER — pan/zoom inspection view for mobile
// ═══════════════════════════════════════════════════════════════════
let _fieldData = null, _fieldActiveIdx = null, _fieldCurrentPath = null;
let _fScale = 1, _fPanX = 0, _fPanY = 0;
let _fPinching = false, _fPinchDist = 0, _fPinchScale = 1;
let _fDragging = false, _fDragStart = null;
let _fPointers = {};
// Badge screen positions are recomputed from these canvas-space (fixed)
// coordinates on every pan/zoom — see _fApply(). Badges live OUTSIDE the
// transformed drawing layer now (sibling in the DOM, see index.html), so
// their own CSS size is completely unaffected by the drawing's zoom.
let _fBadgePts = []; // [{el, cx, cy}]

// Lazy getters — elements live inside #fieldWrap which isn't in DOM at script parse time
function _fViewer() { return document.getElementById('fieldViewerWrap'); }
function _fLayer()  { return document.getElementById('fieldDrawingLayer'); }
function _fCanvas() { return document.getElementById('fieldDrawingCanvas'); }

function _fApply() {
  _fLayer().style.transform = `translate(${_fPanX}px,${_fPanY}px) scale(${_fScale})`;
  // Badges are positioned in real screen pixels, mapped from their fixed
  // canvas-space point through the current pan/scale — same math the CSS
  // transform above does for the drawing, just applied manually so the
  // badge elements themselves never get any scale applied to their size.
  _fBadgePts.forEach(({el, cx, cy}) => {
    el.style.left = (cx * _fScale + _fPanX) + 'px';
    el.style.top  = (cy * _fScale + _fPanY) + 'px';
  });
}
function _fZoom(cx, cy, factor) {
  const ns = Math.min(8, Math.max(0.2, _fScale * factor));
  const r = ns / _fScale;
  _fPanX = cx - r*(cx - _fPanX); _fPanY = cy - r*(cy - _fPanY);
  _fScale = ns; _fApply();
}
function _fFit(_retries) {
  const vw = _fViewer().clientWidth, vh = _fViewer().clientHeight;
  const iw = _fCanvas().width, ih = _fCanvas().height;
  if (!iw || !ih) return;
  // The viewer container can still report 0 size for a frame or two right
  // after showField() flips it to display:flex — mobile Safari in particular
  // doesn't always have the flex layout settled by the time this runs. That
  // silently produced scale = Math.min(0/iw, 0/ih) = 0, i.e. the drawing was
  // rendered correctly but made invisible (scale(0)), with no error thrown
  // anywhere — exactly the "blank, no crash" symptom. Retry a few frames
  // instead of computing a zero scale.
  if (!vw || !vh) {
    const n = (_retries || 0) + 1;
    if (n <= 30) requestAnimationFrame(() => _fFit(n));
    return;
  }
  _fScale = Math.min(vw/iw, vh/ih) * 0.95;
  _fPanX = (vw - iw*_fScale)/2; _fPanY = (vh - ih*_fScale)/2;
  _fApply();
}

// Touch/pointer events attached once when field viewer first opens
function _fAttachEvents() {
  const v = _fViewer();
  if (v._eventsAttached) return;
  v._eventsAttached = true;
  // Stop sheet/scrim pointer events from triggering pan/zoom
  ['fieldSheet','fieldScrim'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('pointerdown', e => e.stopPropagation());
  });
  v.addEventListener('pointerdown', e => {
    _fPointers[e.pointerId] = {x:e.clientX, y:e.clientY};
    const pts = Object.values(_fPointers);
    if (pts.length === 2) {
      _fPinching = true; _fDragging = false;
      _fPinchDist = Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y);
      _fPinchScale = _fScale;
    } else {
      _fDragging = true;
      _fDragStart = {x: e.clientX - _fPanX, y: e.clientY - _fPanY};
    }
  });
  v.addEventListener('pointermove', e => {
    _fPointers[e.pointerId] = {x:e.clientX, y:e.clientY};
    const pts = Object.values(_fPointers);
    if (_fPinching && pts.length === 2) {
      const dist = Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y);
      const mid  = {x:(pts[0].x+pts[1].x)/2, y:(pts[0].y+pts[1].y)/2};
      const ns = Math.min(8, Math.max(0.2, _fPinchScale * dist / _fPinchDist));
      const r = ns / _fScale;
      _fPanX = mid.x - r*(mid.x - _fPanX); _fPanY = mid.y - r*(mid.y - _fPanY);
      _fScale = ns; _fApply();
    } else if (_fDragging && _fDragStart && pts.length === 1) {
      _fPanX = e.clientX - _fDragStart.x; _fPanY = e.clientY - _fDragStart.y; _fApply();
    }
  });
  function _fEndPtr(e) {
    delete _fPointers[e.pointerId];
    if (Object.keys(_fPointers).length < 2) { _fPinching = false; }
    if (Object.keys(_fPointers).length === 0) { _fDragging = false; _fDragStart = null; }
  }
  v.addEventListener('pointerup',     _fEndPtr);
  v.addEventListener('pointercancel', _fEndPtr);
  v.addEventListener('wheel', e => {
    e.preventDefault();
    const r = v.getBoundingClientRect();
    _fZoom(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1/1.15);
  }, {passive:false});
}

// Mobile browsers (iOS Safari especially) silently fail to render a <canvas>
// past a certain total pixel area — the canvas just comes out blank, no
// error thrown. Desktop browsers allow much larger canvases, so a sheet
// that renders fine on desktop can go blank on a phone. 4096x4096 (~16.7M
// px) is a conservative ceiling that's safe across mobile browsers; scale
// down to fit within it rather than drawing 1:1.
// Confirmed via on-device debugging: a 4847x3462 canvas (total area under
// the old 4096x4096 *area* budget) still rendered blank on iPhone Safari.
// Mobile GPUs cap canvas/texture size per INDIVIDUAL DIMENSION, not total
// area — a common real-world limit is 4096px on any one side. A wide-but-
// short image can pass an area check while still failing because its width
// alone exceeds that. Cap each dimension independently instead.
const _F_MAX_CANVAS_DIM = 4096;
function _fSafeCanvasSize(w, h) {
  const scale = Math.min(1, _F_MAX_CANVAS_DIM / w, _F_MAX_CANVAS_DIM / h);
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

function renderFieldDrawing() {
  _fAttachEvents();
  document.getElementById('fieldTitle').textContent = _fieldData.drawingName || 'Inspection';
  document.getElementById('fieldPill').style.display = 'block';
  document.getElementById('fieldBottomBar').style.display = 'flex';
  const fc = _fCanvas();
  // If the source PDF is currently loaded in pdfCanvas, draw from it directly —
  // this gives the same crisp resolution as the main PDF view when zooming in.
  // Otherwise fall back to the stored image (e.g. assigned inspection from another
  // user, or opened straight from the dashboard without the tool view active).
  // NOTE: an untouched <canvas> defaults to 300x150, which is > 100 in both
  // dimensions — that default was passing this check and rendering a blank
  // canvas instead of falling back, so the threshold needs to clear it.
  if (pdfCanvas && pdfCanvas.width > 400 && pdfCanvas.height > 400) {
    const {w, h} = _fSafeCanvasSize(pdfCanvas.width, pdfCanvas.height);
    fc.width = w; fc.height = h;
    fc.getContext('2d').drawImage(pdfCanvas, 0, 0, w, h);
    _fFit(); renderFieldBadges(); updateFieldProgress();
  } else {
    const img = new Image();
    let settled = false;
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      console.warn('[QAQC] field drawing image failed to load:', reason);
      _fDrawLoadError();
    };
    img.onload = () => {
      if (settled) return;
      settled = true;
      const {w, h} = _fSafeCanvasSize(img.naturalWidth, img.naturalHeight);
      fc.width = w; fc.height = h;
      fc.getContext('2d').drawImage(img, 0, 0, w, h);
      _fFit(); renderFieldBadges(); updateFieldProgress();
    };
    img.onerror = () => fail('onerror');
    // Some mobile browsers neither fire onload nor onerror when they give up
    // decoding a very large image (memory pressure) — without this backstop
    // the screen just stays blank forever with no indication anything's wrong.
    setTimeout(() => fail('timeout'), 12000);
    img.src = _fieldData.imageDataUrl;
  }
}

function _fDrawLoadError() {
  const fc = _fCanvas();
  fc.width = 800; fc.height = 500;
  const ctx = fc.getContext('2d');
  ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, fc.width, fc.height);
  ctx.fillStyle = '#f5f5f5'; ctx.font = '600 22px -apple-system,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('Couldn’t load this drawing on this device', fc.width/2, fc.height/2 - 16);
  ctx.font = '15px -apple-system,sans-serif';
  ctx.fillStyle = '#aaa';
  ctx.fillText('The plan image may be too large for this browser to decode.', fc.width/2, fc.height/2 + 16);
  _fFit();
  fieldToast('Could not load the plan image on this device');
}

function renderFieldBadges() {
  const bl = document.getElementById('fieldBadgeLayer');
  bl.innerHTML = '';
  _fBadgePts = [];
  const iw = _fCanvas().width, ih = _fCanvas().height;
  _fieldData.findings.forEach((f, i) => {
    const b = document.createElement('div');
    b.className = 'finding-badge' +
      (f.status==='pass'?' passed':f.status==='fail'?' failed':'') +
      ((f.notes||f.photos.length)?' has-data':'');
    // Fixed CSS size only (see .finding-badge) — no inline width/height tied
    // to canvas size, so badges are a real constant on-screen size always,
    // not just at one particular zoom level.
    b.style.background = f.color || '#0d9488';
    b.textContent = i+1;
    const ck = document.createElement('div'); ck.className='check';
    ck.textContent = f.status==='pass'?'✓':'✗'; b.appendChild(ck);
    b.addEventListener('click', e => { e.stopPropagation(); openFieldSheet(i); });
    bl.appendChild(b);
    _fBadgePts.push({ el: b, cx: f.xPct*iw, cy: f.yPct*ih });
  });
  _fApply(); // position the freshly-created badges at the current pan/zoom
}

function updateFieldProgress() {
  const total    = _fieldData.findings.length;
  const reviewed = _fieldData.findings.filter(f=>f.status!==null).length;
  const passed   = _fieldData.findings.filter(f=>f.status==='pass').length;
  const failed   = _fieldData.findings.filter(f=>f.status==='fail').length;
  document.getElementById('fieldPill').textContent = reviewed+'/'+total;
  document.getElementById('fieldCountPill').textContent =
    reviewed+' / '+total+' reviewed'+(reviewed>0?'  ·  ✓ '+passed+'  ✕ '+failed:'');
}

function openFieldSheet(idx) {
  _fieldActiveIdx = idx;
  const f = _fieldData.findings[idx];
  document.getElementById('fieldSheetTitle').textContent = f.label||('Match #'+(idx+1));
  const badge = document.getElementById('fieldSheetBadge');
  if (f.typeName && f.color) { badge.textContent=f.typeName; badge.style.background=f.color; badge.style.display='inline-flex'; }
  else badge.style.display='none';
  // Crop reference image
  const fc=_fCanvas(),iw=fc.width,ih=fc.height;
  const cx=f.xPct*iw,cy=f.yPct*ih,fw=(f.wPct||0.04)*iw,fh=(f.hPct||0.04)*ih;
  const pad=Math.max(fw,fh)*0.4;
  const sx=Math.max(0,cx-fw/2-pad),sy=Math.max(0,cy-fh/2-pad);
  const sw=Math.min(iw-sx,fw+pad*2),sh=Math.min(ih-sy,fh+pad*2);
  const cc=document.createElement('canvas'); cc.width=cc.height=200;
  const cx2=cc.getContext('2d'); cx2.fillStyle='#fff'; cx2.fillRect(0,0,200,200);
  const ar=sw/sh; let dw,dh,dx,dy;
  if(ar>1){dw=200;dh=200/ar;dx=0;dy=(200-dh)/2;}else{dh=200;dw=200*ar;dy=0;dx=(200-dw)/2;}
  cx2.drawImage(fc,sx,sy,sw,sh,dx,dy,dw,dh);
  cx2.strokeStyle=f.color||'#0d9488'; cx2.lineWidth=2.5;
  const hx=dx+(cx-sx)/sw*dw, hy=dy+(cy-sy)/sh*dh, hr=Math.min(dw,dh)*0.15;
  cx2.beginPath(); cx2.arc(hx,hy,hr,0,Math.PI*2); cx2.stroke();
  document.getElementById('fieldRefImg').src = cc.toDataURL('image/jpeg',0.9);
  document.getElementById('fieldRefName').textContent = f.typeName||f.label||'Symbol';
  document.getElementById('fieldRefScore').style.display = 'none';
  const descEl = document.getElementById('fieldRefDesc');
  if (descEl) { descEl.textContent = f.description || ''; descEl.style.display = f.description ? 'block' : 'none'; }
  document.getElementById('fieldRefSection').style.display = 'block';
  // Checklist
  const qs=f.questions||[];
  const cl=document.getElementById('fieldChecklist');
  const ci=document.getElementById('fieldCheckItems'); ci.innerHTML='';
  if(qs.length){
    if(!f.questionChecks||f.questionChecks.length!==qs.length) f.questionChecks=qs.map(()=>null);
    qs.forEach((q,qi)=>{
      const row=document.createElement('div'); row.className='check-item';
      const qt=document.createElement('div'); qt.className='check-item-q'; qt.textContent=q;
      const btns=document.createElement('div'); btns.className='check-btns';
      const yb=document.createElement('button'); yb.className='check-btn yes'+(f.questionChecks[qi]===true?' active':''); yb.textContent='✓';
      const nb=document.createElement('button'); nb.className='check-btn no'+(f.questionChecks[qi]===false?' active':''); nb.textContent='✕';
      yb.onclick=()=>{f.questionChecks[qi]=f.questionChecks[qi]===true?null:true;yb.classList.toggle('active',f.questionChecks[qi]===true);nb.classList.remove('active');};
      nb.onclick=()=>{f.questionChecks[qi]=f.questionChecks[qi]===false?null:false;nb.classList.toggle('active',f.questionChecks[qi]===false);yb.classList.remove('active');};
      btns.appendChild(yb); btns.appendChild(nb); row.appendChild(qt); row.appendChild(btns); ci.appendChild(row);
    });
    cl.style.display='flex';
  } else { cl.style.display='none'; }
  document.getElementById('fieldNotes').value = f.notes||'';
  document.getElementById('fieldPassBtn').classList.toggle('active', f.status==='pass');
  document.getElementById('fieldFailBtn').classList.toggle('active', f.status==='fail');
  renderFieldPhotos(f.photos);
  document.getElementById('fieldSheet').classList.add('open');
  document.getElementById('fieldScrim').style.display = 'block';
}

function closeFieldSheet() {
  document.getElementById('fieldSheet').classList.remove('open');
  document.getElementById('fieldScrim').style.display = 'none';
  _fieldActiveIdx = null;
}

function setFieldStatus(s) {
  if (_fieldActiveIdx===null) return;
  const f = _fieldData.findings[_fieldActiveIdx];
  f.status = f.status===s ? null : s;
  document.getElementById('fieldPassBtn').classList.toggle('active', f.status==='pass');
  document.getElementById('fieldFailBtn').classList.toggle('active', f.status==='fail');
}

function saveFieldAndClose() {
  if (_fieldActiveIdx===null) return;
  _fieldData.findings[_fieldActiveIdx].notes = document.getElementById('fieldNotes').value.trim();
  // Save to localStorage
  try { localStorage.setItem('qaqc_session_'+_fieldData.exportedAt, JSON.stringify({findings:_fieldData.findings})); } catch(e){}
  // Sync back to Supabase
  if (_sb && _sbUser && _fieldCurrentPath) {
    const blob = new Blob([JSON.stringify(_fieldData)], {type:'application/json'});
    _sb.storage.from('inspections').upload(_fieldCurrentPath, blob, {upsert:true})
      .catch(e=>console.warn('[FieldApp] Sync failed:',e));
  }
  renderFieldBadges(); updateFieldProgress(); closeFieldSheet();
  fieldToast('Saved ✓');
}

function renderFieldPhotos(photos) {
  const grid = document.getElementById('fieldPhotosGrid'); grid.innerHTML='';
  (photos||[]).forEach((url,pi)=>{
    const th=document.createElement('div'); th.className='photo-thumb';
    const im=document.createElement('img'); im.src=url;
    const dl=document.createElement('button'); dl.className='photo-del'; dl.textContent='✕';
    dl.onclick=()=>{ _fieldData.findings[_fieldActiveIdx].photos.splice(pi,1); renderFieldPhotos(_fieldData.findings[_fieldActiveIdx].photos); };
    th.appendChild(im); th.appendChild(dl); grid.appendChild(th);
  });
  const ab=document.createElement('div'); ab.className='add-photo-btn';
  ab.innerHTML='<span>📷</span>Add photo';
  ab.onclick=()=>document.getElementById('fieldPhotoInput').click();
  grid.appendChild(ab);
}

function addFieldPhoto(input) {
  const file=input.files[0]; if(!file||_fieldActiveIdx===null) return;
  const reader=new FileReader();
  reader.onload=ev=>{
    const el=new Image(); el.onload=()=>{
      const MAX=2800, ratio=Math.min(1,MAX/Math.max(el.width,el.height));
      const c=document.createElement('canvas'); c.width=Math.round(el.width*ratio); c.height=Math.round(el.height*ratio);
      c.getContext('2d').drawImage(el,0,0,c.width,c.height);
      _fieldData.findings[_fieldActiveIdx].photos.push(c.toDataURL('image/jpeg',0.92));
      renderFieldPhotos(_fieldData.findings[_fieldActiveIdx].photos);
    }; el.src=ev.target.result;
  };
  reader.readAsDataURL(file); input.value='';
}

function fieldExportData() {
  if (!_fieldData) return;
  const payload = {imageDataUrl:_fieldData.imageDataUrl,drawingName:_fieldData.drawingName||'Inspection',exportedAt:_fieldData.exportedAt,inspectedAt:Date.now(),findings:_fieldData.findings};
  const blob = new Blob([JSON.stringify(payload)],{type:'application/json'});
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='field_report.json'; a.click();
  fieldToast('Exported ✓');
}

function fieldToast(msg) {
  const t=document.getElementById('fieldToast'); t.textContent=msg;
  t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2500);
}

// Start the app — deferred so all DOM elements (including #fieldWrap) exist
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
