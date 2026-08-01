// ═══════════════════════════════════════════════════════════════════════
//  SUPABASE — Auth + Plans Storage
//  1. Go to supabase.com, create a project.
//  2. Settings → API → copy "Project URL" and "anon public" key below.
//  3. Storage → create a bucket named "plans" (private).
//  4. Deploy this file to Vercel or Netlify.
//  Until you fill these in, the tool runs without auth (local-only mode).
// ═══════════════════════════════════════════════════════════════════════
const SUPABASE_URL = 'https://wftaoupovyaqjgiofjzl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_2d_6i0-hbYBq6pwcpBIuvQ_hicxzk5d';

let _sb = null, _sbUser = null;
(function initSupabase() {
  try {
    if (SUPABASE_URL !== 'YOUR_SUPABASE_URL' && typeof supabase !== 'undefined') {
      _sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
  } catch(e) { console.warn('[QAQC] Supabase init failed:', e); }
})();

// ── Screen switching ─────────────────────────────────────────────────
function showAuth() {
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('dashScreen').style.display = 'none';
  document.getElementById('appWrap').style.display   = 'none';
}
// Detect mobile
function _isMobile() {
  return window.innerWidth <= 768 || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function showDash() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('dashScreen').style.display = 'flex';
  document.getElementById('appWrap').style.display    = 'none';
  document.getElementById('fieldWrap').style.display  = 'none';
  const emailEl = document.getElementById('dashUserEmail');
  if (emailEl) emailEl.textContent = _sbUser?.email ?? '';
  // Default tab: Inspections on mobile, Plans on desktop
  switchDashTab(_isMobile() ? 'inspections' : 'plans');
}

function switchDashTab(tab) {
  const isPlans = tab === 'plans';
  const isInsp  = tab === 'inspections';
  const isOrg   = tab === 'org';
  document.getElementById('tabPlans').classList.toggle('active', isPlans);
  document.getElementById('tabInspections').classList.toggle('active', isInsp);
  document.getElementById('tabOrg').classList.toggle('active', isOrg);
  document.getElementById('paneP').classList.toggle('active', isPlans);
  document.getElementById('paneI').classList.toggle('active', isInsp);
  document.getElementById('paneOrg').classList.toggle('active', isOrg);
  if (isPlans) loadPlans();
  else if (isInsp) loadInspections();
  else if (isOrg) loadOrgPane();
}
function showTool() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('dashScreen').style.display = 'none';
  document.getElementById('fieldWrap').style.display  = 'none';
  const aw = document.getElementById('appWrap');
  aw.style.display = 'flex';
  const bb = document.getElementById('backToPlansBtn');
  if (bb) bb.style.display = _sbUser ? 'block' : 'none';
}

function showField() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('dashScreen').style.display = 'none';
  document.getElementById('appWrap').style.display    = 'none';
  document.getElementById('fieldWrap').style.display  = 'flex';
}

// ── ITEM MANAGEMENT ───────────────────────────────────────────────────
const ITEM_COLORS = ['#ef4444','#22c55e','#3b82f6','#f97316','#8b5cf6','#eab308','#ec4899','#14b8a6'];
let inspectionItems = [];
let _detailRect = null; // sheet region captured as the detail/legend

function _captureSheetImg(){
  try{
    if(typeof pdfCanvas==='undefined'||!pdfCanvas||!pdfCanvas.width) return null;
    return pdfCanvas.toDataURL('image/jpeg',0.95);
  }catch(e){ console.warn('[QAQC] sheet capture failed',e); return null; }
}

function _captureDetailImg(){
  try{
    if(typeof detailLegendCaptured==='undefined'||!detailLegendCaptured) return null;
    const dlc=document.getElementById('detailLegendCanvas');
    if(!dlc||!dlc.width) return null;
    return dlc.toDataURL('image/jpeg',0.9);
  }catch(e){ return null; }
}
let currentSelectedItem = null;

function _esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

function nextItemColor(){
  const used = inspectionItems.map(i=>i.color);
  return ITEM_COLORS.find(c=>!used.includes(c)) || ITEM_COLORS[inspectionItems.length % ITEM_COLORS.length];
}

function openNewItemModal() {
  if (isInManualMarkupMode) finishManualMarkup();
  const overlay = document.getElementById('newItemOverlay');
  const input = document.getElementById('newItemNameInput');
  if (input) input.value = '';
  if (overlay) overlay.classList.add('open');
  if (input) setTimeout(() => input.focus(), 0);
}

function closeNewItemModal() {
  const overlay = document.getElementById('newItemOverlay');
  if (overlay) overlay.classList.remove('open');
}

// Resolves true/false based on which button the user clicks. Used before
// running the per-item AI type-sort so items that are all one type (e.g.
// shear walls) can skip classification entirely instead of always sorting.
function askShouldSortItem(name, count) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('sortConfirmOverlay');
    document.getElementById('sortConfirmTitle').textContent = `Sort "${name}" into types?`;
    document.getElementById('sortConfirmSub').textContent = `${count} markup${count !== 1 ? 's' : ''} found. Claude will read each one and group them by type (e.g. Type 1, Type 4). Say no if this item is all one type.`;
    const yesBtn = document.getElementById('sortConfirmYesBtn');
    const noBtn = document.getElementById('sortConfirmNoBtn');
    const cleanup = (result) => {
      overlay.classList.remove('open');
      yesBtn.onclick = null;
      noBtn.onclick = null;
      resolve(result);
    };
    yesBtn.onclick = () => cleanup(true);
    noBtn.onclick = () => cleanup(false);
    overlay.classList.add('open');
  });
}

function confirmNewItem() {
  const input = document.getElementById('newItemNameInput');
  const name = input ? input.value : '';
  if (!name || !name.trim()) return;

  const item = {
    id: Date.now(),
    name: name.trim(),
    color: nextItemColor(),
    boxes: [],
    inSession: false,
    createdAt: new Date().toLocaleString()
  };

  inspectionItems.push(item);
  currentSelectedItem = item;
  closeNewItemModal();
  renderItemsList();
  showStatus(`"${item.name}" added — hit Mark Up to start boxing them.`);
}

function selectItem(itemId) {
  if (isInManualMarkupMode) return;
  const it = inspectionItems.find(i => i.id === itemId);
  currentSelectedItem = (currentSelectedItem && currentSelectedItem.id === itemId) ? null : it || null;
  renderItemsList();
  drawMarkers();
}

function deselectItem() {
  currentSelectedItem = null;
  renderItemsList();
}

function setItemColor(itemId, color) {
  const it = inspectionItems.find(i => i.id === itemId);
  if (!it) return;
  it.color = color;
  if (it.inSession) syncSessionFromItems();
  renderItemsList();
  const sw = document.getElementById('markupModeSwatch');
  if (sw && currentSelectedItem && currentSelectedItem.id === itemId) sw.style.background = color;
  drawMarkers();
}

function renderItemsList() {
  const container = document.getElementById('itemsList');
  const hint = document.getElementById('itemsEmptyHint');
  if (!container) return;

  if (inspectionItems.length === 0) {
    container.style.display = 'none';
    if (hint) hint.style.display = 'block';
    renderSessionSummary();
    return;
  }

  container.style.display = 'block';
  if (hint) hint.style.display = 'none';

  container.innerHTML = inspectionItems.map(item => {
    const sel = currentSelectedItem && currentSelectedItem.id === item.id;
    const n = item.boxes.length;
    return `
    <div style="border:1.5px solid ${sel ? 'var(--navy)' : 'var(--border)'};border-radius:8px;margin-bottom:8px;overflow:hidden;background:var(--surface);">
      <div onclick="selectItem(${item.id})" style="display:flex;align-items:center;gap:8px;padding:9px 10px;cursor:pointer;background:${sel ? 'var(--surface2)' : 'transparent'};">
        <span style="width:11px;height:11px;border-radius:3px;background:${item.color};flex:none;"></span>
        <span style="flex:1;font-size:12px;font-weight:600;color:var(--text);">${_esc(item.name)}</span>
        <span style="font-size:10px;font-weight:700;color:${n ? 'var(--text2)' : 'var(--text3)'};">${n}</span>
        ${item.inSession ? '<span style="font-size:10px;color:#0F6E56;font-weight:700;" title="In session">✓</span>' : ''}
        <button onclick="event.stopPropagation();deleteItem(${item.id})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px;padding:0 2px;line-height:1;">✕</button>
      </div>
      ${sel ? `
      <div style="padding:10px;border-top:1px solid var(--border);">
        <div style="display:flex;gap:5px;margin-bottom:9px;">
          ${ITEM_COLORS.map(c => `<span onclick="setItemColor(${item.id},'${c}')" style="width:17px;height:17px;border-radius:4px;background:${c};cursor:pointer;border:2px solid ${c === item.color ? 'var(--text)' : 'transparent'};box-sizing:border-box;"></span>`).join('')}
        </div>
        <button onclick="startMethodManualMarkup()" style="width:100%;padding:9px;background:var(--navy);color:#fff;border:none;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;">✎ ${n ? 'Mark up more' : 'Mark Up'}</button>
        ${n ? `<div style="max-height:120px;overflow-y:auto;margin-top:8px;">${item.boxes.map((b, i) => `
          <div style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text2);padding:3px 6px;background:var(--surface2);border-radius:4px;margin-bottom:3px;">
            <span style="flex:1;">Markup ${i + 1} · ${Math.round(b.w)}×${Math.round(b.h)}</span>
            <button onclick="deleteBox(${item.id},${i})" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:12px;padding:0;line-height:1;">✕</button>
          </div>`).join('')}</div>` : ''}
        ${n ? (item.inSession
          ? `<div style="margin-top:8px;text-align:center;font-size:11px;font-weight:600;color:#0F6E56;padding:7px;background:#f0fdf4;border:1px solid #86efac;border-radius:6px;">✓ In session</div>`
          : `<button onclick="addItemToSession(${item.id})" style="width:100%;margin-top:8px;padding:9px;background:#0F6E56;color:#fff;border:none;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;">+ Add to Session</button>`
        ) : ''}
      </div>` : ''}
    </div>`;
  }).join('');

  renderSessionSummary();
}

function deleteItem(itemId) {
  const it = inspectionItems.find(i => i.id === itemId);
  if (it && it.boxes.length && !confirm(`Delete "${it.name}" and its ${it.boxes.length} markup(s)?`)) return;
  inspectionItems = inspectionItems.filter(i => i.id !== itemId);
  if (currentSelectedItem && currentSelectedItem.id === itemId) {
    currentSelectedItem = null;
    if (isInManualMarkupMode) cancelManualMarkup();
  }
  syncSessionFromItems();
  renderItemsList();
  drawMarkers();
}

function deleteBox(itemId, idx) {
  const it = inspectionItems.find(i => i.id === itemId);
  if (!it) return;
  it.boxes.splice(idx, 1);
  if (it.inSession) syncSessionFromItems();
  renderItemsList();
  updateMarkupModeCount();
  drawMarkers();
}

// ── SESSION ───────────────────────────────────────────────────────────
function addItemToSession(itemId) {
  const it = inspectionItems.find(i => i.id === itemId);
  if (!it || !it.boxes.length) return;
  it.inSession = true;
  if (!it.baseImg) it.baseImg = _captureSheetImg();
  it.detailImg = _captureDetailImg() || it.detailImg || null;
  syncSessionFromItems();
  renderItemsList();
  showStatus(`"${it.name}" added to session — ${it.boxes.length} markup(s)`);
}

// Rebuilds qaqcSession from items, preserving any non-manual scans.
function syncSessionFromItems() {
  const others = (typeof qaqcSession !== 'undefined' ? qaqcSession : []).filter(s => !s.isManualMarkup);
  const manual = inspectionItems.filter(i => i.inSession && i.boxes.length).map(i => ({
    query: i.name,
    findingsCount: i.boxes.length,
    markedUpImg: null, thumbImg: null, detailImg: i.detailImg || null,
    types: [],
    findingsSnap: i.boxes.map((b, idx) => ({
      x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h,
      score: 1.0, label: `${i.name} ${idx + 1}`
    })),
    baseImg: i.baseImg || null,
    templateSize: {
      w: Math.max(8, Math.round(i.boxes.reduce((a,b)=>a+b.w,0)/i.boxes.length)),
      h: Math.max(8, Math.round(i.boxes.reduce((a,b)=>a+b.h,0)/i.boxes.length))
    },
    cropsGrid: null,
    searchRegionSnap: (typeof searchRegion !== 'undefined' && searchRegion) ? { ...searchRegion } : null,
    timestamp: new Date().toLocaleString(),
    isManualMarkup: true,
    color: i.color,
    itemId: i.id
  }));
  qaqcSession = others.concat(manual);
  renderSessionSummary();
}

function renderSessionSummary() {
  const total = (typeof qaqcSession !== 'undefined' ? qaqcSession : []).reduce((a, s) => a + (s.findingsCount || 0), 0);
  const count = (typeof qaqcSession !== 'undefined' ? qaqcSession : []).length;

  const badge = document.getElementById('sessionCountBadge');
  if (badge) {
    if (count) {
      badge.style.display = 'block';
      badge.textContent = `${count} item${count !== 1 ? 's' : ''} · ${total} markup${total !== 1 ? 's' : ''}`;
    } else badge.style.display = 'none';
  }

  const btn = document.getElementById('createInspectionBtn');
  if (btn) btn.style.display = count ? 'block' : 'none';

  // Keep the legacy QAQC panel's state coherent for the export/report code.
  const statusEl = document.getElementById('qaqcSessionStatus');
  if (statusEl) {
    if (count) {
      statusEl.style.display = 'block';
      statusEl.textContent = `${count} scan(s): ${qaqcSession.map(s => s.query).join(' · ')}`;
    } else statusEl.style.display = 'none';
  }
  const cq = document.getElementById('createQaqcBtn');
  if (cq) cq.style.display = count ? 'block' : 'none';
  const clq = document.getElementById('clearQaqcBtn');
  if (clq) clq.style.display = count ? 'block' : 'none';
}

