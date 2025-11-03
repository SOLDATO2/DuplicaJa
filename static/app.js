// ======= refs do DOM =======

// audio + metadados
const audioKeep = document.getElementById("audio-keep");
const audioRemove = document.getElementById("audio-remove");
const metaRes = document.getElementById("meta-res");
const metaInFps = document.getElementById("meta-in-fps");
const metaOutFps = document.getElementById("meta-out-fps");

const drop = document.getElementById("dropzone");
const input = document.getElementById("file-input");
const dzInstructions = document.getElementById("dz-instructions");
const dzPreview = document.getElementById("dz-preview");
const dzVideo = document.getElementById("dz-video");
const dzClear = document.getElementById("dz-clear");

const multiInput = document.getElementById("multi");
const fpsInput = document.getElementById("fps");
const downRange = document.getElementById("down");
const downValue = document.getElementById("down-value");

const sendBtn = document.getElementById("send-btn");
const statusEl = document.getElementById("status");
const info = document.getElementById("file-info");

const colOriginal = document.getElementById("col-original");
const originalVideo = document.getElementById("original");
const colProcessed = document.getElementById("col-processed");
const processedVideo = document.getElementById("processed");
const downloadLink = document.getElementById("download-link");

// Botão de cancelar (opcional; pode não existir no HTML)
const cancelBtn = document.getElementById("cancel-btn");

// ======= estado =======
const MAX_MB = 1024; // 1 GiB
const ALLOWED_EXTS = [".mp4", ".avi"];
let selectedFile = null;
let originalUrl = null;
let processedUrl = null;
let currentXhr = null; // se você ainda usar XHR em algum lugar

// ======= storage (RF-18 / RF-20) =======
const LS_PARAMS = "ffi:params";   // últimos valores
const LS_PRESETS = "ffi:presets"; // presets locais
const DEFAULT_PARAMS = { multi: 1, fps: "", down: 1, notify: false };

function currentParams() {
  return {
    multi: parseInt(multiInput.value || "1", 10) || 1,
    fps: fpsInput.value ? parseInt(fpsInput.value, 10) : "",
    down: parseFloat(downRange.value || "1"),
    notify: !!(document.getElementById("notify-toggle")?.checked),
  };
}

function applyParams(p) {
  const x = { ...DEFAULT_PARAMS, ...(p || {}) };
  if (multiInput) multiInput.value = x.multi;
  if (fpsInput) fpsInput.value = x.fps === "" || isNaN(x.fps) ? "" : x.fps;
  if (downRange) {
    downRange.value = String(x.down);
    updateDownPercent();
  }
  const notifyToggle = document.getElementById("notify-toggle");
  if (notifyToggle) notifyToggle.checked = !!x.notify;
}

function saveParamsToStorage(p = currentParams()) {
  try { localStorage.setItem(LS_PARAMS, JSON.stringify(p)); } catch { }
}
function loadParamsFromStorage() {
  try {
    const raw = localStorage.getItem(LS_PARAMS);
    if (raw) applyParams(JSON.parse(raw));
    else applyParams(DEFAULT_PARAMS);
  } catch { applyParams(DEFAULT_PARAMS); }
}
function resetToDefaults() {
  try { localStorage.removeItem(LS_PARAMS); } catch { }
  applyParams(DEFAULT_PARAMS);
  setStatus("Preferências resetadas.");
}

// ======= presets locais =======
function getPresets() {
  try { return JSON.parse(localStorage.getItem(LS_PRESETS) || "[]"); } catch { return []; }
}
function setPresets(list) {
  try { localStorage.setItem(LS_PRESETS, JSON.stringify(list)); } catch { }
  refreshPresetSelect();
}
function refreshPresetSelect() {
  const presetSelect = document.getElementById("preset-select");
  if (!presetSelect) return;
  const list = getPresets();
  presetSelect.innerHTML = "";
  if (!list.length) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "(nenhum)";
    presetSelect.appendChild(opt);
    return;
  }
  list.forEach((pr, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = pr.name;
    presetSelect.appendChild(opt);
  });
}

