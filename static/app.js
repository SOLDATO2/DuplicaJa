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
const presetSel = document.getElementById("preset");

const sendBtn = document.getElementById("send-btn");
const statusEl = document.getElementById("status");
const info = document.getElementById("file-info");

const colOriginal = document.getElementById("col-original");
const originalVideo = document.getElementById("original");
const colProcessed = document.getElementById("col-processed");
const processedVideo = document.getElementById("processed");
const downloadLink = document.getElementById("download-link");
const cancelBtn = document.getElementById("cancel-btn");

presetSel?.addEventListener("change", () => {
	const v = presetSel.value;
	if (v === "youtube_60fps") {
		multiInput.value = "2";
		fpsInput.value = "60";
		downRange.value = "1";
		downValue.textContent = "100%";
	} else if (v === "stories_30fps") {
		multiInput.value = "1";
		fpsInput.value = "30";
		downRange.value = "0.75";
		downValue.textContent = "75%";
	} else if (v === "qualidade_120") {
		multiInput.value = "4";   // exemplo (30->120)
		fpsInput.value = "120";
		downRange.value = "1";
		downValue.textContent = "100%";
	} else if (v === "mobile_leve") {
		multiInput.value = "2";
		fpsInput.value = "48";
		downRange.value = "0.5";
		downValue.textContent = "50%";
	}
});

// ======= estado =======
const MAX_MB = 1024;
const ALLOWED_EXTS = [".mp4", ".avi"];
let selectedFile = null;
let originalUrl = null;
let currentJob = null;
let stopPolling = false;
let processedObjectUrl = null;

// ======= utils =======
function showCancel() { cancelBtn?.classList.remove("hidden"); cancelBtn.disabled = false; }
function hideCancel() { cancelBtn?.classList.add("hidden"); }

async function cancelCurrentJob() {
	if (!currentJob) return;
	cancelBtn.disabled = true;
	try {
		const r = await fetch(`/api/jobs/${currentJob.id}/cancel?token=${encodeURIComponent(currentJob.token)}`, { method: "POST" });
		const j = await r.json();
		if (!r.ok || j.code === "ERROR") throw new Error(j.message || "Falha ao cancelar");
		setStatus("Job cancelado", "warning");
		hideProgress();
		hideCancel();
		colProcessed.classList.add("hidden");
		stopPolling = true; // (opcional) corta o laço do poll imediatamente
		setTimeout(() => {
			location.reload();
		}, 300);
	} catch (e) {
		setStatus(e.message || "Erro ao cancelar", "error");
		cancelBtn.disabled = false;
	}
}
cancelBtn?.addEventListener("click", cancelCurrentJob);

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
// ======= progresso simples =======
const pWrap = document.getElementById("progress-wrap");
const pBar = document.getElementById("p-bar");
const pLabel = document.getElementById("p-label");
const pPct = document.getElementById("p-percent");
function showProgress() { pWrap.classList.remove("hidden"); }
function hideProgress() { pWrap.classList.add("hidden"); setProgress(0, "Aguardando arquivo…"); }
function setProgress(pct, label) { const v = Math.max(0, Math.min(100, Math.round(pct))); pBar.style.width = v + "%"; if (label) pLabel.textContent = label; pPct.textContent = v + "%"; }

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
dzClear?.addEventListener("click", (e) => { e.stopPropagation(); clearUploadSelection(); });

// ======= drag & drop + click =======
drop?.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("dragover"); });
drop?.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop?.addEventListener("drop", e => {
	e.preventDefault();
	drop.classList.remove("dragover");
	handleFile(e.dataTransfer.files?.[0]);
});
drop?.addEventListener("click", () => input?.click());
drop?.addEventListener("keydown", (e) => {
	if (e.key === "Enter" || e.code === "Space") {
		e.preventDefault();
		input?.click();
	}
});
input?.addEventListener("change", e => handleFile(e.target.files?.[0]));

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
downRange?.addEventListener("input", updateDownPercent);
updateDownPercent();