// ── MANUAL MARKUP MODE ────────────────────────────────────────────────
let isInManualMarkupMode = false;
let manualBoxStart = null, manualBoxEnd = null;

function startMethodManualMarkup() {
  if (!currentSelectedItem) return;
  isInManualMarkupMode = true;
  manualBoxStart = null; manualBoxEnd = null;
  if (typeof overlayCanvas !== 'undefined' && overlayCanvas) overlayCanvas.style.cursor = 'crosshair';
  if (typeof zoomViewport !== 'undefined' && zoomViewport) zoomViewport.style.cursor = 'crosshair';

  const nb = document.getElementById('newItemBtn');
  if (nb) nb.style.display = 'none';
  const list = document.getElementById('itemsList');
  if (list) list.style.display = 'none';
  const hint = document.getElementById('itemsEmptyHint');
  if (hint) hint.style.display = 'none';

  const bar = document.getElementById('markupModeBar');
  if (bar) bar.style.display = 'block';
  const sw = document.getElementById('markupModeSwatch');
  if (sw) sw.style.background = currentSelectedItem.color;
  const nm = document.getElementById('markupModeName');
  if (nm) nm.textContent = currentSelectedItem.name;
  updateMarkupModeCount();

  showStatus(`Marking up "${currentSelectedItem.name}" — drag a box around each one.`);
  drawMarkers();
}

function updateMarkupModeCount() {
  const el = document.getElementById('markupModeCount');
  if (el && currentSelectedItem) el.textContent = currentSelectedItem.boxes.length;
}

function exitMarkupModeUI() {
  isInManualMarkupMode = false;
  manualBoxStart = null; manualBoxEnd = null;
  if (typeof overlayCanvas !== 'undefined' && overlayCanvas) overlayCanvas.style.cursor = 'grab';
  if (typeof zoomViewport !== 'undefined' && zoomViewport) zoomViewport.style.cursor = 'grab';
  const bar = document.getElementById('markupModeBar');
  if (bar) bar.style.display = 'none';
  const nb = document.getElementById('newItemBtn');
  if (nb) nb.style.display = 'block';
  renderItemsList();
  drawMarkers();
}

function finishCurrentMarkup() { finishManualMarkup(); }

function finishManualMarkup() {
  if (!isInManualMarkupMode) return;
  const item = currentSelectedItem;
  exitMarkupModeUI();
  if (item && item.boxes.length) {
    if (item.inSession) syncSessionFromItems();
    showStatus(`"${item.name}" — ${item.boxes.length} markup(s). Add to session when ready.`);
  } else {
    showStatus('No markups drawn.');
  }
}

function cancelManualMarkup() {
  if (!isInManualMarkupMode) return;
  exitMarkupModeUI();
  showStatus('');
}

