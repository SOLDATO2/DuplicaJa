# api_jobs.py
from __future__ import annotations

import multiprocessing as mp
import os
import secrets
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from multiprocessing import Process
from pathlib import Path
from typing import Dict, Optional

# === usa o seu modelo real ===
import torch
from flask import Blueprint, abort, jsonify, request, send_file, url_for
from werkzeug.exceptions import HTTPException

from model.model import FlowNet
from model.util import interpolate_video

_PROCS: dict[str, Process] = {}

# ========= CONFIG =========
jobs_bp = Blueprint("jobs", __name__)

TTL_SECONDS = 24 * 60 * 60         # RF-11 TTL 24h
UPLOAD_DIR  = Path("static/uploads");  UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR  = Path("static/outputs");  OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

PRESETS = {                         # RF-06
    "youtube_60fps": {"multi": 2, "fps_alvo": 60, "downscale": 1.0},
    "stories_30fps": {"multi": 2, "fps_alvo": 30, "downscale": 0.75},
    "qualidade_120": {"multi": 4, "fps_alvo": 120, "downscale": 1.0},
    "mobile_leve":   {"multi": 2, "fps_alvo": 48, "downscale": 0.5},
}

LABEL_PT = {
    "queued":"Na fila",
    "processing":"Processando",
    "completed":"Concluído",
    "failed":"Erro",
    "canceled":"Cancelado",
}

def _ok(data=None, msg=""):
    return jsonify({"code":"OK","message":msg,"details":None,"data":data or {}})

def _err(code, msg, details=None):
    r = jsonify({"code":"ERROR","message":msg,"details":details})
    r.status_code = code
    return r

@jobs_bp.app_errorhandler(HTTPException)
def _http(e: HTTPException):
    return _err(e.code or 500, e.description or e.name)

import mimetypes
import os
import shutil
import subprocess
import tempfile

import cv2  # pip install opencv-python
import numpy as np
from flask import Response


def ensure_web_mp4(src_path: str) -> str:
    """
    Gera um MP4 web-safe (H.264 yuv420p + moov no início).
    Tenta ffmpeg; sem ffmpeg, usa fallback com OpenCV.
    Retorna o caminho final (pode ser o mesmo se já estiver ok).
    """
    # 1) Se tiver ffmpeg no PATH, use (melhor resultado)
    if shutil.which("ffmpeg"):
        out_path = src_path.rsplit(".", 1)[0] + "_web.mp4"
        cmd = [
            "ffmpeg", "-y", "-i", src_path,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
            "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "128k",
            out_path
        ]
        subprocess.run(cmd, check=True)
        # substitui o arquivo original
        os.replace(out_path, src_path)
        return src_path

    # 2) Fallback sem ffmpeg: regrava vídeo com OpenCV (sem áudio)
    #    Observação: sem áudio e sem faststart; ainda assim costuma tocar em browsers.
    cap = cv2.VideoCapture(src_path)
    if not cap.isOpened():
        return src_path  # não conseguiu abrir? devolve como está.

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)

    # fourcc H.264/AVC costuma ser 'avc1' ou 'H264' dependendo do build; tente ambos
    fourcc_try = [cv2.VideoWriter_fourcc(*'avc1'), cv2.VideoWriter_fourcc(*'H264'), cv2.VideoWriter_fourcc(*'mp4v')]
    tmp_out = src_path.rsplit(".", 1)[0] + "_web_tmp.mp4"
    writer = None
    for fcc in fourcc_try:
        writer = cv2.VideoWriter(tmp_out, fcc, fps, (w, h))
        if writer.isOpened():
            break
    if not writer or not writer.isOpened():
        cap.release()
        # não conseguiu escrever; devolve o original (vai seguir não tocando em alguns browsers)
        return src_path

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # garante 8-bit BGR -> yuv420p é do encoder; aqui só escrevemos
        writer.write(frame)

    cap.release()
    writer.release()

    # substitui o arquivo original
    os.replace(tmp_out, src_path)
    return src_path

def _send_file_with_range(path: Path):
    """
    Serve arquivo com suporte a HTTP Range (206 Partial Content).
    Necessário para <video> conseguir tocar/seek sem travar.
    """
    file_path = str(path)
    file_size = path.stat().st_size
    mime = mimetypes.guess_type(file_path)[0] or "application/octet-stream"

    range_header = request.headers.get("Range", None)
    if not range_header:
        # resposta 200 inteira (sem range)
        resp = Response(
            open(file_path, "rb").read(),
            status=200,
            mimetype=mime,
            direct_passthrough=True
        )
        resp.headers["Content-Length"] = str(file_size)
        resp.headers["Accept-Ranges"] = "bytes"
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        return resp

    # Ex.: "bytes=0-1023"
    try:
        _, rng = range_header.split("=")
        start_s, end_s = (rng.split("-") + [""])[:2]
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
        end = min(end, file_size - 1)
        if start > end or start < 0:
            raise ValueError()
    except Exception:
        # Range inválido
        return Response(status=416)

    length = end - start + 1
    f = open(file_path, "rb")
    f.seek(start)
    data = f.read(length)
    f.close()

    resp = Response(data, status=206, mimetype=mime, direct_passthrough=True)
    resp.headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Content-Length"] = str(length)
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp

# ========= MODELO (carrega 1x aqui) =========
torch.backends.cudnn.benchmark = True
_device = torch.device("cpu")
_model = FlowNet(base=16).to(_device)
_model.eval()
try:
    _model.load_state_dict(torch.load("best_model.pth", map_location=_device))
except Exception as e:
    # se não tiver o peso, os jobs vão falhar com msg clara
    print("ATENÇÃO: best_model.pth não carregado:", e)

# ========= STORE DE JOBS =========
@dataclass
class Job:
    id: str
    token: str
    input_name: str
    output_name: Optional[str] = None

    status: str = "queued"   # queued|processing|completed|failed|canceled
    message: str = ""
    progresso: float = 0.0
    etapa: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)

    preset: Optional[str] = None
    multi: Optional[int] = None
    fps_alvo: Optional[int] = None
    downscale: Optional[float] = None
    manter_audio: bool = True   # ignorado no motor atual

    ttl_seconds: int = TTL_SECONDS
    _cancel: bool = field(default=False, repr=False)

    def expires_at(self) -> datetime:
        return self.created_at + timedelta(seconds=self.ttl_seconds)

    def to_public(self) -> Dict:
        d = asdict(self); d.pop("_cancel", None)
        d["status_label_pt"] = LABEL_PT.get(self.status, self.status)
        d["expires_at"] = self.expires_at().isoformat() + "Z"
        if self.status == "completed" and self.output_name:
            d["result_url"] = url_for("jobs.get_result", id=self.id, token=self.token, _external=True)
        return d

_JOBS: Dict[str, Job] = {}
_LOCK = threading.Lock()

def _put(job: Job):
    with _LOCK: _JOBS[job.id] = job

def _get(jid: str) -> Optional[Job]:
    with _LOCK: return _JOBS.get(jid)

def _cancel(jid: str):
    with _LOCK:
        j = _JOBS.get(jid)
        if not j: return
        j._cancel = True
        j.status = "canceled"
        j.etapa  = "cancelado"
        j.updated_at = datetime.utcnow()
        # limpeza
        try:
            if j.output_name: (OUTPUT_DIR / j.output_name).unlink(missing_ok=True)
            (UPLOAD_DIR / j.input_name).unlink(missing_ok=True)
        except: pass

def _sweep():
    while True:
        time.sleep(30)
        now = datetime.utcnow()
        with _LOCK:
            rm = []
            for jid, j in _JOBS.items():
                if now > j.expires_at():
                    try:
                        if j.output_name: (OUTPUT_DIR / j.output_name).unlink(missing_ok=True)
                        (UPLOAD_DIR / j.input_name).unlink(missing_ok=True)
                    except: pass
                    rm.append(jid)
            for jid in rm:
                _JOBS.pop(jid, None)

threading.Thread(target=_sweep, daemon=True).start()

# ========= WORKER =========
def _out_name(input_name: str, fps: Optional[int]) -> str:
    stem, ext = os.path.splitext(input_name)
    if not ext: ext = ".mp4"
    return f"{stem}_interp_{int(fps)}fps{ext}" if fps else f"{stem}_interp{ext}"

def _interpolate_task(src_path: str, out_path: str, multi: int, fps_override: int | None, down: float):
    # roda a tarefa real (processo separado)
    avg_fps, frames = interpolate_video(
        in_path=src_path,
        out_path=out_path,
        multi=multi,
        fps_override=fps_override,
        down=down,
        model=_model,
        device=_device
    )
    # Guardamos as métricas em um arquivo sidecar simples (para não perder no processo)
    sidecar = out_path + ".meta"
    with open(sidecar, "w", encoding="utf-8") as f:
        f.write(f"{avg_fps}|{frames}")

def _worker(job: Job):
    try:
        job.status="processing"; job.etapa="iniciando"; job.progresso=0.05; job.updated_at=datetime.utcnow()

        src = (UPLOAD_DIR / job.input_name).resolve()
        if not src.exists():
            raise RuntimeError("arquivo de entrada não encontrado")

        out = (OUTPUT_DIR / _out_name(job.input_name, job.fps_alvo)).resolve()

        job.etapa="interpolando"; job.progresso=0.3; job.updated_at=datetime.utcnow()

        # dispara em subprocesso
        p = mp.Process(
            target=_interpolate_task,
            args=(str(src), str(out), int(job.multi or 1), int(job.fps_alvo) if job.fps_alvo else None, float(job.downscale or 1.0))
        )
        p.daemon = True
        p.start()
        _PROCS[job.id] = p

        # loop de espera com checks de cancelamento
        while p.is_alive():
            if job._cancel:
                # matar o processo e limpar
                try:
                    p.terminate()
                except Exception:
                    pass
                p.join(timeout=1)
                try:
                    out.unlink(missing_ok=True)
                except Exception:
                    pass
                try:
                    (UPLOAD_DIR / job.input_name).unlink(missing_ok=True)
                except Exception:
                    pass
                job.status="canceled"; job.etapa="cancelado"; job.updated_at=datetime.utcnow()
                _PROCS.pop(job.id, None)
                return
            time.sleep(0.25)

        # terminou normal
        _PROCS.pop(job.id, None)
        if p.exitcode != 0:
            raise RuntimeError("processo de interpolação terminou com erro")

        # lê sidecar
        meta_path = str(out) + ".meta"
        avg_fps = None; frames = None
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                txt = f.read().strip()
                parts = txt.split("|")
                if len(parts) == 2:
                    avg_fps = float(parts[0]); frames = int(parts[1])
        except Exception:
            pass

        job.output_name = out.name
        job.etapa="finalizando"; job.progresso=0.9; job.updated_at=datetime.utcnow()
        time.sleep(0.1)
        ensure_web_mp4(str(out))
        job.status="completed"; job.message=""; job.progresso=1.0; job.etapa="concluído"; job.updated_at=datetime.utcnow()
    except Exception as e:
        if job.status != "canceled":
            job.status="failed"; job.message=str(e); job.updated_at=datetime.utcnow()
    finally:
        # limpeza do upload (privacidade) – mantém só o resultado
        try:
            (UPLOAD_DIR / job.input_name).unlink(missing_ok=True)
        except Exception:
            pass

