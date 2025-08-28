// ======= refs do DOM =======
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

// ======= estado =======
const MAX_MB = 1024; // 1 GiB
const ALLOWED_EXTS = [".mp4", ".avi"];
let selectedFile = null;
let originalUrl = null;
let processedUrl = null;

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
	// injeta CSS
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

	// cria HTML antes do #status
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

	// refs internas
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
if (dzClear) {
	dzClear.addEventListener("click", (e) => { e.stopPropagation(); clearUploadSelection(); });
}

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
if (input) {
	input.addEventListener("change", e => handleFile(e.target.files?.[0]));
}

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
downRange.addEventListener("input", updateDownPercent);
updateDownPercent();

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
	fd.append("down", String(parseFloat(downRange.value) * 0.25)); 

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
			// continua indeterminado até termos tamanho
			startIndeterminate("Baixando resultado…");
		}
	};

	xhr.onerror = () => {
		stopIndeterminate();
		setStatus("Falha de rede.", "error");
		hideProgress();
		sendBtn.disabled = false;
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
				});
			} else {
				setStatus("Erro no processamento.", "error");
				hideProgress();
				sendBtn.disabled = false;
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

		const avg = xhr.getResponseHeader("x-avg-fps");
		const frames = xhr.getResponseHeader("x-frames");
		const bits = [];
		if (frames) bits.push(`${frames} frames`);
		if (avg) bits.push(`média ${avg} FPS`);
		setStatus(`Processamento concluído! ${bits.join(" • ")}`, "ok");

		setProgress(100, "Concluído");
		// opcional: esconder depois de um tempo
		// setTimeout(hideProgress, 1200);
		sendBtn.disabled = false;
	};

	xhr.send(fd);
});

// ======= limpar blobs ao sair =======
window.addEventListener("beforeunload", () => {
	if (originalUrl) URL.revokeObjectURL(originalUrl);
	if (processedUrl) URL.revokeObjectURL(processedUrl);
});
