import os
import urllib.request
import cv2
import numpy as np
import pyvirtualcam

_MODEL_FILE = "face_landmarker.task"
_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"

if not os.path.exists(_MODEL_FILE):
    print("Downloading face landmark model...")
    urllib.request.urlretrieve(_MODEL_URL, _MODEL_FILE)
    print("Download complete.")

from utils import read_landmarks, add_mask, face_points

REFERENCE_IMAGE = "2.jpg"

face_elements = ["LIP_LOWER", "LIP_UPPER", "EYEBROW_LEFT", "EYEBROW_RIGHT",
                 "EYELINER_LEFT", "EYELINER_RIGHT", "EYESHADOW_LEFT", "EYESHADOW_RIGHT"]

_fallback_colors = {
    "LIP_UPPER":      [0, 0, 200],
    "LIP_LOWER":      [0, 0, 200],
    "EYELINER_LEFT":  [139, 0, 0],
    "EYELINER_RIGHT": [139, 0, 0],
    "EYESHADOW_LEFT": [0, 100, 0],
    "EYESHADOW_RIGHT":[0, 100, 0],
    "EYEBROW_LEFT":   [19, 69, 139],
    "EYEBROW_RIGHT":  [19, 69, 139],
    "BLUSH_LEFT":     [147, 112, 219],
    "BLUSH_RIGHT":    [147, 112, 219],
}

def sample_feature_colors(image_path, elements, fallbacks):
    img = cv2.imread(image_path)
    if img is None:
        print(f"Warning: could not load {image_path}, using default colors.")
        return fallbacks
    try:
        coords = read_landmarks(img)
        result = {}
        for key in elements:
            pts = [coords[i] for i in face_points[key] if i in coords]
            if not pts:
                result[key] = fallbacks.get(key, [128, 128, 128])
                continue
            if len(pts) == 1:
                cx, cy = pts[0]
                patch = img[max(0, cy - 12):cy + 12, max(0, cx - 12):cx + 12]
                color = patch.mean(axis=(0, 1)) if patch.size > 0 else np.array(fallbacks.get(key, [128, 128, 128]))
            else:
                region_mask = np.zeros(img.shape[:2], dtype=np.uint8)
                cv2.fillPoly(region_mask, [np.array(pts)], 255)
                pixels = img[region_mask == 255]
                if len(pixels) > 0:
                    # keep high-saturation pixels, then take the darker half to avoid light noise
                    hsv = cv2.cvtColor(pixels.reshape(1, -1, 3), cv2.COLOR_BGR2HSV).reshape(-1, 3)
                    sat, val = hsv[:, 1], hsv[:, 2]
                    saturated_idx = sat > sat.mean()
                    saturated = pixels[saturated_idx]
                    sat_val = val[saturated_idx]
                    if len(saturated) > 0:
                        dark_half = saturated[sat_val <= np.median(sat_val)]
                        color = dark_half.mean(axis=0) if len(dark_half) > 0 else saturated.mean(axis=0)
                    else:
                        color = pixels.mean(axis=0)
                else:
                    color = np.array(fallbacks.get(key, [128, 128, 128]))
            result[key] = [int(v) for v in color]
        return result
    except Exception as e:
        print(f"Warning: color sampling failed ({e}), using defaults.")
        return fallbacks

_all_elements = face_elements + ["BLUSH_LEFT", "BLUSH_RIGHT"]
sampled = sample_feature_colors(REFERENCE_IMAGE, _all_elements, _fallback_colors)
print("Colors sampled from reference image:")
for k, v in sampled.items():
    print(f"  {k}: BGR{tuple(v)}")

colors_map = {k: sampled[k] for k in face_elements}
blush_color = tuple(sampled.get("BLUSH_LEFT", _fallback_colors["BLUSH_LEFT"]))

_lip_elements  = [e for e in face_elements if "LIP" in e]
_eye_elements  = [e for e in face_elements if "EYESHADOW" in e]
_base_elements = [e for e in face_elements if e not in _lip_elements and e not in _eye_elements]

face_connections = [face_points[e] for e in _base_elements]
colors           = [colors_map[e]  for e in _base_elements]
lip_connections  = [face_points[e] for e in _lip_elements]
lip_colors       = [colors_map[e]  for e in _lip_elements]
eye_connections  = [face_points[e] for e in _eye_elements]
eye_colors       = [colors_map[e]  for e in _eye_elements]

def alpha_blend_mask(base, mask, alpha):
    """Soft alpha blend using mask brightness as per-pixel weight."""
    base_f = base.astype(np.float32)
    mask_f = mask.astype(np.float32)
    peak = mask_f.max()
    if peak < 1e-6:
        return base
    # presence: 1.0 at the center of the feature, smoothly 0 at edges
    presence = mask_f.max(axis=2, keepdims=True) / peak
    # recover the actual color regardless of how dark/bright it is
    pure_color = mask_f / np.where(presence > 0, presence, 1.0)
    weight = presence * alpha
    return np.clip(base_f * (1 - weight) + pure_color * weight, 0, 255).astype(np.uint8)

cap = cv2.VideoCapture(0)
if not cap.isOpened():
    raise RuntimeError("Could not open webcam. Make sure Zoom is not already using it.")

width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps    = cap.get(cv2.CAP_PROP_FPS) or 30

print(f"Webcam opened: {width}x{height} @ {fps}fps")

with pyvirtualcam.Camera(width=width, height=height, fps=fps) as cam:
    print(f"Virtual camera running: {cam.device}")
    print("Press Q in the preview window to quit.")
    while True:
        ret, frame = cap.read()
        if not ret:
            continue  # skip bad frames, don't exit
        # frame = cv2.flip(frame, 1)  # mirror horizontally

        try:
            landmark_coordinates = read_landmarks(frame)
            mask = np.zeros_like(frame)
            mask = add_mask(mask, idx_to_coordinates=landmark_coordinates,
                            face_connections=face_connections, colors=colors)
            output = alpha_blend_mask(frame, mask, 0.4)

            lip_mask = np.zeros_like(frame)
            lip_mask = add_mask(lip_mask, idx_to_coordinates=landmark_coordinates,
                                face_connections=lip_connections, colors=lip_colors)
            output = alpha_blend_mask(output, lip_mask, 0.7)

            eye_mask = np.zeros_like(frame)
            eye_mask = add_mask(eye_mask, idx_to_coordinates=landmark_coordinates,
                                face_connections=eye_connections, colors=eye_colors)
            output = alpha_blend_mask(output, eye_mask, 0.5)

            for key in ("BLUSH_LEFT", "BLUSH_RIGHT"):
                pt_idx = face_points[key][0]
                if pt_idx in landmark_coordinates:
                    cx, cy = landmark_coordinates[pt_idx]
                    blush_mask = np.zeros_like(frame)
                    cv2.ellipse(blush_mask, (cx, cy), (25, 15), 0, 0, 360, blush_color, -1)
                    blush_mask = cv2.GaussianBlur(blush_mask, (61, 61), 25)
                    output = alpha_blend_mask(output, blush_mask, 0.3)
        except (IndexError, KeyError):
            output = frame  # no face detected, pass throuqgh plain video

        # show local preview so you can confirm filter is working
        cv2.imshow("Virtual Makeup Preview (Q to quit)", output)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

        # pyvirtualcam expects RGB
        cam.send(cv2.cvtColor(output, cv2.COLOR_BGR2RGB))
        cam.sleep_until_next_frame()

cap.release()
cv2.destroyAllWindows()
