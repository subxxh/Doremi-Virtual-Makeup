export const FaceRegions = {
  // MediaPipe Face Mesh landmark indices (same source as your Python `utils.py`)
  LIP_UPPER: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 308, 415, 310, 312, 13, 82, 81, 80, 191, 78],
  LIP_LOWER: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 402, 317, 14, 87, 178, 88, 95, 78, 61],
  // Approximate inner mouth opening. Used to prevent lipstick bleeding onto teeth when mouth opens.
  // Source: MediaPipe face mesh lip inner contour indices.
  MOUTH_INNER: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78],
  // Eye outlines (used to cut eyeshadow out of the eyeball region)
  LEFT_EYE: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7, 33],
  // 398 (not 298) is the upper-lid landmark next to the inner corner; 298 is a forehead/inner-brow point
  // and made buildFan(EYE_RIGHT_MASK) spike up into the brow, slicing the eyeshadow into two pieces.
  RIGHT_EYE: [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382, 362],
  // Upper eyelid contours (for cute eyeliner + wing; avoids lining the bottom lid).
  // Both ordered so the polyline runs left→right on screen in canvas space (matches ribbon math).
  EYELID_UPPER_LEFT: [33, 246, 161, 160, 159, 158, 157, 173, 133],
  EYELID_UPPER_RIGHT: [362, 398, 384, 385, 386, 387, 388, 466, 263],
  // Nose ridge (centerline). We'll offset left/right in code to create contour lines.
  NOSE_RIDGE: [168, 6, 195, 5, 4],
  EYEBROW_LEFT: [55, 107, 66, 105, 63, 70, 46, 53, 52, 65, 55],
  EYEBROW_RIGHT: [285, 336, 296, 334, 293, 300, 276, 283, 295, 285],
  EYELINER_LEFT: [243, 112, 26, 22, 23, 24, 110, 25, 226, 130, 33, 7, 163, 144, 145, 153, 154, 155, 133, 243],
  EYELINER_RIGHT: [463, 362, 382, 381, 380, 374, 373, 390, 249, 263, 359, 446, 255, 339, 254, 253, 252, 256, 341, 463],
  /** Crease arc + upper lid margin (runtime `alignCreaseLashForStrip` fixes direction for the strip). */
  EYELID_CREASE_LEFT: [226, 247, 30, 29, 27, 28, 56, 190, 243],
  EYELID_CREASE_RIGHT: [463, 414, 286, 258, 257, 259, 260, 467, 446],
  // Upper lid margin (9 points each, mirrored layout: outer-corner, lash×6, inner-just-past, inner-corner).
  // Equal-arc-length loft in buildEyeshadowCreaseLashStrip needs both sides to have the same role layout
  // so an extra outer-past anchor (e.g. 359) on only one side does not stretch that lash past its crease.
  EYELID_LASH_LEFT: [33, 246, 161, 160, 159, 158, 157, 173, 133],
  EYELID_LASH_RIGHT: [263, 466, 388, 387, 386, 385, 384, 398, 362],
  // Lower-lid polylines, in left-to-right screen order. Offset downward in code to build the
  // under-eye concealer crescent (covers tear trough + upper cheek where dark circles sit).
  UNDER_EYE_LEFT_LID: [133, 155, 154, 153, 145, 144, 163, 7, 33],
  UNDER_EYE_RIGHT_LID: [362, 382, 381, 380, 374, 373, 390, 249, 263],
} as const;

export const FacePoints = {
  BLUSH_LEFT: 50,
  BLUSH_RIGHT: 280,
  NOSE_TIP: 4,
} as const;
