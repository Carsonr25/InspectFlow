// ══════════════════════════════════════════════════════════════════
// DETAIL FOLDER SYSTEM
// ══════════════════════════════════════════════════════════════════

// State
let detailsFolder = []; // [{name, dataUrl, img (preloaded Image), nativeW, nativeH}]
let placingDetail = null; // {img, nativeW, nativeH, name} — set when in 'placing' mode
let activePlacement = null; // {img, x, y, w, h, draggingHandle: null|'nw'|'ne'|'se'|'sw', _drag}

// Detail Sheet Modal state
let dsCanvas = null, dsCtx = null;
let dsPdfDoc = null, dsPdfCurrentPage = 1, dsPdfPageCount = 1;
let dsDisplayScale = 1; // 1/dsScale — maps screen px → canvas px
let dsSelStart = null, dsSelEnd = null, dsIsSelecting = false;
let dsCapturedDataUrl = null;
let dsScale = 1, dsFitScale = 1, dsPanX = 0, dsPanY = 0;

function dsApplyTransform() {
  const wrap = document.getElementById('dsCanvasWrap');
  if (!wrap) return;
  wrap.style.transform = `translate(${dsPanX}px,${dsPanY}px) scale(${dsScale})`;
  dsDisplayScale = dsScale > 0 ? 1 / dsScale : 1;
  const el = document.getElementById('dsZoomLabel');
  if (el) el.textContent = Math.round(dsScale / dsFitScale * 100) + '%';
}
function dsFitToArea() {
  if (!dsCanvas || !dsCanvas.width) return;
  const area = document.getElementById('dsCanvasArea');
  const aw = area.clientWidth, ah = area.clientHeight;
  dsFitScale = Math.min(aw / dsCanvas.width, ah / dsCanvas.height) * 0.95;
  dsScale = dsFitScale;
  dsPanX = (aw - dsCanvas.width  * dsScale) / 2;
  dsPanY = Math.max(8, (ah - dsCanvas.height * dsScale) / 2);
  dsApplyTransform();
}
function dsZoomAround(vpX, vpY, factor) {
  const ns = Math.min(dsScale * 8, Math.max(dsFitScale * 0.5, dsScale * factor));
  const r = ns / dsScale;
  dsPanX = vpX - r * (vpX - dsPanX);
  dsPanY = vpY - r * (vpY - dsPanY);
  dsScale = ns;
  dsApplyTransform();
}
function dsZoomIn()  { const a=document.getElementById('dsCanvasArea'); dsZoomAround(a.clientWidth/2,a.clientHeight/2,1.4); }
function dsZoomOut() { const a=document.getElementById('dsCanvasArea'); dsZoomAround(a.clientWidth/2,a.clientHeight/2,1/1.4); }
function dsZoomFit() { dsFitToArea(); }
function dsOnWheel(e) {
  e.preventDefault();
  const area = document.getElementById('dsCanvasArea');
  const rect = area.getBoundingClientRect();
  dsZoomAround(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1/1.15);
}

function dsUpdateSavedCount() {
  const el = document.getElementById('dsSavedCount');
  if (el) el.textContent = '📁 ' + detailsFolder.length + ' saved';
}

// ── Folder Panel Toggle ──
function toggleFolderPanel() {
  const panel = document.getElementById('detailFolderPanel');
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
}

