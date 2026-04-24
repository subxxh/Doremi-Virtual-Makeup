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

face_elements = ["LIP_LOWER", "LIP_UPPER", "EYEBROW_LEFT", "EYEBROW_RIGHT",
                 "EYELINER_LEFT", "EYELINER_RIGHT", "EYESHADOW_LEFT", "EYESHADOW_RIGHT"]
colors_map = {
    # upper lip and lower lips
    "LIP_UPPER": [255, 0, 0],  # Red in BGR
    "LIP_LOWER": [255, 0, 0],  # Red in BGR
    # eyeliner
    "EYELINER_LEFT": [139, 0, 0],  # Dark Blue in BGR
    "EYELINER_RIGHT": [139, 0, 0],  # Dark Blue in BGR
    # eye shadow
    "EYESHADOW_LEFT": [0, 100, 0],  # Dark Green in BGR
    "EYESHADOW_RIGHT": [0, 100, 0],  # Dark Green in BGR
    # eye brow
    "EYEBROW_LEFT": [19, 69, 139],  # Dark Brown in BGR
    "EYEBROW_RIGHT": [19, 69, 139],  # Dark Brown in BGR
}

face_connections = [face_points[idx] for idx in face_elements]
colors = [colors_map[idx] for idx in face_elements]

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
            output = cv2.addWeighted(frame, 1.0, mask, 0.2, 1.0)

            # hardcoded blush: soft rosy-pink ellipse on each cheek
            blush_color = (147, 112, 219)  # BGR: rosy pink
            for key in ("BLUSH_LEFT", "BLUSH_RIGHT"):
                pt_idx = face_points[key][0]
                if pt_idx in landmark_coordinates:
                    cx, cy = landmark_coordinates[pt_idx]
                    blush_mask = np.zeros_like(frame)
                    cv2.ellipse(blush_mask, (cx, cy), (25, 15), 0, 0, 360, blush_color, -1)
                    blush_mask = cv2.GaussianBlur(blush_mask, (61, 61), 25)
                    output = cv2.addWeighted(output, 1.0, blush_mask, 0.2, 0) #make blush brighter, more noticeable
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
