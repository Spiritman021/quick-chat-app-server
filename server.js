const WebSocket = require("ws");
const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = 9315;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("WebSocket server is running\n");
});

const wss = new WebSocketServer({ server });

const rooms = {};
const messageBuffers = {};
const typingUsers = {}; // Track who is typing in each room
const MAX_MESSAGES = 50;

// Helper function to broadcast user list to room
const broadcastUserList = (roomId) => {
  const users = rooms[roomId]?.map((client) => client.nick) || [];
  const userListMessage = JSON.stringify({
    type: "userList",
    users: users,
  });

  rooms[roomId]?.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(userListMessage);
    }
  });
};

// Helper function to broadcast typing status
const broadcastTypingStatus = (roomId, typingUser, isTyping) => {
  if (!typingUsers[roomId]) {
    typingUsers[roomId] = new Set();
  }

  if (isTyping) {
    typingUsers[roomId].add(typingUser);
  } else {
    typingUsers[roomId].delete(typingUser);
  }

  const typingMessage = JSON.stringify({
    type: "typing",
    typingUsers: Array.from(typingUsers[roomId]),
  });

  rooms[roomId]?.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(typingMessage);
    }
  });
};

const isDev = false;

function log(...args) {
  if (isDev) console.log(...args);
}

// Helper function to broadcast system message
const broadcastSystemMessage = (roomId, message) => {
  const systemMessage = JSON.stringify({
    type: "system",
    text: message,
    timestamp: Date.now(),
  });

  rooms[roomId]?.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(systemMessage);
    }
  });
};

wss.on("connection", (ws, req) => {
  console.log("New connection attempt");

  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const roomId = url.searchParams.get("room");
  const nick = url.searchParams.get("nick");

  console.log(`Connection request: room=${roomId}, nick=${nick}`);

  if (!roomId || !nick) {
    console.log("Missing room or nick, closing connection");
    ws.close(1008, "Room and nick are required");
    return;
  }

  // Initialize room if it doesn't exist
  if (!rooms[roomId]) {
    rooms[roomId] = [];
    messageBuffers[roomId] = [];
    typingUsers[roomId] = new Set();
  }

  // Check if nickname is already taken in this room
  const existingUser = rooms[roomId].find(
    (client) => client.nick === nick && client.ws.readyState === WebSocket.OPEN
  );

  if (existingUser) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Nickname already taken in this room",
      })
    );
    ws.close(1008, "Nickname already taken");
    return;
  }

  // Add client to room
  const clientInfo = { ws, nick, roomId, joinedAt: Date.now() };
  rooms[roomId].push(clientInfo);

  console.log(`User ${nick} joined room ${roomId}`);

  // Send message history to new user
  const history = messageBuffers[roomId] || [];
  ws.send(
    JSON.stringify({
      type: "history",
      messages: history,
    })
  );

  // Send current user list
  broadcastUserList(roomId);

  // Send current typing status
  ws.send(
    JSON.stringify({
      type: "typing",
      typingUsers: Array.from(typingUsers[roomId] || []),
    })
  );

  // Broadcast join message
  broadcastSystemMessage(roomId, `${nick} joined the room`);

  // Handle incoming messages
  ws.on("message", (data) => {
    try {
      const rawData = data.toString().trim();

      if (!rawData) return;

      // Check if it's a JSON message (typing indicator) or plain text message
      let messageObj;
      try {
        messageObj = JSON.parse(rawData);
      } catch (e) {
        // It's a plain text message
        messageObj = { type: "message", text: rawData };
      }

      if (messageObj.type === "typing") {
        // Handle typing indicator
        broadcastTypingStatus(roomId, nick, messageObj.isTyping);
        return;
      }

      if (messageObj.type === "message") {
        const text = messageObj.text;

        // Check if message is too long
        if (text.length > 500) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Message too long (max 500 characters)",
            })
          );
          return;
        }

        log(`Message from ${nick} in room ${roomId}: ${text}`);

        // When user sends a message, remove them from typing
        if (typingUsers[roomId]) {
          typingUsers[roomId].delete(nick);
          broadcastTypingStatus(roomId, nick, false);
        }

        const message = {
          nick,
          text,
          timestamp: Date.now(),
        };

        // Add to message buffer
        messageBuffers[roomId].push(message);
        if (messageBuffers[roomId].length > MAX_MESSAGES) {
          messageBuffers[roomId].shift();
        }

        // Broadcast message to all clients in room
        const messageData = JSON.stringify({
          type: "message",
          ...message,
        });

        rooms[roomId].forEach((client) => {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(messageData);
          }
        });
      }
    } catch (error) {
      console.error("Error processing message:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Error processing message",
        })
      );
    }
  });

  // Handle client disconnect
  ws.on("close", (code, reason) => {
    console.log(
      `User ${nick} disconnected from room ${roomId} (${code}: ${reason})`
    );

    // Remove client from room
    if (rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter((client) => client.ws !== ws);

      // Remove from typing users
      if (typingUsers[roomId]) {
        typingUsers[roomId].delete(nick);
        broadcastTypingStatus(roomId, nick, false);
      }

      // Broadcast leave message only if there are still users in the room
      if (rooms[roomId].length > 0) {
        broadcastSystemMessage(roomId, `${nick} left the room`);
        broadcastUserList(roomId);
      }

      // Clean up empty rooms
      if (rooms[roomId].length === 0) {
        delete rooms[roomId];
        delete messageBuffers[roomId];
        delete typingUsers[roomId];
        console.log(`Room ${roomId} cleaned up`);
      }
    }
  });

  // Handle WebSocket errors
  ws.on("error", (error) => {
    console.error(`WebSocket error for user ${nick}:`, error);
  });

  // Send connection confirmation
  ws.send(
    JSON.stringify({
      type: "connected",
      message: "Successfully connected to the room",
    })
  );
});

// Cleanup disconnected clients periodically
setInterval(() => {
  Object.keys(rooms).forEach((roomId) => {
    const activeClients = rooms[roomId].filter(
      (client) => client.ws.readyState === WebSocket.OPEN
    );

    if (activeClients.length !== rooms[roomId].length) {
      rooms[roomId] = activeClients;
      if (activeClients.length === 0) {
        delete rooms[roomId];
        delete messageBuffers[roomId];
        delete typingUsers[roomId];
        console.log(`Room ${roomId} cleaned up during periodic cleanup`);
      } else {
        broadcastUserList(roomId);
      }
    }
  });
}, 30000); // Check every 30 seconds

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WebSocket server running on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down WebSocket server...");
  wss.close(() => {
    server.close(() => {
      console.log("WebSocket server closed");
      process.exit(0);
    });
  });
});

process.on("SIGTERM", () => {
  console.log("\nShutting down WebSocket server...");
  wss.close(() => {
    server.close(() => {
      console.log("WebSocket server closed");
      process.exit(0);
    });
  });
});