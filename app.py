import os, datetime, subprocess, json, random, string, uuid
from dotenv import load_dotenv 
from flask import (
    Flask, render_template, request, jsonify,
    send_from_directory, make_response
)
from flask_mail import Mail, Message
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

print("DEBUG: app.py is being loaded!")

load_dotenv() 

app = Flask(__name__) # Only one app = Flask(__name__) needed here

# --- NEW: Explicit Logging Configuration ---
import logging
app.logger.setLevel(logging.INFO)
handler = logging.StreamHandler()
handler.setLevel(logging.INFO)
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
handler.setFormatter(formatter)
if not app.logger.handlers:
    app.logger.addHandler(handler)
# --- END NEW Logging Configuration ---

# --- App Configuration ---
app.config.update(
    MAIL_SERVER="smtp.gmail.com",
    MAIL_PORT=587,
    MAIL_USE_TLS=True,
    MAIL_USERNAME=os.getenv("MAIL_USERNAME"),
    MAIL_PASSWORD=os.getenv("MAIL_PASSWORD"),
    MAIL_DEFAULT_SENDER=("GrabScreen", os.getenv("MAIL_USERNAME")),
)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "dev-secret")

# --- App Initialization ---
serializer = URLSafeTimedSerializer(app.config["SECRET_KEY"])
TOKEN_EXPIRY_SECONDS = 15 * 60
mail = Mail(app)

# --- Dynamic Path Configuration based on OS ---
IS_WINDOWS = os.name == 'nt' # 'nt' for Windows, 'posix' for Linux/macOS

if IS_WINDOWS:
    # --- Paths for Windows Local Development ---
    # IMPORTANT: VERIFY THESE PATHS ON YOUR MACHINE!
    # RECDIR should be where you want recordings to be saved locally
    RECDIR = "E:\\GrabScreen_Recordings" # <--- Ensure this path exists and is accessible locally
    # FFMPEG_DIR should be the path to the 'bin' folder containing ffmpeg.exe
    FFMPEG_DIR = "C:\\ffmpeg-7.1.1-essentials_build\\bin" # <--- e.g., "C:\\ffmpeg-7.0.2-full_build\\bin" (VERIFY!)
    FFMPEG_PATH = os.path.join(FFMPEG_DIR, "ffmpeg.exe") # Add .exe for Windows
else:
    # --- Paths for Linux/Render Deployment ---
    # RECDIR must point to your Render Persistent Disk mount path + a subdirectory for your files
    RECDIR = "/var/data/recordings" # <--- CHANGED THIS TO USE RENDER'S PERSISTENT DISK
    # On Render, FFmpeg is usually installed system-wide (e.g., via apt-get).
    # If it's in the system's PATH, just "ffmpeg" is enough.
    FFMPEG_PATH = "ffmpeg" # Assumes 'ffmpeg' is in the system's PATH on Render
    # If you put a static ffmpeg build on the persistent disk, the path would be:
    # FFMPEG_PATH = "/var/data/ffmpeg-7.0.2-amd64-static/ffmpeg" 
    # (assuming you extracted 'ffmpeg-7.0.2-amd64-static' into /var/data/)

MP4_DIR = os.path.join(RECDIR, "mp4_converted")

# Ensure directories exist (will now create them inside /var/data/recordings)
os.makedirs(RECDIR, exist_ok=True)
os.makedirs(MP4_DIR, exist_ok=True) 

# --- FFmpeg Path Verification (for better debugging) ---
# This check is more effective for absolute paths.
# If FFMPEG_PATH is just "ffmpeg", os.path.exists will return False, which is fine
# because subprocess.run will search the system's PATH.
if os.path.isabs(FFMPEG_PATH) and not os.path.exists(FFMPEG_PATH):
    app.logger.error(f"FATAL ERROR: FFmpeg executable not found at '{FFMPEG_PATH}'. Please verify the path and installation steps for this environment.")
