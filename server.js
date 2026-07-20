import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// In-memory store for active events and room states
// Structure:
// {
//   [eventCode]: {
//     code: string,
//     title: string,
//     description: string,
//     status: 'idle' | 'live' | 'paused',
//     rtmpOutputs: { youtube: boolean, facebook: boolean, custom: string },
//     recording: boolean,
//     ticker: { text: string, enabled: boolean, speed: number, color: string, bg: string, size: number },
//     lowerThird: { name: string, role: string, template: string, enabled: boolean },
//     graphics: { logo: string, watermark: boolean, logoEnabled: boolean },
//     cameras: { [socketId]: { id: string, name: string, battery: number, signal: number, network: string, device: string, isFront: boolean, audioEnabled: boolean, videoEnabled: boolean } }
//   }
// }
const rooms = {};

// Port configuration
const PORT = process.env.PORT || 5000;

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', rooms: Object.keys(rooms).length });
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Event validation / login
  socket.on('join-room', ({ eventCode, role, details }) => {
    socket.join(eventCode);
    socket.eventCode = eventCode;
    socket.role = role;

    // Initialize room if not exists
    if (!rooms[eventCode]) {
      rooms[eventCode] = {
        code: eventCode,
        title: 'Pavalam Live Event',
        description: 'Multi-camera Web Broadcasting',
        status: 'idle',
        rtmpOutputs: { youtube: false, facebook: false, custom: '' },
        recording: false,
        ticker: {
          text: '🔴 LIVE | ஸ்ரீ பவளம்மன் கோவில் திருவிழா | அனைவருக்கும் நேரலையில் இணைந்திருப்பதற்கு நன்றி',
          enabled: true,
          speed: 15,
          color: '#ffffff',
          bg: '#ef4444',
          size: 16
        },
        lowerThird: {
          name: 'Special Guest',
          role: 'Temple Priest',
          template: 'default',
          enabled: false
        },
        graphics: {
          logo: 'https://images.unsplash.com/photo-1614850523459-c2f4c699c52e?w=100&auto=format&fit=crop&q=60',
          watermark: true,
          logoEnabled: true
        },
        cameras: {}
      };
    }

    if (role === 'camera') {
      rooms[eventCode].cameras[socket.id] = {
        id: socket.id,
        name: details?.name || `Cam-${socket.id.substring(0, 4)}`,
        battery: details?.battery || 100,
        signal: details?.signal || 4, // 1 to 4 bars
        network: details?.network || 'WiFi',
        device: details?.device || 'Mobile Device',
        isFront: details?.isFront || false,
        audioEnabled: details?.audioEnabled !== false,
        videoEnabled: details?.videoEnabled !== false,
      };

      // Notify host and admins that a new camera joined
      io.to(eventCode).emit('cameras-updated', rooms[eventCode].cameras);
      console.log(`Camera added to room ${eventCode}: ${socket.id}`);
    } else {
      // Send current state to newly joined host / admin
      socket.emit('room-state', rooms[eventCode]);
      console.log(`Admin/Host joined room ${eventCode} with role ${role}`);
    }
  });

  // Camera updates battery, network, camera toggle, etc.
  socket.on('update-camera-status', (details) => {
    const { eventCode } = socket;
    if (eventCode && rooms[eventCode]?.cameras[socket.id]) {
      rooms[eventCode].cameras[socket.id] = {
        ...rooms[eventCode].cameras[socket.id],
        ...details
      };
      io.to(eventCode).emit('cameras-updated', rooms[eventCode].cameras);
    }
  });

  // Admin controls event status (start/stop/pause)
  socket.on('update-event-status', ({ status, title, description }) => {
    const { eventCode } = socket;
    if (eventCode && rooms[eventCode]) {
      if (status) rooms[eventCode].status = status;
      if (title) rooms[eventCode].title = title;
      if (description) rooms[eventCode].description = description;
      
      io.to(eventCode).emit('event-status-changed', {
        status: rooms[eventCode].status,
        title: rooms[eventCode].title,
        description: rooms[eventCode].description
      });
    }
  });

  // Sync RTMP settings
  socket.on('update-rtmp-outputs', (rtmpOutputs) => {
    const { eventCode } = socket;
    if (eventCode && rooms[eventCode]) {
      rooms[eventCode].rtmpOutputs = rtmpOutputs;
      io.to(eventCode).emit('rtmp-outputs-updated', rtmpOutputs);
    }
  });

  // Sync Graphics/Logo configs
  socket.on('update-graphics', (graphics) => {
    const { eventCode } = socket;
    if (eventCode && rooms[eventCode]) {
      rooms[eventCode].graphics = { ...rooms[eventCode].graphics, ...graphics };
      io.to(eventCode).emit('graphics-updated', rooms[eventCode].graphics);
    }
  });

  // Sync Ticker running text
  socket.on('update-ticker', (ticker) => {
    const { eventCode } = socket;
    if (eventCode && rooms[eventCode]) {
      rooms[eventCode].ticker = { ...rooms[eventCode].ticker, ...ticker };
      io.to(eventCode).emit('ticker-updated', rooms[eventCode].ticker);
    }
  });

  // Sync Lower Third overlay
  socket.on('update-lower-third', (lowerThird) => {
    const { eventCode } = socket;
    if (eventCode && rooms[eventCode]) {
      rooms[eventCode].lowerThird = { ...rooms[eventCode].lowerThird, ...lowerThird };
      io.to(eventCode).emit('lower-third-updated', rooms[eventCode].lowerThird);
    }
  });

  // Recording status update
  socket.on('update-recording-status', (isRecording) => {
    const { eventCode } = socket;
    if (eventCode && rooms[eventCode]) {
      rooms[eventCode].recording = isRecording;
      io.to(eventCode).emit('recording-status-updated', isRecording);
    }
  });

  // --- WebRTC Signaling Relay ---
  // Host or camera requests a signaling message (SDP/ICE)
  socket.on('webrtc-signal', ({ targetSocketId, signal }) => {
    // Send signaling data directly to target socket ID
    io.to(targetSocketId).emit('webrtc-signal', {
      senderSocketId: socket.id,
      signal
    });
  });

  // When a client leaves
  socket.on('disconnect', () => {
    const { eventCode, role } = socket;
    if (eventCode && rooms[eventCode]) {
      if (role === 'camera') {
        delete rooms[eventCode].cameras[socket.id];
        io.to(eventCode).emit('cameras-updated', rooms[eventCode].cameras);
        io.to(eventCode).emit('camera-disconnected', socket.id);
        console.log(`Camera disconnected and removed: ${socket.id}`);
      }
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`PAVALAM TV Backend Server running on port ${PORT}`);
});
