# cleanup.py
# This script automatically deletes old video files to save disk space.
# Place this file in the root directory of your project.

import os
import time
from datetime import datetime

# --- CONFIGURATION ---
# These paths must EXACTLY match the paths in your app.py
RECDIR = "/var/data/recordings"
MP4_DIR = os.path.join(RECDIR, "mp4_converted")

# Files older than this will be deleted.
# 24 hours = 24 * 60 * 60 = 86400 seconds
MAX_AGE_SECONDS = 24 * 60 * 60 

def cleanup_directory(directory_path, max_age):
    """Scans a directory and deletes files older than max_age."""
    print(f"--- Scanning directory: {directory_path} ---")
    if not os.path.exists(directory_path):
        print(f"Directory not found. Skipping.")
        return

    now = time.time()
    files_deleted = 0
    
    try:
        for entry in os.scandir(directory_path):
            # We only want to delete files, not directories like 'mp4_converted'
            if entry.is_file():
                try:
                    file_mod_time = entry.stat().st_mtime
                    if (now - file_mod_time) > max_age:
                        file_path = entry.path
                        file_age_hours = (now - file_mod_time) / 3600
                        print(f"Deleting old file: {file_path} (Age: {file_age_hours:.1f} hours)")
                        os.remove(file_path)
                        files_deleted += 1
                except Exception as e:
                    print(f"Error processing file {entry.name}: {e}")
    except Exception as e:
         print(f"Error scanning directory {directory_path}: {e}")

    print(f"Deleted {files_deleted} old files from {directory_path}.\n")

if __name__ == "__main__":
    print(f"Starting cleanup job at {datetime.now()}. Max file age: {MAX_AGE_SECONDS / 3600:.1f} hours.")
    
    # IMPORTANT: Clean the mp4 directory FIRST, then the main recordings directory.
    cleanup_directory(MP4_DIR, MAX_AGE_SECONDS)
    cleanup_directory(RECDIR, MAX_AGE_SECONDS)
    
    print("Cleanup job finished.")