elif not os.path.isabs(FFMPEG_PATH):
    app.logger.info(f"FFmpeg path '{FFMPEG_PATH}' is relative/assumed in PATH. Not performing direct file existence check.")


LINKS_FILE = "public_links.json"
SESSIONS_FILE = "user_sessions.json"

# --- Helper Functions ---
def load_json(file_path):
    if os.path.exists(file_path):
        with open(file_path, "r") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                app.logger.warning(f"Corrupt or empty JSON file: {file_path}. Returning empty dict.")
                return {} # Return empty dict if file is corrupt or empty
    return {}

def save_json(data, file_path):
    with open(file_path, "w") as f:
        json.dump(data, f, indent=2)

public_links = load_json(LINKS_FILE)
user_sessions = load_json(SESSIONS_FILE)

# ─────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html", year=datetime.datetime.now().year)

@app.route("/upload", methods=["POST"])
def upload():
    video_file = request.files.get("video")
    if not video_file:
        return jsonify({"status": "fail", "error": "No file"}), 400

    fname = datetime.datetime.now().strftime("recording_%Y%m%d_%H%M%S.webm")
    save_path = os.path.join(RECDIR, fname)

    try:
        video_file.save(save_path)
    except Exception as e:
        app.logger.error(f"Failed to save uploaded video file: {e}")
        return jsonify({"status": "fail", "error": str(e)}), 500

    token = request.cookies.get("magic_token")
    if not token or token not in user_sessions:
        token = uuid.uuid4().hex[:16]
        user_sessions[token] = []

    user_sessions[token].append(fname)
    save_json(user_sessions, SESSIONS_FILE)

    response = jsonify({"status": "ok", "filename": fname})
    response.set_cookie("magic_token", token, max_age=365*24*60*60)
    return response

@app.route("/session/files")
def session_files():
    token = request.cookies.get("magic_token")
    if not token or token not in user_sessions:
        return jsonify({"status": "empty", "files": []})
    
    # Ensure all files in the session actually exist on disk
    existing_files = [f for f in user_sessions.get(token, []) if os.path.exists(os.path.join(RECDIR, f))]
    if len(existing_files) != len(user_sessions.get(token, [])):
        user_sessions[token] = existing_files
        save_json(user_sessions, SESSIONS_FILE)

    return jsonify({"status": "ok", "files": existing_files})

@app.route("/session/forget", methods=["POST"])
def forget_session():
    token = request.cookies.get("magic_token")
    if token and token in user_sessions:
        del user_sessions[token]
        save_json(user_sessions, SESSIONS_FILE)
    response = jsonify({"status": "ok"})
    response.set_cookie("magic_token", "", expires=0)
    return response

@app.route("/clip/<orig>", methods=["POST"])
def clip(orig):
    try:
        data = request.get_json(force=True)
        start = float(data["start"])
        end = float(data["end"])
    except Exception as e:
        return jsonify({"status": "fail", "error": f"Invalid JSON: {str(e)}"}), 400

    if start >= end:
        return jsonify({"status": "fail", "error": "Start time must be less than end time"}), 400

    in_path = os.path.join(RECDIR, orig)
    if not os.path.exists(in_path):
        return jsonify({"status": "fail", "error": "Original file not found"}), 404

    clip_name = datetime.datetime.now().strftime("clip_%Y%m%d_%H%M%S.webm")
    out_path = os.path.join(RECDIR, clip_name)
    duration = end - start

    cmd = [
        FFMPEG_PATH, "-hide_banner", "-loglevel", "error",
        "-ss", str(start), "-t", str(duration), "-i", in_path,
        "-c:v", "libvpx-vp9", "-b:v", "1M",
        "-c:a", "libopus", "-b:a", "128k",
        "-y", out_path
    ]
    try:
        # For cross-platform, it's safer to rely on FFMPEG_PATH being an absolute path or in system PATH.
        subprocess.run(cmd, check=True, capture_output=True, text=True) 
        token = request.cookies.get("magic_token")
        if token and token in user_sessions:
            user_sessions[token].append(clip_name)
            save_json(user_sessions, SESSIONS_FILE)
        return jsonify({"status": "ok", "clip": clip_name})
    except subprocess.CalledProcessError as e:
        app.logger.error(f"FFmpeg clipping failed for {orig}: {e.stderr}")
        return jsonify({"status": "fail", "error": e.stderr}), 500
    except FileNotFoundError:
        app.logger.error(f"FFmpeg command not found during clip operation. Path used: {FFMPEG_PATH}")
        return jsonify({"status": "fail", "error": "Server error: FFmpeg not found for video clipping."}), 500
    except Exception as e:
        app.logger.error(f"Unexpected error during clipping for {orig}: {e}")
        return jsonify({"status": "fail", "error": f"An unexpected error occurred during clipping: {str(e)}"}), 500

