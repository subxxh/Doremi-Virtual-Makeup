import os
import urllib.request
import cv2
import numpy as np
import pyvirtualcam
from collections import deque

from capture_profile import (
    capture_and_save_profile,
    load_profile,
    extract_feature_colors_from_frame
)

from utils import read_landmarks, add_mask, face_points


# =========================
# MODEL DOWNLOAD
# =========================
_MODEL_FILE = "face_landmarker.task"
_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"

if not os.path.exists(_MODEL_FILE):
    print("Downloading face landmark model...")
    urllib.request.urlretrieve(_MODEL_URL, _model_file)
    print("Download complete")


# =========================
# CONFIG
# =========================
face_elements = [
    "LIP_LOWER", "LIP_UPPER",
    "EYEBROW_LEFT", "EYEBROW_RIGHT",
    "EYELINER_LEFT", "EYELINER_RIGHT",
    "EYESHADOW_LEFT", "EYESHADOW_RIGHT"
]

_fallback_colors = {
    "LIP_UPPER": [0, 0, 200],
    "LIP_LOWER": [0, 0, 200],
    "EYELINER_LEFT": [139, 0, 0],
    "EYELINER_RIGHT": [139, 0, 0],
    "EYESHADOW_LEFT": [0, 100, 0],
    "EYESHADOW_RIGHT": [0, 100, 0],
    "EYEBROW_LEFT": [19, 69, 139],
    "EYEBROW_RIGHT": [19, 69, 139],
    "BLUSH_LEFT": [147, 112, 219],
    "BLUSH_RIGHT": [147, 112, 219],
}

_all_elements = face_elements + ["BLUSH_LEFT", "BLUSH_RIGHT"]


# =========================
# STATE
# =========================
colors_map = _fallback_colors.copy()
blush_color = tuple(_fallback_colors["BLUSH_LEFT"])

SMOOTHING_WINDOW = 5
landmark_buffer = deque(maxlen=SMOOTHING_WINDOW)


# =========================
# HELPERS
# =========================
def rebuild_colors():
    global colors, lip_colors, eye_colors, blush_color, base_elements

    lip_elements = [e for e in face_elements if "LIP" in e]
    eye_elements = [e for e in face_elements if "EYESHADOW" in e]
    base_elements = [e for e in face_elements if e not in lip_elements and e not in eye_elements]

    colors = [colors_map.get(e, _fallback_colors[e]) for e in base_elements]
    lip_colors = [colors_map.get(e, _fallback_colors[e]) for e in lip_elements]
    eye_colors = [colors_map.get(e, _fallback_colors[e]) for e in eye_elements]

    blush_color = tuple(colors_map.get("BLUSH_LEFT", _fallback_colors["BLUSH_LEFT"]))


def draw_ui(frame):
    cv2.rectangle(frame, (10, 10), (330, 150), (0, 0, 0), -1)

    cv2.putText(frame, "MAKEUP FILTER", (20, 40),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255,255,255), 2)

    cv2.putText(frame, "S: Capture Makeup", (20, 70),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200,200,200), 1)

    cv2.putText(frame, "L: Load Profile", (20, 95),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200,200,200), 1)

    cv2.putText(frame, "I: Load Image", (20, 120),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200,200,200), 1)

    return frame


def load_makeup_from_image(path):
    img = cv2.imread(path)
    if img is None:
        print("[ERROR] Image not found")
        return None

    print("[INFO] Extracting makeup from image...")
    return extract_feature_colors_from_frame(
        img,
        _all_elements,
        _fallback_colors
    )


# =========================
# CAMERA
# =========================
cap = cv2.VideoCapture(0)

cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

if not cap.isOpened():
    raise RuntimeError("Could not open webcam")

width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))


DETECT_SCALE = 0.5


