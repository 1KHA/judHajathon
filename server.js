const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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

  socket.on('set-teams', async (teamNames) => {
    // Clear existing teams
    await prisma.team.deleteMany({});
    
    // Create new teams
    await prisma.team.createMany({
      data: teamNames.map(name => ({ name }))
    });
    
    // Update in-memory state
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

  socket.on('submit-answer', async (answerData) => {
    const playerName = players[socket.id]?.name || 'Unknown';
    const answerText = answerData.answer || answerData;
    const questionIndex = answerData.questionIndex;
    const currentTeam = teams[currentTeamIndex];

    // Create or find judge
    const judge = await prisma.judge.upsert({
      where: { name: playerName },
      create: { name: playerName },
      update: {}
    });

    // Find the team
    const team = await prisma.team.findFirst({
      where: { name: currentTeam }
    });

    if (!team) {
      console.error('Team not found:', currentTeam);
      return;
    }

    // Save answer to database
    await prisma.answer.create({
      data: {
        answer: answerText,
        question: { connect: { id: questionIndex + 1 } }, // Assuming question IDs start at 1
        team: { connect: { id: team.id } },
        judge: { connect: { id: judge.id } }
      }
    });

    // Update in-memory state
    if (!answersByTeam[currentTeam]) {
      answersByTeam[currentTeam] = [];
    }
    answersByTeam[currentTeam].push({
      player: playerName,
      answer: answerText
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
