# BlushedCV💄

> Real-time virtual makeup try-on in the browser, powered by face landmark detection and WebGL.

## Features

- Real-time virtual makeup try-on via webcam
- Face landmark detection (MediaPipe `face_landmarker.task`)
- Customizable makeup profiles (`makeup_profile.json`)
- WebGL-powered rendering

## Demo

- Live on Hugging Face Spaces: <https://huggingface.co/spaces/subxxh/BlushedCV>
  
## Tech Stack

- **Backend:** FastAPI, Python 3.10
- **ML:** MediaPipe Face Landmarker
- **Frontend:** WebGL, Gradio
- **Build:** Vite, Rolldown

## Project Structure

```
app.py                  # FastAPI entry, serves built frontend
capture_profile.py      # Capture a makeup profile from a reference image
webcam.py               # Webcam capture pipeline
utils.py                # Shared helpers
face_landmarker.task    # MediaPipe model
makeup_profile.json     # Default makeup config
webgl/                  # WebGL renderer source
dist/                   # Built frontend (served by FastAPI)
requirements.txt        # Python deps
package.json            # Frontend deps
```

## Getting Started

### Prerequisites

- Python 3.10
- Node.js 18+
- A webcam

### Installation

**Windows (PowerShell)**

```powershell
git clone <repo-url>
Set-Location Doremi-Virtual-Makeup

python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt

npm install
npm run build
```

**macOS (bash/zsh)**

```bash
git clone <repo-url>
cd Doremi-Virtual-Makeup

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

npm install
npm run build
```

### Run

```bash
uvicorn app:app --reload
```

Then open http://localhost:8000.

## Usage

1. Grant camera access.
2. Pick or upload a makeup profile.
3. Tweak intensity / colors in the UI.

### Creating a custom profile

```bash
python capture_profile.py --image path/to/reference.jpg --out my_profile.json
```

## Configuration

Describe key fields in `makeup_profile.json` (lipstick color, blush, eyeshadow, etc.).

## Roadmap

- [ ] More preset looks
- [ ] Multi-face detection

## Troubleshooting

- **numpy/gradio conflict:** pin per `requirements.txt`.
- **Black webcam frame:** check browser camera permissions.

## Acknowledgements

- MediaPipe Face Landmarker
- Gradio / FastAPI
