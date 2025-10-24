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

// ======= NOVO: elementos dos RF-17/18/19/20 =======
const notifyToggle = document.getElementById("notify-toggle"); // RF-17
const copyBtn = document.getElementById("copy-btn");           // RF-19
const resetBtn = document.getElementById("reset-btn");         // RF-18
const presetSelect = document.getElementById("preset-select"); // RF-20
const presetApplyBtn = document.getElementById("preset-apply");
const presetSaveBtn = document.getElementById("preset-save");
const presetRenameBtn = document.getElementById("preset-rename");
const presetDeleteBtn = document.getElementById("preset-delete");

// ======= estado =======
const MAX_MB = 1024; // 1 GiB
const ALLOWED_EXTS = [".mp4", ".avi"];
let selectedFile = null;
let originalUrl = null;
let processedUrl = null;

// ======= storage (RF-18 / RF-20) =======
const LS_PARAMS = "ffi:params";   // últimos valores
const LS_PRESETS = "ffi:presets"; // presets locais
const DEFAULT_PARAMS = { multi: 1, fps: "", down: 1, notify: false };

function currentParams() {
  return {
    multi: parseInt(multiInput.value || "1", 10) || 1,
    fps: fpsInput.value ? parseInt(fpsInput.value, 10) : "",
    down: parseFloat(downRange.value || "1"),
    notify: !!(notifyToggle && notifyToggle.checked),
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
  progressWrap = document.createElement("div");
  progressWrap.id = "progress-wrap";
  progressWrap.className = "progress-wrap hidden";
  progressWrap.setAttribute("aria-live", "polite");
  progressWrap.innerHTML = `
    <div class="progress-header">
      <span id="p-label">Aguardando arquivo…</span>
      <span id="p-percent">0%</span>
    </div>
    <div class="progress">
      <div id="p-bar" class="progress-bar"></div>
      <div id="p-ind" class="progress-indeterminate hidden"></div>
    </div>
  `;
  statusEl.parentNode.insertBefore(progressWrap, statusEl);
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
		metaInFps.textContent = "—";   // FPS virá do servidor
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
  // RF-15: limitar combo pelo cliente também (servidor é autoridade)
  if (v > 4) v = 4; // combinado com ALLOWED_MULTIS do servidor
  if (String(v) !== multiInput.value) multiInput.value = String(v);
}
multiInput.addEventListener("input", clampMulti);
multiInput.addEventListener("blur", clampMulti);

// RF-15: validações leves no cliente (máximo de FPS de saída quando fps explicitado)
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


// ======= NOVO: carregar últimos valores (RF-18) =======
loadParamsFromStorage();
refreshPresetSelect();
[multiInput, fpsInput, downRange, notifyToggle].forEach(el => {
  if (el) el.addEventListener("input", () => saveParamsToStorage());
});

// ======= NOVO: copiar parâmetros (RF-19) =======
if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    const payload = JSON.stringify(currentParams());
    try {
      await navigator.clipboard.writeText(payload);
      setStatus("Parâmetros copiados (JSON).", "ok");
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = payload; document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setStatus("Parâmetros copiados (JSON).", "ok"); }
      catch { setStatus("Não foi possível copiar.", "warn"); }
      document.body.removeChild(ta);
    }
  });
}

// ======= NOVO: reset para padrão (RF-18) =======
if (resetBtn) resetBtn.addEventListener("click", () => { resetToDefaults(); });

// ======= NOVO: presets locais (RF-20) =======
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

// ======= NOVO: notificação (RF-17) =======
function maybeNotify(title, body) {
  if (!notifyToggle || !notifyToggle.checked) return;           // só se usuário habilitar
  if (!("Notification" in window)) return;                      // browser sem suporte
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  } else if (Notification.permission === "default") {
    Notification.requestPermission().then(p => {
      if (p === "granted") new Notification(title, { body });
    });
  }
}