document.addEventListener('keydown', (e) => {
  if (!isInManualMarkupMode) return;
  if (e.key === 'Enter') { e.preventDefault(); finishManualMarkup(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelManualMarkup(); }
});

// ── PARKED: other markup methods (kept for later integration) ─────────
function startMethodTextSearch() {
  if (!currentSelectedItem) return;
  const el = document.getElementById('textSearchInput');
  if (el) el.value = currentSelectedItem.name;
  document.getElementById('sidebarOriginal').style.display = 'block';
  document.getElementById('itemsManagementUI').style.display = 'none';
  showStatus(`Text search for "${currentSelectedItem.name}"`);
}

function startMethodTemplateMatching() {
  if (!currentSelectedItem) return;
  const el = document.getElementById('queryInput');
  if (el) el.value = currentSelectedItem.name;
  document.getElementById('sidebarOriginal').style.display = 'block';
  document.getElementById('itemsManagementUI').style.display = 'none';
  showStatus(`Template matching for "${currentSelectedItem.name}"`);
}

function exitToItemsMenu() {
  document.getElementById('sidebarOriginal').style.display = 'none';
  document.getElementById('itemsManagementUI').style.display = 'block';
  renderItemsList();
}

function openNewItemMenu() { openNewItemModal(); }
function setupManualMarkupMode() {}
function attachManualMarkupHandlers() {}
function renderMarkupsList() { updateMarkupModeCount(); }

function _mountDetailPreview(){
  const slot=document.getElementById('detailPreviewSlot');
  const dlc=document.getElementById('detailLegendCanvas');
  if(slot&&dlc&&dlc.parentNode!==slot){ dlc.style.maxWidth='100%'; slot.appendChild(dlc); }
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_mountDetailPreview);
else _mountDetailPreview();

// ── App init ─────────────────────────────────────────────────────────
async function initApp() {
  // authScreen is visible by default — hide other screens immediately
  document.getElementById('dashScreen').style.display = 'none';
  document.getElementById('appWrap').style.display    = 'none';
  document.getElementById('fieldWrap').style.display  = 'none';

  if (!_sb) { return; } // stay on auth screen

  try {
    const { data: { session } } = await _sb.auth.getSession();
    if (session) { _sbUser = session.user; showDash(); }
    // else stay on auth screen (already visible)
    _sb.auth.onAuthStateChange((_ev, sess) => {
      _sbUser = sess?.user ?? null;
      if (_sbUser) showDash(); else showAuth();
    });
  } catch(e) {
    console.warn('[QAQC] Auth check failed — running without auth', e);
    // stay on auth screen so user can log in or bypass
  }
}

// ── Auth form ────────────────────────────────────────────────────────
let _authMode = 'login';
function switchAuthTab(mode) {
  _authMode = mode;
  document.getElementById('tabLogin').classList.toggle('active', mode === 'login');
  document.getElementById('tabSignup').classList.toggle('active', mode === 'signup');
  document.getElementById('authSubmitBtn').textContent = mode === 'login' ? 'Log in' : 'Create account';
  _clearAuthMsg();
}
function _clearAuthMsg() {
  const m = document.getElementById('authMsg');
  m.style.display = 'none'; m.className = 'auth-msg';
}
function _showAuthMsg(text, type = 'error') {
  const m = document.getElementById('authMsg');
  m.textContent = text; m.className = 'auth-msg ' + type;
  m.style.display = 'block';
}
async function submitAuth() {
  console.log('[Auth] submitAuth called, mode:', _authMode);
  if (!_sb) {
    console.error('[Auth] Supabase not loaded');
    _showAuthMsg('Connection error — Supabase not loaded. Check your internet connection and reload.');
    return;
  }
  const email = document.getElementById('authEmail').value.trim();
  const pw    = document.getElementById('authPw').value;
  console.log('[Auth] Email:', email, 'Password entered:', !!pw);
  if (!email || !pw) { _showAuthMsg('Please enter your email and password.'); return; }
  _clearAuthMsg();
  const btn = document.getElementById('authSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Please wait…';
  try {
    let res;
    if (_authMode === 'login') {
      console.log('[Auth] Attempting login...');
      res = await _sb.auth.signInWithPassword({ email, password: pw });
    } else {
      console.log('[Auth] Attempting signup...');
      res = await _sb.auth.signUp({ email, password: pw });
    }
    console.log('[Auth] Response:', res);
    if (res.error) throw res.error;
    if (_authMode === 'signup' && res.data.user && !res.data.session) {
      console.log('[Auth] Signup successful, awaiting email confirmation');
      _showAuthMsg('Account created! Check your email to confirm, then log in.', 'info');
    } else if (res.data.session) {
      // Login succeeded — navigate immediately without waiting for onAuthStateChange
      console.log('[Auth] Login successful, showing dashboard');
      _sbUser = res.data.user;
      showDash();
    } else {
      console.warn('[Auth] No error but also no session');
    }
  } catch(e) {
    console.error('[Auth] Error:', e);
    _showAuthMsg(e.message || 'Authentication failed.');
  } finally {
    btn.disabled = false;
    btn.textContent = _authMode === 'login' ? 'Log in' : 'Create account';
  }
}
async function logOut() {
  if (_sb) await _sb.auth.signOut();
}

// ── Plans (Supabase Storage) ─────────────────────────────────────────
// ── Jobs / Disciplines / Plans navigation ───────────────────────────
let _currentJob = null, _currentDisc = null;
let _existingJobs = []; // cached list for picker
let _pendingFile  = null; // file waiting for job/disc assignment

const DISC_ICONS = {
  'Architectural':'🏛','Structural':'🏗','Mechanical':'⚙️','Electrical':'⚡',
  'Plumbing':'🔧','Civil':'🛣','Fire Protection':'🔥','Other':'📁'
};

function _updateBreadcrumb() {
  const bc  = document.getElementById('plansBreadcrumb');
  const h1  = document.getElementById('plansHeading');
  const btn = document.getElementById('plansUploadBtn');
  if (!_currentJob) {
    bc.style.display = 'none'; h1.textContent = 'My Jobs';
    btn.style.display = 'inline-flex';
  } else if (!_currentDisc) {
    bc.style.display = 'flex';
    bc.innerHTML = `<span class="bc-link" onclick="loadPlans()">My Jobs</span><span class="bc-sep">›</span><span class="bc-current">${_currentJob}</span>`;
    h1.textContent = _currentJob;
    btn.style.display = 'inline-flex';
  } else {
    bc.style.display = 'flex';
    bc.innerHTML = `<span class="bc-link" onclick="loadPlans()">My Jobs</span><span class="bc-sep">›</span><span class="bc-link" onclick="loadDisciplines('${_currentJob}')">${_currentJob}</span><span class="bc-sep">›</span><span class="bc-current">${_currentDisc}</span>`;
    h1.textContent = _currentDisc;
    btn.style.display = 'inline-flex';
  }
}

async function loadPlans() {
  _currentJob = null; _currentDisc = null;
  _updateBreadcrumb();
  const grid = document.getElementById('plansGrid');
  if (!_sb || !_sbUser) { grid.innerHTML = ''; return; }
  grid.innerHTML = '<div class="dash-loader">Loading jobs…</div>';
  try {
    const { data, error } = await _sb.storage.from('plans').list(_sbUser.id + '/');
    if (error) throw error;
    const all  = (data || []).filter(f => f.name && !f.name.startsWith('.'));
    const jobs  = all.filter(f => f.metadata == null); // folders
    const loose = all.filter(f => f.metadata != null); // flat files (old format)
    _existingJobs = jobs.map(j => j.name);

    let html = '';

    if (jobs.length === 0 && loose.length === 0) {
      grid.innerHTML = `<div class="plans-empty"><div class="empty-icon">🏗</div><p>No jobs yet.<br>Upload a plan to create your first job.</p></div>`;
      return;
    }

    if (jobs.length > 0) {
      html += `<div class="jobs-grid">${jobs.map(j => {
        const enc  = encodeURIComponent(j.name);
        const jSafe = j.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        return `<div class="job-card" onclick="loadDisciplines('${enc}')">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div class="job-card-icon">📁</div>
            <button class="dots-btn" onclick="event.stopPropagation();openCtxMenu(event,{type:'job',job:'${jSafe}'})" title="Options">⋯</button>
          </div>
          <div class="job-card-name">${j.name}</div>
        </div>`;
      }).join('')}</div>`;
    }

    if (loose.length > 0) {
      html += `<div style="margin-top:${jobs.length>0?'24px':'0'};"><div style="font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">Unassigned Plans</div>
      <div class="plans-grid">${loose.map(f => {
        const enc  = encodeURIComponent(f.name);
        const date = f.created_at ? new Date(f.created_at).toLocaleDateString() : '';
        return `<div class="plan-card">
          <div class="plan-icon">📄</div>
          <div class="plan-name" title="${f.name}">${f.name}</div>
          <div class="plan-date">${date}</div>
          <button class="dash-new-btn" style="font-size:11px;padding:5px 10px;margin-top:6px;width:100%;" onclick="assignToJob('${enc}')">Assign to job</button>
        </div>`;
      }).join('')}</div></div>`;
    }

    grid.innerHTML = html;
  } catch(e) {
    grid.innerHTML = `<div class="dash-loader">Could not load jobs: ${e.message}</div>`;
  }
}

async function assignToJob(encodedName) {
  const name = decodeURIComponent(encodedName);
  _pendingFile = { _isMove: true, _oldPath: `${_sbUser.id}/${name}`, _name: name };
  await openJobPicker();
}

async function confirmJobPicker() {
  const sel  = document.getElementById('jobPickerJobSelect');
  const inp  = document.getElementById('jobPickerJobInput');
  const disc = document.getElementById('jobPickerDisc').value;
  let job = sel.value === '__new__' ? inp.value.trim() : sel.value;
  if (!job) { alert('Please enter or select a job name.'); return; }
  if (!disc) { alert('Please select a discipline.'); return; }
  if (!_pendingFile) { closeJobPicker(); return; }

  const pf = _pendingFile;
  closeJobPicker();

  if (pf._isMove) {
    // Move existing flat file into job/discipline folder
    const newPath = `${_sbUser.id}/${job}/${disc}/${pf._name}`;
    const { data: dlData, error: dlErr } = await _sb.storage.from('plans').download(pf._oldPath);
    if (dlErr) { alert('Could not move plan: ' + dlErr.message); return; }
    await _sb.storage.from('plans').upload(newPath, dlData, { upsert: true });
    await _sb.storage.from('plans').remove([pf._oldPath]);
    if (!_existingJobs.includes(job)) _existingJobs.push(job);
    loadPlans();
  } else {
    // New upload
    const file = pf;
    const path = `${_sbUser.id}/${job}/${disc}/${file.name}`;
    _sb.storage.from('plans').upload(path, file, { upsert: true })
      .then(() => { if (!_existingJobs.includes(job)) _existingJobs.push(job); })
      .catch(e => console.warn('[QAQC] Upload failed:', e));
    showTool();
    handleFile(file);
  }
}

async function loadDisciplines(encodedJob) {
  _currentJob = decodeURIComponent(encodedJob);
  _currentDisc = null;
  _updateBreadcrumb();
  const grid = document.getElementById('plansGrid');
  grid.innerHTML = '<div class="dash-loader">Loading…</div>';
  try {
    const { data, error } = await _sb.storage.from('plans').list(_sbUser.id + '/' + _currentJob + '/');
    if (error) throw error;
    const discs = (data || []).filter(f => f.name && !f.name.startsWith('.') && f.metadata == null);
    if (discs.length === 0) {
      grid.innerHTML = `<div class="plans-empty"><div class="empty-icon">📂</div><p>No plans yet.<br>Upload a plan to this job.</p></div>`;
      return;
    }
    // Load all disciplines and their files in parallel
    const sections = await Promise.all(discs.map(async d => {
      const prefix = `${_sbUser.id}/${_currentJob}/${d.name}/`;
      const { data: files } = await _sb.storage.from('plans').list(prefix, { sortBy:{ column:'created_at', order:'desc' } });
      return { disc: d.name, files: (files || []).filter(f => f.name && !f.name.startsWith('.') && f.metadata != null) };
    }));
    const ej = encodeURIComponent(_currentJob);
    grid.innerHTML = sections.map(({ disc, files }) => {
      const icon = DISC_ICONS[disc] || '📁';
      const ed   = encodeURIComponent(disc);
      const filesHtml = files.length === 0
        ? `<div style="font-size:12px;color:var(--text3);padding:8px 0;">No plans yet</div>`
        : `<div class="plans-grid">${files.map(f => {
            const date  = f.created_at ? new Date(f.created_at).toLocaleDateString() : '';
            const enc   = encodeURIComponent(f.name);
            const fSafe = f.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
            const dSafe = disc.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
            const jSafe = _currentJob.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
            return `<div class="plan-card" onclick="openStoredPlan('${ej}','${ed}','${enc}')">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                <div class="plan-icon">📄</div>
                <button class="dots-btn" onclick="event.stopPropagation();openCtxMenu(event,{type:'plan',job:'${jSafe}',disc:'${dSafe}',name:'${fSafe}'})" title="Options">⋯</button>
              </div>
              <div class="plan-name" title="${f.name}">${f.name}</div>
              <div class="plan-date">${date}</div>
            </div>`;
          }).join('')}</div>`;
      return `<div style="margin-bottom:24px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1.5px solid var(--border);">
          <span style="font-size:18px;">${icon}</span>
          <span style="font-size:13px;font-weight:700;color:var(--text);">${disc}</span>
          <span style="font-size:11px;color:var(--text3);margin-left:4px;">${files.length} plan${files.length!==1?'s':''}</span>
        </div>
        ${filesHtml}
      </div>`;
    }).join('');
  } catch(e) {
    grid.innerHTML = `<div class="dash-loader">Could not load: ${e.message}</div>`;
  }
}

// loadDrawings kept for direct nav if needed
async function loadDrawings(encodedJob, encodedDisc) {
  loadDisciplines(encodedJob); // just show full expanded view
}

async function openStoredPlan(encodedJob, encodedDisc, encodedName) {
  const job  = decodeURIComponent(encodedJob);
  const disc = decodeURIComponent(encodedDisc);
  const name = decodeURIComponent(encodedName);
  const path = `${_sbUser.id}/${job}/${disc}/${name}`;
  const { data, error } = await _sb.storage.from('plans').download(path);
  if (error) { alert('Could not open plan: ' + error.message); return; }
  showTool();
  handleFile(new File([data], name, { type: 'application/pdf' }));
}

async function deleteStoredPlan(encodedJob, encodedDisc, encodedName) {
  const job  = decodeURIComponent(encodedJob);
  const disc = decodeURIComponent(encodedDisc);
  const name = decodeURIComponent(encodedName);
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  const { error } = await _sb.storage.from('plans').remove([`${_sbUser.id}/${job}/${disc}/${name}`]);
  if (error) { alert('Delete failed: ' + error.message); return; }
  loadDrawings(encodeURIComponent(job), encodeURIComponent(disc));
}

async function deleteJob(encodedJob) {
  const job = decodeURIComponent(encodedJob);
  if (!confirm(`Delete job "${job}" and all its plans? This cannot be undone.`)) return;
  // List all files recursively and delete them
  const { data } = await _sb.storage.from('plans').list(_sbUser.id + '/' + job + '/');
  for (const disc of (data || [])) {
    if (!disc.name) continue;
    const { data: files } = await _sb.storage.from('plans').list(`${_sbUser.id}/${job}/${disc.name}/`);
    const paths = (files || []).map(f => `${_sbUser.id}/${job}/${disc.name}/${f.name}`);
    if (paths.length) await _sb.storage.from('plans').remove(paths);
  }
  loadPlans();
}

// ── Job picker ───────────────────────────────────────────────────────
function triggerDashUpload() {
  document.getElementById('dashFileInput').click();
}

async function handleDashUpload(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  _pendingFile = file;
  if (_sb && _sbUser) {
    openJobPicker();
  } else {
    // No account — open tool directly
    showTool();
    handleFile(file);
  }
}

async function openJobPicker() {
  // Populate job dropdown
  const sel = document.getElementById('jobPickerJobSelect');
  sel.innerHTML = '<option value="">Select a job…</option>';
  if (_existingJobs.length === 0) {
    // fetch jobs if not cached
    const { data } = await _sb.storage.from('plans').list(_sbUser.id + '/');
    _existingJobs = (data || []).filter(f => f.metadata == null && f.name && !f.name.startsWith('.')).map(f => f.name);
  }
  _existingJobs.forEach(j => {
    const opt = document.createElement('option'); opt.value = j; opt.textContent = j; sel.appendChild(opt);
  });
  sel.innerHTML += '<option value="__new__">+ New job…</option>';
  // Pre-select current job if we're inside one
  if (_currentJob) sel.value = _currentJob;
  // Pre-select current discipline
  if (_currentDisc) document.getElementById('jobPickerDisc').value = _currentDisc;
  document.getElementById('jobPickerJobInput').style.display = 'none';
  document.getElementById('jobPickerOverlay').classList.add('open');
}

function closeJobPicker() {
  document.getElementById('jobPickerOverlay').classList.remove('open');
  _pendingFile = null;
}

function jobPickerJobChange(sel) {
  const inp = document.getElementById('jobPickerJobInput');
  inp.style.display = sel.value === '__new__' ? 'block' : 'none';
  if (sel.value === '__new__') inp.focus();
}

// ── Inspections (field app data) ────────────────────────────────────
async function loadInspections() {
  const el = document.getElementById('inspectionsGrid');
  if (!_sb || !_sbUser) { el.innerHTML = '<div class="dash-loader">Log in to see inspections.</div>'; return; }
  el.innerHTML = '<div class="dash-loader">Loading inspections…</div>';
  try {
    const { data, error } = await _sb.storage
      .from('inspections')
      .list(_sbUser.id + '/', { sortBy: { column: 'created_at', order: 'desc' } });
    if (error) throw error;
    const files = (data || []).filter(f => f.name && !f.name.startsWith('.'));

    // Always fetch assigned-to-me inspections — don't gate on _currentOrg
    // (the assignee might not have opened the Org tab yet)
    let assigned = [];
    try {
      const { data: aData } = await _sb.from('inspection_assignments')
        .select('*').eq('assigned_to', _sbUser.id).order('created_at', { ascending: false });
      assigned = aData || [];
    } catch(e) { /* table may not exist yet, ignore */ }

    if (files.length === 0 && assigned.length === 0) {
      el.innerHTML = `<div class="plans-empty"><div class="empty-icon">📋</div><p>No inspections yet.<br>Create one using "Create Inspection" after a scan.</p></div>`;
      return;
    }


    el.innerHTML = '';

    // My inspections section
    if (files.length > 0) {
      if (assigned.length > 0) {
        const lbl = document.createElement('div');
        lbl.className = 'insp-section-label';
        lbl.textContent = 'Created by me';
        el.appendChild(lbl);
      }
      files.forEach(f => {
        const enc  = encodeURIComponent(f.name);
        const date = f.created_at ? new Date(f.created_at).toLocaleDateString() : '';
        const displayName = f.name.replace(/^\d{4}-\d{2}-\d{2}T[^_]+_/, '').replace(/\.json$/, '').replace(/_/g,' ');
        const storagePath = _sbUser.id + '/' + f.name;
        const div = document.createElement('div');
        div.className = 'insp-card';
        div.onclick = () => openInspection(enc);
        div.innerHTML = `<div class="insp-icon">📋</div>
          <div class="insp-info">
            <div class="insp-name" title="${f.name}">${displayName}</div>
            <div class="insp-date">${date}</div>
          </div>
          ${_currentOrg ? `<button class="insp-assign" onclick="event.stopPropagation();openAssignModal('${storagePath}','${displayName.replace(/'/g,"\\'")}')">Assign →</button>` : ''}
          <button class="insp-del" onclick="event.stopPropagation();deleteInspection('${enc}')">✕</button>`;
        el.appendChild(div);
      });
    }

    // Assigned-to-me section
    if (assigned.length > 0) {
      const lbl = document.createElement('div');
      lbl.className = 'insp-section-label';
      lbl.textContent = 'Assigned to me';
      el.appendChild(lbl);
      assigned.forEach(a => {
        const div = document.createElement('div');
        div.className = 'insp-card';
        div.onclick = () => openInspectionByPath(a.inspection_path);
        div.innerHTML = `<div class="insp-icon">📋</div>
          <div class="insp-info">
            <div class="insp-name">${a.inspection_name}</div>
            <div class="insp-date">From: ${a.assigned_by_email || 'teammate'} · ${new Date(a.created_at).toLocaleDateString()}</div>
          </div>
          <span class="insp-badge">Assigned</span>`;
        el.appendChild(div);
      });
    }

    if (files.length === 0 && assigned.length === 0) {
      el.innerHTML = `<div class="plans-empty"><div class="empty-icon">📋</div><p>No inspections yet.<br>Create one using "Create Inspection" after a scan.</p></div>`;
      return;
    }
  } catch(e) {
    el.innerHTML = `<div class="dash-loader">Could not load inspections: ${e.message}</div>`;
  }
}

async function openInspectionByPath(storagePath) {
  _fieldCurrentPath = storagePath;
  try {
    const { data, error } = await _sb.storage.from('inspections').download(storagePath);
    if (error) throw error;
    const text = await data.text();
    _fieldData = JSON.parse(text);
    showField();
    renderFieldDrawing();
  } catch(e) { alert('Could not open inspection: ' + e.message); }
}

async function openInspection(encodedName) {
  const name = decodeURIComponent(encodedName);
  _fieldCurrentPath = _sbUser.id + '/' + name;
  try {
    const { data, error } = await _sb.storage.from('inspections').download(_fieldCurrentPath);
    if (error) throw error;
    const text = await data.text();
    _fieldData = JSON.parse(text);
    // Restore localStorage progress if available
    const saved = localStorage.getItem('qaqc_session_' + _fieldData.exportedAt);
    if (saved) { try { _fieldData.findings = JSON.parse(saved).findings; } catch(e) {} }
    showField();
    renderFieldDrawing();
  } catch(e) {
    alert('Could not open inspection: ' + e.message);
  }
}

async function deleteInspection(encodedName) {
  const name = decodeURIComponent(encodedName);
  if (!confirm('Delete this inspection? This cannot be undone.')) return;
  const { error } = await _sb.storage.from('inspections').remove([_sbUser.id + '/' + name]);
  if (error) { alert('Delete failed: ' + error.message); return; }
  loadInspections();
}

// ── Organizations ────────────────────────────────────────────────────────

let _currentOrg    = null; // {id, name, invite_code}
let _orgMembers    = [];   // [{user_id, email}]
let _pendingAssign = null; // {path, name} while assign modal is open

const ORG_SETUP_SQL = `-- Run this once in Supabase SQL Editor

create table if not exists organizations (
  id          uuid default gen_random_uuid() primary key,
  name        text not null,
  invite_code text unique not null,
  created_by  uuid references auth.users(id),
  created_at  timestamptz default now()
);

create table if not exists org_members (
  org_id    uuid references organizations(id) on delete cascade,
  user_id   uuid references auth.users(id) on delete cascade,
  email     text not null,
  joined_at timestamptz default now(),
  primary key (org_id, user_id)
);

create table if not exists inspection_assignments (
  id                uuid default gen_random_uuid() primary key,
  org_id            uuid references organizations(id),
  inspection_path   text not null,
  inspection_name   text not null,
  assigned_by       uuid references auth.users(id),
  assigned_by_email text,
  assigned_to       uuid references auth.users(id),
  created_at        timestamptz default now()
);

alter table organizations          enable row level security;
alter table org_members            enable row level security;
alter table inspection_assignments enable row level security;

create policy "orgs_read"   on organizations for select using (auth.uid() is not null);
create policy "orgs_insert" on organizations for insert with check (auth.uid() = created_by);

-- Returns uuid[] array (not a set) — required for use in policy expressions
create or replace function get_my_org_ids()
returns uuid[] language sql security definer stable as $$
  select array_agg(org_id) from org_members where user_id = auth.uid()
$$;

create policy "members_read" on org_members
  for select using (user_id = auth.uid() or org_id = any(get_my_org_ids()));
create policy "members_insert" on org_members for insert with check (user_id = auth.uid());

create policy "assign_read" on inspection_assignments
  for select using (assigned_by = auth.uid() or assigned_to = auth.uid());
create policy "assign_insert" on inspection_assignments
  for insert with check (
    assigned_by = auth.uid() and
    exists (select 1 from org_members where org_id = inspection_assignments.org_id and user_id = auth.uid())
  );`;

function showDbSetup() {
  document.getElementById('dbSetupSql').textContent = ORG_SETUP_SQL;
  document.getElementById('dbSetupOverlay').classList.add('open');
}
let _dbSetupDismissed = false;
function closeDbSetup() {
  _dbSetupDismissed = true;
  document.getElementById('dbSetupOverlay').classList.remove('open');
  loadOrgPane();
}
function copyDbSetupSql() {
  navigator.clipboard.writeText(ORG_SETUP_SQL).then(() => {
    const btn = document.querySelector('.db-setup-copy');
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.textContent = '📋 Copy SQL', 2000);
  });
}

async function loadOrgPane() {
  const el = document.getElementById('orgContent');
  if (!_sb || !_sbUser) { el.innerHTML = '<div class="dash-loader">Log in to use organizations.</div>'; return; }
  el.innerHTML = '<div class="dash-loader">Loading…</div>';
  try {
    const { data: myMemberships, error } = await _sb
      .from('org_members').select('org_id, email').eq('user_id', _sbUser.id);
    if (error) {
      // Only show DB setup if the table genuinely doesn't exist yet
      const tablesMissing = error.code === '42P01' || (error.message||'').includes('does not exist');
      if (tablesMissing && !_dbSetupDismissed) {
        showDbSetup();
        el.innerHTML = '<div class="dash-loader">Database setup required — see instructions above.</div>';
      } else {
        el.innerHTML = `<div class="dash-loader">Could not load org: ${error.message}</div>`;
      }
      return;
    }
    if (!myMemberships || myMemberships.length === 0) {
      _currentOrg = null; _orgMembers = [];
      renderOrgEmpty(el); return;
    }
    const orgId = myMemberships[0].org_id;
    const { data: orgData, error: orgErr } = await _sb.from('organizations').select('*').eq('id', orgId).single();
    if (orgErr) throw orgErr;
    _currentOrg = orgData;
    const { data: members } = await _sb.from('org_members').select('user_id, email').eq('org_id', orgId);
    _orgMembers = members || [];
    renderOrgCard(el);
  } catch(e) {
    el.innerHTML = `<div class="dash-loader">Error: ${e.message}</div>`;
  }
}

function renderOrgEmpty(el) {
  el.innerHTML = `<div class="org-empty">
    <div class="org-empty-icon">🏢</div>
    <p>Create or join an organization to assign inspections to teammates.</p>
    <div class="org-action-row">
      <button class="org-action-btn primary" onclick="showOrgCreate()">+ Create Organization</button>
      <button class="org-action-btn secondary" onclick="showOrgJoin()">Enter Invite Code</button>
    </div></div>`;
}

function renderOrgCard(el) {
  const code = _currentOrg.invite_code;
  const membersHtml = _orgMembers.map(m => {
    const initial = (m.email||'?')[0].toUpperCase();
    const isMe = m.user_id === _sbUser.id;
    return `<div class="org-member-row"><div class="org-member-avatar">${initial}</div>
      <span>${m.email}${isMe?' <span style="color:var(--text2);font-size:11px;">(you)</span>':''}</span></div>`;
  }).join('');
  el.innerHTML = `<div class="org-card">
    <div class="org-card-name">🏢 ${_currentOrg.name}</div>
    <div class="org-card-sub">${_orgMembers.length} member${_orgMembers.length!==1?'s':''}</div>
    <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px;">Invite code — share with teammates:</div>
    <div class="org-invite-row">
      <span class="org-invite-code">${code}</span>
      <button class="org-copy-btn" onclick="navigator.clipboard.writeText('${code}').then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='Copy',2000)})">Copy</button>
    </div>
    <div class="org-members-label">Members</div>
    ${membersHtml}
    <button class="org-leave-btn" onclick="leaveOrg()">Leave organization</button>
  </div>`;
}

function showOrgCreate() {
  const el = document.getElementById('orgContent');
  el.innerHTML = `<div class="org-form">
    <div class="org-form-title">Create an organization</div>
    <div class="org-form-sub">Give your team a name. You'll get an invite code to share.</div>
    <input class="org-input" id="orgNameInput" placeholder="e.g. ABC Contractors" maxlength="60" />
    <button class="org-action-btn primary" style="width:100%;" onclick="createOrg()">Create</button>
    <button class="org-action-btn secondary" style="width:100%;margin-top:8px;" onclick="loadOrgPane()">Cancel</button>
  </div>`;
  setTimeout(()=>document.getElementById('orgNameInput')?.focus(),50);
}

function showOrgJoin() {
  const el = document.getElementById('orgContent');
  el.innerHTML = `<div class="org-form">
    <div class="org-form-title">Join an organization</div>
    <div class="org-form-sub">Enter the invite code your team shared with you.</div>
    <input class="org-input" id="orgCodeInput" placeholder="Invite code" maxlength="20" style="text-transform:uppercase;letter-spacing:0.1em;" />
    <button class="org-action-btn primary" style="width:100%;" onclick="joinOrg()">Join</button>
    <button class="org-action-btn secondary" style="width:100%;margin-top:8px;" onclick="loadOrgPane()">Cancel</button>
  </div>`;
  setTimeout(()=>document.getElementById('orgCodeInput')?.focus(),50);
}

async function createOrg() {
  const name = document.getElementById('orgNameInput')?.value.trim();
  if (!name) return;
  const code = Math.random().toString(36).substring(2,6).toUpperCase()+Math.random().toString(36).substring(2,6).toUpperCase();
  try {
    const { data: org, error } = await _sb.from('organizations').insert({ name, invite_code:code, created_by:_sbUser.id }).select().single();
    if (error) throw error;
    await _sb.from('org_members').insert({ org_id:org.id, user_id:_sbUser.id, email:_sbUser.email });
    await loadOrgPane();
  } catch(e) { alert('Could not create organization: '+e.message); }
}

async function joinOrg() {
  const code = document.getElementById('orgCodeInput')?.value.trim().toUpperCase();
  if (!code) return;
  try {
    const { data: org, error } = await _sb.from('organizations').select('*').eq('invite_code',code).single();
    if (error||!org) { alert('Invite code not found. Double-check and try again.'); return; }
    const { error: joinErr } = await _sb.from('org_members').insert({ org_id:org.id, user_id:_sbUser.id, email:_sbUser.email });
    if (joinErr && !joinErr.message.includes('duplicate')) throw joinErr;
    await loadOrgPane();
  } catch(e) { alert('Could not join: '+e.message); }
}

async function leaveOrg() {
  if (!_currentOrg) return;
  if (!confirm(`Leave ${_currentOrg.name}?`)) return;
  await _sb.from('org_members').delete().match({ org_id:_currentOrg.id, user_id:_sbUser.id });
  _currentOrg=null; _orgMembers=[];
  loadOrgPane();
}

// ── Assign modal ─────────────────────────────────────────────────────────

function openAssignModal(storagePath, inspName) {
  if (!_currentOrg) { alert('Join an organization first to assign inspections.'); return; }
  _pendingAssign = { path:storagePath, name:inspName };
  document.getElementById('assignInspName').textContent = inspName;
  const others = _orgMembers.filter(m=>m.user_id!==_sbUser.id);
  const list = document.getElementById('assignMemberList');
  if (!others.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--text2);padding:12px 0;">No other members yet — share your invite code first.</div>';
  } else {
    list.innerHTML = others.map(m=>`<div class="assign-member" onclick="doAssign('${m.user_id}','${m.email.replace(/'/g,"\\'")}')">
      <div class="assign-member-avatar">${(m.email||'?')[0].toUpperCase()}</div>
      <span class="assign-member-email">${m.email}</span></div>`).join('');
  }
  document.getElementById('assignOverlay').classList.add('open');
}
function closeAssignModal() {
  document.getElementById('assignOverlay').classList.remove('open');
  _pendingAssign=null;
}
async function doAssign(toUserId, toEmail) {
  if (!_pendingAssign||!_currentOrg) return;
  try {
    const { error } = await _sb.from('inspection_assignments').upsert({
      org_id:_currentOrg.id, inspection_path:_pendingAssign.path,
      inspection_name:_pendingAssign.name, assigned_by:_sbUser.id,
      assigned_by_email:_sbUser.email, assigned_to:toUserId,
    }, { onConflict: 'inspection_path,assigned_to' });
    if (error) throw error;
    closeAssignModal();
    showBanner(`✓ Assigned to ${toEmail}`);
  } catch(e) { alert('Could not assign: '+e.message); }
}

function triggerDashUpload() {
  document.getElementById('dashFileInput').click();
}

async function handleDashUpload(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  if (_sb && _sbUser) {
    // Upload to storage in background; open immediately without waiting
    _sb.storage.from('plans').upload(_sbUser.id + '/' + file.name, file, { upsert: true })
      .catch(e => console.warn('[QAQC] Background upload failed:', e));
  }
  showTool();
  handleFile(file);
}

// ── PDF.js worker setup — fetch + blob so it works from file:// (local HTML)
// Chrome blocks cross-origin workers when the page is a local file, so we
// fetch the worker script and hand it a blob: URL instead of a CDN URL.
(async function initPdfWorker(){
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  try {
    const resp = await fetch(CDN);
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const text = await resp.text();
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
      new Blob([text], {type:'application/javascript'})
    );
  } catch(e) {
    // Fallback: run PDF.js in the main thread (slower, no worker)
    console.warn('[QAQC] Worker CDN fetch failed — falling back to main-thread PDF processing.', e);
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  }
})();

let findings=[], filteredFindingsForDisplay=[], activeIdx=-1, templateCanvas=null, originalTemplateCanvas=null, mode='idle';
let preSearchTextLocations=[]; // Text locations to filter by during search
let rejectedFindings=[]; // matches the user has marked wrong, for the live calibration summary
let pendingFieldExport=false; // when true, completing review auto-triggers field app export
let detailLegendCaptured=false; // whether user captured a detail legend for classification
let textSearchDetailDataUrl=null; // uploaded detail photo for text search scan
// ── QAQC session accumulator ──
// Each entry = one completed scan, stored here permanently until the
// user exports or clears. Multiple scans (hold-downs, shear walls, etc.)
// all accumulate here so one PDF captures the whole session.
let qaqcSession=[]; // [{label, query, detailImg, markedUpImg, types:[{type,count,description}]}]
let templateCanvas2=null;
let debugMode=false, debugScoreAtFn=null; // set during debug scan so canvas click can probe score
let selStart=null, selEnd=null, isPanning=false, panStart=null, isSelecting=false;
let manualMarkupMode=false;
let isSelectingTemplate2=false;
let scale=1, panX=0, panY=0, lastPinchDist=null;
let searchRegion=null; // {x1,y1,x2,y2} in canvas pixels
// selStart/selEnd are reused as scratch drag-tracking for THREE different
// drags (template, template-2, and the search region) — they get
// overwritten the moment any later drag happens. The vector engine needs
// the ORIGINAL template's box to still be intact even after a search
// region is drawn afterward, so it gets its own permanent home here,
// captured once at the moment of a successful captureTemplate() call.
let templateSelBox=null; // {x1,y1,x2,y2} in canvas pixels, set once at capture
let templateSelBox2=null;
let templateSelBoxOriginal=null; // {x1,y1,x2,y2} BEFORE auto-crop — used for text detection

// Increments every time the template actually changes (a fresh drag
// capture, or saving an edit in the cleanup editor) — never on a scan.
// Two scans that report the same capture ID used the literally identical
// template, byte for byte; there is zero randomness anywhere in the
// matching code, so if you re-run a scan against an unchanged capture ID
// the result has to come out exactly the same every time. This exists
// specifically so re-dragging/re-erasing variability — which a human
// hand can't perfectly repeat — doesn't get mistaken for inconsistency
// in the matching logic itself when you're trying to fine-tune.
let templateCaptureId=0;
function bumpTemplateCaptureId(){
  templateCaptureId++;
  const badge=document.getElementById('captureIdBadge');
  if(badge) badge.textContent=`Template capture #${templateCaptureId} — unchanged until you re-drag or re-edit it`;
}

// Template editor state
let editTool='erase', isEditing=false;
const DISPLAY_SIZE = 400;

const uploadZone=document.getElementById('uploadZone'), fileInput=document.getElementById('fileInput');
const uploadOverlay=document.getElementById('uploadOverlay'), zoomViewport=document.getElementById('zoomViewport');
const zoomContent=document.getElementById('zoomContent'), pdfCanvas=document.getElementById('pdfCanvas');
const overlayCanvas=document.getElementById('overlayCanvas'), selBand=document.getElementById('selBand');
const selBandSize=document.getElementById('selBandSize');
const zoomControls=document.getElementById('zoomControls'), zoomLabel=document.getElementById('zoomLabel');
const canvasBanner=document.getElementById('canvasBanner'), statusEl=document.getElementById('status');
const errorEl=document.getElementById('errorMsg'), findingsWrap=document.getElementById('findingsWrap');
const findingList=document.getElementById('findingList'), instrSelect=document.getElementById('instrSelect');
const instrReady=document.getElementById('instrReady'), examplePreview=document.getElementById('examplePreview');
const exampleImg=document.getElementById('exampleImg'), step2Wrap=document.getElementById('regionWrap');
const findBtn=document.getElementById('findBtn')||{disabled:false}, bottomBar=document.getElementById('bottomBar');
const progressWrap=document.getElementById('progressWrap'), progressBar=document.getElementById('progressBar');
const progressLabel=document.getElementById('progressLabel');
const templateModal=document.getElementById('templateModal');
const templateEditCanvas=document.getElementById('templateEditCanvas');
const ctx=pdfCanvas.getContext('2d'), octx=overlayCanvas.getContext('2d');
const tectx=templateEditCanvas.getContext('2d');

// ── Upload ──
uploadZone.addEventListener('click',()=>fileInput.click());
uploadZone.addEventListener('dragover',e=>{e.preventDefault();uploadZone.classList.add('dragging');});
uploadZone.addEventListener('dragleave',()=>uploadZone.classList.remove('dragging'));
uploadZone.addEventListener('drop',e=>{e.preventDefault();uploadZone.classList.remove('dragging');handleFile(e.dataTransfer.files[0]);});
fileInput.addEventListener('change',e=>handleFile(e.target.files[0]));

// Also allow dropping a new file directly onto the canvas panel at any time
document.querySelector('.canvas-panel').addEventListener('dragover',e=>e.preventDefault());
document.querySelector('.canvas-panel').addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0]);});