@app.route("/recordings/<fname>", endpoint="get_recording_webm")
def recordings(fname):
    # This serves WEBM files for preview and default download
    return send_from_directory(RECDIR, fname, mimetype="video/webm")

@app.route("/download/<fname>", endpoint="download_webm")
def download(fname):
    # This is the default WEBM download
    return send_from_directory(RECDIR, fname, as_attachment=True, mimetype="video/webm")

@app.route("/download/mp4/<filename>", endpoint="download_mp4")
def download_mp4(filename):
    app.logger.info(f"DEBUG: Entering download_mp4 function for {filename}")

    if not filename.endswith(".webm"):
        return jsonify({"status": "fail", "error": "Invalid file type. Only .webm allowed for conversion input."}), 400

    webm_path = os.path.join(RECDIR, filename)
    if not os.path.exists(webm_path):
        app.logger.error(f"❌ Original WEBM file not found at path: {webm_path}")
        return jsonify({"status": "fail", "error": "Original WEBM file not found"}), 404

    mp4_filename = filename.replace(".webm", ".mp4")
    mp4_path = os.path.join(MP4_DIR, mp4_filename)

    # Check if MP4 already exists and is not empty
    if os.path.exists(mp4_path) and os.path.getsize(mp4_path) > 0:
        app.logger.info(f"Serving existing MP4: {mp4_filename}")
        return send_from_directory(MP4_DIR, mp4_filename, as_attachment=True, mimetype="video/mp4")

    app.logger.info(f"Attempting to convert {filename} to MP4...")

    ffmpeg_cmd = [
        FFMPEG_PATH,
        "-y",                 # Overwrite output file without asking
        "-i", webm_path,      # Input WEBM file
        "-r", "30",           # Force output framerate to 30 FPS
        "-c:v", "libx264",
        "-preset", "ultrafast", # Faster encoding, lower quality/larger file for quick conversions
        "-crf", "28",         # Constant Rate Factor (0-51), higher means lower quality/smaller file
        "-c:a", "aac",
        "-b:a", "64k",
        mp4_path,
    ]

    app.logger.info(f"DEBUG: FFmpeg command list: {ffmpeg_cmd}")
    app.logger.info(f"DEBUG: Checking FFMPEG_PATH existence: {os.path.exists(FFMPEG_PATH)}")

    try:
        result = subprocess.run(ffmpeg_cmd, check=True, capture_output=True, text=True, timeout=120) # Increased timeout to 120s

        app.logger.info(f"DEBUG: subprocess.run completed. Return code: {result.returncode}")
        app.logger.info(f"✅ FFmpeg stdout for {filename}:\n{result.stdout}")
        if result.stderr:
            app.logger.warning(f"⚠️ FFmpeg stderr (might be warnings) for {filename}:\n{result.stderr}")

        if not os.path.exists(mp4_path) or os.path.getsize(mp4_path) == 0:
            app.logger.error(f"❌ Converted MP4 is 0 bytes or missing after conversion: {mp4_path}")
            return jsonify({
                "status": "fail",
                "error": "Converted video is empty or corrupt. Try re-uploading or trimming the recording."
            }), 500

        app.logger.info(f"✅ Successfully converted and serving new MP4: {mp4_filename}")
        return send_from_directory(MP4_DIR, mp4_filename, as_attachment=True, mimetype="video/mp4")

    except subprocess.TimeoutExpired as e:
        app.logger.error(f"❌ FFmpeg conversion timed out for {filename} after {e.timeout} seconds. Stderr from partial output: {e.stderr}")
        return jsonify({"status": "fail", "error": f"Video conversion timed out ({e.timeout}s). Try a shorter clip or simpler conversion. Server might be under heavy load or resource constraints."}), 500
    except subprocess.CalledProcessError as e:
        app.logger.error(f"❌ FFmpeg conversion failed for {filename} with error code {e.returncode}:\n{e.stderr}")
        return jsonify({"status": "fail", "error": f"Video conversion failed: {e.stderr}"}), 500
    except FileNotFoundError:
        app.logger.error(f"❌ FFmpeg command not found. Ensure FFmpeg is installed on the server at '{FFMPEG_PATH}' or is in the system's PATH.")
        return jsonify({"status": "fail", "error": "Server error: FFmpeg not found for video conversion."}), 500
    except Exception as e:
        app.logger.error(f"❌ Unexpected error during conversion for {filename}: {e}")
        return jsonify({"status": "fail", "error": f"An unexpected error occurred during conversion: {str(e)}"}), 500

