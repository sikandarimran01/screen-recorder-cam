document.addEventListener("DOMContentLoaded", () => {
  // --- DOM Query Helpers ---
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // --- All DOM Element References ---
  const startBtn = $("#startBtn"), stopBtn = $("#stopBtn"), pauseBtn = $("#pauseBtn"), resumeBtn = $("#resumeBtn");
  const statusMsg = $("#statusMsg");
  const startWebcamBtn = $("#startWebcamBtn");
  const floatingWebcamPreview = $("#floatingWebcamPreview");
  const webcamVideo = $("#webcamVideo");
  const audioInputSelect = $("#audioInput");
  const videoInputSelect = $("#videoInput");
  const previewArea = $("#previewArea"), preview = $("#preview");
  const actionsPanel = $("#actionsPanel");
  const filesPanel = $("#filesPanel"), mediaGrid = $("#mediaGrid");
  const sessionBtn = $("#sessionBtn"), forgetBtn = $("#forgetBtn");
  const clipPanel = $("#clipPanel"), trimSliderEl = $("#trim-slider"), trimStartTime = $("#trim-start-time"), trimEndTime = $("#trim-end-time");
  const emailModal = $("#emailModal"), deleteModal = $("#deleteModal"), forgetSessionModal = $("#forgetSessionModal"), contactModal = $("#contactModal");
  
  // --- App State ---
  let mediaRecorder, chunks = [];
  let screenStream = null, webcamStream = null;
  let currentFile = null, trimSlider = null;

  // =========================================================================
  // HELPER FUNCTIONS 
  // =========================================================================
  const apiFetch = (url, opts) => fetch(url, opts);
  const fullUrl = (path) => `${location.origin}/recordings/${path}`;
  const formatTime = (seconds) => {
    if (isNaN(seconds) || !isFinite(seconds)) return '00:00';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const copy = (text, btn) => {
    navigator.clipboard.writeText(text).then(() => {
      if (!btn) return;
      const prevHTML = btn.innerHTML;
      btn.innerHTML = `<i class="fa-solid fa-check"></i> Copied!`;
      btn.disabled = true;
      setTimeout(() => { btn.innerHTML = prevHTML; btn.disabled = false; }, 1700);
    });
  };
  
  const activateFile = (filename) => {
    if (!filename) {
      currentFile = null;
      previewArea.classList.add("hidden");
      actionsPanel.innerHTML = "";
      return;
    }
    currentFile = filename;
    preview.src = fullUrl(filename);
    previewArea.classList.remove("hidden");
    actionsPanel.innerHTML = `
      <a href="/download/${filename}" class="btn" data-action="download-webm" download><i class="fa-solid fa-download"></i> Download WEBM</a>
      <button class="btn" data-action="download-mp4"><i class="fa-solid fa-file-video"></i> Download MP4</button>
      <button class="btn" data-action="secure-link"><i class="fa-solid fa-lock"></i> Secure Link</button>
      <button class="btn" data-action="public-link"><i class="fa-solid fa-globe"></i> Public Link</button>
      <button class="btn" data-action="email"><i class="fa-solid fa-envelope"></i> Email</button>
      <button class="btn" data-action="clip"><i class="fa-solid fa-scissors"></i> Trim</button>
      <button class="btn danger" data-action="delete"><i class="fa-solid fa-trash-can"></i> Delete</button>`;
    $$(".media-card").forEach(card => card.classList.toggle('selected', card.dataset.filename === filename));
    previewArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  
  const addFileToGrid = (filename) => {
    if ($(`.media-card[data-filename="${filename}"]`)) return;
    const card = document.createElement('div');
    card.className = "media-card";
    card.dataset.filename = filename;
    card.innerHTML = `<video src="${fullUrl(filename)}#t=0.1" preload="metadata"></video><p>${filename.substring(10)}</p>`;
    mediaGrid.prepend(card);
    card.addEventListener('click', () => activateFile(filename));
  };
  
  const renderFiles = (files = []) => {
    mediaGrid.innerHTML = "";
    const hasFiles = files.length > 0;
    if (hasFiles) files.forEach(addFileToGrid);
    sessionBtn.classList.toggle('hidden', !hasFiles);
    forgetBtn.classList.toggle('hidden', !hasFiles);
    filesPanel.classList.toggle('hidden', !hasFiles);
  };

  // =========================================================================
  // CORE RECORDING LOGIC
  // =========================================================================
  
  const stopAllStreams = () => {
    if (screenStream) screenStream.getTracks().forEach(track => track.stop());
    if (webcamStream) webcamStream.getTracks().forEach(track => track.stop());
    screenStream = webcamStream = null;
  };

  const resetRecordingButtons = () => {
    if (!floatingWebcamPreview.classList.contains("hidden")) {
      statusMsg.textContent = "Webcam preview is active. Ready to record.";
      startBtn.textContent = "Start Recording Screen + Mic";
      startBtn.onclick = () => startRecording(true);
    } else {
      statusMsg.textContent = "";
      startBtn.textContent = "Start Recording (Screen Only)";
      startBtn.onclick = () => startRecording(false);
    }
    startBtn.classList.remove("hidden");
    startWebcamBtn.classList.remove("hidden");
    pauseBtn.classList.add("hidden");
    resumeBtn.classList.add("hidden");
    stopBtn.classList.add("hidden");
  };

  const startRecording = async (withWebcam) => {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: true
      });

      const finalStream = new MediaStream();
      screenStream.getVideoTracks().forEach(track => finalStream.addTrack(track));
      screenStream.getAudioTracks().forEach(track => finalStream.addTrack(track));
      
      if (withWebcam && webcamStream && webcamStream.getAudioTracks().length > 0) {
        webcamStream.getAudioTracks().forEach(track => finalStream.addTrack(track));
      }
      
      mediaRecorder = new MediaRecorder(finalStream, { mimeType: "video/webm; codecs=vp8,opus" });
      chunks = [];
      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        const fd = new FormData();
        fd.append("video", blob, "recording.webm");
        statusMsg.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading...`;
        
        stopAllStreams();

        const res = await apiFetch("/upload", { method: "POST", body: fd }).then(r => r.json());
        if (res.status === "ok") {
          statusMsg.textContent = `✅ Recording saved!`;
          addFileToGrid(res.filename);
          activateFile(res.filename);
        } else {
          statusMsg.textContent = "❌ Upload failed: " + res.error;
        }
        resetRecordingButtons();
      };

      mediaRecorder.start();
      statusMsg.textContent = "🎬 Recording...";
      
      screenStream.getVideoTracks()[0].onended = () => stopBtn.click();
      
      startBtn.classList.add("hidden");
      startWebcamBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");
      pauseBtn.classList.remove("hidden");

    } catch (err) {
      if (err.name === 'NotAllowedError') statusMsg.textContent = "🤔 Recording cancelled.";
      else {
        statusMsg.textContent = "❌ Could not start recording.";
        console.error("Recording error:", err);
      }
      stopAllStreams();
      resetRecordingButtons();
    }
  };

  async function populateMediaDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioInputSelect.innerHTML = '';
      videoInputSelect.innerHTML = '';
      devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Unknown ${device.kind}`;
        if (device.kind === 'audioinput') audioInputSelect.appendChild(option);
        else if (device.kind === 'videoinput') videoInputSelect.appendChild(option);
      });
    } catch (err) {
      console.error("Error enumerating devices:", err);
    }
  }

  async function getWebcamAndMicStream() {
    if (webcamStream) webcamStream.getTracks().forEach(track => track.stop());
    try {
      const constraints = {
        video: { deviceId: videoInputSelect.value ? { exact: videoInputSelect.value } : undefined },
        audio: { deviceId: audioInputSelect.value ? { exact: audioInputSelect.value } : undefined },
      };
      webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
      webcamVideo.srcObject = webcamStream;
    } catch (err) {
      console.error("Error getting webcam/mic stream:", err);
      statusMsg.textContent = "❌ Could not access webcam/mic.";
      webcamStream = null;
    }
  }
  
  // =========================================================================
  // EVENT LISTENERS AND INITIALIZATION
  // =========================================================================

  startBtn.onclick = () => startRecording(false);
  startWebcamBtn.onclick = async () => {
    stopAllStreams(); 
    statusMsg.textContent = "⏳ Setting up devices...";
    floatingWebcamPreview.classList.remove("hidden");
    await populateMediaDevices();
    await getWebcamAndMicStream();
    resetRecordingButtons();
  };

  stopBtn.onclick = () => { if (mediaRecorder?.state !== "inactive") mediaRecorder.stop(); };
  pauseBtn.onclick = () => { mediaRecorder.pause(); statusMsg.textContent = "⏸ Paused"; pauseBtn.classList.add("hidden"); resumeBtn.classList.remove("hidden"); };
  resumeBtn.onclick = () => { mediaRecorder.resume(); statusMsg.textContent = "🎬 Recording…"; resumeBtn.classList.add("hidden"); pauseBtn.classList.remove("hidden"); };

  audioInputSelect.onchange = getWebcamAndMicStream;
  videoInputSelect.onchange = getWebcamAndMicStream;
  
  let isDragging = false, offsetX, offsetY;
  floatingWebcamPreview.onmousedown = (e) => {
    if (e.target.tagName === 'VIDEO') {
        isDragging = true;
        offsetX = e.clientX - floatingWebcamPreview.offsetLeft;
        offsetY = e.clientY - floatingWebcamPreview.offsetTop;
        floatingWebcamPreview.style.transition = 'none';
    }
  };
  document.onmousemove = (e) => {
    if(isDragging) {
        floatingWebcamPreview.style.left = `${e.clientX - offsetX}px`;
        floatingWebcamPreview.style.top = `${e.clientY - offsetY}px`;
    }
  };
  document.onmouseup = () => {
    isDragging = false;
    floatingWebcamPreview.style.transition = '';
  };
  
  (async () => {
      const { files = [] } = await apiFetch("/session/files").then(r => r.json()).catch(() => ({}));
      renderFiles(files.reverse());
  })();

});