// Extra rotation applied by the rotate button (0, 90, 180, 270)
let _pdfRotation = 0;
async function rotatePdf() {
  if (!pdfCurrentPage) return;
  _pdfRotation = (_pdfRotation + 90) % 360;
  const baseVp = pdfCurrentPage.getViewport({scale:1.0});
  const DESIRED_SCALE=7.0, MAX_DIM=10000;
  const longestAtDesired = Math.max(baseVp.width,baseVp.height)*DESIRED_SCALE;
  const finalScale = longestAtDesired>MAX_DIM ? MAX_DIM/Math.max(baseVp.width,baseVp.height) : DESIRED_SCALE;
  const totalRotation = (pdfCurrentPage.rotate + _pdfRotation) % 360;
  const vp = pdfCurrentPage.getViewport({scale:finalScale, rotation:totalRotation});
  pdfCurrentViewport = vp; pdfRenderScale = finalScale;
  pdfCanvas.width=vp.width; pdfCanvas.height=vp.height;
  overlayCanvas.width=vp.width; overlayCanvas.height=vp.height;
  pdfCanvas.style.width=vp.width+'px'; pdfCanvas.style.height=vp.height+'px';
  overlayCanvas.style.width=vp.width+'px'; overlayCanvas.style.height=vp.height+'px';
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,vp.width,vp.height);
  await pdfCurrentPage.render({canvasContext:ctx,viewport:vp}).promise;
  zoomFit();
}