@app.route("/link/secure/<fname>", endpoint="generate_secure_link")
def generate_secure_link(fname):
    if not os.path.exists(os.path.join(RECDIR, fname)):
        return jsonify({"status": "fail", "error": "file not found"}), 404

    token = serializer.dumps(fname)
    url = request.url_root.rstrip("/") + "/secure/" + token
    return jsonify({"status": "ok", "url": url})

@app.route("/secure/<token>", endpoint="secure_download")
def secure_download(token):
    try:
        fname = serializer.loads(token, max_age=TOKEN_EXPIRY_SECONDS)
    except SignatureExpired:
        return "⏳ Link expired.", 410
    except BadSignature:
        return "❌ Invalid link.", 400
    return send_from_directory(RECDIR, fname)

@app.route("/link/public/<fname>", methods=["GET"], endpoint="get_or_create_public_link")
def get_or_create_public_link(fname):
    global public_links
    public_links = load_json(LINKS_FILE)
    if not os.path.exists(os.path.join(RECDIR, fname)):
        return jsonify({"status": "fail", "error": "File not found"}), 404

    for token, f in public_links.items():
        if f == fname:
            url = request.url_root.rstrip("/") + "/public/" + token
            return jsonify({"status": "ok", "url": url, "isNew": False})

    token = ''.join(random.choices(string.ascii_letters + string.digits, k=12))
    public_links[token] = fname
    save_json(public_links, LINKS_FILE)
    return jsonify({"status": "ok", "url": request.url_root.rstrip("/") + "/public/" + token, "isNew": True})

@app.route("/link/public/<fname>", methods=["DELETE"], endpoint="delete_public_link")
def delete_public_link(fname):
    global public_links
    public_links = load_json(LINKS_FILE)
    removed = False
    for token, f in list(public_links.items()):
        if f == fname:
            del public_links[token]
            removed = True
    if removed:
        save_json(public_links, LINKS_FILE)
        return jsonify({"status": "ok", "message": "Link removed"})
    return jsonify({"status": "fail", "error": "No public link found"}), 404

@app.route("/public/<token>", endpoint="serve_public_file")
def serve_public_file(token):
    public_links = load_json(LINKS_FILE)
    fname = public_links.get(token)
    if not fname or not os.path.exists(os.path.join(RECDIR, fname)):
        return "❌ Invalid or expired link.", 404
    return send_from_directory(RECDIR, fname)

