import cv2
import json
import numpy as np
from utils import read_landmarks, face_points


def extract_feature_colors_from_frame(frame, elements, fallbacks):
    try:
        coords = read_landmarks(frame)
        result = {}

        for key in elements:
            pts = [coords[i] for i in face_points[key] if i in coords]

            if not pts:
                result[key] = fallbacks.get(key, [128, 128, 128])
                continue

            if len(pts) == 1:
                cx, cy = pts[0]
                patch = frame[max(0, cy - 12):cy + 12, max(0, cx - 12):cx + 12]
                color = patch.mean(axis=(0, 1)) if patch.size > 0 else np.array(fallbacks.get(key, [128, 128, 128]))

            else:
                region_mask = np.zeros(frame.shape[:2], dtype=np.uint8)
                cv2.fillPoly(region_mask, [np.array(pts)], 255)
                pixels = frame[region_mask == 255]

                if len(pixels) > 0:
                    hsv = cv2.cvtColor(pixels.reshape(1, -1, 3), cv2.COLOR_BGR2HSV).reshape(-1, 3)
                    sat, val = hsv[:, 1], hsv[:, 2]

                    # keep high saturation pixels (likely makeup)
                    saturated_idx = sat > sat.mean()
                    saturated = pixels[saturated_idx]
                    sat_val = val[saturated_idx]

                    if len(saturated) > 0:
                        dark_half = saturated[sat_val <= np.median(sat_val)]
                        # median is more stable than mean
                        color = np.median(dark_half, axis=0) if len(dark_half) > 0 else np.median(saturated, axis=0)
                    else:
                        color = np.median(pixels, axis=0)
                else:
                    color = np.array(fallbacks.get(key, [128, 128, 128]))

            result[key] = [int(v) for v in color]

        return result

    except Exception as e:
        print(f"[ERROR] Extraction failed: {e}")
        return fallbacks


def capture_and_save_profile(frame, elements, fallbacks, filename="makeup_profile.json"):
    """
    Call this when user presses a key.
    Extracts makeup from current frame and saves it.
    """
    profile = extract_feature_colors_from_frame(frame, elements, fallbacks)

    with open(filename, "w") as f:
        json.dump(profile, f, indent=4)

    print(f"[INFO] Makeup profile saved to {filename}")
    return profile


def load_profile(filename="makeup_profile.json"):
    try:
        with open(filename, "r") as f:
            profile = json.load(f)
        print(f"[INFO] Loaded profile from {filename}")
        return profile
    except FileNotFoundError:
        print("[WARNING] No saved profile found.")
        return None