async function handleFile(file) {
  if(!file) return;
  _pdfRotation = 0; // reset rotation for each new file
  // Auto-save to cloud when logged in via drag-drop or file picker
  if (_sb && _sbUser && file.type === 'application/pdf') {
    _sb.storage.from('plans').upload(_sbUser.id + '/' + file.name, file, { upsert: true })
      .catch(e => console.warn('[QAQC] Cloud save failed:', e));
  }
  hideError(); showStatus('Loading drawing...',true);
  try {
    if(file.type==='application/pdf') {
      if(typeof pdfjsLib==='undefined') throw new Error('PDF library not loaded — make sure you have an internet connection on first open (needed to load PDF.js from CDN).');
      const buf=await file.arrayBuffer();
      const pdf=await pdfjsLib.getDocument({data:buf}).promise;
      const page=await pdf.getPage(1);
      // A full architectural sheet rendered at high resolution (scale 7.0)
      // can produce a 14,000+ px canvas, which makes panning/zooming
      // extremely laggy regardless of the matching algorithm. Cap the
      // longest side so large sheets get scaled down, while small pages
      // still render at full requested resolution. Bumped from the
      // previous 6.0x to 7.0x (with MAX_DIM raised proportionally, so
      // this doesn't make the downscale cap trigger any sooner than
      // before) — more real pixels for the pixel-matching engine's edge
      // detection, and a sharper, less pixelated image to capture
      // templates from in the first place.
      const baseVp=page.getViewport({scale:1.0});
      const DESIRED_SCALE=7.0, MAX_DIM=10000;
      const longestAtDesired=Math.max(baseVp.width,baseVp.height)*DESIRED_SCALE;
      const finalScale = longestAtDesired>MAX_DIM ? MAX_DIM/Math.max(baseVp.width,baseVp.height) : DESIRED_SCALE;
      const totalRotation = (page.rotate + _pdfRotation) % 360;
      const vp=page.getViewport({scale:finalScale, rotation:totalRotation});
      pdfCurrentPage=page; pdfCurrentViewport=vp; pdfRenderScale=finalScale;
      clearTextCache();
      pdfCanvas.width=vp.width; pdfCanvas.height=vp.height;
      // Fill white background so PDFs with transparency don't look washed out
      ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,vp.width,vp.height);
      await page.render({canvasContext:ctx,viewport:vp}).promise;
      if(finalScale<DESIRED_SCALE) console.log(`[QAQC] Large sheet — rendering at ${finalScale.toFixed(2)}x (~${Math.round(finalScale*72)} DPI) instead of ${DESIRED_SCALE}x to keep panning/zooming smooth. Canvas: ${vp.width}x${vp.height}.`);
    } else {
      await new Promise((res,rej)=>{
        const r=new FileReader();
        r.onload=e=>{
          const img=new Image();
          img.onload=()=>{pdfCanvas.width=img.naturalWidth;pdfCanvas.height=img.naturalHeight;ctx.drawImage(img,0,0);res();};
          img.onerror=rej; img.src=e.target.result;
        };
        r.onerror=rej; r.readAsDataURL(file);
      });
    }
    overlayCanvas.width=pdfCanvas.width; overlayCanvas.height=pdfCanvas.height;
    pdfCanvas.style.width=pdfCanvas.width+'px'; pdfCanvas.style.height=pdfCanvas.height+'px';
    overlayCanvas.style.width=pdfCanvas.width+'px'; overlayCanvas.style.height=pdfCanvas.height+'px';
    uploadOverlay.classList.add('hidden');
    zoomControls.classList.add('visible');
    document.getElementById('step1Btn').disabled=false;
    // Show detail folder toggle whenever a drawing is loaded
    renderFolderPanel();
    zoomFit(); hideStatus();
  } catch(e){showError('Could not load: '+e.message);hideStatus();}
}

// ── Zoom/Pan ──
// Cache viewport rect — only invalidate on resize, never on every wheel/pointer event
let _vpRect=null;
function getVpRect(){if(!_vpRect)_vpRect=zoomViewport.getBoundingClientRect();return _vpRect;}
window.addEventListener('resize',()=>{_vpRect=null;},passive=true);
let _rafPending=false;
function applyTransform(){
  zoomContent.style.transform=`translate3d(${panX}px,${panY}px,0) scale(${scale})`;
  zoomLabel.textContent=Math.round(scale*100)+'%';
}
function zoomFit(){_vpRect=null;const vp=getVpRect();scale=Math.min(vp.width/pdfCanvas.width,vp.height/pdfCanvas.height)*0.95;panX=(vp.width-pdfCanvas.width*scale)/2;panY=(vp.height-pdfCanvas.height*scale)/2;applyTransform();}
function zoomIn(){const vp=getVpRect();zoomAround(vp.width/2,vp.height/2,1.4);}
function zoomOut(){const vp=getVpRect();zoomAround(vp.width/2,vp.height/2,1/1.4);}
function zoomAround(vpX,vpY,factor){const ns=Math.min(12,Math.max(0.05,scale*factor)),r=ns/scale;panX=vpX-r*(vpX-panX);panY=vpY-r*(vpY-panY);scale=ns;applyTransform();}
// Wheel: batch per-frame, normalize to direction so pace is always consistent.
// CSS transition on .zoom-content smooths each step — no momentum/coasting.
let _wheelSteps=0,_wheelCx=0,_wheelCy=0,_wheelRaf=false;
const ZOOM_STEP=1.12;
zoomViewport.addEventListener('wheel',e=>{
  e.preventDefault();
  const rect=getVpRect();
  _wheelCx=e.clientX-rect.left;
  _wheelCy=e.clientY-rect.top;
  _wheelSteps+=Math.sign(e.deltaY);
  if(!_wheelRaf){_wheelRaf=true;requestAnimationFrame(()=>{
    if(_wheelSteps!==0) zoomAround(_wheelCx,_wheelCy,Math.pow(ZOOM_STEP,-_wheelSteps));
    _wheelSteps=0;_wheelRaf=false;
  });}
},{passive:false});
zoomViewport.addEventListener('touchstart',e=>{if(e.touches.length===2)lastPinchDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);},{passive:true});
zoomViewport.addEventListener('touchmove',e=>{if(e.touches.length===2&&lastPinchDist){e.preventDefault();const dist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);const cx=(e.touches[0].clientX+e.touches[1].clientX)/2,cy=(e.touches[0].clientY+e.touches[1].clientY)/2;const rect=getVpRect();zoomAround(cx-rect.left,cy-rect.top,dist/lastPinchDist);lastPinchDist=dist;}},{passive:false});
zoomViewport.addEventListener('touchend',()=>{lastPinchDist=null;},{passive:true});
zoomViewport.addEventListener('pointerdown',onPointerDown);
zoomViewport.addEventListener('pointermove',onPointerMove);
zoomViewport.addEventListener('pointerup',onPointerUp);
zoomViewport.addEventListener('pointercancel',onPointerUp);

function vpToCanvas(cx,cy){const r=zoomViewport.getBoundingClientRect();return{x:(cx-r.left-panX)/scale,y:(cy-r.top-panY)/scale};}
function canvasToVp(cx,cy){return{x:cx*scale+panX,y:cy*scale+panY};}

