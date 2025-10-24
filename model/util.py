import torch
import numpy as np
import cv2
from queue import Queue
from tqdm import tqdm
import time
import torch.nn.functional as F
import threading

_grid_cache = {}
_grid_lock = threading.Lock()

def warp(img, flow, f32=True):
    B, C, H, W = img.shape
    device, dtype = img.device, img.dtype
    key = (H, W, device, dtype)

    if key not in _grid_cache:
        with _grid_lock:
            if key not in _grid_cache:
                y = torch.linspace(-1, 1, H, device=device, dtype=dtype)
                x = torch.linspace(-1, 1, W, device=device, dtype=dtype)
                grid_y, grid_x = torch.meshgrid(y, x, indexing='ij')
                base = torch.stack((grid_x, grid_y), dim=2)  # (H, W, 2)
                _grid_cache[key] = base.unsqueeze(0)         # (1, H, W, 2)

    grid = _grid_cache[key].expand(B, -1, -1, -1)  # (B, H, W, 2)

    flow_x = flow[:, 0, :, :] / ((W - 1) / 2)
    flow_y = flow[:, 1, :, :] / ((H - 1) / 2)
    flow_norm = torch.stack((flow_x, flow_y), dim=3)
    vgrid = grid + flow_norm
    return F.grid_sample(img, vgrid, align_corners=True, padding_mode='border')

def flow2rgb(flow):
    npf = flow.detach().cpu().numpy().transpose(1,2,3,0)[...,0]
    h,w,_,_ = flow.permute(0,2,3,1).shape
    norm = npf / (np.abs(npf).max()+1e-6)
    rgb = np.ones((h,w,3),np.float32)
    rgb[...,0] += norm[...,0]
    rgb[...,1] -= 0.5*(norm[...,0]+norm[...,1])
    rgb[...,2] += norm[...,1]
    return np.clip(rgb,0,1)

def clear_write_buffer(write_buffer, vid_writer, cancel_event=None):
    while True:
        if cancel_event is not None and cancel_event.is_set():
            break
        frame = write_buffer.get()
        if frame is None:
            break
        vid_writer.write(frame[:, :, ::-1])

def build_read_buffer(read_buffer, path, cancel_event=None):
    cap = cv2.VideoCapture(path)
    try:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                break
            ret, frame = cap.read()
            if not ret:
                break
            read_buffer.put(frame[:, :, ::-1].copy())
    finally:
        cap.release()
        read_buffer.put(None)

@torch.inference_mode()
def interpolate_video(in_path, out_path, multi=1, fps_override=None, down=0.25, model=None, device=None, cancel_event=None):
    """Executa a interpolação e grava em out_path. Retorna (avg_fps, frames_gerados)."""

    # (2) propriedades do vídeo
    cap_tmp = cv2.VideoCapture(in_path)
    W = int(cap_tmp.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap_tmp.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps_in = cap_tmp.get(cv2.CAP_PROP_FPS)
    cap_tmp.release()

    fps_out = fps_override or (fps_in * (multi + 1))
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    vid_writer = cv2.VideoWriter(out_path, fourcc, fps_out, (W, H))

    # (3) threads de leitura/gravação
    from _thread import start_new_thread
    read_buffer  = Queue(maxsize=100)
    write_buffer = Queue(maxsize=100)
    start_new_thread(build_read_buffer, (read_buffer, in_path, cancel_event))
    start_new_thread(clear_write_buffer, (write_buffer, vid_writer, cancel_event))

    pbar = tqdm(unit='frames', desc='Interpolando', leave=False)
    last = read_buffer.get()
    if last is None:
        vid_writer.release()
        return 0.0, 0

    frame_count = 0
    start = time.time()

    while True:
        if cancel_event is not None and cancel_event.is_set():
            break

        cur = read_buffer.get()
        if cur is None:
            write_buffer.put(last)
            frame_count += 1
            break

        h_s, w_s = int(H * down), int(W * down)
        last_s = cv2.resize(last, (w_s, h_s), interpolation=cv2.INTER_AREA)
        cur_s  = cv2.resize(cur,  (w_s, h_s), interpolation=cv2.INTER_AREA)

        I0_small = torch.from_numpy(last_s.transpose(2,0,1))[None].to(device).float() / 255.
        I1_small = torch.from_numpy(cur_s .transpose(2,0,1))[None].to(device).float() / 255.
        I0_orig  = torch.from_numpy(last .transpose(2,0,1))[None].to(device).float() / 255.
        I1_orig  = torch.from_numpy(cur  .transpose(2,0,1))[None].to(device).float() / 255.

        write_buffer.put(last)
        frame_count += 1

        for i in range(multi):
            if cancel_event is not None and cancel_event.is_set():
                break

            t = (i+1) / (multi+1)
            flow_small, mask_small = model.inference(I0_small, I1_small)

            scale = H / float(h_s)
            flow_up = F.interpolate(flow_small, size=(H, W), mode='bilinear', align_corners=True) * scale
            mask_up = F.interpolate(mask_small, size=(H, W), mode='bilinear', align_corners=True)

            f01 = flow_up[:, :2] * t
            f10 = flow_up[:, 2:] * (1 - t)

            w0 = warp(I0_orig, f01)
            w1 = warp(I1_orig, f10)
            out = w0 * mask_up + w1 * (1 - mask_up)

            img_tensor = (out * 255.0).byte()
            img = img_tensor[0].detach().cpu().permute(1,2,0).numpy()

            write_buffer.put(img)
            frame_count += 1

        last = cur
        pbar.update(1 + multi)

    pbar.close()
    end = time.time()
    avg_fps = frame_count / (end - start) if end > start else 0.0

    write_buffer.put(None)
    time.sleep(0.5)
    vid_writer.release()

    return avg_fps, frame_count, fps_in, fps_out, W, H
