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
let teams = [];
let currentTeamIndex = 0;
let answersByTeam = {};

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

  socket.on('set-teams', (teamNames) => {
    teams = teamNames;
    currentTeamIndex = 0;
    answersByTeam = {};
    socket.emit('teams-set', teams);
  });

  socket.on('start-question', (questions) => {
    console.log('Sending questions to judges:', {
      questions,
      currentTeam: teams[currentTeamIndex]
    });
    io.to('judge').emit('question', {
      questions,
      currentTeam: teams[currentTeamIndex]
    });
  });

  socket.on('join-host', () => {
    socket.join('host');
  });

  socket.on('next-team', () => {
    if (currentTeamIndex < teams.length - 1) {
      currentTeamIndex++;
      io.to('host').emit('team-changed', teams[currentTeamIndex]);
    }
  });

  socket.on('previous-team', () => {
    if (currentTeamIndex > 0) {
      currentTeamIndex--;
      io.to('host').emit('team-changed', teams[currentTeamIndex]);
    }
  });

  socket.on('end-session', () => {
    io.to('judge').emit('session-ended');
  });

  socket.on('submit-answer', (answer) => {
    const playerName = players[socket.id]?.name || 'Unknown';
    console.log('Answer received:', {
      player: playerName,
      team: teams[currentTeamIndex],
      answer: answer.answer || answer // Handle both object and direct answer
    });
    
    if (!answersByTeam[teams[currentTeamIndex]]) {
      answersByTeam[teams[currentTeamIndex]] = [];
    }
    answersByTeam[teams[currentTeamIndex]].push({
      player: playerName,
      answer: answer.answer || answer // Handle both formats
    });
    
    io.to('host').emit('answers-updated', answersByTeam);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.to('judge').emit('participant-list', Object.values(players));
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
