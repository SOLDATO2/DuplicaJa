import mimetypes
import uuid
from flask import Flask, render_template
from model.model import FlowNet
from contextlib import nullcontext
from tempfile import NamedTemporaryFile, TemporaryDirectory
from flask import Flask, request, send_file, jsonify, abort
from model.util import interpolate_video
import os
import torch
import tempfile
from werkzeug.utils import secure_filename
from werkzeug.exceptions import RequestEntityTooLarge

torch.backends.cudnn.benchmark = True
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Usando: {device}")

model = FlowNet(base=16).to(device)
model.eval()

#carrega o modelo
model.load_state_dict(torch.load("best_model.pth", map_location=device))
print("Modelo carregado")


# #region ================================================== CONFIG ==================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "var", "uploads")
PROCESSED_FOLDER = os.path.join(BASE_DIR, "var", "processed")
ALLOWED_EXTS = {".mp4", ".avi"}
MAX_CONTENT_LENGTH = 1024 * 1024 * 1024  # 1 GiB

app = Flask(__name__)
app.config.update(
    UPLOAD_FOLDER=UPLOAD_FOLDER,
    PROCESSED_FOLDER=PROCESSED_FOLDER,
    MAX_CONTENT_LENGTH=MAX_CONTENT_LENGTH,
)

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PROCESSED_FOLDER, exist_ok=True)

def allowed_file(filename: str) -> bool:
    ext = os.path.splitext(filename)[1].lower()
    return ext in ALLOWED_EXTS

@app.errorhandler(RequestEntityTooLarge)
def handle_413(_e):
    mb = MAX_CONTENT_LENGTH // (1024 * 1024)
    return jsonify({"error": f"Arquivo muito grande. Limite: {mb} MB."}), 413


# #endregion ========================================================================================================

# #region ================================================== ROTAS ==================================================
@app.get("/")
def index():
    # Opcional: passe defaults para o template
    return render_template("index.html", default_multi=1, default_down=0.25)

# Mantive um formulário simples, sem template (útil para smoke tests)
@app.get("/simple")
def simple_form():
    return (
        "<h3>SimpleFlowNet - Interpolação de Vídeo</h3>"
        "<form method='POST' action='/interpolate' enctype='multipart/form-data'>"
        "Vídeo: <input type='file' name='video' accept='video/*' required><br/><br/>"
        "multi (int): <input type='number' name='multi' value='1'><br/>"
        "fps (int, opcional): <input type='number' name='fps'><br/>"
        "down (float): <input type='text' name='down' value='0.25'><br/>"
        "<button type='submit'>Enviar</button>"
        "</form>"
    )

# @app.route("/", methods=["GET"])
# def index():
#     return (
#         "<h3>SimpleFlowNet - Interpolação de Vídeo</h3>"
#         "<form method='POST' action='/interpolate' enctype='multipart/form-data'>"
#         "Vídeo: <input type='file' name='video' accept='video/*' required><br/><br/>"
#         "multi (int): <input type='number' name='multi' value='1'><br/>"
#         "fps (int, opcional): <input type='number' name='fps'><br/>"
#         "down (float): <input type='text' name='down' value='0.25'><br/>"
#         "<button type='submit'>Enviar</button>"
#         "</form>"
#     )


@app.route("/interpolate", methods=["POST"])
def interpolate_route():
    if 'video' not in request.files:
        abort(400, description="Envie o arquivo no campo 'video' (multipart/form-data).")

    f = request.files['video']
    if f.filename == '':
        abort(400, description="Arquivo de vídeo inválido.")

    # parâmetros opcionais
    try:
        multi = int(request.form.get('multi', 1))
        fps   = request.form.get('fps', None)
        fps   = int(fps) if fps not in (None, "", "null") else None
        down  = float(request.form.get('down', 0.25))
    except Exception as e:
        abort(400, description=f"Parâmetros inválidos: {e}")

    # arquivos temporários no diretório /tmp
    tmp_dir = tempfile.gettempdir()
    tmp_in  = NamedTemporaryFile(delete=False, suffix=".mp4", dir=tmp_dir)
    tmp_out = NamedTemporaryFile(delete=False, suffix=f"_x{multi}.mp4", dir=tmp_dir)
    tmp_in.close()
    tmp_out.close()

    # salva upload
    f.save(tmp_in.name)

    try:
        avg_fps, frames = interpolate_video(
            in_path=tmp_in.name,
            out_path=tmp_out.name,
            multi=multi,
            fps_override=fps,
            down=down,
            model=model,
            device=device
        )
    except Exception as e:

        try:
            os.remove(tmp_in.name)
            os.remove(tmp_out.name)
        except Exception:
            pass
        abort(500, description=f"Falha na inferência: {e}")

    #remove tmp
    try:
        os.remove(tmp_in.name)
    except Exception:
        pass

    #retorna com o arquivo interpolado
    filename_download = f"output_x{multi}.mp4"
    resp = send_file(
        tmp_out.name,
        mimetype="video/mp4",
        as_attachment=True,
        download_name=filename_download
    )

    resp.headers['X-Avg-FPS'] = f"{avg_fps:.2f}"
    resp.headers['X-Frames'] = str(frames)
    return resp
# #endregion ========================================================================================================

if __name__ == "__main__":
    app.run(debug=True, threaded=False)