// ======= enviar com XHR + progresso =======
sendBtn.addEventListener("click", () => {
  if (!selectedFile) return;

  // mostra original
  if (originalUrl) originalVideo.src = originalUrl;
  colOriginal.classList.remove("hidden");
  colProcessed.classList.add("hidden");
  hideDropPreview();
  setStatus("Enviando e processando… aguarde.");
  sendBtn.disabled = true;

  // prepara barra
  showProgress();
  setProgress(0, "Preparando…");

  // monta formdata
  const fd = new FormData();
  fd.append("video", selectedFile);
  const m = parseInt(multiInput.value, 10);
  if (!Number.isNaN(m)) fd.append("multi", String(Math.max(1, m)));
  const f = parseInt(fpsInput.value, 10);
  if (!Number.isNaN(f)) fd.append("fps", String(f));

  // ADICIONADO: escolha de áudio
  const audioChoice = (audioRemove && audioRemove.checked) ? "remove" : "keep";
  fd.append("audio", audioChoice);

  // IMPORTANTE: corrigido bug do front — envia o valor de 'down' sem multiplicar
  fd.append("down", String(parseFloat(downRange.value))); // (antes havia *0.25)  :contentReference[oaicite:4]{index=4}

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/interpolate");
  xhr.responseType = "blob";

  // Upload: 0–45%
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      setProgress((e.loaded / e.total) * 45, "Enviando…");
    }
  };
  xhr.upload.onload = () => {
    setProgress(45, "Upload concluído");
    startIndeterminate("Processando no servidor…");
  };

  // Download: 45–100%
  xhr.onprogress = (e) => {
    if (e.lengthComputable) {
      stopIndeterminate();
      const pct = 45 + (e.loaded / e.total) * 55;
      setProgress(pct, "Baixando resultado…");
    } else {
      startIndeterminate("Baixando resultado…");
    }
  };

  xhr.onerror = () => {
    stopIndeterminate();
    setStatus("Falha de rede.", "error");
    hideProgress();
    sendBtn.disabled = false;
    maybeNotify("Falha no processamento", "Houve um erro de rede.");
  };

  xhr.onload = () => {
    stopIndeterminate();
    if (xhr.status !== 200) {
      const ct = xhr.getResponseHeader("content-type") || "";
      if (ct.includes("application/json")) {
        readBlobAsText(xhr.response, (err, txt) => {
          if (err) {
            setStatus("Erro no processamento.", "error");
          } else {
            try {
              const j = JSON.parse(txt);
              setStatus(j?.error || j?.message || "Erro no processamento.", "error");
            } catch {
              setStatus("Erro no processamento.", "error");
            }
          }
          hideProgress();
          sendBtn.disabled = false;
          maybeNotify("Falha no processamento", "O servidor retornou um erro.");
        });
      } else {
        setStatus("Erro no processamento.", "error");
        hideProgress();
        sendBtn.disabled = false;
        maybeNotify("Falha no processamento", "O servidor retornou um erro.");
      }
      return;
    }

    // sucesso
    const blob = xhr.response;
    if (processedUrl) URL.revokeObjectURL(processedUrl);
    processedUrl = URL.createObjectURL(blob);

    processedVideo.src = processedUrl;
    colProcessed.classList.remove("hidden");

    const cd = xhr.getResponseHeader("content-disposition");
    const filename = parseFilenameFromContentDisposition(cd) || "processed_video.mp4";
    downloadLink.href = processedUrl;
    downloadLink.setAttribute("download", filename);

    // ADICIONADO: ler novos headers de metadados e atualizar UI
    const inFps = xhr.getResponseHeader("x-input-fps");
    const outFps = xhr.getResponseHeader("x-output-fps");
    const inRes = xhr.getResponseHeader("x-input-res");

    if (inRes) metaRes.textContent = inRes;
    if (inFps) metaInFps.textContent = parseFloat(inFps).toFixed(3);
    if (outFps) metaOutFps.textContent = parseFloat(outFps).toFixed(3);

    const avg = xhr.getResponseHeader("x-avg-fps");
    const frames = xhr.getResponseHeader("x-frames");
    const bits = [];
    if (frames) bits.push(`${frames} frames`);
    if (avg) bits.push(`média ${avg} FPS`);
    setStatus(`Processamento concluído! ${bits.join(" • ")}`, "ok");

    setProgress(100, "Concluído");
    sendBtn.disabled = false;

    // RF-17: notificação opcional ao concluir
    maybeNotify("Interpolação concluída", bits.join(" • ") || "Seu vídeo está pronto.");
  };

  xhr.send(fd);
});

// ======= limpar blobs ao sair =======
window.addEventListener("beforeunload", () => {
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  if (processedUrl) URL.revokeObjectURL(processedUrl);
});
