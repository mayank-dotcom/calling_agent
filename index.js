import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Server } from 'socket.io'
import { createServer } from 'http'

const app = new Hono()

app.get('/', (c) => {
  return c.json({ status: 'active', message: 'Global Signaling Server Running' })
})

app.get('/users', (c) => {
  return c.json({ online_users: Array.from(activeUsers.keys()) })
})

const httpServer = createServer(app.fetch)
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
})

const activeUsers = new Map();

io.on('connection', (socket) => {
  socket.on('register', (userId) => {
    activeUsers.set(userId, socket.id);
    console.log(`User Registered: ${userId}`);
  });

  socket.on('offer', ({ offer, targetId }) => {
    const targetSocketId = activeUsers.get(targetId);
    if (targetSocketId) {
      let senderUserId = 'unknown';
      for (const [uid, sid] of activeUsers.entries()) {
        if (sid === socket.id) { senderUserId = uid; break; }
      }
      io.to(targetSocketId).emit('offer', { offer, senderId: socket.id, senderUserId });
    }
  });

  socket.on('answer', ({ answer, targetId }) => {
    io.to(targetId).emit('answer', { answer });
  });

  socket.on('ice-candidate', ({ candidate, targetId }) => {
    io.to(targetId).emit('ice-candidate', { candidate });
  });

  // Handle Reject
  socket.on('reject-call', ({ targetId }) => {
    io.to(targetId).emit('call-rejected');
  });

  // Handle Hangup
  socket.on('hangup', ({ targetId }) => {
    const targetSocketId = activeUsers.get(targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-ended');
    }
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of activeUsers.entries()) {
      if (socketId === socket.id) {
        activeUsers.delete(userId);
        break;
      }
    }
  });
})

const port = process.env.PORT || 3000
serve({ fetch: app.fetch, port })
