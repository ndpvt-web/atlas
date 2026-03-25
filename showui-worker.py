#!/usr/bin/env python3.11
"""
ShowUI-2B Persistent Worker for ATLAS Agent
Communicates via stdin/stdout JSON lines.

Protocol:
  Input:  {"id": "abc", "image": "/path/to/img.jpg", "query": "the submit button"}
  Output: {"id": "abc", "coords": [0.49, 0.45], "pixels": [706, 405], "text": "...", "elapsed_ms": 423}

Special commands:
  {"id": "x", "cmd": "health"}  -> {"id": "x", "status": "ok", "model_loaded": true}
  {"id": "x", "cmd": "warmup"} -> loads model if not loaded
"""
import sys
import json
import time
import re
import os

# Force unbuffered output
sys.stdout = os.fdopen(sys.stdout.fileno(), 'w', buffering=1)
sys.stderr = os.fdopen(sys.stderr.fileno(), 'w', buffering=1)

MODEL_ID = "mlx-community/ShowUI-2B-bf16-4bit"
MAX_IMAGE_DIM = 1440  # Resize images larger than this to avoid OOM on M1 8GB

SYSTEM_GROUNDING = (
    "Based on the screenshot of the page, I give a text description and you give "
    "its corresponding location. The coordinate represents a clickable location "
    "[x, y] for an element, which is a relative coordinate on the screenshot, "
    "scaled from 0 to 1."
)

model = None
processor = None


def log(msg):
    print(f"[ShowUI-Worker] {msg}", file=sys.stderr, flush=True)


def load_model():
    global model, processor
    if model is not None:
        return
    log("Loading ShowUI-2B model...")
    t0 = time.time()
    from mlx_vlm import load
    model, processor = load(MODEL_ID)
    log(f"Model loaded in {time.time() - t0:.1f}s")


def resize_if_needed(image_path):
    """Resize image to max dimension if too large. Returns path to (possibly temp) image."""
    from PIL import Image
    img = Image.open(image_path)
    w, h = img.size

    if w <= MAX_IMAGE_DIM and h <= MAX_IMAGE_DIM:
        return image_path, w, h

    # Scale down to MAX_IMAGE_DIM on the longest side
    if w >= h:
        new_w = MAX_IMAGE_DIM
        new_h = int(h * MAX_IMAGE_DIM / w)
    else:
        new_h = MAX_IMAGE_DIM
        new_w = int(w * MAX_IMAGE_DIM / h)

    resized = img.resize((new_w, new_h), Image.LANCZOS)
    tmp_path = f"/tmp/showui-resize-{os.getpid()}.jpg"
    resized.save(tmp_path, "JPEG", quality=85)
    return tmp_path, new_w, new_h


def parse_coords(text):
    """Extract [x, y] coordinates from ShowUI response."""
    # Look for [0.49, 0.2] or (0.49, 0.2) patterns
    match = re.search(r'[\[\(]\s*([\d.]+)\s*,\s*([\d.]+)\s*[\]\)]', text)
    if match:
        x, y = float(match.group(1)), float(match.group(2))
        # Sanity check: coords should be in 0-1 range
        if 0 <= x <= 1 and 0 <= y <= 1:
            return [x, y]
    return None


def process_query(req):
    """Process a grounding query."""
    load_model()

    from mlx_vlm import generate

    image_path = req.get("image", "")
    query = req.get("query", "")
    screen_w = req.get("screen_w", 1440)
    screen_h = req.get("screen_h", 900)

    if not image_path or not os.path.exists(image_path):
        return {"error": f"Image not found: {image_path}"}

    # Resize if needed to avoid OOM
    resized_path, img_w, img_h = resize_if_needed(image_path)

    prompt = SYSTEM_GROUNDING + "\n" + query

    t0 = time.time()
    result = generate(
        model, processor,
        prompt,
        resized_path,
        max_tokens=128,
        verbose=False,
    )
    elapsed_ms = round((time.time() - t0) * 1000)

    text = result.text if hasattr(result, 'text') else str(result)
    coords = parse_coords(text)

    response = {
        "text": text.strip(),
        "elapsed_ms": elapsed_ms,
        "image_size": [img_w, img_h],
    }

    if coords:
        response["coords"] = coords
        # Convert to screen pixels
        px = round(coords[0] * screen_w)
        py = round(coords[1] * screen_h)
        response["pixels"] = [px, py]

    # Clean up temp file
    if resized_path != image_path:
        try:
            os.unlink(resized_path)
        except:
            pass

    return response


def main():
    # Send ready signal
    print(json.dumps({"type": "ready", "model": MODEL_ID}), flush=True)
    log("Worker started, waiting for queries on stdin...")

    # Pre-load model
    try:
        load_model()
        print(json.dumps({"type": "model_loaded"}), flush=True)
    except Exception as e:
        log(f"Failed to load model: {e}")
        print(json.dumps({"type": "model_error", "error": str(e)}), flush=True)

    # Main loop: read JSON lines from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON: {e}"}), flush=True)
            continue

        req_id = req.get("id", "unknown")

        # Handle special commands
        cmd = req.get("cmd")
        if cmd == "health":
            print(json.dumps({
                "id": req_id,
                "status": "ok",
                "model_loaded": model is not None,
            }), flush=True)
            continue
        elif cmd == "warmup":
            try:
                load_model()
                print(json.dumps({"id": req_id, "status": "ok"}), flush=True)
            except Exception as e:
                print(json.dumps({"id": req_id, "error": str(e)}), flush=True)
            continue

        # Process grounding query
        try:
            result = process_query(req)
            result["id"] = req_id
            print(json.dumps(result), flush=True)
        except Exception as e:
            log(f"Query error: {e}")
            print(json.dumps({"id": req_id, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