// ── Render folder panel contents ──
function renderFolderPanel() {
  const grid = document.getElementById('detailFolderGrid');
  const countEl = document.getElementById('detailFolderCount');
  const toggle = document.getElementById('detailFolderToggle');
  if (countEl) countEl.textContent = detailsFolder.length;
  if (toggle) toggle.style.display = 'flex';
  if (!grid) return;
  grid.innerHTML = '';
  if (detailsFolder.length === 0) {
    grid.innerHTML = '<div class="detail-folder-empty">No details saved yet.<br>Upload a detail sheet to start.</div>';
    return;
  }
  detailsFolder.forEach((detail, idx) => {
    const card = document.createElement('div');
    card.className = 'detail-thumb-card';
    const img = document.createElement('img');
    img.src = detail.dataUrl;
    img.alt = detail.name;
    const nameEl = document.createElement('div');
    nameEl.className = 'detail-thumb-name';
    nameEl.textContent = detail.name;
    const placeBtn = document.createElement('button');
    placeBtn.style.cssText = 'font-size:10px;font-weight:600;color:var(--teal);background:none;border:1px solid var(--teal);border-radius:4px;padding:3px 6px;cursor:pointer;white-space:nowrap;flex-shrink:0;';
    placeBtn.textContent = '↗ Place';
    placeBtn.onclick = (e) => { e.stopPropagation(); startPlacingDetail(idx); };
    const delBtn = document.createElement('button');
    delBtn.className = 'detail-thumb-del';
    delBtn.title = 'Remove from folder';
    delBtn.textContent = '✕';
    delBtn.onclick = (e) => { e.stopPropagation(); detailsFolder.splice(idx, 1); renderFolderPanel(); };
    card.appendChild(img);
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:4px;min-width:0;';
    info.appendChild(nameEl);
    info.appendChild(placeBtn);
    card.appendChild(info);
    card.appendChild(delBtn);
    grid.appendChild(card);
  });
}

// ── Open / Close Detail Sheet Modal ──
function openDetailSheetModal() {
  // Close folder panel when opening modal
  document.getElementById('detailFolderPanel').style.display = 'none';
  document.getElementById('detailSheetModal').style.display = 'flex';
  dsCanvas = document.getElementById('dsCanvas');
  dsCtx = dsCanvas ? dsCanvas.getContext('2d') : null;
  // Reset state
  dsSelStart = null; dsSelEnd = null; dsIsSelecting = false;
  dsCapturedDataUrl = null;
  dsPdfDoc = null; dsPdfCurrentPage = 1; dsPdfPageCount = 1;
  // Reset UI
  document.getElementById('dsSelBand').style.display = 'none';
  document.getElementById('dsCanvasArea').style.display = 'none';
  document.getElementById('dsUploadZoneWrap').style.display = 'flex';
  document.getElementById('dsPdfNav').style.display = 'none';
  document.getElementById('dsCropPreviewImg').style.display = 'none';
  document.getElementById('dsNameInput').style.display = 'none';
  document.getElementById('dsNameInput').value = '';
  document.getElementById('dsSaveBtn').style.display = 'none';
  document.getElementById('dsClearCropBtn').style.display = 'none';
  document.getElementById('dsZoomControls').style.display = 'none';
  document.getElementById('dsInstr').textContent = 'Draw a box around one detail to crop it';
  dsUpdateSavedCount();
  // Wire up drop on upload zone
  const uz = document.getElementById('dsUploadZone');
  uz.ondragover = e => { e.preventDefault(); uz.style.borderColor = 'var(--navy)'; };
  uz.ondragleave = () => { uz.style.borderColor = ''; };
  uz.ondrop = e => { e.preventDefault(); uz.style.borderColor = ''; if (e.dataTransfer.files[0]) handleDetailSheetFile(e.dataTransfer.files[0]); };
}

function closeDetailSheetModal() {
  document.getElementById('detailSheetModal').style.display = 'none';
  dsPdfDoc = null;
  renderFolderPanel();
}

// ── Handle file upload into detail sheet modal ──
async function handleDetailSheetFile(file) {
  if (!file) return;
  document.getElementById('dsInstr').textContent = 'Loading…';
  try {
    if (file.type === 'application/pdf') {
      if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js not loaded');
      const buf = await file.arrayBuffer();
      dsPdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
      dsPdfPageCount = dsPdfDoc.numPages;
      dsPdfCurrentPage = 1;
      await dsRenderPage(dsPdfCurrentPage);
      if (dsPdfPageCount > 1) {
        document.getElementById('dsPdfNav').style.display = 'flex';
        document.getElementById('dsPageLabel').textContent = `Page ${dsPdfCurrentPage} of ${dsPdfPageCount}`;
      }
    } else {
      // Image file
      await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = ev => {
          const img = new Image();
          img.onload = () => {
            // Fit to max 4000px wide for high quality crops
            const maxW = 4000;
            const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
            dsCanvas.width = Math.round(img.naturalWidth * scale);
            dsCanvas.height = Math.round(img.naturalHeight * scale);
            dsCanvas.style.width = '';
            dsCanvas.style.height = '';
            dsCtx.drawImage(img, 0, 0, dsCanvas.width, dsCanvas.height);
            requestAnimationFrame(() => dsFitToArea());
            res();
          };
          img.onerror = rej;
          img.src = ev.target.result;
        };
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
    }
    dsShowCanvas();
    document.getElementById('dsInstr').textContent = 'Draw a box around one detail to crop it';
  } catch (e) {
    document.getElementById('dsInstr').textContent = 'Error loading file: ' + e.message;
  }
}

