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

  // NEW: Persistent video elements for canvas drawing - CRITICAL FIX HERE
  // These elements are created once and constantly play their respective streams
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
      if (!container) return; // Guard against container not being ready
      const containerRect = container.getBoundingClientRect(); // Get fresh dimensions
      
      // Calculate new pixel dimensions for the overlay based on normalized state
      const newWidthPx = webcamSize.width * containerRect.width;
      const newHeightPx = (newWidthPx / webcamAspectRatio); 

      // Update the webcamSize height to reflect actual aspect-ratio-constrained height
      webcamSize.height = newHeightPx / containerRect.height;

      // Calculate position in pixels, ensuring it stays within bounds
      let newX = webcamPosition.x * containerRect.width;
      let newY = webcamPosition.y * containerRect.height;

      newX = Math.max(0, Math.min(newX, containerRect.width - newWidthPx));
      newY = Math.max(0, Math.min(newY, containerRect.height - newHeightPx));

      webcamPreview.style.left = `${newX}px`;
      webcamPreview.style.top = `${newY}px`;
      webcamPreview.style.width = `${newWidthPx}px`;
      webcamPreview.style.height = `${newHeightPx}px`;

      // Update normalized positions based on constrained pixel values
      webcamPosition.x = newX / containerRect.width;
      webcamPosition.y = newY / containerRect.height;
  }

  // NEW: Media Device Enumeration and Setup
  async function populateMediaDevices() {
    try {
      // Request initial permissions if not already granted to get device labels
      // This is crucial for Chrome/Firefox to show device labels.
      // Requesting only audio, then video, helps identify exact capabilities.
      // Use empty constraints for initial enumerateDevices to avoid permission prompts right away
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioInputSelect.innerHTML = '';
      videoInputSelect.innerHTML = '';

      // Add a default "No device" option
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
        option.textContent = device.label || `Unknown ${device.kind}`; // Fallback label
        if (device.kind === 'audioinput') {
          audioInputSelect.appendChild(option);
        } else if (device.kind === 'videoinput') {
          videoInputSelect.appendChild(option);
        }
      });

      // Select default devices if available
      audioInputSelect.selectedIndex = 0; // Default to "No Microphone" or first available
      videoInputSelect.selectedIndex = 0; // Default to "No Camera" or first available

    } catch (err) {
      console.error("Error enumerating devices:", err);
      statusMsg.textContent = "❌ Could not list media devices. Please allow camera/mic access.";
    }
  }

  async function getWebcamAndMicStream() {
    if (webcamStream) { // Stop existing stream if any
      webcamStream.getTracks().forEach(track => track.stop());
    }
    // Pause canvas video elements if streams are changing
    if (webcamVideoElementForCanvas) webcamVideoElementForCanvas.pause();

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
          webcamPreview.srcObject = null; // Clear live preview if no stream
          webcamStream = null;
          return;
      }
      
      // Request permissions explicitly for the selected devices
      webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Setup the hidden video element for drawing to canvas
      if (!webcamVideoElementForCanvas) {
        webcamVideoElementForCanvas = document.createElement('video');
        webcamVideoElementForCanvas.style.display = 'none';
        webcamVideoElementForCanvas.muted = true; // Essential to avoid feedback loops
        document.body.appendChild(webcamVideoElementForCanvas);
      }
      webcamVideoElementForCanvas.srcObject = webcamStream;
      webcamVideoElementForCanvas.play().catch(e => console.warn("Webcam video for canvas play error:", e));

      webcamPreview.srcObject = webcamStream; // Show webcam preview to user
      webcamOverlayControls.classList.remove('hidden');

      // Update webcam aspect ratio based on actual stream
      const videoTrack = webcamStream.getVideoTracks()[0];
      if (videoTrack) {
          const { width, height } = videoTrack.getSettings();
          if (width && height) { // Ensure width and height are valid
            webcamAspectRatio = width / height;
          } else {
            console.warn("Webcam video track settings (width/height) are undefined. Defaulting to 16:9 aspect ratio.");
            webcamAspectRatio = 16 / 9; // Fallback
          }
          // Set initial size of the overlay based on container width
          webcamSize.width = 0.25; // 25% of container width
          // Height is derived from width to maintain aspect ratio
          updateWebcamOverlayStyle(); // Call the now globally accessible function
      } else {
        webcamOverlayControls.classList.add('hidden'); // Hide controls if no video track
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
      if (webcamVideoElementForCanvas) webcamVideoElementForCanvas.pause();
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
    // Stop and clean up persistent video elements for canvas
    if (screenVideoElementForCanvas) {
      screenVideoElementForCanvas.pause();
      screenVideoElementForCanvas.srcObject = null;
    }
    if (webcamVideoElementForCanvas) {
      webcamVideoElementForCanvas.pause();
      webcamVideoElementForCanvas.srcObject = null;
    }

    // Stop audio context
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    // Stop canvas animation frame
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    // Restore webcam preview to its "screen only" state (full container, not overlay)
    webcamPreview.classList.remove('webcam-overlay', 'resizing', 'is-dragging', 'hidden-overlay'); 
    webcamPreview.srcObject = null; // Clear live preview
    webcamPreview.style.cssText = ''; // Clear inline styles (position/size)
    webcamOverlayControls.classList.add('hidden');
    isWebcamOverlayVisible = true; // Reset visibility state
    toggleWebcamOverlayBtn.innerHTML = `<i class="fa-solid fa-camera"></i> Hide Overlay`; // Reset button text
  }

  // NEW: Canvas drawing and audio mixing for combined stream
  function drawFrame() {
    const ctx = recordingCanvas.getContext('2d');
    
    // Clear canvas
    ctx.clearRect(0, 0, recordingCanvas.width, recordingCanvas.height);

    // Draw screen video (from persistent element)
    if (screenVideoElementForCanvas && screenVideoElementForCanvas.readyState >= screenVideoElementForCanvas.HAVE_CURRENT_DATA) {
      ctx.drawImage(screenVideoElementForCanvas, 0, 0, recordingCanvas.width, recordingCanvas.height);
    } else {
        // If screen stream is not ready/available, draw a black background
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, recordingCanvas.width, recordingCanvas.height);
    }
    
    // Draw webcam overlay if visible and stream is active (from persistent element)
    if (isWebcamOverlayVisible && webcamVideoElementForCanvas && webcamVideoElementForCanvas.readyState >= webcamVideoElementForCanvas.HAVE_CURRENT_DATA) {
      const overlayWidth = webcamSize.width * recordingCanvas.width;
      const overlayHeight = webcamSize.height * recordingCanvas.height; 
      const overlayX = webcamPosition.x * recordingCanvas.width;
      const overlayY = webcamPosition.y * recordingCanvas.height;
      ctx.drawImage(webcamVideoElementForCanvas, overlayX, overlayY, overlayWidth, overlayHeight);
    }

    animationFrameId = requestAnimationFrame(drawFrame);
  }

  async function getCombinedStream() {
      // Get screen stream dimensions
      if (!screenStream || screenStream.getVideoTracks().length === 0) {
          throw new Error("Screen stream not available for combined recording.");
      }
      const screenVideoTrack = screenStream.getVideoTracks()[0];
      const settings = screenVideoTrack.getSettings();
      // Ensure canvas matches screen resolution for best quality
      recordingCanvas.width = settings.width || 1280; 
      recordingCanvas.height = settings.height || 720;

      // Initialize persistent video element for screen capture (if not already)
      if (!screenVideoElementForCanvas) {
        screenVideoElementForCanvas = document.createElement('video');
        screenVideoElementForCanvas.style.display = 'none';
        screenVideoElementForCanvas.muted = true; // Mute to prevent audio doubling (audio is mixed separately)
        document.body.appendChild(screenVideoElementForCanvas);
      }
      screenVideoElementForCanvas.srcObject = screenStream;
      screenVideoElementForCanvas.play().catch(e => console.warn("Screen video for canvas play error:", e));


      // Start the drawing loop for the canvas
      if (animationFrameId) cancelAnimationFrame(animationFrameId); // Stop any previous loop
      animationFrameId = requestAnimationFrame(drawFrame);

      // Setup combined audio
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const destination = audioContext.createMediaStreamDestination();

      // Connect screen audio to destination
      if (screenStream.getAudioTracks().length > 0) {
          const screenAudioSource = audioContext.createMediaStreamSource(screenStream);
          screenAudioSource.connect(destination);
      }
      // Connect webcam audio to destination
      if (webcamStream && webcamStream.getAudioTracks().length > 0) {
          const webcamAudioSource = audioContext.createMediaStreamSource(webcamStream);
          webcamAudioSource.connect(destination);
      }

      // Get combined stream from canvas and mixed audio
      // Set desired frame rate for canvas captureStream to 30 FPS
      const combinedVideoTrack = recordingCanvas.captureStream(30).getVideoTracks()[0]; 
      const combinedAudioTrack = destination.stream.getAudioTracks()[0];

      return new MediaStream([combinedVideoTrack, combinedAudioTrack]);
  }

  function setupWebcamOverlayControls() {
    // Make webcamPreview a draggable and resizable overlay
    webcamPreview.classList.add('webcam-overlay');
    
    const container = webcamPreview.parentElement;
    // containerRect is fetched inside updateWebcamOverlayStyle

    // Initial positioning
    webcamPosition = { x: 0.7, y: 0.7 }; // Normalized to bottom-right
    webcamSize = { width: 0.25, height: 0.25 }; // Default to 25% width
    updateWebcamOverlayStyle(); // Apply initial styles

    // --- Dragging Logic ---
    const handleDragStart = (e) => {
        if (e.button !== 0 || isResizing) return; // Only left click, not when resizing
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

            // Boundary checks (in pixels)
            newX = Math.max(0, Math.min(newX, containerRect.width - webcamPreview.offsetWidth));
            newY = Math.max(0, Math.min(newY, containerRect.height - webcamPreview.offsetHeight));

            // Convert back to normalized for state
            webcamPosition.x = newX / containerRect.width;
            webcamPosition.y = newY / containerRect.height;
            
            webcamPreview.style.left = `${newX}px`;
            webcamPreview.style.top = `${newY}px`;
        } else if (isResizing) {
            e.preventDefault();
            const containerRect = container.getBoundingClientRect();
            const mouseX = e.clientX;
            
            // Calculate distance from initial drag start to current mouseX
            const deltaX = mouseX - dragOffsetX; 
            
            let newWidthPx = initialWebcamWidth + deltaX;
            newWidthPx = Math.max(50, Math.min(newWidthPx, containerRect.width * 0.7)); // Min 50px, Max 70% of container width
            
            const newHeightPx = newWidthPx / webcamAspectRatio; // Maintain aspect ratio

            // Apply new pixel dimensions directly
            webcamPreview.style.width = `${newWidthPx}px`;
            webcamPreview.style.height = `${newHeightPx}px`;

            // Update normalized size for state
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
            // Recalculate normalized position and size after resizing for accuracy
            updateWebcamOverlayStyle();
        }
    };

    moveWebcamOverlayBtn.addEventListener('mousedown', handleDragStart);
    resizeWebcamOverlayBtn.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || isDragging) return; // Only left click, not when dragging
        e.preventDefault();
        isResizing = true;
        webcamPreview.classList.add('resizing');
        initialWebcamWidth = webcamPreview.offsetWidth;
        initialWebcamHeight = webcamPreview.offsetHeight;
        dragOffsetX = e.clientX; // Store initial mouse X for resizing
    });
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);


    // Toggle overlay visibility
    toggleWebcamOverlayBtn.addEventListener('click', () => {
        isWebcamOverlayVisible = !isWebcamOverlayVisible;
        webcamPreview.classList.toggle('hidden-overlay', !isWebcamOverlayVisible);
        toggleWebcamOverlayBtn.innerHTML = isWebcamOverlayVisible ? 
            `<i class="fa-solid fa-camera"></i> Hide Overlay` : 
            `<i class="fa-solid fa-eye-slash"></i> Show Overlay`;
    });

    // Ensure overlay remains correctly positioned/sized on window resize
    window.addEventListener('resize', updateWebcamOverlayStyle);
  }


  // --- Specific Recording Start Functions ---

  // Screen-only recording logic
  const startScreenOnlyRecording = async () => {
    stopAllStreams(); // Ensure any previous streams are stopped
    webcamCaptureArea.classList.add("hidden"); // Hide webcam controls

    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { mediaSource: "screen" }, audio: true });
      mediaRecorder = new MediaRecorder(screenStream, { mimeType: "video/webm" });
      chunks = [];
      mediaRecorder.ondataavailable = e => chunks.push(e.data);
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        const fd = new FormData();
        fd.append("video", blob, "recording.webm");
        statusMsg.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading & processing...`;
        
        stopAllStreams(); // Important: Stop all tracks on both streams immediately after recording stops
        
        const res = await apiFetch("/upload", { method: "POST", body: fd }).then(r => r.json());
        if (res.status === "ok") {
          statusMsg.textContent = `✅ Recording saved!`;
          addFileToGrid(res.filename);
          activateFile(res.filename);
        } else {
          statusMsg.textContent = "❌ Upload failed: " + res.error;
        }
        resetRecordingButtons(); // Reset buttons to initial state
      };
      mediaRecorder.start();
      screenStream.getVideoTracks()[0].onended = () => stopBtn.click(); // Auto-stop if screen share ends
      statusMsg.textContent = "🎬 Recording screen only…";
      // Update UI for recording in progress
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
      stopAllStreams(); // Clean up if an error occurs
      resetRecordingButtons(); // Restore buttons
    }
  };


  // Combined recording logic
  const startCombinedRecording = async () => {
      statusMsg.textContent = "⏳ Starting combined recording...";
      try {
          // Request screen share (must be done by user click)
          screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); 
          // Re-fetch webcam/mic to ensure latest device selection and correct tracks
          await getWebcamAndMicStream(); 

          // Set webcamPreview's srcObject to the screen stream for user to see
          // (webcam overlay will be positioned on top via CSS)
          webcamPreview.srcObject = screenStream; 
          setupWebcamOverlayControls(); // Setup dragging/resizing on the live preview of screen+webcam

          // Get the final combined stream from the canvas and mixed audio for MediaRecorder
          const combinedStream = await getCombinedStream();
          mediaRecorder = new MediaRecorder(combinedStream, { mimeType: "video/webm" });
          chunks = [];
          mediaRecorder.ondataavailable = e => chunks.push(e.data);
          mediaRecorder.onstop = async () => {
              const blob = new Blob(chunks, { type: "video/webm" });
              const fd = new FormData();
              fd.append("video", blob, "recording.webm");
              statusMsg.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading & processing...`;
              
              stopAllStreams(); // Stop all tracks on all streams
              
              const res = await apiFetch("/upload", { method: "POST", body: fd }).then(r => r.json());
              if (res.status === "ok") {
                  statusMsg.textContent = `✅ Recording saved!`;
                  addFileToGrid(res.filename);
                  activateFile(res.filename);
              } else {
                  statusMsg.textContent = "❌ Upload failed: " + res.error;
              }
              resetRecordingButtons(); // Reset buttons to initial state
          };
          
          mediaRecorder.start();
          statusMsg.textContent = "🎬 Recording screen + webcam…";
          // Auto-stop if screen share ends or webcam stream ends
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
          
          // Hide initial buttons and show recording controls
          startBtn.classList.add("hidden");
          startWebcamBtn.classList.add("hidden");
          webcamCaptureArea.classList.remove("hidden"); // Keep visible for overlay controls
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
          stopAllStreams(); // Clean up on error
          resetRecordingButtons(); // Reset buttons to initial state
      }
  };


  // Helper to reset recording buttons to initial state
  function resetRecordingButtons() {
    startBtn.classList.remove("hidden");
    startWebcamBtn.classList.remove("hidden");
    pauseBtn.classList.add("hidden");
    resumeBtn.classList.add("hidden");
    stopBtn.classList.add("hidden");
    webcamCaptureArea.classList.add("hidden"); // Hide webcam setup UI
    
    // Crucially: Remove the current listener and re-add the screen-only one
    if (startBtn.currentListener) {
        startBtn.removeEventListener("click", startBtn.currentListener);
    }
    startBtn.addEventListener("click", startScreenOnlyRecording);
    startBtn.currentListener = startScreenOnlyRecording; // Update current listener reference

    startBtn.textContent = "Start Recording (Screen Only)"; // Reset text
  }


  // ===================================================================
  // EVENT LISTENERS
  // ===================================================================

  // --- Initial listener setup ---
  startBtn?.addEventListener("click", startScreenOnlyRecording);
  startBtn.currentListener = startScreenOnlyRecording; // Store the currently active listener


  // --- Main Page Navigation (Isolated and Correct) ---
  $("#showPrivacyLink")?.addEventListener("click", (e) => { e.preventDefault(); showView('privacy'); });
  $("#showContactLink")?.addEventListener("click", (e) => { e.preventDefault(); showView('contact'); });
  $$(".back-btn").forEach(btn => btn.addEventListener("click", (e) => { e.preventDefault(); showView('recorder'); }));

  // --- Recorder Controls ---
  // The startBtn's listener is now dynamically managed
  
  // NEW: Start Recording with Webcam button click
  startWebcamBtn?.addEventListener("click", async () => {
    stopAllStreams(); // Clear any previous streams
    webcamCaptureArea.classList.remove("hidden"); // Show webcam controls
    startBtn.classList.add("hidden"); // Hide screen-only button
    startWebcamBtn.classList.add("hidden"); // Hide self until setup is done

    statusMsg.textContent = "⏳ Setting up webcam and screen share. Please allow permissions...";
    await populateMediaDevices(); // Populate dropdowns first
    await getWebcamAndMicStream(); // Get initial webcam/mic streams
    
    // Change the main start button's text and listener for combined recording
    if (startBtn.currentListener) {
        startBtn.removeEventListener("click", startBtn.currentListener);
    }
    startBtn.addEventListener("click", startCombinedRecording);
    startBtn.currentListener = startCombinedRecording; // Update current listener reference

    startBtn.textContent = "Start Combined Recording";
    startBtn.classList.remove("hidden"); // Show the new "Start Combined Recording" button
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

  // --- Helper to reset button state ---
  const resetButton = (btn, originalContent) => {
    if (btn) { // Check if button element exists
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
          const originalWebmButtonContent = webmButton.innerHTML; // Store original content

          // Disable the link visually (it's an <a> tag, but still useful for feedback)
          // For <a> tags, the 'download' attribute handles the download.
          // We show a spinner for a brief moment as an acknowledgment.
          webmButton.classList.add('disabled-link'); // Add a class for styling disabled <a>
          webmButton.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Downloading...`;

          setTimeout(() => {
              resetButton(webmButton, originalWebmButtonContent);
              webmButton.classList.remove('disabled-link'); // Remove disabled class
          }, 2000); // Show spinner for 2 seconds

          // IMPORTANT: Do NOT e.preventDefault() here for <a> tags, as it stops the download.
          break;

      case "download-mp4":
          const mp4Button = button;
          const originalMp4ButtonContent = mp4Button.innerHTML; // Store original content

          mp4Button.disabled = true;
          mp4Button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Converting...`;
          statusMsg.textContent = "⏳ Converting to MP4. This might take a moment...";

          try {
              const downloadUrl = `/download/mp4/${currentFile}`;
              // Make a fetch request to check server's response (for errors)
              const response = await fetch(downloadUrl, { method: 'GET' });

              if (response.ok) {
                  // If OK, trigger the actual file download by redirecting the browser
                  window.location.href = downloadUrl;
                  statusMsg.textContent = `✅ MP4 conversion/download started! Check your downloads.`;
              } else {
                  // If not OK, parse JSON error from Flask
                  const errorData = await response.json();
                  statusMsg.textContent = `❌ MP4 conversion failed: ${errorData.error || 'Unknown error'}`;
                  console.error("MP4 conversion server error:", errorData.error);
              }
          } catch (error) {
              console.error("MP4 conversion request failed (network/parsing error):", error);
              statusMsg.textContent = `❌ MP4 conversion request failed. Please check network.`;
          } finally {
              resetButton(mp4Button, originalMp4ButtonContent); // Use helper to reset
              setTimeout(() => statusMsg.textContent = '', 5000); // Clear message
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

  // --- Contact Form Modal Logic (Updated for better styling) ---
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
        startWebcamBtn.disabled = true; // Disable webcam button too
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