// ======= API helpers =======
async function uploadFile(file) {
	const fd = new FormData();
	fd.append("file", file);
	const r = await fetch("/upload", { method: "POST", body: fd });
	const j = await r.json();
	if (!r.ok || !j.filename) throw new Error(j.message || "Falha no upload");
	return j.filename;
}
async function createJob(inputFilename) {
	const body = {
		input_filename: inputFilename,
		preset: (presetSel?.value || "") || undefined,
		multi: multiInput.value ? parseInt(multiInput.value, 10) : undefined,
		fps_alvo: fpsInput.value ? parseInt(fpsInput.value, 10) : undefined,
		downscale: downRange.value ? parseFloat(downRange.value) : undefined,
		manter_audio: true
	};
	Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
	const r = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const j = await r.json();
	if (!r.ok || j.code === "ERROR") throw new Error(j.message || "Erro ao criar job");
	return j.data;
}
async function pollJob(id, token) {
	while (true) {
		if (stopPolling) return { status: "canceled" };
		const r = await fetch(`/api/jobs/${id}?token=${encodeURIComponent(token)}`);
		const j = await r.json();
		if (!r.ok || j.code === "ERROR") throw new Error(j.message || "Erro no status");
		const d = j.data;
		const pct = typeof d.progresso === "number" ? d.progresso * 100 : 0;
		setProgress(pct, d.status_label_pt + (d.etapa ? ` • ${d.etapa}` : ""));
		if (["completed", "failed", "canceled"].includes(d.status)) return d;
		await new Promise(res => setTimeout(res, 900));
	}
}

// ======= fluxo principal =======
sendBtn.addEventListener("click", async () => {
	if (!selectedFile) return;

	// mostra original
	originalVideo.src = originalUrl;
	colOriginal.classList.remove("hidden");
	colProcessed.classList.add("hidden");
	hideDropPreview();
	setStatus("Enviando e processando… aguarde.");
	sendBtn.disabled = true;

	showProgress();
	setProgress(10, "Enviando…");
	showCancel();
	try {
		const savedName = await uploadFile(selectedFile);
		setProgress(30, "Criando job…");
		const job = await createJob(savedName);
		currentJob = { id: job.id, token: job.token };

		const final = await pollJob(job.id, job.token);

		if (final.status === "completed" && final.result_url) {
			// mesma URL do botão de download
			const playUrl = new URL(final.result_url, location.origin);
			playUrl.searchParams.set("download", "1");
			playUrl.searchParams.set("_", Date.now().toString()); // cache-buster

			processedVideo.srcObject = null;
			processedVideo.preload = "auto";
			processedVideo.src = playUrl.toString();
			processedVideo.muted = true;      // opcional (autoplay)
			processedVideo.load();

			colProcessed.classList.remove("hidden");

			// botão de download igual
			downloadLink.href = playUrl.toString();

			// nome sugerido
			const name = selectedFile.name;
			const dot = name.lastIndexOf(".");
			const stem = dot >= 0 ? name.slice(0, dot) : name;
			const ext = dot >= 0 ? name.slice(dot) : ".mp4";
			const fps = fpsInput.value ? parseInt(fpsInput.value, 10) : undefined;
			const suggest = fps ? `${stem}_interp_${fps}fps${ext}` : `${stem}_interp${ext}`;
			downloadLink.setAttribute("download", suggest);

			setStatus("Processamento concluído ✔", "ok");
			setProgress(100, "Concluído");
		}

		else if (final.status === "failed") {
			setStatus(`Falha: ${final.message || "erro"}`, "error");
			hideProgress();
		} else if (final.status === "canceled") {
			setStatus("Job cancelado", "warning");
			hideProgress();
		}
	} catch (e) {
		console.error(e);
		setStatus(e.message || "Erro inesperado", "error");
		hideProgress();
	} finally {
		sendBtn.disabled = false;
		hideCancel();
	}
});

// ======= cleanup =======
window.addEventListener("beforeunload", () => {
	if (originalUrl) URL.revokeObjectURL(originalUrl);
	if (processedObjectUrl) URL.revokeObjectURL(processedObjectUrl);

});