async function dsRenderPage(pageNum) {
  const page = await dsPdfDoc.getPage(pageNum);
  const baseVp = page.getViewport({ scale: 1 });
  const desiredScale = Math.min(6.0, 3500 / Math.max(baseVp.width, baseVp.height));
  const vp = page.getViewport({ scale: desiredScale });
  dsCanvas.width = Math.round(vp.width);
  dsCanvas.height = Math.round(vp.height);
  // Clear any previous CSS size so we can measure fresh
  dsCanvas.style.width = '';
  dsCanvas.style.height = '';
  await page.render({ canvasContext: dsCtx, viewport: vp }).promise;
  requestAnimationFrame(() => dsFitToArea());
}

async function dsChangePage(delta) {
  if (!dsPdfDoc) return;
  const newPage = Math.max(1, Math.min(dsPdfPageCount, dsPdfCurrentPage + delta));
  if (newPage === dsPdfCurrentPage) return;
  dsPdfCurrentPage = newPage;
  document.getElementById('dsPageLabel').textContent = `Page ${dsPdfCurrentPage} of ${dsPdfPageCount}`;
  document.getElementById('dsSelBand').style.display = 'none';
  dsSelStart = null; dsSelEnd = null; dsCapturedDataUrl = null;
  dsClearCrop();
  await dsRenderPage(dsPdfCurrentPage);
}

function dsShowCanvas() {
  document.getElementById('dsUploadZoneWrap').style.display = 'none';
  const area = document.getElementById('dsCanvasArea');
  area.style.display = 'block';
  document.getElementById('dsZoomControls').style.display = 'flex';
  // Wire wheel zoom on the scroll area (remove first to avoid duplicates)
  area.removeEventListener('wheel', dsOnWheel);
  area.addEventListener('wheel', dsOnWheel, { passive: false });
  // Wire up pointer events on the canvas wrap
  const wrap = document.getElementById('dsCanvasWrap');
  wrap.onpointerdown = dsPointerDown;
  wrap.onpointermove = dsPointerMove;
  wrap.onpointerup = dsPointerUp;
  wrap.setPointerCapture && wrap.addEventListener('pointerup', dsPointerUp);
}

// ── Detail sheet modal: crop selection ──
function dsPointerDown(e) {
  if (e.button !== 0) return;
  const rect = dsCanvas.getBoundingClientRect();
  dsDisplayScale = rect.width > 0 ? dsCanvas.width / rect.width : 1;
  const cx = (e.clientX - rect.left) * dsDisplayScale;
  const cy = (e.clientY - rect.top) * dsDisplayScale;
  dsSelStart = { x: cx, y: cy };
  dsSelEnd = { x: cx, y: cy };
  dsIsSelecting = true;
  dsCapturedDataUrl = null;
  document.getElementById('dsSelBand').style.display = 'block';
  document.getElementById('dsCropPreviewImg').style.display = 'none';
  document.getElementById('dsNameInput').style.display = 'none';
  document.getElementById('dsSaveBtn').style.display = 'none';
  document.getElementById('dsClearCropBtn').style.display = 'none';
  document.getElementById('dsInstr').textContent = 'Drag to select the detail area…';
  e.preventDefault();
}

function dsPointerMove(e) {
  if (!dsIsSelecting || !dsSelStart) return;
  const rect = dsCanvas.getBoundingClientRect();
  dsDisplayScale = rect.width > 0 ? dsCanvas.width / rect.width : 1;
  const cx = (e.clientX - rect.left) * dsDisplayScale;
  const cy = (e.clientY - rect.top) * dsDisplayScale;
  dsSelEnd = { x: cx, y: cy };
  dsUpdateSelBand();
  e.preventDefault();
}