def _require_token(job: Job, token: Optional[str]):
    if not token or token != job.token:
        abort(403, description="token inválido")

# ========= ENDPOINTS =========
@jobs_bp.post("/jobs")  # RF-07 + RF-06
def create_job():
    data = request.get_json(force=True, silent=True) or {}
    input_name = data.get("input_filename")
    if not input_name:
        return _err(400, "input_filename é obrigatório")
    if not (UPLOAD_DIR / input_name).exists():
        return _err(404, "arquivo não encontrado em static/uploads")

    jid   = data.get("id") or str(uuid.uuid4())
    token = data.get("token") or secrets.token_urlsafe(16)
    if _get(jid): return _err(409, "job id já existe")

    # aplica preset
    preset_key = data.get("preset")
    params = PRESETS.get(preset_key, {}).copy() if preset_key else {}
    for k in ["multi","fps_alvo","downscale","manter_audio"]:
        if k in data and data[k] is not None:
            params[k] = data[k]

    job = Job(
        id=jid, token=token, input_name=input_name,
        preset=preset_key,
        multi=params.get("multi"), fps_alvo=params.get("fps_alvo"),
        downscale=params.get("downscale"), manter_audio=bool(params.get("manter_audio", True)),
        ttl_seconds=int(data.get("ttl_seconds") or TTL_SECONDS),
    )
    _put(job)
    threading.Thread(target=_worker, args=(job,), daemon=True).start()
    return _ok(job.to_public()), 202

@jobs_bp.get("/jobs/<id>")  # RF-08
def get_job(id: str):
    job = _get(id)
    if not job: return _err(404, "job não encontrado")
    token = request.args.get("token") or request.headers.get("X-Job-Token")
    _require_token(job, token)
    return _ok(job.to_public())

@jobs_bp.post("/jobs/<id>/cancel")  # RF-09
def cancel_job(id: str):
    job = _get(id)
    if not job: return _err(404, "job não encontrado")
    token = request.args.get("token") or request.headers.get("X-Job-Token")
    _require_token(job, token)

    job._cancel = True
    job.status = "canceled"
    job.etapa  = "cancelado"
    job.updated_at = datetime.utcnow()

    # se houver subprocesso, mata na hora
    p = _PROCS.pop(job.id, None)
    if p and p.is_alive():
        try:
            p.terminate()
        except Exception:
            pass

    # limpeza de artefatos parciais
    try:
        (OUTPUT_DIR / _out_name(job.input_name, job.fps_alvo)).unlink(missing_ok=True)
    except Exception:
        pass
    try:
        (UPLOAD_DIR / job.input_name).unlink(missing_ok=True)
    except Exception:
        pass

    return _ok(job.to_public(), "job cancelado")


@jobs_bp.get("/jobs/<id>/result")  # RF-11
def get_result(id: str):
    job = _get(id)
    if not job:
        return _err(404, "job não encontrado")

    token = request.args.get("token") or request.headers.get("X-Job-Token")
    _require_token(job, token)

    # TTL
    if datetime.utcnow() > job.expires_at():
        return _err(410, "resultado expirado")

    if job.status != "completed" or not job.output_name:
        return _err(404, "resultado indisponível")

    path = (OUTPUT_DIR / job.output_name)
    if not path.exists():
        return _err(404, "arquivo não encontrado")

    # decide inline vs download
    force_download = request.args.get("download") == "1"

    # Mime correto (mp4/avi)
    import mimetypes
    mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"

    # Usa o stack nativo do Flask para Range/206
    resp = send_file(
        path,
        mimetype=mime,
        as_attachment=force_download,
        download_name=path.name,
        conditional=True,   # <<< habilita Range/206
        etag=True,
        last_modified=True
    )

    # inline explícito quando não é download
    if not force_download:
        resp.headers["Content-Disposition"] = f'inline; filename="{path.name}"'

    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Cache-Control"] = "no-store"
    return resp