function onPointerDown(e){
  if(e.touches&&e.touches.length>1)return;

  // ── Detail: resize handle drag ──
  if(activePlacement){
    const c=vpToCanvas(e.clientX,e.clientY);
    const handle=getPlacementHandle(c.x,c.y);
    if(handle){
      activePlacement.draggingHandle=handle;
      activePlacement._drag={startX:c.x,startY:c.y,origX:activePlacement.x,origY:activePlacement.y,origW:activePlacement.w,origH:activePlacement.h};
      e.preventDefault(); return;
    }
    // Click anywhere else while in detail-resize mode — move the detail (center on click)
    const c2=vpToCanvas(e.clientX,e.clientY);
    activePlacement.x=c2.x-activePlacement.w/2;
    activePlacement.y=c2.y-activePlacement.h/2;
    drawMarkers(activeIdx);
    e.preventDefault(); return;
  }

  // ── Detail: drag to draw placement box ──
  if(mode==='placing'&&placingDetail){
    const c=vpToCanvas(e.clientX,e.clientY);
    isSelecting=true; selStart=c; selEnd=c;
    selBand.style.display='block'; updateSelBand();
    e.preventDefault(); return;
  }

  if(isInManualMarkupMode){
    const c=vpToCanvas(e.clientX,e.clientY);
    manualBoxStart=c;
    manualBoxEnd=c;
    e.preventDefault(); e.stopPropagation(); return;
  }
  if(mode==='debug'&&debugScoreAtFn){
    // In debug mode: click anywhere to probe the NCC score at that point
    const c=vpToCanvas(e.clientX,e.clientY);
    const score=debugScoreAtFn(c.x,c.y);
    const threshold=parseInt(document.getElementById('threshold').value)/100;
    const el=document.getElementById('probeResult');
    if(el&&score!==null){
      const pct=Math.round(score*100);
      const verdict= score>=threshold ? `✅ ABOVE threshold — would be caught`
                   : score>=threshold*0.7 ? `🟠 Close miss — try lowering threshold to ${Math.round(score*100)-2}%`
                   : `❌ Low score — template may not match this symbol's shape/size`;
      el.style.display='block';
      el.innerHTML=`<b>Score at click: ${pct}%</b><br><span style="color:#666">${verdict}</span><br><span style="font-size:11px;color:#aaa">Threshold: ${Math.round(threshold*100)}%</span>`;
    }
    return;
  }
  if(mode==='selecting'||mode==='region'){
    const c=vpToCanvas(e.clientX,e.clientY);
    isSelecting=true;selStart=c;selEnd=c;
    selBand.style.display='block';updateSelBand();
    e.preventDefault();
  } else {
    isPanning=true;panStart={x:e.clientX-panX,y:e.clientY-panY};
    zoomContent.classList.add('panning');
    zoomViewport.style.cursor='grabbing';
  }
}
function onPointerMove(e){
  // ── Detail: resize handle drag ──
  if(activePlacement&&activePlacement.draggingHandle){
    const c=vpToCanvas(e.clientX,e.clientY);
    const d=activePlacement._drag;
    const dx=c.x-d.startX, dy=c.y-d.startY;
    const h=activePlacement.draggingHandle;
    if(h==='nw'){activePlacement.x=d.origX+dx;activePlacement.y=d.origY+dy;activePlacement.w=Math.max(20,d.origW-dx);activePlacement.h=Math.max(20,d.origH-dy);}
    else if(h==='ne'){activePlacement.y=d.origY+dy;activePlacement.w=Math.max(20,d.origW+dx);activePlacement.h=Math.max(20,d.origH-dy);}
    else if(h==='se'){activePlacement.w=Math.max(20,d.origW+dx);activePlacement.h=Math.max(20,d.origH+dy);}
    else if(h==='sw'){activePlacement.x=d.origX+dx;activePlacement.w=Math.max(20,d.origW-dx);activePlacement.h=Math.max(20,d.origH+dy);}
    drawMarkers(activeIdx);
    return;
  }
  // ── Detail: drag preview while drawing placement box ──
  if(mode==='placing'&&placingDetail&&isSelecting&&selStart){
    const raw=vpToCanvas(e.clientX,e.clientY);
    const dx=raw.x-selStart.x, dy=raw.y-selStart.y;
    const ar=placingDetail.nativeW/placingDetail.nativeH;
    // Constrain drag box to detail's aspect ratio (dominant axis wins)
    if(Math.abs(dx)/ar>=Math.abs(dy)){
      selEnd={x:raw.x, y:selStart.y+Math.sign(dy||1)*Math.abs(dx)/ar};
    } else {
      selEnd={x:selStart.x+Math.sign(dx||1)*Math.abs(dy)*ar, y:raw.y};
    }
    updateSelBand();
    const x1=Math.min(selStart.x,selEnd.x), y1=Math.min(selStart.y,selEnd.y);
    const w=Math.abs(selEnd.x-selStart.x), h=Math.abs(selEnd.y-selStart.y);
    if(w>4&&h>4){
      octx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
      octx.globalAlpha=0.55;
      octx.drawImage(placingDetail.img,x1,y1,w,h);
      octx.globalAlpha=1;
      if(searchRegion) drawRegionBox();
    }
    return;
  }
  if(isInManualMarkupMode&&manualBoxStart){
    manualBoxEnd=vpToCanvas(e.clientX,e.clientY);
    drawMarkers();
  }
  else if(isSelecting&&selStart){selEnd=vpToCanvas(e.clientX,e.clientY);updateSelBand();}
  else if(isPanning&&panStart){panX=e.clientX-panStart.x;panY=e.clientY-panStart.y;applyTransform();}
}
function onPointerUp(e){
  // ── Manual markup: finish box ──
  if(isInManualMarkupMode&&manualBoxStart&&manualBoxEnd){
    const x=Math.min(manualBoxStart.x,manualBoxEnd.x);
    const y=Math.min(manualBoxStart.y,manualBoxEnd.y);
    const w=Math.abs(manualBoxEnd.x-manualBoxStart.x);
    const h=Math.abs(manualBoxEnd.y-manualBoxStart.y);
    if(w>15&&h>15&&currentSelectedItem){
      currentSelectedItem.boxes.push({x,y,w,h});
      if(currentSelectedItem.inSession) syncSessionFromItems();
      updateMarkupModeCount();
      showStatus(`"${currentSelectedItem.name}" — ${currentSelectedItem.boxes.length} marked. Enter to finish.`);
    }
    manualBoxStart=null;
    manualBoxEnd=null;
    drawMarkers();
    e.preventDefault(); e.stopPropagation(); return;
  }

  // ── Detail: finish handle drag ──
  if(activePlacement&&activePlacement.draggingHandle){
    activePlacement.draggingHandle=null; activePlacement._drag=null; return;
  }
  if(isSelecting){
    isSelecting=false;selEnd=vpToCanvas(e.clientX,e.clientY);selBand.style.display='none';selBandSize.style.display='none';
    if(mode==='placing') finishPlacingDrag();
    else if(mode==='region') finishRegionSelect();
    else if(isSelectingDetailLegend) captureDetailLegend();
    else if(isSelectingTemplate2) captureTemplate2();
    else captureTemplate();
  }
  else if(isPanning){isPanning=false;zoomContent.classList.remove('panning');zoomViewport.style.cursor=(mode==='selecting'||mode==='region'||mode==='placing')?'crosshair':(activePlacement?'default':'grab');zoomViewport.classList.toggle('selecting',mode==='selecting'||mode==='region'||mode==='placing');}
}
function updateSelBand(){
  if(!selStart||!selEnd)return;
  const rect=zoomViewport.getBoundingClientRect();
  // Convert canvas coords back to screen coords relative to canvas-panel
  const s=canvasToVp(selStart.x,selStart.y);
  const e2=canvasToVp(selEnd.x,selEnd.y);
  const x1=Math.min(s.x,e2.x), y1=Math.min(s.y,e2.y);
  const x2=Math.max(s.x,e2.x), y2=Math.max(s.y,e2.y);
  selBand.style.left=x1+'px'; selBand.style.top=y1+'px';
  selBand.style.width=(x2-x1)+'px'; selBand.style.height=(y2-y1)+'px';

  // The "smaller is better" guidance below only makes sense when capturing
  // a template symbol — mode==='region' (Step 2, search area) is supposed
  // to be large, covering most of the usable plan area, so the same
  // tight/loose framing would be actively wrong there. Only show it for
  // template capture (including the optional second template).
  if(mode!=='selecting'){ selBandSize.style.display='none'; return; }

  // Live readout of the REAL canvas-pixel size being selected — this is
  // the number that actually drives template-matching, and it can differ
  // wildly from what the box looks like on screen depending on current
  // zoom: a box that looks tight at a low zoom level can still be hundreds
  // or thousands of canvas pixels across underneath.
  const cw=Math.abs(selEnd.x-selStart.x), ch=Math.abs(selEnd.y-selStart.y);
  const big=Math.max(cw,ch);
  let color, label;
  if(big<=150){color='#1D9E75';label='Tight — looks good';}
  else if(big<=400){color='#EF9F27';label='Getting large — zoom in more';}
  else {color='#c0392b';label='Way too large — zoom in a lot more';}
  selBandSize.textContent=`${Math.round(cw)} × ${Math.round(ch)} px · ${label}`;
  selBandSize.style.background=color;
  selBandSize.style.left=x1+'px';
  selBandSize.style.top=y1+'px';
  selBandSize.style.display='block';
}

// ── Background removal ──
// Makes near-white pixels transparent. threshold: 0–255, higher = more aggressive.
// Uses luminance so off-white, light grey, and cream paper all get caught.
function removeBgFromCanvas(srcCanvas, threshold) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx2 = out.getContext('2d');
  octx2.drawImage(srcCanvas, 0, 0);
  const imgData = octx2.getImageData(0, 0, w, h);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    // Perceptual luminance
    const lum = 0.299*r + 0.587*g + 0.114*b;
    if (lum >= threshold) {
      // Soft feathering: partially transparent for near-threshold pixels
      // so symbol edges don't get hard-clipped
      const alpha = Math.max(0, 1 - (lum - threshold) / (255 - threshold + 1));
      d[i+3] = Math.round(alpha * 255);
    }
  }
  octx2.putImageData(imgData, 0, 0);
  return out;
}

function reapplyBgRemoval() {
  if (!originalTemplateCanvas) return;
  const threshold = parseInt(document.getElementById('bgThreshold').value);
  const cleaned = removeBgFromCanvas(originalTemplateCanvas, threshold);
  const ratio = parseFloat(templateEditCanvas.dataset.ratio) || 1;
  tectx.clearRect(0, 0, templateEditCanvas.width, templateEditCanvas.height);
  tectx.drawImage(cleaned, 0, 0, templateEditCanvas.width, templateEditCanvas.height);
}

// ── AUTO-CROP HELPER: Find tightest box around symbol, remove all whitespace ──
// Returns {canvas, offsetX, offsetY} so caller can adjust template coordinates
// This makes selection size irrelevant — a loose box and tight box match identically
function autoTightCropTemplate(canvas){
  const w=canvas.width, h=canvas.height;
  const ctx=canvas.getContext('2d');
  const imgData=ctx.getImageData(0,0,w,h);
  const data=imgData.data;

  // Find bounding box of all meaningfully non-transparent pixels
  // Use threshold of alpha>20 to ignore very faint artifacts or anti-aliasing halos
  let minX=w, maxX=0, minY=h, maxY=0, found=false;
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const alpha=data[(y*w+x)*4+3];
      // Only count pixels with meaningful opacity (>20, not just stray render artifacts)
      if(alpha>20){
        found=true;
        minX=Math.min(minX,x);
        maxX=Math.max(maxX,x);
        minY=Math.min(minY,y);
        maxY=Math.max(maxY,y);
      }
    }
  }

  // If we found pixels and can crop, do it
  if(found && (minX>0||minY>0||maxX<w-1||maxY<h-1)){
    const cropW=maxX-minX+1, cropH=maxY-minY+1;
    const croppedCanvas=document.createElement('canvas');
    croppedCanvas.width=cropW;
    croppedCanvas.height=cropH;
    const cc=croppedCanvas.getContext('2d');
    cc.drawImage(canvas,minX,minY,cropW,cropH,0,0,cropW,cropH);
    return {canvas: croppedCanvas, offsetX: minX, offsetY: minY};
  }
  return {canvas: canvas, offsetX: 0, offsetY: 0}; // no crop needed
}

// ── Template capture ──
async function captureTemplate(){
  if(!selStart||!selEnd)return;
  const x1=Math.round(Math.min(selStart.x,selEnd.x)),y1=Math.round(Math.min(selStart.y,selEnd.y));
  const x2=Math.round(Math.max(selStart.x,selEnd.x)),y2=Math.round(Math.max(selStart.y,selEnd.y));
  const w=x2-x1,h=y2-y1;
  if(w<4||h<4){showError('Selection too small.');return;}

  // Lock this box in permanently — selStart/selEnd are about to be reused
  // as scratch space the moment a search region or second template gets
  // drawn, so the vector engine needs its own untouchable copy.
  templateSelBox={x1,y1,x2,y2};
  templateSelBoxOriginal={x1,y1,x2,y2}; // Save ORIGINAL before auto-crop adjusts it
  bumpTemplateCaptureId();

  // Capture raw original (used for restore brush and bg threshold slider)
  originalTemplateCanvas=document.createElement('canvas');
  originalTemplateCanvas.width=w;originalTemplateCanvas.height=h;
  originalTemplateCanvas.getContext('2d').drawImage(pdfCanvas,x1,y1,w,h,0,0,w,h);

  // Auto-remove white background immediately on capture
  const bgThresh = parseInt(document.getElementById('bgThreshold')?.value || '220');
  templateCanvas = removeBgFromCanvas(originalTemplateCanvas, bgThresh);

  // ── AUTO-CROP: Tighten box to symbol only (remove all whitespace) ──
  // This ensures big box / small box captures always match the same way
  const cropResult = autoTightCropTemplate(templateCanvas);
  templateCanvas = cropResult.canvas;

  // Adjust templateSelBox to account for the crop offset
  // The vector engine uses templateSelBox as the coordinate system, so it must point
  // to the actual symbol after auto-crop, not the original user-dragged selection
  templateSelBox.x1 += cropResult.offsetX;
  templateSelBox.y1 += cropResult.offsetY;
  templateSelBox.x2 = templateSelBox.x1 + templateCanvas.width;
  templateSelBox.y2 = templateSelBox.y1 + templateCanvas.height;

  // Adjust text regions to match the cropped template canvas coordinates
  // Text regions were computed relative to the original box size, but canvas is now cropped
  _templateTextRegions = _templateTextRegions.map(region => ({
    ...region,
    rx: Math.max(0, region.rx - cropResult.offsetX),
    ry: Math.max(0, region.ry - cropResult.offsetY),
    // Clamp region size to new canvas bounds
    rw: Math.min(templateCanvas.width - Math.max(0, region.rx - cropResult.offsetX), region.rw),
    rh: Math.min(templateCanvas.height - Math.max(0, region.ry - cropResult.offsetY), region.rh)
  })).filter(r => r.rw > 0 && r.rh > 0); // Remove regions that fell outside crop

  exampleImg.src=templateCanvas.toDataURL('image/png');
  // Show template size so we can verify auto-crop is working
  const sizeLabel = document.getElementById('captureIdBadge');
  if(sizeLabel) sizeLabel.textContent = `Template: ${templateCanvas.width} × ${templateCanvas.height}px`;
  examplePreview.style.display='block';

  // Show text controls immediately
  const lbl = document.getElementById('ignoreTextLabel');
  if(lbl) lbl.style.display='flex';

  // ── Text extraction via OCR (moved to ocrTemplateText above) ──
  // Reset BEFORE calling extractTemplateText so it starts fresh
  _templateTextRegions = [];
  _templateDetectedTexts = [];

  // Extract text from template area using same mechanism as text search
  // Must await this or the text won't be ready by the time user searches
  await extractTemplateText();

  instrSelect.classList.remove('active');instrReady.classList.add('active');
  step2Wrap.style.display='block';
  document.getElementById('addTemplate2Hint').style.display='block';
  document.getElementById('detailCaptureWrap').style.display='block'; // show detail legend step
  hideBanner();hideError();mode='ready';zoomViewport.style.cursor='grab';zoomViewport.classList.remove('selecting');
  octx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
  octx.strokeStyle='#EF9F27';octx.lineWidth=Math.max(overlayCanvas.width,overlayCanvas.height)*0.002;
  octx.setLineDash([6,3]);octx.strokeRect(x1,y1,w,h);octx.setLineDash([]);
}

function startSelecting2(){
  isSelectingTemplate2=true;
  mode='selecting';
  selStart=null; selEnd=null;
  selBand.style.display='none';
  selBandSize.style.display='none';
  zoomViewport.style.cursor='crosshair';
  zoomViewport.classList.add('selecting');
  showBanner('Drag a box around the second symbol (e.g. the callout number)');
}