function dsPointerUp(e) {
  if (!dsIsSelecting) return;
  dsIsSelecting = false;
  if (!dsSelStart || !dsSelEnd) return;
  const x1 = Math.round(Math.min(dsSelStart.x, dsSelEnd.x));
  const y1 = Math.round(Math.min(dsSelStart.y, dsSelEnd.y));
  const x2 = Math.round(Math.max(dsSelStart.x, dsSelEnd.x));
  const y2 = Math.round(Math.max(dsSelStart.y, dsSelEnd.y));
  const w = x2 - x1, h = y2 - y1;
  if (w < 8 || h < 8) {
    document.getElementById('dsInstr').textContent = 'Selection too small — try again';
    document.getElementById('dsSelBand').style.display = 'none';
    return;
  }
  // Capture the crop from dsCanvas
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = w; cropCanvas.height = h;
  cropCanvas.getContext('2d').drawImage(dsCanvas, x1, y1, w, h, 0, 0, w, h);
  dsCapturedDataUrl = cropCanvas.toDataURL('image/png');
  // Show preview
  const prevImg = document.getElementById('dsCropPreviewImg');
  prevImg.src = dsCapturedDataUrl;
  prevImg.style.display = 'block';
  document.getElementById('dsNameInput').style.display = 'block';
  document.getElementById('dsNameInput').focus();
  document.getElementById('dsSaveBtn').style.display = 'block';
  document.getElementById('dsClearCropBtn').style.display = 'block';
  document.getElementById('dsInstr').textContent = 'Name it and click Save →';
}

function dsUpdateSelBand() {
  if (!dsSelStart || !dsSelEnd) return;
  const band = document.getElementById('dsSelBand');
  // Band lives inside dsCanvasWrap (pre-transform) so position in canvas pixel space
  const x = Math.min(dsSelStart.x, dsSelEnd.x);
  const y = Math.min(dsSelStart.y, dsSelEnd.y);
  const w = Math.abs(dsSelEnd.x - dsSelStart.x);
  const h = Math.abs(dsSelEnd.y - dsSelStart.y);
  band.style.left = x + 'px'; band.style.top = y + 'px';
  band.style.width = w + 'px'; band.style.height = h + 'px';
  // Counter-scale border so it stays ~2px visually regardless of zoom
  band.style.borderWidth = Math.max(1, 2 / dsScale) + 'px';
}

function dsClearCrop() {
  dsCapturedDataUrl = null;
  dsSelStart = null; dsSelEnd = null;
  document.getElementById('dsSelBand').style.display = 'none';
  document.getElementById('dsCropPreviewImg').style.display = 'none';
  document.getElementById('dsNameInput').style.display = 'none';
  document.getElementById('dsNameInput').value = '';
  document.getElementById('dsSaveBtn').style.display = 'none';
  document.getElementById('dsClearCropBtn').style.display = 'none';
  document.getElementById('dsInstr').textContent = 'Draw a box around one detail to crop it';
}

function saveDetailFromModal() {
  if (!dsCapturedDataUrl) return;
  const name = document.getElementById('dsNameInput').value.trim() || 'Detail ' + (detailsFolder.length + 1);
  // Preload an Image for fast canvas drawing later
  const img = new Image();
  img.src = dsCapturedDataUrl;
  img.onload = () => {
    detailsFolder.push({ name, dataUrl: dsCapturedDataUrl, img, nativeW: img.naturalWidth, nativeH: img.naturalHeight });
    renderFolderPanel();
    dsUpdateSavedCount();
    // Visual feedback
    document.getElementById('dsInstr').textContent = `✓ "${name}" saved! Draw another box to add more.`;
    dsClearCrop();
  };
}

// ── Start placing a detail from the folder ──
function startPlacingDetail(idx) {
  const detail = detailsFolder[idx];
  if (!detail || !pdfCanvas.width) {
    showError('Load a construction drawing first, then place a detail.');
    return;
  }
  // Close the folder panel
  document.getElementById('detailFolderPanel').style.display = 'none';
  placingDetail = detail;
  mode = 'placing';
  zoomViewport.style.cursor = 'crosshair';
  zoomViewport.classList.add('selecting');
  showBanner(`Drag a box where "${detail.name}" should go · Esc to cancel`);
  hideError();
}

