require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');
const Groq = require('groq-sdk');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// Create HTTP server and Socket.io server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for dev
    methods: ["GET", "POST"]
  }
});

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// In-memory Room State
// Structure:
// rooms[roomName] = {
//   hostId: string | null, // Socket ID of the host
//   hostName: string | null,
//   isLocked: boolean,
//   isAutoAccept: boolean,
//   isPresenting: boolean,
//   password: string | null,
//   waitingRoom: [{ id: socketId, name: string, role: string }],
//   activeParticipants: [{ id: socketId, name: string, role: string }]
// }
const rooms = {};

// Socket.io Connection Handling
io.on('connection', async (socket) => {
  console.log('✅ User connected:', socket.id);

  // Helper to sync room state to a specific socket
  const syncRoomState = (roomName, targetSocket) => {
    const currentRoom = rooms[roomName];
    if (currentRoom) {
      targetSocket.emit('room_state', {
        isLocked: currentRoom.isLocked,
        isAutoAccept: currentRoom.isAutoAccept,
        isPresenting: currentRoom.isPresenting
      });
    }
  };

  // User requests to join a room
  socket.on('join_request', async ({ room, name, role }) => {
    const action = role === 'teacher' ? 'creating/joining' : 'requesting to join';
    console.log(`[${role}] ${name} ${action} ${room}`);

    if (!rooms[room]) {
      // Create new room if it doesn't exist
      const newPassword = Math.random().toString(36).substring(2, 8).toUpperCase();
      rooms[room] = {
        hostId: null,
        hostName: null,
        isLocked: false,
        isAutoAccept: true, // Enable auto-accept by default so students can join immediately
        isPresenting: false,
        password: newPassword,
        waitingRoom: [],
        activeParticipants: []
      };
      console.log(`🎉 NEW ROOM CREATED: ${room} | Password: ${newPassword} | Auto-Accept: ON`);
    }

    const currentRoom = rooms[room];

    // If joining as Teacher (Host)
    if (role === 'teacher') {
      // If room already has a host, and it's not this user (reconnect logic could go here)
      // For now, simple override or multi-host support
      if (!currentRoom.hostId) {
        currentRoom.hostId = socket.id;
        currentRoom.hostName = name;
        console.log(`👨‍🏫 ${name} is now the HOST of room ${room}`);
      } else {
        console.log(`👨‍🏫 ${name} joining as co-host in room ${room}`);
      }

      // Teachers bypass waiting room
      socket.join(room);

      // Update active list if not already there
      const existingIdx = currentRoom.activeParticipants.findIndex(p => p.id === socket.id);
      if (existingIdx === -1) {
        currentRoom.activeParticipants.push({ id: socket.id, name, role });
      }

      // Generate LiveKit token
      const at = new AccessToken(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
        {
          identity: name,
          metadata: JSON.stringify({ role }),
        }
      );

      at.addGrant({
        roomJoin: true,
        room: room,
        canPublish: true,
        canSubscribe: true,
      });

      const token = await at.toJwt();
      const url = process.env.LIVEKIT_URL;

      console.log(`✅ Token generated for ${name} in room ${room}`);

      // Send Token immediately
      socket.emit('join_approved', {
        room,
        name,
        role,
        password: currentRoom.password,
        token,
        url
      });

      syncRoomState(room, socket);

      // Broadcast update to room (so other teachers/students see active list)
      io.to(room).emit('update_participants', {
        active: currentRoom.activeParticipants,
        waiting: currentRoom.waitingRoom
      });

      // If there are people in waiting room, notify this new host
      if (currentRoom.waitingRoom.length > 0) {
        socket.emit('waiting_room_update', currentRoom.waitingRoom);
      }

      return;
    }

    // If joining as Student
    if (role === 'student') {

      // Check Password - REMOVED per user request
      /*
      if (currentRoom.password && password !== currentRoom.password) {
        socket.emit('invalid_password');
        return;
      }
      */

      // If room is locked, reject
      if (currentRoom.isLocked) {
        socket.emit('room_locked');
        return;
      }

      // If Auto-Accept is enabled, admit immediately
      if (currentRoom.isAutoAccept) {
        console.log(`[Auto-Accept] Admitting ${name} to ${room}`);

        socket.join(room);
        const user = { id: socket.id, name, role };
        currentRoom.activeParticipants.push(user);

        // Generate LiveKit token for student
        const at = new AccessToken(
          process.env.LIVEKIT_API_KEY,
          process.env.LIVEKIT_API_SECRET,
          {
            identity: name,
            metadata: JSON.stringify({ role }),
          }
        );

        at.addGrant({
          roomJoin: true,
          room: room,
          canPublish: true,
          canSubscribe: true,
        });

        const token = await at.toJwt();
        const url = process.env.LIVEKIT_URL;

        console.log(`✅ Auto-accept: Token generated for student ${name}`);

        socket.emit('join_approved', {
          room,
          name,
          role,
          token,
          url
        });

        // Broadcast update
        io.to(room).emit('update_participants', {
          active: currentRoom.activeParticipants,
          waiting: currentRoom.waitingRoom
        });

        // Notify teachers that a student joined
        io.to(room).emit('participant_joined', { name, role });

        syncRoomState(room, socket);
        return;
      }
      

      // Add to waiting room if not already there
      const alreadyWaiting = currentRoom.waitingRoom.find(u => u.name === name);
      if (!alreadyWaiting) {
        const user = { id: socket.id, name, role };
        currentRoom.waitingRoom.push(user);
      }

      // Notify user they are waiting
      socket.emit('joined_waiting_room');

      // Notify Host(s) - update everyone in the room about the waiting room
      io.to(room).emit('waiting_room_update', currentRoom.waitingRoom);
    }
  });

  // Rejoin logic for refresh/navigation
  socket.on('rejoin', ({ room, name, role }) => {
    console.log(`User ${name} rejoining room ${room} as ${role}`);

    if (!rooms[room]) {
      // Room might have been cleared if host disconnected, but if it's a rejoin we recreate if needed
      rooms[room] = {
        hostId: null,
        hostName: null,
        isLocked: false,
        isAutoAccept: false,
        isPresenting: false,
        password: Math.random().toString(36).substring(2, 8).toUpperCase(),
        waitingRoom: [],
        activeParticipants: []
      };
    }

    const currentRoom = rooms[room];
    socket.join(room);

    if (role === 'teacher') {
      currentRoom.hostId = socket.id;
      currentRoom.hostName = name;
    }

    // Upsert into activeParticipants
    const existingIdx = currentRoom.activeParticipants.findIndex(p => p.name === name);
    if (existingIdx !== -1) {
      currentRoom.activeParticipants[existingIdx].id = socket.id;
    } else {
      currentRoom.activeParticipants.push({ id: socket.id, name, role });
    }

    // Sync state
    socket.emit('update_participants', {
      active: currentRoom.activeParticipants,
      waiting: currentRoom.waitingRoom
    });
    syncRoomState(room, socket);

    if (role === 'teacher') {
      socket.emit('waiting_room_update', currentRoom.waitingRoom);
    }

    // Broadcast update to others
    socket.to(room).emit('update_participants', {
      active: currentRoom.activeParticipants,
      waiting: currentRoom.waitingRoom
    });

    // Notify teachers that a participant rejoined (only if student)
    if (role === 'student') {
      io.to(room).emit('participant_joined', { name, role });
    }
  });

  // Host admits a user
  socket.on('admit_user', ({ room, userId }) => {
    const currentRoom = rooms[room];
    if (!currentRoom) return;

    const userIndex = currentRoom.waitingRoom.findIndex(u => u.id === userId);
    if (userIndex !== -1) {
      const user = currentRoom.waitingRoom.splice(userIndex, 1)[0];

      // Move to active
      user.role = 'student'; // Ensure role is kept or sanitized
      currentRoom.activeParticipants.push(user);

      // Notify user they are approved
      io.to(user.id).emit('join_approved', { room, name: user.name, role: user.role });

      // Send initial room state to the newly admitted user
      io.to(user.id).emit('room_state', {
        isLocked: currentRoom.isLocked,
        isAutoAccept: currentRoom.isAutoAccept,
        isPresenting: currentRoom.isPresenting
      });

      // Update lists for everyone
      io.to(room).emit('update_participants', {
        active: currentRoom.activeParticipants,
        waiting: currentRoom.waitingRoom
      });
      io.to(room).emit('waiting_room_update', currentRoom.waitingRoom);

      // Notify teachers that a student joined
      io.to(room).emit('participant_joined', { name: user.name, role: user.role });
    }
  });

  // Host rejects a user
  socket.on('reject_user', ({ room, userId }) => {
    const currentRoom = rooms[room];
    if (!currentRoom) return;

    const userIndex = currentRoom.waitingRoom.findIndex(u => u.id === userId);
    if (userIndex !== -1) {
      const user = currentRoom.waitingRoom.splice(userIndex, 1)[0];
      io.to(user.id).emit('join_rejected');

      // Update waiting list for host
      io.to(room).emit('waiting_room_update', currentRoom.waitingRoom);
    }
  });

  // Host kicks a user
  socket.on('kick_user', ({ room, userId }) => {
    const currentRoom = rooms[room];
    if (!currentRoom) return;

    const userIndex = currentRoom.activeParticipants.findIndex(u => u.id === userId);
    if (userIndex !== -1) {
      currentRoom.activeParticipants.splice(userIndex, 1);
      io.to(userId).emit('kicked');
      io.to(room).emit('update_participants', {
        active: currentRoom.activeParticipants,
        waiting: currentRoom.waitingRoom
      });
    }
  });

  // Host mutes everyone (Signal only - Frontend must reaction)
  socket.on('mute_all', ({ room }) => {
    io.to(room).emit('host_muted_all');
  });

  // Host toggles room lock
  socket.on('toggle_lock', ({ room, locked }) => {
    if (rooms[room]) {
      rooms[room].isLocked = locked;
      io.to(room).emit('room_status_update', { isLocked: locked });
      console.log(`Room ${room} locked: ${locked}`);
    }
  });

  // Host toggles auto-accept
  socket.on('toggle_auto_accept', ({ room, enabled }) => {
    if (rooms[room]) {
      rooms[room].isAutoAccept = enabled;
      io.to(room).emit('room_status_update', { isAutoAccept: enabled });
      console.log(`Room ${room} Auto-Accept: ${enabled}`);

      // If enabled, admit everyone currently in waiting room
      if (enabled && rooms[room].waitingRoom.length > 0) {
        const waitingList = [...rooms[room].waitingRoom];
        rooms[room].waitingRoom = [];

        waitingList.forEach(user => {
          rooms[room].activeParticipants.push(user);
          io.to(user.id).emit('join_approved', { room, name: user.name, role: user.role });
          io.to(user.id).emit('room_state', {
            isLocked: rooms[room].isLocked,
            isAutoAccept: rooms[room].isAutoAccept,
            isPresenting: rooms[room].isPresenting
          });
        });

        // Update list for everyone
        io.to(room).emit('update_participants', {
          active: rooms[room].activeParticipants,
          waiting: []
        });
        io.to(room).emit('waiting_room_update', []);
      }
    }
  });

  // Host ends meeting
  socket.on('end_meeting', ({ room }) => {
    if (rooms[room]) {
      io.to(room).emit('meeting_ended');
      rooms[room] = null; // Clear room
    }
  });

  // Presentation State
  socket.on('presentation_start', ({ room }) => {
    console.log(`📺 Presentation started in room: ${room}`);
    if (rooms[room]) rooms[room].isPresenting = true;
    io.to(room).emit('presentation_start');
  });

  socket.on('presentation_stop', ({ room }) => {
    console.log(`🛑 Presentation stopped in room: ${room}`);
    if (rooms[room]) rooms[room].isPresenting = false;
    io.to(room).emit('presentation_stop');
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Cleanup logic
    for (const roomName in rooms) {
      if (rooms[roomName]) {
        const room = rooms[roomName];

        // Remove from waiting
        const waitIdx = room.waitingRoom.findIndex(u => u.id === socket.id);
        if (waitIdx !== -1) {
          room.waitingRoom.splice(waitIdx, 1);
          io.to(roomName).emit('waiting_room_update', room.waitingRoom);
        }

        // Remove from active
        const activeIdx = room.activeParticipants.findIndex(u => u.id === socket.id);
        if (activeIdx !== -1) {
          const leftUser = room.activeParticipants.splice(activeIdx, 1)[0];
          io.to(roomName).emit('update_participants', {
            active: room.activeParticipants,
            waiting: room.waitingRoom
          });

          // Notify teachers that a participant left
          io.to(roomName).emit('participant_left', { name: leftUser.name, role: leftUser.role });
        }

        // If Host left?
        if (room.hostId === socket.id) {
          console.log(`Host ${room.hostName} left room ${roomName}`);
          // Don't set null immediately, give time for rejoin?
          // For now keep it simple but notify room
          room.hostId = null;
          io.to(roomName).emit('host_left');
        }
      }
    }
  });
});