@app.route("/send_email", methods=["POST"], endpoint="send_email_route")
def send_email():
    data = request.get_json()
    if not app.config.get("MAIL_USERNAME") or not app.config.get("MAIL_PASSWORD"):
        return jsonify({"status": "fail", "error": "Mail service is not configured on the server."}), 503

    try:
        msg = Message(
            "GrabScreen recording",
            recipients=[data["to"]],
            body=f"Hi,\n\nHere is your recording:\n{data['url']}\n\nEnjoy!"
        )
        mail.send(msg)
        return jsonify({"status": "ok"})
    except Exception as e:
        app.logger.error(f"Mail sending failed: {e}")
        return jsonify({"status": "fail", "error": "Could not send the email."}), 500

@app.route("/debug/files", endpoint="list_debug_files")
def list_files():
    # Allow debug on Render for convenience if RENDER_EXTERNAL_URL is set
    if os.getenv("FLASK_ENV") == "development" or os.getenv("RENDER_EXTERNAL_URL"): 
        webm_files = sorted(os.listdir(RECDIR))
        mp4_files = sorted(os.listdir(MP4_DIR))
        return f"<h2>WEBM Files ({RECDIR}):</h2><pre>{'<br>'.join(webm_files)}</pre>" \
               f"<h2>MP4 Files ({MP4_DIR}):</h2><pre>{'<br>'.join(mp4_files)}</pre>"
    return "Not available in production", 404

@app.route("/delete/<filename>", methods=["POST"], endpoint="delete_file_route")
def delete_file(filename):
    if ".." in filename or filename.startswith("/"):
        return jsonify({"status": "fail", "error": "Invalid filename"}), 400

    file_path = os.path.join(RECDIR, filename)
    mp4_file_path = os.path.join(MP4_DIR, filename.replace(".webm", ".mp4"))
    
    if not os.path.abspath(file_path).startswith(os.path.abspath(RECDIR)):
        return jsonify({"status": "fail", "error": "Access denied"}), 403

    if not os.path.exists(file_path):
        return jsonify({"status": "fail", "error": "File not found"}), 404
    try:
        os.remove(file_path)
        if os.path.exists(mp4_file_path):
            os.remove(mp4_file_path)
            app.logger.info(f"Deleted corresponding MP4 file: {mp4_file_path}")

        token = request.cookies.get("magic_token")
        if token and token in user_sessions and filename in user_sessions[token]:
            user_sessions[token].remove(filename)
            save_json(user_sessions, SESSIONS_FILE)
        
        global public_links
        public_links = load_json(LINKS_FILE)
        for t, f in list(public_links.items()):
            if f == filename:
                del public_links[t]
        save_json(public_links, LINKS_FILE)

        return jsonify({"status": "ok", "message": f"{filename} deleted"})
    except Exception as e:
        app.logger.error(f"File deletion failed: {e}")
        return jsonify({"status": "fail", "error": "Could not delete the file."}), 500

@app.route("/contact_us", methods=["POST"], endpoint="contact_us_route")
def contact_us():
    if not app.config.get("MAIL_USERNAME") or not app.config.get("MAIL_PASSWORD"):
        return jsonify({"status": "fail", "error": "Mail service is not configured on the server."}), 503

    data = request.get_json()
    from_email = data.get("from_email")
    subject = data.get("subject")
    message_body = data.get("message")

    if not all([from_email, subject, message_body]):
        return jsonify({"status": "fail", "error": "Please fill out all fields."}), 400

    try:
        msg = Message(
            subject=f"[GrabScreen Contact] {subject}",
            recipients=[app.config["MAIL_USERNAME"]], 
            body=f"You have a new message from: {from_email}\n\n---\n\n{message_body}",
            reply_to=from_email
        )
        mail.send(msg)
        return jsonify({"status": "ok", "message": "Your message has been sent!"})
    except Exception as e:
        app.logger.error(f"Contact form mail sending failed: {e}")
        return jsonify({"status": "fail", "error": "Sorry, an error occurred and the message could not be sent."}), 500


if __name__ == "__main__":
    app.run(debug=(os.getenv("FLASK_ENV") == "development"), port=5001)