// ── Finish drag-to-place ──
function finishPlacingDrag(){
  if(!selStart||!selEnd||!placingDetail) return;
  const x1=Math.round(Math.min(selStart.x,selEnd.x)), y1=Math.round(Math.min(selStart.y,selEnd.y));
  const x2=Math.round(Math.max(selStart.x,selEnd.x)), y2=Math.round(Math.max(selStart.y,selEnd.y));
  const w=x2-x1, h=y2-y1;
  selBand.style.display='none'; selBandSize.style.display='none';
  if(w<10||h<10){
    showBanner(`Drag a box where "${placingDetail.name}" should go · Esc to cancel`);
    return;
  }
  activePlacement={img:placingDetail.img,x:x1,y:y1,w,h,draggingHandle:null,_drag:null};
  placingDetail=null;
  mode='detail-resize';
  zoomViewport.style.cursor='default';
  zoomViewport.classList.remove('selecting');
  hideBanner();
  document.getElementById('detailPlacementBar').style.display='flex';
  drawMarkers(activeIdx);
}

// ── Cancel placing (Esc) ──
function cancelPlacedDetail() {
  placingDetail = null;
  activePlacement = null;
  mode = 'ready';
  zoomViewport.style.cursor = 'grab';
  zoomViewport.classList.remove('selecting');
  document.getElementById('detailPlacementBar').style.display = 'none';
  hideBanner();
  octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  drawMarkers(activeIdx);
  if (searchRegion) drawRegionBox();
}