def landmarks_downscaled(frame):
    small = cv2.resize(frame, (0, 0), fx=DETECT_SCALE, fy=DETECT_SCALE)
    lm_small = read_landmarks(small)

    lm = {
        k: (int(x / DETECT_SCALE), int(y / DETECT_SCALE))
        for k, (x, y) in lm_small.items()
    }

    landmark_buffer.append(lm)

    smoothed = {}
    for key in lm.keys():
        xs = [f[key][0] for f in landmark_buffer if key in f]
        ys = [f[key][1] for f in landmark_buffer if key in f]

        if xs and ys:
            smoothed[key] = (
                int(sum(xs) / len(xs)),
                int(sum(ys) / len(ys))
            )

    return smoothed


def precompute_blend(masks_alphas, shape):
    a = np.ones((*shape[:2], 1), dtype=np.float32)
    b = np.zeros(shape, dtype=np.float32)

    for mask, alpha in masks_alphas:
        mask_f = mask.astype(np.float32)
        peak = mask_f.max()
        if peak < 1e-6:
            continue

        presence = mask_f.max(axis=2, keepdims=True) / peak
        pure = mask_f / np.where(presence > 0, presence, 1.0)

        w = presence * alpha
        b = b * (1 - w) + pure * w
        a = a * (1 - w)

    return a, b


# =========================
# START
# =========================
rebuild_colors()

with pyvirtualcam.Camera(width=width, height=height, fps=30) as cam:
    print("Virtual camera running")

    while True:
        ret, frame = cap.read()
        if not ret:
            continue

        lm = landmarks_downscaled(frame)
        if not lm:
            cv2.imshow("Virtual Makeup Filter", frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
            continue
        masks_alphas = []

        try:
            mask = np.zeros_like(frame)
            mask = add_mask(mask, lm,
                            [face_points[e] for e in base_elements],
                            colors)
            masks_alphas.append((mask, 0.4))

            lip_mask = np.zeros_like(frame)
            lip_mask = add_mask(lip_mask, lm,
                                [face_points[e] for e in face_elements if "LIP" in e],
                                lip_colors)
            masks_alphas.append((lip_mask, 0.7))

            eye_mask = np.zeros_like(frame)
            eye_mask = add_mask(eye_mask, lm,
                                [face_points[e] for e in face_elements if "EYESHADOW" in e],
                                eye_colors)
            masks_alphas.append((eye_mask, 0.5))

            for key in ("BLUSH_LEFT", "BLUSH_RIGHT"):
                pt = face_points[key][0]
                if pt in lm:
                    cx, cy = lm[pt]
                    bm = np.zeros_like(frame)
                    cv2.ellipse(bm, (cx, cy), (25, 15), 0, 0, 360, blush_color, -1)
                    bm = cv2.GaussianBlur(bm, (31, 31), 15)
                    masks_alphas.append((bm, 0.3))

        except:
            pass

        a, b = precompute_blend(masks_alphas, frame.shape)
        output = np.clip(frame.astype(np.float32) * a + b, 0, 255).astype(np.uint8)

        output = draw_ui(output)

        cv2.imshow("Virtual Makeup Filter", output)

        key = cv2.waitKey(1) & 0xFF

        if key == ord('q'):
            break

        elif key == ord('l'):
            print("[INFO] Loading profile...")
            loaded = load_profile()

            if loaded:
                for k, v in loaded.items():
                    colors_map[k] = [v[2], v[1], v[0]]  # RGB → BGR

            rebuild_colors()

        elif key == ord('s'):
            print("[INFO] Capturing makeup...")
            sampled = capture_and_save_profile(frame, _all_elements, _fallback_colors)

            colors_map.update({k: sampled.get(k, _fallback_colors[k]) for k in _all_elements})
            rebuild_colors()

        elif key == ord('i'):
            print("[INFO] Loading image makeup...")
            sampled = load_makeup_from_image("2.jpg")

            if sampled:
                colors_map.update({k: sampled.get(k, _fallback_colors[k]) for k in _all_elements})

            rebuild_colors()

        cam.send(cv2.cvtColor(output, cv2.COLOR_BGR2RGB))
        cam.sleep_until_next_frame()


cap.release()
cv2.destroyAllWindows()