function captureTemplate2(){
  if(!selStart||!selEnd)return;
  const x1=Math.round(Math.min(selStart.x,selEnd.x)),y1=Math.round(Math.min(selStart.y,selEnd.y));
  const x2=Math.round(Math.max(selStart.x,selEnd.x)),y2=Math.round(Math.max(selStart.y,selEnd.y));
  const w=x2-x1,h=y2-y1;
  if(w<4||h<4){showError('Selection too small.');isSelectingTemplate2=false;return;}
  templateSelBox2={x1,y1,x2,y2};
  templateCanvas2=document.createElement('canvas');
  templateCanvas2.width=w; templateCanvas2.height=h;
  templateCanvas2.getContext('2d').drawImage(pdfCanvas,x1,y1,w,h,0,0,w,h);
  const bgThresh2 = parseInt(document.getElementById('bgThreshold')?.value || '220');
  templateCanvas2 = removeBgFromCanvas(templateCanvas2, bgThresh2);

  // ── AUTO-CROP: Tighten second template to symbol only (remove all whitespace) ──
  // Ensures consistency regardless of selection box size
  const cropResult2 = autoTightCropTemplate(templateCanvas2);
  templateCanvas2 = cropResult2.canvas;

  // Adjust templateSelBox2 to account for the crop offset
  templateSelBox2.x1 += cropResult2.offsetX;
  templateSelBox2.y1 += cropResult2.offsetY;
  templateSelBox2.x2 = templateSelBox2.x1 + templateCanvas2.width;
  templateSelBox2.y2 = templateSelBox2.y1 + templateCanvas2.height;

  document.getElementById('exampleImg2').src=templateCanvas2.toDataURL('image/png');
  document.getElementById('template2Wrap').style.display='block';
  document.getElementById('addTemplate2Hint').style.display='none';
  isSelectingTemplate2=false;
  mode='ready'; zoomViewport.style.cursor='grab'; zoomViewport.classList.remove('selecting');
  hideBanner(); hideError();
}

function clearTemplate2(){
  templateCanvas2=null;templateSelBox2=null;
  document.getElementById('template2Wrap').style.display='none';
  document.getElementById('addTemplate2Hint').style.display='block';
}

// ── Region select ──
function startRegionSelect(){
  mode='region';
  isSelecting=false;
  isPanning=false;
  selStart=null; selEnd=null;
  selBand.style.display='none';
  selBandSize.style.display='none';
  zoomViewport.style.cursor='crosshair';
  zoomViewport.classList.add('selecting');
  showBanner('Drag a box around the plan area — release to confirm');
}

function finishRegionSelect(){
  if(!selStart||!selEnd)return;
  const x1=Math.round(Math.min(selStart.x,selEnd.x)), y1=Math.round(Math.min(selStart.y,selEnd.y));
  const x2=Math.round(Math.max(selStart.x,selEnd.x)), y2=Math.round(Math.max(selStart.y,selEnd.y));
  if((x2-x1)<10||(y2-y1)<10){showError('Region too small.');return;}
  searchRegion={x1,y1,x2,y2};
  document.getElementById('regionPreview').style.display='block';
  mode='ready';
  zoomViewport.style.cursor='grab';
  zoomViewport.classList.remove('selecting');
  hideBanner();
  // Draw region box on overlay
  drawRegionBox();
}

function drawRegionBox(){
  octx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
  if(searchRegion){
    const {x1,y1,x2,y2}=searchRegion;
    octx.strokeStyle='#185FA5';octx.lineWidth=Math.max(overlayCanvas.width,overlayCanvas.height)*0.003;
    octx.setLineDash([10,5]);octx.strokeRect(x1,y1,x2-x1,y2-y1);octx.setLineDash([]);
    // Dim outside region
    octx.fillStyle='rgba(0,0,0,0.25)';
    octx.fillRect(0,0,overlayCanvas.width,y1);
    octx.fillRect(0,y2,overlayCanvas.width,overlayCanvas.height-y2);
    octx.fillRect(0,y1,x1,y2-y1);
    octx.fillRect(x2,y1,overlayCanvas.width-x2,y2-y1);
  }
}

function clearRegion(){
  searchRegion=null;
  document.getElementById('regionPreview').style.display='none';
  octx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
}

// ── Template editor ──
function openTemplateEditor(){
  if(!templateCanvas)return;
  const TW=templateCanvas.width, TH=templateCanvas.height;
  const ratio=Math.min(DISPLAY_SIZE/TW, DISPLAY_SIZE/TH, 4);
  templateEditCanvas.width=Math.round(TW*ratio);
  templateEditCanvas.height=Math.round(TH*ratio);
  templateEditCanvas.style.width=templateEditCanvas.width+'px';
  templateEditCanvas.style.height=templateEditCanvas.height+'px';
  templateEditCanvas.dataset.ratio=ratio;
  tectx.imageSmoothingEnabled=false;
  // Start editor from current templateCanvas (already bg-removed)
  tectx.clearRect(0,0,templateEditCanvas.width,templateEditCanvas.height);
  tectx.drawImage(templateCanvas,0,0,templateEditCanvas.width,templateEditCanvas.height);
  templateModal.classList.add('visible');
  setTool('erase');
}

function resetTemplateEdit(){
  // Re-apply bg removal at current threshold (not fully raw)
  reapplyBgRemoval();
}

function setTool(t){
  editTool=t;
  document.getElementById('toolErase').classList.toggle('active',t==='erase');
  document.getElementById('toolRestore').classList.toggle('active',t==='restore');
  templateEditCanvas.style.cursor=t==='erase'?'cell':'crosshair';
}

templateEditCanvas.addEventListener('pointerdown',e=>{isEditing=true;paintAt(e);});
templateEditCanvas.addEventListener('pointermove',e=>{if(isEditing)paintAt(e);});
templateEditCanvas.addEventListener('pointerup',()=>{isEditing=false;});
templateEditCanvas.addEventListener('pointerleave',()=>{isEditing=false;});

function paintAt(e){
  const rect=templateEditCanvas.getBoundingClientRect();
  const x=e.clientX-rect.left, y=e.clientY-rect.top;
  const brushPx=parseInt(document.getElementById('brushSize').value);
  if(editTool==='erase'){
    tectx.globalCompositeOperation='destination-out';
    tectx.beginPath();tectx.arc(x,y,brushPx,0,Math.PI*2);tectx.fill();
    tectx.globalCompositeOperation='source-over';
  } else {
    // Restore from original
    const ratio=parseFloat(templateEditCanvas.dataset.ratio)||1;
    const ox=x/ratio, oy=y/ratio, br=brushPx/ratio;
    tectx.save();
    tectx.beginPath();tectx.arc(x,y,brushPx,0,Math.PI*2);tectx.clip();
    tectx.drawImage(originalTemplateCanvas,
      Math.max(0,ox-br), Math.max(0,oy-br), br*2, br*2,
      Math.max(0,x-brushPx), Math.max(0,y-brushPx), brushPx*2, brushPx*2);
    tectx.restore();
  }
}

function applyTemplateEdit(){
  // Copy edited canvas back to templateCanvas (at original resolution)
  const ratio=parseFloat(templateEditCanvas.dataset.ratio)||1;
  const TW=templateCanvas.width, TH=templateCanvas.height;
  const newCanvas=document.createElement('canvas');
  newCanvas.width=TW;newCanvas.height=TH;
  const nc=newCanvas.getContext('2d');
  nc.imageSmoothingEnabled=false;
  nc.drawImage(templateEditCanvas,0,0,TW,TH);

  // ── HARD TRANSPARENCY: Convert soft eraser edges to binary (full or nothing) ──
  // Problem: eraser tool creates soft anti-aliased edges. During matching, these fuzzy
  // alpha gradients cause larger templates to match noise. Solution: threshold alpha to 0 or 255.
  let imgData=nc.getImageData(0,0,TW,TH);
  let data=imgData.data;
  const alphaThresh=128; // anything below this becomes fully transparent, above becomes fully opaque
  for(let i=3;i<data.length;i+=4) { // every 4th byte is alpha (RGBA)
    data[i] = data[i]<alphaThresh ? 0 : 255;
  }
  nc.putImageData(imgData,0,0);

  // ── AUTO-CROP: Find bounding box of symbol, remove all whitespace ──
  // No matter how big the user draws the selection, crop to the tightest box around the actual symbol.
  // This normalizes template size so matching is consistent.
  imgData=nc.getImageData(0,0,TW,TH);
  data=imgData.data;
  let minX=TW, maxX=0, minY=TH, maxY=0, found=false;
  for(let y=0;y<TH;y++){
    for(let x=0;x<TW;x++){
      const alpha=data[(y*TW+x)*4+3];
      if(alpha>0){
        found=true;
        minX=Math.min(minX,x);maxX=Math.max(maxX,x);
        minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      }
    }
  }
  if(found && (minX>0||minY>0||maxX<TW-1||maxY<TH-1)){
    const cropW=maxX-minX+1, cropH=maxY-minY+1;
    const croppedCanvas=document.createElement('canvas');
    croppedCanvas.width=cropW;croppedCanvas.height=cropH;
    const cc=croppedCanvas.getContext('2d');
    cc.drawImage(newCanvas,minX,minY,cropW,cropH,0,0,cropW,cropH);
    templateCanvas=croppedCanvas;
  } else {
    templateCanvas=newCanvas;
  }
  bumpTemplateCaptureId();
  exampleImg.src=templateCanvas.toDataURL('image/png');
  templateModal.classList.remove('visible');
}

function closeTemplateEditor(){
  templateModal.classList.remove('visible');
}

// ── Edge detection (Sobel) ──
function sobelEdges(gray, w, h) {
  const edges = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[(y-1)*w+(x-1)] + gray[(y-1)*w+(x+1)]
        -2*gray[y*w+(x-1)]   + 2*gray[y*w+(x+1)]
        -gray[(y+1)*w+(x-1)] + gray[(y+1)*w+(x+1)];
      const gy =
        -gray[(y-1)*w+(x-1)] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+(x+1)]
        +gray[(y+1)*w+(x-1)] + 2*gray[(y+1)*w+x] + gray[(y+1)*w+(x+1)];
      edges[i] = Math.sqrt(gx*gx + gy*gy);
    }
  }
  // FIX 4: Use 99th-percentile normalization instead of global max.
  // A single thick border line can dominate the max and crush all interior
  // symbol edges to near-zero, killing NCC contrast. Clipping at p99
  // preserves relative edge strength where symbols actually live.
  const sorted = edges.slice().sort();
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 1;
  const norm = p99 > 0 ? p99 : 1;
  for (let i = 0; i < edges.length; i++) edges[i] = Math.min(1, edges[i] / norm);
  return edges;
}

// ── Gaussian blur (1-pass box approximation, fast) ──
function gaussianBlur(src, w, h, radius) {
  // Two-pass box blur approximation of Gaussian — fast and good enough for r≤2
  const dst = new Float32Array(src.length);
  const tmp = new Float32Array(src.length);
  const r = Math.round(radius);
  const len = 2 * r + 1;
  // Horizontal pass
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < len && x < w; x++) sum += src[y*w+x];
    for (let x = 0; x < w; x++) {
      tmp[y*w+x] = sum / Math.min(len, w);
      if (x + r + 1 < w) sum += src[y*w+(x+r+1)];
      if (x - r >= 0)    sum -= src[y*w+(x-r)];
    }
  }
  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y < len && y < h; y++) sum += tmp[y*w+x];
    for (let y = 0; y < h; y++) {
      dst[y*w+x] = sum / Math.min(len, h);
      if (y + r + 1 < h) sum += tmp[(y+r+1)*w+x];
      if (y - r >= 0)    sum -= tmp[(y-r)*w+x];
    }
  }
  return dst;
}

// ── Scale an edge map to a new size using bilinear interpolation ──
function scaleEdgeMap(src, srcW, srcH, dstW, dstH) {
  const dst = new Float32Array(dstW * dstH);
  const sx = srcW / dstW, sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const fx = x * sx, fy = y * sy;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0+1, srcW-1), y1 = Math.min(y0+1, srcH-1);
      const dx = fx - x0, dy = fy - y0;
      dst[y*dstW+x] =
        src[y0*srcW+x0]*(1-dx)*(1-dy) + src[y0*srcW+x1]*dx*(1-dy) +
        src[y1*srcW+x0]*(1-dx)*dy     + src[y1*srcW+x1]*dx*dy;
    }
  }
  return dst;
}

// ── Rotate an edge/alpha/gray map 90° clockwise (exact index permutation —
// no interpolation needed, since rotating a grid by 90° is a pure
// relabeling of cells, not a resample). Used to build rotation-hypothesis
// templates for the pixel matcher, mirroring the vector engine's
// 0/90/180/270° approach below. ──
function rotateMap90(src, w, h) {
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      dst[x * h + (h - 1 - y)] = src[y * w + x];
    }
  }
  return dst; // new dimensions are (h, w)
}


// ── Connected component labeling (two-pass union-find, 4-connectivity) ──
function connectedComponents(binary, W, H) {
  const labels = new Int32Array(W * H);
  const parent = new Int32Array(W * H + 2);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  let nextLabel = 1;

  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    a = find(a); b = find(b);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }

  // First pass: label and record equivalences
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!binary[i]) { labels[i] = 0; continue; }
      const above = y > 0 ? labels[(y - 1) * W + x] : 0;
      const left  = x > 0 ? labels[y * W + x - 1]  : 0;
      if (!above && !left) {
        labels[i] = nextLabel++;
      } else if (above && !left) {
        labels[i] = above;
      } else if (!above && left) {
        labels[i] = left;
      } else {
        labels[i] = Math.min(above, left);
        union(above, left);
      }
    }
  }
  // Second pass: resolve equivalences
  for (let i = 0; i < W * H; i++) {
    if (labels[i]) labels[i] = find(labels[i]);
  }
  return labels;
}