// ── Commit placed detail — bake onto pdfCanvas ──
function commitPlacedDetail() {
  if (!activePlacement) return;
  const { img, x, y, w, h } = activePlacement;
  // Draw the detail onto the main PDF canvas (permanent)
  ctx.save();
  ctx.drawImage(img, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  // Thin inset border so the detail has a subtle visual boundary
  ctx.strokeStyle = 'rgba(30,58,95,0.25)';
  ctx.lineWidth = Math.max(pdfCanvas.width, pdfCanvas.height) * 0.0005;
  ctx.strokeRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  ctx.restore();
  activePlacement = null;
  placingDetail = null;
  mode = 'ready';
  zoomViewport.style.cursor = 'grab';
  zoomViewport.classList.remove('selecting');
  document.getElementById('detailPlacementBar').style.display = 'none';
  hideBanner();
  drawMarkers(activeIdx);
  if (searchRegion) drawRegionBox();
  showStatus('Detail committed to drawing — now scan over it as usual.');
}

// ── Draw placement preview / resize handles on overlayCanvas ──
function renderPlacementOnOverlay() {
  if (!activePlacement) return;
  const { img, x, y, w, h } = activePlacement;
  octx.globalAlpha = 0.82;
  octx.drawImage(img, x, y, w, h);
  octx.globalAlpha = 1;
  // Dashed border
  const lw = Math.max(overlayCanvas.width, overlayCanvas.height) * 0.0012;
  octx.strokeStyle = '#2563eb';
  octx.lineWidth = lw;
  octx.setLineDash([8, 4]);
  octx.strokeRect(x, y, w, h);
  octx.setLineDash([]);
  // Corner handles — size in canvas pixels = 10 screen pixels / current zoom
  const hSz = Math.max(8, 12 / scale);
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  corners.forEach(([hx, hy]) => {
    octx.fillStyle = '#2563eb';
    roundRect(octx, hx - hSz / 2, hy - hSz / 2, hSz, hSz, 2); octx.fill();
    octx.strokeStyle = '#fff'; octx.lineWidth = 1; octx.setLineDash([]);
    roundRect(octx, hx - hSz / 2, hy - hSz / 2, hSz, hSz, 2); octx.stroke();
  });
}

// ── Handle hit test (canvas coordinates) ──
function getPlacementHandle(cx, cy) {
  if (!activePlacement) return null;
  const { x, y, w, h } = activePlacement;
  const hitR = Math.max(14, 14 / scale); // ~14 screen-pixel hit radius
  const corners = { nw: [x, y], ne: [x + w, y], se: [x + w, y + h], sw: [x, y + h] };
  for (const [name, [hx, hy]] of Object.entries(corners)) {
    if (Math.hypot(cx - hx, cy - hy) < hitR) return name;
  }
  return null;
}

// ── Inspection flow vs PDF flow ──────────────────────────────────────
let _inspectionMode = false;
let _pendingInspectionName = '';

function startInspectionFlow() {
  if(qaqcSession.length === 0){ showError('No scans added yet — run a scan first.'); return; }
  const overlay = document.getElementById('inspectionNameOverlay');
  const input = document.getElementById('inspectionNameInput');
  if (input) input.value = document.title !== 'InspectFlow' ? document.title : '';
  if (overlay) overlay.classList.add('open');
  if (input) setTimeout(() => input.focus(), 0);
}

function closeInspectionNameModal() {
  document.getElementById('inspectionNameOverlay').classList.remove('open');
}

function confirmInspectionName() {
  const input = document.getElementById('inspectionNameInput');
  const name = (input ? input.value : '').trim();
  if (!name) return;
  _pendingInspectionName = name;
  closeInspectionNameModal();
  _inspectionMode = true;
  includeAIQuestions = false;
  createQaqcTemplate();
}

function startPdfFlow() {
  _inspectionMode = false;
  promptAiQuestionsChoice();
}

// Called by startTypeVerification to set the correct confirm button
function _updateTypeVerifyBtn() {
  const btn = document.getElementById('typeVerifyConfirmBtn');
  if (!btn) return;
  if (_inspectionMode) {
    btn.textContent = '📱 Confirm Types — Create Inspection';
    btn.style.background = '#0d9488';
    btn.onclick = confirmTypesAndCreateInspection;
  } else {
    btn.textContent = '✓ Types look correct — Generate PDF';
    btn.style.background = '#1a1a1a';
    btn.onclick = confirmTypesAndGeneratePdf;
  }
}

async function confirmTypesAndCreateInspection() {
  document.getElementById('typeVerifyOverlay').style.display = 'none';

  const apiKey = (document.getElementById('claudeApiKeyInput')?.value || '').replace(/\s/g,'');
  if (!apiKey) { doExportToFieldApp(); return; } // no key — skip descriptions

  // Gather all types across sessions
  const types = [];
  qaqcSession.forEach(scan => {
    (scan.types || []).forEach(t => {
      types.push({
        typeKey: t.typeKey || t.type,
        name: t.autoNamed ? scan.query : (t.type || t.typeKey),
        query: scan.query
      });
    });
  });

  if (types.length === 0) { doExportToFieldApp(); return; }

  showStatus('AI is reading the details for field descriptions…', true);

  try {
    // Read the actual detail/legend image so descriptions cite real specs
    // (size, length, embedment, fastener count) instead of just guessing
    // from the type's name — this was the gap: the old version never sent
    // the legend to the model at all, so it could only describe generically.
    const legendSession = qaqcSession.find(s => !s.isTextSearch && s.detailImg);
    const msgContent = [];
    if (legendSession) {
      msgContent.push({ type:'image', source:{ type:'base64', media_type:'image/jpeg', data: legendSession.detailImg.split(',')[1] } });
      msgContent.push({ type:'text', text:'LEGEND IMAGE: the detail / keynote schedule for these symbol types.' });
    }
    msgContent.push({ type:'text', text: `You are helping a field inspector identify construction symbols on drawings.
For each type below, ${legendSession ? 'read the legend image above to find its specific callout' : 'describe what it physically looks like'} — size, length, embedment depth, fastener count/spec, material, or connection type. Write ONE concise sentence (max 25 words) telling the inspector exactly what to verify in the field, using the ACTUAL values from the legend when they're visible for that type. If the legend doesn't cover a given type, describe the symbol generically instead of inventing numbers.

Types:
${types.map((t,i) => `${i+1}. "${t.name}" (typeKey: "${t.typeKey}", from scan: "${t.query}")`).join('\n')}

Return ONLY valid JSON, no markdown, no explanation:
{"types":[{"typeKey":"...","description":"..."}]}` });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
        messages: [{ role: 'user', content: msgContent }] })
    });

    const json = await resp.json();
    const raw = json.content?.[0]?.text || '';
    const jsonStr = extractFirstJsonObject(raw);
    const descriptions = jsonStr ? (JSON.parse(jsonStr).types || []) : [];

    // Attach descriptions to types in qaqcSession
    descriptions.forEach(d => {
      qaqcSession.forEach(scan => {
        (scan.types || []).forEach(t => {
          // Append rather than overwrite — t.description may already hold a
          // manually-typed note from the item's markup-mode Details field,
          // and that should never get silently clobbered by the AI's guess.
          if ((t.typeKey || t.type) === d.typeKey) {
            t.description = t.description ? `${t.description} ${d.description}` : d.description;
          }
        });
      });
    });

    showStatus('Descriptions generated — saving inspection…', true);
  } catch(e) {
    console.warn('[QAQC] Description generation failed:', e);
    // Continue without descriptions
  }

  doExportToFieldApp();
}

