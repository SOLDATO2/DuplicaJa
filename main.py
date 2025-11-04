import os
import time
import uuid
import tempfile
import threading
from dataclasses import dataclass, field
from typing import Optional, Dict
from concurrent.futures import ThreadPoolExecutor, Future
import cv2, subprocess, shlex  # + novos

import torch
from flask import Flask, render_template, request, send_file, jsonify, abort, redirect, url_for
from werkzeug.exceptions import RequestEntityTooLarge, HTTPException
from api_jobs import jobs_bp
from pathlib import Path
from werkzeug.utils import secure_filename


from model.model import FlowNet
from model.util import interpolate_video

# ============================ Configuração básica ============================
torch.backends.cudnn.benchmark = True
device = torch.device("cpu")
print(f"Usando: {device}")

model = FlowNet(base=16).to(device)
model.eval()
model.load_state_dict(torch.load("best_model.pth", map_location=device))
print("Modelo carregado")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MAX_CONTENT_LENGTH = 1024 * 1024 * 1024  # 1 GiB
ALLOWED_EXTS = {".mp4", ".avi"}

MAX_FPS_OUT = 120
ALLOWED_MULTIS = {1, 2, 3, 4}
MIN_DOWN, MAX_DOWN = 0.25, 1.0

app = Flask(__name__)
app.register_blueprint(jobs_bp, url_prefix="/api")
app.config.update(MAX_CONTENT_LENGTH=MAX_CONTENT_LENGTH)

@app.errorhandler(HTTPException)
def _http_error(e: HTTPException):
    return jsonify({"code": "ERROR", "message": e.description or e.name, "details": None}), e.code or 500

def api_error(status, code, message, details=None):
    payload = {"code": code, "message": message}
    if details is not None:
        payload["details"] = details
    return jsonify(payload), status

def probe_video(path):
    cap = cv2.VideoCapture(path)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 0
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    finally:
        cap.release()
    return fps, w, h

def validate_combo(multi, fps_override, down, fps_in):
    if multi not in ALLOWED_MULTIS:
        raise ValueError(f"multi deve ser um de {sorted(ALLOWED_MULTIS)}")
    if not (MIN_DOWN <= down <= MAX_DOWN):
        raise ValueError(f"down deve estar entre {MIN_DOWN} e {MAX_DOWN}")
    if fps_override is not None and (fps_override < 1 or fps_override > MAX_FPS_OUT):
        raise ValueError(f"fps deve estar entre 1 e {MAX_FPS_OUT}")
    target_fps = fps_override if fps_override else fps_in * (multi + 1)
    if target_fps > MAX_FPS_OUT:
        raise ValueError(f"FPS de saída ({target_fps:.1f}) excede o máximo {MAX_FPS_OUT}")

def maybe_remux_audio(dest_video, orig_input):
    """
    Se possível, remixa a TRILHA DE ÁUDIO do original no arquivo processado.
    Retorna True em caso de sucesso; caso contrário mantém o vídeo sem áudio.
    """
    tmp = dest_video + ".aud.mp4"
    cmd = f'ffmpeg -y -hide_banner -loglevel error -i "{dest_video}" -i "{orig_input}" ' \
          f'-map 0:v:0 -map 1:a? -c:v copy -c:a aac -shortest "{tmp}"'
    try:
        subprocess.run(shlex.split(cmd), check=True)
        os.replace(tmp, dest_video)
        return True
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        return False


def allowed_file(filename: str) -> bool:
    return os.path.splitext(filename)[1].lower() in ALLOWED_EXTS

@app.errorhandler(RequestEntityTooLarge)
def handle_413(_e):
    mb = MAX_CONTENT_LENGTH // (1024 * 1024)
    return jsonify({"error": f"Arquivo muito grande. Limite: {mb} MB."}), 413

# ============================ Página e saúde ================================
@app.get("/")
def index():
    return render_template("index.html", default_multi=1, default_down=0.25)

@app.get("/saude")
def saude():
    return "Sistema ativo!"

# ------ Rota de upload (o front manda o arquivo aqui antes do /api/jobs) ------
UPLOAD_DIR = Path("static/uploads"); UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

