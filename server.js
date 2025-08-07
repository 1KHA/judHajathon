const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

app.use(express.static('public'));

let judgePIN = '1234';
let players = {};

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('join-judging', (pin, name) => {
if (pin === judgePIN) {
      players[socket.id] = { name, score: 0 };
socket.join('judge');
      socket.emit('joined-success', name);
io.to('judge').emit('participant-list', Object.values(players));
    } else {
      socket.emit('error-message', 'Invalid Game PIN');
    }
  });

  socket.on('start-question', (questions) => {
    io.to('judge').emit('question', questions);
  });

  socket.on('submit-answer', (answer) => {
    console.log(players[socket.id].name, 'answered:', answer);
// Optionally update judgment score here
  });

  socket.on('disconnect', () => {
delete players[socket.id];
    io.to('judge').emit('participant-list', Object.values(players));
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