// ── Context menu ────────────────────────────────────────────────────
let _ctxTarget = null; // { type:'job'|'plan', job, disc, name }

function openCtxMenu(e, target) {
  e.stopPropagation();
  _ctxTarget = target;
  const menu = document.getElementById('ctxMenu');
  document.getElementById('ctxMove').style.display = target.type === 'plan' ? 'flex' : 'none';
  menu.classList.add('open');
  // Position near the button
  const r = e.currentTarget.getBoundingClientRect();
  const mw = 170, mh = target.type === 'plan' ? 110 : 78;
  let left = r.left, top = r.bottom + 4;
  if (left + mw > window.innerWidth - 8) left = r.right - mw;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 4;
  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';
}
document.addEventListener('click', () => document.getElementById('ctxMenu').classList.remove('open'));

async function ctxAction(action) {
  document.getElementById('ctxMenu').classList.remove('open');
  const t = _ctxTarget;
  if (!t) return;

  if (action === 'rename') {
    if (t.type === 'job') {
      const newName = prompt('Rename job:', t.job);
      if (!newName || newName === t.job) return;
      await renameJob(t.job, newName.trim());
    } else {
      const newName = prompt('Rename plan:', t.name.replace(/\.pdf$/i,''));
      if (!newName) return;
      await renamePlan(t.job, t.disc, t.name, newName.trim() + '.pdf');
    }
  } else if (action === 'move') {
    // Reuse job picker in move mode
    _pendingFile = { _isMove: true, _oldPath: `${_sbUser.id}/${t.job}/${t.disc}/${t.name}`, _name: t.name };
    await openJobPicker();
  } else if (action === 'delete') {
    if (t.type === 'job') {
      await deleteJob(encodeURIComponent(t.job));
    } else {
      await deleteStoredPlan(encodeURIComponent(t.job), encodeURIComponent(t.disc), encodeURIComponent(t.name));
    }
  }
}

async function renameJob(oldName, newName) {
  // Move all files: list each discipline folder and copy files to new job name
  const { data: discs } = await _sb.storage.from('plans').list(`${_sbUser.id}/${oldName}/`);
  for (const disc of (discs || []).filter(d => d.metadata == null)) {
    const { data: files } = await _sb.storage.from('plans').list(`${_sbUser.id}/${oldName}/${disc.name}/`);
    for (const f of (files || []).filter(f => f.metadata != null)) {
      const oldPath = `${_sbUser.id}/${oldName}/${disc.name}/${f.name}`;
      const newPath = `${_sbUser.id}/${newName}/${disc.name}/${f.name}`;
      const { data: blob } = await _sb.storage.from('plans').download(oldPath);
      if (blob) {
        await _sb.storage.from('plans').upload(newPath, blob, { upsert: true });
        await _sb.storage.from('plans').remove([oldPath]);
      }
    }
  }
  _existingJobs = _existingJobs.map(j => j === oldName ? newName : j);
  loadPlans();
}

async function renamePlan(job, disc, oldName, newName) {
  const oldPath = `${_sbUser.id}/${job}/${disc}/${oldName}`;
  const newPath = `${_sbUser.id}/${job}/${disc}/${newName}`;
  const { data: blob } = await _sb.storage.from('plans').download(oldPath);
  if (!blob) { alert('Could not download file to rename.'); return; }
  await _sb.storage.from('plans').upload(newPath, blob, { upsert: true });
  await _sb.storage.from('plans').remove([oldPath]);
  loadDisciplines(encodeURIComponent(job));
}