// ======= utils =======
function setStatus(msg, cls = "") {
  statusEl.className = `status ${cls}`;
  statusEl.textContent = msg;
}
function validExt(name) {
  return ALLOWED_EXTS.some(ext => name.toLowerCase().endsWith(ext));
}
function showInfo(file) {
  info.classList.remove("hidden");
  info.textContent = `Selecionado: ${file.name} • ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
}
function showDropPreview(url) {
  dzVideo.src = url;
  dzPreview.classList.remove("hidden");
  dzInstructions.classList.add("hidden");
}
function hideDropPreview() {
  try { dzVideo.pause(); } catch (_) { }
  dzVideo.removeAttribute("src");
  dzVideo.load();
  dzPreview.classList.add("hidden");
  dzInstructions.classList.remove("hidden");
}
function parseFilenameFromContentDisposition(cd) {
  if (!cd) return null;
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(cd);
  return m ? decodeURIComponent(m[1]) : null;
}
function readBlobAsText(blob, cb) {
  const fr = new FileReader();
  fr.onload = () => cb(null, fr.result);
  fr.onerror = () => cb(fr.error || new Error("Falha ao ler resposta"));
  fr.readAsText(blob);
}

// ======= barra de progresso (auto-injetada) =======
let progressWrap, pBar, pInd, pLabel, pPercent;
(function ensureProgressUI() {
  if (!document.getElementById("progress-styles")) {
    const style = document.createElement("style");
    style.id = "progress-styles";
    style.textContent = `
      .progress-wrap{margin-top:.75rem}
      .progress-header{display:flex;justify-content:space-between;font-size:.9rem;margin-bottom:.35rem;color:#666}
      .progress{position:relative;height:10px;background:#eee;border-radius:999px;overflow:hidden}
      .progress-bar{height:100%;width:0%;transition:width .15s ease;background:linear-gradient(90deg,#6d28d9,#a78bfa)}
      .progress-indeterminate{position:absolute;top:0;left:-35%;width:35%;height:100%;
        background:linear-gradient(90deg,rgba(0,0,0,0),rgba(0,0,0,.1),rgba(0,0,0,0));
        animation:indeterminate 1.1s infinite linear}
      @keyframes indeterminate{0%{transform:translateX(0)}100%{transform:translateX(300%)}}
      .hidden{display:none!important}
    `;
    document.head.appendChild(style);
  }
  progressWrap = document.getElementById("progress-wrap") || (() => {
    const el = document.createElement("div");
    el.id = "progress-wrap";
    el.className = "progress-wrap hidden";
    el.setAttribute("aria-live", "polite");
    el.innerHTML = `
      <div class="progress-header">
        <span id="p-label">Aguardando arquivo…</span>
        <span id="p-percent">0%</span>
      </div>
      <div class="progress">
        <div id="p-bar" class="progress-bar"></div>
        <div id="p-ind" class="progress-indeterminate hidden"></div>
      </div>`;
    statusEl.parentNode.insertBefore(el, statusEl);
    return el;
  })();
  pBar = progressWrap.querySelector("#p-bar");
  pInd = progressWrap.querySelector("#p-ind");
  pLabel = progressWrap.querySelector("#p-label");
  pPercent = progressWrap.querySelector("#p-percent");
})();
function showProgress() { progressWrap.classList.remove("hidden"); }
function hideProgress() { progressWrap.classList.add("hidden"); setProgress(0, "Aguardando arquivo…"); stopIndeterminate(); }
function setProgress(pct, label) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  pBar.style.width = v + "%";
  if (label) pLabel.textContent = label;
  pPercent.textContent = v + "%";
}
function startIndeterminate(label) {
  pInd.classList.remove("hidden");
  pLabel.textContent = label || "Processando…";
  pPercent.textContent = "…";
}
function stopIndeterminate() { pInd.classList.add("hidden"); }

// ======= cancelar: habilitar/desabilitar (nunca esconder) =======
function enableCancel() { if (cancelBtn) cancelBtn.disabled = false; }
function disableCancel() { if (cancelBtn) cancelBtn.disabled = true; }

function resetUIAfterCancel() {
  hideProgress();
  colProcessed.classList.add("hidden");
  sendBtn.disabled = false;
  disableCancel();
}

// ======= limpar seleção =======
function clearUploadSelection() {
  if (originalUrl) { URL.revokeObjectURL(originalUrl); originalUrl = null; }
  selectedFile = null;
  input.value = "";
  hideDropPreview();
  info.classList.add("hidden");
  info.textContent = "";
  sendBtn.disabled = true;
  colOriginal.classList.add("hidden");
  colProcessed.classList.add("hidden");
  setStatus("Selecione um vídeo para começar.");
  hideProgress();
  disableCancel();
  if (currentXhr) { try { currentXhr.abort(); } catch {} currentXhr = null; }
}
if (dzClear) dzClear.addEventListener("click", (e) => { e.stopPropagation(); clearUploadSelection(); });

// ======= drag & drop + click =======
if (drop) {
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("dragover"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", e => {
    e.preventDefault();
    drop.classList.remove("dragover");
    handleFile(e.dataTransfer.files?.[0]);
  });
  drop.addEventListener("click", () => input && input.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.code === "Space") {
      e.preventDefault();
      input && input.click();
    }
  });
}
if (input) input.addEventListener("change", e => handleFile(e.target.files?.[0]));

function handleFile(file) {
  if (!file) return;
  if (!validExt(file.name)) {
    setStatus("Formato não suportado. Envie .mp4 ou .avi", "error");
    sendBtn.disabled = true;
    return;
  }
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > MAX_MB) {
    setStatus(`Arquivo muito grande (${sizeMB.toFixed(1)} MB). Limite: ${MAX_MB} MB.`, "error");
    sendBtn.disabled = true;
    return;
  }
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  originalUrl = URL.createObjectURL(file);
  selectedFile = file;

  showDropPreview(originalUrl);

  dzVideo.onloadedmetadata = () => {
    if (dzVideo.videoWidth && dzVideo.videoHeight) {
      metaRes.textContent = `${dzVideo.videoWidth}×${dzVideo.videoHeight}`;
    } else {
      metaRes.textContent = "—";
    }
    metaInFps.textContent = "—";
    metaOutFps.textContent = "—";
  };

  showInfo(file);
  setStatus("Arquivo pronto para envio.");
  sendBtn.disabled = false;

  colOriginal.classList.add("hidden");
  colProcessed.classList.add("hidden");
  processedVideo.removeAttribute("src");
  processedVideo.load();
  downloadLink.href = "#";
  disableCancel(); // nada para cancelar ainda
}

// ======= slider down =======
function updateDownPercent() {
  const val = parseFloat(downRange.value || "1");
  downValue.textContent = `${Math.round(val * 100)}%`;
}
downRange.addEventListener("input", () => {
  updateDownPercent();
  saveParamsToStorage();
});

// RF-16: nunca deixar multi vazio ou < 1
function clampMulti() {
  let v = parseInt(multiInput.value, 10);
  if (Number.isNaN(v) || v < 1) v = 1;
  if (v > 4) v = 4;
  if (String(v) !== multiInput.value) multiInput.value = String(v);
}
multiInput.addEventListener("input", clampMulti);
multiInput.addEventListener("blur", clampMulti);

// RF-15: validações leves no cliente
function clientValidate() {
  const vMulti = parseInt(multiInput.value || "1", 10);
  const vFps = fpsInput.value ? parseInt(fpsInput.value, 10) : null;
  const vDown = parseFloat(downRange.value || "1");
  if (vMulti < 1 || vMulti > 4) return "multi deve estar entre 1 e 4";
  if (vDown < 0.25 || vDown > 1) return "down deve estar entre 0.25 e 1";
  if (vFps !== null && (vFps < 1 || vFps > 120)) return "fps deve estar entre 1 e 120";
  return null;
}

[multiInput, fpsInput, downRange].forEach(el => {
  el.addEventListener("input", () => {
    const err = clientValidate();
    sendBtn.disabled = !!err || !selectedFile;
    if (err) setStatus(err, "error"); else setStatus("Pronto para enviar.");
  });
});

// carregar últimos valores + presets
loadParamsFromStorage();
refreshPresetSelect();
["multi","fps","down","notify-toggle"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", () => saveParamsToStorage());
});

// copiar parâmetros
const copyBtn = document.getElementById("copy-btn");
if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    const payload = JSON.stringify(currentParams());
    try {
      await navigator.clipboard.writeText(payload);
      setStatus("Parâmetros copiados (JSON).", "ok");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = payload; document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setStatus("Parâmetros copiados (JSON).", "ok"); }
      catch { setStatus("Não foi possível copiar.", "warn"); }
      document.body.removeChild(ta);
    }
  });
}

// reset padrão
const resetBtn = document.getElementById("reset-btn");
if (resetBtn) resetBtn.addEventListener("click", resetToDefaults);

// presets locais
const presetSaveBtn = document.getElementById("preset-save");
const presetApplyBtn = document.getElementById("preset-apply");
const presetRenameBtn = document.getElementById("preset-rename");
const presetDeleteBtn = document.getElementById("preset-delete");
const presetSelect = document.getElementById("preset-select");

if (presetSaveBtn) {
  presetSaveBtn.addEventListener("click", () => {
    const name = prompt("Nome do preset:");
    if (!name) return;
    const list = getPresets();
    list.push({ name, params: currentParams() });
    setPresets(list);
    setStatus(`Preset "${name}" salvo.`, "ok");
  });
}
if (presetApplyBtn) {
  presetApplyBtn.addEventListener("click", () => {
    const idx = parseInt(presetSelect.value, 10);
    const list = getPresets();
    const pr = list[idx];
    if (!pr) { setStatus("Nenhum preset selecionado.", "warn"); return; }
    applyParams(pr.params);
    saveParamsToStorage();
    setStatus(`Preset "${pr.name}" aplicado.`, "ok");
  });
}
if (presetRenameBtn) {
  presetRenameBtn.addEventListener("click", () => {
    const idx = parseInt(presetSelect.value, 10);
    const list = getPresets();
    const pr = list[idx];
    if (!pr) return;
    const newName = prompt("Novo nome:", pr.name);
    if (!newName) return;
    pr.name = newName;
    setPresets(list);
    setStatus("Preset renomeado.", "ok");
  });
}
if (presetDeleteBtn) {
  presetDeleteBtn.addEventListener("click", () => {
    const idx = parseInt(presetSelect.value, 10);
    const list = getPresets();
    const pr = list[idx];
    if (!pr) return;
    if (!confirm(`Excluir preset "${pr.name}"?`)) return;
    list.splice(idx, 1);
    setPresets(list);
    setStatus(`Preset "${pr.name}" excluído.`, "ok");
  });
}

// notificação (opcional)
function maybeNotify(title, body) {
  const notifyToggle = document.getElementById("notify-toggle");
  if (!notifyToggle || !notifyToggle.checked) return;
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  } else if (Notification.permission === "default") {
    Notification.requestPermission().then(p => {
      if (p === "granted") new Notification(title, { body });
    });
  }
}

// ======= FETCH helpers que nunca quebram com HTML de erro =======
async function parseMaybeJson(response) {
  const ct = response.headers.get("content-type") || "";
  const raw = await response.text(); // sempre como texto
  let data = null;
  if (ct.includes("application/json")) {
    try { data = JSON.parse(raw); } catch {}
  }
  return { data, raw, ct };
}

// ======= API helpers (jobs REST) =======
async function uploadFile(file){
  const fd = new FormData();
  fd.append("file", file);            // /upload aceita "file"
  const r = await fetch("/upload", { method: "POST", body: fd });
  const { data, raw } = await parseMaybeJson(r);
  if (!r.ok) {
    const msg = data?.message || data?.error || raw.slice(0, 500) || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  if (!data?.filename) throw new Error("Resposta inesperada do /upload.");
  return data.filename;
}

async function createJob(inputFilename){
  const body = {
    input_filename: inputFilename,
    multi: parseInt(multiInput.value||"1",10),
    fps_alvo: fpsInput.value ? parseInt(fpsInput.value,10) : undefined,
    downscale: parseFloat(downRange.value||"1"),
    manter_audio: !(audioRemove?.checked),
  };
  Object.keys(body).forEach(k => body[k]===undefined && delete body[k]);

  const r = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  const { data, raw } = await parseMaybeJson(r);
  if (!r.ok || data?.code === "ERROR") {
    const msg = data?.message || raw.slice(0, 500) || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  if (!data?.data?.id || !data?.data?.token) {
    throw new Error("Resposta inesperada ao criar job.");
  }
  return data.data; // { id, token, ... }
}

async function pollJob(id, token){
  while (true){
    const r = await fetch(`/api/jobs/${id}?token=${encodeURIComponent(token)}`);
    const { data, raw } = await parseMaybeJson(r);
    if (!r.ok || data?.code === "ERROR") {
      const msg = data?.message || raw.slice(0, 500) || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    const d = data?.data;
    if (!d) throw new Error("Resposta inesperada no status do job.");

    if (typeof d.progresso === "number") {
      setProgress(Math.round(d.progresso * 100), d.status_label_pt || "Processando…");
    }
    if (["completed","failed","canceled"].includes(d.status)) return d;
    await new Promise(res => setTimeout(res, 900));
  }
}

function showResult(d){
  // URL inline para <video> (NÃO usar download=1)
  const playUrl = new URL(d.result_url);
  playUrl.searchParams.set("_", Date.now().toString()); // cache-buster

  processedVideo.srcObject = null;
  processedVideo.preload = "auto";
  processedVideo.muted = true; // ajuda autoplay
  processedVideo.src = playUrl.toString();
  processedVideo.load();
  processedVideo.play?.().catch(()=>{});
  colProcessed.classList.remove("hidden");

  // link de download separado
  const dlUrl = new URL(d.result_url);
  dlUrl.searchParams.set("download", "1");
  dlUrl.searchParams.set("_", Date.now().toString());
  downloadLink.href = dlUrl.toString();
  downloadLink.setAttribute("download", "processed_video.mp4");
}

// ======= fluxo com api_jobs (upload -> criar job -> poll -> tocar) =======
sendBtn.addEventListener("click", async () => {
  if (!selectedFile) return;

  // UI inicial
  if (originalUrl) originalVideo.src = originalUrl;
  colOriginal.classList.remove("hidden");
  colProcessed.classList.add("hidden");
  hideDropPreview();
  setStatus("Enviando e processando…");
  sendBtn.disabled = true;
  showProgress(); setProgress(10, "Enviando…");

  try {
    const filename = await uploadFile(selectedFile);
    setProgress(30, "Criando job…");
    const job = await createJob(filename);      // => { id, token, ... }

    setProgress(45, "Na fila/Processando…");
    const final = await pollJob(job.id, job.token);

    if (final.status === "completed" && final.result_url){
      setProgress(95, "Preparando player…");
      showResult(final);
      setStatus("Processamento concluído ✔", "ok");
      setProgress(100, "Concluído");
    } else if (final.status === "failed"){
      setStatus(final.message || "Falha no job.", "error");
      hideProgress();
    } else if (final.status === "canceled"){
      setStatus("Job cancelado.", "warning");
      hideProgress();
    }
  } catch (e){
    console.error(e);
    setStatus(String(e?.message || e), "error");
    hideProgress();
  } finally {
    sendBtn.disabled = false;
  }
});

// Botão cancelar (se existir no HTML): aqui não cancela no servidor, só abortaria XHR se usado.
// Você pode implementar cancelamento real chamando POST /api/jobs/<id>/cancel com token.
if (cancelBtn) {
  cancelBtn.addEventListener("click", () => {
    setStatus("Cancelamento local não implementado para jobs assíncronos.", "warn");
  });
}

// ======= limpar blobs ao sair =======
window.addEventListener("beforeunload", () => {
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  if (processedUrl) URL.revokeObjectURL(processedUrl);
  if (currentXhr) { try { currentXhr.abort(); } catch {} }
});
