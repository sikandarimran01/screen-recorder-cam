document.addEventListener("DOMContentLoaded", () => {
  // --- DOM Query Helpers ---
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // --- UI & API Helpers ---
  const copy = (text, btn) => {
    navigator.clipboard.writeText(text).then(() => {
      if (!btn) return;
      const prevHTML = btn.innerHTML;
      btn.innerHTML = `<i class="fa-solid fa-check"></i> Copied!`;
      btn.disabled = true;
      setTimeout(() => { btn.innerHTML = prevHTML; btn.disabled = false; }, 1700);
    });
  };
  
  const apiFetch = (url, opts = {}) => fetch(url, opts);
  const fullUrl = (f) => `${location.origin}/recordings/${f}`;
  
  // --- All DOM Element References ---
  const recorderView = $("#recorderView"), privacyView = $("#privacyView"), contactView = $("#contactView");
  const startBtn = $("#startBtn"), stopBtn = $("#stopBtn"), pauseBtn = $("#pauseBtn"), resumeBtn = $("#resumeBtn");
  const statusMsg = $("#statusMsg"), previewArea = $("#previewArea"), preview = $("#preview");
  const actionsPanel = $("#actionsPanel"), clipPanel = $("#clipPanel"), filesPanel = $("#filesPanel");
  const mediaGrid = $("#mediaGrid"), sessionBtn = $("#sessionBtn"), forgetBtn = $("#forgetBtn");
  const trimSliderEl = $("#trim-slider"), trimStartTime = $("#trim-start-time"), trimEndTime = $("#trim-end-time");
  const deleteModal = $("#deleteModal"), fileToDeleteEl = $("#fileToDelete"), deleteConfirmBtn = $("#deleteConfirm"), deleteCancelBtn = $("#deleteCancel");
  const emailModal = $("#emailModal"), forgetSessionModal = $("#forgetSessionModal");

  // NEW: Webcam related DOM elements
  const startWebcamBtn = $("#startWebcamBtn");
  const webcamCaptureArea = $("#webcamCaptureArea");
  const audioInputSelect = $("#audioInput");
  const videoInputSelect = $("#videoInput");
  const webcamPreview = $("#webcamPreview"); // This will show the screen AND webcam combined during recording setup
  const recordingCanvas = $("#recordingCanvas");
  const webcamOverlayControls = $("#webcamOverlayControls");
  const toggleWebcamOverlayBtn = $("#toggleWebcamOverlay");
  const moveWebcamOverlayBtn = $("#moveWebcamOverlay");
  const resizeWebcamOverlayBtn = $("#resizeWebcamOverlay");

  // --- App State ---
  let mediaRecorder, chunks = [], currentFile = null, trimSlider = null;
  // NEW: Webcam related states
  let screenStream = null;
  let webcamStream = null;
  let audioContext = null;
  let animationFrameId = null; // For canvas drawing loop
  let isWebcamOverlayVisible = true;
  let webcamPosition = { x: 0.7, y: 0.7 }; // Normalized positions (0 to 1) for bottom-right
  let webcamSize = { width: 0.25, height: 0.25 }; // Normalized size (0 to 1) for 25% width/height
  let webcamAspectRatio = 16 / 9; // Default to common aspect ratio, will be updated from stream

  // NEW: Persistent video elements for canvas drawing
  let screenVideoElementForCanvas = null;
  let webcamVideoElementForCanvas = null;

  // Drag & Resize state
  let isDragging = false;
  let isResizing = false;
  let dragOffsetX, dragOffsetY; // Offset from mouse to element's top-left corner
  let initialWebcamWidth, initialWebcamHeight; // For resizing

  // ===================================================================
  // CORE FUNCTIONS
  // ===================================================================

  const showView = (viewName) => {
    recorderView.classList.add("hidden");
    privacyView.classList.add("hidden");
    contactView.classList.add("hidden");

    if (viewName === 'recorder') recorderView.classList.remove("hidden");
    if (viewName === 'privacy') privacyView.classList.remove("hidden");
    if (viewName === 'contact') contactView.classList.remove("hidden");
  };

  const formatTime = (seconds) => {
    if (isNaN(seconds) || !isFinite(seconds)) return '00:00';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const addFileToGrid = (filename) => {
    if ($(`.media-card[data-filename="${filename}"]`)) return;
    const card = document.createElement("div");
    card.className = "media-card";
    card.dataset.filename = filename;
    card.innerHTML = `<video src="${fullUrl(filename)}#t=0.1" preload="metadata"></video><p>${filename.substring(10)}</p>`;
    mediaGrid.prepend(card);
    card.addEventListener("click", () => activateFile(filename));
  };
  
  const renderFiles = (files = []) => {
    mediaGrid.innerHTML = "";
    const hasFiles = files.length > 0;
    if (hasFiles) files.forEach(addFileToGrid);
    sessionBtn.classList.toggle("hidden", !hasFiles);
    forgetBtn.classList.toggle("hidden", !hasFiles);
    filesPanel.classList.toggle("hidden", !hasFiles);
  };
  
  const activateFile = (filename) => {
    if (!filename) {
      currentFile = null;
      previewArea.classList.add("hidden");
      actionsPanel.innerHTML = ""; // Clear existing buttons
      return;
    }
    currentFile = filename;
    preview.src = fullUrl(filename); 
    previewArea.classList.remove("hidden");
    
    // Re-render the actions panel with the correct href for download-webm
    actionsPanel.innerHTML = `
      <a href="/download/${filename}" class="btn" data-action="download-webm" download><i class="fa-solid fa-download"></i> Download WEBM</a>
      <button class="btn" data-action="download-mp4"><i class="fa-solid fa-file-video"></i> Download MP4</button>
      <button class="btn" data-action="secure-link"><i class="fa-solid fa-lock"></i> Secure Link</button>
      <button class="btn" data-action="public-link"><i class="fa-solid fa-globe"></i> Public Link</button>
      <button class="btn" data-action="email"><i class="fa-solid fa-envelope"></i> Email</button>
      <button class="btn" data-action="clip"><i class="fa-solid fa-scissors"></i> Trim</button>
      <button class="btn danger" data-action="delete"><i class="fa-solid fa-trash-can"></i> Delete</button>
    `;
    
    $$(".media-card").forEach(card => card.classList.toggle("selected", card.dataset.filename === filename));
    previewArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  
  const createSlider = (videoDuration) => {
    if (trimSlider) { trimSlider.destroy(); }
    const startValues = [0, Math.min(10, videoDuration)];
    trimSlider = noUiSlider.create(trimSliderEl, {
      start: startValues, connect: true, range: { min: 0, max: videoDuration }, step: 0.1,
    });
    trimSlider.on('update', (values) => {
      const [start, end] = values.map(v => parseFloat(v));
      trimStartTime.textContent = formatTime(start);
      trimEndTime.textContent = formatTime(end);
    });
    trimSlider.on('slide', (values, handle) => { preview.currentTime = parseFloat(values[handle]); });
    clipPanel.classList.remove("hidden");
    clipPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const setupTrimSlider = () => {
    statusMsg.textContent = "⏳ Initializing trimmer...";
    if (preview.readyState >= 1 && isFinite(preview.duration) && preview.duration > 0) {
      createSlider(preview.duration);
      return;
    }
    statusMsg.textContent = "⏳ Waiting for video metadata...";
    let fallbackTimeout;
    const onMetadataLoaded = () => {
      clearTimeout(fallbackTimeout);
      preview.removeEventListener('loadedmetadata', onMetadataLoaded);
      if (isFinite(preview.duration) && preview.duration > 0) {
        createSlider(preview.duration);
      } else {
        statusMsg.textContent = "❌ Metadata loaded, but the video duration is invalid.";
      }
    };
    preview.addEventListener('loadedmetadata', onMetadataLoaded);
    fallbackTimeout = setTimeout(() => {
      preview.removeEventListener('loadedmetadata', onMetadataLoaded);
      statusMsg.textContent = "❌ Timed out waiting for video.";
    }, 5000);
  };

  // Function to update webcam overlay position and size - MOVED TO GLOBAL SCOPE
  function updateWebcamOverlayStyle() {
      const container = webcamPreview.parentElement;
      if (!container) return; 
      const containerRect = container.getBoundingClientRect(); 
      
      const newWidthPx = webcamSize.width * containerRect.width;
      const newHeightPx = (newWidthPx / webcamAspectRatio); 

      webcamSize.height = newHeightPx / containerRect.height; // Update for consistency

      let newX = webcamPosition.x * containerRect.width;
      let newY = webcamPosition.y * containerRect.height;

      newX = Math.max(0, Math.min(newX, containerRect.width - newWidthPx));
      newY = Math.max(0, Math.min(newY, containerRect.height - newHeightPx));

      webcamPreview.style.left = `${newX}px`;
      webcamPreview.style.top = `${newY}px`;
      webcamPreview.style.width = `${newWidthPx}px`;
      webcamPreview.style.height = `${newHeightPx}px`;

      webcamPosition.x = newX / containerRect.width;
      webcamPosition.y = newY / containerRect.height;
  }

  // NEW: Media Device Enumeration and Setup
  async function populateMediaDevices() {
    try {
      // Request initial permissions if not already granted to get device labels
      try { await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); } catch (e) { console.warn("Initial media access denied or not available:", e); }
      
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioInputSelect.innerHTML = '';
      videoInputSelect.innerHTML = '';

      const defaultAudioOption = document.createElement('option');
      defaultAudioOption.value = '';
      defaultAudioOption.textContent = 'No Microphone';
      audioInputSelect.appendChild(defaultAudioOption);

      const defaultVideoOption = document.createElement('option');
      defaultVideoOption.value = '';
      defaultVideoOption.textContent = 'No Camera';
      videoInputSelect.appendChild(defaultVideoOption);

      devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Unknown ${device.kind}`;
        if (device.kind === 'audioinput') {
          audioInputSelect.appendChild(option);
        } else if (device.kind === 'videoinput') {
          videoInputSelect.appendChild(option);
        }
      });

      audioInputSelect.selectedIndex = 0; 
      videoInputSelect.selectedIndex = 0; 

    } catch (err) {
      console.error("Error enumerating devices:", err);
      statusMsg.textContent = "❌ Could not list media devices. Please allow camera/mic access.";
    }
  }

  async function getWebcamAndMicStream() {
    if (webcamStream) { 
      webcamStream.getTracks().forEach(track => track.stop());
      webcamStream = null;
    }
    if (webcamVideoElementForCanvas) {
      webcamVideoElementForCanvas.pause();
      webcamVideoElementForCanvas.srcObject = null;
    }

    try {
      const audioDeviceId = audioInputSelect.value;
      const videoDeviceId = videoInputSelect.value;

      const constraints = {
        video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : false,
        audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : false,
      };

      if (!constraints.video && !constraints.audio) {
          statusMsg.textContent = "No camera or microphone selected. Only screen will be recorded.";
          webcamOverlayControls.classList.add('hidden');
          webcamPreview.srcObject = null; 
          return;
      }
      
      webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      if (!webcamVideoElementForCanvas) {
        webcamVideoElementForCanvas = document.createElement('video');
        webcamVideoElementForCanvas.style.display = 'none';
        webcamVideoElementForCanvas.muted = true; 
        document.body.appendChild(webcamVideoElementForCanvas);
      }
      webcamVideoElementForCanvas.srcObject = webcamStream;
      webcamVideoElementForCanvas.play().catch(e => console.warn("Webcam video for canvas play error:", e));

      webcamPreview.srcObject = webcamStream; // This shows the webcam preview for positioning
      webcamOverlayControls.classList.remove('hidden');

      const videoTrack = webcamStream.getVideoTracks()[0];
      if (videoTrack) {
          const { width, height } = videoTrack.getSettings();
          webcamAspectRatio = (width && height) ? (width / height) : (16 / 9); // Fallback to 16:9
          webcamSize.width = 0.25; 
          updateWebcamOverlayStyle(); 
      } else {
        webcamOverlayControls.classList.add('hidden'); 
      }

      statusMsg.textContent = "✅ Webcam and microphone connected. Adjust overlay as needed.";

    } catch (err) {
      console.error("Error getting webcam/mic stream:", err);
      statusMsg.textContent = "❌ Could not access webcam/mic. Please ensure access is allowed and devices are connected.";
      webcamOverlayControls.classList.add('hidden');
      if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
        webcamStream = null;
      }
      if (webcamVideoElementForCanvas) {
        webcamVideoElementForCanvas.pause();
        webcamVideoElementForCanvas.srcObject = null;
      }
    }
  }

  function stopAllStreams() {
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      screenStream = null;
    }
    if (webcamStream) {
      webcamStream.getTracks().forEach(track => track.stop());
      webcamStream = null;
    }
    if (screenVideoElementForCanvas) {
      screenVideoElementForCanvas.pause();
      screenVideoElementForCanvas.srcObject = null;
      // screenVideoElementForCanvas.remove(); // Can keep for reuse if preferred
    }
    if (webcamVideoElementForCanvas) {
      webcamVideoElementForCanvas.pause();
      webcamVideoElementForCanvas.srcObject = null;
      // webcamVideoElementForCanvas.remove(); // Can keep for reuse if preferred
    }

    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    webcamPreview.classList.remove('webcam-overlay', 'resizing', 'is-dragging', 'hidden-overlay'); 
    webcamPreview.srcObject = null; // Clear any live stream on webcamPreview
    webcamPreview.style.cssText = ''; // Clear inline styles
    webcamOverlayControls.classList.add('hidden');
    isWebcamOverlayVisible = true; 
    toggleWebcamOverlayBtn.innerHTML = `<i class="fa-solid fa-camera"></i> Hide Overlay`; 
  }

  // NEW: Canvas drawing and audio mixing for combined stream
  function drawFrame() {
    const ctx = recordingCanvas.getContext('2d');
    
    ctx.clearRect(0, 0, recordingCanvas.width, recordingCanvas.height);

    // Draw screen video (from persistent, playing element)
    if (screenVideoElementForCanvas && screenVideoElementForCanvas.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      ctx.drawImage(screenVideoElementForCanvas, 0, 0, recordingCanvas.width, recordingCanvas.height);
    } else {
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, recordingCanvas.width, recordingCanvas.height);
    }
    
    // Draw webcam overlay if visible and stream is active (from persistent, playing element)
    if (isWebcamOverlayVisible && webcamVideoElementForCanvas && webcamVideoElementForCanvas.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const overlayWidth = webcamSize.width * recordingCanvas.width;
      const overlayHeight = webcamSize.height * recordingCanvas.height; 
      const overlayX = webcamPosition.x * recordingCanvas.width;
      const overlayY = webcamPosition.y * recordingCanvas.height;
      ctx.drawImage(webcamVideoElementForCanvas, overlayX, overlayY, overlayWidth, overlayHeight);
    }

    animationFrameId = requestAnimationFrame(drawFrame);
  }

  async function getCombinedStream() {
      if (!screenStream || screenStream.getVideoTracks().length === 0) {
          throw new Error("Screen stream not available for combined recording.");
      }
      const screenVideoTrack = screenStream.getVideoTracks()[0];
      const settings = screenVideoTrack.getSettings();
      recordingCanvas.width = settings.width || 1280; 
      recordingCanvas.height = settings.height || 720;

      // Initialize persistent video element for screen capture (if not already)
      if (!screenVideoElementForCanvas) {
        screenVideoElementForCanvas = document.createElement('video');
        screenVideoElementForCanvas.style.display = 'none';
        screenVideoElementForCanvas.muted = true; 
        document.body.appendChild(screenVideoElementForCanvas);
      }
      screenVideoElementForCanvas.srcObject = screenStream;
      screenVideoElementForCanvas.play().catch(e => console.warn("Screen video for canvas play error:", e));

      // Wait for screen video to load metadata before starting canvas drawing,
      // essential for getting correct dimensions and preventing black frames.
      await new Promise(resolve => {
        if (screenVideoElementForCanvas.readyState >= HTMLMediaElement.HAVE_METADATA) {
          resolve();
        } else {
          screenVideoElementForCanvas.onloadedmetadata = () => resolve();
        }
      });

      // Wait for webcam video to load metadata if active
      if (webcamVideoElementForCanvas && webcamStream && webcamStream.getVideoTracks().length > 0) {
        await new Promise(resolve => {
          if (webcamVideoElementForCanvas.readyState >= HTMLMediaElement.HAVE_METADATA) {
            resolve();
          } else {
            webcamVideoElementForCanvas.onloadedmetadata = () => resolve();
          }
        });
      }

      // Start the drawing loop for the canvas
      if (animationFrameId) cancelAnimationFrame(animationFrameId); 
      animationFrameId = requestAnimationFrame(drawFrame);

      // Setup combined audio
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const destination = audioContext.createMediaStreamDestination();

      if (screenStream.getAudioTracks().length > 0) {
          const screenAudioSource = audioContext.createMediaStreamSource(screenStream);
          screenAudioSource.connect(destination);
      }
      if (webcamStream && webcamStream.getAudioTracks().length > 0) {
          const webcamAudioSource = audioContext.createMediaStreamSource(webcamStream);
          webcamAudioSource.connect(destination);
      }

      const combinedVideoTrack = recordingCanvas.captureStream(30).getVideoTracks()[0]; 
      const combinedAudioTrack = destination.stream.getAudioTracks()[0];

      return new MediaStream([combinedVideoTrack, combinedAudioTrack]);
  }

  function setupWebcamOverlayControls() {
    // This function sets up the CSS class and event listeners for dragging/resizing.
    // webcamPreview already has its srcObject set to the *webcamStream* at this point (before recording starts).
    webcamPreview.classList.add('webcam-overlay');
    
    const container = webcamPreview.parentElement;
    
    // Reset position/size when setting up controls ONLY IF it's the initial setup,
    // or if the user explicitly wants to reset it. For live adjustment, this is not needed here.
    // webcamPosition = { x: 0.7, y: 0.7 }; // Keep previous position
    // webcamSize = { width: 0.25, height: 0.25 }; // Keep previous size
    updateWebcamOverlayStyle(); // Apply current (or default) position/size

    const handleDragStart = (e) => {
        if (e.button !== 0 || isResizing) return; 
        e.preventDefault();
        isDragging = true;
        webcamPreview.classList.add('is-dragging');
        const overlayRect = webcamPreview.getBoundingClientRect();
        dragOffsetX = e.clientX - overlayRect.left;
        dragOffsetY = e.clientY - overlayRect.top;
    };

    const handleMouseMove = (e) => {
        if (isDragging) {
            e.preventDefault();
            const containerRect = container.getBoundingClientRect();

            let newX = e.clientX - containerRect.left - dragOffsetX;
            let newY = e.clientY - containerRect.top - dragOffsetY;

            newX = Math.max(0, Math.min(newX, containerRect.width - webcamPreview.offsetWidth));
            newY = Math.max(0, Math.min(newY, containerRect.height - webcamPreview.offsetHeight));

            webcamPosition.x = newX / containerRect.width;
            webcamPosition.y = newY / containerRect.height;
            
            webcamPreview.style.left = `${newX}px`;
            webcamPreview.style.top = `${newY}px`;
        } else if (isResizing) {
            e.preventDefault();
            const containerRect = container.getBoundingClientRect();
            const mouseX = e.clientX;
            
            const deltaX = mouseX - dragOffsetX; 
            
            let newWidthPx = initialWebcamWidth + deltaX;
            newWidthPx = Math.max(50, Math.min(newWidthPx, containerRect.width * 0.7)); 
            
            const newHeightPx = newWidthPx / webcamAspectRatio; 

            webcamPreview.style.width = `${newWidthPx}px`;
            webcamPreview.style.height = `${newHeightPx}px`;

            webcamSize.width = newWidthPx / containerRect.width;
            webcamSize.height = newHeightPx / containerRect.height;
        }
    };

    const handleMouseUp = () => {
        if (isDragging) {
            isDragging = false;
            webcamPreview.classList.remove('is-dragging');
        }
        if (isResizing) {
            isResizing = false;
            webcamPreview.classList.remove('resizing');
            updateWebcamOverlayStyle();
        }
    };

    moveWebcamOverlayBtn.addEventListener('mousedown', handleDragStart);
    resizeWebcamOverlayBtn.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || isDragging) return; 
        e.preventDefault();
        isResizing = true;
        webcamPreview.classList.add('resizing');
        initialWebcamWidth = webcamPreview.offsetWidth;
        initialWebcamHeight = webcamPreview.offsetHeight;
        dragOffsetX = e.clientX; 
    });
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);


    toggleWebcamOverlayBtn.addEventListener('click', () => {
        isWebcamOverlayVisible = !isWebcamOverlayVisible;
        webcamPreview.classList.toggle('hidden-overlay', !isWebcamOverlayVisible);
        toggleWebcamOverlayBtn.innerHTML = isWebcamOverlayVisible ? 
            `<i class="fa-solid fa-camera"></i> Hide Overlay` : 
            `<i class="fa-solid fa-eye-slash"></i> Show Overlay`;
    });

    window.addEventListener('resize', updateWebcamOverlayStyle);
  }

  // Screen-only recording logic
  const startScreenOnlyRecording = async () => {
    stopAllStreams(); 
    webcamCaptureArea.classList.add("hidden"); 

    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { mediaSource: "screen" }, audio: true });
      mediaRecorder = new MediaRecorder(screenStream, { mimeType: "video/webm; codecs=vp8" }); // Explicitly set VP8
      chunks = [];
      mediaRecorder.ondataavailable = e => chunks.push(e.data);
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        const fd = new FormData();
        fd.append("video", blob, "recording.webm");
        statusMsg.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading & processing...`;
        
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
      screenStream.getVideoTracks()[0].onended = () => stopBtn.click(); 
      statusMsg.textContent = "🎬 Recording screen only…";
      startBtn.classList.add("hidden");
      startWebcamBtn.classList.add("hidden"); 
      stopBtn.classList.remove("hidden");
      pauseBtn.classList.remove("hidden");
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        statusMsg.textContent = "🤔 Recording cancelled. Ready when you are!";
      } else {
        statusMsg.textContent = "❌ Could not start recording. Please try again.";
        console.error("An unexpected error occurred when starting recording:", err);
      }
      setTimeout(() => { statusMsg.textContent = ""; }, 5000);
      stopAllStreams(); 
      resetRecordingButtons(); 
    }
  };

  // Combined recording logic
  const startCombinedRecording = async () => {
      statusMsg.textContent = "⏳ Starting combined recording...";
      try {
          screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); 
          // getWebcamAndMicStream() already retrieved webcamStream and set up webcamVideoElementForCanvas
          // and webcamPreview.srcObject = webcamStream;
          
          // CRITICAL FIX HERE: Set webcamPreview.srcObject to the canvas stream.
          // The canvas is what combines screen + webcam, so the preview should show that.
          const combinedStream = await getCombinedStream();
          webcamPreview.srcObject = combinedStream; // <-- Changed this line

          // Ensure CSS for overlay is active
          webcamPreview.classList.add('webcam-overlay'); 
          // Re-apply styles in case the size/position was lost with srcObject change
          updateWebcamOverlayStyle();

          mediaRecorder = new MediaRecorder(combinedStream, { mimeType: "video/webm; codecs=vp8" }); // Explicitly set VP8
          chunks = [];
          mediaRecorder.ondataavailable = e => chunks.push(e.data);
          mediaRecorder.onstop = async () => {
              const blob = new Blob(chunks, { type: "video/webm" });
              const fd = new FormData();
              fd.append("video", blob, "recording.webm");
              statusMsg.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading & processing...`;
              
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
          statusMsg.textContent = "🎬 Recording screen + webcam…";
          screenStream.getVideoTracks()[0].onended = () => stopBtn.click();
          if (webcamStream && webcamStream.getVideoTracks().length > 0) {
            webcamStream.getVideoTracks()[0].onended = () => {
              console.log("Webcam video track ended, stopping recording.");
              stopBtn.click();
            };
          }
          if (webcamStream && webcamStream.getAudioTracks().length > 0) {
            webcamStream.getAudioTracks()[0].onended = () => {
              console.log("Webcam audio track ended, stopping recording.");
              stopBtn.click();
            };
          }
          
          startBtn.classList.add("hidden");
          startWebcamBtn.classList.add("hidden");
          webcamCaptureArea.classList.remove("hidden"); 
          stopBtn.classList.remove("hidden");
          pauseBtn.classList.remove("hidden");

      } catch (err) {
          if (err.name === 'NotAllowedError') {
              statusMsg.textContent = "🤔 Recording cancelled. Please allow screen/webcam access.";
          } else {
              statusMsg.textContent = "❌ Could not start combined recording: " + (err.message || "Unknown error");
              console.error("Error starting combined recording:", err);
          }
          setTimeout(() => { statusMsg.textContent = ""; }, 5000);
          stopAllStreams(); 
          resetRecordingButtons(); 
      }
  };

  // Helper to reset recording buttons to initial state
  function resetRecordingButtons() {
    startBtn.classList.remove("hidden");
    startWebcamBtn.classList.remove("hidden");
    pauseBtn.classList.add("hidden");
    resumeBtn.classList.add("hidden");
    stopBtn.classList.add("hidden");
    webcamCaptureArea.classList.add("hidden"); 
    
    if (startBtn.currentListener) {
        startBtn.removeEventListener("click", startBtn.currentListener);
    }
    startBtn.addEventListener("click", startScreenOnlyRecording);
    startBtn.currentListener = startScreenOnlyRecording; 

    startBtn.textContent = "Start Recording (Screen Only)"; 
  }

  // ===================================================================
  // EVENT LISTENERS
  // ===================================================================

  // --- Initial listener setup ---
  startBtn?.addEventListener("click", startScreenOnlyRecording);
  startBtn.currentListener = startScreenOnlyRecording; 

  // --- Main Page Navigation ---
  $("#showPrivacyLink")?.addEventListener("click", (e) => { e.preventDefault(); showView('privacy'); });
  $("#showContactLink")?.addEventListener("click", (e) => { e.preventDefault(); showView('contact'); });
  $$(".back-btn").forEach(btn => btn.addEventListener("click", (e) => { e.preventDefault(); showView('recorder'); }));
  
  // NEW: Start Recording with Webcam button click
  startWebcamBtn?.addEventListener("click", async () => {
    stopAllStreams(); 
    webcamCaptureArea.classList.remove("hidden"); 
    startBtn.classList.add("hidden"); 
    startWebcamBtn.classList.add("hidden"); 

    statusMsg.textContent = "⏳ Setting up webcam and screen share. Please allow permissions...";
    await populateMediaDevices(); 
    await getWebcamAndMicStream(); 
    
    setupWebcamOverlayControls(); // Setup dragging/resizing for the webcamPreview which shows webcam feed
                                  // before recording starts

    if (startBtn.currentListener) {
        startBtn.removeEventListener("click", startBtn.currentListener);
    }
    startBtn.addEventListener("click", startCombinedRecording);
    startBtn.currentListener = startCombinedRecording; 

    startBtn.textContent = "Start Combined Recording";
    startBtn.classList.remove("hidden"); 
  });

  // Device selection change listeners (for webcam mode)
  audioInputSelect.addEventListener('change', getWebcamAndMicStream);
  videoInputSelect.addEventListener('change', getWebcamAndMicStream);

  pauseBtn?.addEventListener("click", () => { mediaRecorder.pause(); statusMsg.textContent = "⏸ Paused"; pauseBtn.classList.add("hidden"); resumeBtn.classList.remove("hidden"); });
  resumeBtn?.addEventListener("click", () => { mediaRecorder.resume(); statusMsg.textContent = "🎬 Recording…"; resumeBtn.classList.add("hidden"); pauseBtn.classList.remove("hidden"); });
  stopBtn?.addEventListener("click", () => { 
    if (mediaRecorder?.state !== "inactive") {
      mediaRecorder.stop(); 
      statusMsg.textContent = "Stopping recording...";
    }
  });
  
  // --- Other Button/Panel Listeners ---
  sessionBtn?.addEventListener("click", () => { filesPanel.classList.toggle("hidden"); filesPanel.scrollIntoView({ behavior: 'smooth' }); });
  forgetBtn?.addEventListener("click", () => forgetSessionModal?.showModal());

  const resetButton = (btn, originalContent) => {
    if (btn) { 
        btn.disabled = false;
        btn.innerHTML = originalContent;
    }
  };

  actionsPanel.addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-action]") || e.target.closest("a[data-action]");
    if (!button || !currentFile) return;
    const action = button.dataset.action;
    
    switch (action) {
      case "clip": setupTrimSlider(); break;
      
      case "download-webm":
          const webmButton = button;
          const originalWebmButtonContent = webmButton.innerHTML; 
          webmButton.classList.add('disabled-link'); 
          webmButton.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Downloading...`;

          setTimeout(() => {
              resetButton(webmButton, originalWebmButtonContent);
              webmButton.classList.remove('disabled-link'); 
          }, 2000); 
          break;

      case "download-mp4":
          const mp4Button = button;
          const originalMp4ButtonContent = mp4Button.innerHTML; 

          mp4Button.disabled = true;
          mp4Button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Converting...`;
          statusMsg.textContent = "⏳ Converting to MP4. This might take a moment...";

          try {
              const downloadUrl = `/download/mp4/${currentFile}`;
              const response = await fetch(downloadUrl, { method: 'GET' });

              if (response.ok) {
                  window.location.href = downloadUrl;
                  statusMsg.textContent = `✅ MP4 conversion/download started! Check your downloads.`;
              } else {
                  const errorData = await response.json();
                  statusMsg.textContent = `❌ MP4 conversion failed: ${errorData.error || 'Unknown error'}`;
                  console.error("MP4 conversion server error:", errorData.error);
              }
          } catch (error) {
              console.error("MP4 conversion request failed (network/parsing error):", error);
              statusMsg.textContent = `❌ MP4 conversion request failed. Please check network.`;
          } finally {
              resetButton(mp4Button, originalMp4ButtonContent); 
              setTimeout(() => statusMsg.textContent = '', 5000); 
          }
          break;
      case "secure-link": { const r = await apiFetch(`/link/secure/${currentFile}`).then(r => r.json()); if (r.status === "ok") copy(r.url, button); break; }
      case "public-link": { const r = await apiFetch(`/link/public/${currentFile}`).then(r => r.json()); if (r.status === "ok") { copy(r.url, button); button.innerHTML = `<i class="fa-solid fa-link"></i> Public Link Active`; } break; }
      case "email": emailModal?.showModal(); break;
      case "delete":
        fileToDeleteEl.textContent = currentFile;
        deleteConfirmBtn.dataset.filename = currentFile;
        deleteModal?.showModal();
        break;
    }
  });

  // --- Modal Button Listeners ---
  $("#clipCancel")?.addEventListener("click", () => { clipPanel.classList.add("hidden"); if (trimSlider) { trimSlider.destroy(); trimSlider = null; } statusMsg.textContent = ""; });
  $("#clipGo")?.addEventListener("click", async (e) => {
      if (!currentFile || !trimSlider) return alert("⚠ Trimmer not initialized.");
      const [start, end] = trimSlider.get().map(v => parseFloat(v));
      if (start >= end) return alert("⚠ Invalid range.");
      const btn = e.target.closest("button");
      btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Cutting...`;
      const r = await apiFetch(`/clip/${currentFile}`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ start, end }) }).then(x => x.json());
      if (r.status === "ok") { addFileToGrid(r.clip); activateFile(r.clip); $("#clipCancel").click(); } else { alert("❌ " + r.error); }
      btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-share-nodes"></i> Create & Share Clip`;
  });

  $("#emailClose")?.addEventListener("click", () => emailModal.close());
  $("#emailSend")?.addEventListener("click", async (e) => {
      const to = $("#emailTo").value.trim();
      if (!to) { $("#emailStatus").textContent = "❌ Enter an e-mail."; return; }
      const btn = e.target.closest("button");
      btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Sending...`;
      const linkRes = await apiFetch(`/link/secure/${currentFile}`).then(r => r.json());
      if (linkRes.status !== 'ok') {
          alert('Could not generate a secure link.');
          btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Send`; return;
      }
      const r = await apiFetch("/send_email", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ to, url: linkRes.url }) }).then(x => x.json());
      $("#emailStatus").textContent = r.status === "ok" ? "✅ Sent!" : "❌ " + (r.error || "Failed");
      btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Send`;
      if (r.status === "ok") setTimeout(() => { emailModal.close(); $("#emailStatus").textContent = ""; }, 1500);
  });
  
  deleteCancelBtn?.addEventListener("click", () => deleteModal.close());
  deleteConfirmBtn?.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      const filename = btn.dataset.filename;
      if (!filename) return;
      btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Deleting...`;
      const r = await apiFetch(`/delete/${filename}`, { method: "POST" }).then(r => r.json());
      if (r.status === "ok") {
        statusMsg.textContent = `✅ Recording deleted successfully.`;
        setTimeout(() => { statusMsg.textContent = ""; }, 4000);
        
        const card = $(`.media-card[data-filename="${filename}"]`);
        if (card) { card.classList.add("deleting"); card.addEventListener("animationend", () => card.remove()); }
        if (currentFile === filename) activateFile(null);
      } else {
        alert("❌ Delete failed: " + r.error);
      }
      btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-trash-can"></i> Yes, Delete`;
      deleteModal.close();
  });

  $("#forgetCancel")?.addEventListener("click", () => forgetSessionModal.close());
  $("#forgetConfirm")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Forgetting...`;
      await apiFetch("/session/forget", { method: "POST" });
      renderFiles([]);
      activateFile(null);
      statusMsg.textContent = "✅ Session has been successfully forgotten.";
      setTimeout(() => { statusMsg.textContent = ""; }, 4000);
      forgetSessionModal.close();
      btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-eraser"></i> Yes, Forget Session`;
  });

  // --- Contact Form Modal Logic ---
  const contactModal = $("#contactModal");
  const showContactModalBtn = $("#showContactModalBtn");
  const contactCancelBtn = $("#contactCancelBtn");
  const contactSendBtn = $("#contactSendBtn");
  const contactStatus = $("#contactStatus");

  showContactModalBtn?.addEventListener("click", () => {
    contactStatus.textContent = "";
    contactStatus.className = ""; 
    contactModal?.showModal();
  });

  contactCancelBtn?.addEventListener("click", () => {
    contactModal?.close();
  });

  contactSendBtn?.addEventListener("click", async () => {
    const from_email = $("#contactFromEmail").value.trim();
    const subject = $("#contactSubject").value.trim();
    const message = $("#contactMessage").value.trim();

    if (!from_email || !subject || !message) {
      contactStatus.className = "error";
      contactStatus.textContent = "❌ Please fill out all fields.";
      return;
    }

    contactSendBtn.disabled = true;
    contactSendBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Sending...`;
    contactStatus.className = "";
    contactStatus.textContent = "";

    const res = await apiFetch("/contact_us", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_email, subject, message })
    }).then(r => r.json());

    if (res.status === "ok") {
      contactStatus.className = "success";
      contactStatus.textContent = "✅ Message Sent! We'll get back to you soon.";
      setTimeout(() => {
        contactModal.close();
        $("#contactFromEmail").value = "";
        $("#contactSubject").value = "";
        $("#contactMessage").value = "";
      }, 2500);
    } else {
      contactStatus.className = "error";
      contactStatus.textContent = `❌ ${res.error || "An unknown error occurred."}`;
    }

    contactSendBtn.disabled = false;
    contactSendBtn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Send Message`;
  });

  // --- BUG FIX FOR MOBILE WARNING MODAL ---
  $("#mobileWarningClose")?.addEventListener("click", () => {
    $("#mobileWarningModal")?.close();
  });

  // ===================================================================
  // INITIALIZATION (Runs once on page load)
  // ===================================================================
  (async () => {
    // Mobile check
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
      $("#mobileWarningModal")?.showModal();
      if(startBtn) {
        startBtn.disabled = true;
        startBtn.innerHTML = `<i class="fa-solid fa-desktop"></i> Desktop Only`;
        startWebcamBtn.disabled = true; 
        startWebcamBtn.innerHTML = `<i class="fa-solid fa-desktop"></i> Desktop Only`;
      }
    }
    // Load files
    try {
      const { files = [] } = await apiFetch("/session/files").then(r => r.json());
      renderFiles(files.reverse());
    } catch {}
  })();
});