@app.post("/upload")
def upload():
    if "file" in request.files:
        f = request.files["file"]
    elif "video" in request.files:  # compatibilidade com seu app.js antigo
        f = request.files["video"]
    else:
        return jsonify({"code":"ERROR","message":"campo 'file' não encontrado","details":None}), 400

    fname = secure_filename(f.filename or "video.mp4")
    savepath = (UPLOAD_DIR / fname).resolve()
    f.save(savepath)
    return jsonify({"filename": fname})

# ============================ Suporte a /interpolate síncrono (RNF-05) ======
@app.post("/interpolate")
def interpolate_route():
    if 'video' not in request.files:
        return api_error(400, "bad_request", "Envie o arquivo no campo 'video'.")
    f = request.files['video']
    if f.filename == '':
        return api_error(400, "bad_request", "Arquivo de vídeo inválido.")
    if not allowed_file(f.filename):
        return api_error(422, "unsupported_format", "Formato não suportado. Envie .mp4 ou .avi.")

    # parâmetros
    try:
        multi = int(request.form.get('multi', 1) or 1)
        fps   = request.form.get('fps', None)
        fps   = int(fps) if fps not in (None, "", "null") else None
        down  = float(request.form.get('down', 1) or 1)
        audio_opt = (request.form.get('audio', 'keep') or 'keep').lower()
        keep_audio = audio_opt in ('keep','manter','1','true','yes')
    except Exception as e:
        return api_error(400, "invalid_params", f"Parâmetros inválidos: {e}")

    # salvar temporários
    tmp_dir = tempfile.gettempdir()
    tmp_in  = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4", dir=tmp_dir); tmp_in.close()
    tmp_out = tempfile.NamedTemporaryFile(delete=False, suffix=f"_x{multi}.mp4", dir=tmp_dir); tmp_out.close()
    f.save(tmp_in.name)

    # probe + validação de combinação (RF-15/16)
    fps_in, W, H = probe_video(tmp_in.name)
    try:
        validate_combo(multi, fps, down, fps_in or 30.0)
    except ValueError as ve:
        for p in (tmp_in.name, tmp_out.name):
            try: os.remove(p)
            except Exception: pass
        return api_error(422, "invalid_combo", str(ve))

    try:
        avg_fps, frames, fps_in, fps_out, W, H = interpolate_video(
            in_path=tmp_in.name, out_path=tmp_out.name,
            multi=multi, fps_override=fps, down=down,
            model=model, device=device
        )

        # RF-12: remux de áudio (opcional)
        if keep_audio:
            maybe_remux_audio(tmp_out.name, tmp_in.name)

    except Exception as e:
        for p in (tmp_in.name, tmp_out.name):
            try: os.remove(p)
            except Exception: pass
        return api_error(500, "inference_failed", f"Falha na inferência: {e}")

    # limpa entrada SEMPRE
    try: os.remove(tmp_in.name)
    except Exception: pass

    filename_download = f"output_x{multi}.mp4"
    resp = send_file(tmp_out.name, mimetype="video/mp4", as_attachment=True, download_name=filename_download)

    # headers anteriores
    resp.headers['X-Avg-FPS'] = f"{avg_fps:.2f}"
    resp.headers['X-Frames'] = str(frames)
    # NOVOS headers de metadata (RF-13)
    if fps_in:  resp.headers['X-Input-FPS'] = f"{fps_in:.3f}"
    if fps_out: resp.headers['X-Output-FPS'] = f"{fps_out:.3f}"
    if W and H: resp.headers['X-Input-Res'] = f"{W}x{H}"

    # RNF-05: remover saída ao finalizar
    def _cleanup_on_close(path):
        try: os.remove(path)
        except Exception: pass
    resp.call_on_close(lambda p=tmp_out.name: _cleanup_on_close(p))

    return resp


# ============================ Arquitetura de Jobs (RNF-06 + RNF-02) =========
MAX_WORKERS = 2              # RNF-02: processar 2 simultâneos
MAX_PENDING = 500            # RNF-06: fila suporta 50+ com folga
RESULT_TTL_SEC = 24 * 3600   # boa prática (pode ajustar conforme US-011)

executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
jobs_lock = threading.Lock()

@dataclass
class Job:
    id: str
    status: str = "queued"  # queued|processing|completed|failed|canceled
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    in_path: Optional[str] = None
    out_path: Optional[str] = None
    multi: int = 1
    fps: Optional[int] = None
    down: float = 0.25
    avg_fps: Optional[float] = None
    frames: Optional[int] = None
    error: Optional[str] = None
    future: Optional[Future] = None
    
    fps_in: Optional[float] = None
    fps_out: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    keep_audio: bool = True
        
    cancel_event: threading.Event = field(default_factory=threading.Event)

JOBS: Dict[str, Job] = {}

def _submit_job(job: Job):
    def _runner(j: Job):
        with jobs_lock:
            j.status = "processing"; j.updated_at = time.time()

        try:
            # 1) roda a interpolação recebendo os 6 valores (avg_fps, frames, fps_in, fps_out, W, H)
            avg_fps, frames, fps_in2, fps_out, W2, H2 = interpolate_video(
                in_path=j.in_path,
                out_path=j.out_path,
                multi=j.multi,
                fps_override=j.fps,
                down=j.down,
                model=model,
                device=device,
                cancel_event=j.cancel_event
            )

            # 2) remux de áudio (se solicitado) ANTES de apagar a entrada
            if j.keep_audio and not j.cancel_event.is_set():
                maybe_remux_audio(j.out_path, j.in_path)

            # 3) apaga a entrada sempre
            try:
                os.remove(j.in_path)
            except Exception:
                pass

            # 4) se cancelou, limpa saída e encerra
            if j.cancel_event.is_set():
                try:
                    os.remove(j.out_path)
                except Exception:
                    pass
                with jobs_lock:
                    j.status = "canceled"
                    j.updated_at = time.time()
                return

            # 5) atualiza o job com TODOS os metadados
            with jobs_lock:
                j.avg_fps = avg_fps
                j.frames = frames
                # guarda os metadados (se não vierem None/0)
                if fps_in2: j.fps_in = fps_in2
                if fps_out: j.fps_out = fps_out
                if W2 and H2:
                    j.width, j.height = W2, H2
                j.status = "completed"
                j.updated_at = time.time()

        except Exception as e:
            # falha → limpar resíduos
            for p in (j.in_path, j.out_path):
                try: os.remove(p)
                except Exception: pass
            with jobs_lock:
                j.status = "failed"
                j.error = str(e)
                j.updated_at = time.time()

    job.future = executor.submit(_runner, job)

def _validate_queue_capacity():
    with jobs_lock:
        queued = sum(1 for j in JOBS.values() if j.status in ("queued", "processing"))
        if queued >= MAX_PENDING:
            abort(429, description="Fila cheia. Tente novamente em instantes.")

@app.post("/jobs")
def create_job():
    _validate_queue_capacity()

    if 'video' not in request.files:
        return api_error(400, "bad_request", "Envie o arquivo no campo 'video' (multipart/form-data).")
    f = request.files['video']
    if f.filename == '':
        return api_error(400, "bad_request", "Arquivo de vídeo inválido.")
    if not allowed_file(f.filename):
        return api_error(422, "unsupported_format", "Formato não suportado. Envie .mp4 ou .avi.")

    # lê params
    try:
        multi = int(request.form.get('multi', 1) or 1)
        fps   = request.form.get('fps', None)
        fps   = int(fps) if fps not in (None, "", "null") else None
        down  = float(request.form.get('down', 1) or 1)
        audio_opt = (request.form.get('audio', 'keep') or 'keep').lower()
        keep_audio = audio_opt in ('keep','manter','1','true','yes')
    except Exception as e:
        return api_error(400, "invalid_params", f"Parâmetros inválidos: {e}")

    # prepara paths e salva arquivo
    tmp_dir = tempfile.gettempdir()
    tmp_in  = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4", dir=tmp_dir); tmp_in.close()
    f.save(tmp_in.name)

    job_id = uuid.uuid4().hex
    out_path = os.path.join(tmp_dir, f"{job_id}_x{multi}.mp4")

    # probe + validação (agora com arquivo salvo)
    fps_in, W, H = probe_video(tmp_in.name)
    try:
        validate_combo(multi, fps, down, fps_in or 30.0)
    except ValueError as ve:
        try: os.remove(tmp_in.name)
        except Exception: pass
        return api_error(422, "invalid_combo", str(ve))

    # cria job UMA ÚNICA vez com todos os campos
    job = Job(
        id=job_id,
        in_path=tmp_in.name,
        out_path=out_path,
        multi=multi,
        fps=fps,
        down=down,
        status="queued",
        fps_in=fps_in,
        width=W,
        height=H,
        keep_audio=keep_audio
    )
    with jobs_lock:
        JOBS[job_id] = job

    _submit_job(job)
    return jsonify({"job_id": job_id, "status": "queued"}), 202

