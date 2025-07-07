let canvas;
let ctx;
let screenReader;
let webcamReader;

let screenLastFrame;
let webcamLastFrame;

let running = false;

function draw() {
  if (!running || !ctx) return;

  // If we have a screen frame, draw it and close it to free up memory
  if (screenLastFrame) {
    // Ensure canvas is the same size as the video
    if (canvas.width !== screenLastFrame.codedWidth || canvas.height !== screenLastFrame.codedHeight) {
      canvas.width = screenLastFrame.codedWidth;
      canvas.height = screenLastFrame.codedHeight;
    }
    ctx.drawImage(screenLastFrame, 0, 0);
    screenLastFrame.close();
    screenLastFrame = null;
  }

  // If we have a webcam frame, draw it on top and close it
  if (webcamLastFrame) {
    const webcamWidth = canvas.width / 4; // 25% of screen width
    const webcamHeight = webcamWidth / (webcamLastFrame.codedWidth / webcamLastFrame.codedHeight); // Maintain aspect ratio
    const x = canvas.width - webcamWidth - 20; // 20px padding from right
    const y = canvas.height - webcamHeight - 20; // 20px padding from bottom
    
    ctx.drawImage(webcamLastFrame, x, y, webcamWidth, webcamHeight);
    webcamLastFrame.close();
    webcamLastFrame = null;
  }
}

// Function to start reading from a stream
async function startReading(reader, type) {
  while (running) {
    const { done, value: frame } = await reader.read();
    if (done) break;
    
    if (type === 'screen') {
      if(screenLastFrame) screenLastFrame.close(); // Close previous frame if not drawn yet
      screenLastFrame = frame;
    } else if (type === 'webcam') {
      if(webcamLastFrame) webcamLastFrame.close();
      webcamLastFrame = frame;
    }
    // We draw immediately after getting a screen frame
    if (type === 'screen') {
        draw();
    }
  }
}

self.onmessage = (e) => {
    const { type, payload } = e.data;

    switch (type) {
        case 'start':
            canvas = payload.canvas;
            ctx = canvas.getContext('2d');
            running = true;

            if (payload.screenStream) {
                screenReader = payload.screenStream.getReader();
                startReading(screenReader, 'screen');
            }
            if (payload.webcamStream) {
                webcamReader = payload.webcamStream.getReader();
                startReading(webcamReader, 'webcam');
            }
            break;

        case 'stop':
            running = false;
            // No need to close readers here, the main thread stops the tracks
            self.close(); // Terminate the worker
            break;
    }
};