app.post('/token', async (req, res) => {
  try {
    const { name, room, role } = req.body;
    console.log("📥 TOKEN REQUEST BODY:", req.body);

    if (!name || !room || !role) {
      return res.status(400).json({ error: "Missing name, room, or role" });
    }

    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.LIVEKIT_URL) {
      return res.status(500).json({ error: "LiveKit ENV variables missing" });
    }

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: name,
        metadata: JSON.stringify({ role }),
      }
    );

    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
    });

    const jwt = await at.toJwt();
    console.log("✅ TOKEN GENERATED for:", name, "ROLE:", role);

    res.json({
      token: jwt,
      url: process.env.LIVEKIT_URL,
    });
  } catch (e) {
    console.error("❌ TOKEN ERROR:", e);
    res.status(500).json({ error: "Token generation failed" });
  }
});


app.post('/ask-ai', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content:
            'You are a teacher assistant. Provide only the absolute core answer or the main topic. Use the absolute minimum number of words required. Strictly no explanations, no introductory phrases, and no conversational filler.',
        },
        {
          role: 'user',
          content: question,
        },
      ],
      temperature: 0.3,
    });

    const answer = completion.choices[0]?.message?.content;

    res.json({ answer });
  } catch (err) {
    console.error('❌ GROQ ERROR:', err);
    res.status(500).json({ error: 'AI response failed' });
  }
});


server.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