@app.get("/jobs/<job_id>")
def get_job(job_id):
    job = JOBS.get(job_id)
    if not job:
        abort(404, description="Job não encontrado.")
    with jobs_lock:
        payload = {
            "job_id": job.id,
            "status": job.status,
            "avg_fps": job.avg_fps,
            "frames": job.frames,
            "created_at": job.created_at,
            "updated_at": job.updated_at,
            "has_result": bool(job.out_path and os.path.exists(job.out_path) and job.status == "completed"),
            "error": job.error,
        }
    return jsonify(payload)

@app.post("/jobs/<job_id>/cancel")
def cancel_job(job_id):
    job = JOBS.get(job_id)
    if not job:
        abort(404, description="Job não encontrado.")
    with jobs_lock:
        if job.status in ("completed", "failed", "canceled"):
            return jsonify({"status": job.status})  # nada a fazer
        job.cancel_event.set()
    return jsonify({"status": "canceling"})

@app.get("/jobs/<job_id>/result")
def job_result(job_id):
    job = JOBS.get(job_id)
    if not job:
        abort(404, description="Job não encontrado.")
    if job.status != "completed" or not job.out_path or not os.path.exists(job.out_path):
        abort(409, description="Resultado ainda não disponível.")

    filename_download = f"output_x{job.multi}.mp4"
    resp = send_file(job.out_path, mimetype="video/mp4", as_attachment=True, download_name=filename_download)
    if job.avg_fps is not None:
        resp.headers['X-Avg-FPS'] = f"{job.avg_fps:.2f}"
    if job.frames is not None:
        resp.headers['X-Frames'] = str(job.frames)
    if job.fps_in is not None:  resp.headers['X-Input-FPS'] = f"{job.fps_in:.3f}"
    if job.fps_out is not None: resp.headers['X-Output-FPS'] = f"{job.fps_out:.3f}"
    if job.width and job.height: resp.headers['X-Input-Res'] = f"{job.width}x{job.height}"


    # RNF-05: apaga o resultado após enviar
    def _cleanup_on_close(path, jid):
        try: os.remove(path)
        except Exception: pass
        with jobs_lock:
            j = JOBS.get(jid)
            if j:
                j.out_path = None
                j.updated_at = time.time()
    resp.call_on_close(lambda p=job.out_path, jid=job.id: _cleanup_on_close(p, jid))
    return resp

# (opcional) limpador periódico de sobras por TTL
def _janitor():
    while True:
        time.sleep(60)
        now = time.time()
        with jobs_lock:
            for j in list(JOBS.values()):
                if j.out_path and os.path.exists(j.out_path) and (now - j.updated_at) > RESULT_TTL_SEC:
                    try: os.remove(j.out_path)
                    except Exception: pass
                    j.out_path = None
                    j.updated_at = now

janitor_thread = threading.Thread(target=_janitor, daemon=True)
janitor_thread.start()

if __name__ == "__main__":
    # Para desenvolvimento: atende múltiplas conexões; produção → use um WSGI (gunicorn/uwsgi) com threads=2
    app.run(debug=True, threaded=True)
