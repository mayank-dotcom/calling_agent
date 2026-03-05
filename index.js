import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Server } from 'socket.io'
import { createServer } from 'http'
import mongoose from 'mongoose'
import { cors } from 'hono/cors'

const app = new Hono()
app.use('*', cors())

// ----- MONGODB SETUP -----
const MONGO_URI = process.env.MONGO_URI || '';
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch((err) => console.error('❌ MongoDB Connection Error:', err));
}

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  userId: { type: String, unique: true, required: true },
  isOnline: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
// -------------------------

app.get('/', (c) => {
  return c.json({ status: 'active', message: 'Global Signaling Server Running with MongoDB Support' })
})

app.get('/users', (c) => {
  return c.json({ online_users: Array.from(activeUsers.keys()) })
})

// Endpoint to list all registered users from DB
app.get('/all-users', async (c) => {
  try {
    const users = await User.find({}, 'name userId isOnline lastSeen');
    console.log(`Fetching all users: Found ${users.length} users`);
    return c.json(users);
  } catch (err) {
    console.error('Database Fetch Error:', err);
    return c.json({ error: 'Database error' }, 500);
  }
})

// Endpoint to delete a user
app.delete('/user/:userId', async (c) => {
  const userId = c.req.param('userId');
  try {
    await User.findOneAndDelete({ userId });
    activeUsers.delete(userId);
    io.emit('user-list-updated', Array.from(activeUsers.keys()));
    return c.json({ message: 'User deleted' });
  } catch (err) {
    return c.json({ error: 'Failed to delete user' }, 500);
  }
});

const httpServer = createServer(app.fetch)
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
})

const activeUsers = new Map();

io.on('connection', (socket) => {
  socket.on('register', async (data) => {
    // Handling both old (string) and new (object) registration
    const userId = typeof data === 'string' ? data : data.userId;
    const name = typeof data === 'string' ? data : (data.name || data.userId);

    activeUsers.set(userId, socket.id);
    console.log(`User Registered: ${userId} (${name})`);

    // Sync with MongoDB if connected
    if (MONGO_URI) {
      try {
        await User.findOneAndUpdate(
          { userId },
          { userId, name, isOnline: true, lastSeen: Date.now() },
          { upsert: true, new: true }
        );
      } catch (err) {
        console.error('Error updating User in DB:', err);
      }
    }

    io.emit('user-list-updated', Array.from(activeUsers.keys()));
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
    const targetSocketId = activeUsers.get(targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('answer', { answer });
    }
  });

  socket.on('ice-candidate', ({ candidate, targetId }) => {
    const targetSocketId = activeUsers.get(targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', { candidate });
    }
  });

  // Handle Reject
  socket.on('reject-call', ({ targetId }) => {
    const targetSocketId = activeUsers.get(targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-rejected');
    }
  });

  // Handle Hangup
  socket.on('hangup', ({ targetId }) => {
    const targetSocketId = activeUsers.get(targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-ended');
    }
  });

  socket.on('disconnect', async () => {
    for (const [userId, socketId] of activeUsers.entries()) {
      if (socketId === socket.id) {
        activeUsers.delete(userId);
        console.log(`User Disconnected: ${userId}`);

        // Update MongoDB if connected
        if (MONGO_URI) {
          try {
            await User.findOneAndUpdate({ userId }, { isOnline: false, lastSeen: Date.now() });
          } catch (err) {
            console.error('Error disconnecting User in DB:', err);
          }
        }
        break;
      }
    }
    io.emit('user-list-updated', Array.from(activeUsers.keys()));
  });
})

const port = process.env.PORT || 3000
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port} at 0.0.0.0`);
});