// ── Hu moments from an edge/gray map (7 rotation+scale invariant descriptors) ──
function computeHuMoments(edgeMap, w, h) {
  let m00=0, m10=0, m01=0, m20=0, m02=0, m11=0;
  let m30=0, m12=0, m21=0, m03=0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = edgeMap[y * w + x];
      if (v < 0.05) continue;
      m00 += v;
      m10 += x * v;       m01 += y * v;
      m20 += x*x*v;       m02 += y*y*v;       m11 += x*y*v;
      m30 += x*x*x*v;     m12 += x*y*y*v;
      m21 += x*x*y*v;     m03 += y*y*y*v;
    }
  }
  if (m00 < 1) return null;
  const cx = m10 / m00, cy = m01 / m00;
  // Central moments
  const MU20 = m20/m00 - cx*cx;
  const MU02 = m02/m00 - cy*cy;
  const MU11 = m11/m00 - cx*cy;
  const MU30 = (m30 - 3*cx*m20 + 2*cx*cx*m10) / m00;
  const MU03 = (m03 - 3*cy*m02 + 2*cy*cy*m01) / m00;
  const MU21 = (m21 - 2*cx*m11 - cy*m20 + 2*cx*cx*m01) / m00;
  const MU12 = (m12 - 2*cy*m11 - cx*m02 + 2*cy*cy*m10) / m00;
  // Scale-normalised moments
  const n2 = m00, n3 = m00 * Math.sqrt(m00);
  const nu20=MU20/n2, nu02=MU02/n2, nu11=MU11/n2;
  const nu30=MU30/n3, nu03=MU03/n3, nu21=MU21/n3, nu12=MU12/n3;
  // 7 Hu invariants
  return [
    nu20 + nu02,
    (nu20-nu02)**2 + 4*nu11**2,
    (nu30-3*nu12)**2 + (3*nu21-nu03)**2,
    (nu30+nu12)**2  + (nu21+nu03)**2,
    (nu30-3*nu12)*(nu30+nu12)*((nu30+nu12)**2 - 3*(nu21+nu03)**2)
      + (3*nu21-nu03)*(nu21+nu03)*(3*(nu30+nu12)**2 - (nu21+nu03)**2),
    (nu20-nu02)*((nu30+nu12)**2 - (nu21+nu03)**2) + 4*nu11*(nu30+nu12)*(nu21+nu03),
    (3*nu21-nu03)*(nu30+nu12)*((nu30+nu12)**2 - 3*(nu21+nu03)**2)
      - (nu30-3*nu12)*(nu21+nu03)*(3*(nu30+nu12)**2 - (nu21+nu03)**2)
  ];
}

// ── Hu moment distance (log-scale — standard approach for shape matching) ──
// Returns 0 for identical shape, larger for more different.
// Good match ≈ 0.3–2.0, false positive ≈ 4–10.
function huMomentDist(hu1, hu2) {
  if (!hu1 || !hu2) return 999;
  let d = 0;
  for (let i = 0; i < 7; i++) {
    const a = hu1[i] !== 0 ? Math.sign(hu1[i]) * Math.log10(Math.abs(hu1[i]) + 1e-10) : 0;
    const b = hu2[i] !== 0 ? Math.sign(hu2[i]) * Math.log10(Math.abs(hu2[i]) + 1e-10) : 0;
    d += Math.abs(a - b);
  }
  return d;
}

// ── Main contour match entry point ──
// Performance design: everything runs at DS=4 downsampled resolution
// (1750×1250 instead of 7000×5000), with async yields every ~50ms so
// the browser never freezes. Hu moments are scale-invariant so
// downsampled descriptors are equally valid for shape matching.
async function runContourMatch() {
  if (!templateCanvas) { showError('Select a template first (Step 1).'); return; }

  const contourBtn = document.getElementById('contourBtn');
  if (contourBtn) contourBtn.disabled = true;
  findingsWrap.style.display = 'none';
  bottomBar.classList.remove('visible');
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';
  progressLabel.textContent = 'Contour match — building template descriptor…';
  findings = []; rejectedFindings = [];

  try {
    const TW = templateCanvas.width, TH = templateCanvas.height;
    const IW = pdfCanvas.width,      IH = pdfCanvas.height;
    const DS = 4; // downsample factor — everything computed at this scale
    const DW = Math.ceil(IW / DS), DH = Math.ceil(IH / DS);

    // ── Template: compute at its native size (template is small, no perf issue) ──
    function toGrayLocal(data, w, h) {
      const g = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const a = data[i*4+3];
        if (a < 32) { g[i] = 1.0; continue; } // transparent → white (bg-removed template)
        g[i] = (0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2]) / 255;
      }
      return g;
    }

    const tData    = templateCanvas.getContext('2d').getImageData(0, 0, TW, TH).data;
    const tGray    = toGrayLocal(tData, TW, TH);
    const tEdges   = sobelEdges(gaussianBlur(tGray, TW, TH, 1), TW, TH);
    const tMoments = computeHuMoments(tEdges, TW, TH);
    if (!tMoments) {
      showError('Template is empty or too small for contour matching.');
      progressWrap.style.display = 'none';
      if (contourBtn) contourBtn.disabled = false;
      return;
    }
    const tAspect = TW / TH;

    // ── Drawing: build downsampled grayscale in async row-chunks ──
    // Each chunk covers ~60 DS-rows = 240 full-res rows × full width.
    // At 7000px wide that's ~1.7M pixel reads per chunk ≈ 15ms — comfortably
    // under the 50ms frame budget, so the browser never freezes.
    progressBar.style.width = '5%';
    progressLabel.textContent = 'Contour match — reading drawing pixels…';
    await new Promise(r => setTimeout(r, 0));

    const iData = ctx.getImageData(0, 0, IW, IH).data;
    const dsGray = new Float32Array(DW * DH);

    await new Promise(resolve => {
      let dy = 0;
      function chunkGray() {
        const end = Math.min(dy + 60, DH);
        for (; dy < end; dy++) {
          for (let dx = 0; dx < DW; dx++) {
            let sum = 0, cnt = 0;
            for (let oy = 0; oy < DS && dy*DS+oy < IH; oy++) {
              for (let ox = 0; ox < DS && dx*DS+ox < IW; ox++) {
                const p = ((dy*DS+oy)*IW + (dx*DS+ox)) * 4;
                sum += 0.299*iData[p] + 0.587*iData[p+1] + 0.114*iData[p+2];
                cnt++;
              }
            }
            dsGray[dy * DW + dx] = cnt > 0 ? sum / (cnt * 255) : 0;
          }
        }
        progressBar.style.width = (5 + (dy / DH) * 20).toFixed(1) + '%';
        if (dy < DH) { setTimeout(chunkGray, 0); } else { resolve(); }
      }
      chunkGray();
    });

    // ── Edge detection at DS resolution (~2M pixels, fast) ──
    progressBar.style.width = '26%';
    progressLabel.textContent = 'Contour match — computing edge map…';
    await new Promise(r => setTimeout(r, 0));

    const dsBlurred = gaussianBlur(dsGray, DW, DH, 1);
    const dsEdges   = sobelEdges(dsBlurred, DW, DH);

    // ── Template at DS scale — needed to know search window size ──
    // Hu moments are scale-invariant so matching across resolutions is valid.
    const tDsW = Math.max(4, Math.round(TW / DS));
    const tDsH = Math.max(4, Math.round(TH / DS));

    // ── Integral image of dsEdges — O(1) window-sum queries for pre-filter ──
    progressBar.style.width = '32%';
    progressLabel.textContent = 'Contour match — building integral image…';
    await new Promise(r => setTimeout(r, 0));

    const dsInt = new Float64Array((DW + 1) * (DH + 1));
    for (let y = 0; y < DH; y++) {
      for (let x = 0; x < DW; x++) {
        dsInt[(y+1)*(DW+1)+(x+1)] =
          dsEdges[y*DW+x]
          + dsInt[y*(DW+1)+(x+1)]
          + dsInt[(y+1)*(DW+1)+x]
          - dsInt[y*(DW+1)+x];
      }
    }
    function dsWindowSum(x, y, w, h) {
      return dsInt[(y+h)*(DW+1)+(x+w)] - dsInt[y*(DW+1)+(x+w)]
           - dsInt[(y+h)*(DW+1)+x]     + dsInt[y*(DW+1)+x];
    }

    // ── Template edge energy at DS scale (for density pre-filter) ──
    // Scale the template edge map down to DS size so the energy is comparable.
    const tEdgesDs    = scaleEdgeMap(tEdges, TW, TH, tDsW, tDsH);
    let   tEnergyDs   = 0;
    for (let i = 0; i < tDsW * tDsH; i++) tEnergyDs += tEdgesDs[i];
    tEnergyDs = Math.max(tEnergyDs, 0.5); // guard against empty template

    // ── Sliding window pre-filter: collect non-empty positions ──
    // Stride ≈ template_size/6 so we don't miss symbols sitting between steps.
    // Pre-filter skips blank windows (no edges) and extremely busy ones (hatch/text).
    progressBar.style.width = '40%';
    progressLabel.textContent = 'Contour match — scanning drawing…';
    await new Promise(r => setTimeout(r, 0));

    // Wider stride = fewer windows = faster + less overlap between candidates.
    // template_size/4 means ~4 steps across the symbol, enough to catch any alignment.
    const stride = Math.max(3, Math.round(Math.min(tDsW, tDsH) / 4));
    const preFiltered = [];
    for (let y = 0; y <= DH - tDsH; y += stride) {
      for (let x = 0; x <= DW - tDsW; x += stride) {
        const wSum = dsWindowSum(x, y, tDsW, tDsH);
        const ratio = wSum / tEnergyDs;
        // Tighter density gate: must have 15–500% of template edge energy.
        // < 0.15 = blank area (no symbol here). > 5.0 = dense hatch/text (too noisy).
        if (ratio < 0.15 || ratio > 5.0) continue;
        preFiltered.push({ x, y });
      }
    }

    // ── Sensitivity → max Hu distance ──
    // Hu distances on real symbol matches: ~0.3–1.5. False positives: 2–8.
    // Recalibrated: slider 5 (permissive) → 2.5; slider 95 (strict) → 0.3
    const sliderVal = parseInt(document.getElementById('threshold').value);
    const maxDist = Math.max(0.25, 2.7 - sliderVal * 0.025);

    progressBar.style.width = '48%';
    progressLabel.textContent = `Contour match — comparing ${preFiltered.length} windows…`;
    await new Promise(r => setTimeout(r, 0));

    // ── Hu moment comparison per pre-filtered window, batched ──
    // Each window is tDsW×tDsH pixels — small. BATCH=60 keeps each chunk ≈20ms.
    const results = [];
    let done = 0;
    const BATCH = 60;

    await new Promise(resolve => {
      function processBatch() {
        const end = Math.min(done + BATCH, preFiltered.length);
        for (; done < end; done++) {
          const { x, y } = preFiltered[done];

          // Extract DS-scale patch
          const patch = new Float32Array(tDsW * tDsH);
          for (let py = 0; py < tDsH; py++)
            for (let px = 0; px < tDsW; px++)
              patch[py * tDsW + px] = dsEdges[(y + py) * DW + (x + px)];

          const moments = computeHuMoments(patch, tDsW, tDsH);
          if (!moments) continue;

          const dist = huMomentDist(tMoments, moments);
          if (dist > maxDist) continue;

          const score = Math.max(0, 1 - dist / maxDist);
          results.push({
            x: (x + tDsW / 2) * DS,
            y: (y + tDsH / 2) * DS,
            score, dist
          });
        }
        const pct = 48 + (done / Math.max(1, preFiltered.length)) * 48;
        progressBar.style.width = pct.toFixed(1) + '%';
        progressLabel.textContent = `Contour match — ${done}/${preFiltered.length} windows…`;
        if (done < preFiltered.length) { setTimeout(processBatch, 0); } else { resolve(); }
      }
      processBatch();
    });

    // ── Sort + dedup ──
    results.sort((a, b) => b.score - a.score);
    const minDedup = Math.max(TW, TH) * 0.45;
    const kept = [];
    for (const r of results) {
      if (!kept.some(k => Math.hypot(k.x - r.x, k.y - r.y) < minDedup)) kept.push(r);
    }

    findings = kept.map((r, i) => ({
      x: r.x, y: r.y,
      score: r.score,
      label: `Contour ${i + 1}`,
      scale: 1,
      detail: `Hu dist=${r.dist.toFixed(2)} · shape match ${Math.round(r.score * 100)}%`
    }));

    progressBar.style.width = '100%';
    progressWrap.style.display = 'none';
    drawMarkers();
    if (searchRegion) drawRegionBox();
    await renderFindings();
    mode = 'done';

    const vb = document.getElementById('verifyBtn');
    if (vb) vb.style.display = findings.length > 0 ? 'flex' : 'none';
    const rb = document.getElementById('reviewBtn');
    if (rb) rb.style.display = findings.length > 0 ? 'flex' : 'none';
    const qs = document.getElementById('qaqcSection');
    if (qs) qs.style.display = findings.length > 0 ? 'block' : 'none';

    showStatus(`Contour match: ${findings.length} match${findings.length !== 1 ? 'es' : ''} · ${preFiltered.length} windows scanned`);
    if (findings.length === 0)
      showError(`No contours matched (max Hu dist ${maxDist.toFixed(1)}, ${preFiltered.length} windows scanned). Try lowering sensitivity, or the symbol may be too connected to surrounding linework for shape matching — try Vector scan instead.`);

  } catch (e) {
    showError('Contour match error: ' + e.message);
    progressWrap.style.display = 'none';
  }

  const contourBtn2 = document.getElementById('contourBtn');
  if (contourBtn2) contourBtn2.disabled = false;
}

